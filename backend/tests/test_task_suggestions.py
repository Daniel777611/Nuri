"""Regression coverage for NURI's two task-card triggers."""

import asyncio
import json
import sys
from pathlib import Path

import pytest
from fastapi import BackgroundTasks
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import memstore, runtime  # noqa: E402
from backend import main  # noqa: E402
from backend.router import TurnRoute  # noqa: E402


@pytest.mark.parametrize(
    "text",
    [
        "请给我生成三个任务",
        "把刚才的方案整理成任務卡",
        "给我一个计划",
        "把刚才的方案做成任务卡",
        "不要解释，直接给我一个任务",
        "帮我做一个任务",
        "我想要一个任务",
        "我需要一个任务卡",
        "可以布置一个任务吗",
        "不用再问了，直接给我三个任务",
        "别的问题先不说，给我三个任务",
        "我不要泛泛建议，给我任务",
        "Can you turn this into two task cards for me?",
        "Please create a checklist from that plan.",
    ],
)
def test_explicit_task_requests_are_deterministic(text):
    assert main._user_requested_tasks(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "先不要生成任务卡",
        "不用把它整理成计划",
        "我完成了今天的任务",
        "任务卡是什么？",
        "Don't create tasks yet.",
        "给我三个任务，不过现在先不要生成任务卡",
    ],
)
def test_task_mentions_and_declines_do_not_false_trigger(text):
    assert main._user_requested_tasks(text) is False


@pytest.mark.parametrize(
    "text",
    [
        "列出这个计划的优缺点",
        "可以给我讲讲这个计划吗",
        "Create a summary of this plan",
        "Give me information about task cards",
        "Can you add more detail to this plan?",
    ],
)
def test_plan_information_requests_do_not_create_tasks(text):
    assert main._user_requested_tasks(text) is False


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("给我三个任务", 3),
        ("生成兩個任務卡", 2),
        ("Create one task for me", 1),
        ("Please make four task cards", 4),
        ("帮我整理成任务", None),
    ],
)
def test_requested_task_count(text, expected):
    assert main._requested_task_count(text) == expected


def _proposal(title: str, *, scope: str = "today") -> dict:
    return {
        "title": title,
        "scope": scope,
        "task_type": "interaction",
        "description": f"完成{title}",
        "steps": [f"先做{title}", "记录结果"],
    }


def test_primary_reply_carries_validated_task_proposals():
    parsed = main._parse_nuri_reply(
        json.dumps(
            {
                "text": "今天先试两个小步骤。",
                "quick_replies": [],
                "suggest_tasks": True,
                "task_proposals": [
                    _proposal("固定睡前顺序"),
                    _proposal("固定睡前顺序"),
                    {
                        "title": "记录夜醒",
                        "scope": "invalid",
                        "task_type": "invalid",
                        "description": "",
                        "steps": ["记录时间"],
                    },
                ],
            },
            ensure_ascii=False,
        )
    )

    assert parsed["suggest_tasks"] is True
    assert [task["title"] for task in parsed["task_proposals"]] == [
        "固定睡前顺序",
        "记录夜醒",
    ]
    assert parsed["task_proposals"][1]["scope"] == "today"
    assert parsed["task_proposals"][1]["task_type"] == "interaction"
    assert parsed["task_proposals"][1]["description"] == "记录时间"


def test_actionable_reply_uses_primary_proposals_even_after_old_task_cards(monkeypatch):
    def should_not_run(*_args, **_kwargs):
        raise AssertionError("primary proposals should not need a second model call")

    monkeypatch.setattr(main, "_gen_tasks_ai_sync", should_not_run)
    history_with_old_card = [
        {
            "role": "ai",
            "text": "旧建议",
            "transition": {"kind": "task_suggestion", "tasks": [_proposal("旧任务")]},
        },
        {"role": "user", "text": "这次是新的睡眠问题"},
    ]
    reply = {
        "text": "今晚先固定洗澡、读书、关灯的顺序。",
        "quick_replies": [],
        "suggest_tasks": True,
        "task_proposals": [_proposal("固定睡前顺序", scope="week")],
    }

    transition = asyncio.run(
        main._task_suggestion(
            reply,
            history_with_old_card,
            "孩子最近入睡很困难",
            reply["text"],
        )
    )

    assert transition["kind"] == "task_suggestion"
    assert transition["trigger"] == "actionable_reply"
    assert transition["tasks"][0]["title"] == "固定睡前顺序"


def test_explicit_request_forces_fallback_and_includes_current_ai_plan(monkeypatch):
    captured = {}

    def generate(msgs, requested_count=None):
        captured["msgs"] = msgs
        captured["requested_count"] = requested_count
        return [_proposal("练习平静回应"), _proposal("记录用餐变化")]

    monkeypatch.setattr(main, "_gen_tasks_ai_sync", generate)
    reply = {
        "text": "这周可以先练习平静回应，并记录孩子离桌的次数。",
        "quick_replies": [],
        "suggest_tasks": False,
        "task_proposals": [],
    }

    transition = asyncio.run(
        main._task_suggestion(
            reply,
            [{"role": "user", "text": "孩子吃饭总离桌"}],
            "请把刚才的方案生成两个任务",
            reply["text"],
        )
    )

    assert transition["trigger"] == "explicit_request"
    assert len(transition["tasks"]) == 2
    assert captured["requested_count"] == 2
    assert captured["msgs"][-1] == {"role": "ai", "text": reply["text"]}


def test_user_requested_count_truncates_primary_proposals(monkeypatch):
    monkeypatch.setattr(
        main,
        "_gen_tasks_ai_sync",
        lambda *_args, **_kwargs: pytest.fail("fallback should not run"),
    )
    reply = {
        "text": "我整理好了。",
        "suggest_tasks": True,
        "task_proposals": [_proposal("任务一"), _proposal("任务二"), _proposal("任务三")],
    }

    transition = asyncio.run(
        main._task_suggestion(
            reply,
            [],
            "只给我一个任务",
            reply["text"],
        )
    )

    assert [task["title"] for task in transition["tasks"]] == ["任务一"]


def test_user_requested_count_fills_missing_primary_proposals(monkeypatch):
    monkeypatch.setattr(
        main,
        "_gen_tasks_ai_sync",
        lambda *_args, **_kwargs: [
            _proposal("任务二"),
            _proposal("任务三"),
            _proposal("任务四"),
        ],
    )
    reply = {
        "text": "我先整理了一个行动，并补齐其他可选行动。",
        "suggest_tasks": True,
        "task_proposals": [_proposal("任务一")],
    }

    transition = asyncio.run(
        main._task_suggestion(reply, [], "给我四个任务", reply["text"])
    )

    assert [task["title"] for task in transition["tasks"]] == [
        "任务一",
        "任务二",
        "任务三",
        "任务四",
    ]


def test_proposals_cannot_trigger_when_model_declines(monkeypatch):
    monkeypatch.setattr(
        main,
        "_gen_tasks_ai_sync",
        lambda *_args, **_kwargs: pytest.fail("a disabled turn must stay disabled"),
    )
    reply = {
        "text": "我需要先了解孩子的年龄。",
        "suggest_tasks": False,
        "task_proposals": [_proposal("不应出现")],
    }

    transition = asyncio.run(
        main._task_suggestion(reply, [], "孩子最近睡不好", reply["text"])
    )

    assert transition is None


def test_task_decline_overrides_model_suggestion(monkeypatch):
    monkeypatch.setattr(
        main,
        "_gen_tasks_ai_sync",
        lambda *_args, **_kwargs: pytest.fail("declined tasks must not be generated"),
    )
    reply = {
        "text": "我先把建议放在这里。",
        "suggest_tasks": True,
        "task_proposals": [_proposal("不应出现")],
    }

    transition = asyncio.run(
        main._task_suggestion(
            reply,
            [],
            "先不要生成任务卡",
            reply["text"],
        )
    )

    assert transition is None


def test_emergency_request_never_falls_back_to_routine_tasks(monkeypatch):
    monkeypatch.setattr(
        main,
        "_gen_tasks_ai_sync",
        lambda *_args, **_kwargs: pytest.fail("urgent turns must not generate tasks"),
    )
    reply = {
        "text": "孩子喘不上气时请立即拨打 911，不要等待普通建议。",
        "suggest_tasks": False,
        "task_proposals": [],
    }

    transition = asyncio.run(
        main._task_suggestion(
            reply,
            [],
            "孩子现在喘不上气，给我一个任务",
            reply["text"],
        )
    )

    assert transition is None


def test_clarifying_turn_does_not_generate_tasks(monkeypatch):
    monkeypatch.setattr(
        main,
        "_gen_tasks_ai_sync",
        lambda *_args, **_kwargs: pytest.fail("clarifying turns must not generate tasks"),
    )
    reply = {
        "text": "这种情况大概持续多久了？",
        "suggest_tasks": False,
        "task_proposals": [],
    }

    transition = asyncio.run(
        main._task_suggestion(reply, [], "孩子最近总哭", reply["text"])
    )

    assert transition is None


def test_non_streaming_turn_can_generate_again_in_a_long_lived_session(monkeypatch):
    session_id = "main-long-lived"
    old_transition = {
        "id": "old-ai",
        "session_id": session_id,
        "role": "ai",
        "text": "上个月的方案",
        "quick_replies": [],
        "transition": {"kind": "task_suggestion", "tasks": [_proposal("旧任务")]},
        "created_at": "2026-06-01T00:00:00+00:00",
    }
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)
    monkeypatch.setattr(
        memstore, "sessions",
        {
            session_id: {
                "id": session_id,
                "user_id": "parent-1",
                "source_card_id": None,
                "title": "长期主会话",
                "created_at": "2026-06-01T00:00:00+00:00",
            }
        },
    )
    monkeypatch.setattr(
        memstore, "messages",
        {
            session_id: [
                {
                    "id": "old-user",
                    "session_id": session_id,
                    "role": "user",
                    "text": "上个月的问题",
                    "created_at": "2026-06-01T00:00:00+00:00",
                },
                old_transition,
            ]
        },
    )
    monkeypatch.setattr(main, "oai", object())

    async def reply_context(*_args, **_kwargs):
        # A _ReplyContext, not a bare tuple: the block now also carries the
        # turn's route and any sources fetched for it, and the reply paths read
        # those by name.
        return main._ReplyContext(
            card="", memory="", profile="", style="", internal="",
            sources="", route=TurnRoute(), search_results=[],
        )

    monkeypatch.setattr(main, "_reply_context", reply_context)
    monkeypatch.setattr(
        main,
        "_nuri_reply_sync",
        lambda *_args, **_kwargs: {
            "text": "这次先固定睡前顺序。",
            "quick_replies": [],
            "suggest_tasks": True,
            "task_proposals": [_proposal("固定睡前顺序", scope="week")],
        },
    )

    result = asyncio.run(
        main.post_message(
            session_id,
            main.UserMessageIn(text="这是一个新的睡眠问题"),
            BackgroundTasks(),
            uid="parent-1",
        )
    )

    transition = result["ai_messages"][0]["transition"]
    assert transition["kind"] == "task_suggestion"
    assert transition["tasks"][0]["title"] == "固定睡前顺序"


def test_database_failure_does_not_return_a_fake_saved_task(monkeypatch):
    class BrokenTable:
        def insert(self, _task):
            return self

        def execute(self):
            raise RuntimeError("database unavailable")

    class BrokenSupabase:
        def table(self, _name):
            return BrokenTable()

    memory_tasks = []
    monkeypatch.setattr(runtime, "get_supabase", lambda: BrokenSupabase())
    monkeypatch.setattr(memstore, "tasks", memory_tasks)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            main.create_task(
                main.TaskCreate(
                    title="固定睡前顺序",
                    scope="week",
                    description="连续七天保持相同顺序",
                    steps=["洗漱", "读书", "关灯"],
                ),
                uid="parent-1",
            )
        )

    assert exc.value.status_code == 503
    assert memory_tasks == []


def test_task_creation_requires_authentication():
    response = TestClient(main.app).post(
        "/api/tasks",
        json={"title": "不应匿名保存", "scope": "today"},
    )

    assert response.status_code == 401


def test_task_proposal_accept_is_idempotent_without_database(monkeypatch):
    memory_tasks = []
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)
    monkeypatch.setattr(memstore, "tasks", memory_tasks)
    body = main.TaskCreate(
        title="固定睡前顺序",
        scope="week",
        description="本周持续练习同一个睡前顺序",
        steps=["洗漱", "读书", "关灯"],
        source_message_id="message-123",
        suggestion_index=0,
    )

    first = asyncio.run(main.create_task(body, uid="parent-1"))
    second = asyncio.run(main.create_task(body, uid="parent-1"))

    assert first["id"] == second["id"]
    assert first["source"] == "NURI 对话:message-123:0"
    assert len(memory_tasks) == 1
