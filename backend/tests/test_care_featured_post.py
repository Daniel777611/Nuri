"""The care notification led by the parent's daily featured post.

What changed from the card-only version, and what each test pins:

* the title is the featured post's headline, and the model writes only the
  body — so a model that drifts into writing a title cannot replace it;
* a parent with no recent chat still gets a notification, as a plain hello
  that does not pretend to know what they are dealing with;
* the notification names its post by id, and opening it returns that post
  even after the parent's day has turned over.
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
    "headline": "群里建议逐步自我安抚",
    "takeaways": ["睡前固定流程", "逐步拉长等待时间", "白天多安抚"],
    "source_label": "Facebook 家长群",
}
NOW = datetime(2026, 9, 22, 15, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── Composition ───────────────────────────────────────────────────────────────

def test_with_a_post_the_model_writes_only_the_body():
    prompt = care.build_prompt(care.CareSignals(topics=["睡眠"]), None, post=POST)
    assert "群里建议逐步自我安抚" in prompt
    assert "只输出一行正文" in prompt
    assert "输出两行" not in prompt


def test_without_recent_chat_the_prompt_asks_for_a_plain_hello():
    prompt = care.build_prompt(care.CareSignals(), None, post=POST)
    assert "没有和 NURI 聊天" in prompt
    assert "最近和 NURI 聊到的主题" not in prompt


def test_the_lock_screen_rules_survive_the_post_variant():
    prompt = care.build_prompt(care.CareSignals(topics=["睡眠"]), None, post=POST)
    assert "孩子的名字" in prompt and "家长说过的原话" in prompt


def test_the_body_parser_takes_one_line_and_strips_labels():
    assert care.parse_body("正文：最近辛苦了，这篇也许用得上。") == "最近辛苦了，这篇也许用得上。"
    assert care.parse_body("") == ""


def test_the_payload_names_the_post_and_nothing_private():
    message = care.CareMessage(title="t", body="b", full_content="f", card=None,
                               keywords=["睡眠"], post=POST)
    assert message.payload_data() == {"kind": "care", "daily_post_id": "post-1"}


def test_the_opened_text_carries_the_post_after_the_note():
    full = care.compose_full_content("最近辛苦了", None, POST)
    note, rest = full.split("\n\n", 1)
    assert note == "最近辛苦了"
    assert "《群里建议逐步自我安抚》" in rest


def test_the_fallback_keeps_the_headline_as_title():
    title, body = care.fallback_message(None, POST)
    assert title == "群里建议逐步自我安抚"
    assert body


# ── Generation ────────────────────────────────────────────────────────────────

class _EventsDb:
    """Enough of PostgREST for generate_care_event's writes."""

    def __init__(self):
        self.rows: list[dict] = []

    def table(self, name):
        db = self

        class _T:
            def upsert(self, row, **_k):
                self._row = dict(row) | {"id": "ev-1"}
                return self

            def update(self, patch):
                self._patch = patch
                return self

            def eq(self, *_a):
                return self

            def execute(self):
                if hasattr(self, "_row"):
                    db.rows.append(self._row)
                    return SimpleNamespace(data=[self._row])
                db.rows[-1].update(self._patch)
                return SimpleNamespace(data=[db.rows[-1]])

        return _T()


@pytest.fixture
def generation(monkeypatch):
    from backend.nuri_core import dialogue_reply, family_store

    state = {"reply": "最近辛苦了，这篇也许用得上。", "signals": care.CareSignals(), "post": POST}

    async def _post(_sb, _uid):
        return state["post"]

    async def _profile(_uid):
        return {"nickname": "小曼吧"}, []

    async def _style():
        return ""

    monkeypatch.setattr(push_service, "_featured_post", _post)
    monkeypatch.setattr(care, "gather_signals", lambda *_a, **_k: state["signals"])
    monkeypatch.setattr(family_store, "load_profile", _profile)
    monkeypatch.setattr(family_store, "profile_ctx", lambda *_a: "")
    monkeypatch.setattr(dialogue_reply, "get_style_rules_ctx", _style)
    monkeypatch.setattr(dialogue_reply, "nuri_reply_sync",
                        lambda *_a, **_k: {"text": state["reply"]})
    return state


@pytest.mark.anyio
async def test_a_parent_with_no_recent_chat_still_gets_one(generation):
    db = _EventsDb()
    event = await push_service.generate_care_event(db, "u1", now=NOW)
    assert event is not None
    assert event["title"] == "群里建议逐步自我安抚"
    assert event["body"] == "最近辛苦了，这篇也许用得上。"
    assert event["data"] == {"kind": "care", "daily_post_id": "post-1"}
    assert event["route"] == "/notifications/ev-1"


@pytest.mark.anyio
async def test_a_model_that_writes_a_title_cannot_replace_the_headline(generation):
    generation["reply"] = "别的标题\n最近辛苦了。"
    event = await push_service.generate_care_event(_EventsDb(), "u1", now=NOW)
    assert event["title"] == "群里建议逐步自我安抚"


@pytest.mark.anyio
async def test_without_a_post_it_falls_back_to_the_card_version(generation):
    generation["post"] = None
    generation["reply"] = "标题一行\n正文一行"
    event = await push_service.generate_care_event(_EventsDb(), "u1", now=NOW)
    assert event["title"] == "标题一行"
    assert "daily_post_id" not in event["data"]


def test_one_notification_per_day_whatever_it_carries():
    assert care.dedupe_key("u1", "2026-09-22") == care.dedupe_key("u1", "2026-09-22")
    assert care.dedupe_key("u1", "2026-09-22") != care.dedupe_key("u1", "2026-09-23")


# ── Opening it ────────────────────────────────────────────────────────────────

class _NotificationDb:
    def __init__(self, row):
        self.row = row

    def table(self, _name):
        row = self.row

        class _T:
            def select(self, *_a):
                return self

            def eq(self, *_a):
                return self

            def limit(self, *_a):
                return self

            def execute(self):
                return SimpleNamespace(data=[row])

        return _T()


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    return TestClient(main.app)


def test_the_opened_notification_points_at_its_own_post(client, monkeypatch):
    row = {"id": "ev-1", "user_id": "u1", "type": "follow_up", "title": "t", "body": "b",
           "route": "/notifications/ev-1", "data": {"kind": "care", "daily_post_id": "post-1"},
           "full_content": "最近辛苦了\n\n《群里建议逐步自我安抚》", "created_at": None}
    monkeypatch.setattr(main, "_get_supabase", lambda: _NotificationDb(row))

    async def _card(uid, row_id):
        return POST if (uid, row_id) == ("u1", "post-1") else None
    monkeypatch.setattr(feed_daily_post, "get_card", _card)

    response = client.get("/api/notifications/ev-1",
                          headers={"Authorization": f"Bearer {main._make_token('u1')}"})
    assert response.status_code == 200
    target = response.json()["target"]
    assert target["kind"] == "daily_post"
    assert target["route"] == "/daily-post?id=post-1"
    assert target["title"] == "群里建议逐步自我安抚"


def test_someone_elses_post_is_a_404(client, monkeypatch):
    async def _card(_uid, _row_id):
        return None
    monkeypatch.setattr(feed_daily_post, "get_card", _card)
    response = client.get("/api/feed/daily-post/post-1",
                          headers={"Authorization": f"Bearer {main._make_token('u2')}"})
    assert response.status_code == 404
