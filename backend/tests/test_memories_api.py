from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend import main


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.orders, self.deleting = [], [], False

    def select(self, *_args): return self
    def delete(self): self.deleting = True; return self
    def eq(self, key, value): self.filters.append(lambda row: row.get(key) == value); return self
    def order(self, key, desc=False): self.orders.append((key, desc)); return self

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        hits = [row for row in rows if all(f(row) for f in self.filters)]
        if self.deleting:
            self.db.tables[self.table] = [row for row in rows if row not in hits]
            return SimpleNamespace(data=[dict(row) for row in hits])
        for key, desc in reversed(self.orders):
            hits.sort(key=lambda row: str(row.get(key) or ""), reverse=desc)
        return SimpleNamespace(data=[dict(row) for row in hits])


class Database:
    def __init__(self):
        self.tables = {"user_memories": [
            {"id": "m1", "user_id": "u1", "child_id": None, "category": "constraint",
             "key": "diet", "value": "孩子对鸡蛋过敏", "status": "active", "updated_at": "2026-10-01"},
            {"id": "m2", "user_id": "u1", "child_id": "c1", "category": "concern",
             "key": "sleep", "value": "夜醒两次", "status": "active", "updated_at": "2026-10-02"},
            {"id": "m3", "user_id": "u1", "child_id": None, "category": "fact",
             "key": "old", "value": "已经不对了", "status": "archived", "updated_at": "2026-10-03"},
            {"id": "m4", "user_id": "u2", "child_id": None, "category": "fact",
             "key": "other", "value": "别人的", "status": "active", "updated_at": "2026-10-04"},
        ]}

    def table(self, name): return Query(self, name)


@pytest.fixture
def db(monkeypatch):
    database = Database()
    monkeypatch.setattr(main, "_get_supabase", lambda: database)
    return database


def test_lists_only_this_parents_active_memories_newest_first(db):
    rows = asyncio.run(main.list_memories("u1"))
    assert [r["id"] for r in rows] == ["m2", "m1"]
    assert rows[1]["standing"] is True and rows[0]["standing"] is False
    assert rows[1]["text"] == "孩子对鸡蛋过敏"


def test_forget_deletes_the_row(db):
    asyncio.run(main.forget_memory("m1", "u1"))
    assert "m1" not in {r["id"] for r in db.tables["user_memories"]}


def test_cannot_forget_another_parents_memory(db):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.forget_memory("m4", "u1"))
    assert exc.value.status_code == 404
    assert "m4" in {r["id"] for r in db.tables["user_memories"]}
