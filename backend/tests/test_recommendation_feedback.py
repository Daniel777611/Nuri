import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from backend import stores  # noqa: E402
from backend.feed import signals as feed_signals  # noqa: E402
from backend.nuri_core import outcome_store as core_outcome_store  # noqa: E402
from backend import memstore, runtime  # noqa: E402
from backend.nuri_core import outcome_store  # noqa: E402
from backend import main
from backend.recommendation_feedback import (
    canonical_resource_url,
    card_behavior_signal,
    category_preference_mix,
    normalize_event,
    prune_events,
    recent_resource_urls,
    resource_url_hash,
    weighted_category_for_window,
)


NOW = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)


def _event(
    event: str,
    card_id: str,
    *,
    days_ago: int = 0,
    trusted_resource_url: bool = False,
    **extra,
):
    occurred_at = (NOW - timedelta(days=days_ago)).isoformat()
    value = normalize_event(
        {
            "event_id": f"evt-{event}-{days_ago}-{len(extra)}",
            "event": event,
            "card_id": card_id,
            **extra,
        },
        occurred_at=occurred_at,
        trusted_resource_url=trusted_resource_url,
    )
    assert value is not None
    return value


def test_canonical_resource_url_removes_all_page_query_and_fragment():
    assert canonical_resource_url(
        "https://Example.org/guide/?utm_source=nuri&b=2&a=1#section"
    ) == "https://example.org/guide"
    assert canonical_resource_url("http://example.org/guide") == ""


def test_canonical_resource_url_keeps_only_valid_youtube_video_id():
    assert canonical_resource_url(
        "https://youtu.be/dQw4w9WgXcQ?si=private-token&t=10"
    ) == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert canonical_resource_url(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=private-list"
    ) == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert canonical_resource_url("https://youtube.com/watch?v=too-short") == ""


def test_canonical_resource_url_rejects_malformed_or_non_public_authorities():
    assert canonical_resource_url("https://example.org:not-a-port/guide") == ""
    assert canonical_resource_url("https://user:secret@example.org/guide") == ""
    assert canonical_resource_url("https://127.0.0.1/guide") == ""
    assert canonical_resource_url("https://service.internal/guide") == ""


def test_untrusted_event_persists_only_canonical_url_hash():
    value = _event(
        "external_resource_click",
        "learn_sleep_routine",
        resource_url="https://example.org/guide?token=private#account",
    )
    assert "resource_url" not in value
    assert value["resource_url_hash"] == resource_url_hash("https://example.org/guide")


def test_only_trusted_server_delivery_can_persist_canonical_url():
    delivered = _event(
        "resource_delivered",
        "learn_sleep_routine",
        trusted_resource_url=True,
        resource_url="https://example.org/guide?token=private#account",
    )
    assert delivered["resource_url"] == "https://example.org/guide"
    assert delivered["resource_url_hash"] == resource_url_hash(delivered["resource_url"])

    forged = _event(
        "resource_delivered",
        "learn_sleep_routine",
        resource_url="https://example.org/guide?token=private",
    )
    assert "resource_url" not in forged
    assert forged["resource_url_hash"] == delivered["resource_url_hash"]


def test_recent_resource_urls_are_unique_newest_first():
    events = [
        _event(
            "resource_delivered",
            "learn_sleep_routine",
            days_ago=2,
            trusted_resource_url=True,
            resource_url="https://example.org/a?utm_source=old",
        ),
        _event(
            "resource_delivered",
            "learn_sleep_routine",
            days_ago=1,
            trusted_resource_url=True,
            resource_url="https://example.org/b",
        ),
        _event(
            "resource_delivered",
            "learn_sleep_routine",
            trusted_resource_url=True,
            resource_url="https://example.org/a",
        ),
        _event(
            "resource_delivered",
            "learn_sleep_routine",
            days_ago=40,
            trusted_resource_url=True,
            resource_url="https://example.org/expired",
        ),
    ]
    assert recent_resource_urls(events, now=NOW) == [
        "https://example.org/a",
        "https://example.org/b",
    ]


def test_behavior_signal_rewards_actions_and_penalizes_repetition():
    card_id = "learn_parent_child_connection"
    signal = card_behavior_signal(
        card_id,
        [
            _event("feed_impression", card_id),
            _event("feed_impression", card_id),
            _event("feed_impression", card_id),
            _event("external_resource_click", card_id),
            _event("detail_dwell", card_id, duration_ms=60_000),
        ],
        now=NOW,
    )
    assert signal["affinity"] == 6
    assert signal["freshness_penalty"] == -6
    assert signal["score"] == 0


def test_explicit_negative_is_cleared_by_later_helpful_feedback():
    card_id = "learn_child_emotions"
    negative = card_behavior_signal(
        card_id,
        [_event("not_relevant", card_id)],
        now=NOW,
    )
    assert negative["explicit_negative"] is True
    assert negative["score"] <= -24

    recovered = card_behavior_signal(
        card_id,
        [
            _event("not_relevant", card_id, days_ago=2),
            _event("helpful", card_id),
        ],
        now=NOW,
    )
    assert recovered["explicit_negative"] is False
    assert recovered["score"] > 0


def test_content_quality_feedback_refreshes_resources_without_rejecting_topic():
    card_id = "learn_child_emotions"
    signal = card_behavior_signal(
        card_id,
        [
            _event("not_relevant", card_id, reason="wrong_language"),
            _event("not_relevant", card_id, reason="repetitive"),
        ],
        now=NOW,
    )
    assert signal["explicit_negative"] is False
    assert signal["score"] == 0
    assert signal["content_refresh_reasons"] == ["repetitive", "wrong_language"]


def test_not_now_is_short_lived_instead_of_permanently_rejecting_topic():
    card_id = "learn_child_emotions"
    recent = card_behavior_signal(
        card_id,
        [_event("not_relevant", card_id, reason="not_now")],
        now=NOW,
    )
    older = card_behavior_signal(
        card_id,
        [_event("not_relevant", card_id, days_ago=4, reason="not_now")],
        now=NOW,
    )
    assert recent["temporary_penalty"] == -6
    assert recent["explicit_negative"] is False
    assert older["temporary_penalty"] == 0


def test_unfavorite_does_not_clear_an_explicit_topic_rejection():
    card_id = "learn_child_emotions"
    signal = card_behavior_signal(
        card_id,
        [
            _event("not_relevant", card_id, days_ago=2, reason="topic_mismatch"),
            _event("favorite", card_id, value=0),
        ],
        now=NOW,
    )
    assert signal["explicit_negative"] is True
    assert signal["score"] <= -24


def test_prune_events_deduplicates_client_event_ids_and_expires_old_rows():
    recent = _event("card_open", "learn_child_language")
    duplicate = dict(recent)
    old = _event("card_open", "learn_child_language", days_ago=121)
    assert prune_events([recent, duplicate, old], now=NOW) == [recent]


def test_behavior_feedback_cannot_create_conversation_relevance():
    messages = [{"role": "user", "text": "孩子晚上一直醒，怎么安排睡前流程？"}]
    cards, used = feed_signals.rank_learning_content(
        messages,
        count=4,
        behavior_events=[
            _event("helpful", "learn_child_food"),
            _event("favorite", "learn_child_food", value=1),
        ],
    )
    assert used is True
    assert cards[0]["id"] == "learn_sleep_routine"
    assert cards[0]["is_conversation_match"] is True


def test_questionnaire_seeds_explainable_category_mix_with_authority_floor():
    research_mix = category_preference_mix("research", "expert", [], now=NOW)
    parent_mix = category_preference_mix("experience", "parents", [], now=NOW)

    assert sum(research_mix.values()) == 100
    assert sum(parent_mix.values()) == 100
    assert research_mix["authority"] == max(research_mix.values())
    assert parent_mix["case"] == max(parent_mix.values())
    assert research_mix["authority"] >= 25
    assert parent_mix["authority"] >= 25
    assert min(parent_mix.values()) >= 12


def test_recent_category_clicks_adjust_mix_without_using_legacy_or_expired_events():
    baseline = category_preference_mix("analysis", "all", [], now=NOW)
    recent_featured = [
        _event(
            "external_resource_click",
            "learn_sleep_routine",
            content_category="featured",
            days_ago=index,
        )
        for index in range(3)
    ]
    legacy_without_category = _event(
        "helpful",
        "learn_sleep_routine",
        days_ago=0,
    )
    expired_case = _event(
        "external_resource_click",
        "learn_sleep_routine",
        content_category="case",
        days_ago=31,
    )
    adjusted = category_preference_mix(
        "analysis",
        "all",
        [*recent_featured, legacy_without_category, expired_case],
        now=NOW,
    )

    assert adjusted["featured"] > baseline["featured"]
    assert adjusted["case"] <= baseline["case"]
    assert adjusted["authority"] >= 25
    assert sum(adjusted.values()) == 100


def test_weighted_first_exposure_is_stable_within_window():
    mix = {"authority": 50, "featured": 30, "case": 20}
    first = weighted_category_for_window("parent-one", mix, now=NOW)
    second = weighted_category_for_window(
        "parent-one",
        mix,
        now=NOW + timedelta(hours=5),
    )

    assert first == second
    assert first in mix


def test_not_relevant_suppresses_exact_static_card():
    messages = [{"role": "user", "text": "孩子晚上一直醒，怎么安排睡前流程？"}]
    cards, _ = feed_signals.rank_learning_content(
        messages,
        count=4,
        session_id="main-session",
        context_created_at="2026-08-01T12:00:00+00:00",
        behavior_events=[_event("not_relevant", "learn_sleep_routine")],
    )
    assert cards[0]["id"] != "learn_sleep_routine"
    assert not any(card.get("is_dynamic_research_card") for card in cards)


def test_authenticated_event_endpoint_persists_only_bounded_metadata(monkeypatch):
    memstore.recommendation_events.clear()
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)
    async def enabled_privacy(*_args, **_kwargs):
        return {"allow_history_training": True}

    monkeypatch.setattr(stores, "get_privacy", enabled_privacy)

    result = asyncio.run(
        main.track_recommendation_event(
            main.RecommendationEventIn(
                client_event_id="client-event-123",
                event="external_resource_click",
                card_id="learn_sleep_routine",
                recommendation_id="rec-123",
                resource_id="resource-123",
                resource_url="https://example.org/guide?utm_source=nuri",
                resource_kind="article",
                content_category="authority",
                locale="zh-CN",
                position=1,
            ),
            uid="parent-feedback-test",
        )
    )

    assert result["accepted"] is True
    assert result["persisted"] is False
    stored = memstore.recommendation_events["parent-feedback-test"]
    assert stored == [
        {
            "event_id": "client-event-123",
            "event": "external_resource_click",
            "card_id": "learn_sleep_routine",
            "occurred_at": stored[0]["occurred_at"],
            "recommendation_id": "rec-123",
            "resource_id": "resource-123",
            "resource_kind": "article",
            "content_category": "authority",
            "locale": "zh-CN",
            "resource_url_hash": resource_url_hash("https://example.org/guide"),
            "position": 1,
        }
    ]


def test_not_relevant_endpoint_requires_a_specific_reason(monkeypatch):
    memstore.recommendation_events.clear()
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)

    async def enabled_privacy(*_args, **_kwargs):
        return {"allow_history_training": True}

    monkeypatch.setattr(stores, "get_privacy", enabled_privacy)

    with pytest.raises(main.HTTPException) as missing_reason:
        asyncio.run(
            main.track_recommendation_event(
                main.RecommendationEventIn(
                    client_event_id="client-event-missing-reason",
                    event="not_relevant",
                    card_id="learn_sleep_routine",
                ),
                uid="parent-feedback-test",
            )
        )
    assert missing_reason.value.status_code == 422

    accepted = asyncio.run(
        main.track_recommendation_event(
            main.RecommendationEventIn(
                client_event_id="client-event-with-reason",
                event="not_relevant",
                card_id="learn_sleep_routine",
                reason="wrong_language",
            ),
            uid="parent-feedback-test",
        )
    )
    assert accepted["accepted"] is True


class _MissingRecommendationEventsTable(RuntimeError):
    code = "PGRST205"


class _RecommendationStoreResult:
    def __init__(self, data=None):
        self.data = data


class _RecommendationStoreTable:
    def __init__(self, db, name):
        self.db = db
        self.name = name
        self.action = "select"
        self.rows = None
        self.equals = {}
        self.in_values = {}
        self.less_thans = {}
        self.prefix = None
        self.order_field = None
        self.order_desc = False
        self.row_limit = None
        self.row_range = None
        self.on_conflict = None
        self.ignore_duplicates = False

    def select(self, *_args, **_kwargs):
        self.action = "select"
        return self

    def upsert(self, rows, *, on_conflict=None, ignore_duplicates=False, **_kwargs):
        self.action = "upsert"
        self.rows = rows if isinstance(rows, list) else [rows]
        self.on_conflict = on_conflict
        self.ignore_duplicates = ignore_duplicates
        return self

    def delete(self):
        self.action = "delete"
        return self

    def eq(self, field, value):
        self.equals[field] = value
        return self

    def in_(self, field, values):
        self.in_values[field] = set(values)
        return self

    def lt(self, field, value):
        self.less_thans[field] = value
        return self

    def like(self, field, value):
        assert field == "key" and value.endswith("%")
        self.prefix = value[:-1]
        return self

    def order(self, field, *, desc=False, **_kwargs):
        self.order_field = field
        self.order_desc = desc
        return self

    def limit(self, value):
        self.row_limit = value
        return self

    def range(self, start, end):
        self.row_range = (start, end)
        return self

    def _matches(self, row):
        return (
            all(row.get(field) == value for field, value in self.equals.items())
            and all(
                row.get(field) in values
                for field, values in self.in_values.items()
            )
            and all(
                row.get(field) is not None and row.get(field) < value
                for field, value in self.less_thans.items()
            )
            and (self.prefix is None or row.get("key", "").startswith(self.prefix))
        )

    def _slice(self, rows):
        if self.row_range is not None:
            start, end = self.row_range
            rows = rows[start : end + 1]
        if self.row_limit is not None:
            rows = rows[: self.row_limit]
        return rows

    def execute(self):
        if self.name == "recommendation_events":
            if not self.db.row_table_available:
                raise _MissingRecommendationEventsTable(
                    "Could not find recommendation_events in the schema cache"
                )
            return self._execute_event_rows()
        assert self.name == "app_settings"
        return self._execute_settings()

    def _execute_event_rows(self):
        if self.action == "upsert":
            assert self.on_conflict == "user_id,event_id"
            assert self.ignore_duplicates is True
            for row in self.rows:
                key = (row["user_id"], row["event_id"])
                if key not in self.db.event_rows:
                    self.db.event_rows[key] = dict(row)
            return _RecommendationStoreResult(self.rows)
        if self.action == "delete":
            deleted = [
                key
                for key, row in self.db.event_rows.items()
                if self._matches(row)
            ]
            for key in deleted:
                self.db.event_rows.pop(key, None)
            return _RecommendationStoreResult([])

        rows = [
            row for row in self.db.event_rows.values() if self._matches(row)
        ]
        if self.order_field:
            rows.sort(
                key=lambda row: row.get(self.order_field) or "",
                reverse=self.order_desc,
            )
        rows = self._slice(rows)
        return _RecommendationStoreResult([dict(row) for row in rows])

    def _execute_settings(self):
        if self.action == "upsert":
            assert self.on_conflict == "key"
            for row in self.rows:
                if not self.ignore_duplicates or row["key"] not in self.db.settings:
                    self.db.settings[row["key"]] = dict(row)
            return _RecommendationStoreResult(self.rows)
        if self.action == "delete":
            keys = [
                key
                for key, row in self.db.settings.items()
                if self._matches(row)
            ]
            for key in keys:
                self.db.settings.pop(key, None)
            return _RecommendationStoreResult([])

        rows = [row for row in self.db.settings.values() if self._matches(row)]
        if self.order_field:
            rows.sort(
                key=lambda row: row.get(self.order_field) or "",
                reverse=self.order_desc,
            )
        rows = self._slice(rows)
        return _RecommendationStoreResult([dict(row) for row in rows])


class _RecommendationStoreSupabase:
    def __init__(self, *, row_table_available=True):
        self.row_table_available = row_table_available
        self.event_rows = {}
        self.settings = {}
        self.table_calls = {}

    def table(self, name):
        self.table_calls[name] = self.table_calls.get(name, 0) + 1
        return _RecommendationStoreTable(self, name)


def _storage_event(event_id, event="card_open", *, occurred_at=None):
    occurred_at = occurred_at or datetime.now(timezone.utc).isoformat()
    value = normalize_event(
        {
            "event_id": event_id,
            "event": event,
            "card_id": "learn_sleep_routine",
            "locale": "zh-CN",
        },
        occurred_at=occurred_at,
    )
    assert value is not None
    return value


def test_recommendation_event_table_appends_deduplicates_and_deletes(monkeypatch):
    supabase = _RecommendationStoreSupabase()
    monkeypatch.setattr(runtime, "get_supabase", lambda: supabase)
    monkeypatch.setattr(memstore, "recommendation_events", {})
    monkeypatch.setattr(memstore, "recommendation_event_locks", {})
    monkeypatch.setattr(outcome_store, "_table_available", None)
    uid = "parent-row-events"
    first = _storage_event("row-event-0001")
    second = _storage_event("row-event-0002", event="helpful")

    _, persisted = asyncio.run(
        core_outcome_store.append_events(uid, [first, second, first])
    )

    assert persisted is True
    assert set(supabase.event_rows) == {
        (uid, "row-event-0001"),
        (uid, "row-event-0002"),
    }

    # A cold instance rehydrates from independent rows, not a mutable JSON list.
    monkeypatch.setattr(memstore, "recommendation_events", {})
    loaded = asyncio.run(core_outcome_store.get_events(uid))
    assert {event["event_id"] for event in loaded} == {
        "row-event-0001",
        "row-event-0002",
    }

    asyncio.run(core_outcome_store.delete_events(uid))
    assert supabase.event_rows == {}


def test_missing_event_table_uses_atomic_per_event_setting_rows(monkeypatch):
    supabase = _RecommendationStoreSupabase(row_table_available=False)
    monkeypatch.setattr(runtime, "get_supabase", lambda: supabase)
    monkeypatch.setattr(memstore, "recommendation_events", {})
    monkeypatch.setattr(memstore, "recommendation_event_locks", {})
    monkeypatch.setattr(outcome_store, "_table_available", None)
    uid = "parent-settings-events"
    first = _storage_event("setting-event-0001")
    second = _storage_event("setting-event-0002", event="helpful")
    legacy = _storage_event("legacy-event-0001", event="detail_view")
    legacy_key = main.event_storage_key(uid)
    legacy_value = json.dumps([legacy])
    supabase.settings[legacy_key] = {
        "key": legacy_key,
        "value": legacy_value,
        "updated_at": legacy["occurred_at"],
    }

    asyncio.run(core_outcome_store.append_events(uid, [first]))
    # Simulate another Vercel instance with no process-local event cache.
    monkeypatch.setattr(memstore, "recommendation_events", {})
    asyncio.run(core_outcome_store.append_events(uid, [second, first]))

    # The first missing-table response is cached for this warm instance; all
    # later reads and writes go straight to atomic per-event setting rows.
    assert supabase.table_calls.get("recommendation_events") == 1

    prefix = outcome_store.event_setting_prefix(uid)
    per_event_keys = {
        key for key in supabase.settings if key.startswith(prefix)
    }
    assert len(per_event_keys) == 2
    # The old whole-list key is read for rollout compatibility, never rewritten.
    assert supabase.settings[legacy_key]["value"] == legacy_value

    monkeypatch.setattr(memstore, "recommendation_events", {})
    loaded = asyncio.run(core_outcome_store.get_events(uid))
    assert {event["event_id"] for event in loaded} == {
        "setting-event-0001",
        "setting-event-0002",
        "legacy-event-0001",
    }

    asyncio.run(core_outcome_store.delete_events(uid))
    assert not any(key.startswith(prefix) for key in supabase.settings)
    assert legacy_key not in supabase.settings


def test_row_table_physically_removes_expired_and_overflow_events(monkeypatch):
    supabase = _RecommendationStoreSupabase()
    monkeypatch.setattr(runtime, "get_supabase", lambda: supabase)
    monkeypatch.setattr(memstore, "recommendation_events", {})
    monkeypatch.setattr(memstore, "recommendation_event_locks", {})
    monkeypatch.setattr(outcome_store, "_table_available", None)
    uid = "parent-row-retention"
    now = datetime.now(timezone.utc)

    existing = [
        _storage_event(
            f"retained-row-{index:04d}",
            occurred_at=(now - timedelta(minutes=300 - index)).isoformat(),
        )
        for index in range(241)
    ]
    expired = _storage_event(
        "expired-row-event",
        occurred_at=(now - timedelta(days=121)).isoformat(),
    )
    for event in [*existing, expired]:
        row = outcome_store.event_row(uid, event)
        supabase.event_rows[(uid, event["event_id"])] = row

    newest = _storage_event(
        "newest-row-event",
        occurred_at=(now + timedelta(seconds=1)).isoformat(),
    )
    _, persisted = asyncio.run(
        core_outcome_store.append_events(uid, [newest])
    )

    assert persisted is True
    stored_ids = {
        event_id
        for (user_id, event_id) in supabase.event_rows
        if user_id == uid
    }
    assert len(stored_ids) == 240
    assert "newest-row-event" in stored_ids
    assert "expired-row-event" not in stored_ids


def test_settings_v2_physically_removes_expired_and_overflow_events(monkeypatch):
    supabase = _RecommendationStoreSupabase(row_table_available=False)
    monkeypatch.setattr(runtime, "get_supabase", lambda: supabase)
    monkeypatch.setattr(memstore, "recommendation_events", {})
    monkeypatch.setattr(memstore, "recommendation_event_locks", {})
    monkeypatch.setattr(outcome_store, "_table_available", None)
    uid = "parent-settings-retention"
    now = datetime.now(timezone.utc)

    existing = [
        _storage_event(
            f"retained-setting-{index:04d}",
            occurred_at=(now - timedelta(minutes=300 - index)).isoformat(),
        )
        for index in range(241)
    ]
    expired = _storage_event(
        "expired-setting-event",
        occurred_at=(now - timedelta(days=121)).isoformat(),
    )
    for row in outcome_store.event_setting_rows(
        uid,
        [*existing, expired],
    ):
        supabase.settings[row["key"]] = row
    legacy_events = [
        _storage_event(
            f"legacy-retained-{index:04d}",
            occurred_at=(now - timedelta(minutes=300 - index)).isoformat(),
        )
        for index in range(241)
    ]
    legacy_expired = _storage_event(
        "legacy-expired-event",
        occurred_at=(now - timedelta(days=121)).isoformat(),
    )
    legacy_key = main.event_storage_key(uid)
    supabase.settings[legacy_key] = {
        "key": legacy_key,
        "value": json.dumps([*legacy_events, legacy_expired]),
        "updated_at": legacy_expired["occurred_at"],
    }

    newest = _storage_event(
        "newest-setting-event",
        occurred_at=(now + timedelta(seconds=1)).isoformat(),
    )
    _, persisted = asyncio.run(
        core_outcome_store.append_events(uid, [newest])
    )

    assert persisted is True
    prefix = outcome_store.event_setting_prefix(uid)
    stored_rows = [
        row
        for key, row in supabase.settings.items()
        if key.startswith(prefix)
    ]
    assert len(stored_rows) == 240
    stored_ids = {json.loads(row["value"])["event_id"] for row in stored_rows}
    assert "newest-setting-event" in stored_ids
    assert "expired-setting-event" not in stored_ids
    retained_legacy = json.loads(supabase.settings[legacy_key]["value"])
    assert len(retained_legacy) == 240
    assert not any(
        event["event_id"] == "legacy-expired-event"
        for event in retained_legacy
    )


def test_settings_cleanup_deletes_empty_legacy_v1_value(monkeypatch):
    supabase = _RecommendationStoreSupabase(row_table_available=False)
    monkeypatch.setattr(runtime, "get_supabase", lambda: supabase)
    monkeypatch.setattr(memstore, "recommendation_events", {})
    monkeypatch.setattr(memstore, "recommendation_event_locks", {})
    monkeypatch.setattr(outcome_store, "_table_available", None)
    uid = "parent-empty-legacy-retention"
    expired = _storage_event(
        "only-expired-legacy-event",
        occurred_at=(datetime.now(timezone.utc) - timedelta(days=121)).isoformat(),
    )
    legacy_key = main.event_storage_key(uid)
    supabase.settings[legacy_key] = {
        "key": legacy_key,
        "value": json.dumps([expired]),
        "updated_at": expired["occurred_at"],
    }

    _, persisted = asyncio.run(
        core_outcome_store.append_events(
            uid,
            [_storage_event("new-v2-event")],
        )
    )

    assert persisted is True
    assert legacy_key not in supabase.settings


def test_cleanup_failure_keeps_successfully_written_event(monkeypatch, capsys):
    supabase = _RecommendationStoreSupabase()
    monkeypatch.setattr(runtime, "get_supabase", lambda: supabase)
    monkeypatch.setattr(memstore, "recommendation_events", {})
    monkeypatch.setattr(memstore, "recommendation_event_locks", {})
    monkeypatch.setattr(outcome_store, "_table_available", None)

    async def fail_cleanup(_sb, _uid):
        raise RuntimeError("cleanup unavailable")

    monkeypatch.setattr(
        outcome_store,
        "cleanup_event_table",
        fail_cleanup,
    )
    uid = "parent-cleanup-failure"
    event = _storage_event("persisted-before-cleanup")

    _, persisted = asyncio.run(
        core_outcome_store.append_events(uid, [event])
    )

    assert persisted is True
    assert (uid, "persisted-before-cleanup") in supabase.event_rows
    assert "row retention cleanup failed: RuntimeError" in capsys.readouterr().out
