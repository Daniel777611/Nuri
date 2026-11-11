"""A daily ceiling on the Tavily requests the daily cards may spend.

Tavily's plan is counted per month and refuses everything once it is spent,
which took the daily cards down for days in October. This stops well short of
that: each kind of card gets so many requests per UTC day, and after that the
day's remaining accounts go without a card rather than spend next week's
searches. Chat search is not counted here.

The count is one row per kind in `app_settings`, shared by every serverless
instance. It is taken with a conditional update, so two instances that read the
same count can't both spend the last request.

DAILY_POST_SEARCH_LIMIT and DAILY_VIDEO_SEARCH_LIMIT change the numbers without
a release.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

import anyio

from backend import runtime

DEFAULT_LIMIT = 10
#: Attempts to take a request when other instances keep moving the count.
_TAKE_ATTEMPTS = 8
_LIMIT_ENVS = {"post": "DAILY_POST_SEARCH_LIMIT", "video": "DAILY_VIDEO_SEARCH_LIMIT"}


class SearchBudgetSpent(Exception):
    """Today's requests for this kind of card are used up."""


def limit(kind: str) -> int:
    try:
        return max(0, int(os.getenv(_LIMIT_ENVS[kind], "")))
    except ValueError:
        return DEFAULT_LIMIT


def _key(kind: str) -> str:
    return f"daily_search_budget_{kind}"


def _today(now: Optional[datetime]) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date().isoformat()


def _used(raw: Optional[str], day: str) -> int:
    """Stored as "2026-11-01:3"; another day's count is no count at all."""
    stored_day, _, count = (raw or "").partition(":")
    return int(count) if stored_day == day and count.isdigit() else 0


def _read(sb, kind: str) -> Optional[str]:
    rows = sb.table("app_settings").select("value").eq("key", _key(kind)).limit(1).execute().data or []
    return rows[0].get("value") if rows else None


def _take(sb, kind: str, now: Optional[datetime]) -> bool:
    day, ceiling = _today(now), limit(kind)
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    for _ in range(_TAKE_ATTEMPTS):
        raw = _read(sb, kind)
        used = _used(raw, day)
        if used >= ceiling:
            return False
        value = f"{day}:{used + 1}"
        if raw is None:
            # Ignored when another instance inserts first; the read after it
            # then sees their count.
            rows = sb.table("app_settings").upsert(
                {"key": _key(kind), "value": value, "updated_at": stamp},
                on_conflict="key", ignore_duplicates=True,
            ).execute().data
        else:
            rows = sb.table("app_settings").update({"value": value, "updated_at": stamp}) \
                .eq("key", _key(kind)).eq("value", raw).execute().data
        if rows:
            return True
    return False


async def spend(kind: str, *, now: Optional[datetime] = None) -> None:
    """Take one request, or raise SearchBudgetSpent.

    A counter that can't be reached lets the search through: the database being
    down costs a few requests at most, since the card couldn't be saved either,
    while refusing would look like an empty day for everyone.
    """
    sb = runtime.get_supabase()
    if not sb:
        return
    try:
        taken = await anyio.to_thread.run_sync(lambda: _take(sb, kind, now))
    except Exception as exc:  # noqa: BLE001 - see the docstring
        print(f"[error] daily search budget unavailable: {type(exc).__name__}: {exc}")
        return
    if not taken:
        raise SearchBudgetSpent(f"daily {kind} search limit of {limit(kind)} reached")


async def require_some_left(kind: str, *, now: Optional[datetime] = None) -> None:
    """Raise SearchBudgetSpent if nothing is left, before any model call is
    spent on search words that could not be searched for."""
    sb = runtime.get_supabase()
    if not sb:
        return
    try:
        raw = await anyio.to_thread.run_sync(lambda: _read(sb, kind))
    except Exception as exc:  # noqa: BLE001 - see spend()
        print(f"[error] daily search budget unavailable: {type(exc).__name__}: {exc}")
        return
    if _used(raw, _today(now)) >= limit(kind):
        raise SearchBudgetSpent(f"daily {kind} search limit of {limit(kind)} reached")
