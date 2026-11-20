"""Daily ceilings on the Tavily requests the daily cards may spend.

Two counts per kind of card, per UTC day:

* **Each account** gets ACCOUNT_LIMIT requests (default 10). This is the
  ceiling meant from the start: one account whose plans keep finding nothing
  can't eat everyone else's searches. A normal card costs 2–6.
* **The whole site** gets LIMIT requests (default 15), a backstop so the
  monthly Tavily plan (1000 on the free tier) can't run dry the way it did in
  October. With the shared search pool (search_pool.py) the cards need about
  6–7 a day per kind, so this is not expected to bind. Until 2026-11-09 this
  site-wide count, at 10, was the only one, and it left about half the
  accounts without a card each day.

Chat search is not counted here.

Each count is one row in `app_settings` ("<day>:<n>"), shared by every
serverless instance and taken with a conditional update, so two instances
that read the same count can't both spend the last request.

Which account is spending comes from :func:`for_account`, entered around a
card's generation. Without one, only the site-wide count applies.

DAILY_POST_SEARCH_LIMIT / DAILY_VIDEO_SEARCH_LIMIT (site-wide) and
DAILY_POST_ACCOUNT_SEARCH_LIMIT / DAILY_VIDEO_ACCOUNT_SEARCH_LIMIT (per
account) change the numbers without a release.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Iterator, Optional

import anyio

from backend import runtime

DEFAULT_LIMIT = 15
DEFAULT_ACCOUNT_LIMIT = 10
#: Attempts to take a request when other instances keep moving the count.
_TAKE_ATTEMPTS = 8
_LIMIT_ENVS = {"post": "DAILY_POST_SEARCH_LIMIT", "video": "DAILY_VIDEO_SEARCH_LIMIT"}
_ACCOUNT_LIMIT_ENVS = {
    "post": "DAILY_POST_ACCOUNT_SEARCH_LIMIT", "video": "DAILY_VIDEO_ACCOUNT_SEARCH_LIMIT",
}

_account: ContextVar[Optional[str]] = ContextVar("search_budget_account", default=None)


class SearchBudgetSpent(Exception):
    """Today's requests for this kind of card are used up."""


def _env_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.getenv(name, "")))
    except ValueError:
        return default


def limit(kind: str) -> int:
    """Site-wide requests per UTC day for this kind."""
    return _env_int(_LIMIT_ENVS[kind], DEFAULT_LIMIT)


def account_limit(kind: str) -> int:
    """Requests per account per UTC day for this kind."""
    return _env_int(_ACCOUNT_LIMIT_ENVS[kind], DEFAULT_ACCOUNT_LIMIT)


def _key(kind: str, account: Optional[str] = None) -> str:
    return f"daily_search_budget_{kind}" + (f":{account}" if account else "")


def account_key(kind: str, account: str) -> str:
    """The app_settings key of one account's count (account deletion removes it)."""
    return _key(kind, account)


@contextmanager
def for_account(user_id: Optional[str]) -> Iterator[None]:
    """Count the searches made inside this block against `user_id` as well."""
    token = _account.set(user_id or None)
    try:
        yield
    finally:
        _account.reset(token)


def _today(now: Optional[datetime]) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date().isoformat()


def _used(raw: Optional[str], day: str) -> int:
    """Stored as "2026-11-01:3"; another day's count is no count at all."""
    stored_day, _, count = (raw or "").partition(":")
    return int(count) if stored_day == day and count.isdigit() else 0


def _read(sb, kind: str, account: Optional[str] = None) -> Optional[str]:
    rows = sb.table("app_settings").select("value").eq("key", _key(kind, account)) \
        .limit(1).execute().data or []
    return rows[0].get("value") if rows else None


def _take(sb, kind: str, now: Optional[datetime], account: Optional[str] = None) -> bool:
    day = _today(now)
    ceiling = account_limit(kind) if account else limit(kind)
    key = _key(kind, account)
    stamp = (now or datetime.now(timezone.utc)).isoformat()
    for _ in range(_TAKE_ATTEMPTS):
        raw = _read(sb, kind, account)
        used = _used(raw, day)
        if used >= ceiling:
            return False
        value = f"{day}:{used + 1}"
        if raw is None:
            # Ignored when another instance inserts first; the read after it
            # then sees their count.
            rows = sb.table("app_settings").upsert(
                {"key": key, "value": value, "updated_at": stamp},
                on_conflict="key", ignore_duplicates=True,
            ).execute().data
        else:
            rows = sb.table("app_settings").update({"value": value, "updated_at": stamp}) \
                .eq("key", key).eq("value", raw).execute().data
        if rows:
            return True
    return False


def _site_spent(kind: str) -> SearchBudgetSpent:
    return SearchBudgetSpent(f"daily {kind} search limit of {limit(kind)} reached")


def _account_spent(kind: str) -> SearchBudgetSpent:
    return SearchBudgetSpent(
        f"daily {kind} search limit of {account_limit(kind)} for this account reached"
    )


async def spend(kind: str, *, now: Optional[datetime] = None) -> None:
    """Take one request, or raise SearchBudgetSpent.

    The account's count is taken first, then the site's. When the site is out
    after the account's was taken, that one stays spent: it only happens on a
    day the backstop is hit, when the account gets no search anyway.

    A counter that can't be reached lets the search through: the database being
    down costs a few requests at most, since the card couldn't be saved either,
    while refusing would look like an empty day for everyone.
    """
    sb = runtime.get_supabase()
    if not sb:
        return
    account = _account.get()
    try:
        if account and not await anyio.to_thread.run_sync(lambda: _take(sb, kind, now, account)):
            raise _account_spent(kind)
        taken = await anyio.to_thread.run_sync(lambda: _take(sb, kind, now))
    except SearchBudgetSpent:
        raise
    except Exception as exc:  # noqa: BLE001 - see the docstring
        print(f"[error] daily search budget unavailable: {type(exc).__name__}: {exc}")
        return
    if not taken:
        raise _site_spent(kind)


async def require_some_left(kind: str, *, now: Optional[datetime] = None) -> None:
    """Raise SearchBudgetSpent if nothing is left, before any model call is
    spent on search words that could not be searched for."""
    sb = runtime.get_supabase()
    if not sb:
        return
    account = _account.get()
    day = _today(now)
    try:
        site = await anyio.to_thread.run_sync(lambda: _read(sb, kind))
        mine = await anyio.to_thread.run_sync(lambda: _read(sb, kind, account)) if account else None
    except Exception as exc:  # noqa: BLE001 - see spend()
        print(f"[error] daily search budget unavailable: {type(exc).__name__}: {exc}")
        return
    if account and _used(mine, day) >= account_limit(kind):
        raise _account_spent(kind)
    if _used(site, day) >= limit(kind):
        raise _site_spent(kind)
