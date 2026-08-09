"""Regression coverage for interrupted home-feed resource preparation.

These tests intentionally exercise the three-card preparation endpoint as one
atomic unit.  A partial provider answer must never make one card clickable
while the other cards remain in an indefinite preparing state.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy

import pytest

from backend import memstore, runtime  # noqa: E402
from backend import main
from backend.content_library import LEARNING_CONTENT_BY_ID
from backend.content_research import CONTENT_CATEGORIES, clear_research_cache
from backend.tests.test_content_research import (
    _FakeClient,
    _delivery_ready_parsed_bundle,
    _delivery_ready_raw_resources,
    _parsed_bundle,
    _raw_resources,
    _response,
)
from backend.tests.test_recommendation_snapshots import (
    TEST_SNAPSHOT_SECRET,
    _SettingsSupabase,
)


class _PrepareHarness:
    def __init__(
        self,
        monkeypatch,
        *,
        persistent: bool = False,
        card_id: str = "learn_sleep_routine",
        message: str = "My 11 month old wakes up and struggles to settle at bedtime.",
        recommendation_focus: str = "night waking and bedtime settling",
        child_age_context: str = "11 months",
    ):
        self.uid = "parent-prepare-failure"
        self.card_id = card_id
        self.context = {
            "state": "ready",
            "session_id": "session-prepare-failure",
            "context_created_at": "2026-08-03T10:00:00+00:00",
            "messages": [
                {
                    "role": "user",
                    "text": message,
                }
            ],
            "preferred_locale": "zh-CN",
            "external_research_allowed": True,
            "child_profile_fingerprint": "profile-prepare-failure",
            "child_age_context": child_age_context,
        }
        self.snapshots: dict[str, dict] = {}
        requested = []
        for category in CONTENT_CATEGORIES:
            snapshot = main.build_snapshot(
                self.uid,
                {
                    "id": self.card_id,
                    "content_category": category,
                    "is_conversation_match": True,
                    "recommendation_focus": recommendation_focus,
                },
                self.context,
            )
            self.snapshots[snapshot["recommendation_id"]] = snapshot
            requested.append(
                main.ResearchPrepareItem(
                    card_id=self.card_id,
                    recommendation_id=snapshot["recommendation_id"],
                )
            )
        self.request = main.ResearchPrepareRequest(items=requested)
        self.provider_calls = 0

        async def ready_context(
            uid, preferred_session_id=None, through_created_at=None
        ):
            assert uid == self.uid
            assert preferred_session_id == self.context["session_id"]
            assert through_created_at == self.context["context_created_at"]
            return deepcopy(self.context)

        async def attach_child(uid, loaded):
            assert uid == self.uid
            loaded["child_profile_fingerprint"] = self.context[
                "child_profile_fingerprint"
            ]
            loaded["child_age_context"] = self.context["child_age_context"]
            return loaded

        async def no_events(uid):
            assert uid == self.uid
            return []

        def ranked(*_args, **_kwargs):
            card = deepcopy(
                LEARNING_CONTENT_BY_ID[self.card_id]
            )
            card.update(
                {
                    "is_conversation_match": True,
                    "recommendation_focus": recommendation_focus,
                }
            )
            return [card], True

        monkeypatch.setattr(main, "_load_recent_main_chat", ready_context)
        monkeypatch.setattr(main, "_attach_child_recommendation_context", attach_child)
        monkeypatch.setattr(main, "_db_get_recommendation_events", no_events)
        monkeypatch.setattr(main, "_rank_learning_content", ranked)
        monkeypatch.setattr(main, "content_research_oai", object())

        if persistent:
            supabase = _SettingsSupabase()
            monkeypatch.setattr(main, "RECOMMENDATION_SNAPSHOT_SECRET", TEST_SNAPSHOT_SECRET)
            monkeypatch.setattr(runtime, "get_supabase", lambda: supabase)
            monkeypatch.setattr(memstore, "recommendation_snapshots", {})
            assert asyncio.run(
                main._db_persist_recommendation_snapshots(
                    self.uid, list(self.snapshots.values())
                )
            )
        else:
            async def load_snapshot(uid, recommendation_id):
                assert uid == self.uid
                return deepcopy(self.snapshots.get(recommendation_id))

            async def load_persistent(uid, recommendation_id):
                return await load_snapshot(uid, recommendation_id)

            async def persist(uid, values):
                assert uid == self.uid
                for value in values:
                    self.snapshots[value["recommendation_id"]] = deepcopy(value)
                return True

            monkeypatch.setattr(main, "_db_get_recommendation_snapshot", load_snapshot)
            monkeypatch.setattr(
                main,
                "_db_get_recommendation_snapshot_persistent",
                load_persistent,
            )
            monkeypatch.setattr(main, "_db_persist_recommendation_snapshots", persist)

    def run(self) -> dict:
        return asyncio.run(main.prepare_feed_research(self.request, uid=self.uid))

    def use_research_results(self, monkeypatch, *results: dict):
        remaining = list(results)

        async def research(**_kwargs):
            self.provider_calls += 1
            return deepcopy(remaining.pop(0))

        monkeypatch.setattr(main, "_research_card_detail_resources", research)


def _assert_atomic_retryable(result: dict) -> None:
    assert result["resource_readiness"] == "retryable"
    assert result["prepared_content_set_id"] is None
    assert len(result["items"]) == 3
    assert {item["content_category"] for item in result["items"]} == set(
        CONTENT_CATEGORIES
    )
    assert all(item["resource_readiness"] == "retryable" for item in result["items"])
    assert all(item["resource_pair_complete"] is False for item in result["items"])
    assert all(item["prepared_content_set_id"] is None for item in result["items"])
    assert all(item["resources"] == [] for item in result["items"])


def _assert_atomic_ready(result: dict) -> None:
    assert result["resource_readiness"] == "ready"
    assert result["prepared_content_set_id"].startswith("pcs_")
    assert len(result["items"]) == 3
    assert {item["content_category"] for item in result["items"]} == set(
        CONTENT_CATEGORIES
    )
    assert {
        item["prepared_content_set_id"] for item in result["items"]
    } == {result["prepared_content_set_id"]}
    for item in result["items"]:
        assert item["resource_readiness"] == "ready"
        assert item["resource_pair_complete"] is True
        assert len(item["resources"]) == 2
        assert {resource["kind"] for resource in item["resources"]} == {
            "article",
            "video",
        }
        assert {
            resource["content_category"] for resource in item["resources"]
        } == {item["content_category"]}


def test_prepare_request_requires_all_three_editorial_lanes():
    with pytest.raises(ValueError):
        main.ResearchPrepareRequest(
            items=[
                main.ResearchPrepareItem(
                    card_id="learn_language_milestones",
                    recommendation_id=f"rec_{index}",
                )
                for index in range(2)
            ]
        )


def test_personalized_feed_publishes_reviewed_pairs_during_dynamic_upgrade(
    monkeypatch,
):
    """Reviewed links stay usable while a conversation-specific upgrade runs."""

    uid = "parent-reviewed-ready"
    context = {
        "state": "ready",
        "session_id": "session-reviewed-ready",
        "context_created_at": "2026-08-03T10:00:00+00:00",
        "messages": [
            {
                "role": "user",
                "text": "我会回应孩子的声音，他会模仿爸爸妈妈，想了解11个月宝宝的语言沟通和轮流互动。",
            }
        ],
        "preferred_locale": "zh-CN",
        "external_research_allowed": True,
        "child_profile_fingerprint": "profile-reviewed-ready",
        "child_age_context": "11个月",
    }

    async def load_context(request_uid, **_kwargs):
        assert request_uid == uid
        return deepcopy(context)

    async def attach_child(request_uid, loaded):
        assert request_uid == uid
        loaded["child_profile_fingerprint"] = context[
            "child_profile_fingerprint"
        ]
        loaded["child_age_context"] = context["child_age_context"]
        return loaded

    async def no_events(request_uid):
        assert request_uid == uid
        return []

    def ranked(*_args, **_kwargs):
        card = deepcopy(LEARNING_CONTENT_BY_ID["learn_language_milestones"])
        card.update(
            {
                "is_conversation_match": True,
                "recommendation_focus": "语言发育、回应声音、亲子沟通和轮流互动",
                "related_session_id": context["session_id"],
                "context_created_at": context["context_created_at"],
            }
        )
        return [card], True

    async def attach_snapshots(request_uid, items, loaded):
        assert request_uid == uid
        assert loaded["session_id"] == context["session_id"]
        for index, item in enumerate(items):
            item["recommendation_id"] = f"rec_reviewed_{index}"

    monkeypatch.setattr(main, "_load_recent_main_chat", load_context)
    monkeypatch.setattr(main, "_attach_child_recommendation_context", attach_child)
    monkeypatch.setattr(main, "_db_get_recommendation_events", no_events)
    monkeypatch.setattr(main, "_rank_learning_content", ranked)
    monkeypatch.setattr(main, "_attach_recommendation_snapshots", attach_snapshots)
    monkeypatch.setattr(main, "content_research_oai", object())

    result = asyncio.run(
        main.get_personalized_feed(
            count=3,
            presentation="category_cards",
            uid=uid,
        )
    )

    assert len(result["items"]) == 3
    assert {item["content_category"] for item in result["items"]} == set(
        CONTENT_CATEGORIES
    )
    for item in result["items"]:
        assert item["resource_readiness"] == "ready"
        assert item["resource_pair_complete"] is True
        assert len(item["resources"]) == 2
        assert {resource["kind"] for resource in item["resources"]} == {
            "article",
            "video",
        }
        assert item["research_status"] == "reviewed_fallback"
        assert item["prepared_content_set_id"] is None


def _assert_reviewed_whitelist_ready(result: dict) -> None:
    _assert_atomic_ready(result)
    assert result["research_status"] == "reviewed_whitelist"
    resources = [
        resource for item in result["items"] for resource in item["resources"]
    ]
    assert len(resources) == 6
    assert all(
        resource["research_source"] == "reviewed_whitelist"
        and resource["link_health_status"] == "manual_verified"
        and resource["delivery_source_contract"]
        == main.DELIVERY_SOURCE_CONTRACT_VERSION
        for resource in resources
    )


def test_prepare_provider_failure_publishes_diverse_reviewed_whitelist(
    monkeypatch,
):
    """A provider outage publishes only the exact, diverse six-slot whitelist."""

    harness = _PrepareHarness(
        monkeypatch,
        card_id="learn_language_milestones",
        message="我会回应孩子的声音，他会模仿爸爸妈妈，想了解9个月宝宝的语言沟通和轮流互动。",
        recommendation_focus="语言发育、回应声音、亲子沟通和轮流互动",
        child_age_context="9个月",
    )
    harness.use_research_results(
        monkeypatch,
        {"_provider_failure": "retryable"},
    )

    result = harness.run()

    assert harness.provider_calls == 1
    _assert_reviewed_whitelist_ready(result)
    resources = [
        resource for item in result["items"] for resource in item["resources"]
    ]
    authority_article = next(
        resource
        for resource in resources
        if resource["content_category"] == "authority"
        and resource["kind"] == "article"
    )
    assert authority_article["translation_type"] == "official_translation"
    assert authority_article["display_locale"] == "zh-CN"
    authority_video = next(
        resource
        for resource in resources
        if resource["content_category"] == "authority"
        and resource["kind"] == "video"
    )
    assert authority_video["id"] == (
        "language-sfaa-7-12-authority-video-zh-cn-v1"
    )
    assert authority_video["content_substance_status"] == "verified"
    featured_article = next(
        resource
        for resource in resources
        if resource["content_category"] == "featured"
        and resource["kind"] == "article"
    )
    featured_video = next(
        resource
        for resource in resources
        if resource["content_category"] == "featured"
        and resource["kind"] == "video"
    )
    assert featured_article["id"] == (
        "language-dxy-six-ways-featured-article-zh-cn-v1"
    )
    assert featured_article["publisher"] == "丁香妈妈"
    assert featured_article["featured_readability_status"] == "verified"
    assert featured_video["id"] == "language-huang-featured-video-zh-cn-v1"
    assert featured_video["content_substance_status"] == "verified"
    assert featured_video["featured_readability_status"] == "verified"
    assert all(
        "UNICEF" not in str(resource.get("publisher") or "").upper()
        for resource in resources
        if resource["content_category"] == "featured"
    )
    assert all(
        resource.get("source_language") in {"zh-CN", "zh-TW"}
        for resource in resources
        if resource["content_category"] in {"featured", "case"}
        and resource["kind"] == "article"
    )
    assert all(
        resource.get("translation_type") == "official_translation"
        or (
            resource.get("source_language") != "en"
            and resource.get("translation_type") == "original"
        )
        for resource in resources
        if resource["content_category"] in {"authority", "featured"}
        and resource["kind"] == "article"
    )
    assert all(
        resource.get("spoken_language") == "mandarin"
        for resource in resources
        if resource["kind"] == "video"
    )
    assert all(
        resource.get("spoken_language") != "english"
        for item in result["items"]
        for pair in [item["resources"], *item.get("alternate_resource_pairs", [])]
        for resource in (
            pair.get("resources", []) if isinstance(pair, dict) else pair
        )
        if resource.get("kind") == "video"
    )


def test_reviewed_whitelist_ready_card_opens_without_another_provider_call(
    monkeypatch,
):
    """A published fallback pair and the detail endpoint share one ready gate."""

    harness = _PrepareHarness(
        monkeypatch,
        card_id="learn_language_milestones",
        message="我想了解11个月宝宝的语言沟通和轮流互动。",
        recommendation_focus="语言发育、亲子沟通和轮流互动",
        child_age_context="11个月",
    )
    harness.use_research_results(
        monkeypatch,
        {"_provider_failure": "retryable"},
    )
    prepared = harness.run()
    authority = next(
        item
        for item in prepared["items"]
        if item["content_category"] == "authority"
    )

    detail = asyncio.run(
        main.get_card_detail(
            card_id=harness.card_id,
            recommendation_id=authority["recommendation_id"],
            prepared_content_set_id=prepared["prepared_content_set_id"],
            content_category="authority",
            uid=harness.uid,
        )
    )

    assert harness.provider_calls == 1
    assert detail["resource_readiness"] == "ready"
    assert detail["resource_pair_complete"] is True
    assert detail["resources"] == authority["resources"]


@pytest.mark.parametrize(
    "recommendation_focus",
    main._TOPIC_SIGNAL_ALIASES["learn_language_milestones"],
)
def test_language_reviewed_whitelist_covers_every_conversation_focus(
    monkeypatch,
    recommendation_focus,
):
    """Every language alias can use the same stage-matched verified source set."""

    harness = _PrepareHarness(
        monkeypatch,
        card_id="learn_language_milestones",
        message=f"我想了解宝宝最近的{recommendation_focus}。",
        recommendation_focus=recommendation_focus,
        child_age_context="11个月",
    )
    harness.use_research_results(
        monkeypatch,
        {"_provider_failure": "retryable"},
    )

    result = harness.run()

    assert harness.provider_calls == 1
    _assert_reviewed_whitelist_ready(result)


def test_prepare_rejects_six_resources_when_one_lane_is_not_article_and_video(
    monkeypatch,
):
    """A six-item answer is still incomplete when one lane has two articles."""

    bundle = _parsed_bundle(include_optional_third=False)
    featured_video = next(
        resource
        for resource in bundle["resources"]
        if resource["content_category"] == "featured"
        and resource["kind"] == "video"
    )
    featured_video["kind"] = "article"
    harness = _PrepareHarness(monkeypatch)
    harness.use_research_results(monkeypatch, bundle)

    result = harness.run()

    assert harness.provider_calls == 1
    _assert_atomic_retryable(result)


def test_prepare_is_atomic_when_any_one_of_three_category_pairs_is_missing(
    monkeypatch,
):
    """Five valid slots cannot publish the two otherwise-complete cards."""

    bundle = _parsed_bundle(include_optional_third=False)
    bundle["resources"] = [
        resource
        for resource in bundle["resources"]
        if not (
            resource["content_category"] == "case"
            and resource["kind"] == "video"
        )
    ]
    harness = _PrepareHarness(monkeypatch)
    harness.use_research_results(monkeypatch, bundle)

    result = harness.run()

    assert harness.provider_calls == 1
    _assert_atomic_retryable(result)


def test_prepare_provider_timeout_returns_retryable_for_all_three_cards(
    monkeypatch,
):
    """The actual provider boundary converts a timeout into a retryable set."""

    harness = _PrepareHarness(monkeypatch)
    calls = []

    def provider_timeout(*_args, **_kwargs):
        calls.append(1)
        raise TimeoutError("provider timed out")

    monkeypatch.setattr(main, "research_learning_resources", provider_timeout)

    result = harness.run()

    assert calls == [1]
    _assert_atomic_retryable(result)


def test_prepare_can_recover_after_timeout_from_a_cold_serverless_instance(
    monkeypatch,
):
    """A durable preparing marker must not strand the next cold invocation."""

    harness = _PrepareHarness(monkeypatch, persistent=True)
    complete = _delivery_ready_parsed_bundle()
    harness.use_research_results(
        monkeypatch,
        {"_provider_failure": "retryable"},
        complete,
    )

    first = harness.run()
    _assert_atomic_retryable(first)

    # Vercel may route the next retry to a new process with an empty local
    # cache.  The encrypted app_settings snapshots are the only surviving state.
    monkeypatch.setattr(memstore, "recommendation_snapshots", {})
    recovered = harness.run()

    # The first retry produces the complete primary bundle. The delivery
    # contract may make one bounded reserve request to prewarm an instant
    # alternate; failure of that optional reserve cannot roll back primary.
    assert harness.provider_calls >= 2
    assert recovered["resource_readiness"] == "ready"
    assert recovered["prepared_content_set_id"].startswith("pcs_")
    assert len({item["prepared_content_set_id"] for item in recovered["items"]}) == 1
    assert all(item["resource_readiness"] == "ready" for item in recovered["items"])
    assert all(item["resource_pair_complete"] is True for item in recovered["items"])
    assert all(
        {resource["kind"] for resource in item["resources"]}
        == {"article", "video"}
        for item in recovered["items"]
    )


def test_prepare_upgrades_legacy_single_pair_set_before_returning(monkeypatch):
    """A v2 ready set must be expanded instead of trapping clients in retry."""

    harness = _PrepareHarness(monkeypatch)
    bundle = _delivery_ready_parsed_bundle()
    old_set_id = f"pcs_{'e' * 24}"
    for recommendation_id, snapshot in list(harness.snapshots.items()):
        category = str(snapshot["content_category"])
        resources = [
            resource
            for resource in bundle["resources"]
            if resource["content_category"] == category
        ]
        old_pair = [
            next(resource for resource in resources if resource["kind"] == "article"),
            next(resource for resource in resources if resource["kind"] == "video"),
        ]
        legacy = main.snapshot_with_prepared_resource_pair(
            snapshot,
            old_pair,
            content_set_id=old_set_id,
        )
        legacy["version"] = 2
        legacy.pop("prepared_resource_pairs", None)
        legacy.pop("active_pair_id", None)
        harness.snapshots[recommendation_id] = legacy

    harness.use_research_results(monkeypatch, bundle)
    result = harness.run()

    assert harness.provider_calls >= 1
    assert result["resource_readiness"] == "ready"
    assert result["prepared_content_set_id"] != old_set_id
    assert result["publication_state"] == "published"
    assert all(item["alternate_count"] >= 1 for item in result["items"])
    assert all(len(item["alternate_resource_pairs"]) >= 1 for item in result["items"])


def test_immediate_retry_after_incomplete_bundle_bypasses_warm_failure_cache(
    monkeypatch,
):
    """A user's retry must perform new work, not replay a 180s negative cache."""

    clear_research_cache()
    incomplete_resources = [
        resource
        for resource in _delivery_ready_raw_resources(include_optional_third=False)
        if not (
            resource["content_category"] == "case"
            and resource["kind"] == "video"
        )
    ]
    incomplete = _response(incomplete_resources)
    complete = _response(
        _delivery_ready_raw_resources(include_optional_third=False)
    )
    provider = _FakeClient((incomplete, incomplete, incomplete, complete))
    harness = _PrepareHarness(monkeypatch)
    monkeypatch.setattr(main, "content_research_oai", provider)

    try:
        first = harness.run()
        _assert_atomic_retryable(first)
        assert len(provider.responses.calls) == 3

        recovered = harness.run()

        # The fourth call is the required fresh primary attempt. Additional
        # calls are bounded reserve preparation for instant alternatives.
        assert len(provider.responses.calls) >= 4
        assert recovered["resource_readiness"] == "ready"
        assert all(
            item["resource_readiness"] == "ready"
            and item["resource_pair_complete"] is True
            for item in recovered["items"]
        )
    finally:
        clear_research_cache()
