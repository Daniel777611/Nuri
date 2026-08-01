"""Coverage for conversation-linked, curated learning recommendations."""

import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import main  # noqa: E402
from backend.content_library import (  # noqa: E402
    LEARNING_CONTENT_CARDS,
    SUPPORTED_RESOURCE_LOCALES,
    TAIWAN_AUTHORITY_RESOURCE_HOSTS,
    TRUSTED_RESOURCE_HOSTS,
    is_trusted_resource_url,
    order_learning_resources,
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


def _run_personalized(
    monkeypatch,
    uid,
    sessions,
    messages,
    privacy=None,
    count=4,
    research_client=None,
):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)
    monkeypatch.setattr(main, "_sessions", {item["id"]: item for item in sessions})
    monkeypatch.setattr(main, "_messages", messages)
    # Keep deterministic ranking tests independent of developer-machine API
    # credentials. Tests for open-topic research opt in with a sentinel client.
    monkeypatch.setattr(main, "content_research_oai", research_client)

    async def verified_privacy(request_uid, fail_closed=False):
        del fail_closed
        stored = (privacy or {}).get(request_uid)
        return main._normalized_privacy_settings(stored)

    # Ranking tests use the in-memory conversation fallback, but privacy must
    # still be treated as a successfully verified setting. Storage-failure
    # behavior is covered independently below.
    monkeypatch.setattr(main, "_db_get_privacy", verified_privacy)
    return asyncio.run(main.get_personalized_feed(count=count, uid=uid))


class _ChatQueryResult:
    def __init__(self, data):
        self.data = data


class _ChatQuery:
    def __init__(self, rows):
        self.rows = list(rows)
        self.filters = []
        self.orders = []
        self.row_limit = None

    def select(self, *_args):
        return self

    def eq(self, field, value):
        self.filters.append(("eq", field, value))
        return self

    def in_(self, field, values):
        self.filters.append(("in", field, set(values)))
        return self

    def lte(self, field, value):
        self.filters.append(("lte", field, value))
        return self

    def order(self, field, desc=False):
        self.orders.append((field, desc))
        return self

    def limit(self, value):
        self.row_limit = value
        return self

    def execute(self):
        rows = list(self.rows)
        for operation, field, value in self.filters:
            if operation == "eq":
                rows = [row for row in rows if row.get(field) == value]
            elif operation == "in":
                rows = [row for row in rows if row.get(field) in value]
            else:
                rows = [row for row in rows if str(row.get(field) or "") <= value]
        for field, desc in reversed(self.orders):
            rows.sort(key=lambda row: str(row.get(field) or ""), reverse=desc)
        if self.row_limit is not None:
            rows = rows[: self.row_limit]
        return _ChatQueryResult(rows)


class _ChatSupabase:
    def __init__(self, sessions, messages):
        self.sessions = sessions
        self.messages = messages

    def table(self, name):
        if name == "chat_sessions":
            return _ChatQuery(self.sessions)
        if name == "chat_messages":
            return _ChatQuery(self.messages)
        raise AssertionError(name)


def test_personalized_feed_requires_login():
    with TestClient(main.app) as client:
        response = client.get("/api/feed/personalized")

    assert response.status_code == 401


def test_memory_feed_is_uid_scoped_excludes_card_sessions_and_matches_sleep(
    monkeypatch,
):
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


def test_supabase_long_current_chat_keeps_substantive_cross_session_goal(monkeypatch):
    sessions = [
        {
            **_session("history-main", "parent-1", created_at="2026-07-31T09:00:00+00:00"),
        },
        {
            **_session("current-main", "parent-1", created_at="2026-08-01T09:00:00+00:00"),
        },
    ]
    messages = [
        {
            **_message(
                f"current-{index:02d}",
                "user",
                "给我一些任务吧。",
                f"2026-08-01T10:{index:02d}:00+00:00",
            ),
            "session_id": "current-main",
        }
        for index in range(40)
    ]
    messages.extend(
        [
            {
                **_message(
                    "history-specific",
                    "user",
                    "九个月宝宝需要练习轮流发声和语言理解。",
                    "2026-07-31T10:00:00+00:00",
                ),
                "session_id": "history-main",
            },
            {
                **_message(
                    "history-ack",
                    "user",
                    "好的，谢谢。",
                    "2026-07-31T10:01:00+00:00",
                ),
                "session_id": "history-main",
            },
            {
                **_message(
                    "history-action",
                    "user",
                    "也给我一些任务吧。",
                    "2026-07-31T10:02:00+00:00",
                ),
                "session_id": "history-main",
            },
        ]
    )
    supabase = _ChatSupabase(sessions, messages)
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "content_research_oai", None)

    async def verified_privacy(_uid, fail_closed=False):
        del fail_closed
        return main._normalized_privacy_settings({})

    async def skip_snapshots(_uid, cards, _context):
        return cards

    monkeypatch.setattr(main, "_db_get_privacy", verified_privacy)
    monkeypatch.setattr(main, "_attach_recommendation_snapshots", skip_snapshots)

    payload = asyncio.run(main.get_personalized_feed(count=4, uid="parent-1"))

    assert payload["personalization_mode"] == "conversation"
    assert payload["items"][0]["id"] == "learn_language_milestones"
    assert payload["items"][0]["recommendation_intent"] == "action_plan"
    assert "轮流发声" in payload["items"][0]["personalization_reason"]
    assert payload["history_session_count"] == 1
    assert payload["history_user_message_count"] == 3


def test_supabase_missing_requested_session_does_not_fall_through(monkeypatch):
    sessions = [_session("different-main", "parent-1")]
    messages = [
        {
            **_message(
                "different-user",
                "user",
                "这是另一段仍然存在的对话。",
                "2026-08-01T10:00:00+00:00",
            ),
            "session_id": "different-main",
        }
    ]
    monkeypatch.setattr(main, "_get_supabase", lambda: _ChatSupabase(sessions, messages))

    async def verified_privacy(_uid, fail_closed=False):
        del fail_closed
        return main._normalized_privacy_settings({})

    monkeypatch.setattr(main, "_db_get_privacy", verified_privacy)
    context = asyncio.run(
        main._load_recent_main_chat(
            "parent-1",
            preferred_session_id="deleted-main",
            through_created_at="2026-07-31T10:00:00+00:00",
        )
    )

    assert context["state"] == "context_not_found"
    assert context["session_id"] is None
    assert context["messages"] == []


def test_memory_missing_requested_session_does_not_fall_through(monkeypatch):
    sessions = [_session("different-main", "parent-1")]
    messages = {
        "different-main": [
            _message(
                "different-user",
                "user",
                "这是另一段仍然存在的对话。",
                "2026-08-01T10:00:00+00:00",
            )
        ]
    }
    monkeypatch.setattr(main, "_get_supabase", lambda: None)
    monkeypatch.setattr(main, "_sessions", {item["id"]: item for item in sessions})
    monkeypatch.setattr(main, "_messages", messages)

    async def verified_privacy(_uid, fail_closed=False):
        del fail_closed
        return main._normalized_privacy_settings({})

    monkeypatch.setattr(main, "_db_get_privacy", verified_privacy)
    context = asyncio.run(
        main._load_recent_main_chat(
            "parent-1",
            preferred_session_id="deleted-main",
            through_created_at="2026-07-31T10:00:00+00:00",
        )
    )

    assert context["state"] == "context_not_found"
    assert context["session_id"] is None
    assert context["messages"] == []


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
    assert all(
        item.get("related_session_id") != "other-main" for item in payload["items"]
    )


def test_latest_development_question_outranks_older_sleep_context(monkeypatch):
    sessions = [_session("parent-main", "parent-1")]
    messages = {
        "parent-main": [
            _message(
                "old-sleep-user",
                "user",
                "孩子前几天夜醒、睡眠差、作息乱，睡前也总是哭闹。",
                "2026-07-29T10:00:00+00:00",
            ),
            _message(
                "old-sleep-ai",
                "ai",
                "可以先固定睡前节奏并记录夜醒。",
                "2026-07-29T10:01:00+00:00",
            ),
            _message(
                "latest-development-user",
                "user",
                "孩子现在9个月，这个阶段有什么关键期和需要关注的发展？",
                "2026-07-31T10:00:00+00:00",
            ),
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] == "conversation"
    assert payload["items"][0]["id"] == "learn_development_milestones"
    assert payload["items"][0]["is_conversation_match"] is True


def test_negated_sleep_topic_does_not_beat_explicit_picky_eating_topic(monkeypatch):
    sessions = [_session("parent-main", "parent-1")]
    messages = {
        "parent-main": [
            _message(
                "latest-user",
                "user",
                "这不是睡眠问题，主要是孩子最近很挑食。",
                "2026-07-31T10:00:00+00:00",
            )
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] == "conversation"
    assert payload["items"][0]["id"] == "learn_picky_eating"
    assert payload["items"][0]["is_conversation_match"] is True


def test_english_negated_sleep_topic_does_not_beat_picky_eating(monkeypatch):
    sessions = [_session("parent-main", "parent-1")]
    messages = {
        "parent-main": [
            _message(
                "latest-user",
                "user",
                "Sleep isn't the problem; my child is a picky eater.",
                "2026-07-31T10:00:00+00:00",
            )
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] == "conversation"
    assert payload["items"][0]["id"] == "learn_picky_eating"
    assert payload["items"][0]["is_conversation_match"] is True


def test_rejecting_previous_topic_does_not_reuse_assistant_context(monkeypatch):
    sessions = [_session("parent-main", "parent-1")]
    messages = {
        "parent-main": [
            _message(
                "assistant-sleep",
                "ai",
                "我们可以继续讨论夜醒、哄睡和睡前作息。",
                "2026-07-31T09:59:00+00:00",
            ),
            _message(
                "latest-user",
                "user",
                "我不想继续聊这个，换个话题。",
                "2026-07-31T10:00:00+00:00",
            ),
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] != "conversation"
    assert payload["matched_topic"] is None
    assert all(item["is_conversation_match"] is False for item in payload["items"])


def test_latest_hitting_problem_outranks_keyword_rich_older_sleep_context(monkeypatch):
    sessions = [_session("parent-main", "parent-1")]
    messages = {
        "parent-main": [
            _message(
                "old-sleep-user",
                "user",
                "孩子前几天夜醒、睡眠差、作息乱，睡前也很难哄睡。",
                "2026-07-29T10:00:00+00:00",
            ),
            _message(
                "old-sleep-ai",
                "ai",
                "固定睡前节奏通常有助于改善夜醒。",
                "2026-07-29T10:01:00+00:00",
            ),
            _message(
                "latest-behavior-user",
                "user",
                "这是另一个问题：孩子最近总打人，我应该怎么处理？",
                "2026-07-31T10:00:00+00:00",
            ),
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] == "conversation"
    assert payload["items"][0]["id"] == "learn_tantrum_boundaries"
    assert payload["items"][0]["is_conversation_match"] is True


def test_english_keyword_matching_uses_word_boundaries(monkeypatch):
    sessions = [_session("parent-main", "parent-1")]
    messages = {
        "parent-main": [
            _message(
                "latest-user",
                "user",
                "My child displays pictures at school.",
                "2026-07-31T10:00:00+00:00",
            )
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    # "displays" must not accidentally match the static "play" term.  The
    # real, otherwise-unmapped question now receives a dynamic research card.
    assert payload["personalization_mode"] == "conversation"
    assert payload["items"][0]["is_dynamic_research_card"] is True
    assert payload["items"][0]["topic"] == "My child displays pictures at school"
    assert all(
        not item.get("is_conversation_match")
        for item in payload["items"][1:]
    )


def test_assistant_boilerplate_cannot_establish_a_conversation_match(monkeypatch):
    sessions = [_session("parent-main", "parent-1")]
    messages = {
        "parent-main": [
            _message(
                "latest-user",
                "user",
                "谢谢。",
                "2026-07-31T10:00:00+00:00",
            ),
            _message(
                "generic-ai",
                "ai",
                "平时可以关注孩子的情绪、表达、沟通、陪伴和互动。",
                "2026-07-31T10:01:00+00:00",
            ),
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] != "conversation"
    assert payload["matched_topic"] is None
    assert all(item["is_conversation_match"] is False for item in payload["items"])


def test_unmapped_conversation_gets_addressable_dynamic_research_card(monkeypatch):
    sessions = [_session("montessori-chat", "parent-1")]
    messages = {
        "montessori-chat": [
            _message(
                "latest-user",
                "user",
                "我们正在考虑让孩子上哪一种幼儿园，蒙特梭利和森林学校该怎么选择？",
                "2026-07-31T10:00:00+00:00",
            )
        ]
    }

    payload = _run_personalized(
        monkeypatch,
        "parent-1",
        sessions,
        messages,
        privacy={
            "parent-1": {
                "allow_history_training": True,
                "allow_external_content_research": True,
            }
        },
        research_client=object(),
    )

    card = payload["items"][0]
    assert payload["personalization_mode"] == "conversation"
    assert payload["matched_topic"] == card["topic"]
    assert payload["related_session_id"] == "montessori-chat"
    assert card["id"].startswith("learn_conversation_")
    assert card["is_dynamic_research_card"] is True
    assert card["is_conversation_match"] is True
    assert card["related_session_id"] == "montessori-chat"
    assert card["context_created_at"] == "2026-07-31T10:00:00+00:00"
    assert card["resource_status"] == "research_on_open"
    assert "蒙特梭利" in card["title"]
    assert all(
        all(count == 0 for count in category.values())
        for category in card["resource_summary"]["categories"].values()
    )


@pytest.mark.parametrize(
    "topic_text, expected_fragment",
    [
        (
            "我们在比较 Montessori 蒙特梭利和 forest school 森林学校，应该怎么选？",
            "Montessori",
        ),
        (
            "孩子的堂兄经常排挤和羞辱他，这种亲属之间的霸凌该怎么处理？",
            "亲属之间的霸凌",
        ),
        (
            "我们刚移居到另一个国家，怎样帮助孩子适应新的文化和学校？",
            "移居",
        ),
    ],
    ids=["montessori-forest-school", "relative-bullying", "relocation-adjustment"],
)
def test_novel_real_topics_are_conversation_matches_and_can_research(
    monkeypatch, topic_text, expected_fragment
):
    sessions = [_session("novel-topic-chat", "parent-1")]
    messages = {
        "novel-topic-chat": [
            _message(
                "latest-user",
                "user",
                topic_text,
                "2026-07-31T10:00:00+00:00",
            )
        ]
    }
    payload = _run_personalized(
        monkeypatch,
        "parent-1",
        sessions,
        messages,
        privacy={
            "parent-1": {
                "allow_history_training": True,
                "allow_external_content_research": True,
            }
        },
        research_client=object(),
    )
    card = payload["items"][0]

    assert payload["personalization_mode"] == "conversation"
    assert card["is_conversation_match"] is True
    assert card["is_dynamic_research_card"] is True
    assert card["resource_status"] == "research_on_open"
    assert expected_fragment in card["title"]

    detail = asyncio.run(
        main.get_card_detail(
            card["id"],
            session_id=card["related_session_id"],
            context_created_at=card["context_created_at"],
            uid="parent-1",
        )
    )
    assert detail["id"] == card["id"]
    assert detail["is_dynamic_research_card"] is True
    assert detail["resources"] == []
    assert detail["research_status"] == "pending"

    researched_resources = [
        {
            "id": f"dynamic-{category}-{kind}",
            "content_category": category,
            "source_tier": "authority" if category == "authority" else "curated",
            "kind": kind,
            "title": f"{category} {kind}",
            "publisher": "Verified source",
            "language": "简体中文",
            "locales": ["zh-CN"],
            "description": "与当前家庭问题直接相关并已核验。",
            "url": f"https://example.org/{category}/{kind}",
            "research_source": "openai_web_search",
        }
        for category in main.CONTENT_CATEGORIES
        for kind in ("article", "video")
    ]
    calls = []

    async def complete_dynamic_research(*, card, context, uid):
        calls.append((card["id"], context["session_id"], uid))
        return {
            "resources": researched_resources,
            "dynamic_resource_count": 6,
            "reviewed_resource_count": 0,
            "query": card["topic_label"],
            "editor_note": "六项内容均与当前对话直接相关。",
            "cited_source_count": 6,
        }

    monkeypatch.setattr(
        main, "_research_card_detail_resources", complete_dynamic_research
    )
    research = asyncio.run(
        main.get_card_research(
            card["id"],
            session_id=card["related_session_id"],
            context_created_at=card["context_created_at"],
            uid="parent-1",
        )
    )

    assert calls == [(card["id"], "novel-topic-chat", "parent-1")]
    assert research["research_status"] == "fresh"
    assert len(research["resources"]) == 6
    assert {
        (resource["content_category"], resource["kind"])
        for resource in research["resources"]
    } == {
        (category, kind)
        for category in main.CONTENT_CATEGORIES
        for kind in ("article", "video")
    }


@pytest.mark.parametrize("external_consent", [False, True], ids=["no-consent", "consent"])
@pytest.mark.parametrize(
    "urgent_text",
    [
        "My child isn't breathing.",
        "My child is not breathing.",
        "She swallowed bleach.",
        "My toddler got into a bottle of pills.",
        "He turned blue and limp.",
        "My baby won't wake up.",
        "Her lips are blue.",
        "There is no pulse.",
        "He drank antifreeze.",
        "He swallowed a button battery.",
        "孩子没有呼吸了。",
        "孩子呼吸停了。",
        "孩子吞了漂白水。",
        "孩子误吞了一瓶药片。",
        "孩子全身发蓝而且软趴趴。",
        "宝宝怎么都叫不醒。",
        "孩子的嘴唇发蓝了。",
        "我摸不到孩子的脉搏。",
        "孩子喝了防冻液。",
        "孩子吞下了一颗纽扣电池。",
    ],
    ids=[
        "isnt-breathing",
        "is-not-breathing",
        "swallowed-bleach",
        "bottle-of-pills",
        "blue-and-limp",
        "wont-wake-up",
        "blue-lips",
        "no-pulse",
        "drank-antifreeze",
        "swallowed-button-battery",
        "zh-no-breathing",
        "zh-stopped-breathing",
        "zh-swallowed-bleach",
        "zh-bottle-of-pills",
        "zh-blue-and-limp",
        "zh-wont-wake-up",
        "zh-blue-lips",
        "zh-no-pulse",
        "zh-drank-antifreeze",
        "zh-swallowed-button-battery",
    ],
)
def test_urgent_research_gate_precedes_consent_and_never_calls_research(
    monkeypatch, urgent_text, external_consent
):
    sessions = [_session("urgent-chat", "parent-1")]
    messages = {
        "urgent-chat": [
            _message(
                "urgent-user",
                "user",
                urgent_text,
                "2026-07-31T10:00:00+00:00",
            )
        ]
    }
    payload = _run_personalized(
        monkeypatch,
        "parent-1",
        sessions,
        messages,
        privacy={
            "parent-1": {
                "allow_history_training": True,
                "allow_external_content_research": external_consent,
            }
        },
        research_client=object(),
    )
    assert main._urgent_task_suppressed(urgent_text) is True
    assert payload["items"][0]["resource_status"] == "urgent_suppressed"

    async def research_must_not_run(**_kwargs):
        raise AssertionError("urgent context reached external research")

    monkeypatch.setattr(main, "_research_card_detail_resources", research_must_not_run)
    detail = asyncio.run(
        main.get_card_detail(
            "learn_sleep_routine",
            session_id="urgent-chat",
            context_created_at="2026-07-31T10:00:00+00:00",
            uid="parent-1",
        )
    )
    research = asyncio.run(
        main.get_card_research(
            "learn_sleep_routine",
            session_id="urgent-chat",
            context_created_at="2026-07-31T10:00:00+00:00",
            uid="parent-1",
        )
    )

    assert detail["research_status"] == "urgent_suppressed"
    assert research == {"research_status": "urgent_suppressed"}


def test_memory_context_honors_preferred_session_for_followup_binding(monkeypatch):
    sessions = [
        _session(
            "preferred-chat",
            "parent-1",
            created_at="2026-07-29T10:00:00+00:00",
        ),
        _session(
            "newer-chat",
            "parent-1",
            created_at="2026-07-31T10:00:00+00:00",
        ),
    ]
    messages = {
        "preferred-chat": [
            _message(
                "preferred-user",
                "user",
                "我们正在比较蒙特梭利和森林学校。",
                "2026-07-29T10:01:00+00:00",
            )
        ],
        "newer-chat": [
            _message(
                "newer-user",
                "user",
                "孩子昨晚一直夜醒。",
                "2026-07-31T10:01:00+00:00",
            )
        ],
    }
    monkeypatch.setattr(main, "_sessions", {item["id"]: item for item in sessions})
    monkeypatch.setattr(main, "_messages", messages)

    context = main._recent_main_chat_from_memory(
        "parent-1", preferred_session_id="preferred-chat"
    )

    assert context["state"] == "ready"
    assert context["session_id"] == "preferred-chat"
    assert [message["id"] for message in context["messages"]] == ["preferred-user"]


def test_memory_context_aggregates_only_same_users_recent_main_chats(monkeypatch):
    sessions = [
        _session("current-main", "parent-1", created_at="2026-07-31T10:00:00+00:00"),
        _session("older-main", "parent-1", created_at="2026-07-29T10:00:00+00:00"),
        _session(
            "card-chat",
            "parent-1",
            source_card_id="learn_sleep_routine",
            created_at="2026-07-30T10:00:00+00:00",
        ),
        _session("other-parent-main", "parent-2", created_at="2026-07-30T11:00:00+00:00"),
    ]
    messages = {
        "current-main": [
            _message(
                "current-task",
                "user",
                "给我一些任务吧。",
                "2026-07-31T10:01:00+00:00",
            )
        ],
        "older-main": [
            _message(
                "older-language",
                "user",
                "我想练习九个月宝宝的轮流发声和语言理解。",
                "2026-07-29T10:01:00+00:00",
            )
        ],
        "card-chat": [
            _message("card-sleep", "user", "最近总夜醒。", "2026-07-30T10:01:00+00:00")
        ],
        "other-parent-main": [
            _message(
                "other-emotion",
                "user",
                "孩子总是崩溃大哭。",
                "2026-07-30T11:01:00+00:00",
            )
        ],
    }
    monkeypatch.setattr(main, "_sessions", {item["id"]: item for item in sessions})
    monkeypatch.setattr(main, "_messages", messages)

    context = main._recent_main_chat_from_memory("parent-1")

    assert context["session_id"] == "current-main"
    assert [message["id"] for message in context["messages"]] == [
        "older-language",
        "current-task",
    ]
    assert context["messages"][0]["context_scope"] == "account_history"
    assert context["messages"][-1]["context_scope"] == "current_session"
    assert context["history_session_count"] == 1
    assert context["history_user_message_count"] == 1


def test_action_request_keeps_user_language_goal_ahead_of_ai_fine_motor_aside(
    monkeypatch,
):
    sessions = [_session("parent-main", "parent-1")]
    messages = {
        "parent-main": [
            _message(
                "language-goal",
                "user",
                "我想在换尿布和看窗外时，练习九个月宝宝轮流发声和语音理解。",
                "2026-07-31T09:58:00+00:00",
            ),
            _message(
                "ai-aside",
                "ai",
                "这个月龄也可以关注抓握、爬行和精细动作等发展里程碑。",
                "2026-07-31T09:59:00+00:00",
            ),
            _message(
                "latest-task",
                "user",
                "那给我一些任务吧。",
                "2026-07-31T10:00:00+00:00",
            ),
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)
    card = payload["items"][0]

    assert payload["personalization_mode"] == "conversation"
    assert card["id"] == "learn_language_milestones"
    assert card["recommendation_intent"] == "action_plan"
    assert card["recommendation_score"] >= main._CONVERSATION_MATCH_MIN_SCORE
    assert "轮流发声" in card["recommendation_focus"]
    assert "可执行任务" in card["personalization_reason"]
    assert "轮流发声" in card["personalization_reason"]


def test_generic_task_can_continue_recent_same_account_user_goal(monkeypatch):
    sessions = [
        _session("current-main", "parent-1", created_at="2026-07-31T10:00:00+00:00"),
        _session("recent-language", "parent-1", created_at="2026-07-30T10:00:00+00:00"),
        _session("stale-sleep", "parent-1", created_at="2026-07-20T10:00:00+00:00"),
    ]
    messages = {
        "current-main": [
            _message("task", "user", "给我一个任务。", "2026-07-31T10:01:00+00:00")
        ],
        "recent-language": [
            _message(
                "language",
                "user",
                "宝宝还不会轮流发声，我想加强语言互动。",
                "2026-07-30T10:01:00+00:00",
            )
        ],
        "stale-sleep": [
            _message(
                "sleep",
                "user",
                "很久以前孩子夜醒睡不好。",
                "2026-07-20T10:01:00+00:00",
            )
        ],
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)
    card = payload["items"][0]

    assert card["id"] == "learn_language_milestones"
    assert card["recommendation_intent"] == "action_plan"
    assert "结合你最近其他对话" in card["personalization_reason"]
    assert "语言互动" in card["recommendation_focus"]


def test_generic_task_and_ai_only_topic_do_not_force_static_personalization(
    monkeypatch,
):
    sessions = [_session("parent-main", "parent-1")]
    messages = {
        "parent-main": [
            _message(
                "ai-development",
                "ai",
                "可以关注精细动作、爬行和发展里程碑。",
                "2026-07-31T09:59:00+00:00",
            ),
            _message(
                "generic-task",
                "user",
                "给我一些任务吧。",
                "2026-07-31T10:00:00+00:00",
            ),
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] == "default"
    assert payload["matched_topic"] is None
    assert all(not item["is_conversation_match"] for item in payload["items"])
    assert all("recommendation_score" not in item for item in payload["items"])


def test_product_task_card_feedback_inherits_recent_parenting_goal(monkeypatch):
    """Regression: app feedback must not become the homepage learning topic."""

    sessions = [
        _session(
            "product-feedback",
            "parent-1",
            created_at="2026-08-01T10:00:00+00:00",
        ),
        _session(
            "parenting-context",
            "parent-1",
            created_at="2026-07-31T10:00:00+00:00",
        ),
    ]
    messages = {
        "parenting-context": [
            _message(
                "development-question",
                "user",
                "宝宝现在九个月，未来两个月有什么关键期和发展重点？",
                "2026-07-31T10:01:00+00:00",
            ),
            _message(
                "development-answer",
                "ai",
                "可以关注语言、动作和亲子互动的发展变化。",
                "2026-07-31T10:02:00+00:00",
            ),
            _message(
                "busy-parent",
                "user",
                "我自己在创业，工作很忙，平时陪孩子的时间很少。",
                "2026-07-31T10:03:00+00:00",
            ),
        ],
        "product-feedback": [
            _message(
                "missing-task-card",
                "user",
                "为什么现在还是没有给我生成任务卡片？",
                "2026-08-01T10:01:00+00:00",
            )
        ],
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)
    card = payload["items"][0]

    assert payload["personalization_mode"] == "conversation"
    assert payload["matched_topic"] == "connection"
    assert card["id"] == "learn_serve_and_return"
    assert card["is_conversation_match"] is True
    assert card.get("is_dynamic_research_card") is not True
    assert "没有给我生成任务卡片" not in card["title"]
    assert "创业" in card["recommendation_focus"]
    assert "结合你最近其他对话" in card["personalization_reason"]


def test_product_feedback_without_parenting_context_does_not_create_dynamic_card(
    monkeypatch,
):
    sessions = [_session("product-feedback", "parent-1")]
    messages = {
        "product-feedback": [
            _message(
                "missing-task-card",
                "user",
                "为什么没有任务卡片？",
                "2026-08-01T10:01:00+00:00",
            )
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] == "default"
    assert payload["matched_topic"] is None
    assert all(not item["is_conversation_match"] for item in payload["items"])
    assert all(not item.get("is_dynamic_research_card") for item in payload["items"])


def test_long_single_session_keeps_busy_parent_and_key_period_as_top_two(
    monkeypatch,
):
    """Production regression: 12 recent turns must not erase 24 user signals."""

    # Mirrors the production account's real chronological user-message shape,
    # including repeated context-dependent questions between the two topics.
    user_texts = [
        "我想了解他现在有哪些关键期",
        "给我一些任务卡片让我可以做这些任务帮助他的关键期发展",
        "你就个我一个任务吧",
        "你告诉我他从现在到未来两个月会出现什么关键期，我应该怎么准备？",
        "给我硕鼠哦这段时期的关键期",
        "我现在和他相处要注意什么？",
        "你能告诉我小啊谷最需要什么嘛？",
        "你能告诉我小啊谷最需要什么嘛？",
        "你能告诉我小啊谷最需要什么嘛？",
        "你能告诉我小啊谷最需要什么嘛？",
        "你能告诉我小啊谷最需要什么嘛？",
        "我想我再语言开发这个部分肯恶搞做得比较差。",
        "你觉得我是一个好父亲嘛？",
        "你觉得我是一个好父亲嘛？",
        "你觉得我是一个好父亲嘛？",
        "你觉得我是一个好父亲嘛？",
        "你觉得我是一个好父亲嘛？",
        "我感觉我现在再创业太忙了，陪他的时间都很少，主要是妈妈再照顾他。",
        "我们讨论过什么？你认为我是一共什么样的父亲",
        "我并没有愧疚啊",
        "你认为我现在最需要什么样的引导？",
        "你给我3个适合我的任务吧",
        "没有任务卡片？",
        "给我一些任务吧",
    ]
    assert len(user_texts) == 24
    session_messages = []
    for index, text in enumerate(user_texts, start=1):
        session_messages.extend(
            [
                _message(
                    f"u-{index:02d}",
                    "user",
                    text,
                    f"2026-08-01T10:{(index - 1) * 2:02d}:00+00:00",
                ),
                _message(
                    f"a-{index:02d}",
                    "ai",
                    "我记住了，我们继续围绕你的情况来聊。",
                    f"2026-08-01T10:{(index - 1) * 2 + 1:02d}:00+00:00",
                ),
            ]
        )
    sessions = [_session("long-main", "parent-1")]
    messages = {"long-main": session_messages}
    monkeypatch.setattr(main, "_sessions", {"long-main": sessions[0]})
    monkeypatch.setattr(main, "_messages", messages)

    context = main._recent_main_chat_from_memory("parent-1", limit=12)
    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)
    first, second = payload["items"][:2]

    assert context["current_session_user_message_count"] == 24
    assert any(
        message["id"] == "u-18"
        and message["context_scope"] == "current_session_history"
        for message in context["messages"]
    )
    assert [first["id"], second["id"]] == [
        "learn_serve_and_return",
        "learn_development_milestones",
    ]
    assert first["recommendation_intent"] == "action_plan"
    assert second["recommendation_intent"] == "action_plan"
    assert "创业" in first["recommendation_focus"]
    assert any(
        marker in second["recommendation_focus"]
        for marker in ("关键期", "发展阶段", "发育里程碑")
    )
    assert first["recommendation_focus"] != second["recommendation_focus"]
    assert first["recommendation_focus"] in first["personalization_reason"]
    assert second["recommendation_focus"] in second["personalization_reason"]
    assert all("任务卡片" not in item["title"] for item in payload["items"])


def test_recommendation_feedback_clause_keeps_real_parenting_fact():
    assert main._clean_parenting_signal(
        "这个推荐和我的对话不相关，我创业很忙，陪孩子时间很少。"
    ) == "我创业很忙，陪孩子时间很少"
    assert main._clean_parenting_signal(
        "这段内容不准确，宝宝现在九个月，未来两个月想关注关键期。"
    ) == "宝宝现在九个月，未来两个月想关注关键期"


@pytest.mark.parametrize(
    "text",
    [
        "These recommendations are irrelevant to my child.",
        "The suggested content is inaccurate for my baby.",
        "This card is not suitable for my family.",
    ],
)
def test_english_recommendation_feedback_is_not_a_parenting_topic(text):
    assert main._is_recommendation_feedback(text) is True
    assert main._clean_parenting_signal(text) == ""


@pytest.mark.parametrize(
    "text",
    [
        "What kind of father do you think I am?",
        "What have we discussed?",
        "What do you remember about me?",
    ],
)
def test_english_conversation_meta_is_not_a_parenting_topic(text):
    assert main._is_conversation_meta_request(text) is True
    assert main._clean_parenting_signal(text) == ""


@pytest.mark.parametrize(
    "text",
    [
        "Give me some tasks.",
        "Give me an action plan.",
        "Could you create a task for me?",
    ],
)
def test_english_generic_action_requests_inherit_the_existing_topic(text):
    assert main._is_action_only_request(text) is True


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "为什么没有任务卡片但我想知道孩子夜醒怎么办",
            "我想知道孩子夜醒怎么办",
        ),
        (
            "这个推荐和我的对话不相关但我创业很忙陪孩子很少",
            "我创业很忙陪孩子很少",
        ),
        (
            "我只是说创业公司业务没有聊孩子，但现在孩子每天夜醒",
            "现在孩子每天夜醒",
        ),
        (
            "这个阶段孩子夜醒和白天小睡无关，我想知道原因",
            "这个阶段孩子夜醒和白天小睡无关，我想知道原因",
        ),
        (
            "这些行为与自闭症无关，孩子只是最近压力大",
            "这些行为与自闭症无关，孩子只是最近压力大",
        ),
    ],
)
def test_signal_cleaning_drops_only_product_or_non_parenting_clauses(raw, expected):
    assert main._clean_parenting_signal(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "我只是说创业公司业务没有聊孩子，但我家娃最近夜醒",
            "我家娃最近夜醒",
        ),
        (
            "我只是说创业公司业务没有聊孩子，但小啊谷最近夜醒",
            "小啊谷最近夜醒",
        ),
        (
            "我只是说创业公司业务没有聊孩子，但他最近每天夜醒",
            "他最近每天夜醒",
        ),
    ],
)
def test_non_parenting_clause_does_not_erase_a_real_child_fact(raw, expected):
    assert main._clean_parenting_signal(raw) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("给我一些任务吧", True),
        ("也给我一些任务吧", True),
        ("你给我3个适合我的任务吧", True),
        ("给我一些睡眠任务", False),
        ("给我一些情绪任务", False),
        ("给我一些语言任务", False),
    ],
)
def test_action_only_classifier_preserves_short_parenting_topics(text, expected):
    assert main._is_action_only_request(text) is expected


def test_generic_context_request_does_not_swallow_a_trailing_real_topic():
    assert main._is_generic_context_request("你认为我最需要什么引导？") is True
    assert (
        main._is_generic_context_request("你认为我最需要什么引导？孩子最近夜醒")
        is False
    )


def test_recommendation_diagnostics_never_log_conversation_text(capsys):
    main._log_personalized_feed_decision(
        "parent-secret-id",
        {
            "state": "ready",
            "messages": [
                {
                    "role": "user",
                    "text": "PRIVATE_CONVERSATION_TEXT 没有任务卡片",
                }
            ],
            "current_session_user_message_count": 1,
            "history_user_message_count": 0,
        },
        [
            {
                "id": "learn_serve_and_return",
                "is_conversation_match": True,
                "recommendation_score": 15,
            }
        ],
    )

    logged = capsys.readouterr().out
    assert "personalized_feed_ranked" in logged
    assert "learn_serve_and_return" in logged
    assert "PRIVATE_CONVERSATION_TEXT" not in logged
    assert "parent-secret-id" not in logged


@pytest.mark.parametrize(
    "text",
    [
        "我最近在创业公司做融资，工作很忙，但这次没有聊孩子或陪伴。",
        "我最近在创业公司做融资，工作很忙。",
        "我最近正在创业，白天都在见投资人。",
        "公司下个月要融资，我最近都在做商业计划书。",
        "We need a transparent fundraising plan.",
        "At this moment I am meeting investors.",
        "The company needs an apparent growth strategy.",
    ],
)
def test_startup_company_only_does_not_become_parenting_recommendation(
    monkeypatch, text
):
    sessions = [_session("startup-only", "parent-1")]
    messages = {
        "startup-only": [
            _message(
                "startup",
                "user",
                text,
                "2026-08-01T10:00:00+00:00",
            )
        ]
    }

    payload = _run_personalized(monkeypatch, "parent-1", sessions, messages)

    assert payload["personalization_mode"] == "default"
    assert payload["matched_topic"] is None
    assert all(not item["is_conversation_match"] for item in payload["items"])
    assert all(not item.get("is_dynamic_research_card") for item in payload["items"])


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("为什么现在还是没有给我生成任务卡片？", True),
        ("任务卡片在哪里？", True),
        ("NURI 没有显示推荐卡片。", True),
        ("请给我两个任务卡。", False),
        ("给我一个未来两个月的陪伴计划。", False),
    ],
)
def test_product_meta_detection_does_not_consume_real_task_requests(text, expected):
    assert main._is_product_meta_request(text) is expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("请给我一个今晚能做的方案。", "action_plan"),
        ("蒙特梭利和森林学校怎么选？", "compare"),
        ("我快崩溃了，先陪陪我。", "support"),
        ("九个月宝宝通常会有哪些语言变化？", "learn"),
        ("孩子崩溃大哭时该怎么理解？", "learn"),
    ],
)
def test_recommendation_intent_codes_describe_the_users_request(text, expected):
    assert main._recommendation_intent_code(text) == expected


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
    assert all(
        "关闭对话个性化" in item["personalization_reason"] for item in payload["items"]
    )


@pytest.mark.parametrize("card", LEARNING_CONTENT_CARDS, ids=lambda card: card["id"])
def test_learning_resources_include_trusted_https_article_and_video(card):
    resources = card.get("resources") or []
    kinds = {resource.get("kind") for resource in resources}
    locales = {
        locale for resource in resources for locale in resource.get("locales", [])
    }

    assert {"article", "video"} <= kinds
    assert {"zh-CN", "zh-TW", "en"} <= locales
    assert all(resource.get("locales") for resource in resources)
    assert all(
        locale in SUPPORTED_RESOURCE_LOCALES
        for resource in resources
        for locale in resource["locales"]
    )
    assert all(
        str(resource.get("url") or "").startswith("https://") for resource in resources
    )
    assert all(is_trusted_resource_url(resource["url"]) for resource in resources)


@pytest.mark.parametrize("card", LEARNING_CONTENT_CARDS, ids=lambda card: card["id"])
def test_learning_resources_include_source_curation_metadata(card):
    resources = card.get("resources") or []

    assert all(
        resource.get("content_category") in {"authority", "featured", "case"}
        for resource in resources
    )
    assert all(
        resource.get("source_tier") in {"authority", "curated"}
        for resource in resources
    )
    assert all(
        resource.get("selection_basis")
        in {
            "official",
            "expert_reviewed",
            "audience_popular",
            "expert_and_audience",
            "lived_experience",
        }
        for resource in resources
    )
    assert all(resource.get("trust_note") for resource in resources)
    assert all(resource.get("recognition") for resource in resources)
    assert all(resource.get("selection_reason") for resource in resources)


@pytest.mark.parametrize("card", LEARNING_CONTENT_CARDS, ids=lambda card: card["id"])
def test_english_resources_fill_all_source_and_format_groups(card):
    groups = {
        (resource["source_tier"], resource["kind"])
        for resource in card.get("resources", [])
        if "en" in resource.get("locales", [])
    }

    assert groups == {
        ("authority", "article"),
        ("curated", "article"),
        ("authority", "video"),
        ("curated", "video"),
    }


@pytest.mark.parametrize("card", LEARNING_CONTENT_CARDS, ids=lambda card: card["id"])
def test_english_curated_resources_use_reviewed_non_mainland_expert_source(card):
    resources = [
        resource
        for resource in card.get("resources", [])
        if resource.get("source_tier") == "curated"
        and "en" in resource.get("locales", [])
    ]

    assert len(resources) == 2
    assert {resource["kind"] for resource in resources} == {"article", "video"}
    assert all(
        urlparse(resource["url"]).hostname == "raisingchildren.net.au"
        for resource in resources
    )
    assert all("澳大利亚政府支持" in resource["trust_note"] for resource in resources)


def test_audience_recognition_is_only_claimed_with_visible_evidence():
    resources_by_id = {
        resource["id"]: resource
        for card in LEARNING_CONTENT_CARDS
        for resource in card.get("resources", [])
    }

    assert (
        resources_by_id["sleep-rcn-article"]["selection_basis"] == "expert_and_audience"
    )
    assert (
        resources_by_id["sleep-rcn-article"]["audience_note"] == "7.4k 位读者标记有帮助"
    )
    assert (
        resources_by_id["safety-rcn-article"]["selection_basis"]
        == "expert_and_audience"
    )
    assert (
        resources_by_id["safety-rcn-article"]["audience_note"]
        == "1.2k 位读者标记有帮助"
    )

    unsupported = [
        resource
        for resource in resources_by_id.values()
        if resource.get("source_tier") == "curated"
        and "en" in resource.get("locales", [])
        and resource["id"] not in {"sleep-rcn-article", "safety-rcn-article"}
    ]
    assert all(
        resource["selection_basis"] == "expert_reviewed" for resource in unsupported
    )
    assert all(not resource.get("audience_note") for resource in unsupported)


@pytest.mark.parametrize("card", LEARNING_CONTENT_CARDS, ids=lambda card: card["id"])
def test_simplified_resources_use_reviewed_non_mainland_source(card):
    resources = [
        resource
        for resource in card.get("resources", [])
        if "zh-CN" in resource.get("locales", [])
    ]

    groups = {
        (resource["content_category"], resource["kind"]) for resource in resources
    }
    assert len(resources) == 6
    assert groups == {
        (category, kind)
        for category in ("authority", "featured", "case")
        for kind in ("article", "video")
    }
    authority_article = next(
        resource
        for resource in resources
        if (resource["content_category"], resource["kind"])
        == ("authority", "article")
    )
    videos = [resource for resource in resources if resource["kind"] == "video"]

    # Simplified-Chinese fallback articles remain outside mainland China. Videos
    # may come from reviewed Hong Kong or Taiwan public-health publishers, but
    # must be explicitly verified as Mandarin rather than inferred from script.
    assert urlparse(authority_article["url"]).hostname == "www.fhs.gov.hk"
    assert urlparse(authority_article["url"]).path.startswith("/sc_chi/")
    assert "香港特别行政区政府" in authority_article["publisher"]
    for video in videos:
        assert video["spoken_language"] == "mandarin"
        assert video["spoken_language_status"] == "verified"
        assert video["language_evidence"]
        assert video["spoken_language_evidence"]
        assert video["spoken_language_evidence_url"] == video["url"]
        assert not any(
            marker in " ".join(
                str(video.get(field) or "").casefold()
                for field in ("title", "description", "language", "spoken_language")
            )
            for marker in ("cantonese", "粤语", "粵語", "广东话", "廣東話")
        )


@pytest.mark.parametrize("card", LEARNING_CONTENT_CARDS, ids=lambda card: card["id"])
def test_traditional_resources_are_taiwan_authority_first(card):
    resources = [
        resource
        for resource in card.get("resources", [])
        if "zh-TW" in resource.get("locales", [])
    ]

    groups = {
        (resource["content_category"], resource["kind"]) for resource in resources
    }
    assert len(resources) == 6
    assert groups == {
        (category, kind)
        for category in ("authority", "featured", "case")
        for kind in ("article", "video")
    }
    assert all(resource["source_region"] == "TW" for resource in resources)
    assert all("台灣" in resource["language"] for resource in resources)
    authority_resources = [
        resource
        for resource in resources
        if resource["content_category"] == "authority"
    ]
    assert len(authority_resources) == 2
    assert all(
        resource["source_tier"] == "authority" for resource in authority_resources
    )
    assert all(
        resource["selection_basis"] == "official"
        for resource in authority_resources
    )

    taiwan_video_publishers = {
        "臺灣衛生福利部國民健康署官方頻道",
        "埔里基督教醫院 · 小星星協奏曲",
        "臺灣雲林縣衛生局保健科",
    }
    for resource in authority_resources:
        hostname = urlparse(resource["url"]).hostname
        assert hostname in TAIWAN_AUTHORITY_RESOURCE_HOSTS | {"www.youtube.com"}
        if hostname == "www.youtube.com":
            assert resource["publisher"] in taiwan_video_publishers


def test_mainland_resource_hosts_are_not_trusted():
    mainland_hosts = {
        "nhc.gov.cn",
        "www.nhc.gov.cn",
        "unicef.cn",
        "www.unicef.cn",
    }

    assert mainland_hosts.isdisjoint(TRUSTED_RESOURCE_HOSTS)


def test_learning_resource_ids_are_unique():
    ids = [
        resource["id"]
        for card in LEARNING_CONTENT_CARDS
        for resource in card.get("resources", [])
    ]

    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(
    ("preferred_locale", "expected_first_locale"),
    [("zh-CN", "zh-CN"), ("zh", "zh-CN"), ("zh-TW", "zh-TW"), ("en", "en")],
)
def test_learning_resources_are_ordered_by_preferred_locale(
    preferred_locale, expected_first_locale
):
    original = list(LEARNING_CONTENT_CARDS[0]["resources"])

    ordered = order_learning_resources(original, preferred_locale)

    assert expected_first_locale in ordered[0]["locales"]
    assert ordered[0]["kind"] == "article"
    assert LEARNING_CONTENT_CARDS[0]["resources"] == original


def test_english_learning_resources_follow_group_order():
    ordered = order_learning_resources(LEARNING_CONTENT_CARDS[0]["resources"], "en")
    english = [resource for resource in ordered if "en" in resource["locales"]]

    assert [
        (resource["source_tier"], resource["kind"]) for resource in english[:4]
    ] == [
        ("authority", "article"),
        ("authority", "video"),
        ("curated", "article"),
        ("curated", "video"),
    ]


def test_learning_detail_returns_resources_and_unknown_id_is_404(monkeypatch):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)

    detail = asyncio.run(main.get_card_detail("learn_sleep_routine", uid=None))

    assert detail["id"] == "learn_sleep_routine"
    assert detail["body"]
    assert {resource["kind"] for resource in detail["resources"]} >= {
        "article",
        "video",
    }
    assert all(
        is_trusted_resource_url(resource["url"]) for resource in detail["resources"]
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.get_card_detail("learn_does_not_exist", uid=None))
    assert exc_info.value.status_code == 404


def test_learning_detail_uses_saved_traditional_chinese_preference(monkeypatch):
    async def traditional_context(
        _uid, preferred_session_id=None, through_created_at=None
    ):
        assert preferred_session_id is None
        assert through_created_at is None
        return {
            "state": "no_history",
            "session_id": None,
            "messages": [],
            "preferred_locale": "zh-TW",
        }

    monkeypatch.setattr(main, "_load_recent_main_chat", traditional_context)

    detail = asyncio.run(main.get_card_detail("learn_sleep_routine", uid="parent-1"))

    assert detail["resources"][0]["locales"] == ["zh-TW"]
    assert detail["resources"][0]["kind"] == "article"
    assert detail["resources"][1]["locales"] == ["zh-TW"]
    assert detail["resources"][1]["kind"] == "video"


def test_card_context_includes_learning_content_and_resource_titles():
    card = next(
        item for item in LEARNING_CONTENT_CARDS if item["id"] == "learn_sleep_routine"
    )

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

    def limit(self, value):
        assert value == 1
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
        return _Result([{"value": value}] if value is not None else [])


class _PrivacySupabase:
    def __init__(self):
        self.store = {}

    def table(self, name):
        assert name == "app_settings"
        return _PrivacySettingsTable(self.store)


@pytest.mark.parametrize(
    "empty_data", [None, []], ids=["maybe-single-none", "empty-list"]
)
def test_missing_privacy_row_defaults_to_history_personalization_enabled(
    monkeypatch, empty_data
):
    class EmptyPrivacyTable:
        def select(self, *_args, **_kwargs):
            return self

        def eq(self, field, _value):
            assert field == "key"
            return self

        def maybe_single(self):
            return self

        def limit(self, value):
            assert value == 1
            return self

        def execute(self):
            return _Result(empty_data)

    class EmptyPrivacySupabase:
        def table(self, name):
            assert name == "app_settings"
            return EmptyPrivacyTable()

    monkeypatch.setattr(main, "_get_supabase", lambda: EmptyPrivacySupabase())
    monkeypatch.setattr(main, "_privacy", {})

    loaded = asyncio.run(main._db_get_privacy("parent-1", fail_closed=True))

    assert loaded["allow_history_training"] is True
    assert loaded["allow_external_content_research"] is False


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
                "language": "zh-TW",
            },
        )
    )
    assert saved["allow_history_training"] is False
    assert (
        json.loads(supabase.store[main._privacy_storage_key("parent-1")])[
            "allow_history_training"
        ]
        is False
    )

    # Simulate a Vercel cold start: process memory is empty, Supabase remains.
    monkeypatch.setattr(main, "_privacy", {})
    loaded = asyncio.run(main._db_get_privacy("parent-1", fail_closed=True))
    assert loaded["allow_history_training"] is False
    assert loaded["language"] == "zh-TW"


def test_legacy_chinese_privacy_locale_normalizes_to_simplified_chinese():
    settings = main._normalized_privacy_settings({"language": "zh"})

    assert settings["language"] == "zh-CN"


@pytest.mark.parametrize("locale", ["zh-CN", "zh-TW", "en"])
def test_privacy_model_accepts_supported_resource_locales(locale):
    body = main.PrivacySettings(language=locale)

    assert body.language == locale


def test_privacy_endpoint_round_trips_traditional_chinese(monkeypatch):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)
    monkeypatch.setattr(main, "_privacy", {})
    payload = {
        "allow_history_training": True,
        "allow_external_content_research": True,
        "daily_push": True,
        "anonymous_community_share": False,
        "language": "zh-TW",
    }

    with TestClient(main.app) as client:
        saved = client.put("/api/privacy", json=payload)
        loaded = client.get("/api/privacy")
        rejected = client.put("/api/privacy", json={**payload, "language": "fr"})

    assert saved.status_code == 200
    assert saved.json()["language"] == "zh-TW"
    assert saved.json()["allow_external_content_research"] is True
    assert loaded.status_code == 200
    assert loaded.json()["language"] == "zh-TW"
    assert loaded.json()["allow_external_content_research"] is True
    assert rejected.status_code == 422


def test_privacy_lookup_fails_closed_when_storage_is_unavailable(monkeypatch):
    class BrokenSupabase:
        def table(self, _name):
            raise RuntimeError("temporary outage")

    monkeypatch.setattr(main, "_get_supabase", lambda: BrokenSupabase())
    monkeypatch.setattr(main, "_privacy", {})

    loaded = asyncio.run(main._db_get_privacy("parent-1", fail_closed=True))

    assert loaded["allow_history_training"] is False


def test_privacy_lookup_fails_closed_when_client_is_unconfigured(monkeypatch):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)
    monkeypatch.setattr(main, "_privacy", {"parent-1": dict(main._DEFAULT_PRIVACY)})

    loaded = asyncio.run(main._db_get_privacy("parent-1", fail_closed=True))

    assert loaded["allow_history_training"] is False
    assert loaded[main._PRIVACY_STORAGE_UNAVAILABLE] is True


def test_privacy_lookup_does_not_trust_warm_cache_during_storage_failure(monkeypatch):
    class BrokenSupabase:
        def table(self, _name):
            raise RuntimeError("temporary outage")

    monkeypatch.setattr(main, "_get_supabase", lambda: BrokenSupabase())
    monkeypatch.setattr(main, "_privacy", {"parent-1": dict(main._DEFAULT_PRIVACY)})

    loaded = asyncio.run(main._db_get_privacy("parent-1", fail_closed=True))

    assert loaded["allow_history_training"] is False
    assert loaded[main._PRIVACY_STORAGE_UNAVAILABLE] is True


def test_privacy_storage_failure_uses_unavailable_feed_not_opt_out_copy(monkeypatch):
    class BrokenSupabase:
        def table(self, _name):
            raise RuntimeError("temporary outage")

    monkeypatch.setattr(main, "_get_supabase", lambda: BrokenSupabase())
    monkeypatch.setattr(main, "_privacy", {})

    payload = asyncio.run(main.get_personalized_feed(count=4, uid="parent-1"))

    assert payload["personalization_mode"] == "default_unavailable"
    assert payload["matched_topic"] is None
    assert payload["related_session_id"] is None
    assert all(item["is_conversation_match"] is False for item in payload["items"])
    assert all(
        "关闭对话个性化" not in item["personalization_reason"]
        for item in payload["items"]
    )


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
