"""Create notification events, and deliver the ones that are due.

Two halves that the handoff insists stay apart (§9.1): business code only ever
*creates* an event, and a single dispatcher decides whether it may be sent. The
separation is what makes quiet hours, per-day caps and device fan-out one
decision in one place instead of a rule every caller has to remember.

Everything the parent sees is composed in
``backend.nuri_core.care_notifications``; this module is the part that touches
the database, the model and Apple.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time as dt_time, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anyio

from backend import llm_usage, push_apns
from backend.nuri_core import care_notifications as care

log = logging.getLogger("nuri.push")

CARE_THREAD_ID = "nuri-care"

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


# ── Creating a care event ─────────────────────────────────────────────────────

async def generate_care_event(
    sb: Any,
    uid: str,
    *,
    scheduled_at: Optional[datetime] = None,
    now: Optional[datetime] = None,
) -> Optional[dict]:
    """Compose one caring notification for an account and queue it.

    Returns the queued row, or ``None`` when there is nothing worth saying —
    an account with no recent history gets silence rather than a generic
    greeting it never asked for.
    """
    from backend.nuri_core import dialogue_reply as core_dialogue_reply
    from backend.nuri_core import family_store as core_family_store

    now = now or _now()
    signals = await anyio.to_thread.run_sync(lambda: care.gather_signals(sb, uid, now=now))
    if signals.is_empty():
        return None

    card = care.match_card(signals)

    nickname = ""
    try:
        profile, children = await core_family_store.load_profile(uid)
        nickname = (profile or {}).get("nickname", "") or ""
        profile_ctx = core_family_store.profile_ctx(profile, children)
    except Exception:
        profile_ctx = ""

    prompt = care.build_prompt(signals, card, nickname)
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
        title, body = care.fallback_message(card)

    message = care.CareMessage(
        title=title, body=body,
        full_content=care.compose_full_content(body, card),
        card=card, keywords=signals.keywords(),
    )

    day = (scheduled_at or now).astimezone(timezone.utc).date().isoformat()
    row = {
        "user_id": uid,
        "type": "follow_up",
        "title": message.title,
        "body": message.body,
        "route": "/notifications/pending",
        "data": message.payload_data(),
        "thread_id": CARE_THREAD_ID,
        "collapse_id": f"care-{day}"[:64],
        "dedupe_key": care.dedupe_key(uid, day, (card or {}).get("id", "")),
        "scheduled_at": _iso(scheduled_at or now),
        "full_content": message.full_content,
        "status": "queued",
    }

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
    try:
        zone = ZoneInfo(prefs.get("time_zone") or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    local = moment.astimezone(zone).time()
    if start < end:
        return start <= local < end
    return local >= start or local < end  # wraps past midnight


def _sent_today(sb: Any, uid: str, prefs: dict, moment: datetime) -> int:
    try:
        zone = ZoneInfo(prefs.get("time_zone") or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    local_midnight = moment.astimezone(zone).replace(hour=0, minute=0, second=0, microsecond=0)
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
    patch: dict[str, Any] = {"status": status, "updated_at": _iso(_now())}
    if error:
        patch["last_error"] = error[:300]
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

    if not push_apns.configured():
        # Put them straight back rather than burning attempts against a
        # deployment that has no APNs key yet.
        for event in events:
            await _requeue(sb, event["id"], 30, "apns_not_configured")
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
                .select("id,apns_token,apns_environment,permission_status")
                .eq("user_id", uid).eq("is_active", True).execute().data or []
            )

        devices = [
            d for d in await anyio.to_thread.run_sync(_devices)
            if d.get("permission_status") in {"authorized", "provisional"}
        ]
        if not devices:
            await _finish(sb, event_id, "cancelled", "no_active_device")
            counters["no_devices"] += 1
            continue

        accepted = retryable = 0
        for device in devices:
            try:
                result = await push_apns.send_alert(
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
                log.warning("apns transport error: %s", type(exc).__name__)
                continue

            def _record() -> None:
                sb.table("notification_deliveries").upsert({
                    "event_id": event_id, "device_id": device["id"],
                    "apns_id": result.apns_id if result.accepted else None,
                    "status": "accepted" if result.accepted else "rejected",
                    "http_status": result.http_status,
                    "error_reason": result.reason,
                    "latency_ms": result.latency_ms,
                    "attempt": int(event.get("attempt_count") or 1),
                    "sent_at": _iso(_now()) if result.accepted else None,
                }, on_conflict="event_id,device_id").execute()
            await anyio.to_thread.run_sync(_record)

            _log_safe("apns_result", event_id=event_id, device_id=device["id"],
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
