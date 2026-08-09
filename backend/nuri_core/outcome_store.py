"""4 结果学习模型 — recommendation engagement.

The other outcome stream. `outcome.py` learns from what happened after a chat
reply; this learns from what happened after a recommendation was shown —
impressions, opens, dwell, favourites, "not relevant". Both belong to the same
subsystem, and both exist so ranking can be tuned against what parents actually
did rather than against what someone assumed they would.

Storage is deliberately awkward, and the reason matters: `recommendation_events`
is a real table when the migration has been run, and a set of rows in
`app_settings` when it has not. Every deployed NURI database already has
`app_settings`, so the fallback means engagement learning starts working
without a schema change being a prerequisite. The table is probed once per
process and the result cached in `_table_available`.

Nothing here stores conversation text, resource titles or raw identifiers — see
recommendation_feedback.py, which owns the privacy-safe normalisation this
module persists.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import anyio
from fastapi import HTTPException, status

from backend import memstore
from backend.recommendation_feedback import (
    EVENT_RETENTION_DAYS,
    MAX_EVENTS_PER_USER,
    event_storage_key,
    normalize_event,
    prune_events,
)
from backend import runtime
from backend.runtime import get_supabase, now

#: Probed on first use, then cached: True when the dedicated table exists,
#: False when the app_settings fallback is in play, None before either is known.
_table_available: Optional[bool] = None

EVENTS_TABLE = "recommendation_events"
EVENTS_LIMIT = MAX_EVENTS_PER_USER
EVENTS_CLEANUP_PAGE = 1000
EVENTS_DELETE_BATCH = 50


def events_table_missing(exc: Exception) -> bool:
    """Recognise the PostgREST/Postgres errors emitted before migration.

    Only an absent table activates the legacy JSON fallback. Other database
    failures must not silently resume read/modify/write persistence, because
    doing so would reintroduce cross-instance lost updates.
    """

    code = str(getattr(exc, "code", "") or "").upper()
    details = " ".join(
        str(value)
        for value in (
            exc,
            getattr(exc, "message", ""),
            getattr(exc, "details", ""),
        )
    ).casefold()
    if code in {"42P01", "PGRST205"}:
        return True
    return "recommendation_events" in details and any(
        marker in details
        for marker in (
            "does not exist",
            "could not find",
            "schema cache",
            "undefined table",
            "undefined_table",
        )
    )


def event_row(uid: str, event: dict) -> dict:
    """Map a normalized signal to one append-only database row."""

    metadata = {
        key: value
        for key, value in event.items()
        if key not in {"event_id", "event", "card_id", "occurred_at"}
    }
    return {
        "user_id": uid,
        "event_id": str(event["event_id"]),
        "event_type": str(event["event"]),
        "card_id": str(event["card_id"]),
        "occurred_at": str(event["occurred_at"]),
        "event_data": metadata,
    }


def event_setting_prefix(uid: str) -> str:
    """Return the non-identifying per-event fallback key prefix."""

    user_digest = hashlib.sha256(uid.encode("utf-8")).hexdigest()
    return f"recommendation_event:v2:{user_digest}:"


def event_setting_key(uid: str, event_id: str) -> str:
    event_digest = hashlib.sha256(event_id.encode("utf-8")).hexdigest()
    return f"{event_setting_prefix(uid)}{event_digest}"


def event_setting_rows(uid: str, events: list[dict]) -> list[dict]:
    """Map events to independently upsertable app_settings rows."""

    return [
        {
            "key": event_setting_key(uid, str(event["event_id"])),
            "value": json.dumps(event, ensure_ascii=False),
            "updated_at": str(event["occurred_at"]),
        }
        for event in events
    ]


def event_retention_cutoff() -> str:
    """Return the UTC cutoff shared by logical and physical retention."""

    return (
        datetime.now(timezone.utc) - timedelta(days=EVENT_RETENTION_DAYS)
    ).isoformat()


async def cleanup_event_table(sb: object, uid: str) -> None:
    """Physically enforce age and count retention in the migrated row table.

    The stale delete is handled entirely by PostgREST.  Overflow is paged from
    the first row beyond the newest bounded history and removed in batches;
    repeatedly reading from the same offset also handles histories larger than
    PostgREST's normal 1,000-row response cap.
    """

    cutoff = event_retention_cutoff()
    await anyio.to_thread.run_sync(
        lambda: sb.table(EVENTS_TABLE)
        .delete()
        .eq("user_id", uid)
        .lt("occurred_at", cutoff)
        .execute()
    )
    while True:
        result = await anyio.to_thread.run_sync(
            lambda: sb.table(EVENTS_TABLE)
            .select("event_id")
            .eq("user_id", uid)
            .order("occurred_at", desc=True)
            .range(
                EVENTS_LIMIT,
                EVENTS_LIMIT
                + EVENTS_CLEANUP_PAGE
                - 1,
            )
            .execute()
        )
        event_ids = [
            str(row.get("event_id"))
            for row in list(getattr(result, "data", None) or [])
            if isinstance(row, dict) and row.get("event_id")
        ]
        if not event_ids:
            return
        for start in range(0, len(event_ids), EVENTS_DELETE_BATCH):
            batch = event_ids[start : start + EVENTS_DELETE_BATCH]
            await anyio.to_thread.run_sync(
                lambda batch=batch: sb.table(EVENTS_TABLE)
                .delete()
                .eq("user_id", uid)
                .in_("event_id", batch)
                .execute()
            )


async def cleanup_event_settings(sb: object, uid: str) -> None:
    """Physically enforce retention for migration-free atomic v2 rows."""

    prefix = event_setting_prefix(uid)
    cutoff = event_retention_cutoff()
    await anyio.to_thread.run_sync(
        lambda: sb.table("app_settings")
        .delete()
        .like("key", f"{prefix}%")
        .lt("updated_at", cutoff)
        .execute()
    )
    while True:
        result = await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .select("key")
            .like("key", f"{prefix}%")
            .order("updated_at", desc=True)
            .range(
                EVENTS_LIMIT,
                EVENTS_LIMIT
                + EVENTS_CLEANUP_PAGE
                - 1,
            )
            .execute()
        )
        keys = [
            str(row.get("key"))
            for row in list(getattr(result, "data", None) or [])
            if isinstance(row, dict) and row.get("key")
        ]
        if not keys:
            break
        for start in range(0, len(keys), EVENTS_DELETE_BATCH):
            batch = keys[start : start + EVENTS_DELETE_BATCH]
            await anyio.to_thread.run_sync(
                lambda batch=batch: sb.table("app_settings")
                .delete()
                .like("key", f"{prefix}%")
                .in_("key", batch)
                .execute()
            )

    # v1 is no longer appended, so compacting its single legacy JSON value
    # cannot race with a writer.  Keep it only for rollout compatibility while
    # enforcing the same physical age/count boundary as both append-only paths.
    legacy_key = event_storage_key(uid)
    legacy_result = await anyio.to_thread.run_sync(
        lambda: sb.table("app_settings")
        .select("value")
        .eq("key", legacy_key)
        .limit(1)
        .execute()
    )
    legacy_rows = list(getattr(legacy_result, "data", None) or [])
    if not legacy_rows:
        return
    legacy: object = (
        legacy_rows[0].get("value")
        if isinstance(legacy_rows[0], dict)
        else None
    )
    if isinstance(legacy, str):
        try:
            legacy = json.loads(legacy)
        except (TypeError, ValueError):
            legacy = []
    retained = prune_events(legacy)
    if retained == legacy:
        return
    if not retained:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .eq("key", legacy_key)
            .execute()
        )
        return
    await anyio.to_thread.run_sync(
        lambda: sb.table("app_settings")
        .upsert(
            {
                "key": legacy_key,
                "value": json.dumps(retained, ensure_ascii=False),
                "updated_at": now(),
            },
            on_conflict="key",
        )
        .execute()
    )


async def cleanup_events_best_effort(
    sb: object,
    uid: str,
    *,
    include_row_table: bool,
) -> None:
    """Run retention without changing the success of an already-stored event."""

    if include_row_table:
        try:
            await cleanup_event_table(sb, uid)
        except Exception as exc:
            print(
                "[warn] recommendation event row retention cleanup failed: "
                f"{type(exc).__name__}"
            )
    # Clean rollout fallback rows even after the table becomes available so an
    # environment cannot retain old v2 rows forever following its migration.
    try:
        await cleanup_event_settings(sb, uid)
    except Exception as exc:
        print(
            "[warn] settings recommendation event retention cleanup failed: "
            f"{type(exc).__name__}"
        )


def event_from_row(row: object) -> Optional[dict]:
    """Restore and revalidate a signal loaded from the row table."""

    if not isinstance(row, dict):
        return None
    metadata: object = row.get("event_data")
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (TypeError, ValueError):
            metadata = {}
    payload = dict(metadata) if isinstance(metadata, dict) else {}
    event_type = row.get("event_type")
    payload.update(
        {
            "event_id": row.get("event_id"),
            "event": event_type,
            "card_id": row.get("card_id"),
        }
    )
    occurred_at = row.get("occurred_at")
    if isinstance(occurred_at, datetime):
        occurred_at = occurred_at.isoformat()
    if not isinstance(occurred_at, str):
        return None
    return normalize_event(
        payload,
        occurred_at=occurred_at,
        trusted_resource_url=event_type == "resource_delivered",
    )


async def get_events_settings(
    uid: str,
    *,
    cached: Optional[list[dict]] = None,
) -> list[dict]:
    """Read atomic per-event settings plus the read-only legacy JSON value."""

    sb = runtime.get_supabase()
    if not sb:
        return prune_events(cached or [])
    try:
        per_event_result = await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .select("value")
            .like("key", f"{event_setting_prefix(uid)}%")
            .order("updated_at", desc=True)
            .limit(EVENTS_LIMIT)
            .execute()
        )
        legacy_result = await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .select("value")
            .eq("key", event_storage_key(uid))
            .limit(1)
            .execute()
        )
        per_event_rows = list(getattr(per_event_result, "data", None) or [])
        stored_events: list[object] = []
        for row in per_event_rows:
            stored: object = row.get("value") if isinstance(row, dict) else None
            if isinstance(stored, str):
                try:
                    stored = json.loads(stored)
                except (TypeError, ValueError):
                    continue
            stored_events.append(stored)

        # v1 was one mutable JSON array. It remains read-only so an in-flight
        # migration cannot lose old learning signals, but all new writes use a
        # unique v2 key per event.
        legacy_rows = list(getattr(legacy_result, "data", None) or [])
        legacy: object = legacy_rows[0].get("value") if legacy_rows else []
        if isinstance(legacy, str):
            try:
                legacy = json.loads(legacy)
            except (TypeError, ValueError):
                legacy = []
        if isinstance(legacy, list):
            stored_events.extend(legacy)
        return prune_events(stored_events)
    except Exception as exc:
        print(f"[warn] settings recommendation event lookup failed: {type(exc).__name__}")
        return prune_events(cached or [])


async def get_events(uid: str) -> list[dict]:
    """Load bounded, privacy-safe recommendation behaviour for one user."""

    global _table_available
    cached = memstore.recommendation_events.get(uid)
    sb = runtime.get_supabase()
    if not sb:
        return prune_events(cached or [])
    if _table_available is False:
        events = await get_events_settings(uid, cached=cached)
        memstore.recommendation_events[uid] = events
        return events
    try:
        result = await anyio.to_thread.run_sync(
            lambda: sb.table(EVENTS_TABLE)
            .select("event_id,event_type,card_id,occurred_at,event_data")
            .eq("user_id", uid)
            .order("occurred_at", desc=True)
            .limit(EVENTS_LIMIT)
            .execute()
        )
        rows = list(getattr(result, "data", None) or [])
        row_events = [
            event for row in rows if (event := event_from_row(row))
        ]
        # Continue reading rollout rows after the table appears. This closes the
        # deployment window where one instance has already discovered the new
        # table while another has just written an atomic v2 settings row.
        settings_events = await get_events_settings(uid)
        events = prune_events(
            [*row_events, *settings_events]
        )
        _table_available = True
        memstore.recommendation_events[uid] = events
        return events
    except Exception as exc:
        if events_table_missing(exc):
            _table_available = False
            events = await get_events_settings(uid, cached=cached)
            memstore.recommendation_events[uid] = events
            return events
        # Feedback may refine a recommendation but must never make the home feed
        # unavailable. A warm process can still use its bounded local copy.
        print(f"[warn] recommendation event lookup failed: {type(exc).__name__}")
        return prune_events(cached or [])


async def append_events(
    uid: str,
    payloads: list[dict],
) -> tuple[list[dict], bool]:
    """Atomically append idempotent event rows across backend instances."""

    global _table_available
    if not payloads:
        return await get_events(uid), True
    lock = memstore.recommendation_event_locks.setdefault(uid, asyncio.Lock())
    async with lock:
        existing = await get_events(uid)
        known_ids = {
            str(item.get("event_id") or "")
            for item in existing
            if item.get("event_id")
        }
        merged = list(existing)
        prepared: list[dict] = []
        for payload in payloads:
            item = dict(payload)
            event_id = str(item.get("event_id") or uuid.uuid4())[:80]
            item["event_id"] = event_id
            if event_id and event_id in known_ids:
                continue
            merged.append(item)
            prepared.append(item)
            if event_id:
                known_ids.add(event_id)
        merged = prune_events(merged)
        memstore.recommendation_events[uid] = merged

        if not prepared:
            return merged, True

        sb = runtime.get_supabase()
        if not sb:
            return merged, False
        if _table_available is False:
            try:
                await anyio.to_thread.run_sync(
                    lambda: sb.table("app_settings").upsert(
                        event_setting_rows(uid, prepared),
                        on_conflict="key",
                        ignore_duplicates=True,
                    ).execute()
                )
                await cleanup_events_best_effort(
                    sb,
                    uid,
                    include_row_table=False,
                )
                stored = await get_events_settings(
                    uid,
                    cached=merged,
                )
                memstore.recommendation_events[uid] = stored
                return stored, True
            except Exception as settings_exc:
                print(
                    "[warn] settings recommendation event persistence failed: "
                    f"{type(settings_exc).__name__}"
                )
                return merged, False
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table(EVENTS_TABLE)
                .upsert(
                    [event_row(uid, event) for event in prepared],
                    on_conflict="user_id,event_id",
                    ignore_duplicates=True,
                )
                .execute()
            )
            _table_available = True
            await cleanup_events_best_effort(
                sb,
                uid,
                include_row_table=True,
            )
            # Re-read so this process immediately sees events appended by other
            # instances between its initial read and atomic insert.
            return await get_events(uid), True
        except Exception as exc:
            if events_table_missing(exc):
                _table_available = False
                # The migration-free fallback still appends atomically: every
                # event owns a unique app_settings key. Never rewrite the old
                # per-user JSON array, which could lose concurrent events.
                try:
                    await anyio.to_thread.run_sync(
                        lambda: sb.table("app_settings").upsert(
                            event_setting_rows(uid, prepared),
                            on_conflict="key",
                            ignore_duplicates=True,
                        ).execute()
                    )
                    await cleanup_events_best_effort(
                        sb,
                        uid,
                        include_row_table=False,
                    )
                    stored = await get_events_settings(
                        uid,
                        cached=merged,
                    )
                    memstore.recommendation_events[uid] = stored
                    return stored, True
                except Exception as settings_exc:
                    print(
                        "[warn] settings recommendation event persistence failed: "
                        f"{type(settings_exc).__name__}"
                    )
                    return merged, False
            print(f"[warn] recommendation event persistence failed: {type(exc).__name__}")
            return merged, False


async def delete_events(uid: str) -> None:
    global _table_available
    memstore.recommendation_events.pop(uid, None)
    memstore.recommendation_event_locks.pop(uid, None)
    sb = runtime.get_supabase()
    if not sb:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation feedback could not be deleted",
        )
    if _table_available is not False:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table(EVENTS_TABLE)
                .delete()
                .eq("user_id", uid)
                .execute()
            )
            _table_available = True
        except Exception as exc:
            if events_table_missing(exc):
                _table_available = False
            else:
                print(f"[warn] recommendation event delete failed: {exc}")
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    "Recommendation feedback could not be deleted",
                ) from exc

    # Delete both the atomic v2 fallback rows and read-only v1 compatibility
    # value. Once every environment has the new table these remain harmless
    # no-ops and guarantee privacy erasure of rollout data.
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .like("key", f"{event_setting_prefix(uid)}%")
            .execute()
        )
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .eq("key", event_storage_key(uid))
            .execute()
        )
    except Exception as exc:
        print(f"[warn] settings recommendation event delete failed: {exc}")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation feedback could not be deleted",
        ) from exc


def new_event(
    *,
    event: str,
    card_id: str,
    trusted_resource_url: bool = False,
    **payload: object,
) -> dict:
    occurred_at = now()
    normalized = normalize_event(
        {
            "event_id": str(uuid.uuid4()),
            "event": event,
            "card_id": card_id,
            **payload,
        },
        occurred_at=occurred_at,
        trusted_resource_url=trusted_resource_url,
    )
    if not normalized:  # All server-created callers use the allowlist.
        raise ValueError("invalid recommendation event")
    return normalized
