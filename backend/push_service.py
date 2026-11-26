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
import os
from datetime import date, datetime, time as dt_time, timedelta, timezone
from typing import Any, Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anyio

from backend import llm_usage, locales, push_apns, push_fcm, stores
from backend.feed import local_activity_service as activities
from backend.nuri_core import care_notifications as care

log = logging.getLogger("nuri.push")

CARE_THREAD_ID = "nuri-care"

#: One sender per platform. Both take the same keywords and return the same
#: result type, so the dispatch loop below never branches on platform.
_SENDERS = {"ios": push_apns, "android": push_fcm}

#: How many events one dispatch run will claim. Vercel's cron fires every five
#: minutes, so this only has to keep up with a backlog, not drain one instantly.
DEFAULT_BATCH_SIZE = 100
ALPHA_IOS_TOPIC = "com.ordashtech.nuri.beta"
_COMMUNITY_PUSH_KINDS = frozenset({
    "community_question", "community_reply", "community_invitation",
    "community_conversation", "community_ai_consent",
})
_CLAIM_RPC = {
    "default": "claim_due_notifications",
    "local_activity": "claim_due_local_activity_notifications",
    "alpha_community": "claim_due_alpha_community_notifications",
}

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
#: Local hour the daily video goes out: between the morning's featured post
#: and the evening's care line, so the three arrive one at a time.
VIDEO_LOCAL_HOUR = 14


def video_send_time(prefs: dict, now: datetime) -> datetime:
    """14:00 the parent's time; if that has passed but the care line has not
    gone yet, now; otherwise 14:00 tomorrow."""
    local = now.astimezone(_zone(prefs))
    target = local.replace(hour=VIDEO_LOCAL_HOUR, minute=0, second=0, microsecond=0)
    if target > local:
        return target.astimezone(timezone.utc)
    if local.hour < CARE_LOCAL_HOUR:
        return now
    return (target + timedelta(days=1)).astimezone(timezone.utc)


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


#: A plain completion, not the chat pipeline: the NURI persona and its style
#: rules are shaped for a full reply (bullets, several questions) and pulled the
#: two-line notification towards a generic greeting.
CARE_MODEL = os.getenv("CARE_NOTIFICATION_MODEL", "gpt-5.5")


def compose_care_text(prompt: str) -> str:
    """Ask OpenAI for the follow-up's two lines (title, body)."""
    from backend import runtime

    if runtime.oai is None:
        return ""
    resp = runtime.oai.chat.completions.create(
        model=CARE_MODEL,
        messages=[{"role": "user", "content": prompt}],
    )
    return (resp.choices[0].message.content or "").strip()


async def generate_care_event(
    sb: Any,
    uid: str,
    *,
    scheduled_at: Optional[datetime] = None,
    now: Optional[datetime] = None,
    slot: Optional[str] = None,
) -> Optional[dict]:
    """Compose one caring line for an account and queue it for the evening.

    With ``slot`` (a test account's half-hour run, see ``tester_slot``) it goes
    out now instead, deduplicated per slot rather than per day.

    Written from what the parent last talked to NURI about — lately if there
    is anything, else their last conversation. The same words become NURI's
    message in the conversation when the notification is tapped. Returns
    ``None`` for an account that has never talked to NURI, or one already
    queued today.
    """
    from backend.nuri_core import family_store as core_family_store

    now = now or _now()
    signals = await anyio.to_thread.run_sync(lambda: care.latest_signals(sb, uid, now=now))
    if signals.is_empty():
        return None

    nickname = ""
    child_names: list[str] = []
    try:
        profile, children = await core_family_store.load_profile(uid)
        nickname = (profile or {}).get("nickname", "") or ""
        child_names = [c.get("nickname") or "" for c in children or []]
    except Exception:
        pass

    prompt = care.build_prompt(signals, nickname)
    title = body = ""
    try:
        text = await anyio.to_thread.run_sync(lambda: compose_care_text(prompt))
        title, body = care.parse_completion(care.scrub_names(text, child_names))
    except Exception as exc:  # noqa: BLE001 - a failed line must not fail the run
        log.warning("care composition failed: %s", type(exc).__name__)

    if not title or not body:
        title, body = care.fallback_message()

    if scheduled_at is None and slot:
        scheduled_at = now
    if scheduled_at is None:
        prefs = await anyio.to_thread.run_sync(lambda: _preferences(sb, uid))
        scheduled_at = next_local_hour(prefs, CARE_LOCAL_HOUR, now)
    day = slot or now.astimezone(timezone.utc).date().isoformat()
    return await _queue(sb, _event_row(
        uid, care.KIND_CARE, title, body, day, scheduled_at,
        full_content=body, data=_tester_data(slot),
    ))


async def generate_post_event(
    sb: Any,
    uid: str,
    *,
    now: Optional[datetime] = None,
    slot: Optional[str] = None,
) -> Optional[dict]:
    """Queue the parent's featured post as its own notification, to go now.

    Returns ``None`` when no post could be made today, or one is already queued.
    """
    now = now or _now()
    post = await _featured_post(sb, uid)
    if not post:
        return None
    title, body = care.post_message(post)
    day = slot or now.astimezone(timezone.utc).date().isoformat()
    return await _queue(sb, _event_row(
        uid, care.KIND_DAILY_POST, title, body, day, now,
        full_content=care.post_intro(post),
        data={"daily_post_id": post["id"], **_tester_data(slot)},
    ))


async def _daily_video(sb: Any, uid: str) -> Optional[dict]:
    """The parent's video for their local day — the one Home shows."""
    from backend.feed import daily_video as feed_daily_video

    zone = (await anyio.to_thread.run_sync(lambda: _preferences(sb, uid))).get("time_zone")
    try:
        result = await feed_daily_video.get_daily_video(uid, zone)
    except Exception as exc:  # noqa: BLE001 - the notification can go without it
        log.warning("daily video failed: %s", type(exc).__name__)
        return None
    card = result.get("card") if result.get("state") == "ready" else None
    return card if card and card.get("id") and card.get("video_id") else None


async def generate_video_event(
    sb: Any,
    uid: str,
    *,
    now: Optional[datetime] = None,
    slot: Optional[str] = None,
) -> Optional[dict]:
    """Queue the parent's daily video (the knowledge card) for the afternoon.

    Returns ``None`` when no video could be found today, or one is already queued.
    """
    now = now or _now()
    video = await _daily_video(sb, uid)
    if not video:
        return None
    title, body = care.video_message(video)
    if slot:
        scheduled_at = now
    else:
        prefs = await anyio.to_thread.run_sync(lambda: _preferences(sb, uid))
        scheduled_at = video_send_time(prefs, now)
    day = slot or now.astimezone(timezone.utc).date().isoformat()
    return await _queue(sb, _event_row(
        uid, care.KIND_DAILY_VIDEO, title, body, day, scheduled_at,
        full_content=video.get("intro") or "",
        data={"daily_video_id": video["id"], **_tester_data(slot)},
    ))


_LOCAL_ACTIVITY_DAYS = {1, 4}  # Tuesday and Friday in the parent's time zone.
_LOCAL_ACTIVITY_COPY = {
    "en": ("Explore something nearby", "See a new family activity or local resource in Nuri."),
    "zh-CN": ("看看附近有什么", "打开 Nuri 查看新的亲子活动或本地资源。"),
    "zh-TW": ("看看附近有什麼", "打開 Nuri 查看新的親子活動或在地資源。"),
}


async def generate_local_activity_event(
    sb: Any, uid: str, *, now: Optional[datetime] = None,
) -> Optional[dict]:
    """Occasionally queue one ready, opt-in activity for a compatible iOS build."""
    builds = activities.supported_builds()
    if not activities.enabled() or not builds:
        return None
    now = now or _now()
    prefs = await anyio.to_thread.run_sync(lambda: _preferences(sb, uid, fail_closed=True))
    local = now.astimezone(_zone(prefs))
    scheduled = local.replace(hour=16, minute=30, second=0, microsecond=0)
    # The shared preparation job runs in UTC, often after evening quiet hours
    # in Asia. Prepare the next local slot instead of queueing a near-midnight alert.
    if scheduled < local:
        scheduled += timedelta(days=1)
    if scheduled.weekday() not in _LOCAL_ACTIVITY_DAYS or not prefs.get("enabled", True):
        return None
    area = await activities.load_area(sb, uid)
    if not area.get("enabled"):
        return None

    def delivery_context():
        devices = sb.table("push_devices").select("platform,bundle_id,build_number").eq(
            "user_id", uid,
        ).eq("is_active", True).in_("permission_status", ["authorized", "provisional"]).execute().data or []
        if not any(activities.supports_push(device, builds) for device in devices):
            return None
        cutoff = (now - timedelta(days=30)).isoformat()
        rows = sb.table("notification_events").select("data").eq(
            "user_id", uid,
        ).eq("data->>kind", activities.KIND).in_(
            "status", ["queued", "processing", "sent", "partial"],
        ).gte("scheduled_at", cutoff).limit(32).execute().data or []
        return {(row.get("data") or {}).get("local_activity_id") for row in rows}

    seen = await anyio.to_thread.run_sync(delivery_context)
    if seen is None:
        return None
    privacy = await stores.get_privacy(uid, fail_closed=True)
    locale = locales.normalize_preferred_locale(privacy.get("language"))
    day = scheduled.date()
    result = await activities.recommendations(sb, uid, locale=locale, now=now, day=day, area=area)
    # Same-day events may already be over when the notification arrives; the
    # in-app list can still show them with a link to the organizer.
    eligible = [
        item for item in result["items"]
        if item["id"] not in seen
        and (item["kind"] == "ongoing_resource" or (item.get("start_date") or "") > day.isoformat())
    ]
    if not eligible:
        return None
    item = eligible[0]
    revision = str(area["revision"])
    if not await activities.find_activity(sb, uid, item["id"], now=now, day=day, revision=revision):
        return None
    expiry = (scheduled + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    title, body = _LOCAL_ACTIVITY_COPY[locale]
    event = _event_row(uid, activities.KIND, title, body, day.isoformat(), scheduled, body, {
        "local_activity_id": item["id"],
        "local_activity_revision": revision,
    })
    event["expires_at"] = _iso(expiry)
    return await _queue(sb, event)


def fair_order(uids: list[str], now: datetime, *, shift: int = 0) -> list[str]:
    """`uids` starting one place further along each day."""
    ordered = sorted(uids)
    if not ordered:
        return []
    start = (now.astimezone(timezone.utc).date().toordinal() + shift) % len(ordered)
    return ordered[start:] + ordered[:start]


# ── Test accounts ─────────────────────────────────────────────────────────────
# Accounts listed in PUSH_TEST_EMAILS can get both notifications every half
# hour (the /internal/push/test-accounts endpoint) so the team can watch the
# content without waiting a day. Its cron is off: to turn the burst back on,
# add `{"path": "/api/internal/push/test-accounts", "schedule": "*/30 * * * *"}`
# to vercel.json. Without it these accounts get the normal two a day. Quiet hours still apply; the daily cap does not, or the
# fifth run of the day would be cancelled.

DEFAULT_TEST_EMAILS = "daniel@ordashlab.com,123@123.com,contact@ordashteches.com"


def tester_emails() -> list[str]:
    raw = os.getenv("PUSH_TEST_EMAILS", DEFAULT_TEST_EMAILS)
    return [e.strip().lower() for e in raw.split(",") if e.strip()]


def tester_slot(now: datetime) -> str:
    """The half hour ``now`` falls in, e.g. ``2026-09-26T14:30``."""
    moment = now.astimezone(timezone.utc)
    return moment.replace(minute=30 if moment.minute >= 30 else 0).strftime("%Y-%m-%dT%H:%M")


def _tester_data(slot: Optional[str]) -> dict:
    return {"test_burst": True} if slot else {}


# ── Preferences ───────────────────────────────────────────────────────────────

def _preferences(sb: Any, uid: str, *, fail_closed: bool = False) -> dict:
    try:
        rows = (
            sb.table("notification_preferences").select("*").eq("user_id", uid)
            .limit(1).execute().data or []
        )
    except Exception:
        if fail_closed:
            raise
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
    scope: Literal["default", "local_activity", "alpha_community"] = "default",
) -> dict[str, int]:
    """Claim due events and try to deliver each to the account's devices."""
    now = now or _now()
    counters = {"claimed": 0, "sent": 0, "partial": 0, "failed": 0,
                "skipped_prefs": 0, "deferred_quiet": 0, "capped": 0,
                "no_devices": 0, "deactivated": 0}

    def _claim() -> list[dict]:
        return (
            sb.rpc(_CLAIM_RPC[scope], {"batch_size": batch_size})
            .execute().data or []
        )

    events = await anyio.to_thread.run_sync(_claim)
    alpha_community = scope == "alpha_community"
    if scope == "local_activity":
        events = [event for event in events if (event.get("data") or {}).get("kind") == activities.KIND]
    elif alpha_community:
        counters.update(skipped_inaccessible=0, deferred_target=0)
        events = [
            event for event in events if event.get("type") == "chat"
            and (event.get("data") or {}).get("kind") in _COMMUNITY_PUSH_KINDS
        ]
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
        data = event.get("data") or {}
        is_local_activity = data.get("kind") == activities.KIND
        try:
            prefs = await anyio.to_thread.run_sync(
                lambda: _preferences(sb, uid, fail_closed=True)
                if is_local_activity or alpha_community else _preferences(sb, uid),
            )
            parent_messages = True
            if alpha_community:
                rows = await anyio.to_thread.run_sync(
                    lambda: sb.table("community_preferences")
                    .select("parent_message_notifications_enabled").eq("user_id", uid).limit(1).execute().data or []
                )
                parent_messages = not rows or rows[0].get("parent_message_notifications_enabled", True)
        except Exception:
            await _requeue(sb, event_id, 15, "notification_preferences_unavailable")
            continue

        allowed = prefs.get("enabled", True) if is_local_activity else _type_enabled(prefs, event["type"])
        if not allowed or not parent_messages:
            await _finish(sb, event_id, "cancelled", "type_disabled")
            counters["skipped_prefs"] += 1
            continue

        if event["type"] != "system" and in_quiet_hours(prefs, now):
            # Held, not dropped: §12 defers rather than discards.
            await _requeue(sb, event_id, 30)
            counters["deferred_quiet"] += 1
            continue

        cap = int(prefs.get("max_per_day", 4) or 0)
        if not alpha_community and data.get("test_burst"):
            cap = 0  # Test accounts run every half hour, uncapped.
        if event["type"] != "system" and cap > 0:
            if await anyio.to_thread.run_sync(lambda: _sent_today(sb, uid, prefs, now)) >= cap:
                await _finish(sb, event_id, "cancelled", "daily_cap")
                counters["capped"] += 1
                continue

        if alpha_community:
            # Community owns current target and recipient visibility. A queued
            # event cannot rely on the permissions it had when it was created.
            from backend import community

            try:
                resolved = await community.notification_target(uid, event_id)
            except community.CommunityError as exc:
                if exc.retryable:
                    await _requeue(sb, event_id, 15, "community_target_unavailable")
                    counters["deferred_target"] += 1
                    continue
                resolved = {}
            if not resolved.get("accessible"):
                await _finish(sb, event_id, "cancelled", "community_target_no_longer_accessible")
                counters["skipped_inaccessible"] += 1
                continue

        def _devices() -> list[dict]:
            query = (
                sb.table("push_devices")
                .select("id,platform,apns_token,apns_environment,permission_status,bundle_id,build_number")
                .eq("user_id", uid).eq("is_active", True)
            )
            if alpha_community:
                query = query.eq("platform", "ios").eq("bundle_id", ALPHA_IOS_TOPIC).eq("apns_environment", "production")
            return query.execute().data or []

        reachable = [
            d for d in await anyio.to_thread.run_sync(_devices)
            if d.get("permission_status") in {"authorized", "provisional"}
        ]
        if alpha_community:
            reachable = [
                d for d in reachable if d.get("platform") == "ios" and d.get("bundle_id") == ALPHA_IOS_TOPIC
                and d.get("apns_environment") == "production"
            ]
            data = {"kind": data["kind"]}
        if is_local_activity:
            builds = activities.supported_builds()
            reachable = [d for d in reachable if activities.supports_push(d, builds)]
            local_day = now.astimezone(_zone(prefs)).date()
            revision = data.get("local_activity_revision")
            activity_id = data.get("local_activity_id")
            try:
                current = bool(reachable and revision and activity_id) and await activities.find_activity(
                    sb, uid, activity_id, now=now, day=local_day, revision=revision,
                )
            except Exception:
                await _requeue(sb, event_id, 15, "local_activity_storage_unavailable")
                continue
            if not current:
                await _finish(sb, event_id, "cancelled", "local_activity_no_longer_eligible")
                counters["skipped_prefs"] += 1
                continue
            # Keep the account's coarse area and the consent revision off-device.
            data = {"kind": activities.KIND}
        if not reachable:
            if alpha_community:
                # The Alpha registration may have changed since the claim.
                await _requeue(sb, event_id, 10, "no_active_alpha_device")
                counters["no_devices"] += 1
                continue
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
                platform = device.get("platform") or "ios"
                sender = _SENDERS[platform]
                # Always pass the actual stored iOS topic. An absent/invalid
                # value is a local rejection, never a primary-topic fallback.
                topic = {"topic": device.get("bundle_id")} if platform == "ios" else {}
                result = await sender.send_alert(
                    device_token=device["apns_token"],
                    environment=device["apns_environment"],
                    title=event["title"], body=event["body"],
                    notification_id=event_id, notification_type=event["type"],
                    # A claimed row may precede the queue's route write-back.
                    route=care.route_for(event_id), data=data,
                    thread_id=event.get("thread_id") or "nuri-reminders",
                    collapse_id=event.get("collapse_id"),
                    **topic,
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
