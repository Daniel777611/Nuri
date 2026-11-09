"""The shared search pool: one Tavily request serves every parent with the same words."""

from __future__ import annotations

import asyncio
import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend import runtime
from backend.feed import search_budget, search_pool
from backend.search_tavily import SearchUnavailable
from backend.websearch import SearchImage, SearchResult

NOW = datetime(2026, 11, 9, 15, tzinfo=timezone.utc)


class _Query:
    def __init__(self, db, table):
        self._db, self._table = db, table
        self._filters, self._op, self._payload = [], "select", None

    def select(self, *_a, **_k): return self
    def update(self, patch): self._op, self._payload = "update", patch; return self
    def upsert(self, row, **_k): self._op, self._payload = "upsert", row; return self
    def eq(self, c, v): self._filters.append((c, v)); return self
    def limit(self, *_a, **_k): return self

    def execute(self):
        if self._db.down:
            raise RuntimeError("connection refused")
        with self._db.lock:
            rows = self._db.tables.setdefault(self._table, [])
            if self._op == "upsert":
                key = (self._payload["kind"], self._payload["lang"], self._payload["query"])
                rows[:] = [r for r in rows if (r["kind"], r["lang"], r["query"]) != key]
                rows.append(dict(self._payload))
                return SimpleNamespace(data=[dict(self._payload)])
            hits = [r for r in rows if all(r.get(c) == v for c, v in self._filters)]
            if self._op == "update":
                for r in hits:
                    r.update(self._payload)
            return SimpleNamespace(data=[dict(r) for r in hits])


class _DB:
    def __init__(self):
        self.tables, self.lock, self.down = {}, threading.Lock(), False

    def table(self, name):
        return _Query(self, name)


@pytest.fixture
def db(monkeypatch):
    db = _DB()
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.delenv("CONTENT_POOL_TTL_DAYS", raising=False)
    spent: list[str] = []

    async def spend(kind, **_k):
        if db.budget_left is not None:
            if db.budget_left <= 0:
                raise search_budget.SearchBudgetSpent(f"daily {kind} search limit of 10 reached")
            db.budget_left -= 1
        spent.append(kind)

    db.budget_left = None
    db.spent = spent
    monkeypatch.setattr(search_budget, "spend", spend)
    return db


def _result(n=1):
    return SearchResult(
        title=f"Post {n}", url=f"https://www.facebook.com/groups/moms/posts/{n}",
        snippet="My 9 month old would only eat purees, here is what we did.", lang="en",
        images=(SearchImage(url=f"https://scontent.example/{n}.jpg", description="a bowl"),),
    )


def _fetcher(calls, results=None, error=None):
    async def fetch():
        calls.append(1)
        if error:
            raise error
        return list(results if results is not None else [_result()])
    return fetch


def _search(query="9 month old starting solids moms", *, fetch, now=NOW, kind="post", lang="en"):
    return asyncio.run(search_pool.search(kind, query, lang, fetch, now=now))


def test_the_second_parent_with_the_same_words_does_not_search(db):
    calls = []
    first = _search(fetch=_fetcher(calls))
    second = _search("  9 Month old starting  solids moms ", fetch=_fetcher(calls), now=NOW + timedelta(days=2))
    assert len(calls) == 1 and db.spent == ["post"]
    # The pooled copy comes back as the same results, images included.
    assert second == first
    assert db.tables["content_search_pool"][0]["uses"] == 2


def test_a_pooled_search_is_searched_again_after_the_ttl(db, monkeypatch):
    monkeypatch.setenv("CONTENT_POOL_TTL_DAYS", "3")
    calls = []
    _search(fetch=_fetcher(calls))
    _search(fetch=_fetcher(calls), now=NOW + timedelta(days=3, minutes=1))
    assert len(calls) == 2


def test_ttl_zero_turns_sharing_off(db, monkeypatch):
    monkeypatch.setenv("CONTENT_POOL_TTL_DAYS", "0")
    calls = []
    _search(fetch=_fetcher(calls))
    _search(fetch=_fetcher(calls))
    assert len(calls) == 2


def test_kinds_and_languages_do_not_share(db):
    calls = []
    _search(fetch=_fetcher(calls))
    _search(fetch=_fetcher(calls), kind="video")
    _search(fetch=_fetcher(calls), lang="zh")
    assert len(calls) == 3


def test_an_empty_answer_is_not_pooled(db):
    calls = []
    assert _search(fetch=_fetcher(calls, results=[])) == []
    _search(fetch=_fetcher(calls))
    assert len(calls) == 2


def test_a_spent_budget_falls_back_to_a_stale_entry(db):
    calls = []
    first = _search(fetch=_fetcher(calls))
    db.budget_left = 0
    stale = _search(fetch=_fetcher(calls), now=NOW + timedelta(days=30))
    assert stale == first and len(calls) == 1


def test_a_spent_budget_with_nothing_pooled_raises(db):
    db.budget_left = 0
    calls = []
    with pytest.raises(search_budget.SearchBudgetSpent):
        _search(fetch=_fetcher(calls))
    assert not calls


def test_an_outage_falls_back_to_a_stale_entry_and_otherwise_raises(db):
    calls = []
    first = _search(fetch=_fetcher(calls))
    outage = SearchUnavailable("tavily HTTP 432: usage limit")
    assert _search(fetch=_fetcher(calls, error=outage), now=NOW + timedelta(days=8)) == first
    with pytest.raises(SearchUnavailable):
        _search("toddler tantrums moms", fetch=_fetcher(calls, error=outage))


def test_an_unreachable_pool_still_searches(db):
    db.down = True
    calls = []
    assert _search(fetch=_fetcher(calls)) == [_result()]
    assert len(calls) == 1


def test_the_count_says_how_many_requests_were_really_sent(db):
    async def card():
        counter = search_pool.start_counting()
        calls = []
        await asyncio.gather(
            search_pool.search("post", "a moms", "en", _fetcher(calls), now=NOW),
            search_pool.search("post", "b moms", "zh", _fetcher(calls), now=NOW),
        )
        await search_pool.search("post", "a moms", "en", _fetcher(calls), now=NOW)
        return counter[0]

    assert asyncio.run(card()) == 2


def test_the_admin_count_reads_the_recorded_searches():
    from backend.usage_dashboard import card_searches

    assert card_searches({"status": "ready", "query": {"zh": "a", "en": "b", "searches": 0}}) == 0
    assert card_searches({"status": "failed", "query": {"searches": 1}}) == 1
    # Rows from before the pool keep the old estimate.
    assert card_searches({"status": "ready", "query": {"zh": "a", "en": "b"}}) == 2
