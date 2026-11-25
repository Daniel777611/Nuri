from datetime import datetime, timedelta, timezone

import pytest

from backend import alpha_community_bots as bots, community, runtime
from backend.tests.community_fakes import FakeDB


NOW = datetime(2026, 11, 25, 18, 0, tzinfo=timezone.utc)
PERSONAS = {
    "active": {"activity": "high", "language": "en", "timeZone": "America/Chicago"},
    "quiet": {"activity": "low", "language": "en", "timeZone": "America/Chicago"},
}


def test_reply_cooldowns_allow_active_parents_to_reply_sooner_and_keep_quiet_hours():
    previous = int((NOW - timedelta(minutes=30)).timestamp())
    recent = {uid: previous for uid in PERSONAS}
    assert bots.eligible_parents(PERSONAS, recent, NOW, action="replies") == ["active"]
    assert bots.eligible_parents(PERSONAS, {}, NOW + timedelta(hours=12), action="replies") == []


@pytest.mark.anyio
async def test_publish_respects_pool_gap_daily_cap_and_routes_verified_bots(monkeypatch):
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
    assert await bots.publish_question(list(PERSONAS), PERSONAS, NOW) is None
    assert calls == []
    assert await bots.publish_question(list(PERSONAS), PERSONAS, NOW + timedelta(minutes=20)) == "quiet"
    assert calls == [("write", "quiet"), ("publish", "quiet", set(PERSONAS), "en")]

    questions.extend([
        {"id": f"older-{i}", "author_id": "active", "created_at": (NOW - timedelta(hours=3)).isoformat()}
        for i in range(bots.DAILY_QUESTION_LIMIT)
    ])
    assert await bots.publish_question(list(PERSONAS), PERSONAS, NOW + timedelta(minutes=20)) is None
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
