"""Consumer self-deletion for NURI's custom JWT / public.users identity.

No Supabase Auth admin API, Stripe, mail, or model provider is involved. The
identity DELETE follows owned-content cleanup; its FK cascades are one DB
statement. The protective privacy tombstone is erased only after identity loss.
Ancillary FK-free stores require separate statements: preflight prevents known
dependency failures from beginning deletion, but this is deliberately NOT a
cross-worker transaction. Once cleanup begins, failures describe partial or
unconfirmed deletion, never a safe rollback. Already-authorized work in another
worker is not retroactively cancelled; strict atomic erasure needs a separately
approved database transaction/deletion-state design.
"""

from __future__ import annotations

from collections.abc import Callable
import json
from datetime import datetime, timezone

import anyio
from fastapi import HTTPException

from backend import memstore, stores
from backend.nuri_core import family, outcome
from backend.nuri_core.outcome_store import event_setting_prefix
from backend.recommendation_feedback import event_storage_key
from backend.recommendation_snapshots import snapshot_storage_prefix


# These have no users FK in the checked-in migrations. All other owned tables
# (children, conversations/messages, memory, tasks/cards, feedback, notification
# devices/events/deliveries, visits, email logs and local billing caches) cascade
# from public.users. Deployments must verify those existing migrations before
# enabling this route. Provider billing records/subscriptions are NOT cancelled.
_NON_CASCADE_TABLES = (
    ("favorites", False),
    ("collections", False),
    ("llm_call_logs", True),
    ("nuri_turn_outcomes", True),
    ("nuri_turn_traces", True),
    # Legacy reviewer eligibility is account-bound but has no checked-in FK.
    ("fix_reviewers", True),
)
_PRIVACY_FLAGS = ("allow_history_training", "allow_external_content_research",
                  "daily_push", "anonymous_community_share")


def _failure(code: str, *, state: str) -> HTTPException:
    # Never include passwords, JWTs, raw identities, or dependency errors.
    return HTTPException(503, {"code": code, "deletion_state": state})


def _rows(result) -> list[dict]:
    rows = getattr(result, "data", None)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise RuntimeError("invalid account storage response")
    return rows


async def load_account(sb, uid: str, *, fields: str = "id,email,hashed_password") -> dict | None:
    """Fresh durable existence check. DB outages do not authenticate via cache."""
    if sb is None:
        raise HTTPException(503, "Account storage is temporarily unavailable")
    try:
        rows = _rows(await anyio.to_thread.run_sync(
            lambda: sb.table("users").select(fields).eq("id", uid).limit(1).execute()
        ))
    except Exception as exc:
        raise HTTPException(503, "Account storage is temporarily unavailable") from exc
    if rows and rows[0].get("id") != uid:
        raise HTTPException(503, "Account storage is temporarily unavailable")
    return rows[0] if rows else None


def _optional_table_missing(exc: Exception, table: str) -> bool:
    # Missing optional rollout tables contain no data to delete. Permissions,
    # connection failures and missing required tables never get this exemption.
    if str(getattr(exc, "code", "")) in {"42P01", "PGRST205"}:
        return True
    message = str(exc).casefold()
    return table in message and any(marker in message for marker in (
        "does not exist", "could not find the table", "undefined table",
    ))


def _setting_scopes(uid: str) -> tuple[tuple[str, str], ...]:
    return (
        ("eq", stores.privacy_storage_key(uid)),
        ("like", snapshot_storage_prefix(uid) + "%"),
        ("eq", event_storage_key(uid)),
        ("like", event_setting_prefix(uid) + "%"),
    )


def _scoped_settings_query(sb, operation: str, kind: str, key: str):
    query = sb.table("app_settings")
    query = query.select("key").limit(1) if operation == "select" else query.delete()
    return getattr(query, kind)("key", key)


def _purge_memory(uid: str, email: str) -> None:
    """Only this process's own-account caches; never clear another family."""
    memstore.users_id.pop(uid, None)
    cached = memstore.users_email.get(email)
    if cached and cached.get("id") == uid:
        memstore.users_email.pop(email, None)
    memstore.children[:] = [row for row in memstore.children if row.get("user_id") != uid]
    memstore.tasks[:] = [row for row in memstore.tasks if row.get("user_id") != uid]
    memstore.analytics[:] = [row for row in memstore.analytics if row.get("user_id") != uid]
    for sid in [sid for sid, row in memstore.sessions.items() if row.get("user_id") == uid]:
        memstore.sessions.pop(sid, None)
        memstore.messages.pop(sid, None)
    for mapping in (memstore.favorites, memstore.collections, memstore.fav_cols,
                    memstore.privacy, memstore.recommendation_events,
                    memstore.recommendation_event_locks):
        mapping.pop(uid, None)
    for key in [key for key in memstore.recommendation_snapshots if key[0] == uid]:
        memstore.recommendation_snapshots.pop(key, None)
    family.invalidate(uid)
    outcome.invalidate(uid)


async def delete_account(sb, uid: str, password: str,
                         verify_password: Callable[[str, str], bool], *,
                         privileged_storage: bool) -> None:
    # runtime also supports an anon-key fallback. RLS can silently hide rows
    # from that role, so empty SELECT/DELETE is not proof of complete erasure.
    # Only a deliberately configured server service role may enter this flow.
    if not privileged_storage:
        raise _failure("ACCOUNT_DELETION_UNAVAILABLE", state="not_started")
    user = await load_account(sb, uid)
    if user is None:
        raise HTTPException(401, "Account no longer exists")
    hashed = user.get("hashed_password")
    email = user.get("email")
    if not isinstance(hashed, str) or not isinstance(email, str) or not email:
        raise _failure("ACCOUNT_DELETION_UNAVAILABLE", state="not_started")
    if not await anyio.to_thread.run_sync(lambda: verify_password(password, hashed)):
        # This is reauthentication failure, NOT expiration of a valid session.
        raise HTTPException(403, {"code": "ACCOUNT_REAUTH_FAILED", "deletion_state": "not_started"})

    available_tables: list[str] = []
    scopes = _setting_scopes(uid)
    try:
        for table, optional in _NON_CASCADE_TABLES:
            try:
                _rows(await anyio.to_thread.run_sync(
                    lambda table=table: sb.table(table).select("user_id")
                    .eq("user_id", uid).limit(1).execute()
                ))
            except Exception as exc:
                if optional and _optional_table_missing(exc, table):
                    continue
                raise
            available_tables.append(table)
        for kind, key in scopes:
            _rows(await anyio.to_thread.run_sync(
                lambda kind=kind, key=key: _scoped_settings_query(sb, "select", kind, key).execute()
            ))
        _rows(await anyio.to_thread.run_sync(
            lambda: sb.table("email_codes").select("email").eq("email", email).limit(1).execute()
        ))
        # Password reset during preflight must not begin removing data under
        # the old proof. The final DELETE also compares the exact proven hash.
        current = await load_account(sb, uid)
        if current is None or current.get("hashed_password") != hashed:
            raise HTTPException(403, {"code": "ACCOUNT_REAUTH_FAILED", "deletion_state": "not_started"})
    except HTTPException as exc:
        if exc.status_code == 403:
            raise
        raise _failure("ACCOUNT_DELETION_UNAVAILABLE", state="not_started") from exc
    except Exception as exc:
        raise _failure("ACCOUNT_DELETION_UNAVAILABLE", state="not_started") from exc

    # Removing privacy before the identity could revive default-on preferences
    # if the final identity DELETE fails. Persist an explicit all-false marker
    # using this already-checked privileged client; only remove it after durable
    # identity absence. A failed write/readback begins no destructive deletion.
    privacy_key = stores.privacy_storage_key(uid)
    tombstone = {**stores.DEFAULT_PRIVACY, **{key: False for key in _PRIVACY_FLAGS}}
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings").upsert({
                "key": privacy_key,
                "value": json.dumps(tombstone, ensure_ascii=False),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }, on_conflict="key").execute()
        )
        rows = _rows(await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings").select("value").eq("key", privacy_key).limit(1).execute()
        ))
        value = rows[0].get("value") if len(rows) == 1 else None
        if isinstance(value, str):
            value = json.loads(value)
        if not isinstance(value, dict) or any(value.get(key) is not False for key in _PRIVACY_FLAGS):
            raise RuntimeError("privacy opt-out was not confirmed")
    except Exception as exc:
        raise _failure("ACCOUNT_DELETION_UNAVAILABLE", state="not_started") from exc
    memstore.privacy[uid] = dict(tombstone)

    try:
        for table in available_tables:
            await anyio.to_thread.run_sync(
                lambda table=table: sb.table(table).delete().eq("user_id", uid).execute()
            )
        for kind, key in scopes:
            if kind == "eq" and key == privacy_key:
                continue
            await anyio.to_thread.run_sync(
                lambda kind=kind, key=key: _scoped_settings_query(sb, "delete", kind, key).execute()
            )
        await anyio.to_thread.run_sync(
            lambda: sb.table("email_codes").delete().eq("email", email).execute()
        )
    except Exception as exc:
        raise _failure("ACCOUNT_DELETION_INCOMPLETE", state="partial") from exc

    # FK cascades and identity removal commit atomically in this one statement.
    # A timeout may mean it committed. Never label that an intact-account error.
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("users").delete().eq("id", uid)
            .eq("hashed_password", hashed).execute()
        )
    except Exception:
        pass  # Read durable state below, without exposing dependency details.
    try:
        remaining = await load_account(sb, uid, fields="id")
    except HTTPException as exc:
        raise _failure("ACCOUNT_DELETION_UNCONFIRMED", state="unknown") from exc
    if remaining is not None:
        raise _failure("ACCOUNT_DELETION_INCOMPLETE", state="partial")
    _purge_memory(uid, email)
    # Identity is already gone. Failure to finish this final metadata cleanup
    # cannot be called a fully successful erasure or an intact-account failure.
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings").delete().eq("key", privacy_key).execute()
        )
    except Exception:
        pass  # It may have committed; confirm durable absence below.
    try:
        rows = _rows(await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings").select("key").eq("key", privacy_key).limit(1).execute()
        ))
    except Exception as exc:
        raise _failure("ACCOUNT_DELETION_UNCONFIRMED", state="unknown") from exc
    if rows:
        raise _failure("ACCOUNT_DELETION_UNCONFIRMED", state="unknown")
