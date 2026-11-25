import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend import alpha_community_bots as bots, community, runtime
from backend.tests.community_fakes import FakeDB


NOW = datetime(2026, 11, 25, 18, 0, tzinfo=timezone.utc)
PERSONAS = {
    "active": {"slug": "active", "activity": "high", "language": "en", "timeZone": "America/Chicago"},
    "quiet": {"slug": "quiet", "activity": "low", "language": "en", "timeZone": "America/Chicago"},
}


def test_scheduler_uses_simulated_availability_and_per_person_spacing(monkeypatch):
    monkeypatch.setattr(bots.routines, "participates", lambda *_args, **_kwargs: True)
    previous = int((NOW - timedelta(minutes=30)).timestamp())
    recent = {uid: previous for uid in PERSONAS}
    awake = {uid: object() for uid in PERSONAS}
    assert bots.eligible_parents(PERSONAS, recent, awake, NOW, action="replies") == ["active"]
    assert bots.eligible_parents(PERSONAS, {}, {"quiet": awake["quiet"]}, NOW, action="replies") == ["quiet"]
    assert bots.eligible_parents(PERSONAS, {}, {}, NOW, action="replies") == []


@pytest.mark.anyio
async def test_publish_respects_personal_and_community_caps_without_a_global_posting_slot(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    calls = []

    async def write_as(uid, *_args, **_kwargs):
        calls.append(("write", uid))
        return "What's a quick game you play on a rainy afternoon?"

    async def create(uid, question, *, verified_bot_ids):
        calls.append(("publish", uid, set(verified_bot_ids), question.original_language))
        return {"created": True}

    monkeypatch.setattr(bots, "write_as", write_as)
    monkeypatch.setattr(community, "create_question", create)
    questions = db.rows("community_questions")
    questions.extend([
        {"id": "older", "author_id": "active", "created_at": (NOW - timedelta(hours=2)).isoformat()},
        {"id": "newest", "author_id": "active", "created_at": (NOW - timedelta(minutes=10)).isoformat()},
    ])
    assert await bots.publish_question(list(PERSONAS), PERSONAS, NOW) == "quiet"
    assert calls == [("write", "quiet"), ("publish", "quiet", set(PERSONAS), "en")]

    questions.extend([
        {"id": f"older-{i}", "author_id": "active", "created_at": (NOW - timedelta(hours=3)).isoformat()}
        for i in range(bots.DAILY_QUESTION_LIMIT)
    ])
    assert await bots.publish_question(list(PERSONAS), PERSONAS, NOW) is None
    assert len(calls) == 2


@pytest.mark.anyio
async def test_tick_reports_reply_cohort_and_leaves_one_slot_for_bot_threads(monkeypatch):
    db = FakeDB()
    db.rows(bots.TABLE).append({
        "id": 1, "enabled": True, "last_started_at": (NOW - timedelta(minutes=10)).isoformat(),
        "last_activity": {},
    })
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)

    class Clock(datetime):
        instant = NOW

        @classmethod
        def now(cls, tz=None):
            return cls.instant.astimezone(tz)

    monkeypatch.setattr(bots, "datetime", Clock)

    async def authorize(_authorization):
        return dict(db.rows(bots.TABLE)[0])

    async def personas():
        return PERSONAS

    priorities = []

    async def reply(_eligible, _personas, _now, *, human_first):
        priorities.append(human_first)
        return "active", human_first

    async def skip(*_args):
        return None

    monkeypatch.setattr(bots, "authorize_scheduler", authorize)
    monkeypatch.setattr(bots, "verified_personas", personas)
    monkeypatch.setattr(bots.routines, "load_routines", lambda: {uid: object() for uid in PERSONAS})
    monkeypatch.setattr(bots.routines, "current_scene", lambda *_args: object())
    monkeypatch.setattr(bots.routines, "participates", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(bots, "reply_to_delivery", reply)
    monkeypatch.setattr(bots, "publish_question", skip)
    monkeypatch.setattr(bots, "continue_thread", skip)

    results = []
    for offset in (0, 10, 20):
        Clock.instant = NOW + timedelta(minutes=offset)
        results.append(await bots.tick(None))
    assert priorities.count(True) == 2
    assert priorities.count(False) == 1
    assert sum(result["human_replies"] for result in results) == 2
    assert sum(result["bot_replies"] for result in results) == 1
    assert all(result["replies"] == 1 and result["errors"] == 0 for result in results)
    assert all(result["routine_profiles"] == 2 and result["available_scenes"] == 2 for result in results)


@pytest.mark.anyio
async def test_writer_gets_an_individual_local_scene_and_can_pass(monkeypatch):
    calls = []
    scene = SimpleNamespace(
        story="The family shares daycare pickup and the parents alternate early shifts.",
        local_date="2026-11-25", weekday="Wednesday", local_hour=12, kind="transition",
        description="Morning shift is over and school pickup is an hour away.",
        moment="Wondering what to take to the park after pickup.",
    )
    monkeypatch.setattr(bots.routines, "load_routines", lambda: {"active": object()})
    monkeypatch.setattr(bots.routines, "current_scene", lambda *_args: scene)

    async def complete(_site, _uid, system, payload):
        calls.append((system, json.loads(payload)))
        return "[SKIP]"

    monkeypatch.setattr(community, "_complete", complete)
    assert await bots.write_as("active", PERSONAS["active"], "Reply", now=NOW, question="A sample") is None
    system, payload = calls[0]
    assert "[SKIP]" in system
    assert payload["local_moment"]["family_story"] == scene.story
    assert payload["local_moment"]["current_activity"] == scene.description
    assert payload["local_moment"]["something_on_their_mind"] == scene.moment
    assert payload["question"] == "A sample"

    monkeypatch.setattr(bots.routines, "current_scene", lambda *_args: None)
    assert await bots.write_as("active", PERSONAS["active"], "Reply", now=NOW) is None
    assert len(calls) == 1
