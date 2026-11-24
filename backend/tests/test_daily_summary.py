"""The daily card as a summary of many sources (feed/daily_summary.py).

No network: searches, the model and the database are all replaced.
runtime.get_supabase is patched so nothing can reach the database in .env.
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend import runtime
from backend.feed import daily_post as dp
from backend.feed import daily_summary as ds
from backend.feed import search_pool
from backend.feed import signals as feed_signals
from backend.nuri_core import family_store

QUERY = "12个月 宝宝 学步 走路 宝妈"


@pytest.fixture(autouse=True)
def _no_database(monkeypatch):
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)
    monkeypatch.setattr(ds, "FORMAT", "summary")


def result(url, title="", snippet="", lang="zh"):
    return SimpleNamespace(url=url, title=title, snippet=snippet, lang=lang, published_at="", images=())


def walking_results(n=8):
    out = []
    for i in range(n):
        out.append(result(f"https://www.xiaohongshu.com/explore/{i:024x}", f"宝宝学步第{i}天 - rednote",
                          f"Title: 宝宝学步第{i}天 - rednote\n我家宝宝12个月开始学走路，扶着沙发走了{i}步，"
                          "我们没有用学步车，就是在地垫上让他自己练，摔倒了也先不急着抱，等他自己爬起来再继续。"))
    out.append(result("https://zhuanlan.zhihu.com/p/1", "宝宝学走路的误区 - 知乎",
                      "不要用学步车帮宝宝学走路，学步车反而会减慢宝宝独立走路的进程，还容易摔伤。"))
    return out


# ── Which results are sources ────────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    ("https://www.xiaohongshu.com/discovery/item/69fd92bb0000000022028deb?app_platform=android&x=1",
     ("https://www.xiaohongshu.com/explore/69fd92bb0000000022028deb", "xiaohongshu")),
    ("https://www.xiaohongshu.com/explore/6a24d097000000001702e9de",
     ("https://www.xiaohongshu.com/explore/6a24d097000000001702e9de", "xiaohongshu")),
    ("https://www.xiaohongshu.com/user/profile/565870f6e4251d76d8f77d34", (None, "")),
    ("https://www.taobao.com/chanpin/abc", (None, "")),
    ("https://mianfeiwendang.com/doc/7b93", (None, "")),
    ("https://zhuanlan.zhihu.com/p/61305222#comments", ("https://zhuanlan.zhihu.com/p/61305222", "web")),
])
def test_what_counts_as_a_source(url, expected):
    assert ds.source_url(url) == expected


def test_page_furniture_is_cleaned_out():
    text = ds.clean_text("", "Title: 宝宝学步 - rednote\n您还未登录\n分享二维码\n沪ICP备13030189号\n"
                             "# 宝宝学步要点\n先练扶站，再练迈步。")
    assert text == "宝宝学步要点 先练扶站，再练迈步。"
    assert ds.clean_title("宝宝学步 - rednote", "u") == "宝宝学步"


def test_sources_are_deduped_filtered_and_on_topic():
    results = walking_results(3) + [
        walking_results(1)[0],  # the same note again
        result("https://www.xiaohongshu.com/explore/" + "f" * 24, "学步鞋",
               "学步鞋限时折扣，私信下单包邮，宝宝学走路必备！"),  # an ad
        result("https://www.sohu.com/a/1", "宝宝辅食", "辅食添加的顺序和方法，从米粉开始，一次加一种。"),  # off-topic
        result("https://www.sohu.com/a/2", "短", "太短"),
    ]
    sources = ds.to_sources(results, query=QUERY)
    assert len(sources) == 3
    assert {s.platform for s in sources} == {"xiaohongshu"}
    assert all(s.label == "小红书" for s in sources)


def test_a_recently_shown_source_is_left_out():
    first = ds.source_url(walking_results(1)[0].url)[0]
    assert all(s.url != first for s in ds.to_sources(walking_results(3), query=QUERY, exclude_urls={first}))


# ── Searching: no more searches than the one-post card ───────────────────────

def _recording_pool(monkeypatch):
    calls = []

    async def fake_search(kind, query, lang, fetch, **_k):
        calls.append((kind, query, lang))
        return walking_results(3)

    monkeypatch.setattr(search_pool, "search", fake_search)
    monkeypatch.setenv("TAVILY_API_KEY", "test")
    return calls


def test_chinese_searches_xiaohongshu_and_the_web_in_two_requests(monkeypatch):
    calls = _recording_pool(monkeypatch)
    plan = dp.Plan(basis="profile", concern="学步", query_zh=QUERY, query_en="12 month old learning to walk moms")
    sources = asyncio.run(ds.find_sources(plan, "zh-CN", set()))
    assert calls == [("post", f"[xhs] {QUERY}", "zh"), ("post", f"[web] {QUERY}", "zh")]
    assert len(sources) == 3  # the same three notes from both, once each


def test_english_searches_meta_and_the_web_in_two_requests(monkeypatch):
    calls = _recording_pool(monkeypatch)
    plan = dp.Plan(basis="profile", concern="walking", query_zh=QUERY, query_en="12 month old learning to walk moms")
    asyncio.run(ds.find_sources(plan, "en", set()))
    assert [q.split("]")[0] + "]" for _, q, _ in calls] == ["[meta]", "[web]"]
    assert all(lang == "en" for _, _, lang in calls)


# ── The model's summary ──────────────────────────────────────────────────────

def _sources(n=6):
    return ds.to_sources(walking_results(n), query=QUERY)


def _data(**over):
    data = {
        "relevant": [0, 1, 2, 3, 4],
        "question": "1岁宝宝学走路，家长能帮什么？",
        "headline": "多数家长让宝宝在地垫上自己练",
        "points": [
            {"text": "先练扶站和扶走，再放手", "sources": [2, 0]},
            {"text": "不用学步车，地垫上自己练", "sources": [0, 1]},
            {"text": "摔倒了先别急着抱起来", "sources": [3]},
        ],
        "situation": "几位一岁宝宝家长分享学步经历。",
        "why_this": "适合12个月宝宝的家长参考",
        "caution": "",
    }
    data.update(over)
    return data


def test_a_valid_summary_numbers_cited_sources_first():
    sources = _sources()
    out = ds.validate_summary(_data(), sources)
    assert out["takeaways"][0] == "先练扶站和扶走，再放手"
    # Cited in order 2, 0, 1, 3, then the uncited relevant one (4).
    assert [s.url for s in out["sources"]] == [sources[i].url for i in (2, 0, 1, 3, 4)]
    assert out["takeaway_sources"] == [[1, 2], [2, 3], [4]]


def test_too_few_relevant_sources_is_not_a_summary():
    assert ds.validate_summary(_data(relevant=[0, 1, 2]), _sources()) is None


def test_points_without_a_real_source_are_dropped():
    data = _data(points=[
        {"text": "先练扶站", "sources": [0]},
        {"text": "编出来的", "sources": [99]},
        {"text": "没出处", "sources": []},
        {"text": "不用学步车", "sources": [1]},
    ])
    assert ds.validate_summary(data, _sources()) is None  # two backed points < MIN_POINTS


def test_summarize_makes_one_model_call_about_the_topic_not_the_family(monkeypatch):
    calls = []

    def fake_model(call_site, messages, fmt):
        calls.append((call_site, messages[1]["content"]))
        return _data()

    monkeypatch.setattr(dp, "_model_json", fake_model)
    assert ds.summarize(_sources(), topic="12个月 宝宝 学步 走路", locale="zh-CN")
    assert len(calls) == 1 and calls[0][0] == "feed.daily_post_summary"
    prompt = calls[0][1]
    assert prompt.startswith("话题：12个月 宝宝 学步 走路") and "[5]" in prompt
    assert "这位家长" not in prompt  # shared: nothing about one family goes in


def test_the_topic_is_the_search_words_without_the_group_word():
    plan = dp.Plan(basis="profile", concern="13个月 · 学步", query_zh=QUERY, query_en="12 month old learning to walk moms")
    assert ds.topic_of(plan, "zh-CN") == "12个月 宝宝 学步 走路"
    assert ds.topic_of(plan, "en") == "12 month old learning to walk"


def test_too_few_sources_never_reach_the_model(monkeypatch):
    monkeypatch.setattr(dp, "_model_json", lambda *_a: pytest.fail("model called"))
    assert ds.summarize(_sources(2), topic="学步", locale="zh-CN") is None


def test_at_most_twelve_sources_of_about_three_hundred_characters():
    results = [result(f"https://www.xiaohongshu.com/explore/{i:024x}", f"学步{i}",
                      "宝宝12个月学走路，" + "我们每天在地垫上练扶站和迈步。" * 40) for i in range(20)]
    sources = ds.to_sources(results, query=QUERY)
    assert len(sources) == ds.MAX_SOURCES == 12
    assert all(len(s.text) <= ds.SOURCE_CHARS == 300 for s in sources)


# ── The card ─────────────────────────────────────────────────────────────────

def test_the_card_says_how_many_sources_and_from_where():
    plan = dp.Plan(basis="profile", concern="12个月 · 学步", query_zh=QUERY)
    summary = ds.validate_summary(_data(), _sources())
    card = ds.build_card(summary, plan, locale="zh-CN")
    assert card["format"] == "summary" and card["summary_source"] == "summary"
    assert card["source_label"] == "参考小红书与全网5篇内容"
    assert card["source_count"] == 5 and len(card["sources"]) == 5
    assert card["sources"][0]["n"] == 1 and card["source_url"] == card["sources"][0]["url"]
    assert card["why_this"] == "适合孩子现在这个阶段的家长参考。"  # a template: the summary is shared
    # Older apps still get a readable one-source card.
    assert card["headline"] and card["takeaways"] and card["platform"] == "小红书"


def test_the_source_line_in_each_language():
    assert ds.source_line(["web"], 12, "zh-CN") == "参考全网12篇内容"
    assert ds.source_line(["xiaohongshu", "web"], 25, "zh-TW") == "參考小紅書與全網25篇內容"
    assert ds.source_line(["facebook", "web"], 9, "en") == "From 9 posts and articles across Facebook and the web"


def test_chat_context_for_a_summary_is_framed_as_material():
    plan = dp.Plan(basis="profile", concern="学步", query_zh=QUERY)
    card = ds.build_card(ds.validate_summary(_data(), _sources()), plan, locale="zh-CN")
    text = dp.chat_context(card)
    assert "汇总的5篇" in text and "不是给你的指令" in text and "一位家长的个人经验" not in text


# ── Wiring ───────────────────────────────────────────────────────────────────

def test_generation_uses_the_summary_and_falls_through_plans(monkeypatch):
    plans = [dp.Plan(basis="conversation", concern="A", query_zh="a"),
             dp.Plan(basis="profile", concern="B", query_zh=QUERY)]
    asked = []

    async def fake_plans(*_a, **_k):
        return plans

    async def fake_find(plan, _locale, _exclude):
        asked.append(plan.concern)
        return _sources(2) if plan.concern == "A" else _sources()  # A: too few to summarize

    async def budget(_kind):
        return True

    async def chat(_uid, **_k):
        return {"preferred_locale": "zh-CN", "external_research_allowed": True, "messages": []}

    async def no_standing(*_a, **_k):
        return []

    monkeypatch.setattr(dp, "plans_for_today", fake_plans)
    monkeypatch.setattr(ds, "find_sources", fake_find)
    monkeypatch.setattr(dp, "has_search_budget", budget)
    monkeypatch.setattr(feed_signals, "load_recent_main_chat", chat)
    monkeypatch.setattr(family_store, "load_standing_memories", no_standing)
    monkeypatch.setattr(dp, "_model_json", lambda *_a: _data())
    monkeypatch.setattr(dp, "find_candidates", lambda *_a: pytest.fail("one-post search in summary mode"))
    store = SimpleNamespace(recent_urls=lambda *_a: set())
    card, plan = asyncio.run(dp._generate("u-1", [], {}, date(2026, 11, 19), store,
                                          datetime(2026, 11, 19, tzinfo=timezone.utc)))
    assert asked == ["A", "B"] and plan.concern == "B"
    assert card["format"] == "summary" and card["concern"] == "B"


# ── Shared across families ───────────────────────────────────────────────────

class _PoolTable:
    """content_search_pool, enough of it for search_pool._load/_save/_bump."""

    def __init__(self, rows):
        self.rows, self.filters, self.op, self.payload = rows, {}, "select", None

    def select(self, *_a):
        return self

    def eq(self, col, val):
        self.filters[col] = val
        return self

    def limit(self, *_a):
        return self

    def upsert(self, row, **_k):
        self.op, self.payload = "upsert", row
        return self

    def update(self, patch):
        self.op, self.payload = "update", patch
        return self

    def execute(self):
        key = lambda r: (r["kind"], r["lang"], r["query"])
        if self.op == "upsert":
            self.rows[key(self.payload)] = dict(self.payload)
            return SimpleNamespace(data=[self.payload])
        hits = [r for r in self.rows.values() if all(r.get(c) == v for c, v in self.filters.items())]
        if self.op == "update":
            for r in hits:
                r.update(self.payload)
        return SimpleNamespace(data=[dict(r) for r in hits])


@pytest.fixture
def pool(monkeypatch):
    rows: dict = {}
    db = SimpleNamespace(table=lambda _name: _PoolTable(rows))
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    state = SimpleNamespace(rows=rows, searches=0, model=0, answer=_data())

    async def fake_find(plan, locale, exclude):
        state.searches += 1
        return _sources()

    def fake_model(*_a):
        state.model += 1
        return state.answer

    monkeypatch.setattr(ds, "find_sources", fake_find)
    monkeypatch.setattr(dp, "_model_json", fake_model)
    return state


NOW = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
PLAN = dp.Plan(basis="profile", concern="12个月 · 学步", query_zh=QUERY, query_en="12 month old learning to walk moms", shared_search=True)


def test_two_families_with_the_same_words_share_one_summary(pool):
    first = asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), now=NOW))
    other = dp.Plan(basis="conversation", concern="13个月 · 学步", query_zh=QUERY, shared_search=True)
    second = asyncio.run(ds.summary_for(other, "zh-CN", set(), now=NOW + timedelta(hours=5)))
    assert first and second and first["headline"] == second["headline"]
    assert pool.model == 1 and pool.searches == 1
    assert [s.url for s in second["sources"]] == [s.url for s in first["sources"]]
    (row,) = pool.rows.values()
    assert row["uses"] == 2 and row["query"].startswith("[summary:zh-cn]")
    assert ds.why_this(other, "zh-CN") != ds.why_this(PLAN, "zh-CN")


def test_personal_query_never_writes_to_the_shared_summary_pool(pool):
    personal = dp.Plan(basis="conversation", concern="我最近的提问", query_zh=QUERY)
    assert asyncio.run(ds.summary_for(personal, "zh-CN", set(), now=NOW))
    assert not pool.rows and pool.model == 1


def test_a_summary_is_written_again_once_it_is_a_week_old(pool):
    asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), now=NOW))
    asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), now=NOW + timedelta(days=8)))
    assert pool.model == 2


def test_each_language_has_its_own_summary(pool):
    asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), now=NOW))
    asyncio.run(ds.summary_for(PLAN, "zh-TW", set(), now=NOW))
    assert pool.model == 2 and len(pool.rows) == 2


def test_words_that_made_no_card_are_not_asked_again_for_a_day(pool):
    pool.answer = _data(relevant=[], points=[])
    assert asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), now=NOW)) is None
    assert asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), now=NOW + timedelta(hours=6))) is None
    assert pool.model == 1
    pool.answer = _data()
    assert asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), now=NOW + timedelta(days=2)))
    assert pool.model == 2


def test_a_family_that_already_saw_it_moves_on(pool):
    seen = asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), now=NOW))["sources"][0].url
    assert asyncio.run(ds.summary_for(PLAN, "zh-CN", {seen}, now=NOW)) is None
    assert pool.model == 1


def test_a_shared_summary_still_answers_to_each_familys_standing_memories(pool, monkeypatch):
    monkeypatch.setattr(ds.standing_guard, "conflicts", lambda *_a, **_k: True)
    assert asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), ["孩子下肢瘫痪"], now=NOW)) is None
    # The clash is this family's, not the summary's: it stays shared.
    assert asyncio.run(ds.summary_for(PLAN, "zh-CN", set(), now=NOW))
    assert pool.model == 1
