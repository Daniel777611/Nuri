"""FCM HTTP v1 client — the one place that talks to Google about Android push.

The Android twin of :mod:`backend.push_apns`, shaped so the dispatcher can treat
the two alike: credentials are read on first use, :func:`configured` says
whether sending is possible, and a rejection comes back as a result rather than
an exception. Firebase is used for delivery only; accounts and data stay in
Supabase.

Credentials are one service-account key, the JSON file Firebase gives you under
Project settings → Service accounts, stored whole in ``FCM_SERVICE_ACCOUNT_JSON``.
Its ``private_key`` already escapes newlines as ``\\n`` inside the JSON string,
so the file pastes into a Vercel variable unchanged.

As with APNs, an accepted request means Google took the message, not that a
phone showed it.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Optional

import httpx
import jwt

from backend.push_apns import APNsResult

TOKEN_URL = "https://oauth2.googleapis.com/token"
SEND_URL = "https://fcm.googleapis.com/v1/projects/{project}/messages:send"
SCOPE = "https://www.googleapis.com/auth/firebase.messaging"

#: The Android shell creates this channel with IMPORTANCE_HIGH, which is what
#: makes Android show the notification as a heads-up popup rather than only an
#: icon in the status bar. The id must match ``NuriApp.CARE_CHANNEL_ID``.
CARE_CHANNEL_ID = "nuri_care"

#: Google access tokens last an hour; refresh early so one never expires
#: between being read and being used.
_TOKEN_TTL_SECONDS = 50 * 60

#: FCM error codes that mean this registration token will never work again.
DEACTIVATING = frozenset({"UNREGISTERED", "SENDER_ID_MISMATCH"})
RETRYABLE = frozenset({"UNAVAILABLE", "INTERNAL", "QUOTA_EXCEEDED"})

_access_token: Optional[str] = None
_access_created_at = 0.0
_token_lock = asyncio.Lock()
_client: Optional[httpx.AsyncClient] = None


def package_name() -> str:
    return os.getenv("ANDROID_PACKAGE_NAME", "com.ordashtech.nuri")


def _service_account() -> Optional[dict]:
    raw = os.getenv("FCM_SERVICE_ACCOUNT_JSON")
    if not raw:
        return None
    try:
        info = json.loads(raw)
    except ValueError:
        return None
    if not all(info.get(k) for k in ("project_id", "client_email", "private_key")):
        return None
    return info


def configured() -> bool:
    return _service_account() is not None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=15.0)
    return _client


async def aclose() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def reset_access_token() -> None:
    """Forget the cached access token. Used by tests and after a 401."""
    global _access_token, _access_created_at
    _access_token, _access_created_at = None, 0.0


async def access_token() -> str:
    """An OAuth access token for FCM, from the service account's own JWT."""
    global _access_token, _access_created_at
    now = time.time()
    if _access_token and now - _access_created_at < _TOKEN_TTL_SECONDS:
        return _access_token
    async with _token_lock:
        now = time.time()
        if _access_token and now - _access_created_at < _TOKEN_TTL_SECONDS:
            return _access_token
        info = _service_account()
        if info is None:
            raise RuntimeError("FCM_SERVICE_ACCOUNT_JSON is missing or malformed")
        assertion = jwt.encode(
            {
                "iss": info["client_email"],
                "scope": SCOPE,
                "aud": info.get("token_uri") or TOKEN_URL,
                "iat": int(now),
                "exp": int(now) + 3600,
            },
            info["private_key"],
            algorithm="RS256",
        )
        response = await _http().post(
            info.get("token_uri") or TOKEN_URL,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
        )
        response.raise_for_status()
        _access_token = response.json()["access_token"]
        _access_created_at = now
        return _access_token


def _error_code(response: httpx.Response) -> Optional[str]:
    """The FCM-specific code if there is one, else the generic gRPC status."""
    try:
        error = response.json().get("error") or {}
    except ValueError:
        return "InvalidFCMResponse"
    for detail in error.get("details") or []:
        if str(detail.get("@type", "")).endswith("FcmError") and detail.get("errorCode"):
            return detail["errorCode"]
    return error.get("status")


async def send_alert(
    *,
    device_token: str,
    title: str,
    body: str,
    notification_id: str,
    notification_type: str,
    route: str,
    data: Optional[dict[str, Any]] = None,
    collapse_id: Optional[str] = None,
    **_: Any,
) -> APNsResult:
    """Send one alert to one Android install. Never raises for an FCM rejection.

    Takes the same keywords as :func:`backend.push_apns.send_alert` (extra
    APNs-only ones are ignored) and returns the same result type, so the
    dispatcher does not care which platform a device is on.
    """
    info = _service_account()
    if info is None:
        raise RuntimeError("FCM_SERVICE_ACCOUNT_JSON is missing or malformed")

    # FCM data values must be strings. `route` and friends sit at the top
    # level, mirroring the APNs payload, so the shell reads them the same way.
    message_data = {
        "notification_id": notification_id,
        "type": notification_type,
        "route": route,
        "data": json.dumps(data or {}, ensure_ascii=False),
    }
    android: dict[str, Any] = {
        # HIGH wakes a dozing phone; without it the popup can arrive late.
        "priority": "HIGH",
        "notification": {
            "channel_id": CARE_CHANNEL_ID,
            "default_sound": True,
            "notification_priority": "PRIORITY_HIGH",
            "visibility": "PRIVATE",
        },
    }
    if collapse_id:
        android["collapse_key"] = collapse_id[:64]
        android["notification"]["tag"] = collapse_id[:64]

    payload = {
        "message": {
            "token": device_token,
            "notification": {"title": title, "body": body},
            "data": message_data,
            "android": android,
        }
    }

    started = time.monotonic()
    response = await _http().post(
        SEND_URL.format(project=info["project_id"]),
        headers={"authorization": f"Bearer {await access_token()}"},
        json=payload,
    )
    latency_ms = int((time.monotonic() - started) * 1000)

    reason = None if response.status_code == 200 else _error_code(response)
    if response.status_code == 401:
        reset_access_token()

    return APNsResult(
        accepted=response.status_code == 200,
        # notification_deliveries.apns_id is a uuid column; an FCM message name
        # ("projects/…/messages/0:…") does not fit and is not needed.
        apns_id="",
        http_status=response.status_code,
        reason=reason,
        deactivate_token=response.status_code == 404 or reason in DEACTIVATING,
        retryable=response.status_code in {429, 500, 503} or reason in RETRYABLE,
        latency_ms=latency_ms,
    )
