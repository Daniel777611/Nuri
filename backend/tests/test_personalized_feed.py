"""Coverage for conversation-linked, curated learning recommendations."""

import asyncio
import json
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import main  # noqa: E402
from backend.content_library import (  # noqa: E402
    LEARNING_CONTENT_CARDS,
    is_trusted_resource_url,
)


def _session(
    session_id: str,
    uid: str,
    *,
    source_card_id=None,
    created_at="2026-07-20T10:00:00+00:00",
):
    return {
        "id": session_id,
        "user_id": uid,
        "source_card_id": source_card_id,
        "title": session_id,
        "created_at": created_at,
    }


def _message(message_id: str, role: str, text: str, created_at: str):
    return {
        "id": message_id,
        "role": role,
        "text": text,
        "created_at": created_at,
    }


def _run_personalized(monkeypatch, uid, sessions, messages, privacy=None, count=4):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)
    monkeypatch.setattr(main, "_sessions", {item["id"]: item for item in sessions})
    monkeypatch.setattr(main, "_messages", messages)
    monkeypatch.setattr(main, "_privacy", privacy or {})
    return asyncio.run(main.get_personalized_feed(count=count, uid=uid))


def test_personalized_feed_requires_login():
    with TestClient(main.app) as client:
        response = client.get("/api/feed/personalized")

    assert response.status_code == 401


def test_memory_feed_is_uid_scoped_excludes_card_sessions_and_matches_sleep(monkeypatch):
    sessions = [
        _session("parent-main", "parent-1"),
        _session(
            "parent-card-chat",
            "parent-1",
            source_card_id="card_sleep_routine",
            created_at="2026-07-30T10:00:00+00:00",
        ),
        _session("other-main", "parent-2", created_at="2026-07-31T10:00:00+00:00"),
    ]
    messages = {
        "parent-main": [
            _message(
                "p-user",
                "user",
                "孩子最近总是夜醒，睡眠也很不规律。",
                "2026-07-29T10:00:00+00:00",
            ),
            _message(
                "p-ai",
                "ai",
                "我们可以先固定睡前节奏。",
                "2026-07-29T10:01:00+00:00",
            ),
        ],
        "parent-card-chat": [
            _message(
                "card-user",
                "user",
                "孩子说话晚，应该如何练习？",
                "2026-07-30T10:01:00+00:00",
            )
        ],
        "other-main": [
            _message(
                "other-user",
                "user",
                "他最近经常打人和发脾气。",
                "2026-07-31T10:01:00+00:00",
            )
        ],
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] == "conversation"
    assert payload["items"][0]["id"] == "learn_sleep_routine"
    assert payload["items"][0]["is_conversation_match"] is True
    assert payload["items"][0]["related_session_id"] == "parent-main"
    assert payload["related_session_id"] == "parent-main"


def test_another_parents_conversation_cannot_affect_ranking(monkeypatch):
    sessions = [
        _session("parent-main", "parent-1"),
        _session("other-main", "parent-2", created_at="2026-07-31T10:00:00+00:00"),
    ]
    messages = {
        "parent-main": [
            _message(
                "parent-user",
                "user",
                "孩子一生气就哭，我想学习怎么安抚他的情绪。",
                "2026-07-29T10:00:00+00:00",
            )
        ],
        "other-main": [
            _message(
                "other-user",
                "user",
                "孩子每天夜醒很多次，完全睡不好。",
                "2026-07-31T10:01:00+00:00",
            )
        ],
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["items"][0]["id"] == "learn_big_feelings"
    assert payload["items"][0]["related_session_id"] == "parent-main"
    assert payload["related_session_id"] == "parent-main"
    assert all(item.get("related_session_id") != "other-main" for item in payload["items"])


def test_history_training_opt_out_never_reads_or_links_conversations(monkeypatch):
    sessions = [_session("private-main", "parent-1")]
    messages = {
        "private-main": [
            _message(
                "private-user",
                "user",
                "孩子夜醒，最近睡眠特别差。",
                "2026-07-30T10:00:00+00:00",
            )
        ]
    }

    payload = _run_personalized(
        monkeypatch,
        "parent-1",
        sessions,
        messages,
        privacy={"parent-1": {"allow_history_training": False}},
    )

    assert payload["personalization_mode"] == "default_privacy"
    assert payload["matched_topic"] is None
    assert payload["related_session_id"] is None
    assert all(item["is_conversation_match"] is False for item in payload["items"])
    assert all(item["related_session_id"] is None for item in payload["items"])
    assert all("关闭对话个性化" in item["personalization_reason"] for item in payload["items"])


@pytest.mark.parametrize("card", LEARNING_CONTENT_CARDS, ids=lambda card: card["id"])
def test_learning_resources_include_trusted_https_article_and_video(card):
    resources = card.get("resources") or []
    kinds = {resource.get("kind") for resource in resources}

    assert {"article", "video"} <= kinds
    assert all(str(resource.get("url") or "").startswith("https://") for resource in resources)
    assert all(is_trusted_resource_url(resource["url"]) for resource in resources)


def test_learning_detail_returns_resources_and_unknown_id_is_404(monkeypatch):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)

    detail = asyncio.run(main.get_card_detail("learn_sleep_routine", uid=None))

    assert detail["id"] == "learn_sleep_routine"
    assert detail["body"]
    assert {resource["kind"] for resource in detail["resources"]} >= {"article", "video"}
    assert all(is_trusted_resource_url(resource["url"]) for resource in detail["resources"])

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.get_card_detail("learn_does_not_exist", uid=None))
    assert exc_info.value.status_code == 404


def test_card_context_includes_learning_content_and_resource_titles():
    card = next(item for item in LEARNING_CONTENT_CARDS if item["id"] == "learn_sleep_routine")

    context = main._card_ctx(card["id"])

    assert card["title"] in context
    assert card["summary"] in context
    assert card["resources"][0]["title"] in context
    assert "延伸资源" in context


class _Result:
    def __init__(self, data=None):
        self.data = data


class _PrivacySettingsTable:
    def __init__(self, store):
        self.store = store
        self.key = None
        self.pending = None
        self.action = "select"

    def select(self, *_args, **_kwargs):
        self.action = "select"
        return self

    def eq(self, field, value):
        assert field == "key"
        self.key = value
        return self

    def maybe_single(self):
        return self

    def upsert(self, row, **_kwargs):
        self.action = "upsert"
        self.pending = row
        return self

    def execute(self):
        if self.action == "upsert":
            self.store[self.pending["key"]] = self.pending["value"]
            return _Result([self.pending])
        value = self.store.get(self.key)
        return _Result({"value": value} if value is not None else None)


class _PrivacySupabase:
    def __init__(self):
        self.store = {}

    def table(self, name):
        assert name == "app_settings"
        return _PrivacySettingsTable(self.store)


def test_privacy_opt_out_survives_a_cold_process_cache(monkeypatch):
    supabase = _PrivacySupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_privacy", {})

    saved = asyncio.run(
        main._db_set_privacy(
            "parent-1",
            {
                "allow_history_training": False,
                "daily_push": True,
                "anonymous_community_share": False,
                "language": "zh",
            },
        )
    )
    assert saved["allow_history_training"] is False
    assert json.loads(supabase.store[main._privacy_storage_key("parent-1")])[
        "allow_history_training"
    ] is False

    # Simulate a Vercel cold start: process memory is empty, Supabase remains.
    monkeypatch.setattr(main, "_privacy", {})
    loaded = asyncio.run(main._db_get_privacy("parent-1", fail_closed=True))
    assert loaded["allow_history_training"] is False


def test_privacy_lookup_fails_closed_when_storage_is_unavailable(monkeypatch):
    class BrokenSupabase:
        def table(self, _name):
            raise RuntimeError("temporary outage")

    monkeypatch.setattr(main, "_get_supabase", lambda: BrokenSupabase())
    monkeypatch.setattr(main, "_privacy", {})

    loaded = asyncio.run(main._db_get_privacy("parent-1", fail_closed=True))

    assert loaded["allow_history_training"] is False


def test_failed_privacy_write_restores_the_previous_cached_setting(monkeypatch):
    class BrokenTable:
        def upsert(self, *_args, **_kwargs):
            return self

        def execute(self):
            raise RuntimeError("write failed")

    class BrokenSupabase:
        def table(self, _name):
            return BrokenTable()

    previous = {**main._DEFAULT_PRIVACY, "allow_history_training": False}
    monkeypatch.setattr(main, "_get_supabase", lambda: BrokenSupabase())
    monkeypatch.setattr(main, "_privacy", {"parent-1": previous})

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            main._db_set_privacy(
                "parent-1",
                {**main._DEFAULT_PRIVACY, "allow_history_training": True},
            )
        )

    assert exc_info.value.status_code == 503
    assert main._privacy["parent-1"]["allow_history_training"] is False
