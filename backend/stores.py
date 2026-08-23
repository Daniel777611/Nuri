"""The generic persistence layer: cards, privacy, snapshots, favourites.

What is left of main.py's `_db_*` helpers once each of the four subsystems took
the tables it owns. These four are not any subsystem's data — they belong to
the app: the generated feed cards and the feed mode, the parent's privacy
settings, the recommendation snapshots that make detail links stable, and the
favourites and collections.

Every function here has the same shape: try Supabase, fall back to
`memstore` when there is no client or the call fails. That is what lets the
whole app run with no credentials.

Privacy is the exception and reads deliberately differently. A failure there
raises rather than falling back, because silently defaulting `allow_history_training`
back to on after a storage error would re-enable something a parent switched
off. Fail closed, and say so.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Optional

import anyio
from fastapi import HTTPException, status

from backend import locales, memstore
from backend.recommendation_snapshots import (
    parse_snapshot,
    prepared_resource_pair,
    serialize_snapshot,
    snapshot_storage_key,
    snapshot_storage_prefix,
)
from backend import runtime
from backend.runtime import RECOMMENDATION_SNAPSHOT_SECRET, get_supabase, now

#: Fallback when Supabase is unavailable. Reassigned, so it stays module-level
#: here beside the `global` that writes it rather than living in memstore.
_gen_mode: str = "ai"

DEFAULT_PRIVACY = {
    "allow_history_training": True,
    "allow_external_content_research": False,
    "daily_push": True,
    "anonymous_community_share": False,
    "language": "zh-CN",
    "preferred_locale": "zh-CN",
}
#: Sentinel written in place of a deletion, so a later storage failure cannot
#: read as "never opted out".
PRIVACY_STORAGE_UNAVAILABLE = "_storage_unavailable"

async def get_gen_cards() -> list[dict]:
    sb = runtime.get_supabase()
    if not sb:
        return []
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("feed_cards").select("*").order("created_at", desc=True).limit(50).execute()
        )
        return res.data or []
    except Exception as e:
        print(f"[warn] get_gen_cards: {e}")
        return []

async def save_gen_cards(cards: list[dict]):
    sb = runtime.get_supabase()
    if not sb or not cards:
        return
    # Replace previous batch — delete all stored gen cards first
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("feed_cards").delete().eq("source", "ai").execute()
        )
    except Exception as e:
        print(f"[warn] save_gen_cards delete: {e}")
    rows = [
        {
            "id": card["id"], "type": card["type"], "type_label": card["type_label"],
            "cta": card.get("cta", "问问AI →"), "title": card["title"],
            "summary": card.get("summary", ""), "body": card.get("body", ""),
            "tags": card.get("tags", []), "hook_line": card.get("hook_line", ""),
            "image_url": card.get("image_url", ""), "keywords": card.get("keywords", []),
            "source": card.get("source", "ai"), "created_at": now(),
        }
        for card in cards
    ]
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("feed_cards").insert(rows).execute()
        )
    except Exception as e:
        print(f"[warn] save_gen_cards insert: {e}")

async def get_feed_mode() -> str:
    sb = runtime.get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings").select("value").eq("key", "feed_gen_mode").maybe_single().execute()
            )
            if res.data:
                return str(res.data.get("value", "ai"))
        except Exception as e:
            print(f"[warn] get_feed_mode: {e}")
    return _gen_mode

async def set_feed_mode(mode: str):
    global _gen_mode
    _gen_mode = mode
    sb = runtime.get_supabase()
    if sb:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings").upsert(
                    {"key": "feed_gen_mode", "value": mode, "updated_at": now()},
                    on_conflict="key"
                ).execute()
            )
        except Exception as e:
            print(f"[warn] set_feed_mode: {e}")


def normalized_privacy_settings(value: object) -> dict:
    settings = dict(DEFAULT_PRIVACY)
    if not isinstance(value, dict):
        return settings
    for key in (
        "allow_history_training",
        "allow_external_content_research",
        "daily_push",
        "anonymous_community_share",
    ):
        if isinstance(value.get(key), bool):
            settings[key] = value[key]
    settings["language"] = locales.normalize_preferred_locale(value.get("language"))
    return settings


def privacy_storage_key(uid: str) -> str:
    # app_settings predates per-user preferences and may be visible to broader
    # database roles in older installations. Do not place a raw user ID in it.
    digest = hashlib.sha256(uid.encode("utf-8")).hexdigest()
    return f"user_privacy:{digest}"


async def get_privacy(uid: Optional[str], fail_closed: bool = False) -> dict:
    """Load per-user privacy settings from the existing app_settings table.

    Namespaced keys avoid a new migration while still surviving Vercel cold
    starts. If storage is temporarily unavailable and no warm cache exists,
    conversation personalization fails closed.
    """

    key = uid or "singleton"
    cached = memstore.privacy.get(key)
    sb = runtime.get_supabase()
    if sb and uid:
        try:
            result = await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings")
                .select("value")
                .eq("key", privacy_storage_key(uid))
                .limit(1)
                .execute()
            )
            rows = list(getattr(result, "data", None) or [])
            if rows:
                stored_value = rows[0].get("value")
                if isinstance(stored_value, str):
                    stored_value = json.loads(stored_value)
                settings = normalized_privacy_settings(stored_value)
                memstore.privacy[key] = settings
                return settings

            # A successful query with no row means this user has never changed
            # the default.  It is not a storage failure and must not be
            # presented as an explicit privacy opt-out.  The database is the
            # source of truth, so also replace any stale process-local value.
            settings = dict(DEFAULT_PRIVACY)
            memstore.privacy[key] = settings
            return settings
        except Exception as exc:
            print(f"[warn] get_privacy: {exc}")
            if fail_closed:
                return {
                    **DEFAULT_PRIVACY,
                    "allow_history_training": False,
                    PRIVACY_STORAGE_UNAVAILABLE: True,
                }
    elif uid and fail_closed:
        return {
            **DEFAULT_PRIVACY,
            "allow_history_training": False,
            PRIVACY_STORAGE_UNAVAILABLE: True,
        }
    return normalized_privacy_settings(cached)


async def set_privacy(uid: Optional[str], settings: dict) -> dict:
    key = uid or "singleton"
    normalized = normalized_privacy_settings(settings)
    previous = memstore.privacy.get(key)
    memstore.privacy[key] = normalized
    sb = runtime.get_supabase()
    if uid and not sb:
        if previous is None:
            memstore.privacy.pop(key, None)
        else:
            memstore.privacy[key] = previous
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Privacy settings could not be saved",
        )
    if sb and uid:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings").upsert(
                    {
                        "key": privacy_storage_key(uid),
                        "value": json.dumps(normalized, ensure_ascii=False),
                        "updated_at": now(),
                    },
                    on_conflict="key",
                ).execute()
            )
        except Exception as exc:
            if previous is None:
                memstore.privacy.pop(key, None)
            else:
                memstore.privacy[key] = previous
            print(f"[warn] set_privacy: {exc}")
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Privacy settings could not be saved",
            ) from exc
    return normalized


async def delete_privacy(uid: str) -> None:
    memstore.privacy.pop(uid, None)
    sb = runtime.get_supabase()
    if not sb:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Privacy settings could not be deleted",
        )
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .eq("key", privacy_storage_key(uid))
            .execute()
        )
    except Exception as exc:
        print(f"[warn] delete_privacy: {exc}")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Privacy settings could not be deleted",
        ) from exc


async def persist_snapshots(
    uid: str,
    snapshots: list[dict],
) -> bool:
    """Atomically persist encrypted recommendation snapshots when storage exists."""

    if not snapshots:
        return True
    sb = runtime.get_supabase()
    if not sb or not RECOMMENDATION_SNAPSHOT_SECRET:
        return False
    ready_snapshots = [
        snapshot for snapshot in snapshots if prepared_resource_pair(snapshot)
    ]
    nonready_snapshots = [
        snapshot for snapshot in snapshots if not prepared_resource_pair(snapshot)
    ]

    def rows_for(values: list[dict]) -> list[dict]:
        return [
            {
                "key": snapshot_storage_key(uid, snapshot["recommendation_id"]),
                "value": serialize_snapshot(
                    snapshot,
                    secret=RECOMMENDATION_SNAPSHOT_SECRET,
                ),
                "updated_at": now(),
            }
            for snapshot in values
        ]

    try:
        if nonready_snapshots:
            nonready_rows = rows_for(nonready_snapshots)
            # DO NOTHING on conflict is the monotonicity boundary. An old
            # preparing/retryable/feed write can create a snapshot, but can
            # never replace a complete pair published by a newer invocation.
            await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings")
                .upsert(
                    nonready_rows,
                    on_conflict="key",
                    ignore_duplicates=True,
                )
                .execute()
            )
        if ready_snapshots:
            ready_rows = rows_for(ready_snapshots)
            await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings")
                .upsert(ready_rows, on_conflict="key")
                .execute()
            )
    except Exception as exc:
        print(f"[warn] recommendation snapshot persistence failed: {exc}")
        return False

    for snapshot in ready_snapshots:
        memstore.recommendation_snapshots[(uid, snapshot["recommendation_id"])] = snapshot
    # Resolve insert-vs-conflict from durable storage before caching or exposing
    # a non-ready snapshot. Only a complete durable pair is allowed to replace
    # the caller's state. If storage still says ``preparing``, a provider
    # failure in this invocation must remain ``retryable`` in the response so
    # the client can schedule another attempt.
    for snapshot in nonready_snapshots:
        current = await get_snapshot_persistent(
            uid,
            snapshot["recommendation_id"],
        )
        if current and prepared_resource_pair(current):
            snapshot.clear()
            snapshot.update(current)
        memstore.recommendation_snapshots[(uid, snapshot["recommendation_id"])] = snapshot
    return True



async def get_snapshot(
    uid: str,
    recommendation_id: Optional[str],
) -> Optional[dict]:
    if not recommendation_id:
        return None
    try:
        snapshot_storage_key(uid, recommendation_id)
    except ValueError:
        return None

    cached = parse_snapshot(memstore.recommendation_snapshots.get((uid, recommendation_id)))
    try:
        snapshot = await get_snapshot_persistent(
            uid,
            recommendation_id,
        )
    except HTTPException:
        if cached:
            return cached
        raise
    if snapshot:
        memstore.recommendation_snapshots[(uid, recommendation_id)] = snapshot
        return snapshot
    return cached


async def get_snapshot_persistent(
    uid: str,
    recommendation_id: Optional[str],
) -> Optional[dict]:
    """Read storage directly so stale process state cannot downgrade ready data."""

    if not recommendation_id:
        return None
    try:
        key = snapshot_storage_key(uid, recommendation_id)
    except ValueError:
        return None
    sb = runtime.get_supabase()
    if not sb:
        return None
    try:
        result = await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .select("value")
            .eq("key", key)
            .limit(1)
            .execute()
        )
        rows = list(getattr(result, "data", None) or [])
        snapshot = (
            parse_snapshot(
                rows[0].get("value"),
                secret=RECOMMENDATION_SNAPSHOT_SECRET,
            )
            if rows and RECOMMENDATION_SNAPSHOT_SECRET
            else None
        )
        return snapshot
    except Exception as exc:
        print(f"[warn] recommendation snapshot lookup failed: {exc}")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation context is temporarily unavailable",
        ) from exc


async def delete_snapshots(uid: str) -> None:
    for cache_key in [key for key in memstore.recommendation_snapshots if key[0] == uid]:
        memstore.recommendation_snapshots.pop(cache_key, None)
    sb = runtime.get_supabase()
    if not sb:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation history could not be deleted",
        )
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .like("key", f"{snapshot_storage_prefix(uid)}%")
            .execute()
        )
    except Exception as exc:
        print(f"[warn] recommendation snapshot delete failed: {exc}")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation history could not be deleted",
        ) from exc


async def list_fav_ids(uid: str) -> set:
    sb = runtime.get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").select("card_id").eq("user_id", uid).execute()
            )
            return {r["card_id"] for r in (res.data or [])}
        except Exception as e:
            print(f"[warn] list_fav_ids: {e}")
    return memstore.favorites.get(uid, set())

async def toggle_fav(uid: str, card_id: str) -> bool:
    sb = runtime.get_supabase()
    if sb:
        try:
            existing = await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").select("id").eq("user_id", uid).eq("card_id", card_id).execute()
            )
            if existing.data:
                await anyio.to_thread.run_sync(
                    lambda: sb.table("favorites").delete().eq("user_id", uid).eq("card_id", card_id).execute()
                )
                return False
            await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").insert({"user_id": uid, "card_id": card_id}).execute()
            )
            return True
        except Exception as e:
            print(f"[warn] toggle_fav: {e}")
    # fallback
    memstore.favorites.setdefault(uid, set())
    if card_id in memstore.favorites[uid]:
        memstore.favorites[uid].discard(card_id)
        return False
    memstore.favorites[uid].add(card_id)
    return True

async def list_collections(uid: str) -> list:
    sb = runtime.get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("collections").select("id,name,created_at").eq("user_id", uid).order("created_at").execute()
            )
            return res.data or []
        except Exception as e:
            print(f"[warn] list_collections: {e}")
    return memstore.collections.get(uid, [])

async def create_collection(uid: str, name: str) -> dict:
    now_iso = now()
    sb = runtime.get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("collections").insert({"user_id": uid, "name": name}).execute()
            )
            return res.data[0]
        except Exception as e:
            print(f"[warn] create_collection: {e}")
    col = {"id": str(uuid.uuid4()), "name": name, "created_at": now_iso}
    memstore.collections.setdefault(uid, []).append(col)
    return col

async def rename_collection(uid: str, col_id: str, name: str) -> bool:
    sb = runtime.get_supabase()
    if sb:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("collections").update({"name": name}).eq("id", col_id).eq("user_id", uid).execute()
            )
            return True
        except Exception as e:
            print(f"[warn] rename_collection: {e}")
    for col in memstore.collections.get(uid, []):
        if col["id"] == col_id:
            col["name"] = name
            return True
    return False

async def delete_collection(uid: str, col_id: str) -> bool:
    sb = runtime.get_supabase()
    if sb:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("collections").delete().eq("id", col_id).eq("user_id", uid).execute()
            )
            return True
        except Exception as e:
            print(f"[warn] delete_collection: {e}")
    cols = memstore.collections.get(uid, [])
    memstore.collections[uid] = [c for c in cols if c["id"] != col_id]
    return True

async def save_fav(uid: str, card_id: str, collection_id: str) -> bool:
    """Save card to collection. If already in that collection, removes it (toggle). Returns saved state."""
    sb = runtime.get_supabase()
    if sb:
        try:
            existing = await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").select("id,collection_id").eq("user_id", uid).eq("card_id", card_id).execute()
            )
            if existing.data:
                row = existing.data[0]
                if row.get("collection_id") == collection_id:
                    await anyio.to_thread.run_sync(
                        lambda: sb.table("favorites").delete().eq("user_id", uid).eq("card_id", card_id).execute()
                    )
                    return False
                await anyio.to_thread.run_sync(
                    lambda: sb.table("favorites").update({"collection_id": collection_id}).eq("user_id", uid).eq("card_id", card_id).execute()
                )
                return True
            await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").insert({"user_id": uid, "card_id": card_id, "collection_id": collection_id}).execute()
            )
            return True
        except Exception as e:
            print(f"[warn] save_fav: {e}")
    # fallback in-memory
    memstore.favorites.setdefault(uid, set())
    memstore.fav_cols.setdefault(uid, {})
    if card_id in memstore.favorites[uid] and memstore.fav_cols[uid].get(card_id) == collection_id:
        memstore.favorites[uid].discard(card_id)
        memstore.fav_cols[uid].pop(card_id, None)
        return False
    memstore.favorites[uid].add(card_id)
    memstore.fav_cols[uid][card_id] = collection_id
    return True
