"""Offline registration and dispatch across the independent iOS app topics."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import main, push_apns, push_service
from backend.push_apns import APNsResult
from backend.tests.test_android_push import FCM_TOKEN, _register

PRODUCTION = "com.ordashtech.nuri.nativelab"
BETA = "com.ordashtech.nuri.beta"
EARLY_ACCESS = "com.ordashtech.nuri.earlyaccess"
LEGACY = "com.example.existing-primary"
NOW = datetime(2026, 11, 4, 12, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setenv("APNS_BUNDLE_ID", LEGACY)

    def forbidden(*_args, **_kwargs):
        pytest.fail("topic tests must not access a live database or APNs provider")

    monkeypatch.setattr(main, "_get_supabase", forbidden)
    monkeypatch.setattr(push_apns, "provider_token", forbidden)
    monkeypatch.setattr(push_apns, "_http", forbidden)


def test_only_configured_primary_and_the_three_registered_native_topics_are_allowed():
    for topic in [LEGACY, PRODUCTION, BETA, EARLY_ACCESS]:
        assert push_apns.is_allowed_topic(topic)
    for topic in [None, "", " ", False, 42, {}, [], "com.other.app",
                  BETA + ".debug", BETA.upper(), PRODUCTION + " ",
                  EARLY_ACCESS + ".debug", EARLY_ACCESS.upper(), EARLY_ACCESS + " ",
                  "com.ordashtech.nuri.preview"]:
        assert not push_apns.is_allowed_topic(topic)


@pytest.mark.parametrize("topic", [LEGACY, PRODUCTION, BETA, EARLY_ACCESS])
def test_registration_preserves_each_approved_topic_and_existing_token_rules(monkeypatch, topic):
    response, recorder = _register(
        TestClient(main.app), monkeypatch, platform="ios", apns_token="AB" * 32,
        apns_environment="production", bundle_id=topic,
    )
    assert response.status_code == 200
    stored = next(payload for table, operation, payload in recorder.writes
                  if table == "push_devices" and operation == "upsert")
    assert stored["bundle_id"] == topic
    assert stored["user_id"] == "u1"
    assert stored["apns_token"] == "ab" * 32
    assert "ab" * 32 not in response.text


@pytest.mark.parametrize("topic", ["com.other.app", BETA + ".debug", BETA + " ", "",
                                 EARLY_ACCESS + ".debug", EARLY_ACCESS.upper(), EARLY_ACCESS + " "])
def test_unapproved_registration_is_rejected_before_any_device_write(monkeypatch, topic):
    response, recorder = _register(
        TestClient(main.app), monkeypatch, platform="ios", apns_token="ab" * 32,
        bundle_id=topic,
    )
    assert response.status_code == 422
    assert recorder.writes == []


@pytest.fixture
def apns(monkeypatch):
    captured = SimpleNamespace(provider_calls=0, requests=[])

    async def provider_token():
        captured.provider_calls += 1
        return "mock-provider-token"

    class Client:
        async def post(self, url, **kwargs):
            captured.requests.append((url, kwargs))
            return SimpleNamespace(status_code=200, headers={"apns-id": "mock-apns-id"}, content=b"")

    monkeypatch.setattr(push_apns, "provider_token", provider_token)
    monkeypatch.setattr(push_apns, "_http", lambda: Client())
    return captured


async def send(**options):
    return await push_apns.send_alert(
        device_token="ab" * 32, environment=options.pop("environment", "production"),
        title="Mock title", body="Mock body", notification_id="mock-event",
        notification_type="follow_up", route="/notifications/mock-event", **options,
    )


@pytest.mark.anyio
@pytest.mark.parametrize("topic", [LEGACY, PRODUCTION, BETA, EARLY_ACCESS])
@pytest.mark.parametrize("environment", ["production", "sandbox"])
async def test_sender_uses_the_exact_approved_topic_in_each_apns_environment(apns, topic, environment):
    result = await send(topic=topic, environment=environment)
    assert result.accepted
    assert apns.provider_calls == 1
    url, request = apns.requests[0]
    expected_host = (push_apns.APNS_PRODUCTION_HOST if environment == "production"
                     else push_apns.APNS_SANDBOX_HOST)
    assert url == expected_host + "/3/device/" + "ab" * 32
    assert request["headers"]["apns-topic"] == topic
    assert request["headers"]["authorization"] == "bearer mock-provider-token"
    assert request["json"]["route"] == "/notifications/mock-event"


@pytest.mark.anyio
async def test_only_an_omitted_legacy_sender_argument_uses_the_existing_primary(apns):
    assert (await send()).accepted
    assert apns.requests[0][1]["headers"]["apns-topic"] == LEGACY


@pytest.mark.anyio
@pytest.mark.parametrize("topic", [None, "", " ", False, 42, {}, [], "com.other.app", BETA + ".debug",
                                 EARLY_ACCESS + ".debug", EARLY_ACCESS.upper(), EARLY_ACCESS + " "])
async def test_invalid_explicit_topic_never_signs_sends_retries_or_retires_a_device(topic):
    # The autouse fixture fails immediately if signing or networking is tried.
    result = await send(topic=topic)
    assert not result.accepted
    assert not result.retryable
    assert not result.deactivate_token
    assert result.http_status == 0  # No HTTP request was made.
    assert result.reason == "UnsupportedAPNSTopic"
    assert result.apns_id == ""


class DispatchDb:
    """Project selected columns so a missing bundle_id query cannot pass."""

    def __init__(self, devices):
        self.devices = deepcopy(devices)
        self.deliveries = []
        self.device_updates = []
        self.device_projections = []
        self.device_filters = []

    def rpc(self, *_args, **_kwargs):
        event = {"id": "mock-event", "user_id": "u1", "type": "follow_up",
                 "title": "Mock title", "body": "Mock body", "route": "/notifications/mock-event",
                 "data": {}, "attempt_count": 1}
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[event]))

    def table(self, table):
        db = self

        class Query:
            def __init__(self):
                self.columns = None
                self.filters = []
                self.operation = "select"
                self.payload = None

            def select(self, columns):
                self.columns = columns.split(",")
                if table == "push_devices":
                    db.device_projections.append(self.columns)
                return self

            def eq(self, key, value):
                self.filters.append((key, value))
                return self

            def update(self, payload):
                self.operation, self.payload = "update", payload
                return self

            def upsert(self, payload, **_kwargs):
                self.operation, self.payload = "upsert", payload
                return self

            def execute(self):
                if table == "push_devices" and self.operation == "select":
                    db.device_filters.extend(self.filters)
                    rows = [row for row in db.devices
                            if all(row.get(key) == value for key, value in self.filters)]
                    return SimpleNamespace(data=[{key: row[key] for key in self.columns if key in row}
                                                 for row in rows])
                if table == "push_devices" and self.operation == "update":
                    db.device_updates.append((self.filters, self.payload))
                if table == "notification_deliveries" and self.operation == "upsert":
                    db.deliveries.append(self.payload)
                return SimpleNamespace(data=[])

        return Query()


def device(name, platform, topic):
    return {"id": name, "user_id": "u1", "is_active": True, "platform": platform,
            "bundle_id": topic, "apns_token": FCM_TOKEN if platform == "android" else name.encode().hex() * 16,
            "apns_environment": "production", "permission_status": "authorized"}


@pytest.fixture
def dispatch(monkeypatch):
    outcome = SimpleNamespace(android=[], finished=[], requeued=[])

    async def android(**kwargs):
        outcome.android.append(kwargs)
        return APNsResult(True, "", 200, None, False, False, 0)

    async def finish(_sb, event_id, status, *_args):
        outcome.finished.append((event_id, status))

    async def requeue(_sb, event_id, *_args):
        outcome.requeued.append(event_id)

    monkeypatch.setattr(push_service, "_SENDERS", {
        "ios": SimpleNamespace(configured=lambda: True, send_alert=push_apns.send_alert),
        "android": SimpleNamespace(configured=lambda: True, send_alert=android),
    })
    monkeypatch.setattr(push_service, "_preferences", lambda *_args: {"time_zone": "UTC"})
    monkeypatch.setattr(push_service, "in_quiet_hours", lambda *_args: False)
    monkeypatch.setattr(push_service, "_sent_today", lambda *_args: 0)
    monkeypatch.setattr(push_service, "_finish", finish)
    monkeypatch.setattr(push_service, "_requeue", requeue)
    return outcome


@pytest.mark.anyio
async def test_one_account_reaches_all_approved_ios_topics_and_android_with_each_devices_own_topic(dispatch, apns):
    rows = [device("legacy", "ios", LEGACY), device("prod", "ios", PRODUCTION),
            device("beta", "ios", BETA), device("preview", "ios", EARLY_ACCESS),
            device("android", "android", "com.example.android")]
    db = DispatchDb(rows)
    result = await push_service.dispatch_due_notifications(db, now=NOW)
    assert [request[1]["headers"]["apns-topic"] for request in apns.requests] == [LEGACY, PRODUCTION, BETA, EARLY_ACCESS]
    assert len(dispatch.android) == 1 and dispatch.android[0]["device_token"] == FCM_TOKEN
    assert "topic" not in dispatch.android[0]
    assert "bundle_id" in db.device_projections[0]
    assert db.device_filters == [("user_id", "u1"), ("is_active", True)]
    assert {row["device_id"] for row in db.deliveries} == {"legacy", "prod", "beta", "preview", "android"}
    assert dispatch.finished == [("mock-event", "sent")]
    assert result["sent"] == 1 and result["deactivated"] == 0


@pytest.mark.anyio
@pytest.mark.parametrize("topic", [None, "", "com.other.app", EARLY_ACCESS + ".debug"])
async def test_dispatch_rejects_explicit_invalid_rows_without_apns_or_deactivation(dispatch, topic):
    rows = [device("invalid", "ios", topic)]
    db = DispatchDb(rows)
    result = await push_service.dispatch_due_notifications(db, now=NOW)
    assert db.device_updates == [] and db.devices == rows
    assert result["deactivated"] == 0 and result["failed"] == 1
    assert db.deliveries[0]["error_reason"] == "UnsupportedAPNSTopic"
    assert db.deliveries[0]["http_status"] == 0
    assert dispatch.requeued == []


@pytest.mark.anyio
async def test_missing_stored_topic_does_not_fall_back_or_block_other_valid_devices(dispatch, apns):
    missing = device("missing", "ios", PRODUCTION)
    del missing["bundle_id"]
    rows = [missing, device("prod", "ios", PRODUCTION), device("beta", "ios", BETA),
            device("preview", "ios", EARLY_ACCESS)]
    db = DispatchDb(rows)
    result = await push_service.dispatch_due_notifications(db, now=NOW)
    assert apns.provider_calls == 3
    assert [request[1]["headers"]["apns-topic"] for request in apns.requests] == [PRODUCTION, BETA, EARLY_ACCESS]
    assert db.device_updates == [] and db.devices == rows
    rejected = [row for row in db.deliveries if row["status"] == "rejected"]
    assert [(row["device_id"], row["error_reason"]) for row in rejected] == [("missing", "UnsupportedAPNSTopic")]
    assert result["partial"] == 1 and result["deactivated"] == 0
    assert dispatch.finished == [("mock-event", "partial")]
    assert dispatch.requeued == []
