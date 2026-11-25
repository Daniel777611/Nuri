from datetime import datetime, timedelta, timezone

import pytest

from backend import community, runtime
from backend.alpha_community_seed import ABOUT_PREFIX
from backend.tests.community_fakes import FakeDB, Query


NOW = datetime(2026, 11, 25, 18, 0, tzinfo=timezone.utc)
AUTHOR = "bot-author"
BOTS = {f"bot-{index}" for index in range(5)}
VERIFIED = BOTS | {AUTHOR}
RECENT_FIELDS = "recipient_id,community_questions!inner(author_id)"


class MatchingQuery(Query):
    fields = "*"

    def select(self, fields="*"):
        self.fields = fields
        return self

    def _hits(self, rows):
        if self.fields == RECENT_FIELDS:
            if self.db.cooldown_unavailable:
                raise RuntimeError("cooldown unavailable")
            authors = {row["id"]: row["author_id"] for row in self.db.rows("community_questions")}
            rows = [
                {**row, "community_questions.author_id": authors[row["question_id"]]}
                for row in rows if row["question_id"] in authors
            ]
        return super()._hits(rows)

    def execute(self):
        result = super().execute()
        if self.op == "select":
            self.db.reads.append((self.table, self.fields, set()))
            if self.table in {"users", "children", "community_profiles"}:
                self.db.reads[-1][2].update(row.get("user_id", row.get("id")) for row in result.data)
        return result


class MatchingDB(FakeDB):
    real_time = False
    cooldown_unavailable = False

    def __init__(self):
        super().__init__()
        self._clock = NOW
        self.reads = []

    def table(self, name):
        return MatchingQuery(self, name)


@pytest.fixture
def matching(monkeypatch):
    db = MatchingDB()
    real_accounts = {"available", "recent", "hidden", "blocked", "elsewhere", "unverified-bot"}
    for uid in sorted(VERIFIED | real_accounts):
        db.rows("users").append({"id": uid, "city": "Chicago", "top_concerns": ["sleep"]})
        db.rows("children").append({"user_id": uid, "birth_date": "2024-06-01"})
        db.rows("community_profiles").append({
            "user_id": uid, "public_id": uid, "display_name": uid,
            "city_label": "Austin" if uid == "elsewhere" else "Chicago",
            "about": ABOUT_PREFIX if uid in VERIFIED or uid == "unverified-bot" else "",
        })
        db.rows("community_preferences").append({
            "user_id": uid, "profile_hidden": uid == "hidden",
            "parent_message_notifications_enabled": uid == "recent",
        })
    db.rows("community_blocks").append({"blocker_id": "blocked", "blocked_id": AUTHOR})
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(runtime, "alpha_features_available", lambda: True)
    monkeypatch.setattr(community, "_now", lambda: NOW)
    monkeypatch.setattr(community, "DELIVERY_FANOUT", 5)
    rank_inputs = []

    async def rank(_question, shortlist, _features, _asker):
        rank_inputs.append(set(shortlist))
        return shortlist

    monkeypatch.setattr(community, "_ai_rank", rank)
    return db, rank_inputs


def past_delivery(db, name, author, recipient, hours):
    db.rows("community_questions").append({
        "id": name, "author_id": author, "created_at": (NOW - timedelta(days=2)).isoformat(),
    })
    db.rows("community_question_deliveries").append({
        "question_id": name, "recipient_id": recipient, "state": "replied",
        "created_at": (NOW - timedelta(hours=hours)).isoformat(),
    })


async def publish(db, **kwargs):
    question = community.QuestionIn(body="Which playground do you like?", client_request_id="matching-0001",
                                    original_language="en", anonymous=True)
    result = await community.create_question(AUTHOR, question, **kwargs)
    question_id = result["question"]["question_id"]
    deliveries = [row for row in db.rows("community_question_deliveries") if row["question_id"] == question_id]
    assert result["delivery"] == {"recipient_count": len(deliveries), "state": "delivered"}
    assert all(row["state"] == "waiting" for row in deliveries)
    assert all(community._parse_ts(row["expires_at"]) == NOW + timedelta(days=community.DELIVERY_TTL_DAYS)
               for row in deliveries)
    return {row["recipient_id"] for row in deliveries}


@pytest.mark.anyio
async def test_synthetic_question_reserves_one_public_fit_without_reading_private_profiles(matching):
    db, rank_inputs = matching
    past_delivery(db, "prior-synthetic", "bot-0", "recent", hours=6)
    past_delivery(db, "expired-cooldown", "bot-1", "available", hours=7)
    past_delivery(db, "human-question", "recent", "available", hours=2)

    recipients = await publish(db, verified_bot_ids=VERIFIED)

    assert recipients - BOTS == {"available"}
    assert len(recipients & BOTS) == 4
    assert rank_inputs == [BOTS]
    assert not db.rows("notification_events")  # The selected real recipient opted out.
    assert any(fields == RECENT_FIELDS for _, fields, _ in db.reads)
    assert all(ids <= VERIFIED for table, _, ids in db.reads if table in {"users", "children"})
    assert all(not ids & {"hidden", "blocked"} for table, fields, ids in db.reads
               if table == "community_profiles" and fields != "user_id")


@pytest.mark.anyio
@pytest.mark.parametrize("read_failure", [False, True])
async def test_synthetic_question_uses_all_bot_slots_if_real_cooldown_cannot_clear(matching, read_failure):
    db, _ = matching
    if read_failure:
        db.cooldown_unavailable = True
    else:
        past_delivery(db, "prior-synthetic-a", "bot-0", "available", hours=1)
        past_delivery(db, "prior-synthetic-b", "bot-1", "recent", hours=5)

    assert await publish(db, verified_bot_ids=VERIFIED) == BOTS


@pytest.mark.anyio
@pytest.mark.parametrize("alpha, supplied", [(True, False), (False, True)])
async def test_standard_matching_stays_active_without_both_alpha_and_verified_author(matching, monkeypatch,
                                                                                   alpha, supplied):
    db, rank_inputs = matching
    monkeypatch.setattr(runtime, "alpha_features_available", lambda: alpha)

    await publish(db, **({"verified_bot_ids": VERIFIED} if supplied else {}))

    assert "available" in rank_inputs[0]
    assert not any(fields == RECENT_FIELDS for _, fields, _ in db.reads)
