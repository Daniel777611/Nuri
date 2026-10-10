"""How much a parent may talk to NURI today, and how much they already have.

Allowances are set in conversation turns, because that is what a parent and
an operator both understand — `basic` is "ten conversations a day" — and
spent in tokens, because a turn that pastes a clinic report costs five
ordinary ones. One turn is TOKENS_PER_TURN: production turns (2026-09-20 →
10-08, 161 of them; router, reply and memory extraction together) took 10.3k
tokens at the median and 12.9k at p90, so 13k covers nine turns in ten.

Two places set the numbers, both editable from the admin page without a
release (see the /admin/quota routes):

* the tier allowances and the turn size, one JSON row in app_settings under
  `quota_config`, read through a short cache;
* per-account overrides in `user_quota_overrides`, for sponsored and other
  hand-picked accounts. An override never lowers what a tier gives: the
  account gets whichever is more generous, so a sponsored parent who later
  subscribes is not held to the old number.

What counts is everything billed under a `chat.*` call site to this account:
the reply, the router, memory extraction, voice transcription, titles. Work
the product does on its own — the daily post and video, the home check-in —
is not the parent's spending and is left out.

The day is the parent's own calendar day, in the timezone their client sends,
so the allowance resets at their midnight rather than at UTC's.

Nothing is blocked unless QUOTA_ENFORCED is set. Until then the numbers are
still reported, so the billing page can show them during testing.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from backend import billing

log = logging.getLogger("nuri.quota")

#: Turns per day per tier; None is no limit. The defaults, until an operator
#: saves something else from the admin page.
DEFAULT_TURNS = {"basic": 10, "plus": 25, "unlimited": None}
DEFAULT_TOKENS_PER_TURN = 13_000

CONFIG_KEY = "quota_config"
OVERRIDE_TABLE = "user_quota_overrides"
CHAT_CALL_SITE_PATTERN = "chat.%"

_CONFIG_TTL_S = 60
_config_cache: dict[str, Any] = {"at": 0.0, "value": None}


def enforced() -> bool:
    return os.getenv("QUOTA_ENFORCED", "").strip().lower() in {"1", "true", "yes", "on"}


# ── Configuration ─────────────────────────────────────────────────────────────

def _positive_int(value: Any) -> Optional[int]:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def normalize_config(raw: Any) -> dict:
    """A complete, valid config from whatever was stored (or nothing)."""
    raw = raw if isinstance(raw, dict) else {}
    turns_raw = raw.get("turns") if isinstance(raw.get("turns"), dict) else {}
    turns = dict(DEFAULT_TURNS)
    for tier in ("basic", "plus"):
        if tier in turns_raw:
            value = turns_raw[tier]
            turns[tier] = None if value is None else (_positive_int(value) or turns[tier])
    return {
        "tokens_per_turn": _positive_int(raw.get("tokens_per_turn")) or DEFAULT_TOKENS_PER_TURN,
        "turns": turns,
    }


def load_config(sb, *, fresh: bool = False) -> dict:
    cached = _config_cache["value"]
    if not fresh and cached is not None and time.monotonic() - _config_cache["at"] < _CONFIG_TTL_S:
        return cached
    stored = None
    if sb is not None:
        try:
            rows = (
                sb.table("app_settings").select("value").eq("key", CONFIG_KEY)
                .limit(1).execute().data or []
            )
            if rows:
                stored = json.loads(rows[0]["value"])
        except Exception as exc:  # noqa: BLE001 - defaults beat an outage
            log.warning("quota config unavailable: %s", type(exc).__name__)
    config = normalize_config(stored)
    _config_cache.update(at=time.monotonic(), value=config)
    return config


def save_config(sb, raw: dict) -> dict:
    config = normalize_config(raw)
    sb.table("app_settings").upsert(
        {"key": CONFIG_KEY, "value": json.dumps(config)}, on_conflict="key",
    ).execute()
    _config_cache.update(at=time.monotonic(), value=config)
    return config


def tier_turns(config: dict, tier: str) -> Optional[int]:
    return config["turns"].get(tier if tier in DEFAULT_TURNS else "basic")


# ── Per-account overrides ─────────────────────────────────────────────────────

def _active(row: dict, now: datetime) -> bool:
    expires = row.get("expires_at")
    if not expires:
        return True
    try:
        return datetime.fromisoformat(str(expires).replace("Z", "+00:00")) > now
    except ValueError:
        return True


def override_for(sb, uid: str, now: Optional[datetime] = None) -> Optional[dict]:
    """The account's active override, or None. Fails open to None: a missing
    table (migration not run) must not stop anyone from talking."""
    try:
        rows = (
            sb.table(OVERRIDE_TABLE).select("*").eq("user_id", uid)
            .limit(1).execute().data or []
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("quota overrides unavailable: %s", type(exc).__name__)
        return None
    row = rows[0] if rows else None
    if row and _active(row, now or datetime.now(timezone.utc)):
        return row
    return None


def _more_generous(a: Optional[int], b: Optional[int]) -> Optional[int]:
    """None means unlimited, which beats any number."""
    if a is None or b is None:
        return None
    return max(a, b)


# ── Usage ─────────────────────────────────────────────────────────────────────

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
    now = now or datetime.now(timezone.utc)
    config = load_config(sb)
    per_turn = config["tokens_per_turn"]
    tier = tier or billing.tier_for(sb, uid)
    turns = tier_turns(config, tier)
    override = override_for(sb, uid, now)
    if override is not None:
        turns = _more_generous(turns, override.get("daily_turns"))
    limit = None if turns is None else turns * per_turn
    start, end = day_window(tz, now)
    used = used_tokens(sb, uid, start)
    return {
        "tier": tier,
        "limit": limit,
        "used": used,
        "remaining": None if limit is None else max(0, limit - used),
        "exhausted": limit is not None and used >= limit,
        "limit_turns": turns,
        "tokens_per_turn": per_turn,
        "override": override is not None,
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
