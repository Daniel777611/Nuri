"""Shared search results for the daily cards.

Every parent's daily post and daily video used to cost their own Tavily
searches, about 44 a day for ten accounts against a free plan of 1000 a month.
Most of those searches were the same words — the coarse profile plan is an age
band and one concern — and the same words bring back nearly the same posts the
next day. So a search's results are kept in `content_search_pool` for
TTL_DAYS and any parent whose plan produces the same words reads them from
there. Measured on October's rows: about 6–7 searches a day per kind instead of
about 14 recorded (and more with fallbacks).

Only the search is shared. Each parent's card is still picked from the results
by the model, against their own child, their standing memories and the posts
they have already been shown.

A stale row is still better than nothing: when the day's search budget is spent
or Tavily refuses, a pool entry of any age is used instead of failing the card.
"""

from __future__ import annotations

import os
import re
from contextvars import ContextVar
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

import anyio

from backend import runtime
from backend.feed import search_budget

TABLE = "content_search_pool"
DEFAULT_TTL_DAYS = 7


def ttl_days() -> float:
    """CONTENT_POOL_TTL_DAYS; 0 turns sharing off (every card searches again)."""
    try:
        return max(0.0, float(os.getenv("CONTENT_POOL_TTL_DAYS", "")))
    except ValueError:
        return float(DEFAULT_TTL_DAYS)


def query_key(query: str) -> str:
    return re.sub(r"\s+", " ", query or "").strip().lower()


# ── Counting real searches ───────────────────────────────────────────────────

#: Requests actually sent to Tavily by the card being built, so its row can
#: say what it cost (the admin page's per-account table reads it). A list so
#: the searches gathered in child tasks add to the same count.
_spent: ContextVar[Optional[list]] = ContextVar("content_pool_spent", default=None)


def start_counting() -> list:
    counter = [0]
    _spent.set(counter)
    return counter


def _count_one() -> None:
    counter = _spent.get()
    if counter is not None:
        counter[0] += 1


# ── Storage ──────────────────────────────────────────────────────────────────

def _parse(ts) -> Optional[datetime]:
    try:
        value = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def to_json(results) -> list[dict]:
    out = []
    for r in results or []:
        item = asdict(r)
        item["images"] = [dict(i) for i in item.get("images") or []]
        out.append(item)
    return out


def from_json(items) -> list:
    from backend.websearch import SearchImage, SearchResult

    out = []
    for item in items or []:
        if not isinstance(item, dict) or not item.get("url"):
            continue
        images = tuple(
            SearchImage(url=str(i.get("url") or ""), description=str(i.get("description") or ""))
            for i in item.get("images") or [] if isinstance(i, dict) and i.get("url")
        )
        out.append(SearchResult(
            title=str(item.get("title") or ""), url=str(item["url"]),
            snippet=str(item.get("snippet") or ""), lang=item.get("lang") or "en",
            published_at=str(item.get("published_at") or ""),
            site_name=str(item.get("site_name") or ""), tier=item.get("tier") or "neutral",
            images=images,
        ))
    return out


def _load(sb, kind: str, lang: str, key: str) -> Optional[dict]:
    rows = sb.table(TABLE).select("results,fetched_at,uses").eq("kind", kind).eq("lang", lang) \
        .eq("query", key).limit(1).execute().data or []
    return rows[0] if rows else None


def _save(sb, kind: str, lang: str, key: str, results: list[dict], now: datetime) -> None:
    sb.table(TABLE).upsert({
        "kind": kind, "lang": lang, "query": key, "results": results,
        "fetched_at": now.isoformat(), "uses": 1,
    }, on_conflict="kind,lang,query").execute()


def _bump(sb, kind: str, lang: str, key: str, uses: int) -> None:
    sb.table(TABLE).update({"uses": uses + 1}).eq("kind", kind).eq("lang", lang) \
        .eq("query", key).execute()


async def _quietly(fn, what: str):
    """Pool storage never decides whether a card gets made: unreachable or
    missing, the search simply goes to the provider as before."""
    try:
        return await anyio.to_thread.run_sync(fn)
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] content pool {what} failed: {type(exc).__name__}: {str(exc)[:200]}")
        return None


# ── Entry point ──────────────────────────────────────────────────────────────

async def search(
    kind: str, query: str, lang: str, fetch: Callable[[], Awaitable[list]],
    *, now: Optional[datetime] = None,
) -> list:
    """Results for these words: from the pool while fresh, else one budgeted
    provider request whose results then go into the pool.

    `fetch` sends the request itself; the budget is taken here, only when the
    pool can't answer. A spent budget or a provider failure falls back to a
    pool entry of any age, and raises only when there is none.
    """
    now = now or datetime.now(timezone.utc)
    key = query_key(query)
    sb = runtime.get_supabase()
    row = await _quietly(lambda: _load(sb, kind, lang, key), "read") if sb and key else None

    ttl = ttl_days()
    fetched = _parse((row or {}).get("fetched_at"))
    if row and ttl and fetched and now - fetched < timedelta(days=ttl):
        await _quietly(lambda: _bump(sb, kind, lang, key, int(row.get("uses") or 0)), "count")
        return from_json(row.get("results"))

    try:
        await search_budget.spend(kind)
        _count_one()
        results = await fetch()
    except Exception as exc:
        if row is not None:
            print(f"[warn] content pool: {type(exc).__name__}, using the {kind} results from {row.get('fetched_at')}")
            return from_json(row.get("results"))
        raise
    # Nothing found is not kept: a week of "nothing" for these words would
    # cost more than the one search it saves.
    if sb and key and results:
        payload = to_json(results)
        await _quietly(lambda: _save(sb, kind, lang, key, payload, now), "write")
    return results
