"""Unit coverage for the read-only home-card conversation preview."""

import asyncio
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import main  # noqa: E402


def test_preview_requires_a_valid_parent_token():
    with TestClient(main.app) as client:
        response = client.get("/api/chat/main/preview")

    assert response.status_code == 401


def _run_preview(monkeypatch, sessions, messages, uid="parent-1"):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)
    monkeypatch.setattr(main, "_sessions", {item["id"]: item for item in sessions})
    monkeypatch.setattr(main, "_messages", messages)
    return asyncio.run(main.get_main_chat_preview(uid))


def test_preview_selects_the_most_recently_active_main_session(monkeypatch):
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
                "text": "must not appear",
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

    assert preview["session_id"] == "main-most-recently-active"
    assert preview["last_user_message"]["text"] == "小满昨晚又醒了两次"
    assert preview["last_message"]["role"] == "ai"
    assert preview["last_activity_at"] == "2026-07-29T10:01:00+00:00"


def test_preview_treats_ai_only_session_as_no_previous_user_topic(monkeypatch):
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

    preview = _run_preview(monkeypatch, sessions, messages)

    assert preview["has_conversation"] is True
    assert preview["session_id"] == "main-1"
    assert preview["last_user_message"] is None
    assert preview["last_message"]["text"] == "你好，我在这里。"


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


def test_preview_returns_explicit_empty_payload_without_main_session(monkeypatch):
    sessions = [
        {
            "id": "card-session",
            "user_id": "parent-1",
            "source_card_id": "card-1",
            "title": "article chat",
            "created_at": "2026-07-20T10:00:00+00:00",
        }
    ]

    preview = _run_preview(monkeypatch, sessions, {})

    assert preview == {
        "has_conversation": False,
        "session_id": None,
        "title": None,
        "last_activity_at": None,
        "last_user_message": None,
        "last_message": None,
    }


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
