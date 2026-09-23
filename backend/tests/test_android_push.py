"""Android push: FCM results, the registration route, and per-platform dispatch.

The dispatcher treats an Android phone and an iPhone alike once each has a row
in push_devices; what differs is only which sender it hands the device to. So
the tests pin the three seams where the platforms part ways: how FCM answers
are classified, what the route accepts for `platform: "android"`, and that a
deployment with only one platform's credentials still reaches that platform.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from backend import main, push_apns, push_fcm, push_service
from backend.push_apns import APNsResult

FCM_TOKEN = "dGVzdC1pbnN0YWxs:APA91bH" + "x_Y-z0" * 25
SERVICE_ACCOUNT = json.dumps({
    "project_id": "nuri-test",
    "client_email": "push@nuri-test.iam.gserviceaccount.com",
    "private_key": "-----BEGIN PRIVATE KEY-----\\nnot-a-key\\n-----END PRIVATE KEY-----\\n",
})


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _async(value):
    return value


# ── FCM result classification ─────────────────────────────────────────────────

class _Response:
    def __init__(self, status_code, error_code=None, status=None):
        self.status_code = status_code
        self._body = {} if status_code == 200 else {"error": {
            "status": status or "INVALID_ARGUMENT",
            "details": [{
                "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                "errorCode": error_code,
            }] if error_code else [],
        }}

    def json(self):
        return self._body


async def _send_with(monkeypatch, response):
    monkeypatch.setenv("FCM_SERVICE_ACCOUNT_JSON", SERVICE_ACCOUNT)
    monkeypatch.setattr(push_fcm, "access_token", lambda: _async("tok"))
    sent: dict = {}

    class _Client:
        async def post(self, url, **kwargs):
            sent["url"], sent["json"] = url, kwargs.get("json")
            return response

    monkeypatch.setattr(push_fcm, "_http", lambda: _Client())
    result = await push_fcm.send_alert(
        device_token=FCM_TOKEN, environment="production", title="t", body="b",
        notification_id="n1", notification_type="follow_up",
        route="/notifications/n1", data={"card_id": "c"},
        thread_id="nuri-care", collapse_id="care-2026-09-22",
    )
    return result, sent


@pytest.mark.anyio
@pytest.mark.parametrize("status_code, error_code, deactivate, retryable", [
    (200, None, False, False),
    (404, "UNREGISTERED", True, False),
    (403, "SENDER_ID_MISMATCH", True, False),
    (400, "INVALID_ARGUMENT", False, False),
    (429, "QUOTA_EXCEEDED", False, True),
    (503, "UNAVAILABLE", False, True),
    (500, "INTERNAL", False, True),
])
async def test_fcm_results_are_classified(
    monkeypatch, status_code, error_code, deactivate, retryable,
):
    result, _ = await _send_with(monkeypatch, _Response(status_code, error_code))
    assert result.accepted is (status_code == 200)
    assert result.deactivate_token is deactivate
    assert result.retryable is retryable
    assert result.reason == (None if status_code == 200 else error_code)


@pytest.mark.anyio
async def test_the_payload_asks_for_a_heads_up_popup(monkeypatch):
    """Android only pops a notification over the screen on a high-importance
    channel, so the message must name the channel the shell created."""
    _, sent = await _send_with(monkeypatch, _Response(200))
    message = sent["json"]["message"]
    assert sent["url"].endswith("/projects/nuri-test/messages:send")
    assert message["token"] == FCM_TOKEN
    assert message["android"]["priority"] == "HIGH"
    assert message["android"]["notification"]["channel_id"] == push_fcm.CARE_CHANNEL_ID
    assert message["data"]["route"] == "/notifications/n1"
    # FCM rejects non-string data values.
    assert all(isinstance(v, str) for v in message["data"].values())


@pytest.mark.anyio
async def test_a_401_drops_the_cached_access_token(monkeypatch):
    push_fcm._access_token, push_fcm._access_created_at = "stale", 9e9
    await _send_with(monkeypatch, _Response(401, status="UNAUTHENTICATED"))
    assert push_fcm._access_token is None


def test_fcm_is_off_without_a_usable_service_account(monkeypatch):
    monkeypatch.delenv("FCM_SERVICE_ACCOUNT_JSON", raising=False)
    assert push_fcm.configured() is False
    monkeypatch.setenv("FCM_SERVICE_ACCOUNT_JSON", "{not json")
    assert push_fcm.configured() is False
    monkeypatch.setenv("FCM_SERVICE_ACCOUNT_JSON", SERVICE_ACCOUNT)
    assert push_fcm.configured() is True


# ── Registration route ────────────────────────────────────────────────────────

class _Recorder:
    def __init__(self):
        self.writes: list[tuple[str, str, dict]] = []

    def table(self, name):
        rec = self

        class _T:
            def __init__(self):
                self._op, self._payload = None, None

            def update(self, payload):
                self._op, self._payload = "update", payload
                return self

            def upsert(self, payload, **_k):
                self._op, self._payload = "upsert", payload
                return self

            def eq(self, *_a):
                return self

            def neq(self, *_a):
                return self

            def execute(self):
                rec.writes.append((name, self._op, self._payload))
                row = dict(self._payload or {})
                row.setdefault("id", "dev-1")
                row.setdefault("is_active", True)
                row.setdefault("updated_at", "2026-09-22T00:00:00+00:00")
                return SimpleNamespace(data=[row])

        return _T()


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    return TestClient(main.app)


def _register(client, monkeypatch, **overrides):
    rec = _Recorder()
    monkeypatch.setattr(main, "_get_supabase", lambda: rec)
    body = {
        "installation_id": "5c8044c6-85f1-45f4-b9ac-75a49a50d42f",
        "platform": "android", "apns_token": FCM_TOKEN,
        "apns_environment": "production", "bundle_id": push_fcm.package_name(),
        "permission_status": "authorized", "time_zone": "Asia/Shanghai",
    } | overrides
    response = client.post(
        "/api/mobile/push-devices",
        headers={"Authorization": f"Bearer {main._make_token('u1')}"},
        json=body,
    )
    return response, rec


def test_an_android_device_is_stored_with_its_token_intact(client, monkeypatch):
    response, rec = _register(client, monkeypatch)
    assert response.status_code == 200
    device = next(w[2] for w in rec.writes if w[0] == "push_devices" and w[1] == "upsert")
    assert device["platform"] == "android"
    # FCM tokens are case-sensitive; lowercasing one, as iOS does, breaks it.
    assert device["apns_token"] == FCM_TOKEN
    assert FCM_TOKEN not in response.text


def test_android_has_no_sandbox(client, monkeypatch):
    response, _ = _register(client, monkeypatch, apns_environment="sandbox")
    assert response.status_code == 422


def test_an_android_token_with_foreign_characters_is_refused(client, monkeypatch):
    response, _ = _register(client, monkeypatch, apns_token="bad token/" * 10)
    assert response.status_code == 422


def test_an_unexpected_package_is_refused(client, monkeypatch):
    response, _ = _register(client, monkeypatch, bundle_id="com.example.other")
    assert response.status_code == 422


def test_ios_registration_is_unchanged(client, monkeypatch):
    response, rec = _register(
        client, monkeypatch, platform="ios", apns_token="AB" * 32,
        apns_environment="sandbox", bundle_id=push_apns.bundle_id(),
    )
    assert response.status_code == 200
    device = next(w[2] for w in rec.writes if w[0] == "push_devices" and w[1] == "upsert")
    assert device["apns_token"] == "ab" * 32


# ── Dispatch routes each device to its platform's sender ─────────────────────

class _DispatchDb:
    def __init__(self, devices):
        self.devices = devices
        self.deliveries: list[dict] = []

    def rpc(self, *_a, **_k):
        event = {
            "id": "ev1", "user_id": "u1", "type": "follow_up", "title": "t",
            "body": "b", "route": "/notifications/ev1", "data": {},
            "thread_id": "nuri-care", "collapse_id": None, "attempt_count": 1,
        }
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[event]))

    def table(self, name):
        db = self

        class _T:
            def select(self, *_a):
                return self

            def eq(self, *_a):
                return self

            def upsert(self, payload, **_k):
                db.deliveries.append(payload)
                return self

            def update(self, *_a):
                return self

            def execute(self):
                return SimpleNamespace(data=list(db.devices) if name == "push_devices" else [])

        return _T()


def _device(platform, token):
    return {"id": f"dev-{platform}", "platform": platform, "apns_token": token,
            "apns_environment": "production", "permission_status": "authorized"}


@pytest.fixture
def dispatch(monkeypatch):
    outcome: dict = {"sent": [], "finished": [], "requeued": []}

    def _sender(name, is_configured):
        async def send_alert(**kwargs):
            outcome["sent"].append((name, kwargs["device_token"]))
            return APNsResult(True, "", 200, None, False, False, 5)
        return SimpleNamespace(configured=lambda: is_configured, send_alert=send_alert)

    async def _finish(_sb, event_id, status_, *_a):
        outcome["finished"].append((event_id, status_))

    async def _requeue(_sb, event_id, *_a):
        outcome["requeued"].append(event_id)

    monkeypatch.setattr(push_service, "_preferences", lambda *_a: {"time_zone": "UTC"})
    monkeypatch.setattr(push_service, "in_quiet_hours", lambda *_a: False)
    monkeypatch.setattr(push_service, "_sent_today", lambda *_a: 0)
    monkeypatch.setattr(push_service, "_finish", _finish)
    monkeypatch.setattr(push_service, "_requeue", _requeue)

    def configure(*, ios: bool, android: bool):
        monkeypatch.setattr(push_service, "_SENDERS", {
            "ios": _sender("ios", ios), "android": _sender("android", android),
        })
        return outcome
    return configure


NOW = datetime(2026, 9, 22, 12, tzinfo=timezone.utc)


@pytest.mark.anyio
async def test_each_device_goes_to_its_own_platform(dispatch):
    outcome = dispatch(ios=True, android=True)
    db = _DispatchDb([_device("ios", "ab" * 32), _device("android", FCM_TOKEN)])
    await push_service.dispatch_due_notifications(db, now=NOW)
    assert sorted(outcome["sent"]) == [("android", FCM_TOKEN), ("ios", "ab" * 32)]
    assert outcome["finished"] == [("ev1", "sent")]
    # A uuid column must not receive FCM's empty message id.
    assert all(d["apns_id"] is None for d in db.deliveries if d["device_id"] == "dev-android")


@pytest.mark.anyio
async def test_android_is_reached_before_apns_is_configured(dispatch):
    """The first Android build will ship while the APNs key is still missing."""
    outcome = dispatch(ios=False, android=True)
    db = _DispatchDb([_device("ios", "ab" * 32), _device("android", FCM_TOKEN)])
    await push_service.dispatch_due_notifications(db, now=NOW)
    assert outcome["sent"] == [("android", FCM_TOKEN)]


@pytest.mark.anyio
async def test_a_phone_on_an_unconfigured_platform_is_held_not_failed(dispatch):
    outcome = dispatch(ios=False, android=True)
    db = _DispatchDb([_device("ios", "ab" * 32)])
    await push_service.dispatch_due_notifications(db, now=NOW)
    assert outcome["sent"] == []
    assert outcome["requeued"] == ["ev1"]
    assert outcome["finished"] == []


@pytest.mark.anyio
async def test_the_access_token_is_obtained_with_a_signed_service_account_jwt(monkeypatch):
    import jwt
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    monkeypatch.setenv("FCM_SERVICE_ACCOUNT_JSON", json.dumps({
        "project_id": "nuri-test", "client_email": "push@nuri-test.iam.gserviceaccount.com",
        "private_key": pem,
    }))
    push_fcm.reset_access_token()
    seen: dict = {}

    class _Client:
        async def post(self, url, data=None, **_k):
            seen["url"], seen["assertion"] = url, data["assertion"]
            return SimpleNamespace(raise_for_status=lambda: None,
                                   json=lambda: {"access_token": "ya29.test"})

    monkeypatch.setattr(push_fcm, "_http", lambda: _Client())
    assert await push_fcm.access_token() == "ya29.test"
    claims = jwt.decode(seen["assertion"], key.public_key(), algorithms=["RS256"],
                        audience=push_fcm.TOKEN_URL)
    assert claims["scope"] == push_fcm.SCOPE
    assert claims["iss"] == "push@nuri-test.iam.gserviceaccount.com"
    push_fcm.reset_access_token()


# ── Keyless credentials: Vercel OIDC → Google Workload Identity Federation ───

FEDERATION_ENV = {
    "GCP_PROJECT_ID": "nuri-933b9",
    "GCP_PROJECT_NUMBER": "123456789012",
    "GCP_SERVICE_ACCOUNT_EMAIL": "fcm-sender@nuri-933b9.iam.gserviceaccount.com",
    "GCP_WORKLOAD_IDENTITY_POOL_ID": "vercel",
    "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID": "vercel",
}


@pytest.fixture
def federation(monkeypatch):
    for name, value in FEDERATION_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("FCM_SERVICE_ACCOUNT_JSON", raising=False)
    monkeypatch.delenv("VERCEL_OIDC_TOKEN", raising=False)
    push_fcm.reset_access_token()
    push_fcm.use_vercel_oidc_token(None)
    yield
    push_fcm.use_vercel_oidc_token(None)
    push_fcm.reset_access_token()


def test_federation_needs_the_request_token(federation):
    """The GCP_* variables alone are not enough: without the OIDC header the
    dispatcher must hold events rather than fail every one of them."""
    assert push_fcm.configured() is False
    push_fcm.use_vercel_oidc_token("vercel.jwt")
    assert push_fcm.configured() is True
    assert push_fcm.project_id() == "nuri-933b9"


@pytest.mark.anyio
async def test_the_oidc_token_is_exchanged_then_impersonates_the_sender(federation, monkeypatch):
    push_fcm.use_vercel_oidc_token("vercel.jwt")
    calls: list[tuple[str, dict]] = []

    class _Client:
        async def post(self, url, json=None, headers=None, **_k):
            calls.append((url, {"json": json, "headers": headers or {}}))
            body = ({"access_token": "federated"} if "sts.googleapis.com" in url
                    else {"accessToken": "sa-token", "expireTime": "x"})
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: body)

    monkeypatch.setattr(push_fcm, "_http", lambda: _Client())
    assert await push_fcm.access_token() == "sa-token"

    (sts_url, sts), (sa_url, sa) = calls
    assert sts_url == push_fcm.STS_URL
    assert sts["json"]["subject_token"] == "vercel.jwt"
    assert sts["json"]["audience"] == (
        "//iam.googleapis.com/projects/123456789012/locations/global/"
        "workloadIdentityPools/vercel/providers/vercel"
    )
    assert sa_url.endswith(
        "/serviceAccounts/fcm-sender@nuri-933b9.iam.gserviceaccount.com:generateAccessToken",
    )
    assert sa["headers"]["authorization"] == "Bearer federated"
    assert sa["json"]["scope"] == [push_fcm.SCOPE]


def test_federation_is_preferred_over_a_key(federation, monkeypatch):
    monkeypatch.setenv("FCM_SERVICE_ACCOUNT_JSON", SERVICE_ACCOUNT)
    push_fcm.use_vercel_oidc_token("vercel.jwt")
    assert push_fcm.project_id() == "nuri-933b9"


def test_the_dispatch_route_hands_over_the_vercel_header(client, monkeypatch):
    seen: dict = {}
    monkeypatch.setenv("CRON_SECRET", "right")
    monkeypatch.setattr(main, "_get_supabase", lambda: object())
    monkeypatch.setattr(push_fcm, "use_vercel_oidc_token",
                        lambda token: seen.setdefault("token", token))

    async def _dispatch(_sb):
        return {}
    monkeypatch.setattr(push_service, "dispatch_due_notifications", _dispatch)

    response = client.get(
        "/api/internal/push/dispatch",
        headers={"Authorization": "Bearer right", "x-vercel-oidc-token": "vercel.jwt"},
    )
    assert response.status_code == 200
    assert seen["token"] == "vercel.jwt"
