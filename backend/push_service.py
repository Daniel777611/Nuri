"""Create notification events, and deliver the ones that are due.

Two halves that the handoff insists stay apart (§9.1): business code only ever
*creates* an event, and a single dispatcher decides whether it may be sent. The
separation is what makes quiet hours, per-day caps and device fan-out one
decision in one place instead of a rule every caller has to remember.

Everything the parent sees is composed in
``backend.nuri_core.care_notifications``; this module is the part that touches
the database, the model, Apple and Google.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time as dt_time, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anyio

from backend import llm_usage, push_apns, push_fcm
from backend.nuri_core import care_notifications as care

log = logging.getLogger("nuri.push")

CARE_THREAD_ID = "nuri-care"

#: One sender per platform. Both take the same keywords and return the same
#: result type, so the dispatch loop below never branches on platform.
_SENDERS = {"ios": push_apns, "android": push_fcm}

#: How many events one dispatch run will claim. Vercel's cron fires every five
#: minutes, so this only has to keep up with a backlog, not drain one instantly.
DEFAULT_BATCH_SIZE = 100

#: §13 bans the raw token, the payload text and the user's own words from logs.
#: Only these fields are ever logged.
_SAFE_LOG_FIELDS = (
    "event_id", "delivery_id", "device_id", "apns_id",
    "environment", "http_status", "reason", "latency_ms", "attempt",
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _log_safe(message: str, **fields: Any) -> None:
    payload = {k: v for k, v in fields.items() if k in _SAFE_LOG_FIELDS}
    log.info("%s %s", message, payload)


# ── Creating the daily events ─────────────────────────────────────────────────

#: Local hour the care line goes out. The featured post goes out when the day's
#: run makes it (the morning, for most parents); care waits for the evening, so
#: the two never land on the lock screen together.
CARE_LOCAL_HOUR = 18


def _zone(prefs: dict) -> Any:
    try:
        return ZoneInfo(prefs.get("time_zone") or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


def next_local_hour(prefs: dict, hour: int, now: datetime) -> datetime:
    """The next time the parent's own clock reads ``hour``:00, in UTC."""
    local = now.astimezone(_zone(prefs))
    target = local.replace(hour=hour, minute=0, second=0, microsecond=0)
    if target <= local:
        target += timedelta(days=1)
    return target.astimezone(timezone.utc)


async def _featured_post(sb: Any, uid: str) -> Optional[dict]:
    """The parent's featured post for their local day, making it if needed.

    The same card Home shows (backend/feed/daily_post.py), so the notification
    and the app agree. Making one searches and calls a model, which takes a few
    seconds; a failure only means there is no post notification today.
    """
    from backend.feed import daily_post as feed_daily_post

    zone = (await anyio.to_thread.run_sync(lambda: _preferences(sb, uid))).get("time_zone")
    try:
        result = await feed_daily_post.get_daily_post(uid, zone)
    except Exception as exc:  # noqa: BLE001 - the notification can go without it
        log.warning("featured post failed: %s", type(exc).__name__)
        return None
    card = result.get("card") if result.get("state") == "ready" else None
    return card if card and card.get("id") and card.get("headline") else None


async def _queue(sb: Any, row: dict) -> Optional[dict]:
    """Insert one event unless its dedupe key already exists; give it its route."""

    def _insert() -> list[dict]:
        return (
            sb.table("notification_events")
            .upsert(row, on_conflict="dedupe_key", ignore_duplicates=True)
            .execute()
            .data
            or []
        )

    inserted = await anyio.to_thread.run_sync(_insert)
    if not inserted:
        return None  # Already queued for this account today.

    event = inserted[0]
    # The route needs the id the database just assigned, so it is written back
    # rather than guessed. §10: the app only accepts a controlled relative path.
    route = care.route_for(event["id"])
    await anyio.to_thread.run_sync(
        lambda: sb.table("notification_events")
        .update({"route": route, "updated_at": _iso(_now())})
        .eq("id", event["id"]).execute()
    )
    event["route"] = route
    return event


def _event_row(uid: str, kind: str, title: str, body: str, day: str,
               scheduled_at: datetime, full_content: str, data: dict) -> dict:
    return {
        "user_id": uid,
        "type": "follow_up",
        "title": title,
        "body": body,
        "route": "/notifications/pending",
        "data": {"kind": kind, **data},
        "thread_id": CARE_THREAD_ID,
        # Distinct per kind: a shared collapse id would let the evening's care
        # line replace the morning's post on the lock screen.
        "collapse_id": f"{kind}-{day}"[:64],
        "dedupe_key": care.dedupe_key(uid, day, kind),
        "scheduled_at": _iso(scheduled_at),
        "full_content": full_content,
        "status": "queued",
    }


async def generate_care_event(
    sb: Any,
    uid: str,
    *,
    scheduled_at: Optional[datetime] = None,
    now: Optional[datetime] = None,
) -> Optional[dict]:
    """Compose one caring line for an account and queue it for the evening.

    Written from what the parent last talked to NURI about — lately if there
    is anything, else their last conversation. The same words become NURI's
    message in the conversation when the notification is tapped. Returns
    ``None`` for an account that has never talked to NURI, or one already
    queued today.
    """
    from backend.nuri_core import dialogue_reply as core_dialogue_reply
    from backend.nuri_core import family_store as core_family_store

    now = now or _now()
    signals = await anyio.to_thread.run_sync(lambda: care.latest_signals(sb, uid, now=now))
    if signals.is_empty():
        return None

    nickname = ""
    try:
        profile, children = await core_family_store.load_profile(uid)
        nickname = (profile or {}).get("nickname", "") or ""
        profile_ctx = core_family_store.profile_ctx(profile, children)
    except Exception:
        profile_ctx = ""

    prompt = care.build_prompt(signals, nickname)
    title = body = ""
    try:
        style_ctx = await core_dialogue_reply.get_style_rules_ctx()
        reply = await anyio.to_thread.run_sync(
            lambda: core_dialogue_reply.nuri_reply_sync(
                [{"role": "user", "text": prompt}], "", "", profile_ctx, style_ctx,
            )
        )
        title, body = care.parse_completion(reply.get("text", ""))
    except Exception as exc:  # noqa: BLE001 - a failed line must not fail the run
        log.warning("care composition failed: %s", type(exc).__name__)

    if not title or not body:
        title, body = care.fallback_message()

    if scheduled_at is None:
        prefs = await anyio.to_thread.run_sync(lambda: _preferences(sb, uid))
        scheduled_at = next_local_hour(prefs, CARE_LOCAL_HOUR, now)
    day = now.astimezone(timezone.utc).date().isoformat()
    return await _queue(sb, _event_row(
        uid, care.KIND_CARE, title, body, day, scheduled_at,
        full_content=body, data={},
    ))


async def generate_post_event(
    sb: Any,
    uid: str,
    *,
    now: Optional[datetime] = None,
) -> Optional[dict]:
    """Queue the parent's featured post as its own notification, to go now.

    Returns ``None`` when no post could be made today, or one is already queued.
    """
    now = now or _now()
    post = await _featured_post(sb, uid)
    if not post:
        return None
    title, body = care.post_message(post)
    day = now.astimezone(timezone.utc).date().isoformat()
    return await _queue(sb, _event_row(
        uid, care.KIND_DAILY_POST, title, body, day, now,
        full_content=care.post_intro(post), data={"daily_post_id": post["id"]},
    ))


# ── Preferences ───────────────────────────────────────────────────────────────

def _preferences(sb: Any, uid: str) -> dict:
    try:
        rows = (
            sb.table("notification_preferences").select("*").eq("user_id", uid)
            .limit(1).execute().data or []
        )
    except Exception:
        rows = []
    if rows:
        return rows[0]
    # An account that has never opened the settings screen still gets the
    # documented defaults rather than being treated as opted out.
    return {
        "enabled": True, "reminders_enabled": True, "chat_enabled": True,
        "care_enabled": True, "quiet_hours_start": "21:00",
        "quiet_hours_end": "08:00", "time_zone": "UTC", "max_per_day": 4,
        "show_preview": False,
    }


def _type_enabled(prefs: dict, event_type: str) -> bool:
    if event_type == "system":
        return True  # §12: security notices are exempt.
    if not prefs.get("enabled", True):
        return False
    return {
        "reminder": prefs.get("reminders_enabled", True),
        "task": prefs.get("reminders_enabled", True),
        "chat": prefs.get("chat_enabled", True),
        "follow_up": prefs.get("care_enabled", True),
    }.get(event_type, True)


def _parse_time(value: Any) -> Optional[dt_time]:
    if isinstance(value, dt_time):
        return value
    if not value:
        return None
    try:
        parts = str(value).split(":")
        return dt_time(int(parts[0]), int(parts[1]) if len(parts) > 1 else 0)
    except (ValueError, IndexError):
        return None


def in_quiet_hours(prefs: dict, moment: datetime) -> bool:
    """Whether local time falls inside the parent's do-not-disturb window.

    §12 says quiet hours run in the user's own IANA zone, and the window
    normally wraps midnight (21:00–08:00), so the comparison has to handle a
    start later than its end.
    """
    start, end = _parse_time(prefs.get("quiet_hours_start")), _parse_time(prefs.get("quiet_hours_end"))
    if not start or not end or start == end:
        return False
    local = moment.astimezone(_zone(prefs)).time()
    if start < end:
        return start <= local < end
    return local >= start or local < end  # wraps past midnight


def _sent_today(sb: Any, uid: str, prefs: dict, moment: datetime) -> int:
    local_midnight = moment.astimezone(_zone(prefs)).replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        return (
            sb.table("notification_events")
            .select("id", count="exact", head=True)
            .eq("user_id", uid).in_("status", ["sent", "partial"])
            .gte("updated_at", _iso(local_midnight)).execute().count or 0
        )
    except Exception:
        return 0


# ── Dispatch ──────────────────────────────────────────────────────────────────

async def _finish(sb: Any, event_id: str, status: str, error: str = "") -> None:
    # A delivered event keeps no error: the "push_not_configured" from the
    # attempts before credentials existed would otherwise read as a failure.
    patch: dict[str, Any] = {"status": status, "updated_at": _iso(_now()),
                             "last_error": error[:300] or None}
    await anyio.to_thread.run_sync(
        lambda: sb.table("notification_events").update(patch).eq("id", event_id).execute()
    )


async def _requeue(sb: Any, event_id: str, delay_minutes: int, error: str = "") -> None:
    patch: dict[str, Any] = {
        "status": "queued",
        "scheduled_at": _iso(_now() + timedelta(minutes=delay_minutes)),
        "updated_at": _iso(_now()),
    }
    if error:
        patch["last_error"] = error[:300]
    await anyio.to_thread.run_sync(
        lambda: sb.table("notification_events").update(patch).eq("id", event_id).execute()
    )


async def dispatch_due_notifications(
    sb: Any, *, batch_size: int = DEFAULT_BATCH_SIZE, now: Optional[datetime] = None,
) -> dict[str, int]:
    """Claim due events and try to deliver each to the account's devices."""
    now = now or _now()
    counters = {"claimed": 0, "sent": 0, "partial": 0, "failed": 0,
                "skipped_prefs": 0, "deferred_quiet": 0, "capped": 0,
                "no_devices": 0, "deactivated": 0}

    def _claim() -> list[dict]:
        return (
            sb.rpc("claim_due_notifications", {"batch_size": batch_size})
            .execute().data or []
        )

    events = await anyio.to_thread.run_sync(_claim)
    counters["claimed"] = len(events)
    if not events:
        return counters

    ready = {platform for platform, sender in _SENDERS.items() if sender.configured()}
    if not ready:
        # Put them straight back rather than burning attempts against a
        # deployment that has no push credentials yet.
        for event in events:
            await _requeue(sb, event["id"], 30, "push_not_configured")
        counters["failed"] = 0
        return counters

    for event in events:
        uid, event_id = event["user_id"], event["id"]
        prefs = await anyio.to_thread.run_sync(lambda: _preferences(sb, uid))

        if not _type_enabled(prefs, event["type"]):
            await _finish(sb, event_id, "cancelled", "type_disabled")
            counters["skipped_prefs"] += 1
            continue

        if event["type"] != "system" and in_quiet_hours(prefs, now):
            # Held, not dropped: §12 defers rather than discards.
            await _requeue(sb, event_id, 30)
            counters["deferred_quiet"] += 1
            continue

        cap = int(prefs.get("max_per_day", 4) or 0)
        if event["type"] != "system" and cap > 0:
            if await anyio.to_thread.run_sync(lambda: _sent_today(sb, uid, prefs, now)) >= cap:
                await _finish(sb, event_id, "cancelled", "daily_cap")
                counters["capped"] += 1
                continue

        def _devices() -> list[dict]:
            return (
                sb.table("push_devices")
                .select("id,platform,apns_token,apns_environment,permission_status")
                .eq("user_id", uid).eq("is_active", True).execute().data or []
            )

        reachable = [
            d for d in await anyio.to_thread.run_sync(_devices)
            if d.get("permission_status") in {"authorized", "provisional"}
        ]
        if not reachable:
            await _finish(sb, event_id, "cancelled", "no_active_device")
            counters["no_devices"] += 1
            continue
        devices = [d for d in reachable if (d.get("platform") or "ios") in ready]
        if not devices:
            # Only phones on a platform whose credentials are not set yet:
            # hold the event instead of failing it.
            await _requeue(sb, event_id, 30, "push_not_configured")
            continue

        accepted = retryable = 0
        for device in devices:
            try:
                sender = _SENDERS[device.get("platform") or "ios"]
                result = await sender.send_alert(
                    device_token=device["apns_token"],
                    environment=device["apns_environment"],
                    title=event["title"], body=event["body"],
                    notification_id=event_id, notification_type=event["type"],
                    route=event["route"], data=event.get("data") or {},
                    thread_id=event.get("thread_id") or "nuri-reminders",
                    collapse_id=event.get("collapse_id"),
                )
            except Exception as exc:  # noqa: BLE001 - one device must not stop the rest
                retryable += 1
                log.warning("push transport error: %s", type(exc).__name__)
                continue

            def _record() -> None:
                sb.table("notification_deliveries").upsert({
                    "event_id": event_id, "device_id": device["id"],
                    "apns_id": (result.apns_id or None) if result.accepted else None,
                    "status": "accepted" if result.accepted else "rejected",
                    "http_status": result.http_status,
                    "error_reason": result.reason,
                    "latency_ms": result.latency_ms,
                    "attempt": int(event.get("attempt_count") or 1),
                    "sent_at": _iso(_now()) if result.accepted else None,
                }, on_conflict="event_id,device_id").execute()
            await anyio.to_thread.run_sync(_record)

            _log_safe("push_result", event_id=event_id, device_id=device["id"],
                      apns_id=result.apns_id, environment=device["apns_environment"],
                      http_status=result.http_status, reason=result.reason,
                      latency_ms=result.latency_ms)

            if result.accepted:
                accepted += 1
            elif result.deactivate_token:
                await anyio.to_thread.run_sync(
                    lambda: sb.table("push_devices").update({
                        "is_active": False, "invalidated_at": _iso(_now()),
                        "updated_at": _iso(_now()),
                    }).eq("id", device["id"]).execute()
                )
                counters["deactivated"] += 1
            elif result.retryable:
                retryable += 1

        if accepted and accepted == len(devices):
            await _finish(sb, event_id, "sent")
            counters["sent"] += 1
        elif accepted:
            await _finish(sb, event_id, "partial")
            counters["partial"] += 1
        elif retryable and int(event.get("attempt_count") or 1) < 5:
            await _requeue(sb, event_id, 10, "retryable_apns_error")
        else:
            await _finish(sb, event_id, "failed", "all_devices_rejected")
            counters["failed"] += 1

    return counters
