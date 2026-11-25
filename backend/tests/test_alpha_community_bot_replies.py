"""Alpha bottle replies use owned deliveries and ordinary Community writes."""

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from backend import alpha_community_bots as bots, community, runtime
from backend.tests.community_fakes import FakeDB, Query


NOW = datetime(2026, 11, 25, 17, tzinfo=timezone.utc)
PERSONAS = {"bot-en": {"language": "en"}, "bot-zh": {"language": "zh-TW"}}
ELIGIBLE = list(PERSONAS)


class ReplyQuery(Query):
    def select(self, columns="*", **_kwargs):
        self.join_bottle = "bottle:community_questions!inner(" in columns
        return self

    def in_(self, key, values):
        if key == "prior_bot.author_id":
            self.prior_bot_authors = set(values)
            return self
        return super().in_(key, values)

    @property
    def not_(self):
        return SimpleNamespace(in_=lambda key, values: self._f(lambda row: row.get(key) not in values))

    def _hits(self, rows):
        if getattr(self, "join_bottle", False):
            questions = {q["id"]: q for q in self.db.rows("community_questions")}
            rows = [
                {**row, "bottle": bottle, **{f"bottle.{key}": value for key, value in bottle.items()}}
                for row in rows if (bottle := questions.get(row["question_id"]))
            ]
        if hasattr(self, "prior_bot_authors"):
            by_bot = {r["question_id"] for r in self.db.rows("community_replies")
                      if r["author_id"] in self.prior_bot_authors}
            rows = [{**row, "prior_bot": True if row["id"] in by_bot else None} for row in rows]
        return super()._hits(rows)


class ReplyDB(FakeDB):
    def table(self, name):
        return ReplyQuery(self, name)


@pytest.fixture
def world(monkeypatch):
    db = ReplyDB()
    notifications = []
    generated = []
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    for uid in ["asker", "human-replier", *PERSONAS]:
        db.table("community_profiles").insert({"user_id": uid, "display_name": uid}).execute()

    async def write(uid, _person, _task, **data):
        generated.append((uid, data["question"]))
        return "Synthetic test response."

    async def notify(uid, kind, business_id, target, **_kwargs):
        notifications.append((uid, kind, business_id, target["question_id"]))

    monkeypatch.setattr(bots, "write_as", write)
    monkeypatch.setattr(community, "_notify", notify)

    def ask(key, *, uid="asker", status="open", age=timedelta(hours=2), lang="zh-TW"):
        return db.table("community_questions").insert({
            "author_id": uid, "body": key, "status": status, "original_language": lang,
            "client_request_id": key, "created_at": (NOW - age).isoformat(),
        }).execute().data[0]

    def deliver(question, uid, *, state="waiting", expires=None):
        return db.table("community_question_deliveries").insert({
            "question_id": question["id"], "recipient_id": uid, "state": state,
            "expires_at": (expires or NOW + timedelta(days=3)).isoformat(),
        }).execute().data[0]

    def tick(*, human_first=True):
        return asyncio.run(bots.reply_to_delivery(ELIGIBLE, PERSONAS, NOW, human_first=human_first))

    return SimpleNamespace(db=db, ask=ask, deliver=deliver, tick=tick,
                           generated=generated, notifications=notifications)


def test_human_reply_keeps_bottle_eligible_and_fallback_is_once(world, monkeypatch):
    monkeypatch.setattr(community, "_now", lambda: NOW)
    question = world.ask("human bottling question")
    human_delivery = world.deliver(question, "human-replier")
    asyncio.run(community.respond("human-replier", human_delivery["id"], community.ResponseIn(
        body="Real parent fixture answer", language="zh-TW", client_request_id="human-answer-fixture",
    )))
    world.notifications.clear()

    assert world.tick() == ("bot-zh", True)
    assert world.tick() is None
    replies = world.db.rows("community_replies")
    assert {item["author_id"] for item in replies} == {"human-replier", "bot-zh"}
    assert [item["recipient_id"] for item in world.db.rows("community_question_deliveries")] == [
        "human-replier", "bot-zh",
    ]
    assert [notice[:2] for notice in world.notifications] == [("asker", "community_reply")]
    assert world.generated == [("bot-zh", question["body"])]


def test_existing_waiting_delivery_is_reused_without_adding_fallback(world, monkeypatch):
    monkeypatch.setattr(community, "_now", lambda: NOW)
    question = world.ask("previously matched")
    first = world.deliver(question, "bot-en")
    world.deliver(question, "bot-zh")
    assert world.tick() == ("bot-zh", True)
    assert world.tick() is None
    by_uid = {r["recipient_id"]: r for r in world.db.rows("community_question_deliveries")}
    assert len(by_uid) == 2 and by_uid["bot-en"]["id"] == first["id"]
    assert by_uid["bot-en"]["state"] == "waiting"
    assert by_uid["bot-zh"]["state"] == "replied"


def test_stale_closed_and_expired_matches_are_not_reopened(world):
    world.ask("stale", age=timedelta(days=8))
    world.ask("closed", status="closed")
    expired = world.ask("previously matched but expired")
    world.deliver(expired, "bot-en", expires=NOW - timedelta(seconds=1))
    assert world.tick() is None
    assert len(world.db.rows("community_question_deliveries")) == 1
    assert not world.generated and not world.notifications


def test_hidden_authors_and_hidden_or_blocked_bots_are_skipped(world):
    world.db.table("community_profiles").insert({"user_id": "hidden-author"}).execute()
    for uid in ("hidden-author", "bot-en"):
        world.db.table("community_preferences").insert({"user_id": uid, "profile_hidden": True}).execute()
    world.ask("private author", uid="hidden-author")
    world.ask("blocked recipient")
    world.db.table("community_blocks").insert({"blocker_id": "bot-zh", "blocked_id": "asker"}).execute()
    assert world.tick() is None
    assert not world.db.rows("community_question_deliveries")
    assert not world.generated


@pytest.mark.parametrize("blocked", [False, True])
def test_hidden_author_only_gets_a_reply_to_an_already_shared_bottle(world, monkeypatch, blocked):
    monkeypatch.setattr(community, "_now", lambda: NOW)
    world.db.table("community_preferences").insert({"user_id": "asker", "profile_hidden": True}).execute()
    world.ask("never shared", age=timedelta(days=2))
    shared = world.ask("already shared and answered")
    previous = world.deliver(shared, "human-replier")
    asyncio.run(community.respond("human-replier", previous["id"], community.ResponseIn(
        body="First ordinary fixture answer", language="zh-TW", client_request_id="hidden-share-fixture",
    )))
    if blocked:
        world.db.table("community_blocks").insert({"blocker_id": "asker", "blocked_id": "bot-zh"}).execute()
        world.db.table("community_blocks").insert({"blocker_id": "bot-en", "blocked_id": "asker"}).execute()
    assert world.tick() == (None if blocked else ("bot-zh", True))
    assert len(world.db.rows("community_question_deliveries")) == (1 if blocked else 2)
    assert all(row["question_id"] == shared["id"] for row in world.db.rows("community_question_deliveries"))
    assert world.db.rows("community_preferences")[0]["profile_hidden"]


def test_an_unmatched_bottle_at_publish_time_waits_for_original_delivery(world):
    world.ask("just published", age=timedelta(minutes=3))
    assert world.tick() is None and not world.db.rows("community_question_deliveries")


def test_each_class_gets_its_own_queue_and_fifo_attempts(world, monkeypatch):
    monkeypatch.setattr(community, "_now", lambda: NOW)
    oldest = world.ask("oldest human", age=timedelta(days=4))
    next_human = world.ask("second human", age=timedelta(days=3))
    synthetic = world.ask("existing synthetic match", uid="bot-zh", lang="en")
    world.deliver(synthetic, "bot-en")
    world.ask("synthetic without delivery", uid="bot-en")

    assert world.tick(human_first=False) == ("bot-en", False)
    assert world.tick() == ("bot-zh", True)
    assert world.tick() == ("bot-zh", True)
    assert world.tick(human_first=False) is None
    assert [item["question_id"] for item in world.db.rows("community_replies")] == [
        synthetic["id"], oldest["id"], next_human["id"],
    ]


def test_waiting_bot_match_is_found_after_exhausted_or_human_delivery_backlog(world, monkeypatch):
    monkeypatch.setattr(community, "_now", lambda: NOW)
    for index in range(65):
        exhausted = world.ask(f"synthetic already answered {index}", uid="bot-en")
        world.deliver(exhausted, "bot-zh", state="replied")
        human = world.ask(f"old human match {index}")
        world.deliver(human, "bot-zh")
    waiting = world.ask("real waiting bot match", uid="bot-zh")
    world.deliver(waiting, "bot-en")
    assert world.tick(human_first=False) == ("bot-en", False)
    assert [reply["question_id"] for reply in world.db.rows("community_replies")] == [waiting["id"]]


def test_human_bottle_is_found_after_many_previous_bot_answers(world, monkeypatch):
    monkeypatch.setattr(community, "_now", lambda: NOW)
    for index in range(65):
        seen = world.ask(f"human bottle with an earlier bot answer {index}")
        delivery = world.deliver(seen, "bot-en", state="replied")
        world.db.table("community_replies").insert({
            "question_id": seen["id"], "delivery_id": delivery["id"], "author_id": "bot-en",
            "client_request_id": f"old-auto-reply-{index}",
        }).execute()
    waiting = world.ask("previously unanswered")
    assert world.tick() == ("bot-zh", True)
    assert world.db.rows("community_replies")[-1]["question_id"] == waiting["id"]


def test_row_conflict_can_continue_but_storage_failure_is_reported(world, monkeypatch):
    monkeypatch.setattr(community, "_now", lambda: NOW)
    first = world.ask("row changed")
    second = world.ask("another human bottle")
    actual_respond = community.respond

    async def conflict(uid, delivery, body):
        row = next(item for item in world.db.rows("community_question_deliveries") if item["id"] == delivery)
        if row["question_id"] == first["id"]:
            raise community.CommunityError("VERSION_CONFLICT", "Fixture changed")
        return await actual_respond(uid, delivery, body)

    monkeypatch.setattr(community, "respond", conflict)
    assert world.tick() == ("bot-zh", True)
    assert [item["question_id"] for item in world.db.rows("community_replies")] == [second["id"]]
    assert len(world.db.rows("community_question_deliveries")) == 2

    async def failed(*_args):
        raise community.CommunityError("STORAGE_OR_SERVICE_UNAVAILABLE", "Fixture unavailable")

    monkeypatch.setattr(community, "respond", failed)
    with pytest.raises(community.CommunityError) as out:
        world.tick()
    assert out.value.error_code == "STORAGE_OR_SERVICE_UNAVAILABLE"
    assert len(world.db.rows("community_question_deliveries")) == 2
