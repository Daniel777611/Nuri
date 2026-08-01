"""Validation and route coverage for conversation-aware content research."""

from __future__ import annotations

import asyncio
import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import main  # noqa: E402
from backend.content_research import (  # noqa: E402
    CONTENT_CATEGORIES,
    RESOURCE_KINDS,
    clear_research_cache,
    parse_research_response,
    redact_conversation_text,
    research_learning_resources,
)


_URL_BY_SLOT = {
    ("authority", "article"): "https://www.cdc.gov/parenting/sleep/article.html",
    ("authority", "video"): "https://www.fhs.gov.hk/sc_chi/mulit_med/000015.html",
    ("featured", "article"): "https://raisingchildren.net.au/sleep/featured-guide",
    ("featured", "video"): "https://babyedu.sfaa.gov.tw/info/10000213",
    ("case", "article"): "https://parenting.example.com/our-sleep-story",
    ("case", "video"): "https://www.youtube.com/watch?v=wG2wh9b3X8I",
}


def _raw_resources(locale: str = "zh-CN") -> list[dict]:
    language = {
        "zh-CN": "简体中文",
        "zh-TW": "繁體中文",
        "en": "English",
    }[locale]
    spoken_language = "english" if locale == "en" else "mandarin"
    resources = []
    for category in CONTENT_CATEGORIES:
        for kind in RESOURCE_KINDS:
            url = _URL_BY_SLOT[(category, kind)]
            if locale == "zh-CN":
                title = (
                    f"父母真实案例：幼儿睡眠{kind}"
                    if category == "case"
                    else f"{category} 类{kind}：幼儿睡眠建议"
                )
            elif locale == "zh-TW":
                title = (
                    f"家長親身案例：幼兒睡眠{kind}"
                    if category == "case"
                    else f"{category} 類{kind}：幼兒睡眠建議"
                )
            else:
                title = (
                    f"Parent family case {kind} title"
                    if category == "case"
                    else f"{category} {kind} title"
                )
            resources.append(
                {
                    "content_category": category,
                    "kind": kind,
                    "title": title,
                    "publisher": f"{category} publisher",
                    "language": language,
                    "spoken_language": (
                        spoken_language if kind == "video" else "not_applicable"
                    ),
                    "spoken_language_evidence": (
                        "页面明确标注普通话（Mandarin）"
                        if locale in {"zh-CN", "zh-TW"} and kind == "video"
                        else ("The page identifies English speech." if kind == "video" else "")
                    ),
                    "spoken_language_evidence_url": url if kind == "video" else "",
                    "description": f"A useful {kind} for this family's situation.",
                    "url": url,
                    "trust_note": "The source and page were checked.",
                    "recognition": "Selected using verifiable source evidence.",
                    "selection_reason": "It directly answers the recent conversation.",
                    "audience_note": "",
                    # An off-site authority video needs cited institution
                    # evidence; other videos use their cited creator page in
                    # this compact fixture. Articles intentionally leave it blank.
                    "evidence_url": (
                        _URL_BY_SLOT[("authority", "article")]
                        if category == "authority" and kind == "video"
                        else (url if kind == "video" else "")
                    ),
                    "case_evidence": (
                        "A parent describes this family's first-person experience."
                        if category == "case"
                        else ""
                    ),
                    "case_evidence_url": url if category == "case" else "",
                }
            )
    return resources


def _response(
    resources: list[dict] | None = None,
    *,
    cited_urls: list[str] | None = None,
) -> dict:
    resources = deepcopy(resources if resources is not None else _raw_resources())
    if cited_urls is None:
        cited_urls = [resource["url"] for resource in resources]
    payload = {
        "query": "toddler sleep routine based on the recent conversation",
        "editor_note": "These resources match the family's current sleep concern.",
        "resources": resources,
    }
    return {
        "output_text": json.dumps(payload, ensure_ascii=False),
        "output": [
            {
                "type": "web_search_call",
                "action": {
                    "sources": [
                        {"type": "url", "url": url} for url in cited_urls
                    ]
                },
            }
        ],
    }


def _parsed_bundle(locale: str = "zh-CN") -> dict:
    parsed = parse_research_response(
        _response(_raw_resources(locale)),
        locale=locale,
        card_id="learn_sleep_routine",
    )
    assert parsed is not None
    return parsed


def test_complete_research_bundle_has_three_categories_and_both_formats():
    parsed = _parsed_bundle()

    expected_slots = [
        (category, kind)
        for category in CONTENT_CATEGORIES
        for kind in RESOURCE_KINDS
    ]
    assert [
        (resource["content_category"], resource["kind"])
        for resource in parsed["resources"]
    ] == expected_slots
    assert len(parsed["resources"]) == 6
    assert parsed["cited_source_count"] == 6
    assert all(
        resource["research_source"] == "openai_web_search"
        for resource in parsed["resources"]
    )


def test_research_bundle_is_rejected_when_any_slot_is_missing():
    resources = _raw_resources()[:-1]

    parsed = parse_research_response(
        _response(resources),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


def test_research_bundle_is_rejected_when_a_resource_url_is_not_cited():
    resources = _raw_resources()
    cited_urls = [resource["url"] for resource in resources[:-1]]

    parsed = parse_research_response(
        _response(resources, cited_urls=cited_urls),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("spoken_language", "cantonese"),
        ("title", "家长分享：粤语版睡眠经验"),
        ("description", "This video is spoken in 廣東話 with simplified subtitles."),
    ],
)
def test_simplified_chinese_bundle_rejects_cantonese_video(field, value):
    resources = _raw_resources()
    featured_video = next(
        resource
        for resource in resources
        if (resource["content_category"], resource["kind"])
        == ("featured", "video")
    )
    featured_video[field] = value

    parsed = parse_research_response(
        _response(resources),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


def test_unreviewed_video_cannot_self_declare_mandarin():
    resources = _raw_resources()
    featured_video = next(
        item
        for item in resources
        if (item["content_category"], item["kind"]) == ("featured", "video")
    )
    unreviewed_url = "https://www.youtube.com/watch?v=unreviewedMandarin123"
    featured_video["url"] = unreviewed_url
    featured_video["evidence_url"] = unreviewed_url
    featured_video["spoken_language_evidence_url"] = unreviewed_url

    parsed = parse_research_response(
        _response(resources),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


def test_conversation_text_is_redacted_before_web_research():
    redacted = redact_conversation_text(
        "宝宝名叫小谷，住在123 Main Street，电话 +1 (415) 555-1212，邮箱 parent@example.com"
    )

    assert "小谷" not in redacted
    assert "123 Main Street" not in redacted
    assert "555-1212" not in redacted
    assert "parent@example.com" not in redacted
    assert "[名字]" in redacted
    assert "[地址]" in redacted


def test_english_name_address_and_school_are_redacted_before_web_research():
    redacted = redact_conversation_text(
        "My daughter Sophia lives at 123 Main Street and attends Little Star School. "
        "My name is Daniel Wang."
    )

    assert "Sophia" not in redacted
    assert "123 Main Street" not in redacted
    assert "Little Star School" not in redacted
    assert "Daniel Wang" not in redacted
    assert "[name]" in redacted
    assert "[address]" in redacted
    assert "[school]" in redacted


@pytest.mark.parametrize(
    ("message", "private_name", "topic_fragment"),
    [
        (
            "My child's name is Oliver, and bedtime takes two hours.",
            "Oliver",
            "bedtime takes two hours",
        ),
        (
            "Her name is Sophia. She wakes after every sleep cycle.",
            "Sophia",
            "wakes after every sleep cycle",
        ),
        (
            "Our baby, Emma, refuses solid food at dinner.",
            "Emma",
            "refuses solid food at dinner",
        ),
        (
            "My son is John Smith and has frequent bedtime tantrums.",
            "John Smith",
            "frequent bedtime tantrums",
        ),
        (
            "Our son's name is Liam, and he wakes before dawn.",
            "Liam",
            "wakes before dawn",
        ),
        (
            "My kid's name is Alex. Meals have become stressful.",
            "Alex",
            "Meals have become stressful",
        ),
        (
            "We call her Sophia, and transitions are difficult.",
            "Sophia",
            "transitions are difficult",
        ),
        (
            "She is named Emma. She refuses her afternoon nap.",
            "Emma",
            "refuses her afternoon nap",
        ),
    ],
)
def test_common_child_name_phrases_are_redacted_without_losing_topic(
    message, private_name, topic_fragment
):
    redacted = redact_conversation_text(message)

    assert private_name not in redacted
    assert "[name]" in redacted
    assert topic_fragment in redacted


def test_full_us_address_is_redacted_without_losing_following_topic():
    redacted = redact_conversation_text(
        "We live at 123 Main Street, Springfield, IL 62704. "
        "My toddler wakes every two hours."
    )

    assert "123 Main Street" not in redacted
    assert "Springfield" not in redacted
    assert "62704" not in redacted
    assert "[address]" in redacted
    assert "My toddler wakes every two hours." in redacted


def test_school_and_canadian_address_are_redacted_without_losing_topic():
    redacted = redact_conversation_text(
        "My daughter studies at Little Star Academy. "
        "We live at 123 King Street, Toronto, ON M5V 3A8. "
        "She needs help with school drop-off."
    )

    assert "Little Star Academy" not in redacted
    assert "123 King Street" not in redacted
    assert "Toronto" not in redacted
    assert "M5V 3A8" not in redacted
    assert "[school]" in redacted
    assert "[address]" in redacted
    assert "She needs help with school drop-off." in redacted


@pytest.mark.parametrize("kind", ["article", "video"])
def test_chinese_bundle_rejects_resource_title_without_chinese_text(kind):
    resources = _raw_resources()
    resource = next(
        item
        for item in resources
        if (item["content_category"], item["kind"]) == ("featured", kind)
    )
    resource["title"] = "An English title presented as a Chinese resource"

    parsed = parse_research_response(
        _response(resources),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("spoken_language_evidence", ""),
        ("spoken_language_evidence", "页面只有简体中文字幕"),
        ("spoken_language_evidence_url", ""),
        (
            "spoken_language_evidence_url",
            "https://creator.example.com/language-proof",
        ),
    ],
)
def test_chinese_video_requires_cited_explicit_mandarin_evidence(field, value):
    resources = _raw_resources()
    featured_video = next(
        item
        for item in resources
        if (item["content_category"], item["kind"])
        == ("featured", "video")
    )
    featured_video[field] = value

    parsed = parse_research_response(
        _response(resources),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


def test_video_resource_must_link_to_a_direct_watch_page():
    resources = _raw_resources()
    featured_video = next(
        item
        for item in resources
        if (item["content_category"], item["kind"])
        == ("featured", "video")
    )
    channel_url = "https://www.youtube.com/@trusted-parenting-creator"
    featured_video["url"] = channel_url
    featured_video["evidence_url"] = channel_url
    featured_video["spoken_language_evidence_url"] = channel_url

    parsed = parse_research_response(
        _response(resources),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


def test_every_video_requires_a_cited_creator_or_institution_evidence_url():
    resources = _raw_resources()
    case_video = next(
        item
        for item in resources
        if (item["content_category"], item["kind"]) == ("case", "video")
    )
    case_video["evidence_url"] = "https://creator.example.com/about"

    parsed = parse_research_response(
        _response(resources),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


def test_authority_youtube_video_requires_cited_authority_evidence_url():
    resources = _raw_resources()
    authority_video = next(
        item
        for item in resources
        if (item["content_category"], item["kind"])
        == ("authority", "video")
    )
    authority_video_url = "https://www.youtube.com/watch?v=EtfYKMI6At8"
    authority_video["url"] = authority_video_url
    authority_video["spoken_language_evidence_url"] = authority_video_url
    non_authority_evidence = "https://creator.example.com/about"
    authority_video["evidence_url"] = non_authority_evidence
    cited_urls = [item["url"] for item in resources] + [non_authority_evidence]

    parsed = parse_research_response(
        _response(resources, cited_urls=cited_urls),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


def test_arbitrary_youtube_video_cannot_borrow_unrelated_authority_citation():
    resources = _raw_resources("en")
    authority_video = next(
        item
        for item in resources
        if (item["content_category"], item["kind"])
        == ("authority", "video")
    )
    authority_video_url = "https://www.youtube.com/watch?v=arbitraryInfluencer999"
    authority_video["url"] = authority_video_url
    authority_video["spoken_language_evidence_url"] = authority_video_url
    authority_video["evidence_url"] = _URL_BY_SLOT[("authority", "article")]
    cited_urls = [item["url"] for item in resources] + [
        authority_video["evidence_url"]
    ]

    parsed = parse_research_response(
        _response(resources, cited_urls=cited_urls),
        locale="en",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


def test_unreviewed_authority_host_video_is_rejected_even_when_fully_cited():
    resources = _raw_resources("en")
    authority_video = next(
        item
        for item in resources
        if (item["content_category"], item["kind"])
        == ("authority", "video")
    )
    unreviewed_authority_url = (
        "https://www.cdc.gov/parenting/videos/unreviewed-sleep-video.html"
    )
    authority_video["url"] = unreviewed_authority_url
    authority_video["evidence_url"] = unreviewed_authority_url
    cited_urls = [item["url"] for item in resources]

    parsed = parse_research_response(
        _response(resources, cited_urls=cited_urls),
        locale="en",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


@pytest.mark.parametrize(
    ("case_evidence", "case_evidence_url"),
    [
        ("", _URL_BY_SLOT[("case", "article")]),
        ("A parent describes a real experience.", "https://example.com/other-case"),
    ],
)
def test_lived_case_requires_nonempty_evidence_on_the_resource_page(
    case_evidence, case_evidence_url
):
    resources = _raw_resources("en")
    case_article = next(
        item
        for item in resources
        if (item["content_category"], item["kind"]) == ("case", "article")
    )
    case_article["case_evidence"] = case_evidence
    case_article["case_evidence_url"] = case_evidence_url
    cited_urls = [item["url"] for item in resources] + [case_evidence_url]

    parsed = parse_research_response(
        _response(resources, cited_urls=cited_urls),
        locale="en",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


@pytest.mark.parametrize(
    "private_url",
    [
        "https://127.0.0.1/private",
        "https://10.0.0.8/private",
        "https://[::1]/private",
        "https://localhost/private",
    ],
)
def test_research_bundle_rejects_private_or_local_urls(private_url):
    resources = _raw_resources()
    resources[-2]["url"] = private_url

    parsed = parse_research_response(
        _response(resources),
        locale="zh-CN",
        card_id="learn_sleep_routine",
    )

    assert parsed is None


class _FakeResponses:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return deepcopy(self.response)


class _FakeClient:
    def __init__(self, response):
        self.responses = _FakeResponses(response)


def test_research_route_is_post_only_and_requires_login():
    with TestClient(main.app) as client:
        unauthenticated = client.post(
            "/api/feed/learn_sleep_routine/research"
        )
        wrong_method = client.get("/api/feed/learn_sleep_routine/research")

    assert unauthenticated.status_code == 401
    assert wrong_method.status_code in {404, 405}
    assert unauthenticated.headers["cache-control"] == "private, no-store"
    assert unauthenticated.headers["vary"] == "Authorization"


def test_research_uses_only_structured_card_context_and_ignores_raw_messages():
    clear_research_cache()
    client = _FakeClient(_response())
    raw_message_texts = [
        "RAW_PRIVATE_USER_TEXT My child's name is Oliver at 123 Main Street.",
        "RAW_PRIVATE_ASSISTANT_TEXT The parent supplied private details.",
    ]
    kwargs = {
        "card": {
            "id": "learn_sleep_routine",
            "topic": "My kid's name is Alex; toddler bedtime resistance",
            "topic_label": "My kid's name is Alex; toddler bedtime resistance",
            "title": "Continue learning about toddler bedtime resistance",
            "summary": "固定睡前节奏。",
            "recommendation_focus": "九个月宝宝轮流发声",
            "recommendation_intent": "action_plan",
            "unapproved_context": "THIS_MUST_NOT_REACH_RESEARCH",
        },
        "messages": [
            {"role": "user", "text": raw_message_texts[0]},
            {"role": "assistant", "text": raw_message_texts[1]},
        ],
        "preferred_locale": "zh-CN",
        "model": "test-model",
        "safety_identifier": "nuri_test_parent",
    }

    try:
        first = research_learning_resources(client, **kwargs)
        assert first is not None
        first["resources"][0]["title"] = "mutated by caller"

        second = research_learning_resources(
            client,
            **{
                **kwargs,
                "messages": [
                    {
                        "role": "user",
                        "text": "A completely different raw conversation secret.",
                    }
                ],
            },
        )

        assert len(client.responses.calls) == 1
        assert second is not None
        assert second["resources"][0]["title"] != "mutated by caller"
        request = client.responses.calls[0]
        assert len(request["tools"]) == 1
        assert request["tools"][0]["type"] == "web_search"
        assert request["tools"][0]["search_context_size"] in {
            "low",
            "medium",
            "high",
        }
        assert request["include"] == ["web_search_call.action.sources"]
        assert request["store"] is False
        assert all(text not in request["input"] for text in raw_message_texts)
        assert "RAW_PRIVATE" not in request["input"]
        assert "Alex" not in request["input"]
        assert "toddler bedtime resistance" in request["input"]
        assert "九个月宝宝轮流发声" in request["input"]
        assert "action_plan" in request["input"]
        assert "THIS_MUST_NOT_REACH_RESEARCH" not in request["input"]
    finally:
        clear_research_cache()


def test_unmatched_virtual_card_is_not_exposed(monkeypatch):
    async def no_generated_cards():
        return []

    monkeypatch.setattr(main, "_db_get_gen_cards", no_generated_cards)

    with pytest.raises(main.HTTPException) as exc_info:
        asyncio.run(
            main.get_card_detail(
                "learn_conversation_followup",
                session_id="preferred-chat",
                context_created_at="2026-07-31T10:00:00+00:00",
                uid="parent-private-id",
            )
        )

    assert exc_info.value.status_code == 404


def test_detail_returns_reviewed_pending_without_calling_provider(monkeypatch):
    messages = [
        {
            "id": "message-1",
            "role": "user",
            "text": "孩子最近夜醒，睡前很难入睡，睡眠作息很乱。",
            "created_at": "2026-07-31T10:00:00+00:00",
        }
    ]

    async def ready_context(
        _uid, preferred_session_id=None, through_created_at=None
    ):
        assert preferred_session_id is None
        assert through_created_at is None
        return {
            "state": "ready",
            "session_id": "session-1",
            "messages": messages,
            "preferred_locale": "zh-CN",
            "external_research_allowed": True,
        }

    calls = []

    def should_not_search(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("detail endpoint must never call the research provider")

    monkeypatch.setattr(main, "_load_recent_main_chat", ready_context)
    monkeypatch.setattr(main, "content_research_oai", object())
    monkeypatch.setattr(main, "research_learning_resources", should_not_search)

    detail = asyncio.run(
        main.get_card_detail("learn_sleep_routine", uid="parent-private-id")
    )

    assert calls == []
    assert detail["research_status"] == "pending"
    assert detail["resources"]
    assert all(
        resource.get("research_source") != "openai_web_search"
        for resource in detail["resources"]
    )
    assert detail["resource_blueprint"] == {
        category: ["article", "video"] for category in CONTENT_CATEGORIES
    }


def test_research_endpoint_returns_dynamic_bundle_for_matched_card(monkeypatch):
    messages = [
        {
            "id": "message-1",
            "role": "user",
            "text": "孩子最近夜醒，睡前很难入睡，睡眠作息很乱。",
            "created_at": "2026-07-31T10:00:00+00:00",
        }
    ]

    async def ready_context(
        _uid, preferred_session_id=None, through_created_at=None
    ):
        assert preferred_session_id is None
        assert through_created_at is None
        return {
            "state": "ready",
            "session_id": "session-1",
            "messages": messages,
            "preferred_locale": "zh-CN",
            "external_research_allowed": True,
        }

    bundle = _parsed_bundle()
    client = object()
    calls = []

    def fake_research(passed_client, **kwargs):
        calls.append((passed_client, kwargs))
        return deepcopy(bundle)

    monkeypatch.setattr(main, "_load_recent_main_chat", ready_context)
    monkeypatch.setattr(main, "content_research_oai", client)
    monkeypatch.setattr(main, "research_learning_resources", fake_research)

    research = asyncio.run(
        main.get_card_research("learn_sleep_routine", uid="parent-private-id")
    )

    assert len(calls) == 1
    assert calls[0][0] is client
    assert calls[0][1]["messages"] == messages
    assert calls[0][1]["preferred_locale"] == "zh-CN"
    assert calls[0][1]["safety_identifier"].startswith("nuri_")
    assert "parent-private-id" not in calls[0][1]["safety_identifier"]
    assert research["research_status"] == "fresh"
    assert research["research_query"] == bundle["query"]
    assert research["research_editor_note"] == bundle["editor_note"]
    assert research["research_source_count"] == 6
    assert research["resources"] == bundle["resources"]
    assert research["resource_blueprint"] == {
        category: ["article", "video"] for category in CONTENT_CATEGORIES
    }
    assert research["resource_summary"]["categories"] == {
        category: {kind: 1 for kind in RESOURCE_KINDS}
        for category in CONTENT_CATEGORIES
    }


@pytest.mark.parametrize("provider_failure", ["empty", "exception"])
def test_research_endpoint_returns_fallback_when_provider_fails(
    monkeypatch, provider_failure
):
    async def ready_context(
        _uid, preferred_session_id=None, through_created_at=None
    ):
        assert preferred_session_id is None
        assert through_created_at is None
        return {
            "state": "ready",
            "session_id": "session-1",
            "messages": [
                {
                    "id": "message-1",
                    "role": "user",
                    "text": "孩子最近夜醒，睡前很难入睡，睡眠作息很乱。",
                    "created_at": "2026-07-31T10:00:00+00:00",
                }
            ],
            "preferred_locale": "zh-CN",
            "external_research_allowed": True,
        }

    calls = []

    def failed_research(*args, **kwargs):
        calls.append((args, kwargs))
        if provider_failure == "exception":
            raise RuntimeError("provider unavailable")
        return None

    monkeypatch.setattr(main, "_load_recent_main_chat", ready_context)
    monkeypatch.setattr(main, "content_research_oai", object())
    monkeypatch.setattr(main, "research_learning_resources", failed_research)

    research = asyncio.run(
        main.get_card_research("learn_sleep_routine", uid="parent-private-id")
    )

    assert len(calls) == 1
    assert research == {"research_status": "reviewed_fallback"}


def test_research_endpoint_does_not_search_when_card_did_not_match_chat(monkeypatch):
    async def ready_sleep_context(
        _uid, preferred_session_id=None, through_created_at=None
    ):
        assert preferred_session_id is None
        assert through_created_at is None
        return {
            "state": "ready",
            "session_id": "session-1",
            "messages": [
                {
                    "id": "message-1",
                    "role": "user",
                    "text": "孩子最近夜醒，睡前很难入睡，睡眠作息很乱。",
                    "created_at": "2026-07-31T10:00:00+00:00",
                }
            ],
            "preferred_locale": "zh-CN",
            "external_research_allowed": True,
        }

    calls = []

    def should_not_search(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("web research must not run for an unrelated card")

    monkeypatch.setattr(main, "_load_recent_main_chat", ready_sleep_context)
    monkeypatch.setattr(main, "content_research_oai", object())
    monkeypatch.setattr(main, "research_learning_resources", should_not_search)

    research = asyncio.run(
        main.get_card_research("learn_picky_eating", uid="parent-private-id")
    )

    assert calls == []
    assert research == {"research_status": "reviewed_fallback"}


def test_external_research_requires_separate_explicit_consent(monkeypatch):
    async def consent_off_context(
        _uid, preferred_session_id=None, through_created_at=None
    ):
        return {
            "state": "ready",
            "session_id": "session-1",
            "messages": [
                {
                    "role": "user",
                    "text": "孩子最近夜醒，睡前很难入睡，睡眠作息很乱。",
                }
            ],
            "preferred_locale": "zh-CN",
            "external_research_allowed": False,
        }

    calls = []

    def should_not_search(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("provider must not run without explicit consent")

    monkeypatch.setattr(main, "_load_recent_main_chat", consent_off_context)
    monkeypatch.setattr(main, "content_research_oai", object())
    monkeypatch.setattr(main, "research_learning_resources", should_not_search)

    detail = asyncio.run(
        main.get_card_detail("learn_sleep_routine", uid="parent-private-id")
    )
    research = asyncio.run(
        main.get_card_research("learn_sleep_routine", uid="parent-private-id")
    )

    assert calls == []
    assert detail["research_status"] == "consent_required"
    assert research == {"research_status": "consent_required"}


def test_emergency_context_never_calls_content_research_provider(monkeypatch):
    async def urgent_context(
        _uid, preferred_session_id=None, through_created_at=None
    ):
        return {
            "state": "ready",
            "session_id": "session-urgent",
            "messages": [
                {
                    "role": "user",
                    "text": "孩子夜醒后突然不能呼吸，已经失去意识。",
                }
            ],
            "preferred_locale": "zh-CN",
            "external_research_allowed": True,
        }

    calls = []

    def should_not_search(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("emergencies must never enter content research")

    monkeypatch.setattr(main, "_load_recent_main_chat", urgent_context)
    monkeypatch.setattr(main, "content_research_oai", object())
    monkeypatch.setattr(main, "research_learning_resources", should_not_search)

    detail = asyncio.run(
        main.get_card_detail("learn_sleep_routine", uid="parent-private-id")
    )
    research = asyncio.run(
        main.get_card_research("learn_sleep_routine", uid="parent-private-id")
    )

    assert calls == []
    assert detail["research_status"] == "urgent_suppressed"
    assert research == {"research_status": "urgent_suppressed"}


@pytest.mark.parametrize(
    ("uid", "client_configured", "context", "is_match"),
    [
        (
            None,
            True,
            {"state": "ready", "messages": [{"role": "user", "text": "夜醒"}]},
            True,
        ),
        (
            "parent-1",
            False,
            {"state": "ready", "messages": [{"role": "user", "text": "夜醒"}]},
            True,
        ),
        (
            "parent-1",
            True,
            {"state": "privacy_off", "messages": [{"role": "user", "text": "夜醒"}]},
            True,
        ),
        ("parent-1", True, {"state": "ready", "messages": []}, True),
        (
            "parent-1",
            True,
            {"state": "ready", "messages": [{"role": "user", "text": "夜醒"}]},
            False,
        ),
    ],
)
def test_research_gate_never_calls_provider_when_preconditions_fail(
    monkeypatch, uid, client_configured, context, is_match
):
    calls = []

    def should_not_search(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("provider should not be called")

    monkeypatch.setattr(
        main, "content_research_oai", object() if client_configured else None
    )
    monkeypatch.setattr(main, "research_learning_resources", should_not_search)

    result = asyncio.run(
        main._research_card_detail_resources(
            card={"id": "learn_sleep_routine", "is_conversation_match": is_match},
            context=context,
            uid=uid,
        )
    )

    assert result is None
    assert calls == []
