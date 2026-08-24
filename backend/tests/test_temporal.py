from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend import main
from backend.nuri_core import dialogue_reply, temporal


NOW = datetime(2026, 8, 22, 14, 30, tzinfo=timezone.utc)


def test_iana_timezone_and_local_calendar_anchor_are_deterministic():
    ctx = temporal.build_context("America/Chicago", now_utc=NOW)

    assert ctx.user_local.isoformat().startswith("2026-08-22T09:30:00-05:00")
    block = temporal.prompt_block(ctx)
    assert "用户本地今天：2026-08-22；昨天：2026-08-21" in block
    assert "不等同于不足24小时" in block


def test_invalid_timezone_is_rejected_but_old_client_defaults_to_utc():
    assert main.UserMessageIn(text="hi").client_context is None
    with pytest.raises(ValidationError):
        main.UserMessageIn(
            text="hi", client_context={"timezone": "Chicago, maybe"}
        )


def test_message_annotation_has_absolute_local_time_and_server_computed_age():
    ctx = temporal.build_context("America/Chicago", now_utc=NOW)
    annotation = temporal.message_time_annotation(
        "2026-08-21T12:00:00Z", ctx,
    )

    assert "2026-08-21 07:00:00 America/Chicago" in annotation
    assert "距本轮1天2小时" in annotation


def test_linear_and_four_model_prompts_share_the_same_temporal_context():
    ctx = temporal.build_context("America/Chicago", now_utc=NOW)
    history = [
        {
            "role": "user",
            "text": "昨天发生的",
            "created_at": "2026-08-20T12:00:00Z",
        },
        {
            "role": "ai",
            "text": "先观察",
            "created_at": "2026-08-20T12:01:00Z",
        },
        {
            "role": "user",
            "text": "现在已经过了多久？",
            "created_at": NOW.isoformat(),
        },
    ]

    linear, _ = dialogue_reply.nuri_messages(
        history, temporal_context=ctx,
    )
    four, _ = dialogue_reply.nuri_messages(
        history,
        system_prompt=dialogue_reply.CACHE_SEAM.join(("global", "family", "turn")),
        temporal_context=ctx,
    )

    clock = temporal.prompt_block(ctx)
    assert any(clock in m["content"] for m in linear if m["role"] == "system")
    assert any(clock in m["content"] for m in four if m["role"] == "system")
    for built in (linear, four):
        real_messages = [m for m in built if m["role"] in {"user", "assistant"}]
        assert "2026-08-20 07:00:00 America/Chicago" in real_messages[0]["content"]
        assert "本轮消息时间：2026-08-22 09:30:00" in real_messages[-1]["content"]


class _Messages:
    def __init__(self):
        self.rows = []
        self.selected = []
        self.pending = None
        self.filters = {}

    def insert(self, row):
        self.pending = row
        return self

    def select(self, columns):
        self.selected.append(columns)
        return self

    def eq(self, column, value):
        self.filters[column] = value
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        if self.pending is not None:
            self.rows.append(self.pending)
            self.pending = None
            return SimpleNamespace(data=self.rows[-1:])
        rows = [
            row for row in self.rows
            if all(row.get(column) == value for column, value in self.filters.items())
        ]
        self.filters = {}
        return SimpleNamespace(data=rows)


class _Supabase:
    def __init__(self):
        self.messages = _Messages()

    def table(self, name):
        assert name == "chat_messages"
        return self.messages


def test_prepare_turn_keeps_created_at_from_supabase(monkeypatch):
    sb = _Supabase()

    async def owned(*_args):
        return {"id": "session-1", "user_id": "parent-1"}

    async def profile(*_args):
        return ({}, [])

    async def noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    monkeypatch.setattr(main, "_load_owned_session", owned)
    monkeypatch.setattr(main.core_family_store, "load_profile", profile)
    monkeypatch.setattr(main.core_family_store, "save_normalized_input", noop)
    monkeypatch.setattr(main, "_maybe_set_title", noop)
    monkeypatch.setattr(main, "_now", lambda: NOW.isoformat())

    turn = asyncio.run(
        main._prepare_turn(
            "session-1",
            main.UserMessageIn(
                text="现在呢？",
                client_context={"timezone": "America/Chicago"},
            ),
            "parent-1",
        )
    )

    assert "*" in sb.messages.selected
    assert turn.msgs[-1]["created_at"] == NOW.isoformat()
    assert turn.temporal.timezone_name == "America/Chicago"
