"""The two daily notifications, and where a tap on each one lands.

What each test pins:

* care and the featured post are separate notifications, each at most once a
  day, with collapse ids that cannot overwrite each other on a lock screen;
* the care line waits for the parent's evening and is written from what they
  last talked about; an account that never talked to NURI gets none;
* a tapped care line appears in the conversation as NURI's own message, word
  for word;
* a tapped post appears as NURI's message carrying the post as a card, and as
  the card marker the reply path reads, so the replies are about the post;
* a second tap adds nothing, and someone else's notification is a 404.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from backend import main, push_service
from backend.feed import daily_post as feed_daily_post
from backend.nuri_core import care_notifications as care

POST = {
    "id": "post-1",
    "card_id": "dailypost:post-1",
    "headline": "群里建议逐步自我安抚",
    "takeaways": ["睡前固定流程", "逐步拉长等待时间", "白天多安抚"],
    "source_label": "Facebook 家长群",
    "source_url": "https://example.com/p/1",
}
# 10:00 in Chicago, when the daily run fires.
NOW = datetime(2026, 9, 22, 15, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── Composition ───────────────────────────────────────────────────────────────

def test_the_post_notification_is_its_headline_and_a_takeaway():
    title, body = care.post_message(POST)
    assert title == "群里建议逐步自我安抚"
    assert "睡前固定流程" in body


def test_a_post_without_takeaways_still_has_a_body():
    title, body = care.post_message({"headline": "群里建议逐步自我安抚"})
    assert title and body


def test_what_nuri_says_over_the_card_names_the_post():
    assert "《群里建议逐步自我安抚》" in care.post_intro(POST)


# ── Generation ────────────────────────────────────────────────────────────────

class _EventsDb:
    """Enough of PostgREST for the event writes, honouring the dedupe key."""

    def __init__(self, prefs: dict | None = None):
        self.rows: list[dict] = []
        self.prefs = prefs or {"time_zone": "America/Chicago"}

    def table(self, name):
        db = self

        class _T:
            def select(self, *_a, **_k):
                return self

            def limit(self, *_a):
                return self

            def upsert(self, row, **_k):
                self._row = dict(row)
                return self

            def update(self, patch):
                self._patch = patch
                return self

            def eq(self, _col, val):
                self._id = val
                return self

            def execute(self):
                if name == "notification_preferences":
                    return SimpleNamespace(data=[db.prefs])
                if hasattr(self, "_row"):
                    if any(r["dedupe_key"] == self._row["dedupe_key"] for r in db.rows):
                        return SimpleNamespace(data=[])
                    row = self._row | {"id": f"ev-{len(db.rows) + 1}"}
                    db.rows.append(row)
                    return SimpleNamespace(data=[row])
                row = next(r for r in db.rows if r["id"] == self._id)
                row.update(self._patch)
                return SimpleNamespace(data=[row])

        return _T()


@pytest.fixture
def generation(monkeypatch):
    from backend.nuri_core import dialogue_reply, family_store

    state = {"reply": "睡前的节奏\n最近的睡前节奏辛苦了，想聊聊的时候我一直在。",
             "signals": care.CareSignals(topics=["睡眠"]), "post": POST}

    async def _post(_sb, _uid):
        return state["post"]

    async def _profile(_uid):
        return {"nickname": "小曼吧"}, []

    async def _style():
        return ""

    monkeypatch.setattr(push_service, "_featured_post", _post)
    monkeypatch.setattr(care, "latest_signals", lambda *_a, **_k: state["signals"])
    monkeypatch.setattr(family_store, "load_profile", _profile)
    monkeypatch.setattr(family_store, "profile_ctx", lambda *_a: "")
    monkeypatch.setattr(dialogue_reply, "get_style_rules_ctx", _style)
    monkeypatch.setattr(dialogue_reply, "nuri_reply_sync",
                        lambda *_a, **_k: {"text": state["reply"]})
    return state


@pytest.mark.anyio
async def test_the_post_goes_out_now_as_its_own_notification(generation):
    event = await push_service.generate_post_event(_EventsDb(), "u1", now=NOW)
    assert event["title"] == "群里建议逐步自我安抚"
    assert event["data"] == {"kind": "daily_post", "daily_post_id": "post-1"}
    assert event["scheduled_at"] == NOW.isoformat()
    assert event["route"] == "/notifications/ev-1"
    assert "《群里建议逐步自我安抚》" in event["full_content"]


@pytest.mark.anyio
async def test_no_post_today_means_no_post_notification(generation):
    generation["post"] = None
    assert await push_service.generate_post_event(_EventsDb(), "u1", now=NOW) is None


@pytest.mark.anyio
async def test_care_is_its_own_notification_in_the_evening(generation):
    event = await push_service.generate_care_event(_EventsDb(), "u1", now=NOW)
    assert event["title"] == "睡前的节奏"
    assert event["body"] == "最近的睡前节奏辛苦了，想聊聊的时候我一直在。"
    assert event["data"] == {"kind": "care"}
    # What the conversation shows on a tap is the lock screen's line itself.
    assert event["full_content"] == event["body"]
    # 18:00 in Chicago the same day.
    assert event["scheduled_at"] == datetime(2026, 9, 22, 23, tzinfo=timezone.utc).isoformat()


@pytest.mark.anyio
async def test_an_account_that_never_talked_gets_no_care(generation):
    generation["signals"] = care.CareSignals()
    assert await push_service.generate_care_event(_EventsDb(), "u1", now=NOW) is None


@pytest.mark.anyio
async def test_a_failed_model_still_sends_a_plain_line(generation):
    generation["reply"] = ""
    event = await push_service.generate_care_event(_EventsDb(), "u1", now=NOW)
    assert (event["title"], event["body"]) == care.fallback_message()


@pytest.mark.anyio
async def test_both_go_out_the_same_day_without_replacing_each_other(generation):
    db = _EventsDb()
    post = await push_service.generate_post_event(db, "u1", now=NOW)
    care_event = await push_service.generate_care_event(db, "u1", now=NOW)
    assert post and care_event
    assert post["collapse_id"] != care_event["collapse_id"]
    assert post["dedupe_key"] != care_event["dedupe_key"]


@pytest.mark.anyio
async def test_each_kind_is_sent_once_a_day(generation):
    db = _EventsDb()
    assert await push_service.generate_post_event(db, "u1", now=NOW)
    assert await push_service.generate_care_event(db, "u1", now=NOW)
    assert await push_service.generate_post_event(db, "u1", now=NOW) is None
    assert await push_service.generate_care_event(db, "u1", now=NOW) is None


# ── Opening one ───────────────────────────────────────────────────────────────

class _OpenDb:
    """The notification row, and the chat_messages table the tap writes to."""

    def __init__(self, event: dict):
        self.event = event
        self.messages: dict[str, dict] = {}

    def table(self, name):
        db = self

        class _T:
            def select(self, *_a, **_k):
                return self

            def eq(self, *_a):
                return self

            def limit(self, *_a):
                return self

            def upsert(self, row, **_k):
                self._row = row
                return self

            def execute(self):
                if name == "chat_messages":
                    db.messages.setdefault(self._row["id"], self._row)
                    return SimpleNamespace(data=[])
                return SimpleNamespace(data=[db.event])

        return _T()


def _event(**over):
    return {"id": "ev-1", "user_id": "u1", "type": "follow_up",
            "title": "睡前的节奏", "body": "最近的睡前节奏辛苦了。",
            "data": {"kind": "care"}, "full_content": "最近的睡前节奏辛苦了。"} | over


@pytest.fixture
def opened(monkeypatch):
    from fastapi.testclient import TestClient

    state = {"db": _OpenDb(_event()), "chat_events": []}
    monkeypatch.setattr(main, "_get_supabase", lambda: state["db"])

    async def _session(_body, uid):
        return {"id": f"session-of-{uid}"}

    async def _card(uid, row_id):
        return POST if (uid, row_id) == ("u1", "post-1") else None

    async def _record(uid, row_id, event, **_k):
        state["chat_events"].append((uid, row_id, event))
        return True

    monkeypatch.setattr(main, "start_session", _session)
    monkeypatch.setattr(feed_daily_post, "get_card", _card)
    monkeypatch.setattr(feed_daily_post, "record_event", _record)

    client = TestClient(main.app)

    def tap(uid="u1", notification_id="ev-1"):
        return client.post(f"/api/notifications/{notification_id}/open",
                           headers={"Authorization": f"Bearer {main._make_token(uid)}"})

    state["tap"] = tap
    return state


def test_a_tapped_care_line_is_nuris_own_message(opened):
    response = opened["tap"]()
    assert response.status_code == 200
    assert response.json() == {"session_id": "session-of-u1", "kind": "care"}
    [message] = opened["db"].messages.values()
    assert message["session_id"] == "session-of-u1"
    assert message["role"] == "ai"
    assert message["text"] == "最近的睡前节奏辛苦了。"
    assert message["transition"] is None


def test_a_tapped_post_brings_the_card_and_its_context(opened):
    opened["db"].event = _event(
        title="群里建议逐步自我安抚", body="其他家长的做法：睡前固定流程。",
        data={"kind": "daily_post", "daily_post_id": "post-1"},
        full_content=care.post_intro(POST),
    )
    response = opened["tap"]()
    assert response.json()["kind"] == "daily_post"
    [message] = opened["db"].messages.values()
    assert message["role"] == "ai"
    assert message["text"] == care.post_intro(POST)
    transition = message["transition"]
    # A card marker: the reply path reads the latest one for its context.
    assert transition["kind"] == main.CARD_OPENED
    assert transition["card_id"] == "dailypost:post-1"
    assert "群里建议逐步自我安抚" in transition["context"]
    assert transition["post"]["id"] == "post-1"
    assert transition["post"]["headline"] == "群里建议逐步自我安抚"
    assert opened["chat_events"] == [("u1", "post-1", "chat")]


def test_the_reply_path_takes_its_context_from_that_message(opened):
    opened["db"].event = _event(data={"kind": "daily_post", "daily_post_id": "post-1"})
    opened["tap"]()
    [message] = opened["db"].messages.values()
    turn = SimpleNamespace(msgs=[{"role": "user", "text": "你好"}, message], session={})
    assert main._active_card_id(turn) == "dailypost:post-1"


def test_a_notification_from_before_the_split_keeps_its_care_line(opened):
    """The old combined notification: a care body and a post. Both survive."""
    opened["db"].event = _event(
        body="最近辛苦了，这篇也许用得上。",
        data={"kind": "care", "daily_post_id": "post-1"},
        full_content="最近辛苦了，这篇也许用得上。\n\n《群里建议逐步自我安抚》\n睡前固定流程",
    )
    opened["tap"]()
    [message] = opened["db"].messages.values()
    assert message["text"] == "最近辛苦了，这篇也许用得上。"
    assert message["transition"]["post"]["id"] == "post-1"


def test_a_second_tap_adds_nothing(opened):
    opened["tap"]()
    opened["tap"]()
    assert len(opened["db"].messages) == 1


def test_someone_elses_notification_is_a_404(opened):
    response = opened["tap"](uid="u2")
    assert response.status_code == 404
    assert opened["db"].messages == {}


def test_someone_elses_post_is_a_404(monkeypatch):
    from fastapi.testclient import TestClient

    async def _card(_uid, _row_id):
        return None
    monkeypatch.setattr(feed_daily_post, "get_card", _card)
    response = TestClient(main.app).get(
        "/api/feed/daily-post/post-1",
        headers={"Authorization": f"Bearer {main._make_token('u2')}"},
    )
    assert response.status_code == 404
