"""Unit coverage for the read-only home-card conversation preview."""

import asyncio
import logging
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import runtime  # noqa: E402
from backend import main  # noqa: E402


def test_preview_requires_a_valid_parent_token():
    with TestClient(main.app) as client:
        response = client.get("/api/chat/main/preview")

    assert response.status_code == 401


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, database, table_name):
        self.database = database
        self.table_name = table_name
        self.filters = []
        self.orders = []
        self.limit_count = None

    def select(self, _columns):
        return self

    def eq(self, key, value):
        self.filters.append(lambda row, k=key, v=value: row.get(k) == v)
        return self

    def in_(self, key, values):
        allowed = set(values)
        self.filters.append(lambda row, k=key, a=allowed: row.get(k) in a)
        return self

    def order(self, key, desc=False):
        self.orders.append((key, desc))
        return self

    def limit(self, count):
        self.limit_count = count
        return self

    def execute(self):
        if self.table_name in self.database.fail_tables:
            raise RuntimeError(f"{self.table_name} unavailable")
        rows = [dict(row) for row in self.database.rows.get(self.table_name, [])]
        for predicate in self.filters:
            rows = [row for row in rows if predicate(row)]
        for key, desc in reversed(self.orders):
            rows.sort(key=lambda row, k=key: str(row.get(k) or ""), reverse=desc)
        if self.limit_count is not None:
            rows = rows[: self.limit_count]
        return _Result(rows)


class _Supabase:
    def __init__(self, sessions, messages, memories=None, fail_tables=()):
        self.rows = {
            "chat_sessions": sessions,
            "chat_messages": [
                message for session_messages in messages.values() for message in session_messages
            ],
            "user_memories": memories or [],
        }
        self.fail_tables = set(fail_tables)

    def table(self, name):
        return _Query(self, name)


def _run_preview(monkeypatch, sessions, messages, uid="parent-1", memories=None):
    database = _Supabase(sessions, messages, memories)
    monkeypatch.setattr(runtime, "get_supabase", lambda: database)
    return asyncio.run(main.get_main_chat_preview(uid))


def test_preview_includes_a_card_origin_session_in_continuous_history(monkeypatch):
    sessions = [
        {
            "id": "main-newer-created",
            "user_id": "parent-1",
            "source_card_id": None,
            "title": "newer session",
            "created_at": "2026-07-20T10:00:00+00:00",
        },
        {
            "id": "main-most-recently-active",
            "user_id": "parent-1",
            "source_card_id": None,
            "title": "active session",
            "created_at": "2026-07-10T10:00:00+00:00",
        },
        {
            "id": "card-session",
            "user_id": "parent-1",
            "source_card_id": "card-1",
            "title": "article chat",
            "created_at": "2026-07-30T10:00:00+00:00",
        },
        {
            "id": "other-parent",
            "user_id": "parent-2",
            "source_card_id": None,
            "title": "private",
            "created_at": "2026-07-30T11:00:00+00:00",
        },
    ]
    messages = {
        "main-newer-created": [
            {
                "id": "newer-created-msg",
                "session_id": "main-newer-created",
                "role": "user",
                "text": "older activity",
                "created_at": "2026-07-20T10:01:00+00:00",
            }
        ],
        "main-most-recently-active": [
            {
                "id": "active-user",
                "session_id": "main-most-recently-active",
                "role": "user",
                "text": "小满昨晚又醒了两次",
                "created_at": "2026-07-29T10:00:00+00:00",
            },
            {
                "id": "active-ai",
                "session_id": "main-most-recently-active",
                "role": "ai",
                "text": "我们先固定夜醒后的回应方式。",
                "created_at": "2026-07-29T10:01:00+00:00",
            },
        ],
        "card-session": [
            {
                "id": "card-msg",
                "session_id": "card-session",
                "role": "user",
                "text": "从卡片开始、但属于账号的持续对话",
                "created_at": "2026-07-30T10:01:00+00:00",
            }
        ],
        "other-parent": [
            {
                "id": "other-msg",
                "session_id": "other-parent",
                "role": "user",
                "text": "must stay private",
                "created_at": "2026-07-30T11:01:00+00:00",
            }
        ],
    }

    preview = _run_preview(monkeypatch, sessions, messages)

    assert preview["session_id"] == "card-session"
    assert preview["last_user_message"]["text"] == "从卡片开始、但属于账号的持续对话"
    assert preview["last_message"]["role"] == "user"
    assert preview["last_activity_at"] == "2026-07-30T10:01:00+00:00"


def test_ai_only_session_uses_relevant_active_memory_preview(monkeypatch):
    sessions = [
        {
            "id": "main-1",
            "user_id": "parent-1",
            "source_card_id": None,
            "title": "和NURI聊天",
            "created_at": "2026-07-20T10:00:00+00:00",
        }
    ]
    messages = {
        "main-1": [
            {
                "id": "hello",
                "session_id": "main-1",
                "role": "ai",
                "text": "你好，我在这里。",
                "created_at": "2026-07-20T10:00:01+00:00",
            }
        ]
    }

    memories = [
        {
            "id": "must-not-leak",
            "user_id": "parent-1",
            "category": "fact",
            "key": "generic_note",
            "value": "较新的普通事实",
            "confidence": 0.99,
            "source_id": "private-source",
            "status": "active",
            "updated_at": "2026-07-22T10:00:00+00:00",
        },
        {
            "user_id": "parent-1",
            "category": "concern",
            "key": "sleep",
            "value": "小满最近夜醒两次",
            "status": "active",
            "updated_at": "2026-07-21T10:00:00+00:00",
        },
        {
            "user_id": "parent-1",
            "category": "concern",
            "key": "email_address",
            "value": "private@example.com",
            "status": "active",
            "updated_at": "2026-07-23T10:00:00+00:00",
        },
        {
            "user_id": "parent-1",
            "category": "preference",
            "key": "structured",
            "value": '{"raw": "must not leak"}',
            "status": "active",
            "updated_at": "2026-07-24T10:00:00+00:00",
        },
        {
            "user_id": "parent-1",
            "category": "concern",
            "key": "archived-concern",
            "value": "已经归档",
            "status": "archived",
            "updated_at": "2026-07-25T10:00:00+00:00",
        },
    ]

    preview = _run_preview(monkeypatch, sessions, messages, memories=memories)

    assert preview["has_conversation"] is True
    assert preview["session_id"] == "main-1"
    assert preview["last_user_message"] is None
    assert preview["last_message"]["text"] == "你好，我在这里。"
    assert preview["memory_preview"] == {
        "category": "concern",
        "key": "sleep",
        "text": "小满最近夜醒两次",
        "updated_at": "2026-07-21T10:00:00+00:00",
    }


def test_ai_only_new_session_does_not_hide_real_previous_topic(monkeypatch):
    sessions = [
        {
            "id": "real-history",
            "user_id": "parent-1",
            "source_card_id": None,
            "title": "real history",
            "created_at": "2026-07-20T10:00:00+00:00",
        },
        {
            "id": "new-empty-session",
            "user_id": "parent-1",
            "source_card_id": None,
            "title": "new greeting only",
            "created_at": "2026-07-30T10:00:00+00:00",
        },
    ]
    messages = {
        "real-history": [
            {
                "id": "real-user",
                "session_id": "real-history",
                "role": "user",
                "text": "这是最后一次真实提问",
                "created_at": "2026-07-29T10:00:00+00:00",
            },
            {
                "id": "real-ai",
                "session_id": "real-history",
                "role": "ai",
                "text": "这是对应回复",
                "created_at": "2026-07-29T10:01:00+00:00",
            },
        ],
        "new-empty-session": [
            {
                "id": "new-greeting",
                "session_id": "new-empty-session",
                "role": "ai",
                "text": "你好，我在这里。",
                "created_at": "2026-07-30T10:00:01+00:00",
            }
        ],
    }

    preview = _run_preview(monkeypatch, sessions, messages)

    assert preview["session_id"] == "real-history"
    assert preview["last_user_message"]["text"] == "这是最后一次真实提问"
    assert preview["last_message"]["text"] == "这是对应回复"


def test_preview_returns_explicit_empty_payload_for_completely_empty_account(monkeypatch):
    preview = _run_preview(monkeypatch, [], {})

    assert preview == {
        "has_conversation": False,
        "session_id": None,
        "title": None,
        "last_activity_at": None,
        "last_user_message": None,
        "last_message": None,
        "memory_preview": None,
    }


def test_preview_can_return_memory_without_a_conversation(monkeypatch):
    preview = _run_preview(
        monkeypatch,
        [],
        {},
        memories=[{
            "user_id": "parent-1",
            "category": "preference",
            "key": "response_style",
            "value": "喜欢先给简单步骤",
            "status": "active",
            "updated_at": "2026-07-20T10:00:00+00:00",
        }],
    )

    assert preview["has_conversation"] is False
    assert preview["session_id"] is None
    assert preview["memory_preview"]["text"] == "喜欢先给简单步骤"


def test_preview_database_error_is_503_and_structured_log(monkeypatch, caplog):
    database = _Supabase([], {}, fail_tables={"chat_sessions"})
    monkeypatch.setattr(runtime, "get_supabase", lambda: database)

    with caplog.at_level(logging.ERROR, logger="backend.main"):
        with pytest.raises(HTTPException) as raised:
            asyncio.run(main.get_main_chat_preview("parent-1"))

    assert raised.value.status_code == 503
    record = next(record for record in caplog.records if record.message == "chat_main_preview_database_error")
    assert record.event == "chat_main_preview_database_error"
    assert record.error_type == "RuntimeError"
    assert record.user_id_hash
    assert "parent-1" not in record.getMessage()


def test_preview_does_not_expose_full_message_payload(monkeypatch):
    sessions = [
        {
            "id": "main-1",
            "user_id": "parent-1",
            "source_card_id": None,
            "title": "private chat",
            "created_at": "2026-07-20T10:00:00+00:00",
        }
    ]
    messages = {
        "main-1": [
            {
                "id": "user-1",
                "session_id": "main-1",
                "role": "user",
                "text": "真实的上次对话",
                "image_base64": "large-private-image",
                "transition": {"kind": "task_suggestion"},
                "quick_replies": ["private"],
                "created_at": "2026-07-20T10:01:00+00:00",
            }
        ]
    }

    preview = _run_preview(monkeypatch, sessions, messages)

    assert set(preview["last_user_message"]) == {"id", "text", "created_at"}
    assert set(preview["last_message"]) == {"id", "role", "text", "created_at"}
    assert preview["memory_preview"] is None


def test_preview_skips_newer_pending_generation_claim(monkeypatch):
    sessions = [{
        "id": "main-1",
        "user_id": "parent-1",
        "source_card_id": None,
        "title": "chat",
        "created_at": "2026-08-23T10:00:00+00:00",
    }]
    messages = {"main-1": [
        {
            "id": "user-1", "session_id": "main-1", "role": "user",
            "text": "昨天和今天的真实问题",
            "created_at": "2026-08-23T10:01:00+00:00",
        },
        {
            "id": "ai-1", "session_id": "main-1", "role": "ai",
            "text": "真实回答", "transition": None,
            "created_at": "2026-08-23T10:01:01+00:00",
        },
        {
            "id": "pending", "session_id": "main-1", "role": "ai",
            "text": "",
            "transition": {
                "kind": main._GENERATION_CLAIM_KIND,
                "claim_token": "live-worker",
                "lease_expires_at": "2099-01-01T00:00:00+00:00",
            },
            "created_at": "2026-08-23T10:01:02+00:00",
        },
    ]}

    preview = _run_preview(monkeypatch, sessions, messages)

    assert preview["last_message"]["id"] == "ai-1"
    assert preview["last_message"]["text"] == "真实回答"


def test_ai_only_history_exposes_orphan_memories_as_a_labeled_recovery_card(
    monkeypatch,
):
    sessions = [{
        "id": "main-1",
        "user_id": "parent-1",
        "source_card_id": None,
        "title": "chat",
        "created_at": "2026-08-24T04:16:00+00:00",
    }]
    messages = {"main-1": [{
        "id": "greeting",
        "session_id": "main-1",
        "role": "ai",
        "text": "你好，我在这里。",
        "transition": None,
        "created_at": "2026-08-24T04:17:00+00:00",
    }]}
    memories = [
        {
            "user_id": "parent-1",
            "category": "child_state",
            "key": "eyes_red_frequent",
            "value": "啊谷经常眼睛有点红。",
            "source_type": "chat",
            "source_id": "deleted-user-message",
            "status": "active",
            "updated_at": "2026-08-23T16:47:15+00:00",
        },
        {
            "user_id": "parent-1",
            "category": "fact",
            "key": "email_address",
            "value": "must-not-leak@example.com",
            "source_type": "chat",
            "source_id": "deleted-private-message",
            "status": "active",
            "updated_at": "2026-08-23T16:48:15+00:00",
        },
    ]
    database = _Supabase(sessions, messages, memories)
    monkeypatch.setattr(runtime, "get_supabase", lambda: database)

    rows = asyncio.run(main.get_messages("main-1", uid="parent-1"))

    assert [row["id"] for row in rows[1:]] == ["greeting"]
    recovery = rows[0]
    assert recovery["text"] == ""
    assert recovery["transition"]["kind"] == main.MEMORY_CONTEXT
    assert recovery["transition"]["title"] == "已恢复的家庭记忆"
    assert "不是逐字聊天记录" in recovery["transition"]["notice"]
    assert recovery["transition"]["items"] == [{
        "category": "child_state",
        "text": "啊谷经常眼睛有点红。",
        "updated_at": "2026-08-23T16:47:15+00:00",
    }]
    # The recovery view is derived and must never manufacture stored dialogue.
    assert [row["id"] for row in database.rows["chat_messages"]] == ["greeting"]


def test_real_parent_messages_never_get_a_memory_recovery_card(monkeypatch):
    sessions = [{
        "id": "main-1",
        "user_id": "parent-1",
        "title": "chat",
        "created_at": "2026-08-24T04:16:00+00:00",
    }]
    messages = {"main-1": [{
        "id": "user-1",
        "session_id": "main-1",
        "role": "user",
        "text": "真实保留下来的对话",
        "transition": None,
        "created_at": "2026-08-24T04:17:00+00:00",
    }]}
    memories = [{
        "user_id": "parent-1",
        "category": "fact",
        "key": "old_fact",
        "value": "旧记忆",
        "source_type": "chat",
        "source_id": "deleted-message",
        "status": "active",
        "updated_at": "2026-08-23T16:47:15+00:00",
    }]
    database = _Supabase(sessions, messages, memories)
    monkeypatch.setattr(runtime, "get_supabase", lambda: database)

    rows = asyncio.run(main.get_messages("main-1", uid="parent-1"))

    assert [row["id"] for row in rows] == ["user-1"]


def test_memory_recovery_failure_never_hides_durable_messages(monkeypatch):
    sessions = [{
        "id": "main-1",
        "user_id": "parent-1",
        "title": "chat",
        "created_at": "2026-08-24T04:16:00+00:00",
    }]
    messages = {"main-1": [{
        "id": "greeting",
        "session_id": "main-1",
        "role": "ai",
        "text": "真实保留下来的欢迎语",
        "transition": None,
        "created_at": "2026-08-24T04:17:00+00:00",
    }]}
    database = _Supabase(sessions, messages, [])
    monkeypatch.setattr(runtime, "get_supabase", lambda: database)

    async def broken_recovery(*_args, **_kwargs):
        raise RuntimeError("optional recovery query failed")

    monkeypatch.setattr(main, "_memory_recovery_message", broken_recovery)

    rows = asyncio.run(main.get_messages("main-1", uid="parent-1"))

    assert [row["id"] for row in rows] == ["greeting"]
