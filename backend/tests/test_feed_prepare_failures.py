"""Regression coverage for interrupted home-feed resource preparation.

These tests intentionally exercise the three-card preparation endpoint as one
atomic unit.  A partial provider answer must never make one card clickable
while the other cards remain in an indefinite preparing state.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy

import pytest

from backend import main
from backend.content_library import LEARNING_CONTENT_BY_ID
from backend.content_research import CONTENT_CATEGORIES, clear_research_cache
from backend.tests.test_content_research import (
    _FakeClient,
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
            monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
            monkeypatch.setattr(main, "_recommendation_snapshots", {})
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


def test_personalized_feed_exposes_complete_reviewed_pairs_without_waiting_for_provider(
    monkeypatch,
):
    """A reviewed exact match is immediately clickable even when research is on.

    Live research may later improve the choice, but it must not downgrade six
    already-reviewed, age/topic/locale-compliant resources to ``preparing`` and
    make the Home card depend on an external provider before it can be opened.
    """

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
        assert item["prepared_content_set_id"] is None


def test_prepare_provider_failure_publishes_complete_reviewed_set_when_all_slots_pass(
    monkeypatch,
):
    """A transient provider outage must not block a fully reviewed exact match.

    This is the production click path reported by the user: the conversation is
    about an 11-month-old's language communication, and the reviewed zh-CN
    library has an age-, language- and topic-matched article/video pair for each
    editorial lane.  Publishing remains atomic; this fallback is allowed only
    when all six independently reviewed slots pass the normal hard gates.
    """

    harness = _PrepareHarness(
        monkeypatch,
        card_id="learn_language_milestones",
        message="我会回应孩子的声音，他会模仿爸爸妈妈，想了解11个月宝宝的语言沟通和轮流互动。",
        recommendation_focus="语言发育、回应声音、亲子沟通和轮流互动",
        child_age_context="11个月",
    )
    harness.use_research_results(
        monkeypatch,
        {"_provider_failure": "retryable"},
    )

    result = harness.run()

    assert harness.provider_calls == 1
    _assert_atomic_ready(result)


@pytest.mark.parametrize(
    "recommendation_focus",
    main._TOPIC_SIGNAL_ALIASES["learn_language_milestones"],
)
def test_language_reviewed_fallback_matches_every_production_language_signal(
    monkeypatch,
    recommendation_focus,
):
    """Every focus emitted by production ranking keeps all three lanes open."""

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

    _assert_atomic_ready(result)


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
    complete = _parsed_bundle(include_optional_third=False)
    harness.use_research_results(
        monkeypatch,
        {"_provider_failure": "retryable"},
        complete,
    )

    first = harness.run()
    _assert_atomic_retryable(first)

    # Vercel may route the next retry to a new process with an empty local
    # cache.  The encrypted app_settings snapshots are the only surviving state.
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    recovered = harness.run()

    assert harness.provider_calls == 2
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


def test_immediate_retry_after_incomplete_bundle_bypasses_warm_failure_cache(
    monkeypatch,
):
    """A user's retry must perform new work, not replay a 180s negative cache."""

    clear_research_cache()
    incomplete_resources = [
        resource
        for resource in _raw_resources(include_optional_third=False)
        if not (
            resource["content_category"] == "case"
            and resource["kind"] == "video"
        )
    ]
    incomplete = _response(incomplete_resources)
    complete = _response(_raw_resources(include_optional_third=False))
    provider = _FakeClient((incomplete, incomplete, incomplete, complete))
    harness = _PrepareHarness(monkeypatch)
    monkeypatch.setattr(main, "content_research_oai", provider)

    try:
        first = harness.run()
        _assert_atomic_retryable(first)
        assert len(provider.responses.calls) == 3

        recovered = harness.run()

        assert len(provider.responses.calls) == 4
        assert recovered["resource_readiness"] == "ready"
        assert all(
            item["resource_readiness"] == "ready"
            and item["resource_pair_complete"] is True
            for item in recovered["items"]
        )
    finally:
        clear_research_cache()
