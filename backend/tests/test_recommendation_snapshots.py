"""Coverage for stable personalized recommendation snapshots."""

import asyncio
import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest

from backend import main
from backend.recommendation_snapshots import (
    build_snapshot,
    prepared_resource_pair,
    parse_snapshot,
    recommendation_id,
    serialize_snapshot,
    snapshot_with_prepared_resource_pair,
    snapshot_storage_key,
    snapshot_storage_prefix,
)


TEST_SNAPSHOT_SECRET = "unit-test-snapshot-secret"


@pytest.fixture(autouse=True)
def _stable_snapshot_secret(monkeypatch):
    monkeypatch.setattr(
        main, "RECOMMENDATION_SNAPSHOT_SECRET", TEST_SNAPSHOT_SECRET
    )


def test_recommendation_id_is_stable_and_opaque():
    first = recommendation_id(
        "private-user-123",
        card_id="learn_language_milestones",
        session_id="session-secret",
        context_created_at="2026-08-01T10:00:00+00:00",
    )
    second = recommendation_id(
        "private-user-123",
        card_id="learn_language_milestones",
        session_id="session-secret",
        context_created_at="2026-08-01T10:00:00+00:00",
    )

    assert first == second
    assert first.startswith("rec_")
    assert "private-user" not in first
    assert "session-secret" not in first


def test_recommendation_id_changes_with_child_profile_version():
    base = dict(
        card_id="learn_language_milestones",
        session_id="session-secret",
        context_created_at="2026-08-01T10:00:00+00:00",
    )

    first = recommendation_id(
        "private-user-123", **base, profile_fingerprint="age-profile-a"
    )
    second = recommendation_id(
        "private-user-123", **base, profile_fingerprint="age-profile-b"
    )

    assert first != second


def test_category_snapshots_are_unique_and_freeze_category_and_locale():
    context = {
        "session_id": "main-session",
        "context_created_at": "2026-08-01T10:00:00+00:00",
        "preferred_locale": "zh-TW",
    }
    snapshots = [
        build_snapshot(
            "parent-1",
            {
                "id": "learn_sleep_routine",
                "content_category": category,
            },
            context,
        )
        for category in ("authority", "featured", "case")
    ]

    assert len({snapshot["recommendation_id"] for snapshot in snapshots}) == 3
    assert [snapshot["content_category"] for snapshot in snapshots] == [
        "authority",
        "featured",
        "case",
    ]
    assert all(snapshot["preferred_locale"] == "zh-TW" for snapshot in snapshots)
    assert all(snapshot["card_id"] == "learn_sleep_routine" for snapshot in snapshots)


def test_snapshot_round_trip_is_bounded_and_user_namespaced():
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    snapshot = build_snapshot(
        "parent-1",
        {
            "id": "learn_language_milestones",
            "personalization_reason": "因为你希望获得九个月宝宝的轮流发声练习",
            "recommendation_focus": "轮流发声",
            "recommendation_intent": "action_plan",
            "recommendation_score": 27,
        },
        {
            "session_id": "main-session",
            "context_created_at": "2026-08-01T10:00:00+00:00",
            "child_profile_fingerprint": "safe-profile-version",
            "child_age_context": "孩子当前年龄：10个月",
        },
        now=now,
    )

    serialized = serialize_snapshot(snapshot, secret=TEST_SNAPSHOT_SECRET)
    restored = parse_snapshot(
        serialized,
        now=now,
        secret=TEST_SNAPSHOT_SECRET,
    )

    assert restored == snapshot
    assert serialized.startswith("fernet:v1:")
    assert "main-session" not in serialized
    assert "action_plan" not in serialized
    assert restored["session_id"] == "main-session"
    assert restored["recommendation_intent"] == "action_plan"
    assert restored["child_profile_fingerprint"] == "safe-profile-version"
    assert restored["child_age_context"] == "孩子当前年龄：10个月"
    assert snapshot_storage_key("parent-1", snapshot["recommendation_id"]).endswith(
        snapshot["recommendation_id"]
    )
    assert "parent-1" not in snapshot_storage_key(
        "parent-1", snapshot["recommendation_id"]
    )
    assert snapshot_storage_key(
        "parent-1", snapshot["recommendation_id"]
    ).startswith(snapshot_storage_prefix("parent-1"))


def test_expired_or_malformed_snapshot_is_rejected():
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    snapshot = build_snapshot(
        "parent-1",
        {"id": "learn_sleep_routine"},
        {"session_id": "session-1", "context_created_at": now.isoformat()},
        now=now - timedelta(days=91),
    )

    assert parse_snapshot(
        serialize_snapshot(snapshot, secret=TEST_SNAPSHOT_SECRET),
        now=now,
        secret=TEST_SNAPSHOT_SECRET,
    ) is None
    assert parse_snapshot("not json", now=now) is None
    assert parse_snapshot(
        json.dumps(snapshot),
        now=now,
        secret=TEST_SNAPSHOT_SECRET,
    ) is None
    assert parse_snapshot(
        serialize_snapshot(snapshot, secret=TEST_SNAPSHOT_SECRET),
        now=now - timedelta(days=92),
        secret="wrong-secret",
    ) is None
    with pytest.raises(ValueError):
        snapshot_storage_key("parent-1", "bad-id")


def test_version_one_snapshot_remains_readable_during_upgrade():
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    snapshot = build_snapshot(
        "parent-1",
        {"id": "learn_sleep_routine"},
        {"session_id": "session-1", "context_created_at": now.isoformat()},
        now=now,
    )
    snapshot["version"] = 1
    snapshot["context_version"] = "multi-session-intent-v1"
    snapshot.pop("child_profile_fingerprint", None)
    snapshot.pop("child_age_context", None)

    restored = parse_snapshot(
        serialize_snapshot(snapshot, secret=TEST_SNAPSHOT_SECRET),
        now=now,
        secret=TEST_SNAPSHOT_SECRET,
    )

    assert restored is not None
    assert restored["version"] == 1
    assert restored["child_profile_fingerprint"] is None
    assert restored["child_age_context"] == ""


class _Result:
    def __init__(self, data=None):
        self.data = data


class _SettingsTable:
    def __init__(self, store, *, fail_delete=False):
        self.store = store
        self.fail_delete = fail_delete
        self.action = "select"
        self.rows = None
        self.key = None
        self.key_prefix = None
        self.ignore_duplicates = False

    def upsert(self, rows, **kwargs):
        self.action = "upsert"
        self.rows = rows
        self.ignore_duplicates = bool(kwargs.get("ignore_duplicates"))
        return self

    def select(self, *_args):
        self.action = "select"
        return self

    def delete(self):
        self.action = "delete"
        return self

    def eq(self, field, value):
        assert field == "key"
        self.key = value
        return self

    def limit(self, value):
        assert value == 1
        return self

    def like(self, field, value):
        assert field == "key"
        assert value.endswith("%")
        self.key_prefix = value[:-1]
        return self

    def execute(self):
        if self.action == "upsert":
            rows = self.rows if isinstance(self.rows, list) else [self.rows]
            for row in rows:
                if self.ignore_duplicates and row["key"] in self.store:
                    continue
                self.store[row["key"]] = row["value"]
            return _Result(rows)
        if self.action == "delete":
            if self.fail_delete:
                raise RuntimeError("delete unavailable")
            deleted = [
                key for key in self.store if key.startswith(self.key_prefix or "")
            ]
            for key in deleted:
                self.store.pop(key, None)
            return _Result([{"key": key} for key in deleted])
        value = self.store.get(self.key)
        return _Result([{"value": value}] if value is not None else [])


class _SettingsSupabase:
    def __init__(self, *, fail_delete=False):
        self.store = {}
        self.fail_delete = fail_delete

    def table(self, name):
        if name == "recommendation_events":
            exc = RuntimeError(
                "Could not find recommendation_events in the schema cache"
            )
            exc.code = "PGRST205"
            raise exc
        assert name == "app_settings"
        return _SettingsTable(self.store, fail_delete=self.fail_delete)


def test_category_card_feed_and_details_keep_fixed_two_resource_contract(
    monkeypatch,
):
    supabase = _SettingsSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    monkeypatch.setattr(main, "content_research_oai", None)
    context = {
        "state": "ready",
        "session_id": "main-session",
        "context_created_at": "2026-08-01T10:00:00+00:00",
        "preferred_locale": "zh-TW",
        "external_research_allowed": False,
        "help_preference": "experience",
        "info_source": "parents",
        "messages": [
            {
                "id": "message-1",
                "session_id": "main-session",
                "role": "user",
                "text": "My baby wakes several times every night and needs a bedtime routine.",
                "created_at": "2026-08-01T10:00:00+00:00",
                "context_scope": "current_session",
            }
        ],
    }

    async def load_context(*_args, **_kwargs):
        return context

    async def leave_child_context_unchanged(_uid, loaded_context):
        return loaded_context

    async def no_events(_uid):
        return []

    monkeypatch.setattr(main, "_load_recent_main_chat", load_context)
    monkeypatch.setattr(
        main,
        "_attach_child_recommendation_context",
        leave_child_context_unchanged,
    )
    monkeypatch.setattr(main, "_db_get_recommendation_events", no_events)

    payload = asyncio.run(
        main.get_personalized_feed(
            count=3,
            presentation="category_cards",
            uid="parent-1",
        )
    )
    items = payload["items"]

    assert payload["model_version"] == "questionnaire-behavior-category-pairs-v2"
    assert sum(payload["category_mix"].values()) == 100
    assert payload["category_mix"]["case"] == max(
        payload["category_mix"].values()
    )
    assert payload["category_mix"]["authority"] >= 25
    assert payload["initial_content_category"] in {
        "authority",
        "featured",
        "case",
    }
    assert [item["content_category"] for item in items] == [
        "authority",
        "featured",
        "case",
    ]
    assert [item["rank"] for item in items] == [1, 2, 3]
    assert len({item["recommendation_id"] for item in items}) == 3
    assert {item["id"] for item in items} == {"learn_sleep_routine"}
    assert {
        item["content_category"]: item["category_preference_weight"]
        for item in items
    } == payload["category_mix"]
    assert sum(item["is_primary_exposure_category"] for item in items) == 1

    for item in items:
        category = item["content_category"]
        assert item["resource_pair_complete"] is True
        assert item["resource_readiness"] == "ready"
        assert item["research_status"] == "ready"
        assert len(item["resources"]) == 2
        assert {resource["kind"] for resource in item["resources"]} == {
            "article",
            "video",
        }
        assert item["headline_source"] == "reviewed_article"
        assert item["resource_blueprint"] == {category: ["article", "video"]}
        assert item["resource_summary"]["preferred_locale"] == "zh-TW"
        assert item["resource_summary"]["categories"][category] == {
            "article": 1,
            "video": 1,
        }
        assert sum(
            count
            for formats in item["resource_summary"]["categories"].values()
            for count in formats.values()
        ) == 2

        snapshot = asyncio.run(
            main._db_get_recommendation_snapshot(
                "parent-1", item["recommendation_id"]
            )
        )
        assert snapshot["card_id"] == item["id"]
        assert snapshot["content_category"] == category
        assert snapshot["preferred_locale"] == "zh-TW"

        detail = asyncio.run(
            main.get_card_detail(
                item["id"],
                recommendation_id=item["recommendation_id"],
                content_category=category,
                uid="parent-1",
            )
        )
        assert detail["content_category"] == category
        assert detail["preferred_locale"] == "zh-TW"
        assert detail["resource_pair_complete"] is True
        assert detail["resource_blueprint"] == {category: ["article", "video"]}
        assert len(detail["resources"]) == 2
        assert [resource["kind"] for resource in detail["resources"]] == [
            "article",
            "video",
        ]
        assert all(
            resource["content_category"] == category
            and "zh-TW" in (resource.get("locales") or [])
            for resource in detail["resources"]
        )
        assert detail["resource_summary"]["categories"][category] == {
            "article": 1,
            "video": 1,
        }
        assert sum(
            count
            for formats in detail["resource_summary"]["categories"].values()
            for count in formats.values()
        ) == 2

    authority = items[0]
    with pytest.raises(Exception) as error:
        asyncio.run(
            main.get_card_detail(
                authority["id"],
                recommendation_id=authority["recommendation_id"],
                content_category="featured",
                uid="parent-1",
            )
        )
    assert getattr(error.value, "status_code", None) == 404


def test_category_cards_use_distinct_honest_fallback_headlines_without_articles(
    monkeypatch,
):
    base_card = deepcopy(main.LEARNING_CONTENT_BY_ID["learn_language_milestones"])
    base_card.update(
        {
            "is_conversation_match": True,
            "recommendation_focus": "宝宝会重复音节，也会回应名字",
            "child_age_context": "孩子当前年龄：9个月",
        }
    )
    monkeypatch.setattr(
        main,
        "_reviewed_category_resource_pair",
        lambda *_args, **_kwargs: [],
    )

    cards = [
        main._category_feed_card(
            base_card,
            category,
            "zh-CN",
            context_state="ready",
        )
        for category in main.CONTENT_CATEGORIES
    ]

    assert len({card["title"] for card in cards}) == 3
    assert [card["headline_source"] for card in cards] == [
        "category_fallback",
        "category_fallback",
        "category_fallback",
    ]
    assert [card["publisher"] for card in cards] == [
        "NURI 权威来源筛选",
        "NURI 编辑精选",
        "NURI 真实家庭案例",
    ]
    assert all(card["title"] != base_card["title"] for card in cards)


def test_profile_only_category_feed_loads_events_and_attaches_age_before_cards(
    monkeypatch,
):
    context = {
        "state": "no_history",
        "session_id": None,
        "preferred_locale": "zh-CN",
        "external_research_allowed": False,
        "help_preference": "experience",
        "info_source": "parents",
        "child_age_context": "孩子当前年龄：30个月",
        "messages": [],
    }
    behavior_events = [
        {
            "event": "helpful",
            "card_id": "learn_development_milestones",
            "content_category": "case",
        }
    ]
    captured: dict[str, object] = {}

    async def load_context(*_args, **_kwargs):
        return dict(context)

    async def leave_context_unchanged(_uid, loaded_context):
        return loaded_context

    async def load_events(uid):
        captured["events_uid"] = uid
        return behavior_events

    def rank_default(*_args, **kwargs):
        captured["rank_events"] = kwargs.get("behavior_events")
        card = deepcopy(main.LEARNING_CONTENT_BY_ID["learn_development_milestones"])
        card["is_conversation_match"] = False
        return [card], False

    original_category_card = main._category_feed_card

    def inspect_category_card(base_card, *args, **kwargs):
        assert base_card["child_age_context"] == "孩子当前年龄：30个月"
        return original_category_card(base_card, *args, **kwargs)

    async def skip_snapshots(_uid, cards, _context):
        return cards

    monkeypatch.setattr(main, "_load_recent_main_chat", load_context)
    monkeypatch.setattr(
        main,
        "_attach_child_recommendation_context",
        leave_context_unchanged,
    )
    monkeypatch.setattr(main, "_db_get_recommendation_events", load_events)
    monkeypatch.setattr(main, "_rank_learning_content", rank_default)
    monkeypatch.setattr(main, "_category_feed_card", inspect_category_card)
    monkeypatch.setattr(main, "_attach_recommendation_snapshots", skip_snapshots)

    payload = asyncio.run(
        main.get_personalized_feed(
            count=3,
            presentation="category_cards",
            uid="profile-only-parent",
        )
    )

    assert captured["events_uid"] == "profile-only-parent"
    assert captured["rank_events"] == behavior_events
    assert payload["personalization_mode"] == "profile"
    assert all(
        item["child_age_context"] == "孩子当前年龄：30个月"
        for item in payload["items"]
    )


def test_snapshot_survives_process_cache_and_restores_detail_reason(monkeypatch):
    supabase = _SettingsSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    context = {
        "state": "ready",
        "session_id": "main-session",
        "context_created_at": "2026-08-01T10:00:00+00:00",
        "preferred_locale": "zh-CN",
        "external_research_allowed": False,
        "messages": [
            {
                "id": "message-1",
                "session_id": "main-session",
                "role": "user",
                "text": "我想练习九个月宝宝轮流发声和语言理解。",
                "created_at": "2026-08-01T10:00:00+00:00",
                "context_scope": "current_session",
            }
        ],
    }
    cards, _ = main._rank_learning_content(
        context["messages"],
        count=4,
        session_id=context["session_id"],
        context_created_at=context["context_created_at"],
    )
    language_card = next(
        card for card in cards if card["id"] == "learn_language_milestones"
    )
    language_card["personalization_reason"] = "冻结后的具体推荐理由"

    asyncio.run(
        main._attach_recommendation_snapshots("parent-1", [language_card], context)
    )
    rec_id = language_card["recommendation_id"]
    assert language_card["recommendation_context_status"] == "persisted"

    # Simulate a Vercel cold start: process-local cache disappears while the
    # existing app_settings row remains available.
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    restored = asyncio.run(main._db_get_recommendation_snapshot("parent-1", rec_id))
    assert restored["personalization_reason"] == "冻结后的具体推荐理由"

    async def load_context(*_args, **_kwargs):
        return context

    monkeypatch.setattr(main, "_load_recent_main_chat", load_context)
    detail = asyncio.run(
        main.get_card_detail(
            "learn_language_milestones",
            recommendation_id=rec_id,
            uid="parent-1",
        )
    )

    assert detail["recommendation_id"] == rec_id
    assert detail["recommendation_context_status"] == "snapshot"
    assert detail["personalization_reason"] == "冻结后的具体推荐理由"
    assert detail["is_conversation_match"] is True
    assert detail["related_session_id"] == "main-session"


def test_prepared_pair_survives_cold_cache_and_repeated_feed(monkeypatch):
    supabase = _SettingsSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    context = {
        "state": "ready",
        "session_id": "session-prepared",
        "context_created_at": "2026-08-03T10:00:00+00:00",
        "preferred_locale": "zh-CN",
        "child_profile_fingerprint": "profile-prepared",
        "child_age_context": "孩子当前年龄：11个月",
    }
    card = {
        "id": "learn_sleep_routine",
        "content_category": "authority",
        "is_conversation_match": True,
        "resource_readiness": "preparing",
    }
    snapshot = build_snapshot("parent-prepared", card, context)
    pair = [
        {
            "id": "prepared-article",
            "kind": "article",
            "content_category": "authority",
            "locales": ["zh-CN"],
            "title": "真实准备文章",
            "publisher": "权威机构",
            "description": "准备好的文章摘要",
            "url": "https://example.org/prepared-article",
        },
        {
            "id": "prepared-video",
            "kind": "video",
            "content_category": "authority",
            "locales": ["zh-CN"],
            "title": "真实准备视频",
            "publisher": "权威机构",
            "url": "https://example.org/prepared-video",
        },
    ]
    prepared = snapshot_with_prepared_resource_pair(
        snapshot,
        pair,
        content_set_id=f"pcs_{'a' * 24}",
    )

    assert asyncio.run(
        main._db_persist_recommendation_snapshots("parent-prepared", [prepared])
    )
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    restored = asyncio.run(
        main._db_get_recommendation_snapshot(
            "parent-prepared",
            snapshot["recommendation_id"],
        )
    )
    assert prepared_resource_pair(restored) == pair

    rebuilt_card = deepcopy(card)
    asyncio.run(
        main._attach_recommendation_snapshots(
            "parent-prepared",
            [rebuilt_card],
            context,
        )
    )
    assert rebuilt_card["resource_readiness"] == "ready"
    assert rebuilt_card["prepared_content_set_id"] == f"pcs_{'a' * 24}"
    assert rebuilt_card["resources"] == pair
    assert rebuilt_card["title"] == "真实准备文章"

    stale_retryable = deepcopy(snapshot)
    stale_retryable["resource_readiness"] = "retryable"
    assert asyncio.run(
        main._db_persist_recommendation_snapshots(
            "parent-prepared",
            [stale_retryable],
        )
    )
    assert prepared_resource_pair(stale_retryable) == pair
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    still_ready = asyncio.run(
        main._db_get_recommendation_snapshot(
            "parent-prepared",
            snapshot["recommendation_id"],
        )
    )
    assert prepared_resource_pair(still_ready) == pair


def test_provider_failure_returns_retryable_while_durable_preparing_is_monotonic(
    monkeypatch,
):
    supabase = _SettingsSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    snapshot = build_snapshot(
        "parent-retryable",
        {
            "id": "learn_language_milestones",
            "content_category": "authority",
            "resource_readiness": "preparing",
        },
        {
            "session_id": "session-retryable",
            "context_created_at": "2026-08-03T10:00:00+00:00",
            "preferred_locale": "zh-CN",
        },
    )

    preparing = main.snapshot_with_resource_readiness(snapshot, "preparing")
    assert asyncio.run(
        main._db_persist_recommendation_snapshots(
            "parent-retryable",
            [preparing],
        )
    )

    retryable = asyncio.run(
        main._mark_prepare_retryable("parent-retryable", [preparing])
    )

    assert retryable[0]["resource_readiness"] == "retryable"
    assert prepared_resource_pair(retryable[0]) is None

    # A cold process still sees the durable in-flight marker. The retryable
    # response is invocation-local and cannot downgrade a concurrently ready
    # row in another Vercel instance.
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    durable = asyncio.run(
        main._db_get_recommendation_snapshot(
            "parent-retryable",
            snapshot["recommendation_id"],
        )
    )
    assert durable["resource_readiness"] == "preparing"


def test_persistent_ready_snapshot_wins_over_stale_process_cache(monkeypatch):
    supabase = _SettingsSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    uid = "parent-cross-instance"
    snapshot = build_snapshot(
        uid,
        {
            "id": "learn_language_milestones",
            "content_category": "authority",
        },
        {
            "session_id": "session-cross-instance",
            "context_created_at": "2026-08-03T10:00:00+00:00",
            "preferred_locale": "zh-CN",
        },
    )
    preparing = main.snapshot_with_resource_readiness(snapshot, "preparing")
    pair = [
        {
            "id": "cross-instance-article",
            "kind": "article",
            "content_category": "authority",
            "locales": ["zh-CN"],
            "url": "https://example.org/cross-instance-article",
        },
        {
            "id": "cross-instance-video",
            "kind": "video",
            "content_category": "authority",
            "locales": ["zh-CN"],
            "url": "https://example.org/cross-instance-video",
        },
    ]
    ready = snapshot_with_prepared_resource_pair(
        snapshot,
        pair,
        content_set_id=f"pcs_{'b' * 24}",
    )

    assert asyncio.run(main._db_persist_recommendation_snapshots(uid, [ready]))
    # Simulate another warm function instance whose process cache still holds
    # the pre-generation state while durable storage already contains ready.
    main._recommendation_snapshots[(uid, snapshot["recommendation_id"])] = preparing

    restored = asyncio.run(
        main._db_get_recommendation_snapshot(uid, snapshot["recommendation_id"])
    )

    assert prepared_resource_pair(restored) == pair
    assert restored["prepared_content_set_id"] == f"pcs_{'b' * 24}"


def test_feed_exposes_recommendation_ids_per_card_only(monkeypatch):
    supabase = _SettingsSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    monkeypatch.setattr(main, "content_research_oai", None)
    context = {
        "state": "ready",
        "session_id": "main-session",
        "context_created_at": "2026-08-01T10:00:00+00:00",
        "preferred_locale": "zh-CN",
        "external_research_allowed": False,
        "messages": [
            {
                "id": "message-1",
                "session_id": "main-session",
                "role": "user",
                "text": "宝宝晚上总是夜醒，我也想练习轮流发声和语言理解。",
                "created_at": "2026-08-01T10:00:00+00:00",
                "context_scope": "current_session",
            }
        ],
    }

    async def load_context(*_args, **_kwargs):
        return context

    monkeypatch.setattr(main, "_load_recent_main_chat", load_context)
    payload = asyncio.run(main.get_personalized_feed(count=4, uid="parent-1"))
    matched = [
        item for item in payload["items"] if item.get("is_conversation_match")
    ]

    assert "recommendation_id" not in payload
    assert len(matched) >= 2
    recommendation_ids = [item.get("recommendation_id") for item in matched]
    assert all(recommendation_ids)
    assert len(recommendation_ids) == len(set(recommendation_ids))
    for item in matched:
        snapshot = asyncio.run(
            main._db_get_recommendation_snapshot(
                "parent-1", item["recommendation_id"]
            )
        )
        assert snapshot["card_id"] == item["id"]


def test_recommendation_id_cannot_be_reused_for_another_card(monkeypatch):
    snapshot = build_snapshot(
        "parent-1",
        {"id": "learn_language_milestones"},
        {"session_id": "session-1", "context_created_at": "2026-08-01T10:00:00+00:00"},
    )

    async def stored_snapshot(_uid, _recommendation_id):
        return snapshot

    monkeypatch.setattr(main, "_db_get_recommendation_snapshot", stored_snapshot)
    with pytest.raises(Exception) as error:
        asyncio.run(
            main.get_card_detail(
                "learn_sleep_routine",
                recommendation_id=snapshot["recommendation_id"],
                uid="parent-1",
            )
        )
    assert getattr(error.value, "status_code", None) == 404


def test_explicit_missing_recommendation_id_fails_closed(monkeypatch):
    async def missing_snapshot(_uid, _recommendation_id):
        return None

    monkeypatch.setattr(main, "_db_get_recommendation_snapshot", missing_snapshot)
    with pytest.raises(Exception) as error:
        asyncio.run(
            main.get_card_detail(
                "learn_language_milestones",
                recommendation_id="rec_0123456789abcdef01234567",
                uid="parent-1",
            )
        )
    assert getattr(error.value, "status_code", None) == 404


def test_recommendation_id_is_user_bound_in_persistent_lookup(monkeypatch):
    supabase = _SettingsSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    card = {
        "id": "learn_language_milestones",
        "is_conversation_match": True,
        "personalization_reason": "语言互动",
    }
    context = {
        "session_id": "session-1",
        "context_created_at": "2026-08-01T10:00:00+00:00",
    }
    asyncio.run(main._attach_recommendation_snapshots("parent-1", [card], context))
    rec_id = card["recommendation_id"]
    monkeypatch.setattr(main, "_recommendation_snapshots", {})

    assert asyncio.run(
        main._db_get_recommendation_snapshot("parent-2", rec_id)
    ) is None


def test_snapshot_privacy_delete_removes_cache_and_persistent_rows(monkeypatch):
    supabase = _SettingsSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    card = {"id": "learn_sleep_routine", "is_conversation_match": True}
    context = {
        "session_id": "session-1",
        "context_created_at": "2026-08-01T10:00:00+00:00",
    }
    asyncio.run(main._attach_recommendation_snapshots("parent-1", [card], context))
    rec_id = card["recommendation_id"]

    asyncio.run(main._db_delete_recommendation_snapshots("parent-1"))

    assert not supabase.store
    assert asyncio.run(
        main._db_get_recommendation_snapshot("parent-1", rec_id)
    ) is None
    with pytest.raises(Exception) as error:
        asyncio.run(
            main.get_card_detail(
                "learn_sleep_routine",
                recommendation_id=rec_id,
                uid="parent-1",
            )
        )
    assert getattr(error.value, "status_code", None) == 404


def test_snapshot_privacy_delete_failure_is_fail_closed(monkeypatch):
    supabase = _SettingsSupabase(fail_delete=True)
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    snapshot = build_snapshot(
        "parent-1",
        {"id": "learn_sleep_routine"},
        {"session_id": "session-1", "context_created_at": "2026-08-01T10:00:00+00:00"},
    )
    supabase.store[
        snapshot_storage_key("parent-1", snapshot["recommendation_id"])
    ] = serialize_snapshot(snapshot, secret=TEST_SNAPSHOT_SECRET)

    with pytest.raises(Exception) as error:
        asyncio.run(main._db_delete_recommendation_snapshots("parent-1"))

    assert getattr(error.value, "status_code", None) == 503
    assert supabase.store


def test_snapshot_delete_without_database_returns_503(monkeypatch):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)

    with pytest.raises(Exception) as error:
        asyncio.run(main._db_delete_recommendation_snapshots("parent-1"))

    assert getattr(error.value, "status_code", None) == 503


def test_authenticated_privacy_update_without_database_returns_503(monkeypatch):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)
    monkeypatch.setattr(
        main,
        "_privacy",
        {"parent-1": main._normalized_privacy_settings({})},
    )
    previous = dict(main._privacy["parent-1"])

    with pytest.raises(Exception) as error:
        asyncio.run(
            main._db_set_privacy(
                "parent-1",
                {"allow_history_training": False},
            )
        )

    assert getattr(error.value, "status_code", None) == 503
    assert main._privacy["parent-1"] == previous


def test_wipe_keeps_history_opt_out_when_snapshot_delete_fails(monkeypatch):
    supabase = _SettingsSupabase(fail_delete=True)
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_privacy", {})
    monkeypatch.setattr(main, "_recommendation_snapshots", {})

    with pytest.raises(Exception) as error:
        asyncio.run(main.wipe_all(uid="parent-1"))

    assert getattr(error.value, "status_code", None) == 503
    privacy_value = supabase.store[main._privacy_storage_key("parent-1")]
    assert json.loads(privacy_value)["allow_history_training"] is False
    assert main._privacy["parent-1"]["allow_history_training"] is False


def test_snapshot_cannot_restore_context_when_history_privacy_is_off(monkeypatch):
    snapshot = build_snapshot(
        "parent-1",
        {
            "id": "learn_sleep_routine",
            "recommendation_focus": "宝宝反复夜醒",
        },
        {"session_id": "session-1", "context_created_at": "2026-08-01T10:00:00+00:00"},
    )

    async def stored_snapshot(_uid, _recommendation_id):
        return snapshot

    async def privacy_off_context(*_args, **_kwargs):
        return {
            "state": "privacy_off",
            "session_id": None,
            "messages": [],
            "preferred_locale": "zh-CN",
            "external_research_allowed": False,
        }

    monkeypatch.setattr(main, "_db_get_recommendation_snapshot", stored_snapshot)
    monkeypatch.setattr(main, "_load_recent_main_chat", privacy_off_context)

    with pytest.raises(Exception) as error:
        asyncio.run(
            main.get_card_detail(
                "learn_sleep_routine",
                recommendation_id=snapshot["recommendation_id"],
                uid="parent-1",
            )
        )

    assert getattr(error.value, "status_code", None) == 404


def test_snapshot_cannot_bind_to_a_different_resolved_session(monkeypatch):
    snapshot = build_snapshot(
        "parent-1",
        {"id": "learn_sleep_routine", "recommendation_focus": "宝宝反复夜醒"},
        {"session_id": "deleted-session", "context_created_at": "2026-08-01T10:00:00+00:00"},
    )

    async def stored_snapshot(_uid, _recommendation_id):
        return snapshot

    async def wrong_session_context(*_args, **_kwargs):
        return {
            "state": "ready",
            "session_id": "different-session",
            "context_created_at": "2026-08-01T09:00:00+00:00",
            "preferred_locale": "zh-CN",
            "external_research_allowed": False,
            "messages": [
                {
                    "role": "user",
                    "text": "这是另一段对话。",
                    "context_scope": "current_session",
                }
            ],
        }

    monkeypatch.setattr(main, "_db_get_recommendation_snapshot", stored_snapshot)
    monkeypatch.setattr(main, "_load_recent_main_chat", wrong_session_context)

    with pytest.raises(Exception) as error:
        asyncio.run(
            main.get_card_detail(
                "learn_sleep_routine",
                recommendation_id=snapshot["recommendation_id"],
                uid="parent-1",
            )
        )

    assert getattr(error.value, "status_code", None) == 404


def test_disabling_history_invalidates_old_recommendation_link(monkeypatch):
    supabase = _SettingsSupabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: supabase)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    card = {"id": "learn_sleep_routine", "is_conversation_match": True}
    context = {
        "session_id": "session-1",
        "context_created_at": "2026-08-01T10:00:00+00:00",
    }
    asyncio.run(main._attach_recommendation_snapshots("parent-1", [card], context))
    rec_id = card["recommendation_id"]

    async def save_privacy(_uid, values):
        return values

    monkeypatch.setattr(main, "_db_set_privacy", save_privacy)
    asyncio.run(
        main.update_privacy(
            main.PrivacySettings(allow_history_training=False),
            uid="parent-1",
        )
    )

    assert asyncio.run(
        main._db_get_recommendation_snapshot("parent-1", rec_id)
    ) is None


def test_unpersisted_feed_card_uses_legacy_context_only(monkeypatch):
    monkeypatch.setattr(main, "_get_supabase", lambda: None)
    monkeypatch.setattr(main, "_recommendation_snapshots", {})
    card = {
        "id": "learn_language_milestones",
        "is_conversation_match": True,
        "personalization_reason": "语言互动",
    }
    context = {
        "session_id": "session-1",
        "context_created_at": "2026-08-01T10:00:00+00:00",
    }

    asyncio.run(main._attach_recommendation_snapshots("parent-1", [card], context))

    assert "recommendation_id" not in card
    assert card["recommendation_context_status"] == "legacy_fallback"


def test_dynamic_cross_session_card_restores_from_snapshot_focus(monkeypatch):
    dynamic_id = "learn_conversation_0123456789abcdef0123"
    snapshot = build_snapshot(
        "parent-1",
        {
            "id": dynamic_id,
            "personalization_reason": "结合近期对话继续研究蒙特梭利幼儿园选择",
            "recommendation_focus": "蒙特梭利幼儿园选择",
            "recommendation_intent": "action_plan",
            "recommendation_score": 12,
        },
        {
            "session_id": "current-main",
            "context_created_at": "2026-08-01T10:00:00+00:00",
        },
    )

    async def stored_snapshot(_uid, _recommendation_id):
        return snapshot

    async def generic_current_context(*_args, **_kwargs):
        return {
            "state": "ready",
            "session_id": "current-main",
            "context_created_at": "2026-08-01T10:00:00+00:00",
            "preferred_locale": "zh-CN",
            "external_research_allowed": False,
            "messages": [
                {
                    "role": "user",
                    "text": "给我一些任务吧。",
                    "context_scope": "current_session",
                }
            ],
        }

    monkeypatch.setattr(main, "_db_get_recommendation_snapshot", stored_snapshot)
    monkeypatch.setattr(main, "_load_recent_main_chat", generic_current_context)
    monkeypatch.setattr(main, "content_research_oai", None)

    detail = asyncio.run(
        main.get_card_detail(
            dynamic_id,
            recommendation_id=snapshot["recommendation_id"],
            uid="parent-1",
        )
    )

    assert detail["id"] == dynamic_id
    assert detail["is_dynamic_research_card"] is True
    assert detail["is_conversation_match"] is True
    assert detail["recommendation_focus"] == "蒙特梭利幼儿园选择"
    assert detail["recommendation_context_status"] == "snapshot"
