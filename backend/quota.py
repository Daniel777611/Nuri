"""How much a parent may talk to NURI today, and how much they already have.

The allowance is tokens, not messages: a turn that pastes a clinic report
costs five ordinary ones, and counting messages would price both the same.
It is sized in turns, though, because that is what a parent understands —
`basic` is "about ten conversations a day". Measured on production
llm_call_logs (2026-09-20 → 10-08, 161 turns), one chat turn — router, reply
and memory extraction together — took 10.3k tokens at the median and 12.9k
at p90, so ten turns at p90 is 130k.

What counts is everything billed under a `chat.*` call site to this account:
the reply, the router, memory extraction, voice transcription, titles. Work
the product does on its own — the daily post and video, the home check-in —
is not the parent's spending and is left out.

The day is the parent's own calendar day, in the timezone their client sends
with each turn, so the allowance resets at their midnight rather than at UTC's.

Nothing is blocked unless QUOTA_ENFORCED is set. Until then the numbers are
still reported, so the billing page can show them during testing.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from backend import billing

log = logging.getLogger("nuri.quota")

#: Tokens per day for each tier; None is no limit. Overridable per deployment
#: so the allowance can be tuned without a release.
DEFAULT_DAILY_TOKENS = {
    "basic": 130_000,      # ≈10 turns at p90
    "plus": 650_000,       # ≈50 turns: five times basic
    "unlimited": None,
}

CHAT_CALL_SITE_PATTERN = "chat.%"


def enforced() -> bool:
    return os.getenv("QUOTA_ENFORCED", "").strip().lower() in {"1", "true", "yes", "on"}


def daily_limit(tier: str) -> Optional[int]:
    if tier not in DEFAULT_DAILY_TOKENS:
        tier = "basic"
    default = DEFAULT_DAILY_TOKENS[tier]
    if default is None:
        return None
    raw = os.getenv(f"QUOTA_{tier.upper()}_DAILY_TOKENS", "").strip()
    try:
        return max(0, int(raw)) if raw else default
    except ValueError:
        log.error("QUOTA_%s_DAILY_TOKENS is not a number: %r", tier.upper(), raw)
        return default


def _zone(tz: Optional[str]):
    try:
        return ZoneInfo(tz) if tz else timezone.utc
    except Exception:  # noqa: BLE001 - an unknown zone name falls back to UTC
        return timezone.utc


def day_window(tz: Optional[str], now: Optional[datetime] = None) -> tuple[datetime, datetime]:
    """[start, end) of the parent's current day, as UTC instants."""
    zone = _zone(tz)
    local = (now or datetime.now(timezone.utc)).astimezone(zone)
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    # Adding a day to the local midnight, then normalizing, keeps a DST day
    # 23 or 25 hours long instead of drifting the reset by an hour.
    end = (start.replace(tzinfo=None) + timedelta(days=1)).replace(tzinfo=zone)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def used_tokens(sb, uid: str, since: datetime) -> int:
    rows = (
        sb.table("llm_call_logs")
        .select("total_tokens")
        .eq("user_id", uid)
        .like("call_site", CHAT_CALL_SITE_PATTERN)
        .gte("created_at", since.isoformat())
        .limit(10_000)
        .execute()
        .data
        or []
    )
    return sum(int(r.get("total_tokens") or 0) for r in rows)


def snapshot(sb, uid: str, tz: Optional[str] = None, *, tier: Optional[str] = None,
             now: Optional[datetime] = None) -> dict:
    tier = tier or billing.tier_for(sb, uid)
    limit = daily_limit(tier)
    start, end = day_window(tz, now)
    used = used_tokens(sb, uid, start)
    return {
        "tier": tier,
        "limit": limit,
        "used": used,
        "remaining": None if limit is None else max(0, limit - used),
        "exhausted": limit is not None and used >= limit,
        "resets_at": end.isoformat(),
        "enforced": enforced(),
    }


def blocks(sb, uid: str, tz: Optional[str] = None) -> Optional[dict]:
    """The snapshot when this account may not start another turn, else None.

    A turn's cost is only known afterwards, so the last turn of the day may
    run over the line; the next one is what gets refused. Fails open: a
    database hiccup must not lock every parent out of the conversation.
    """
    if not enforced():
        return None
    try:
        snap = snapshot(sb, uid, tz)
    except Exception as exc:  # noqa: BLE001
        log.warning("quota check failed open: %s", type(exc).__name__)
        return None
    return snap if snap["exhausted"] else None
