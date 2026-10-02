"""The daily video: which links count, what the pick must be, the day's flow."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend import push_service, runtime
from backend.feed import daily_post as dp
from backend.feed import daily_video as dv
from backend.feed import signals as feed_signals
from backend.nuri_core import care_notifications as care
from backend.nuri_core import family_store
from backend.tests.test_daily_post import _DB, _no_real_database  # noqa: F401 - fixture

NOW = datetime(2026, 9, 11, 16, 0, tzinfo=timezone.utc)
VID = "vIULng1QDpo"


@pytest.mark.parametrize("url, expected", [
    (f"https://www.youtube.com/watch?v={VID}&t=30s", VID),
    (f"https://youtu.be/{VID}", VID),
    (f"https://m.youtube.com/watch?v={VID}", VID),
    (f"https://www.youtube.com/shorts/{VID}", None),
    ("https://www.youtube.com/@doctor/videos", None),
    ("https://www.youtube.com/playlist?list=PL123", None),
    (f"https://vimeo.com/{VID}", None),
])
def test_only_watch_links_are_videos(url, expected):
    assert dv.video_id_of(url) == expected


def _result(url=f"https://www.youtube.com/watch?v={VID}", title="Tantrum tips - YouTube"):
    return SimpleNamespace(url=url, title=title, snippet="A pediatrician explains tantrums.", lang="en")


def test_candidates_drop_repeats_and_recently_shown_videos():
    other = "https://www.youtube.com/watch?v=GXAyoxpqMag"
    out = dv.to_candidates([_result(), _result(), _result(url=other)], exclude_urls={dv.watch_url(VID)})
    assert [c.video_id for c in out] == ["GXAyoxpqMag"]
    assert dv.to_candidates([_result()], exclude_urls=set())[0].title == "Tantrum tips"


def test_video_searches_ask_for_experts_not_mom_groups():
    zh, en = dv.video_queries(dp.Plan(basis="profile", concern="x", query_zh="20个月 发脾气 宝妈",
                                      query_en="toddler tantrums moms"))
    assert "宝妈" not in zh and "育儿专家" in zh
    assert not en.endswith("moms") and "pediatrician" in en


def _pick(**over):
    data = {"choice": 0, "video_topic": "发脾气", "fit": "strong", "display_title": "孩子发脾气怎么办",
            "channel": "Cook Children's", "speaker_kind": "institution"}
    data.update(over)
    return data


@pytest.mark.parametrize("override", [{"choice": -1}, {"choice": 3}, {"fit": "weak"}, {"fit": ""}])
def test_unfit_picks_are_refused(override):
    assert dv.validate_pick(_pick(**override), dv.to_candidates([_result()], exclude_urls=set())) is None


def test_the_intro_only_claims_a_conversation_that_happened():
    talked = dv.intro({"basis": "conversation", "concern": "躺地哭闹"}, "Linda", "zh-CN")
    assert talked.startswith("Linda你好呀") and "你和NURI聊到「躺地哭闹」" in talked
    stage = dv.intro({"basis": "profile", "concern": "10个月 · 睡眠"}, "", "zh-CN")
    assert "聊到" not in stage and "孩子现在的阶段" in stage
    assert "影片" in dv.intro({"basis": "conversation", "concern": "x"}, "", "zh-TW")
    assert dv.intro({"basis": "conversation", "concern": "picky eating"}, "Ann", "en").startswith("Hi Ann!")


def test_the_lock_screen_shows_the_video_not_the_parents_words():
    title, body = care.video_message({"display_title": "孩子发脾气怎么办", "concern": "躺地哭闹"})
    assert "躺地哭闹" not in title + body and "孩子发脾气怎么办" in body


@pytest.mark.parametrize("utc_hour, expected", [
    (15, NOW.replace(hour=21)),   # 08:00 in LA → 14:00 LA today
    (22, NOW.replace(hour=22)),   # 15:00 LA, before care → now
    (2, NOW.replace(hour=21)),    # 19:00 LA the evening before → 14:00 LA the next day
])
def test_the_video_goes_out_between_the_post_and_care(utc_hour, expected):
    now = NOW.replace(hour=utc_hour)
    when = push_service.video_send_time({"time_zone": "America/Los_Angeles"}, now)
    assert when == expected


@pytest.fixture
def world(monkeypatch):
    db = _DB()
    state = SimpleNamespace(db=db, picks=0, summaries=0)
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(dv, "enabled", lambda: True)

    async def fake_profile(_uid):
        return {"nickname": "Linda", "parent_role": "mom", "top_concerns": ["emotion"]}, [
            {"nickname": "小满", "birth_date": "2025-01-05"}
        ]

    async def fake_chat(_uid, **_k):
        return {"state": "ready", "preferred_locale": "zh-CN", "external_research_allowed": True,
                "messages": [{"role": "user", "text": "宝宝一不如意就躺地上哭"}]}

    async def fake_find(plan, _locale, exclude):
        return [] if dv.watch_url(VID) in exclude else dv.to_candidates([_result()], exclude_urls=set())

    def fake_pick(candidates, **_k):
        state.picks += 1
        return dv.validate_pick(_pick(), candidates)

    def fake_summary(card, locale):
        state.summaries += 1
        return "儿科医生讲孩子为什么发脾气，以及家长怎么应对。"

    monkeypatch.setattr(family_store, "load_profile", fake_profile)
    monkeypatch.setattr(feed_signals, "load_recent_main_chat", fake_chat)
    monkeypatch.setattr(dp, "conversation_plan", lambda *_a, **_k: dp.Plan(
        basis="conversation", concern="躺地哭闹", query_zh="20个月 发脾气 宝妈", query_en="toddler tantrums moms"))
    monkeypatch.setattr(dv, "find_candidates", fake_find)
    monkeypatch.setattr(dv, "pick_video", fake_pick)
    monkeypatch.setattr(dv, "write_summary", fake_summary)
    return state


def _get(now=NOW):
    return asyncio.run(dv.get_daily_video("mom-1", "America/Los_Angeles", now=now))


def test_the_days_video_is_built_once_and_its_summary_written_once(world):
    first = _get()
    assert first["state"] == "ready"
    card = first["card"]
    assert card["video_id"] == VID and card["card_id"].startswith(dv.CARD_ID_PREFIX)
    assert "躺地哭闹" in card["intro"] and "description" not in card
    assert _get(now=NOW + timedelta(hours=3))["card"]["id"] == card["id"] and world.picks == 1

    summary = asyncio.run(dv.get_summary("mom-1", card["id"]))
    assert summary and asyncio.run(dv.get_summary("mom-1", card["id"])) == summary
    assert world.summaries == 1
    assert asyncio.run(dv.get_summary("someone-else", card["id"])) is None


def test_tomorrow_never_repeats_the_same_video(world):
    _get()
    assert _get(now=NOW + timedelta(days=1))["state"] == "empty"


def test_the_chat_marker_carries_the_video(world):
    card = _get()["card"]
    fields = asyncio.run(dv.marker_fields("mom-1", card["card_id"]))
    assert fields["title"] == "孩子发脾气怎么办" and dv.watch_url(VID) in fields["context"]
    assert asyncio.run(dv.marker_fields("mom-1", "dailypost:x")) is None
