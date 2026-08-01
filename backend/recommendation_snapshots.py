"""Stable, user-bound snapshots for personalized learning recommendations.

The public ``recommendation_id`` is only an opaque lookup identifier.  The
underlying session reference, cutoff timestamp and explanation stay in the
server-side ``app_settings`` value so copied detail links never expose raw
conversation text or a user identifier.
"""

from __future__ import annotations

import hashlib
import json
import re
import base64
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from cryptography.fernet import Fernet, InvalidToken


SNAPSHOT_VERSION = 2
SNAPSHOT_CONTEXT_VERSION = "multi-session-intent-child-age-v2"
SUPPORTED_SNAPSHOT_VERSIONS = frozenset({1, SNAPSHOT_VERSION})
SNAPSHOT_TTL_DAYS = 90

_RECOMMENDATION_ID = re.compile(r"^rec_[a-f0-9]{24}$")
_SERIALIZED_PREFIX = "fernet:v1:"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def recommendation_id(
    uid: str,
    *,
    card_id: str,
    session_id: Optional[str],
    context_created_at: Optional[str],
    profile_fingerprint: Optional[str] = None,
    context_version: str = SNAPSHOT_CONTEXT_VERSION,
) -> str:
    """Return a stable opaque ID without putting account data in the URL."""

    material = "\n".join(
        (
            uid,
            card_id,
            session_id or "no-session",
            context_created_at or "no-cutoff",
            profile_fingerprint or "no-profile",
            context_version,
        )
    )
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]
    return f"rec_{digest}"


def snapshot_storage_key(uid: str, recommendation_id_value: str) -> str:
    """Namespace a snapshot to one account without storing its raw user ID."""

    if not _RECOMMENDATION_ID.fullmatch(recommendation_id_value):
        raise ValueError("invalid recommendation_id")
    return f"{snapshot_storage_prefix(uid)}{recommendation_id_value}"


def snapshot_storage_prefix(uid: str) -> str:
    """Return the account-scoped prefix used for bulk privacy deletion."""

    user_digest = hashlib.sha256(uid.encode("utf-8")).hexdigest()
    return f"user_recommendation:{user_digest}:"


def build_snapshot(
    uid: str,
    card: Mapping[str, Any],
    context: Mapping[str, Any],
    *,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Build the bounded server-side record used to reconstruct a detail page."""

    created_at = (now or _utc_now()).astimezone(timezone.utc)
    card_id = str(card.get("id") or "").strip()
    if not card_id:
        raise ValueError("card id is required")
    session_id = str(context.get("session_id") or "").strip() or None
    context_created_at = str(context.get("context_created_at") or "").strip() or None
    profile_fingerprint = (
        str(context.get("child_profile_fingerprint") or "").strip() or None
    )
    rec_id = recommendation_id(
        uid,
        card_id=card_id,
        session_id=session_id,
        context_created_at=context_created_at,
        profile_fingerprint=profile_fingerprint,
    )
    return {
        "version": SNAPSHOT_VERSION,
        "context_version": SNAPSHOT_CONTEXT_VERSION,
        "recommendation_id": rec_id,
        "card_id": card_id,
        "session_id": session_id,
        "context_created_at": context_created_at,
        "child_profile_fingerprint": profile_fingerprint,
        "child_age_context": str(context.get("child_age_context") or "")[:120],
        "personalization_reason": str(card.get("personalization_reason") or "")[:240],
        "recommendation_focus": str(card.get("recommendation_focus") or "")[:80],
        "recommendation_intent": str(card.get("recommendation_intent") or "")[:48],
        "recommendation_score": int(card.get("recommendation_score") or 0),
        "created_at": created_at.isoformat(),
        "expires_at": (created_at + timedelta(days=SNAPSHOT_TTL_DAYS)).isoformat(),
    }


def _snapshot_cipher(secret: str) -> Fernet:
    if not secret:
        raise ValueError("snapshot encryption secret is required")
    material = hashlib.sha256(
        f"nuri:recommendation-snapshot:v1:{secret}".encode("utf-8")
    ).digest()
    return Fernet(base64.urlsafe_b64encode(material))


def serialize_snapshot(snapshot: Mapping[str, Any], *, secret: str) -> str:
    """Encrypt and authenticate a snapshot before database persistence."""

    plaintext = json.dumps(
        dict(snapshot), ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    token = _snapshot_cipher(secret).encrypt(plaintext).decode("ascii")
    return f"{_SERIALIZED_PREFIX}{token}"


def parse_snapshot(
    value: object,
    *,
    now: Optional[datetime] = None,
    secret: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Validate a stored snapshot and reject malformed or expired records."""

    try:
        if isinstance(value, str):
            if not secret or not value.startswith(_SERIALIZED_PREFIX):
                return None
            token = value[len(_SERIALIZED_PREFIX) :].encode("ascii")
            plaintext = _snapshot_cipher(secret).decrypt(token)
            parsed = json.loads(plaintext)
        else:
            # Process-local cache records never leave the backend process.
            parsed = dict(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, json.JSONDecodeError, InvalidToken):
        return None
    if parsed.get("version") not in SUPPORTED_SNAPSHOT_VERSIONS:
        return None
    rec_id = str(parsed.get("recommendation_id") or "")
    if not _RECOMMENDATION_ID.fullmatch(rec_id):
        return None
    if not str(parsed.get("card_id") or "").strip():
        return None
    try:
        expires_at = datetime.fromisoformat(str(parsed.get("expires_at") or ""))
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    if expires_at <= (now or _utc_now()).astimezone(timezone.utc):
        return None
    # Version 1 records remain readable during the deployment transition. They
    # are still bound to the same account/session and expiration checks; the
    # current child age is attached at request time before resources are gated.
    if parsed.get("version") == 1:
        parsed.setdefault("child_profile_fingerprint", None)
        parsed.setdefault("child_age_context", "")
    return parsed
