from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend import main, stores


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.orders, self.limit_count = [], [], None
        self.operation, self.payload = "select", None

    def select(self, *_args): return self
    def eq(self, key, value): self.filters.append(lambda row: row.get(key) == value); return self
    def in_(self, key, values): self.filters.append(lambda row: row.get(key) in set(values)); return self
    def gte(self, key, value): self.filters.append(lambda row: str(row.get(key) or "") >= str(value)); return self
    def order(self, key, desc=False): self.orders.append((key, desc)); return self
    def limit(self, count): self.limit_count = count; return self
    def update(self, payload): self.operation, self.payload = "update", dict(payload); return self
    def upsert(self, payload, on_conflict=None):
        self.operation, self.payload, self.conflict = "upsert", dict(payload), on_conflict
        return self

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        hits = [row for row in rows if all(predicate(row) for predicate in self.filters)]
        if self.operation == "upsert":
            existing = next((row for row in rows if row.get("user_id") == self.payload["user_id"]
                             and row.get("message_id") == self.payload["message_id"]), None)
            if existing:
                existing.update(self.payload)
            else:
                rows.append(dict(self.payload)); existing = rows[-1]
            return SimpleNamespace(data=[dict(existing)])
        if self.operation == "update":
            for row in hits: row.update(self.payload)
            return SimpleNamespace(data=[dict(row) for row in hits])
        for key, desc in reversed(self.orders):
            hits.sort(key=lambda row: str(row.get(key) or ""), reverse=desc)
        if self.limit_count is not None: hits = hits[: self.limit_count]
        return SimpleNamespace(data=[dict(row) for row in hits])


class Database:
    def __init__(self):
        self.tables = {
            "chat_sessions": [{"id": "s1", "user_id": "u1", "created_at": "2026-09-22T10:00:00Z"}],
            "chat_messages": [
                {"id": "q1", "session_id": "s1", "role": "user", "text": "help", "created_at": "2026-09-22T10:00:01Z"},
                {"id": "a1", "session_id": "s1", "role": "ai", "text": "answer", "created_at": "2026-09-22T10:00:02Z", "transition": None},
            ],
            "chat_message_feedback": [],
            "users": [{"id": "u1", "email": "parent@example.test", "nickname": "Parent"}],
        }

    def table(self, name): return Query(self, name)


def setup_feedback(monkeypatch, *, allow_training=True):
    db = Database()
    monkeypatch.setattr(main, "_require_chat_storage", lambda: db)
    monkeypatch.setattr(main, "_get_supabase", lambda: db)

    async def privacy(_uid, fail_closed=True):
        assert fail_closed is True
        return {"allow_history_training": allow_training}

    monkeypatch.setattr(stores, "get_privacy", privacy)
    return db


def test_feedback_is_idempotent_and_switches_one_row(monkeypatch):
    db = setup_feedback(monkeypatch)
    first = asyncio.run(main.set_chat_message_feedback(
        "s1", "a1", main.ChatMessageFeedbackIn(rating="like"), "u1"))
    second = asyncio.run(main.set_chat_message_feedback(
        "s1", "a1", main.ChatMessageFeedbackIn(rating="dislike"), "u1"))
    assert first["rating"] == "like"
    assert second["rating"] == "dislike"
    assert len(db.tables["chat_message_feedback"]) == 1
    assert db.tables["chat_message_feedback"][0]["source_user_message_id"] == "q1"
    assert db.tables["chat_message_feedback"][0]["review_status"] == "pending"


def test_feedback_rejects_user_messages(monkeypatch):
    setup_feedback(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.set_chat_message_feedback(
            "s1", "q1", main.ChatMessageFeedbackIn(rating="like"), "u1"))
    assert exc.value.status_code == 404


def test_feedback_enforces_session_ownership(monkeypatch):
    setup_feedback(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.set_chat_message_feedback(
            "s1", "a1", main.ChatMessageFeedbackIn(rating="like"), "someone-else"))
    assert exc.value.status_code == 404


def test_training_candidate_requires_privacy_permission(monkeypatch):
    db = setup_feedback(monkeypatch, allow_training=False)
    result = asyncio.run(main.set_chat_message_feedback(
        "s1", "a1", main.ChatMessageFeedbackIn(rating="like"), "u1"))
    assert result["training_eligible"] is False
    assert db.tables["chat_message_feedback"][0]["training_eligible"] is False


def test_history_rehydrates_saved_rating(monkeypatch):
    db = setup_feedback(monkeypatch)
    db.tables["chat_message_feedback"] = [{"user_id": "u1", "message_id": "a1", "rating": "like"}]

    async def no_recovery(*_args, **_kwargs): return None
    monkeypatch.setattr(main, "_memory_recovery_message", no_recovery)
    history = asyncio.run(main.get_messages("s1", "u1"))
    answer = next(row for row in history if row["id"] == "a1")
    assert answer["feedback_rating"] == "like"


def test_admin_review_queue_joins_prompt_and_response(monkeypatch):
    setup_feedback(monkeypatch)
    asyncio.run(main.set_chat_message_feedback(
        "s1", "a1", main.ChatMessageFeedbackIn(rating="dislike"), "u1"))
    report = asyncio.run(main.admin_chat_feedback(days=30, rating=None, limit=100, _=None))
    assert report["totals"] == {"all": 1, "like": 0, "dislike": 1, "training_eligible": 1}
    assert report["rows"][0]["prompt"] == "help"
    assert report["rows"][0]["response"] == "answer"
    assert report["rows"][0]["review_status"] == "pending"
