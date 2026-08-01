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
