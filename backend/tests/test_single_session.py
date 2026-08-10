"""One account, one conversation — enforced by the route, not by the client.

`POST /chat/sessions` used to insert unconditionally and leave the client to
decide whether it wanted a session, which it did by listing sessions and taking
the first without a `source_card_id`. Two requests that raced each made their
own. Production reached 49 sessions across 13 accounts, one holding nine, and
every extra session opened with a model-written greeting on gpt-5.5 — five of
those in one afternoon, 42% of that day's tokens.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from backend import main, memstore


class _SessionTable:
    """Just enough PostgREST to stand in for chat_sessions."""

    def __init__(self, store: list[dict], on_insert=None):
        self._store = store
        self._on_insert = on_insert
        self._filters: dict = {}

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def insert(self, row):
        self._pending = row
        return self

    def execute(self):
        if getattr(self, "_pending", None) is not None:
            row, self._pending = self._pending, None
            if self._on_insert:
                self._on_insert(row)
            self._store.append(row)
            return SimpleNamespace(data=[row])
        rows = [
            r for r in self._store
            if all(r.get(k) == v for k, v in self._filters.items())
        ]
        rows.sort(key=lambda r: r.get("created_at") or "")
        return SimpleNamespace(data=rows[:1])


class _Supabase:
    def __init__(self, sessions: list[dict], on_insert=None):
        self.sessions = sessions
        self._on_insert = on_insert
        self.message_inserts: list[dict] = []

    def table(self, name):
        if name == "chat_sessions":
            return _SessionTable(self.sessions, self._on_insert)
        outer = self

        class _Sink:
            def insert(self, row):
                outer.message_inserts.append(row)
                return self

            def select(self, *_a, **_k):
                return self

            def eq(self, *_a, **_k):
                return self

            def order(self, *_a, **_k):
                return self

            def limit(self, *_a, **_k):
                return self

            def execute(self):
                return SimpleNamespace(data=[])

        return _Sink()


@pytest.fixture
def no_model(monkeypatch):
    """Keep the greeting off the network; its absence is also what we assert."""
    monkeypatch.setattr(main, "oai", None)
    monkeypatch.setattr(memstore, "sessions", {})
    monkeypatch.setattr(memstore, "messages", {})


def _start(card_id=None):
    return asyncio.run(
        main.start_session(main.StartChatRequest(card_id=card_id), uid="parent-1")
    )


def test_second_call_returns_the_same_conversation(monkeypatch, no_model):
    sb = _Supabase([])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    first = _start()
    second = _start()

    assert second["id"] == first["id"]
    assert len(sb.sessions) == 1


def test_opening_a_card_does_not_start_a_second_conversation(monkeypatch, no_model):
    """What the feed's "打开学习胶囊" used to do.

    A card is a topic inside the one conversation, not a conversation of its
    own; the parent must keep the history they already have.
    """
    sb = _Supabase([])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    main_session = _start()
    from_card = _start(card_id="learn_big_feelings")

    assert from_card["id"] == main_session["id"]
    assert len(sb.sessions) == 1
    assert not from_card.get("source_card_id")


def test_returning_costs_no_greeting(monkeypatch, no_model):
    """Each extra session used to open with its own gpt-5.5 greeting, which is
    where the duplicated spend actually went."""
    sb = _Supabase([])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    _start()
    after_first = len(sb.message_inserts)
    _start()
    _start()

    assert len(sb.message_inserts) == after_first


def test_a_lost_insert_race_adopts_the_winner(monkeypatch, no_model):
    """The pre-insert check is not atomic, so two first-ever requests can both
    reach the insert. The unique index lets one win; the loser has to return
    that row rather than fall back to memory and recreate the split."""
    winner = {
        "id": "winner-session",
        "user_id": "parent-1",
        "title": "和NURI聊天",
        "created_at": "2020-01-01T00:00:00+00:00",
    }

    def reject(row):
        # Stand in for the unique index: someone else got there first.
        if row.get("user_id") == "parent-1":
            sb.sessions.append(winner)
            raise RuntimeError('duplicate key value violates "chat_sessions_one_per_user"')

    sb = _Supabase([], on_insert=reject)
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    session = _start()

    assert session["id"] == "winner-session"
    assert memstore.sessions == {}
