"""The caring notification: what it may say, and who it may reach.

Two kinds of rule are tested here, and only one of them is about correctness.

The first is the lock screen. §4.1 of the iOS handoff bans a child's name, a
birthday, a diagnosis and the parent's own words from an APNs payload, because
a notification renders on a locked phone in front of whoever is standing there.
That is a promise about privacy, so it is asserted rather than trusted to a
prompt.

The second is restraint. §12 caps proactive notifications, and a card attached
to a caring line has to be about the same subject or it reads as an ad wearing
sympathy. `MIN_CARD_SCORE` is what stops one incidental term hit from counting
as relevance, and the test for it is the test for the feature being worth
shipping at all.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from backend import main, push_apns, push_service
from backend.content_library import LEARNING_CONTENT_BY_ID
from backend.nuri_core import care_notifications as care


# ── Fakes ─────────────────────────────────────────────────────────────────────

class _Query:
    """Enough PostgREST for the two tables `gather_signals` reads."""

    def __init__(self, rows: list[dict]):
        self._rows = list(rows)

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def gte(self, col, val):
        self._rows = [r for r in self._rows if str(r.get(col, "")) >= str(val)]
        return self

    def order(self, col, desc=False, **_k):
        self._rows.sort(key=lambda r: str(r.get(col, "")), reverse=desc)
        return self

    def limit(self, n, **_k):
        self._rows = self._rows[:n]
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows, count=len(self._rows))


class _FakeSupabase:
    def __init__(self, **tables: list[dict]):
        self._tables = tables

    def table(self, name):
        return _Query(self._tables.get(name, []))


def _memory(key: str, value: str, category: str = "child_state", when: str = "2026-09-05"):
    return {"user_id": "u1", "category": category, "key": key, "value": value,
            "status": "active", "updated_at": f"{when}T00:00:00+00:00"}


def _turn(topic: str, when: str = "2026-09-05"):
    return {"user_id": "u1", "route_topic": topic, "created_at": f"{when}T00:00:00+00:00"}


NOW = datetime(2026, 9, 6, 12, 0, tzinfo=timezone.utc)


# ── Signals ───────────────────────────────────────────────────────────────────

def test_signals_come_from_distilled_records_not_transcripts():
    """Keys and router topics, never a parent's sentences.

    `value` is read for prompting but must not become matching vocabulary:
    it is the one field that holds what the parent actually wrote.
    """
    sb = _FakeSupabase(
        user_memories=[_memory("sleep_onset_duration", "晚上入睡大约需要40分钟。")],
        chat_turn_logs=[_turn("宝宝上午小睡变短")],
    )
    signals = care.gather_signals(sb, "u1", now=NOW)

    assert "sleep" in signals.terms
    assert "宝宝上午小睡变短" in signals.topics
    assert "晚上入睡大约需要40分钟。" in signals.private_notes
    assert not any("40分钟" in term for term in signals.terms)


def test_stale_history_is_not_treated_as_current():
    sb = _FakeSupabase(
        user_memories=[_memory("sleep_onset", "…", when="2026-01-01")],
        chat_turn_logs=[_turn("睡眠", when="2026-01-01")],
    )
    assert care.gather_signals(sb, "u1", now=NOW).is_empty()


def test_only_caring_categories_contribute():
    """`fact` is profile data — an age or a city makes a hollow greeting."""
    sb = _FakeSupabase(
        user_memories=[_memory("child_age_months", "9个月", category="fact")],
        chat_turn_logs=[],
    )
    assert care.gather_signals(sb, "u1", now=NOW).is_empty()


def test_router_topics_split_on_their_separator():
    sb = _FakeSupabase(user_memories=[], chat_turn_logs=[_turn("寒暄/继续追问")])
    topics = care.gather_signals(sb, "u1", now=NOW).topics
    assert "寒暄" in topics and "继续追问" in topics


# ── Card matching ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("topic, expected", [
    ("宝宝上午小睡变短", "learn_sleep_routine"),
    ("孩子挑食不吃蔬菜", "learn_picky_eating"),
    ("孩子情绪崩溃大哭", "learn_big_feelings"),
])
def test_card_matches_the_subject(topic, expected):
    signals = care.CareSignals(topics=[topic])
    card = care.match_card(signals)
    assert card is not None and card["id"] == expected


def test_an_unrelated_history_gets_no_card():
    """Better to send the caring line alone than to staple an ad to it."""
    assert care.match_card(care.CareSignals(topics=["报税截止日期"])) is None


def test_empty_history_gets_no_card():
    assert care.match_card(care.CareSignals()) is None


def test_a_single_incidental_hit_is_below_the_bar():
    """One term is coincidence; `MIN_CARD_SCORE` is what makes it not enough."""
    signals = care.CareSignals(terms=["食物"])
    assert care.score_card(LEARNING_CONTENT_BY_ID["learn_picky_eating"], signals) < care.MIN_CARD_SCORE
    assert care.match_card(signals) is None


def test_repetition_does_not_outweigh_variety():
    repeated = care.CareSignals(terms=["睡眠"] * 20)
    once = care.CareSignals(terms=["睡眠"])
    card = LEARNING_CONTENT_BY_ID["learn_sleep_routine"]
    assert care.score_card(card, repeated) == care.score_card(card, once)


# ── What may reach a lock screen ──────────────────────────────────────────────

def test_prompt_forbids_the_details_the_payload_may_not_carry():
    prompt = care.build_prompt(care.CareSignals(topics=["睡眠"]), None)
    for banned in ("名字", "生日", "诊断", "原话"):
        assert banned in prompt


def test_prompt_passes_notes_as_background_only():
    signals = care.CareSignals(topics=["睡眠"], private_notes=["孩子夜里醒三次"])
    assert "禁止复述" in care.build_prompt(signals, None)


def test_dates_and_long_numbers_are_stripped_even_if_the_model_emits_them():
    title, body = care.parse_completion("生日 2025-10-10 快到了\n电话 13800138000 记得存")
    assert "2025" not in title and "10-10" not in title
    assert "13800138000" not in body


def test_lengths_are_capped():
    long_line = "睡" * 200
    title, body = care.parse_completion(f"{long_line}\n{long_line}")
    assert len(title) <= care.TITLE_MAX_CHARS
    assert len(body) <= care.BODY_MAX_CHARS


@pytest.mark.parametrize("raw", [
    "标题：最近还好吗\n正文：记得也照顾自己",
    "「最近还好吗」\n「记得也照顾自己」",
    "  最近还好吗  \n\n  记得也照顾自己  ",
])
def test_completion_parsing_survives_the_ways_the_model_drifts(raw):
    title, body = care.parse_completion(raw)
    assert title == "最近还好吗"
    assert body == "记得也照顾自己"


def test_a_single_line_completion_still_yields_both_fields():
    title, body = care.parse_completion("最近辛苦了，记得也照顾一下自己")
    assert title and body


def test_empty_completion_falls_back_rather_than_sending_blank():
    assert care.parse_completion("") == ("", "")
    title, body = care.fallback_message(None)
    assert title and body


# ── Payload data ──────────────────────────────────────────────────────────────

def test_payload_data_carries_an_identifier_not_content():
    card = LEARNING_CONTENT_BY_ID["learn_sleep_routine"]
    message = care.CareMessage("t", "b", "full", card, ["睡眠"])
    data = message.payload_data()
    assert data == {"kind": "care", "card_id": "learn_sleep_routine"}
    assert card["title"] not in str(data)


def test_full_content_is_where_the_card_is_described():
    card = LEARNING_CONTENT_BY_ID["learn_sleep_routine"]
    full = care.compose_full_content("最近辛苦了", card)
    assert card["title"] in full and "最近辛苦了" in full


def test_route_is_an_internal_path():
    route = care.route_for("abc-123")
    assert route.startswith("/notifications/") and "://" not in route


def test_dedupe_key_is_stable_per_day_and_hides_the_account():
    a = care.dedupe_key("user-42", "2026-09-06", "learn_sleep_routine")
    b = care.dedupe_key("user-42", "2026-09-06", "learn_sleep_routine")
    assert a == b
    assert "user-42" not in a
    assert a != care.dedupe_key("user-42", "2026-09-07", "learn_sleep_routine")


# ── Quiet hours and preferences ───────────────────────────────────────────────

def _prefs(**over):
    base = {"enabled": True, "reminders_enabled": True, "chat_enabled": True,
            "care_enabled": True, "quiet_hours_start": "21:00",
            "quiet_hours_end": "08:00", "time_zone": "America/Chicago",
            "max_per_day": 4}
    return base | over


@pytest.mark.parametrize("utc_hour, quiet", [
    (3, True),    # 22:00 Chicago — inside the window, after the start
    (7, True),    # 02:00 Chicago — past midnight, still inside
    (12, True),   # 07:00 Chicago — the last quiet hour
    (13, False),  # 08:00 Chicago — the end is exclusive, so this is the
                  # first moment a notification may land, not the last quiet one
    (18, False),  # 13:00 Chicago — plainly outside
])
def test_quiet_hours_wrap_midnight_in_the_users_zone(utc_hour, quiet):
    moment = datetime(2026, 9, 6, utc_hour, 0, tzinfo=timezone.utc)
    assert push_service.in_quiet_hours(_prefs(), moment) is quiet


def test_an_unknown_timezone_does_not_crash_the_dispatcher():
    moment = datetime(2026, 9, 6, 3, 0, tzinfo=timezone.utc)
    assert push_service.in_quiet_hours(_prefs(time_zone="Mars/Olympus"), moment) in {True, False}


def test_quiet_hours_off_when_unset():
    moment = datetime(2026, 9, 6, 3, 0, tzinfo=timezone.utc)
    assert not push_service.in_quiet_hours(
        _prefs(quiet_hours_start=None, quiet_hours_end=None), moment)


def test_care_has_its_own_switch():
    assert push_service._type_enabled(_prefs(care_enabled=False), "follow_up") is False
    assert push_service._type_enabled(_prefs(care_enabled=False), "reminder") is True


def test_the_master_switch_still_lets_security_notices_through():
    off = _prefs(enabled=False)
    assert push_service._type_enabled(off, "follow_up") is False
    assert push_service._type_enabled(off, "system") is True


# ── APNs result classification ────────────────────────────────────────────────

class _Response:
    def __init__(self, status_code, reason=None):
        self.status_code = status_code
        self._reason = reason
        self.headers = {"apns-id": "11111111-1111-1111-1111-111111111111"}
        self.content = b"{}" if reason else b""

    def json(self):
        return {"reason": self._reason}


async def _send_with(monkeypatch, status_code, reason=None):
    monkeypatch.setattr(push_apns, "provider_token", lambda: _async("tok"))
    captured = _Response(status_code, reason)

    class _Client:
        async def post(self, *_a, **_k):
            return captured

    monkeypatch.setattr(push_apns, "_http", lambda: _Client())
    return await push_apns.send_alert(
        device_token="a" * 64, environment="production", title="t", body="b",
        notification_id="n", notification_type="follow_up", route="/notifications/n",
    )


async def _async(value):
    return value


@pytest.mark.anyio
@pytest.mark.parametrize("status_code, reason, deactivate, retryable", [
    (200, None, False, False),
    (410, "Unregistered", True, False),
    (400, "BadDeviceToken", True, False),
    (400, "DeviceTokenNotForTopic", True, False),
    (413, "PayloadTooLarge", False, False),
    (429, "TooManyRequests", False, True),
    (503, "ServiceUnavailable", False, True),
])
async def test_apns_results_are_classified_per_the_failure_table(
    monkeypatch, status_code, reason, deactivate, retryable,
):
    result = await _send_with(monkeypatch, status_code, reason)
    assert result.accepted is (status_code == 200)
    assert result.deactivate_token is deactivate
    assert result.retryable is retryable


@pytest.mark.anyio
async def test_a_403_drops_the_cached_provider_token(monkeypatch):
    push_apns._jwt_value, push_apns._jwt_created_at = "stale", 9e9
    await _send_with(monkeypatch, 403, "InvalidProviderToken")
    assert push_apns._jwt_value is None


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── HTTP surface ──────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    return TestClient(main.app)


def test_device_registration_requires_a_token(client):
    assert client.post("/api/mobile/push-devices", json={}).status_code == 401


def test_preferences_require_a_token(client):
    assert client.get("/api/notifications/preferences").status_code == 401


def test_internal_dispatch_rejects_a_wrong_secret(client, monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "right")
    response = client.get("/api/internal/push/dispatch",
                          headers={"Authorization": "Bearer wrong"})
    assert response.status_code == 401


def test_internal_dispatch_is_closed_when_no_secret_is_configured(client, monkeypatch):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    assert client.get("/api/internal/push/dispatch").status_code == 503


def test_a_malformed_apns_token_is_refused(client, monkeypatch):
    monkeypatch.setattr(main, "_get_supabase", lambda: _FakeSupabase())
    token = main._make_token("u1")
    response = client.post(
        "/api/mobile/push-devices",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "installation_id": "5c8044c6-85f1-45f4-b9ac-75a49a50d42f",
            "platform": "ios", "apns_token": "z" * 64,
            "apns_environment": "production",
            "bundle_id": push_apns.bundle_id(), "permission_status": "authorized",
        },
    )
    assert response.status_code == 422
