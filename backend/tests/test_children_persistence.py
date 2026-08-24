"""Security and durability contract for the account's child profiles."""

from __future__ import annotations

import asyncio
import inspect
from datetime import date

import pytest
from fastapi import HTTPException

from backend import main
from backend.nuri_core import family_store


class _Result:
    def __init__(self, data):
        self.data = data


class _ChildrenTable:
    def __init__(self, *, returned=None):
        self.returned = returned
        self.action = ""
        self.payload = None
        self.filters: list[tuple[str, str]] = []

    def select(self, *_args):
        self.action = "select"
        return self

    def order(self, *_args, **_kwargs):
        return self

    def insert(self, payload):
        self.action = "insert"
        self.payload = payload
        return self

    def update(self, payload):
        self.action = "update"
        self.payload = payload
        return self

    def delete(self):
        self.action = "delete"
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def execute(self):
        if self.returned is not None:
            return _Result(self.returned)
        if self.action == "insert":
            return _Result([self.payload])
        if self.action == "update":
            return _Result([{**self.payload, "id": "child-1"}])
        return _Result([])


class _Supabase:
    def __init__(self, table):
        self.children = table

    def table(self, name):
        assert name == "children"
        return self.children


def _child(birth_date="2025-10-10"):
    return main.ChildCreate(
        nickname="小啊谷",
        birth_date=date.fromisoformat(birth_date),
        gender="boy",
    )


@pytest.mark.parametrize(
    "handler",
    [main.list_children, main.add_child, main.update_child, main.delete_child],
)
def test_every_child_route_requires_a_valid_account(handler):
    dependency = inspect.signature(handler).parameters["uid"].default
    assert dependency.dependency is main._req_uid


@pytest.mark.parametrize(
    "call",
    [
        lambda: main.list_children(uid="parent-1"),
        lambda: main.add_child(_child(), uid="parent-1"),
        lambda: main.update_child("child-1", _child(), uid="parent-1"),
        lambda: main.delete_child("child-1", uid="parent-1"),
    ],
)
def test_child_routes_never_fall_back_to_process_memory(monkeypatch, call):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(call())
    assert exc.value.status_code == 503


def test_update_returns_the_exact_persisted_birthday_and_scopes_owner(monkeypatch):
    table = _ChildrenTable()
    monkeypatch.setattr(main, "_get_supabase", lambda: _Supabase(table))
    monkeypatch.setattr(main, "_invalidate_child_recommendations", lambda _uid: _noop())

    saved = asyncio.run(main.update_child("child-1", _child(), uid="parent-1"))

    assert saved["birth_date"] == "2025-10-10"
    assert ("id", "child-1") in table.filters
    assert ("user_id", "parent-1") in table.filters


def test_delete_reports_missing_instead_of_claiming_success(monkeypatch):
    table = _ChildrenTable(returned=[])
    monkeypatch.setattr(main, "_get_supabase", lambda: _Supabase(table))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.delete_child("missing", uid="parent-1"))
    assert exc.value.status_code == 404


async def _noop():
    return None


def test_profile_query_failure_is_not_misreported_as_missing_child(monkeypatch):
    class BrokenTable:
        def select(self, *_args):
            raise ConnectionError("database unavailable")

    class BrokenSupabase:
        def table(self, _name):
            return BrokenTable()

    monkeypatch.setattr(family_store.runtime, "get_supabase", lambda: BrokenSupabase())

    with pytest.raises(family_store.ProfileStorageUnavailable):
        asyncio.run(family_store.load_profile("parent-1"))
