"""The daily post card: one real post from another parent, per parent, per day.

No network: the search provider and the model are replaced, and the database
is an in-memory stand-in.
"""

from __future__ import annotations

import asyncio
import threading
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import main, runtime
from backend.feed import daily_post as dp
from backend.feed import signals as feed_signals
from backend.nuri_core import family_store

NOW = datetime(2026, 9, 11, 16, 0, tzinfo=timezone.utc)  # 09:00 in Los Angeles


# ── Post URLs ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("url,expected", [
    ("https://www.facebook.com/groups/babysleep/posts/1092869635799664",
     "https://www.facebook.com/groups/babysleep/posts/1092869635799664"),
    ("https://m.facebook.com/kids.eat.in.color/posts/some-slug/1426389592189492?locale=en_GB",
     "https://www.facebook.com/kids.eat.in.color/posts/some-slug/1426389592189492"),
    ("https://www.facebook.com/permalink.php?story_fbid=123&id=456&ref=x",
     "https://www.facebook.com/permalink.php?story_fbid=123&id=456"),
    ("https://www.instagram.com/reel/DN8GWlYDlzO/toddler-moms-try-this?hl=en",
     "https://www.instagram.com/reel/DN8GWlYDlzO"),
    ("https://www.instagram.com/p/CfJ60mPOBfM", "https://www.instagram.com/p/CfJ60mPOBfM"),
    ("https://www.threads.com/@dr_jaden777/post/DVhp9m2AUoH/slug",
     "https://www.threads.com/@dr_jaden777/post/DVhp9m2AUoH"),
    # Not posts: a page, a group's front page, a login wall, a profile, another site.
    ("https://www.facebook.com/mummyworldmalaysia", None),
    ("https://www.facebook.com/groups/babysleep", None),
    ("https://www.facebook.com/login/?next=%2Fgroups%2Fx%2Fposts%2F1", None),
    ("https://www.instagram.com/some.mom/", None),
    ("https://www.zhihu.com/question/565758002/answer/125012601944", None),
    ("javascript:alert(1)", None),
])
def test_only_post_urls_on_the_three_platforms_survive(url, expected):
    assert dp.canonical_post_url(url) == expected


def test_facebook_markup_and_login_walls_are_stripped():
    text, ai = dp.clean_post_text(
        "Mom group | My 8 month old wakes up | Facebook",
        "Title: Mom group | My 8 month old wakes up | Facebook Never miss a post from x. "
        "Sign up for Instagram to stay in the loop. What I did was white noise and an earlier bedtime. "
        "'/%3E%3Cpath d='M16.0001 7.9996c0 4.418' fill='url(%23paint2)'",
    )
    assert "What I did was white noise and an earlier bedtime." in text
    assert "%3E" not in text and "Never miss" not in text and "Title:" not in text
    assert ai is False


def test_facebook_ai_summaries_are_flagged():
    _text, ai = dp.clean_post_text("G | Q | Facebook", "Summarized by AI from the post below. Parents suggest…")
    assert ai is True


def test_a_snippet_that_was_only_markup_is_too_short_to_use():
    results = [SimpleNamespace(
        url="https://www.facebook.com/OppaSharing/posts/x/1052674312883607",
        title="宝宝辅食", snippet="'/%3E%3Cpath d='M16.0001 7.9996c0 4.418-3.5815 7.9996'", lang="zh",
        published_at="",
    )]
    assert dp.to_candidates(results, exclude_urls=set()) == []


# ── Source labels ────────────────────────────────────────────────────────────

def test_a_group_is_named_only_when_its_url_spells_the_name():
    url = "https://www.facebook.com/groups/babysleeptrainingtipshelp/posts/1"
    assert dp.source_label("facebook", url, "My 10 month old wakes | Baby Sleep Training Tips & Help | Facebook") \
        == "Facebook 群组「Baby Sleep Training Tips & Help」"
    assert dp.source_label("facebook", url, "How to help an 11-month-old sleep? - Facebook",
                           "Baby Sleep Training Tips & Help · my 11 month old") \
        == "Facebook 群组「Baby Sleep Training Tips & Help」"
    # A numeric group id can't vouch for any title part.
    assert dp.source_label("facebook", "https://www.facebook.com/groups/298595937871497/posts/2",
                           "Anyone else have a picky eater | Stately Maine Coons | Facebook") == "Facebook 家长群"


def test_page_threads_and_instagram_labels():
    assert dp.source_label("facebook", "https://www.facebook.com/drshanetan/posts/x/5",
                           "Dr. Shane Tan - 这位妈咪处理孩子的情绪", "Dr. Shane Tan's Post. Dr. Shane Tan") \
        .startswith("Facebook ")
    assert dp.source_label("threads", "https://www.threads.com/@s228587sarah/post/Da_x", "") == "Threads @s228587sarah"
    assert dp.source_label("instagram", "https://www.instagram.com/p/X", 'Set on Instagram: "hi"') == "Instagram Set"


# ── Excerpts and picks ───────────────────────────────────────────────────────

def test_excerpts_stop_where_the_author_stopped():
    assert dp.clean_excerpt("He needs to learn to fall asleep on his own a… Asked heal family") \
        == "He needs to learn to fall asleep on his own a"
    assert dp.clean_excerpt("Too short…") == ""
    long = "First sentence is here. " * 10
    cut = dp.clean_excerpt(long.strip())
    assert cut.endswith(".") and len(cut) <= dp.MAX_EXCERPT_CHARS


def _cand(url="https://www.facebook.com/groups/momsgroup123/posts/1", text=None, ai=False):
    return dp.Candidate(
        url=url, platform="facebook", title="t",
        text=text or "My son refused veggies. What I did was blend spinach into pancakes and he ate them all.",
        ai_summary=ai, lang="en", label="Facebook 家长群",
    )


def _pick(**over):
    data = {
        "choice": 0, "author_kind": "parent", "headline": "把菠菜打进松饼",
        "takeaways": ["把蔬菜打碎做进松饼"], "excerpt": "What I did was blend spinach into pancakes",
        "why_this": "同样是不吃菜", "caution": "",
    }
    data.update(over)
    return data


def test_a_parents_post_with_a_verbatim_quote_is_kept():
    picked = dp.validate_pick(_pick(), [_cand()])
    assert picked and picked["excerpt"] == "What I did was blend spinach into pancakes"


def test_a_quote_that_is_not_in_the_post_is_dropped_not_trusted():
    picked = dp.validate_pick(_pick(excerpt="I blended spinach and broccoli into pancakes"), [_cand()])
    assert picked and picked["excerpt"] == ""


def test_a_facebook_summary_is_never_quoted():
    picked = dp.validate_pick(_pick(), [_cand(ai=True)])
    assert picked["excerpt"] == ""


@pytest.mark.parametrize("override", [
    {"author_kind": "professional"},
    {"author_kind": "organization"},
    {"choice": -1},
    {"choice": 5},
    {"headline": ""},
    {"takeaways": []},
])
def test_non_parent_or_empty_picks_are_refused(override):
    assert dp.validate_pick(_pick(**override), [_cand()]) is None


def test_group_answers_must_actually_come_from_a_group():
    page = _cand(url="https://www.facebook.com/mummyworldmalaysia/posts/x/2")
    assert dp.validate_pick(_pick(author_kind="parent_group_answers"), [page]) is None
    assert dp.validate_pick(_pick(author_kind="parent_group_answers"), [_cand()]) is not None


def test_a_rejected_choice_is_struck_and_the_model_asked_again(monkeypatch):
    calls = []
    answers = [_pick(author_kind="professional"), _pick(choice=0)]

    def fake_ask(candidates, **_k):
        calls.append([c.url for c in candidates])
        return answers[len(calls) - 1]

    monkeypatch.setattr(dp, "_ask_pick", fake_ask)
    first, second = _cand(url="https://www.facebook.com/groups/aaaaaaaa/posts/1"), _cand()
    picked = dp.pick_post([first, second], concern="c", child_age_context="", locale="zh-CN")
    assert picked["candidate"].url == second.url
    assert calls == [[first.url, second.url], [second.url]]


def test_nothing_usable_stops_after_one_question(monkeypatch):
    calls = []
    monkeypatch.setattr(dp, "_ask_pick", lambda c, **_k: calls.append(1) or _pick(choice=-1))
    assert dp.pick_post([_cand()], concern="c", child_age_context="", locale="zh-CN") is None
    assert len(calls) == 1


# ── What to look for ─────────────────────────────────────────────────────────

def test_the_profile_plan_uses_only_age_band_and_a_concern_rotated_by_day():
    children = [{"birth_date": (date.today() - timedelta(days=548)).isoformat()}]
    a = dp.profile_plan(children, ["sleep", "food"], date(2026, 9, 11))
    b = dp.profile_plan(children, ["sleep", "food"], date(2026, 9, 12))
    assert a.basis == "profile"
    assert {a.concern.split(" · ")[1], b.concern.split(" · ")[1]} == {"睡眠", "饮食"}
    assert "个月" in a.query_zh and "month old" in a.query_en


def test_the_profile_label_reads_in_the_parents_language():
    children = [{"birth_date": (date.today() - timedelta(days=548)).isoformat()}]
    assert dp.profile_plan(children, ["emotion"], date(2026, 9, 11), "zh-TW").concern.endswith("情緒")
    assert "個月" in dp.profile_plan(children, ["emotion"], date(2026, 9, 11), "zh-TW").concern
    assert dp.profile_plan(children, ["emotion"], date(2026, 9, 11), "en").concern.endswith("tantrums")


def test_the_profile_plan_without_anything_still_searches():
    plan = dp.profile_plan([], [], date(2026, 9, 11))
    assert plan.query_zh and plan.query_en and plan.concern == "新手家长"


def test_search_words_leave_without_the_childs_name(monkeypatch):
    monkeypatch.setattr(dp, "_model_json", lambda *_a, **_k: {
        "concern": "小满挑食", "query_zh": "小满 18个月 挑食 妈妈经验", "query_en": "Xiaoman picky eater",
    })
    plan = dp.conversation_plan(["小满最近不吃菜"], "孩子当前年龄：18个月", [{"nickname": "小满", "birth_date": "2025-03-05"}])
    assert "小满" not in plan.query_zh


# ── The daily row ────────────────────────────────────────────────────────────

class _Query:
    def __init__(self, db, table):
        self._db, self._table = db, table
        self._filters, self._op, self._payload, self._limit = [], "select", None, None

    def select(self, *_a, **_k): return self
    def insert(self, row): self._op, self._payload = "insert", row; return self
    def update(self, patch): self._op, self._payload = "update", patch; return self
    def eq(self, c, v): self._filters.append(lambda r: str(r.get(c)) == str(v)); return self
    def gte(self, c, v): self._filters.append(lambda r: str(r.get(c)) >= str(v)); return self
    def is_(self, c, _v): self._filters.append(lambda r: r.get(c) is None); return self
    def limit(self, n, **_k): self._limit = n; return self
    def order(self, *_a, **_k): return self

    def execute(self):
        with self._db.lock:
            rows = self._db.tables.setdefault(self._table, [])
            if self._op == "insert":
                if any(r["user_id"] == self._payload["user_id"] and r["day"] == self._payload["day"] for r in rows):
                    raise RuntimeError("23505 duplicate key value violates unique constraint")
                rows.append(dict(self._payload))
                return SimpleNamespace(data=[dict(self._payload)])
            hits = [r for r in rows if all(f(r) for f in self._filters)]
            if self._op == "update":
                for r in hits:
                    r.update(self._payload)
                return SimpleNamespace(data=[dict(r) for r in hits])
            return SimpleNamespace(data=[dict(r) for r in hits[: self._limit or None]])


class _DB:
    def __init__(self):
        self.tables, self.lock = {}, threading.Lock()

    def table(self, name):
        return _Query(self, name)


@pytest.fixture(autouse=True)
def _no_real_database(monkeypatch):
    attempts: list = []

    def refuse(*args, **_k):
        attempts.append(args)
        raise RuntimeError("real Supabase client requested in a unit test")

    monkeypatch.setattr(runtime, "supabase_client", None)
    monkeypatch.setattr(runtime, "create_client", refuse)
    yield
    assert not attempts, "a test tried to open a real Supabase client"


@pytest.fixture
def world(monkeypatch):
    db = _DB()
    state = SimpleNamespace(db=db, generated=0, external=True, conversation_calls=0,
                            searched=[], card_url="https://www.facebook.com/groups/momsgroup123/posts/1")
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(dp, "enabled", lambda: True)

    async def fake_profile(_uid):
        return {"nickname": "Momo", "parent_role": "mom", "top_concerns": ["food"]}, [
            {"nickname": "小满", "birth_date": "2025-03-05"}
        ]

    async def fake_chat(_uid, **_k):
        return {
            "state": "ready", "preferred_locale": "zh-CN",
            "external_research_allowed": state.external,
            "messages": [{"role": "user", "text": "小满最近只吃白米饭"}],
        }

    def fake_conversation_plan(texts, _age, _children, _locale="zh-CN"):
        state.conversation_calls += 1
        return dp.Plan(basis="conversation", concern="挑食", query_zh="18个月 挑食", query_en="picky")

    async def fake_find(plan, _locale, exclude):
        state.searched.append((plan.basis, set(exclude)))
        return [] if state.card_url in exclude else [_cand(url=state.card_url)]

    def fake_pick(candidates, **_k):
        state.generated += 1
        return dp.validate_pick(_pick(), candidates)

    monkeypatch.setattr(family_store, "load_profile", fake_profile)
    monkeypatch.setattr(feed_signals, "load_recent_main_chat", fake_chat)
    monkeypatch.setattr(dp, "conversation_plan", fake_conversation_plan)
    monkeypatch.setattr(dp, "find_candidates", fake_find)
    monkeypatch.setattr(dp, "pick_post", fake_pick)
    return state


def _get(now=NOW, tz="America/Los_Angeles"):
    return asyncio.run(dp.get_daily_post("mom-1", tz, now=now))


def test_the_first_visit_of_the_day_builds_the_card_and_later_visits_reuse_it(world):
    first = _get()
    assert first["state"] == "ready"
    card = first["card"]
    assert card["card_id"].startswith("dailypost:")
    assert card["nickname"] == "Momo" and card["audience"] == "mom"
    assert card["source_url"] == world.card_url and card["basis"] == "conversation"
    again = _get(now=NOW + timedelta(hours=5))
    assert again["card"]["card_id"] == card["card_id"]
    assert world.generated == 1


def test_the_day_follows_the_parents_timezone(world):
    _get()  # 09:00 on the 11th in Los Angeles
    late_utc = NOW + timedelta(hours=10)  # 02:00 UTC on the 12th, still the 11th in LA
    assert _get(now=late_utc)["day"] == "2026-09-11"
    assert _get(now=late_utc, tz="Asia/Shanghai")["day"] == "2026-09-12"


def test_a_new_day_is_a_new_card_and_never_the_same_post_twice(world):
    _get()
    tomorrow = _get(now=NOW + timedelta(days=1))
    # The only post the fake search knows was shown yesterday.
    assert tomorrow["state"] == "empty"
    assert world.card_url in world.searched[-1][1]


def test_without_the_research_switch_the_conversation_never_leaves(world):
    world.external = False
    out = _get()
    assert out["state"] == "ready"
    assert world.conversation_calls == 0
    assert out["card"]["basis"] == "profile"


def test_an_empty_day_is_retried_hours_later_not_every_visit(world, monkeypatch):
    searches = []

    async def empty(*_a, **_k):
        searches.append(1)
        return []

    monkeypatch.setattr(dp, "find_candidates", empty)
    assert _get()["state"] == "empty"
    tried = len(searches)
    assert _get(now=NOW + timedelta(minutes=30))["state"] == "empty"
    assert len(searches) == tried  # no new search inside the retry window
    rows = world.db.tables["daily_post_cards"]
    assert len(rows) == 1 and rows[0]["status"] == "empty"
    assert _get(now=NOW + timedelta(hours=3, minutes=1))["state"] == "empty"
    assert len(searches) > tried


def test_a_second_request_while_one_generates_waits_instead_of_doubling(world):
    world.db.tables["daily_post_cards"] = [{
        "id": "row-1", "user_id": "mom-1", "day": "2026-09-11", "status": "pending",
        "created_at": NOW.isoformat(), "updated_at": (NOW - timedelta(seconds=20)).isoformat(),
    }]
    out = _get()
    assert out["state"] == "pending" and out["retry_after_s"] == 5
    assert world.generated == 0


def test_a_crashed_generation_is_taken_over(world):
    world.db.tables["daily_post_cards"] = [{
        "id": "row-1", "user_id": "mom-1", "day": "2026-09-11", "status": "pending",
        "created_at": NOW.isoformat(), "updated_at": (NOW - timedelta(minutes=10)).isoformat(),
    }]
    out = _get()
    assert out["state"] == "ready" and out["card"]["id"] == "row-1"


def test_a_generation_failure_is_recorded_and_retried_soon(world, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("provider down")

    monkeypatch.setattr(dp, "pick_post", boom)
    assert _get()["state"] == "empty"
    assert world.db.tables["daily_post_cards"][0]["status"] == "failed"
    monkeypatch.setattr(dp, "pick_post", lambda c, **_k: dp.validate_pick(_pick(), c))
    assert _get(now=NOW + timedelta(minutes=11))["state"] == "ready"


def test_switched_off_answers_disabled(monkeypatch):
    monkeypatch.setattr(dp, "enabled", lambda: False)
    assert _get()["state"] == "disabled"


# ── Routes and chat ──────────────────────────────────────────────────────────

def test_the_route_needs_a_token_and_returns_the_card(world):
    client = TestClient(main.app)
    assert client.get("/api/feed/daily-post").status_code == 401
    res = client.get("/api/feed/daily-post?tz=America/Chicago",
                     headers={"Authorization": f"Bearer {main._make_token('mom-1')}"})
    assert res.status_code == 200
    assert res.json()["state"] == "ready"
    assert res.headers["Cache-Control"] == "private, no-store"


def test_a_daily_card_opens_in_chat_only_for_its_owner_and_carries_its_context(world):
    card = _get()["card"]
    owner = asyncio.run(dp.marker_fields("mom-1", card["card_id"]))
    assert owner["title"] == "把菠菜打进松饼"
    assert "What I did was blend spinach" in owner["context"]
    assert asyncio.run(dp.marker_fields("someone-else", card["card_id"])) is None
    assert asyncio.run(dp.marker_fields("mom-1", "card_food_picky")) is None


def test_card_use_is_stamped_once_and_only_for_the_owner(world):
    card = _get()["card"]
    client = TestClient(main.app)
    owner = {"Authorization": f"Bearer {main._make_token('mom-1')}"}
    other = {"Authorization": f"Bearer {main._make_token('someone-else')}"}
    assert client.post(f"/api/feed/daily-post/{card['id']}/events", json={"event": "open"},
                       headers=other).json() == {"recorded": False}
    assert client.post(f"/api/feed/daily-post/{card['id']}/events", json={"event": "open"},
                       headers=owner).json() == {"recorded": True}
    first = world.db.tables["daily_post_cards"][0]["opened_at"]
    client.post(f"/api/feed/daily-post/{card['id']}/events", json={"event": "open"}, headers=owner)
    assert world.db.tables["daily_post_cards"][0]["opened_at"] == first
    assert client.post(f"/api/feed/daily-post/{card['id']}/events", json={"event": "like"},
                       headers=owner).status_code == 422


def test_the_reply_path_reads_the_card_context_from_the_marker():
    main._MARKER_CARD_CONTEXT.clear()
    turn = SimpleNamespace(
        msgs=[{"role": "ai", "text": "", "transition": {
            "kind": main.CARD_OPENED, "card_id": "dailypost:abc", "title": "t", "context": "帖子上下文",
        }}],
        session={"source_card_id": None},
    )
    assert main._active_card_id(turn) == "dailypost:abc"
    assert main._card_ctx("dailypost:abc", []) == "帖子上下文"
