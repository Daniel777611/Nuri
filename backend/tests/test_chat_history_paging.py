from __future__ import annotations

import asyncio
from types import SimpleNamespace

from backend import main


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.orders, self.limit_count = [], [], None

    def select(self, *_args): return self
    def eq(self, key, value): self.filters.append(lambda row: row.get(key) == value); return self
    def in_(self, key, values): self.filters.append(lambda row: row.get(key) in set(values)); return self
    def lt(self, key, value): self.filters.append(lambda row: str(row.get(key) or "") < str(value)); return self
    def order(self, key, desc=False): self.orders.append((key, desc)); return self
    def limit(self, count): self.limit_count = count; return self

    def execute(self):
        hits = [row for row in self.db.tables.get(self.table, []) if all(f(row) for f in self.filters)]
        for key, desc in reversed(self.orders):
            hits.sort(key=lambda row: str(row.get(key) or ""), reverse=desc)
        if self.limit_count is not None:
            hits = hits[: self.limit_count]
        return SimpleNamespace(data=[dict(row) for row in hits])


class Database:
    def __init__(self, count):
        self.tables = {
            "chat_sessions": [{"id": "s1", "user_id": "u1", "created_at": "2026-01-01T00:00:00Z"}],
            "chat_messages": [
                {
                    "id": f"m{i:03d}", "session_id": "s1", "role": "user" if i % 2 else "ai",
                    "text": f"message {i}", "created_at": f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}Z",
                    "transition": None,
                }
                for i in range(count)
            ],
            "chat_message_feedback": [],
        }

    def table(self, name): return Query(self, name)


def _setup(monkeypatch, count):
    db = Database(count)
    monkeypatch.setattr(main, "_require_chat_storage", lambda: db)
    monkeypatch.setattr(main, "_get_supabase", lambda: db)

    async def no_recovery(*_args, **_kwargs): return None
    monkeypatch.setattr(main, "_memory_recovery_message", no_recovery)
    return db


def test_first_page_is_the_newest_messages_in_reading_order(monkeypatch):
    _setup(monkeypatch, 30)
    page = asyncio.run(main.get_messages("s1", "u1", limit=10))
    assert [m["id"] for m in page["messages"]] == [f"m{i:03d}" for i in range(20, 30)]
    assert page["has_more"] is True


def test_older_pages_walk_back_to_the_start(monkeypatch):
    _setup(monkeypatch, 25)
    seen: list[str] = []
    before = None
    while True:
        page = asyncio.run(main.get_messages("s1", "u1", limit=10, before=before))
        seen = [m["id"] for m in page["messages"]] + seen
        if not page["has_more"]:
            break
        before = page["messages"][0]["created_at"]
    assert seen == [f"m{i:03d}" for i in range(25)]


def test_legacy_call_keeps_the_newest_rows_when_capped(monkeypatch):
    _setup(monkeypatch, 12)
    monkeypatch.setattr(main, "CHAT_HISTORY_MAX_ROWS", 5)
    history = asyncio.run(main.get_messages("s1", "u1"))
    assert isinstance(history, list)
    assert [m["id"] for m in history] == [f"m{i:03d}" for i in range(7, 12)]
