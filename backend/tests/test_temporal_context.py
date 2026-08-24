"""Regression coverage for time semantics in the chat prompt.

These tests freeze the server clock.  They deliberately assert both calendar
semantics ("yesterday" in the parent's timezone) and elapsed-time semantics;
those are related, but they are not interchangeable around midnight or DST.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend import main
from backend.main import ClientContext
from backend.nuri_core import family, family_store, state_store, temporal
from backend.nuri_core.dialogue_reply import CACHE_SEAM, nuri_messages
from backend.router import TurnRoute


UTC = timezone.utc


def _utc(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=UTC)


def _conversation_messages(messages: list[dict]) -> list[dict]:
    """Exclude system and optional few-shot messages from a built prompt."""

    return [
        message
        for message in messages
        if message["role"] in {"user", "assistant"}
        and "消息时间：" in message["content"]
    ]


@pytest.mark.parametrize(
    "timezone_name,expected_local,expected_today,expected_yesterday",
    [
        (
            "America/Chicago",
            "2026-08-22 22:30:00 America/Chicago",
            "2026-08-22",
            "2026-08-21",
        ),
        (
            "Asia/Shanghai",
            "2026-08-23 11:30:00 Asia/Shanghai",
            "2026-08-23",
            "2026-08-22",
        ),
    ],
)
def test_prompt_uses_the_users_local_calendar_date(
    timezone_name, expected_local, expected_today, expected_yesterday
):
    context = temporal.build_context(
        timezone_name, now_utc=_utc(2026, 8, 23, 3, 30)
    )

    block = temporal.prompt_block(context)

    assert f"用户本地时间：{expected_local}" in block
    assert f"用户本地今天：{expected_today}；昨天：{expected_yesterday}" in block
    assert "服务器 UTC：2026-08-23T03:30:00Z" in block


def test_message_from_27_hours_ago_is_labeled_one_day_three_hours_ago():
    context = temporal.build_context(
        "America/Chicago", now_utc=_utc(2026, 8, 23, 3, 30)
    )

    annotation = temporal.message_time_annotation(
        _utc(2026, 8, 22, 0, 30), context
    )

    assert "2026-08-21 19:30:00 America/Chicago" in annotation
    assert "距本轮1天3小时" in annotation
    assert "该消息中的今天=2026-08-21，昨天=2026-08-20" in annotation
    assert "不到24小时" not in annotation


def test_crossing_local_midnight_can_be_yesterday_even_under_24_hours():
    context = temporal.build_context(
        "America/Chicago", now_utc=_utc(2026, 8, 23, 5, 30)
    )

    annotation = temporal.message_time_annotation(
        _utc(2026, 8, 23, 4, 45), context
    )
    block = temporal.prompt_block(context)

    assert context.user_local.strftime("%Y-%m-%d %H:%M") == "2026-08-23 00:30"
    assert "2026-08-22 23:45:00 America/Chicago" in annotation
    assert "距本轮45分钟" in annotation
    assert "用户本地今天：2026-08-23；昨天：2026-08-22" in block
    assert "“昨天”表示用户本地日历的前一日，不等同于不足24小时" in block


def test_spring_dst_uses_elapsed_instant_not_wall_clock_difference():
    # Chicago jumps from 01:59:59 CST to 03:00:00 CDT on this date.  The wall
    # clock moves three hours, while only two real hours elapse.
    context = temporal.build_context(
        "America/Chicago", now_utc=_utc(2026, 3, 8, 8, 30)
    )

    annotation = temporal.message_time_annotation(
        _utc(2026, 3, 8, 6, 30), context
    )

    assert context.user_local.strftime("%Y-%m-%d %H:%M %z") == "2026-03-08 03:30 -0500"
    assert "2026-03-08 00:30:00 America/Chicago" in annotation
    assert "距本轮2小时" in annotation
    assert "距本轮3小时" not in annotation


def test_fall_dst_uses_elapsed_instant_through_the_repeated_hour():
    # The repeated 01:00 hour makes the wall-clock gap one hour, but the UTC
    # instants are two hours apart.
    context = temporal.build_context(
        "America/Chicago", now_utc=_utc(2026, 11, 1, 8, 30)
    )

    annotation = temporal.message_time_annotation(
        _utc(2026, 11, 1, 6, 30), context
    )

    assert context.user_local.strftime("%Y-%m-%d %H:%M %z") == "2026-11-01 02:30 -0600"
    assert "2026-11-01 01:30:00 America/Chicago" in annotation
    assert "距本轮2小时" in annotation


@pytest.mark.parametrize(
    "bad_timestamp",
    [None, "", "not-a-timestamp", "2026-13-45T99:99:99Z", object()],
)
def test_bad_or_missing_historical_timestamp_degrades_to_unknown(bad_timestamp):
    context = temporal.build_context("Asia/Shanghai", now_utc=_utc(2026, 8, 23, 3))

    annotation = temporal.message_time_annotation(bad_timestamp, context)

    assert annotation == "历史消息时间：未知"


def test_missing_current_timestamp_uses_server_clock_without_inventing_an_age():
    context = temporal.build_context("UTC", now_utc=_utc(2026, 8, 23, 3))

    annotation = temporal.message_time_annotation(None, context, current=True)

    assert annotation == "本轮消息时间：服务器当前时间"
    assert "距本轮" not in annotation


def test_future_timestamp_is_explicitly_labeled_and_never_becomes_negative_age():
    context = temporal.build_context("UTC", now_utc=_utc(2026, 8, 23, 3))

    annotation = temporal.message_time_annotation(
        _utc(2026, 8, 23, 5), context
    )

    assert "比本轮晚2小时" in annotation
    assert "距本轮-" not in annotation


def test_nuri_messages_keeps_history_times_and_adds_temporal_system_block():
    context = temporal.build_context(
        "America/Chicago", now_utc=_utc(2026, 8, 23, 3, 30)
    )
    history = [
        {
            "role": "user",
            "text": "这件事发生在昨天。",
            "created_at": "2026-08-22T00:30:00Z",
        },
        {
            "role": "ai",
            "text": "我先记下时间。",
            "created_at": "2026-08-22T00:31:00Z",
        },
        {
            "role": "user",
            "text": "现在已经过去多久了？",
            "created_at": "2026-08-23T03:30:00Z",
        },
    ]

    built, _ = nuri_messages(history, temporal_context=context)

    systems = [message["content"] for message in built if message["role"] == "system"]
    conversation = _conversation_messages(built)
    assert any("【本轮时间语义（服务器生成，必须遵守）】" in item for item in systems)
    assert len(conversation) == 3
    assert "2026-08-21 19:30:00 America/Chicago" in conversation[0]["content"]
    assert "距本轮1天3小时" in conversation[0]["content"]
    assert "2026-08-21 19:31:00 America/Chicago" in conversation[1]["content"]
    assert "本轮消息时间：2026-08-22 22:30:00 America/Chicago" in conversation[2]["content"]
    assert conversation[0]["content"].endswith("这件事发生在昨天。")
    assert conversation[2]["content"].endswith("现在已经过去多久了？")


def test_four_model_prompt_path_also_receives_the_temporal_block_and_annotations():
    context = temporal.build_context(
        "Asia/Shanghai", now_utc=_utc(2026, 8, 23, 3, 30)
    )
    history = [
        {
            "role": "user",
            "text": "昨天开始的。",
            "created_at": "2026-08-22T03:30:00Z",
        },
        {
            "role": "user",
            "text": "今天还在继续。",
            "created_at": "2026-08-23T03:30:00Z",
        },
    ]

    built, _ = nuri_messages(
        history,
        system_prompt=CACHE_SEAM.join(("PERSONA", "FAMILY", "TURN")),
        temporal_context=context,
    )

    systems = [message["content"] for message in built if message["role"] == "system"]
    conversation = _conversation_messages(built)
    assert systems[0].startswith("PERSONA")
    assert any("TURN" in item and "用户本地今天：2026-08-23" in item for item in systems)
    assert "历史消息时间：2026-08-22 11:30:00 Asia/Shanghai" in conversation[0]["content"]
    assert "本轮消息时间：2026-08-23 11:30:00 Asia/Shanghai" in conversation[1]["content"]


def test_client_timezone_validation_rejects_non_iana_values():
    with pytest.raises(ValidationError):
        ClientContext(timezone="Chicago")


def test_client_timezone_validation_accepts_supported_iana_values():
    assert ClientContext(timezone="America/Chicago").timezone == "America/Chicago"
    assert ClientContext(timezone="Asia/Shanghai").timezone == "Asia/Shanghai"


def test_declared_client_clock_fields_are_retained_but_do_not_drive_server_time():
    context = ClientContext(
        timezone="America/Chicago",
        utc_offset_minutes=-300,
        locale="zh-CN",
        local_datetime="2026-08-22T09:30:00-05:00",
    )

    assert context.utc_offset_minutes == -300
    assert context.locale == "zh-CN"
    assert context.local_datetime.endswith("-05:00")


def test_annotate_history_copies_messages_and_anchors_each_messages_yesterday():
    context = temporal.build_context("America/Chicago", now_utc=_utc(2026, 8, 23, 3, 30))
    original = [{
        "role": "user",
        "text": "昨天发生的",
        "created_at": "2026-08-21T12:00:00Z",
    }]

    annotated = temporal.annotate_history(original, context)

    assert original[0]["text"] == "昨天发生的"
    assert annotated[0] is not original[0]
    assert "该消息中的今天=2026-08-21，昨天=2026-08-20" in annotated[0]["text"]


def test_parent_stated_follow_up_date_is_local_nine_am_then_saved_as_utc():
    context = temporal.build_context("America/Chicago", now_utc=_utc(2026, 8, 22, 14, 30))

    due_at, source = family_store.follow_up_due_at(
        {"due_date": "2026-08-24", "topic": "回诊"}, context,
    )

    assert source == "stated"
    assert due_at == "2026-08-24T14:00:00+00:00"


def test_rolling_summary_receives_timestamped_transcript(monkeypatch):
    context = temporal.build_context("Asia/Shanghai", now_utc=_utc(2026, 8, 23, 3, 30))
    captured = {}

    async def fake_load(_session_id):
        return "", 0

    async def fake_save(_session_id, summary, covered_tokens):
        captured["saved"] = (summary, covered_tokens)

    def fake_summarize(transcript, previous=""):
        captured["transcript"] = transcript
        return "绝对日期摘要"

    monkeypatch.setattr(state_store, "load", fake_load)
    monkeypatch.setattr(state_store, "save", fake_save)
    monkeypatch.setattr(state_store, "summarize_sync", fake_summarize)
    monkeypatch.setattr(state_store.context_budget, "STATE_REFRESH_TOKENS", 0)
    history = [{
        "role": "user",
        "text": "昨天开始咳嗽",
        "created_at": "2026-08-21T04:00:00Z",
    }]

    asyncio.run(state_store.refresh_if_needed(
        "session-1", history, kept=[], temporal_context=context,
    ))

    assert "历史消息时间：2026-08-21 12:00:00 Asia/Shanghai" in captured["transcript"]
    assert "该消息中的今天=2026-08-21，昨天=2026-08-20" in captured["transcript"]
    assert captured["saved"][0] == "绝对日期摘要"


def test_memory_write_uses_runtime_timestamp_without_shadowing_clock(monkeypatch):
    inserted = []

    class Query:
        mode = "select"

        def select(self, *_args):
            self.mode = "select"
            return self

        def eq(self, *_args):
            return self

        def is_(self, *_args):
            return self

        def insert(self, row):
            inserted.append(row)
            self.mode = "insert"
            return self

        def execute(self):
            return type("Result", (), {"data": []})()

    query = Query()
    monkeypatch.setattr(
        family_store.runtime, "get_supabase",
        lambda: type("Supabase", (), {"table": lambda _self, _name: query})(),
    )
    monkeypatch.setattr(
        family_store, "now", lambda: "2026-08-22T14:30:00+00:00",
    )

    asyncio.run(family_store.upsert_memories(
        [{
            "category": "fact", "key": "事件日期",
            "value": "2026-08-21", "confidence": 0.9,
        }],
        user_id="parent-1", child_id=None,
        source_type="chat", source_id="message-1",
    ))

    assert inserted[0]["created_at"] == "2026-08-22T14:30:00+00:00"
    assert inserted[0]["last_confirmed_at"] == "2026-08-22T14:30:00+00:00"


def _turn_with_temporal_history(context):
    history = [
        {
            "role": "user",
            "text": "昨天开始咳嗽。",
            "created_at": "2026-08-21T12:00:00Z",
        },
        {
            "role": "ai",
            "text": "先观察精神和呼吸。",
            "created_at": "2026-08-21T12:01:00Z",
        },
        {
            "role": "user",
            "text": "现在已经多久了？",
            "created_at": context.server_utc.isoformat(),
        },
    ]
    turn = main._Turn(
        session={"id": "session-1", "user_id": "parent-1"},
        owner_uid="parent-1",
        user_msg=history[-1],
        msgs=history,
        context_hints={},
        fix_text=None,
        temporal=context,
    )
    return turn, history


def _assert_single_temporal_annotation_per_message(received, original):
    assert len(received) == len(original)
    for annotated, stored in zip(received, original):
        assert annotated is not stored
        assert annotated["text"].count("消息时间：") == 1
        assert annotated["text"].endswith(stored["text"])
        assert stored["text"].count("消息时间：") == 0
    assert "该消息中的今天=2026-08-21，昨天=2026-08-20" in received[0]["text"]
    assert "本轮消息时间：" in received[-1]["text"]


def test_linear_router_receives_timestamped_history_once(monkeypatch):
    context = temporal.build_context(
        "America/Chicago", now_utc=_utc(2026, 8, 23, 3, 30)
    )
    turn, original = _turn_with_temporal_history(context)
    captured = {}

    async def fake_route(history, **_kwargs):
        captured["history"] = history
        return TurnRoute(needs_search=False)

    monkeypatch.setattr(main, "route_turn", fake_route)

    route, results = asyncio.run(main._route_and_search(turn, "", None))

    assert route.needs_search is False
    assert results == []
    _assert_single_temporal_annotation_per_message(captured["history"], original)


def test_four_model_router_receives_timestamped_history_once(monkeypatch):
    context = temporal.build_context(
        "America/Chicago", now_utc=_utc(2026, 8, 23, 3, 30)
    )
    turn, original = _turn_with_temporal_history(context)
    captured = {}

    async def fake_run_turn_context(**kwargs):
        captured["history"] = kwargs["history"]
        return SimpleNamespace(
            trace=SimpleNamespace(timings={}, metrics_row=lambda: {}),
            search_results=[],
            card="",
            memory="",
            profile="",
            state="",
            style="",
            internal="",
            sources="",
            route=TurnRoute(needs_search=False),
            plan=None,
            family=None,
            evidence=None,
        )

    monkeypatch.setattr(main, "run_turn_context", fake_run_turn_context)

    result = asyncio.run(
        main._reply_context_four_model(
            turn, main.UserMessageIn(text="现在已经多久了？"), None,
        )
    )

    assert result.route.needs_search is False
    _assert_single_temporal_annotation_per_message(captured["history"], original)


def _turn_with_child_pii_for_routing():
    context = temporal.build_context(
        "America/Chicago", now_utc=_utc(2026, 8, 24, 12, 0)
    )
    history = [
        {
            "role": "user",
            "text": "你知道小啊谷的生日吗？",
            "created_at": "2026-08-24T11:58:00Z",
        },
        {
            "role": "ai",
            "text": "小啊谷的生日是2025年10月10日。",
            "created_at": "2026-08-24T11:59:00Z",
        },
        {
            "role": "user",
            "text": "那语言发展呢？",
            "created_at": context.server_utc.isoformat(),
        },
    ]
    return main._Turn(
        session={"id": "session-1", "user_id": "parent-1"},
        owner_uid="parent-1",
        user_msg=history[-1],
        msgs=history,
        context_hints={
            "children": [{
                "nickname": "小啊谷",
                "birth_date": "2025-10-10",
            }],
        },
        fix_text=None,
        temporal=context,
    )


def test_linear_pipeline_redacts_child_pii_before_router(monkeypatch):
    turn = _turn_with_child_pii_for_routing()
    captured = {}

    async def fake_route(history, **kwargs):
        captured["history"] = history
        captured["sensitive_children"] = kwargs.get("sensitive_children")
        return TurnRoute(needs_search=False)

    monkeypatch.setattr(main, "route_turn", fake_route)
    asyncio.run(main._route_and_search(turn, "孩子当前年龄：10个月", None))

    routed_text = "\n".join(message["text"] for message in captured["history"])
    assert "小啊谷" not in routed_text
    assert "2025年10月10日" not in routed_text
    assert "10个月" in routed_text
    assert captured["sensitive_children"] == turn.context_hints["children"]


def test_four_model_pipeline_redacts_child_pii_before_router(monkeypatch):
    turn = _turn_with_child_pii_for_routing()
    captured = {}

    async def fake_route(history, **kwargs):
        captured["history"] = history
        captured["sensitive_children"] = kwargs.get("sensitive_children")
        return TurnRoute(needs_search=False)

    async def fake_run_turn_context(**kwargs):
        route = await kwargs["route_turn"](
            kwargs["history"], client=None, child_context="孩子当前年龄：10个月",
        )
        return SimpleNamespace(
            trace=SimpleNamespace(timings={}, metrics_row=lambda: {}),
            search_results=[], card="", memory="", profile="", state="",
            style="", internal="", sources="", route=route, plan=None,
            family=None, evidence=None,
        )

    monkeypatch.setattr(main, "route_turn", fake_route)
    monkeypatch.setattr(main, "run_turn_context", fake_run_turn_context)
    asyncio.run(main._reply_context_four_model(
        turn, main.UserMessageIn(text="那语言发展呢？"), None,
    ))

    routed_text = "\n".join(message["text"] for message in captured["history"])
    assert "小啊谷" not in routed_text
    assert "2025年10月10日" not in routed_text
    assert "10个月" in routed_text
    assert captured["sensitive_children"] == turn.context_hints["children"]


class _CapturingSyncClient:
    def __init__(self, content):
        self.content = content
        self.calls = []
        self.chat = self
        self.completions = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = SimpleNamespace(content=self.content)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message)], usage=None,
        )


def test_summary_model_prompt_pins_absolute_date_normalization(monkeypatch):
    client = _CapturingSyncClient("孩子于2026-08-20开始咳嗽。")
    monkeypatch.setattr(state_store, "oai", client)
    monkeypatch.setattr(state_store.llm_usage, "record", lambda *_args, **_kwargs: None)
    transcript = (
        "家长：[历史消息时间：2026-08-21 12:00:00 Asia/Shanghai；"
        "该消息中的今天=2026-08-21，昨天=2026-08-20；距本轮2天]\n"
        "昨天开始咳嗽"
    )

    result = state_store.summarize_sync(
        transcript,
        previous="孩子在2026-08-19夜里睡得不好。",
    )

    prompt = client.calls[0]["messages"][0]["content"]
    assert result == "孩子于2026-08-20开始咳嗽。"
    assert "[已有摘要]\n孩子在2026-08-19夜里睡得不好。" in prompt
    assert "[新增对话]" in prompt and "昨天=2026-08-20" in prompt
    assert "改写成能确定的绝对日期或明确持续时长" in prompt
    assert "具体日期未确认" in prompt
    assert "绝不能把旧消息里的相对时间当成生成摘要当天" in prompt


def test_memory_extraction_prompt_receives_message_anchors_and_clock(monkeypatch):
    response = json.dumps(
        {
            "memories": [
                {
                    "category": "child_state",
                    "key": "咳嗽开始日期",
                    "value": "2026-08-20",
                    "confidence": 0.9,
                }
            ],
            "follow_ups": [
                {
                    "topic": "咳嗽恢复",
                    "note": "确认2026-08-20开始的咳嗽是否好转",
                    "due_date": "2026-08-24",
                }
            ],
        },
        ensure_ascii=False,
    )
    client = _CapturingSyncClient(response)
    monkeypatch.setattr(family_store, "oai", client)
    monkeypatch.setattr(family_store.llm_usage, "record", lambda *_args, **_kwargs: None)
    context = temporal.build_context(
        "Asia/Shanghai", now_utc=_utc(2026, 8, 23, 3, 30)
    )
    history = [{
        "role": "user",
        "text": "昨天开始咳嗽，明天如果没好就去复诊。",
        "created_at": "2026-08-21T04:00:00Z",
    }]

    extracted = family_store.extract_memories_sync(history, context)

    request = client.calls[0]["messages"]
    system, conversation = request[0]["content"], request[1]["content"]
    assert "用户本地今天：2026-08-23；昨天：2026-08-22" in system
    assert "将相对日期规范化为用户当地的绝对日期" in system
    assert "无法从时间标注确定的日期不要猜" in system
    assert "该消息中的今天=2026-08-21，昨天=2026-08-20" in conversation
    assert history[0]["text"] == "昨天开始咳嗽，明天如果没好就去复诊。"
    assert extracted["memories"][0]["value"] == "2026-08-20"
    assert extracted["follow_ups"][0]["due_date"] == "2026-08-24"


def test_memory_pipeline_forwards_the_same_temporal_context_to_follow_up(monkeypatch):
    context = temporal.build_context(
        "America/Chicago", now_utc=_utc(2026, 8, 23, 3, 30)
    )
    captured = {}

    def fake_extract(history, temporal_context=None):
        captured["extract_context"] = temporal_context
        return {
            "memories": [],
            "follow_ups": [{
                "topic": "复诊", "note": "确认恢复情况", "due_date": "2026-08-24",
            }],
        }

    async def fake_upsert_memories(*_args, **_kwargs):
        return None

    async def fake_upsert_follow_ups(items, **kwargs):
        captured["follow_ups"] = items
        captured["upsert_context"] = kwargs.get("temporal_context")

    monkeypatch.setattr(family_store, "worth_extracting", lambda _history: True)
    monkeypatch.setattr(family_store, "extract_memories_sync", fake_extract)
    monkeypatch.setattr(family_store, "upsert_memories", fake_upsert_memories)
    monkeypatch.setattr(family_store, "upsert_follow_ups", fake_upsert_follow_ups)
    monkeypatch.setattr(family, "invalidate", lambda _uid: None)

    asyncio.run(family.extract_and_upsert_memories(
        [{
            "role": "user", "text": "明天如果还没好就去复诊。",
            "created_at": "2026-08-22T03:30:00Z",
        }],
        "parent-1",
        "message-1",
        temporal_context=context,
    ))

    assert captured["extract_context"] is context
    assert captured["upsert_context"] is context
    assert captured["follow_ups"][0]["due_date"] == "2026-08-24"


@pytest.mark.parametrize(
    "timezone_name,now_utc,due_date,expected_due_at",
    [
        # The target is after Chicago's spring DST transition: 09:00 is CDT.
        (
            "America/Chicago",
            _utc(2026, 3, 1, 15),
            "2026-03-09",
            "2026-03-09T14:00:00+00:00",
        ),
        (
            "Asia/Shanghai",
            _utc(2026, 8, 22, 14, 30),
            "2026-08-24",
            "2026-08-24T01:00:00+00:00",
        ),
        # A stale date is moved to tomorrow in the parent's local calendar.
        (
            "America/Chicago",
            _utc(2026, 8, 23, 3, 30),
            "2026-08-20",
            "2026-08-23T14:00:00+00:00",
        ),
    ],
)
def test_parent_stated_follow_up_uses_target_dates_local_nine_am(
    timezone_name, now_utc, due_date, expected_due_at
):
    context = temporal.build_context(timezone_name, now_utc=now_utc)

    due_at, source = family_store.follow_up_due_at(
        {"due_date": due_date, "topic": "复诊"}, context,
    )

    assert source == "stated"
    assert due_at == expected_due_at
