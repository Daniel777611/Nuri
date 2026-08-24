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
import base64
from io import BytesIO
import threading
from types import SimpleNamespace

import pytest
from PIL import Image

from backend import main, memstore


def _jpeg_data_uri(color: tuple[int, int, int]) -> str:
    output = BytesIO()
    Image.new("RGB", (1, 1), color).save(output, "JPEG")
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


class _SessionTable:
    """Just enough PostgREST to stand in for chat_sessions."""

    def __init__(self, store: list[dict], on_insert=None, lock=None):
        self._store = store
        self._on_insert = on_insert
        self._lock = lock or threading.Lock()
        self._filters: dict = {}
        self._pending = None
        self._update = None
        self._orders: list[tuple[str, bool]] = []
        self._limit = None

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def order(self, column, desc=False, **_k):
        self._orders.append((column, desc))
        return self

    def limit(self, count, **_k):
        self._limit = count
        return self

    def insert(self, row):
        self._pending = row
        return self

    def update(self, patch):
        self._update = patch
        return self

    def execute(self):
        with self._lock:
            if self._pending is not None:
                row, self._pending = self._pending, None
                if self._on_insert:
                    self._on_insert(row)
                self._store.append(dict(row))
                return SimpleNamespace(data=[dict(row)])
            rows = [
                r for r in self._store
                if all(r.get(k) == v for k, v in self._filters.items())
            ]
            if self._update is not None:
                patch, self._update = self._update, None
                for row in rows:
                    row.update(patch)
                return SimpleNamespace(data=[dict(row) for row in rows])
            for column, desc in reversed(self._orders):
                rows.sort(
                    key=lambda r, c=column: str(r.get(c) or ""),
                    reverse=desc,
                )
            if not self._orders:
                rows.sort(key=lambda r: r.get("created_at") or "")
            if self._limit is not None:
                rows = rows[: self._limit]
            return SimpleNamespace(data=[dict(row) for row in rows])


class _Supabase:
    def __init__(self, sessions: list[dict], on_insert=None):
        self.sessions = sessions
        self._on_insert = on_insert
        self.message_inserts: list[dict] = []
        self._lock = threading.Lock()

    def table(self, name):
        if name == "chat_sessions":
            return _SessionTable(self.sessions, self._on_insert, self._lock)
        # chat_messages has to read back what it stored: the divider dedupe
        # works by looking at the last message, so a sink that always answers
        # "empty" would let the test pass while the real check never ran.
        return _MessageTable(self.message_inserts, self._lock)


class _MessageTable:
    def __init__(self, store: list[dict], lock=None):
        self._store = store
        self._lock = lock or threading.Lock()
        self._filters: dict = {}
        self._desc = False
        self._limit = None
        self._pending = None
        self._update = None
        self._delete = False

    def insert(self, row):
        self._pending = row
        return self

    def select(self, *_a, **_k):
        return self

    def update(self, patch):
        self._update = patch
        return self

    def delete(self):
        self._delete = True
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def in_(self, col, values):
        self._filters[col] = set(values)
        return self

    def order(self, _col, desc=False, **_k):
        self._desc = desc
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        def value(row, key):
            if "->>" in key:
                column, json_key = key.split("->>", 1)
                nested = row.get(column) or {}
                return nested.get(json_key) if isinstance(nested, dict) else None
            return row.get(key)

        with self._lock:
            if self._pending is not None:
                row, self._pending = self._pending, None
                if any(existing.get("id") == row.get("id") for existing in self._store):
                    raise RuntimeError("duplicate key value violates chat_messages_pkey")
                self._store.append(dict(row))
                return SimpleNamespace(data=[dict(row)])
            rows = [
                r for r in self._store
                if all(
                    value(r, k) in v if isinstance(v, set) else value(r, k) == v
                    for k, v in self._filters.items()
                )
            ]
            if self._update is not None:
                patch, self._update = self._update, None
                for row in rows:
                    row.update(patch)
                return SimpleNamespace(data=[dict(row) for row in rows])
            if self._delete:
                deleted = [dict(row) for row in rows]
                self._store[:] = [row for row in self._store if row not in rows]
                return SimpleNamespace(data=deleted)
            rows.sort(key=lambda r: r.get("created_at") or "", reverse=self._desc)
            rows = rows[: self._limit] if self._limit else rows
            return SimpleNamespace(data=[dict(row) for row in rows])


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


def test_legacy_duplicates_open_the_session_with_the_newest_parent_message(
    monkeypatch, no_model,
):
    sessions = [
        {
            "id": "older-row",
            "user_id": "parent-1",
            "title": "old greeting only",
            "created_at": "2026-07-01T00:00:00+00:00",
        },
        {
            "id": "real-history",
            "user_id": "parent-1",
            "title": "real history",
            "created_at": "2026-07-02T00:00:00+00:00",
        },
    ]
    sb = _Supabase(sessions)
    sb.message_inserts.extend([
        {
            "id": "old-greeting",
            "session_id": "older-row",
            "role": "ai",
            "text": "你好",
            "transition": None,
            "created_at": "2026-07-01T00:00:01+00:00",
        },
        {
            "id": "latest-user",
            "session_id": "real-history",
            "role": "user",
            "text": "这是最新的真实对话",
            "transition": None,
            "created_at": "2026-08-23T00:00:00+00:00",
        },
    ])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    session = _start()

    assert session["id"] == "real-history"
    assert len(sb.sessions) == 2


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


def test_opening_a_card_leaves_a_divider_carrying_the_card(monkeypatch, no_model):
    """The marker is the divider the parent sees *and* where the reply path
    reads card context from, now that no card has a session of its own."""
    sb = _Supabase([])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    _start()
    before = len(sb.message_inserts)
    _start(card_id="learn_big_feelings")

    markers = [
        m for m in sb.message_inserts[before:]
        if (m.get("transition") or {}).get("kind") == main.CARD_OPENED
    ]
    assert len(markers) == 1
    assert markers[0]["transition"]["card_id"] == "learn_big_feelings"
    # No text: it is a separator, and every prompt builder drops empty messages,
    # so it never reaches the model as if the parent had said it.
    assert markers[0]["text"] == ""


def test_the_newest_marker_decides_the_card_context(monkeypatch):
    """Two cards opened in one conversation: the turns after the second are
    about the second, and `source_card_id` is only a legacy fallback."""
    turn = SimpleNamespace(
        session={},
        msgs=[
            {"role": "user", "text": "hi", "transition": None},
            {"role": "ai", "text": "", "transition": {"kind": main.CARD_OPENED, "card_id": "learn_sleep_routine"}},
            {"role": "user", "text": "睡眠的问题", "transition": None},
            {"role": "ai", "text": "", "transition": {"kind": main.CARD_OPENED, "card_id": "learn_big_feelings"}},
            {"role": "user", "text": "情绪呢", "transition": None},
        ],
    )
    assert main._active_card_id(turn) == "learn_big_feelings"


def test_card_context_falls_back_to_a_legacy_card_session(monkeypatch):
    """Anonymous sessions created before this still carry source_card_id, and
    must keep working."""
    turn = SimpleNamespace(session={"source_card_id": "card_food_picky"}, msgs=[])
    assert main._active_card_id(turn) == "card_food_picky"


def test_a_conversation_with_no_card_has_no_card_context(monkeypatch):
    turn = SimpleNamespace(session={}, msgs=[{"role": "user", "text": "hi"}])
    assert main._active_card_id(turn) == ""


def test_reopening_the_same_card_does_not_stack_dividers(monkeypatch, no_model):
    """The home screen can fire the request several times for one tap — that is
    exactly how the duplicate sessions were being created."""
    sb = _Supabase([])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    _start()
    _start(card_id="learn_big_feelings")
    after_first = len(sb.message_inserts)
    _start(card_id="learn_big_feelings")
    _start(card_id="learn_big_feelings")

    assert len(sb.message_inserts) == after_first


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
    greetings = [
        row for row in sb.message_inserts
        if row.get("id") == str(main.uuid.uuid5(
            main.uuid.NAMESPACE_URL, "nuri:greeting:winner-session"
        ))
    ]
    assert len(greetings) == 1
    assert memstore.sessions == {}


def test_existing_empty_session_is_repaired_with_one_greeting(monkeypatch, no_model):
    session = {
        "id": "empty-session",
        "user_id": "parent-1",
        "title": "和NURI聊天",
        "script_key": "free",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    returned = _start()
    _start()

    assert returned["id"] == session["id"]
    assert len(sb.message_inserts) == 1
    assert sb.message_inserts[0]["role"] == "ai"


def test_empty_session_gets_greeting_before_card_marker(monkeypatch, no_model):
    session = {
        "id": "empty-session",
        "user_id": "parent-1",
        "title": "和NURI聊天",
        "script_key": "free",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    _start(card_id="learn_big_feelings")

    assert sb.message_inserts[0]["role"] == "ai"
    assert (sb.message_inserts[1].get("transition") or {}).get("kind") == (
        main.CARD_OPENED
    )


def test_persistent_conversation_cannot_be_deleted(monkeypatch, no_model):
    """A stale client cleanup must not erase the account's durable history."""
    session = {
        "id": "persistent-session",
        "user_id": "parent-1",
        "title": "和NURI聊天",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    with pytest.raises(main.HTTPException) as exc:
        asyncio.run(main.delete_session(session["id"], uid="parent-1"))

    assert exc.value.status_code == 409
    assert sb.sessions == [session]


def test_signed_in_session_never_falls_back_to_process_memory(monkeypatch, no_model):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)

    with pytest.raises(main.HTTPException) as exc:
        _start()

    assert exc.value.status_code == 503
    assert memstore.sessions == {}
    assert memstore.messages == {}


def test_user_message_write_failure_stops_before_fake_success(monkeypatch, no_model):
    class BrokenMessageTable(_MessageTable):
        def execute(self):
            raise RuntimeError("chat_messages unavailable")

    class BrokenMessagesSupabase(_Supabase):
        def table(self, name):
            if name == "chat_sessions":
                return _SessionTable(self.sessions)
            return BrokenMessageTable(self.message_inserts)

    session = {
        "id": "durable-session",
        "user_id": "parent-1",
        "title": "和NURI聊天",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = BrokenMessagesSupabase([session])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    with pytest.raises(main.HTTPException) as exc:
        asyncio.run(
            main._prepare_turn(
                session["id"], main.UserMessageIn(text="这条必须保存"), "parent-1"
            )
        )

    assert exc.value.status_code == 503
    assert memstore.messages == {}


def test_ai_message_write_failure_is_not_reported_as_saved(monkeypatch, no_model):
    class BrokenCompletionTable(_MessageTable):
        def execute(self):
            if self._update is not None:
                raise RuntimeError("chat_messages unavailable")
            return super().execute()

    class BrokenSupabase(_Supabase):
        def table(self, name):
            if name == "chat_sessions":
                return _SessionTable(self.sessions, lock=self._lock)
            return BrokenCompletionTable(self.message_inserts, self._lock)

    sb = BrokenSupabase([])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    message_id = main._ai_message_id("durable-session", "client-message-1")
    claim = asyncio.run(main._acquire_generation_claim(
        sb, "durable-session", message_id,
    ))

    with pytest.raises(main.HTTPException) as exc:
        asyncio.run(
            main._persist_ai_turn(
                "durable-session",
                SimpleNamespace(
                    msgs=[],
                    user_msg={"id": "client-message-1"},
                    generation_claim_token=claim.token,
                ),
                "这条也必须保存",
                [],
                None,
            )
        )

    assert exc.value.status_code == 503


def _install_turn_dependencies(monkeypatch, normalized_calls):
    async def load_profile(_uid):
        return {}, []

    async def save_normalized_input(**kwargs):
        normalized_calls.append(kwargs)

    monkeypatch.setattr(main.core_family_store, "load_profile", load_profile)
    monkeypatch.setattr(
        main.core_family_store, "save_normalized_input", save_normalized_input,
    )


def _prepare(session_id, body):
    return asyncio.run(main._prepare_turn(session_id, body, "parent-1"))


def test_client_retry_key_is_session_scoped_and_normalized_only_once(
    monkeypatch, no_model,
):
    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    calls = []
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    _install_turn_dependencies(monkeypatch, calls)
    body = main.UserMessageIn(
        text="请记住这一条", client_message_id="client-request-123",
    )

    first = _prepare(session["id"], body)
    asyncio.run(main._release_generation_claim(
        sb,
        session["id"],
        main._ai_message_id(session["id"], first.user_msg["id"]),
        first.generation_claim_token,
    ))
    second = _prepare(session["id"], body)

    assert first.user_message_created is True
    assert second.user_message_created is False
    assert second.replayed_ai_message is None
    assert first.user_msg["id"] != body.client_message_id
    assert first.user_msg["id"] == main._user_message_id(
        session["id"], body.client_message_id,
    )
    assert main._user_message_id("session-a", body.client_message_id) != (
        main._user_message_id("session-b", body.client_message_id)
    )
    assert len(calls) == 1
    asyncio.run(main._release_generation_claim(
        sb,
        session["id"],
        main._ai_message_id(session["id"], second.user_msg["id"]),
        second.generation_claim_token,
    ))


def test_reusing_client_retry_key_for_different_content_is_conflict(
    monkeypatch, no_model,
):
    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    calls = []
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    _install_turn_dependencies(monkeypatch, calls)
    _prepare(
        session["id"],
        main.UserMessageIn(text="原始内容", client_message_id="client-request-123"),
    )

    with pytest.raises(main.HTTPException) as exc:
        _prepare(
            session["id"],
            main.UserMessageIn(text="不同内容", client_message_id="client-request-123"),
        )

    assert exc.value.status_code == 409
    assert len(calls) == 1


def test_reusing_client_retry_key_for_different_image_is_conflict(
    monkeypatch, no_model,
):
    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    calls = []
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    _install_turn_dependencies(monkeypatch, calls)
    _prepare(
        session["id"],
        main.UserMessageIn(
            text="图片",
            image_base64=_jpeg_data_uri((255, 0, 0)),
            client_message_id="client-request-123",
        ),
    )

    with pytest.raises(main.HTTPException) as exc:
        _prepare(
            session["id"],
            main.UserMessageIn(
                text="图片",
                image_base64=_jpeg_data_uri((0, 0, 255)),
                client_message_id="client-request-123",
            ),
        )

    assert exc.value.status_code == 409
    assert calls[0]["raw_image_base64"] is None
    stored_user = next(row for row in sb.message_inserts if row["role"] == "user")
    assert stored_user["image_base64"].startswith("data:image/jpeg;base64,")


def test_write_verification_is_scoped_to_the_session(monkeypatch, no_model):
    sb = _Supabase([])
    sb.message_inserts.append({
        "id": "same-id", "session_id": "other-session", "role": "user",
        "text": "foreign",
    })

    row = asyncio.run(main._chat_row_by_id(
        sb, "chat_messages", "same-id", session_id="wanted-session",
    ))

    assert row is None


def test_completed_retry_replays_ai_without_generation_or_side_effects(
    monkeypatch, no_model,
):
    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    calls = []
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    _install_turn_dependencies(monkeypatch, calls)
    body = main.UserMessageIn(
        text="同一个请求", client_message_id="client-request-123",
    )
    first = _prepare(session["id"], body)
    ai = asyncio.run(main._persist_ai_turn(
        session["id"], first, "已经保存的回答", ["继续"], None, [],
    ))

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("a replay must not generate or persist again")

    monkeypatch.setattr(main, "_scripted_reply", forbidden)
    monkeypatch.setattr(main, "_persist_ai_turn", forbidden)
    background = main.BackgroundTasks()
    result = asyncio.run(main.post_message(
        session["id"], body, background, uid="parent-1",
    ))

    assert result["ai_messages"] == [ai]
    assert len(calls) == 1
    assert background.tasks == []


def test_streaming_completed_retry_replays_saved_result(monkeypatch, no_model):
    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    calls = []
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    _install_turn_dependencies(monkeypatch, calls)
    body = main.UserMessageIn(
        text="同一个流请求", client_message_id="client-request-123",
    )
    first = _prepare(session["id"], body)
    asyncio.run(main._persist_ai_turn(
        session["id"], first, "旧流式回答", [], None, [],
    ))

    async def collect():
        response = await main.post_message_stream(
            session["id"], body, uid="parent-1",
        )
        return "".join([
            chunk.decode() if isinstance(chunk, bytes) else chunk
            async for chunk in response.body_iterator
        ])

    payload = asyncio.run(collect())

    assert '"type": "delta"' in payload
    assert "旧流式回答" in payload
    assert '"type": "done"' in payload
    assert len(calls) == 1


def test_ai_retry_key_collision_with_different_text_is_conflict(
    monkeypatch, no_model,
):
    session_id = "session-a"
    user_id = main._user_message_id(session_id, "client-request-123")
    existing = {
        "id": main._ai_message_id(session_id, user_id),
        "session_id": session_id, "role": "ai", "text": "已经保存",
        "image_base64": None, "created_at": "2020-01-01T00:00:02+00:00",
    }
    with pytest.raises(main.HTTPException) as exc:
        main._validate_completed_ai_message(existing, {
            "id": existing["id"],
            "session_id": session_id,
            "role": "ai",
            "text": "另一个回答",
            "quick_replies": [],
            "transition": None,
            "sources": [],
        })

    assert exc.value.status_code == 409


def test_pending_generation_claim_is_hidden_from_message_history(
    monkeypatch, no_model,
):
    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    sb.message_inserts.extend([
        {
            "id": "user-1", "session_id": session["id"], "role": "user",
            "text": "可见问题", "transition": None,
            "created_at": "2026-08-23T00:00:00+00:00",
        },
        {
            "id": "pending-ai", "session_id": session["id"], "role": "ai",
            "text": "", "quick_replies": [],
            "transition": {
                "kind": main._GENERATION_CLAIM_KIND,
                "claim_token": "peer-token",
                "lease_expires_at": "2099-01-01T00:00:00+00:00",
            },
            "created_at": "2026-08-23T00:00:01+00:00",
        },
    ])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)

    rows = asyncio.run(main.get_messages(session["id"], uid="parent-1"))

    assert [row["id"] for row in rows] == ["user-1"]


def test_expired_generation_claim_is_recoverable_by_atomic_takeover(
    monkeypatch, no_model,
):
    sb = _Supabase([])
    message_id = "pending-ai"
    sb.message_inserts.append({
        "id": message_id, "session_id": "session-a", "role": "ai",
        "text": "", "quick_replies": [],
        "transition": {
            "kind": main._GENERATION_CLAIM_KIND,
            "claim_token": "dead-worker",
            "lease_expires_at": "2020-01-01T00:00:00+00:00",
        },
        "created_at": "2020-01-01T00:00:00+00:00",
    })

    claim = asyncio.run(main._acquire_generation_claim(
        sb, "session-a", message_id, wait_seconds=0,
    ))

    assert claim.owned is True
    assert claim.token != "dead-worker"
    assert sb.message_inserts[0]["transition"]["claim_token"] == claim.token


def test_expired_claim_takeover_verifies_return_minimal_update(no_model):
    class MinimalUpdateTable(_MessageTable):
        def execute(self):
            was_update = self._update is not None
            result = super().execute()
            return SimpleNamespace(data=[]) if was_update else result

    class MinimalUpdateSupabase(_Supabase):
        def table(self, name):
            if name == "chat_sessions":
                return super().table(name)
            return MinimalUpdateTable(self.message_inserts, self._lock)

    sb = MinimalUpdateSupabase([])
    message_id = "pending-ai-minimal"
    sb.message_inserts.append({
        "id": message_id, "session_id": "session-a", "role": "ai",
        "text": "", "quick_replies": [],
        "transition": {
            "kind": main._GENERATION_CLAIM_KIND,
            "claim_token": "dead-worker",
            "lease_expires_at": "2020-01-01T00:00:00+00:00",
        },
        "created_at": "2020-01-01T00:00:00+00:00",
    })

    claim = asyncio.run(main._acquire_generation_claim(
        sb, "session-a", message_id, wait_seconds=0,
    ))

    assert claim.owned is True
    assert sb.message_inserts[0]["transition"]["claim_token"] == claim.token


def test_live_generation_claim_returns_explicit_conflict_after_wait(no_model):
    sb = _Supabase([])
    sb.message_inserts.append({
        "id": "pending-ai", "session_id": "session-a", "role": "ai",
        "text": "", "quick_replies": [],
        "transition": {
            "kind": main._GENERATION_CLAIM_KIND,
            "claim_token": "live-worker",
            "lease_expires_at": "2099-01-01T00:00:00+00:00",
        },
        "created_at": "2026-08-23T00:00:00+00:00",
    })

    with pytest.raises(main.HTTPException) as exc:
        asyncio.run(main._acquire_generation_claim(
            sb, "session-a", "pending-ai", wait_seconds=0,
        ))

    assert exc.value.status_code == 409


def test_ambiguous_claim_completion_readback_keeps_owner_side_effect_rights(
    monkeypatch, no_model,
):
    class AmbiguousCompletionTable(_MessageTable):
        def __init__(self, parent):
            super().__init__(parent.message_inserts, parent._lock)
            self.parent = parent

        def execute(self):
            if self._update is not None and self.parent.raise_after_update:
                result = super().execute()
                self.parent.raise_after_update = False
                raise RuntimeError("response lost after commit")
            return super().execute()

    class AmbiguousSupabase(_Supabase):
        def __init__(self):
            super().__init__([])
            self.raise_after_update = True

        def table(self, name):
            if name == "chat_sessions":
                return _SessionTable(self.sessions, lock=self._lock)
            return AmbiguousCompletionTable(self)

    sb = AmbiguousSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    user_id = "user-1"
    message_id = main._ai_message_id("session-a", user_id)
    claim = asyncio.run(main._acquire_generation_claim(
        sb, "session-a", message_id,
    ))
    turn = SimpleNamespace(
        user_msg={"id": user_id}, generation_claim_token=claim.token,
    )

    saved = asyncio.run(main._persist_ai_turn(
        "session-a", turn, "只生成一次的回答", ["继续"], None, [],
    ))

    assert saved["text"] == "只生成一次的回答"
    # The owner must still schedule this turn's metrics/memory/outcome work;
    # an ambiguous response is not a peer replay.
    assert saved.created is True
    assert not any(main._is_pending_generation_claim(row) for row in sb.message_inserts)


def test_expired_owner_cannot_claim_side_effects_from_new_owner_completion(
    no_model,
):
    sb = _Supabase([])
    message_id = "pending-ai"
    first = asyncio.run(main._acquire_generation_claim(
        sb, "session-a", message_id,
    ))
    # Simulate a crashed/slow worker whose lease was legitimately taken over.
    sb.message_inserts[0]["transition"]["lease_expires_at"] = (
        "2020-01-01T00:00:00+00:00"
    )
    second = asyncio.run(main._acquire_generation_claim(
        sb, "session-a", message_id, wait_seconds=0,
    ))
    assert second.token != first.token

    winner = asyncio.run(main._complete_generation_claim(
        sb,
        session_id="session-a",
        message_id=message_id,
        token=second.token,
        text="相同的确定性回答",
        quick_replies=[],
        transition=None,
        sources=[],
    ))
    assert winner.created is True

    with pytest.raises(main.HTTPException) as exc:
        asyncio.run(main._complete_generation_claim(
            sb,
            session_id="session-a",
            message_id=message_id,
            token=first.token,
            text="相同的确定性回答",
            quick_replies=[],
            transition=None,
            sources=[],
        ))

    assert exc.value.status_code == 409


def test_concurrent_same_client_turn_generates_once_and_peer_replays(
    monkeypatch, no_model,
):
    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "step": 1, "script_key": "free",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    normalized = []
    _install_turn_dependencies(monkeypatch, normalized)
    calls = []
    started = asyncio.Event()

    async def one_script(_session, _session_id):
        calls.append("generated")
        started.set()
        await asyncio.sleep(0.15)
        return "并发只生成一次", [], None, 1, 1

    monkeypatch.setattr(main, "_scripted_reply", one_script)
    body = main.UserMessageIn(
        text="同一条并发消息", client_message_id="same-client-request",
    )

    async def run_both():
        first = asyncio.create_task(main.post_message(
            session["id"], body, main.BackgroundTasks(), uid="parent-1",
        ))
        await started.wait()
        second = asyncio.create_task(main.post_message(
            session["id"], body, main.BackgroundTasks(), uid="parent-1",
        ))
        return await asyncio.gather(first, second)

    first, second = asyncio.run(run_both())

    assert calls == ["generated"]
    assert first["ai_messages"][0]["text"] == "并发只生成一次"
    assert second["ai_messages"][0]["text"] == "并发只生成一次"
    assert len(normalized) == 1
    assert len([
        row for row in sb.message_inserts
        if row.get("id") == main._ai_message_id(
            session["id"], first["user_message"]["id"],
        )
    ]) == 1


def test_concurrent_initial_greeting_uses_one_model_call(monkeypatch):
    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "step": 1, "script_key": "free",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    monkeypatch.setattr(main, "oai", object())

    async def load_profile(_uid):
        return ({"nickname": "Daniel"}, [])

    async def no_cards():
        return []

    async def no_style():
        return ""

    monkeypatch.setattr(main.core_family_store, "load_profile", load_profile)
    monkeypatch.setattr(main.core_family_store, "profile_ctx", lambda *_args: "")
    monkeypatch.setattr(main.stores, "get_gen_cards", no_cards)
    monkeypatch.setattr(main.core_dialogue_reply, "get_style_rules_ctx", no_style)
    calls = []
    entered = threading.Event()
    release = threading.Event()

    def greeting_model(*_args, **_kwargs):
        calls.append("generated")
        entered.set()
        assert release.wait(timeout=2)
        return {"text": "只生成一次的问候", "quick_replies": []}

    monkeypatch.setattr(
        main.core_dialogue_reply, "nuri_reply_sync", greeting_model,
    )

    async def run_both():
        first = asyncio.create_task(main._ensure_initial_greeting(session, "parent-1"))
        await asyncio.to_thread(entered.wait, 2)
        second = asyncio.create_task(main._ensure_initial_greeting(session, "parent-1"))
        await asyncio.sleep(0.05)
        release.set()
        await asyncio.gather(first, second)

    asyncio.run(run_both())

    assert calls == ["generated"]
    greetings = [
        row for row in sb.message_inserts
        if row.get("role") == "ai" and row.get("text") == "只生成一次的问候"
    ]
    assert len(greetings) == 1


def test_generation_failure_releases_claim_and_retry_can_complete(
    monkeypatch, no_model,
):
    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "step": 1, "script_key": "free",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = _Supabase([session])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    _install_turn_dependencies(monkeypatch, [])
    attempts = []

    async def flaky_script(_session, _session_id):
        attempts.append("attempt")
        if len(attempts) == 1:
            raise RuntimeError("model failed")
        return "重试成功", [], None, 1, 1

    monkeypatch.setattr(main, "_scripted_reply", flaky_script)
    body = main.UserMessageIn(
        text="失败后重试", client_message_id="retry-after-failure",
    )

    with pytest.raises(RuntimeError, match="model failed"):
        asyncio.run(main.post_message(
            session["id"], body, main.BackgroundTasks(), uid="parent-1",
        ))
    assert not any(main._is_pending_generation_claim(row) for row in sb.message_inserts)

    result = asyncio.run(main.post_message(
        session["id"], body, main.BackgroundTasks(), uid="parent-1",
    ))

    assert attempts == ["attempt", "attempt"]
    assert result["ai_messages"][0]["text"] == "重试成功"


def test_script_cursor_advances_only_after_reply_completion(
    monkeypatch, no_model,
):
    class BrokenCompletionTable(_MessageTable):
        def execute(self):
            if self._update is not None:
                raise RuntimeError("reply completion unavailable")
            return super().execute()

    class BrokenSupabase(_Supabase):
        def table(self, name):
            if name == "chat_sessions":
                return _SessionTable(self.sessions, lock=self._lock)
            return BrokenCompletionTable(self.message_inserts, self._lock)

    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "step": 1, "script_key": "free",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = BrokenSupabase([session])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    _install_turn_dependencies(monkeypatch, [])

    with pytest.raises(main.HTTPException) as exc:
        asyncio.run(main.post_message(
            session["id"],
            main.UserMessageIn(
                text="不能跳步", client_message_id="script-write-failure",
            ),
            main.BackgroundTasks(),
            uid="parent-1",
        ))

    assert exc.value.status_code == 503
    assert session["step"] == 1


def test_stream_never_emits_done_before_reply_completion(
    monkeypatch, no_model,
):
    class BrokenCompletionTable(_MessageTable):
        def execute(self):
            if self._update is not None:
                raise RuntimeError("reply completion unavailable")
            return super().execute()

    class BrokenSupabase(_Supabase):
        def table(self, name):
            if name == "chat_sessions":
                return _SessionTable(self.sessions, lock=self._lock)
            return BrokenCompletionTable(self.message_inserts, self._lock)

    session = {
        "id": "session-a", "user_id": "parent-1", "title": "chat",
        "step": 1, "script_key": "free",
        "created_at": "2020-01-01T00:00:00+00:00",
    }
    sb = BrokenSupabase([session])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    _install_turn_dependencies(monkeypatch, [])

    async def collect():
        response = await main.post_message_stream(
            session["id"],
            main.UserMessageIn(
                text="流式保存失败", client_message_id="stream-write-failure",
            ),
            uid="parent-1",
        )
        return "".join([
            chunk.decode() if isinstance(chunk, bytes) else chunk
            async for chunk in response.body_iterator
        ])

    payload = asyncio.run(collect())

    assert '"type": "delta"' in payload
    assert '"type": "error"' in payload
    assert '"type": "done"' not in payload
    assert not any(main._is_pending_generation_claim(row) for row in sb.message_inserts)
