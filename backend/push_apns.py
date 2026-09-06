"""APNs provider client — the one place that talks to Apple.

Implements §8 of the iOS dynamic-notification handoff (v1.0, 2026-09-04), with
one structural change: the handoff reads its credentials at import time
(``os.environ["APNS_TEAM_ID"]``). Every module in this backend is imported
eagerly by ``backend.main``, so doing that would make an unconfigured APNs key
crash the entire API — chat included — rather than disable one feature. Here the
credentials are read on first use and :func:`configured` reports whether sending
is possible at all, so the rest of the product keeps working while push is being
set up.

What the handoff says about results is worth restating because it shapes the
caller: *"APNs 200 是接受指标，不是设备展示或用户阅读回执"*. A 200 means Apple
accepted the request. It does not mean a phone displayed anything, and nothing
in this file should be read as delivery confirmation.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal, Optional

import httpx
import jwt

APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com"
APNS_PRODUCTION_HOST = "https://api.push.apple.com"

#: Apple rejects a provider token older than an hour. Refreshing at 50 minutes
#: keeps one token for hundreds of notifications without ever presenting a
#: stale one, which Apple treats as an authentication failure rather than a
#: retryable error.
_TOKEN_TTL_SECONDS = 50 * 60

#: Reasons that will fail again on retry. §13: a bad, wrong-topic or expired
#: token needs the device deactivated, and an oversized payload needs the
#: template fixed — resending either one just burns quota.
NON_RETRYABLE = frozenset({
    "BadDeviceToken", "DeviceTokenNotForTopic", "Forbidden",
    "ExpiredToken", "Unregistered", "PayloadTooLarge",
})

#: Reasons that mean the token is dead and the row should be retired now.
DEACTIVATING = frozenset({
    "BadDeviceToken", "DeviceTokenNotForTopic", "ExpiredToken", "Unregistered",
})

_jwt_value: Optional[str] = None
_jwt_created_at = 0.0
_jwt_lock = asyncio.Lock()
_client: Optional[httpx.AsyncClient] = None


def bundle_id() -> str:
    return os.getenv("APNS_BUNDLE_ID", "com.ordashtech.nuri")


def configured() -> bool:
    """Whether a provider token can be built at all.

    Checked before a dispatch run so an unconfigured deployment reports
    "push is off" once, instead of failing every event individually.
    """
    return all(os.getenv(name) for name in
               ("APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY"))


def _private_key() -> str:
    # Vercel environment variables cannot hold real newlines, so a .p8 is
    # stored with literal backslash-n and restored here.
    return os.environ["APNS_PRIVATE_KEY"].replace("\\n", "\n")


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # Apple requires HTTP/2 and rewards a reused connection; a new client
        # per notification would pay a TLS handshake every time.
        _client = httpx.AsyncClient(http2=True, timeout=15.0)
    return _client


async def aclose() -> None:
    """Release the shared connection. Used by tests and shutdown hooks."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def reset_provider_token() -> None:
    """Forget the cached provider token. Used by tests and after a 403."""
    global _jwt_value, _jwt_created_at
    _jwt_value, _jwt_created_at = None, 0.0


async def provider_token() -> str:
    global _jwt_value, _jwt_created_at
    now = time.time()
    if _jwt_value and now - _jwt_created_at < _TOKEN_TTL_SECONDS:
        return _jwt_value
    async with _jwt_lock:
        # Re-checked inside the lock: several coroutines can arrive at an
        # expired token together and only one of them should sign a new one.
        now = time.time()
        if _jwt_value and now - _jwt_created_at < _TOKEN_TTL_SECONDS:
            return _jwt_value
        _jwt_value = jwt.encode(
            {"iss": os.environ["APNS_TEAM_ID"], "iat": int(now)},
            _private_key(),
            algorithm="ES256",
            headers={"kid": os.environ["APNS_KEY_ID"]},
        )
        _jwt_created_at = now
        return _jwt_value


@dataclass
class APNsResult:
    accepted: bool
    apns_id: str
    http_status: int
    reason: Optional[str]
    deactivate_token: bool
    retryable: bool
    latency_ms: int


async def send_alert(
    *,
    device_token: str,
    environment: Literal["sandbox", "production"],
    title: str,
    body: str,
    notification_id: str,
    notification_type: str,
    route: str,
    data: Optional[dict[str, Any]] = None,
    thread_id: str = "nuri-reminders",
    collapse_id: Optional[str] = None,
    expiration_epoch: Optional[int] = None,
) -> APNsResult:
    """Send one alert. Never raises for an APNs-level rejection.

    The caller needs to record and act on a rejection per device, so a 4xx or
    5xx comes back as an :class:`APNsResult` rather than an exception; only a
    transport failure propagates.
    """
    host = APNS_SANDBOX_HOST if environment == "sandbox" else APNS_PRODUCTION_HOST
    request_id = str(uuid.uuid4())
    payload = {
        "aps": {
            "alert": {"title": title, "body": body},
            "sound": "default",
            "thread-id": thread_id,
        },
        "notification_id": notification_id,
        "type": notification_type,
        "route": route,
        "data": data or {},
    }
    headers = {
        "authorization": f"bearer {await provider_token()}",
        "apns-topic": bundle_id(),
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-id": request_id,
    }
    if collapse_id:
        headers["apns-collapse-id"] = collapse_id[:64]
    if expiration_epoch is not None:
        headers["apns-expiration"] = str(expiration_epoch)

    started = time.monotonic()
    response = await _http().post(
        f"{host}/3/device/{device_token}", headers=headers, json=payload,
    )
    latency_ms = int((time.monotonic() - started) * 1000)

    reason: Optional[str] = None
    if response.content:
        try:
            reason = response.json().get("reason")
        except ValueError:
            reason = "InvalidAPNsResponse"

    if response.status_code == 403:
        # Key ID, Team ID, the .p8 or the signing clock is wrong. The cached
        # token cannot become valid on its own, so drop it and let the next
        # attempt sign a fresh one before a human is paged.
        reset_provider_token()

    return APNsResult(
        accepted=response.status_code == 200,
        apns_id=response.headers.get("apns-id", request_id),
        http_status=response.status_code,
        reason=reason,
        deactivate_token=response.status_code == 410 or reason in DEACTIVATING,
        retryable=response.status_code in {429, 500, 503}
        and reason not in NON_RETRYABLE,
        latency_ms=latency_ms,
    )
