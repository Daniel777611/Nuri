"""The daily ceiling on Tavily requests made for the daily cards."""

from __future__ import annotations

import asyncio
import threading
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from backend import push_service, runtime
from backend.feed import daily_post as dp
from backend.feed import daily_video as dv
from backend.feed import search_budget as sb
from backend.search_tavily import TavilySearchProvider
from backend.tests.test_daily_post import _no_real_database  # noqa: F401 - fixture

NOW = datetime(2026, 11, 1, 15, 0, tzinfo=timezone.utc)
TOMORROW = datetime(2026, 11, 2, 15, 0, tzinfo=timezone.utc)


class _Query:
    """app_settings as PostgREST treats it: an update matches on its filters,
    an ignored duplicate returns no rows."""

    def __init__(self, db):
        self.db, self.op, self.payload, self.filters = db, "select", None, {}

    def select(self, *_a): return self
    def limit(self, _n): return self
    def eq(self, column, value): self.filters[column] = value; return self
    def update(self, patch): self.op, self.payload = "update", patch; return self

    def upsert(self, row, **kwargs):
        assert kwargs == {"on_conflict": "key", "ignore_duplicates": True}
        self.op, self.payload = "upsert", row
        return self

    def execute(self):
        with self.db.lock:
            if self.db.broken:
                raise RuntimeError("database down")
            if self.op == "upsert":
                if self.payload["key"] in self.db.rows:
                    return SimpleNamespace(data=[])
                self.db.rows[self.payload["key"]] = dict(self.payload)
                return SimpleNamespace(data=[dict(self.payload)])
            row = self.db.rows.get(self.filters.get("key"))
            if row is None or any(row.get(k) != v for k, v in self.filters.items()):
                return SimpleNamespace(data=[])
            if self.op == "update":
                row.update(self.payload)
            return SimpleNamespace(data=[dict(row)])


class _Settings:
    def __init__(self):
        self.rows, self.lock, self.broken = {}, threading.Lock(), False

    def table(self, name):
        assert name == "app_settings"
        return _Query(self)


@pytest.fixture
def db(monkeypatch):
    settings = _Settings()
    monkeypatch.setattr(runtime, "get_supabase", lambda: settings)
    for name in ("DAILY_POST_SEARCH_LIMIT", "DAILY_VIDEO_SEARCH_LIMIT",
                 "DAILY_POST_ACCOUNT_SEARCH_LIMIT", "DAILY_VIDEO_ACCOUNT_SEARCH_LIMIT"):
        monkeypatch.delenv(name, raising=False)
    return settings


def _spend(kind="post", now=NOW, account=None):
    async def run():
        with sb.for_account(account):
            await sb.spend(kind, now=now)
    asyncio.run(run())


def test_fifteen_requests_a_day_site_wide_then_no_more(db):
    for _ in range(15):
        _spend()
    with pytest.raises(sb.SearchBudgetSpent, match="limit of 15 reached"):
        _spend()
    assert db.rows["daily_search_budget_post"]["value"] == "2026-11-01:15"


def test_each_account_gets_ten_of_its_own(db):
    for _ in range(10):
        _spend(account="u1")
    with pytest.raises(sb.SearchBudgetSpent, match="limit of 10 for this account"):
        _spend(account="u1")
    # Another parent is not held back by the first one's searches.
    _spend(account="u2")
    assert db.rows["daily_search_budget_post:u1"]["value"] == "2026-11-01:10"
    assert db.rows["daily_search_budget_post:u2"]["value"] == "2026-11-01:1"
    assert db.rows["daily_search_budget_post"]["value"] == "2026-11-01:11"


def test_the_site_wide_backstop_still_holds_across_accounts(db):
    for i in range(15):
        _spend(account=f"u{i}")
    with pytest.raises(sb.SearchBudgetSpent, match="limit of 15 reached"):
        _spend(account="u99")


def test_an_account_out_of_searches_is_refused_before_a_model_call(db):
    for _ in range(10):
        _spend(account="u1")

    async def check(account):
        with sb.for_account(account):
            await sb.require_some_left("post", now=NOW)

    with pytest.raises(sb.SearchBudgetSpent, match="for this account"):
        asyncio.run(check("u1"))
    asyncio.run(check("u2"))


def test_the_account_lasts_only_inside_its_block(db):
    async def run():
        with sb.for_account("u1"):
            await sb.spend("post", now=NOW)
        await sb.spend("post", now=NOW)

    asyncio.run(run())
    assert db.rows["daily_search_budget_post:u1"]["value"] == "2026-11-01:1"
    assert db.rows["daily_search_budget_post"]["value"] == "2026-11-01:2"


def test_posts_and_videos_have_separate_budgets(db):
    for _ in range(15):
        _spend("post")
    _spend("video")
    assert db.rows["daily_search_budget_video"]["value"] == "2026-11-01:1"


def test_a_new_utc_day_starts_again(db):
    for _ in range(10):
        _spend(account="u1")
    for _ in range(5):
        _spend()
    _spend(now=TOMORROW, account="u1")
    assert db.rows["daily_search_budget_post"]["value"] == "2026-11-02:1"
    assert db.rows["daily_search_budget_post:u1"]["value"] == "2026-11-02:1"


def test_the_limit_can_change_without_a_release(db, monkeypatch):
    monkeypatch.setenv("DAILY_VIDEO_SEARCH_LIMIT", "1")
    _spend("video")
    with pytest.raises(sb.SearchBudgetSpent):
        _spend("video")
    monkeypatch.setenv("DAILY_VIDEO_SEARCH_LIMIT", "not a number")
    assert sb.limit("video") == sb.DEFAULT_LIMIT
    monkeypatch.setenv("DAILY_VIDEO_ACCOUNT_SEARCH_LIMIT", "2")
    _spend("video", account="u1")
    _spend("video", account="u1")
    with pytest.raises(sb.SearchBudgetSpent, match="for this account"):
        _spend("video", account="u1")


def test_concurrent_instances_cannot_overspend(db, monkeypatch):
    monkeypatch.setattr(sb, "_TAKE_ATTEMPTS", 200)
    taken = []

    def worker():
        if sb._take(db, "post", NOW):
            taken.append(1)

    threads = [threading.Thread(target=worker) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(taken) == 15
    assert db.rows["daily_search_budget_post"]["value"] == "2026-11-01:15"


def test_an_unreachable_counter_does_not_block_the_search(db):
    db.broken = True
    _spend()
    asyncio.run(sb.require_some_left("post", now=NOW))


def test_require_some_left_only_reads(db):
    asyncio.run(sb.require_some_left("post", now=NOW))
    assert not db.rows
    for _ in range(15):
        _spend()
    with pytest.raises(sb.SearchBudgetSpent):
        asyncio.run(sb.require_some_left("post", now=NOW))


def _plan():
    return dp.Plan(basis="profile", concern="挑食", query_zh="挑食 宝妈", query_en="picky moms")


@pytest.mark.parametrize("module, kind", [(dp, "DAILY_POST"), (dv, "DAILY_VIDEO")])
def test_card_searches_stop_at_the_limit_without_reaching_tavily(db, monkeypatch, module, kind):
    monkeypatch.setenv("TAVILY_API_KEY", "test")
    monkeypatch.setenv(f"{kind}_SEARCH_LIMIT", "3")
    requests = []

    async def fetch(_self, request):
        requests.append(request.query)
        return []

    monkeypatch.setattr(TavilySearchProvider, "fetch", fetch)
    asyncio.run(module.find_candidates(_plan(), "zh-CN", set()))  # both languages: 2 of 3
    asyncio.run(module.find_candidates(_plan(), "zh-CN", set()))  # one more gets through
    assert len(requests) == 3
    with pytest.raises(sb.SearchBudgetSpent):
        asyncio.run(module.find_candidates(_plan(), "zh-CN", set()))
    assert len(requests) == 3


def test_the_start_of_the_list_moves_each_day_and_keeps_everyone():
    uids = [f"u{i}" for i in range(8)]
    today = push_service.fair_order(uids, NOW)
    tomorrow = push_service.fair_order(uids, TOMORROW)
    assert sorted(today) == sorted(uids)
    assert tomorrow == today[1:] + today[:1]
    assert push_service.fair_order([], NOW) == []


def test_at_five_cards_a_kind_nobody_goes_without_both():
    uids = [f"u{i}" for i in range(8)]
    for day in (NOW, TOMORROW):
        posts = push_service.fair_order(uids, day)[:5]
        videos = push_service.fair_order(uids, day, shift=len(uids) // 2)[:5]
        assert set(posts) | set(videos) == set(uids)
