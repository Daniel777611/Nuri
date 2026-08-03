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
import copy
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

from cryptography.fernet import Fernet, InvalidToken


SNAPSHOT_VERSION = 2
SNAPSHOT_CONTEXT_VERSION = "multi-session-intent-child-age-v2"
SUPPORTED_SNAPSHOT_VERSIONS = frozenset({1, SNAPSHOT_VERSION})
SNAPSHOT_TTL_DAYS = 90
PREPARED_CONTENT_TTL_HOURS = 6
RESOURCE_READINESS_VALUES = frozenset({"preparing", "ready", "retryable"})

_RECOMMENDATION_ID = re.compile(r"^rec_[a-f0-9]{24}$")
_PREPARED_CONTENT_SET_ID = re.compile(r"^pcs_[a-f0-9]{24}$")
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
    content_category = str(card.get("content_category") or "").strip() or None
    session_id = str(context.get("session_id") or "").strip() or None
    context_created_at = str(context.get("context_created_at") or "").strip() or None
    profile_fingerprint = (
        str(context.get("child_profile_fingerprint") or "").strip() or None
    )
    rec_id = recommendation_id(
        uid,
        # Category-card recommendations intentionally share the same base
        # learning topic.  Bind the opaque ID to the presentation lane so the
        # authority, featured and case snapshots can never overwrite or open
        # one another while downstream favorites/chat keep the base card ID.
        card_id=(
            f"{card_id}::{content_category}" if content_category else card_id
        ),
        session_id=session_id,
        context_created_at=context_created_at,
        profile_fingerprint=profile_fingerprint,
    )
    return {
        "version": SNAPSHOT_VERSION,
        "context_version": SNAPSHOT_CONTEXT_VERSION,
        "recommendation_id": rec_id,
        "card_id": card_id,
        "content_category": content_category,
        "preferred_locale": str(context.get("preferred_locale") or "")[:16],
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


def _prepared_binding(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    """Return the immutable recommendation fields a prepared pair is bound to."""

    return {
        "recommendation_id": snapshot.get("recommendation_id"),
        "content_category": snapshot.get("content_category"),
        "preferred_locale": snapshot.get("preferred_locale") or "",
        "child_profile_fingerprint": snapshot.get("child_profile_fingerprint"),
        "context_created_at": snapshot.get("context_created_at"),
    }


def _clear_prepared_content(snapshot: dict[str, Any]) -> None:
    for field in (
        "prepared_binding",
        "prepared_resources",
        "prepared_content_set_id",
        "prepared_at",
        "prepared_expires_at",
    ):
        snapshot.pop(field, None)


def prepared_resource_pair(
    snapshot: Mapping[str, Any],
    *,
    now: Optional[datetime] = None,
) -> Optional[list[dict[str, Any]]]:
    """Return a still-valid article/video pair bound to this exact snapshot."""

    if snapshot.get("resource_readiness") != "ready":
        return None
    if snapshot.get("prepared_binding") != _prepared_binding(snapshot):
        return None
    if not _PREPARED_CONTENT_SET_ID.fullmatch(
        str(snapshot.get("prepared_content_set_id") or "")
    ):
        return None
    try:
        expires_at = datetime.fromisoformat(
            str(snapshot.get("prepared_expires_at") or "")
        )
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    if expires_at <= (now or _utc_now()).astimezone(timezone.utc):
        return None
    resources = snapshot.get("prepared_resources")
    if not isinstance(resources, list) or len(resources) != 2:
        return None
    pair: list[dict[str, Any]] = []
    kinds: set[str] = set()
    expected_category = str(snapshot.get("content_category") or "")
    expected_locale = str(snapshot.get("preferred_locale") or "")
    for raw in resources:
        if not isinstance(raw, dict):
            return None
        resource = copy.deepcopy(raw)
        kind = str(resource.get("kind") or "")
        if kind not in {"article", "video"} or kind in kinds:
            return None
        category = str(resource.get("content_category") or "")
        if category and category != expected_category:
            return None
        locales = resource.get("locales")
        if expected_locale and isinstance(locales, list) and expected_locale not in locales:
            return None
        if not str(resource.get("url") or "").startswith("https://"):
            return None
        kinds.add(kind)
        pair.append(resource)
    return pair if kinds == {"article", "video"} else None


def snapshot_with_resource_readiness(
    snapshot: Mapping[str, Any],
    readiness: str,
) -> dict[str, Any]:
    """Set a non-ready preparation state without retaining stale content."""

    if readiness not in RESOURCE_READINESS_VALUES - {"ready"}:
        raise ValueError("invalid non-ready resource readiness")
    updated = copy.deepcopy(dict(snapshot))
    _clear_prepared_content(updated)
    updated["resource_readiness"] = readiness
    updated["resource_readiness_updated_at"] = _utc_now().isoformat()
    return updated


def snapshot_with_prepared_resource_pair(
    snapshot: Mapping[str, Any],
    resources: list[dict[str, Any]],
    *,
    content_set_id: str,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Attach one encrypted-at-rest pair to its immutable recommendation."""

    prepared_at = (now or _utc_now()).astimezone(timezone.utc)
    updated = copy.deepcopy(dict(snapshot))
    updated.update(
        {
            "resource_readiness": "ready",
            "resource_readiness_updated_at": prepared_at.isoformat(),
            "prepared_binding": _prepared_binding(updated),
            "prepared_resources": copy.deepcopy(resources),
            "prepared_content_set_id": str(content_set_id),
            "prepared_at": prepared_at.isoformat(),
            "prepared_expires_at": (
                prepared_at + timedelta(hours=PREPARED_CONTENT_TTL_HOURS)
            ).isoformat(),
        }
    )
    if not content_set_id or prepared_resource_pair(updated, now=prepared_at) is None:
        raise ValueError("invalid prepared resource pair")
    return updated


def carry_prepared_resource_state(
    previous: Mapping[str, Any],
    fresh: Mapping[str, Any],
    *,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Preserve preparation state when an identical feed snapshot is rebuilt."""

    updated = copy.deepcopy(dict(fresh))
    if _prepared_binding(previous) != _prepared_binding(updated):
        return updated
    readiness = str(previous.get("resource_readiness") or "")
    if readiness == "ready" and prepared_resource_pair(previous, now=now) is None:
        readiness = "retryable"
    if readiness not in RESOURCE_READINESS_VALUES:
        return updated
    updated["resource_readiness"] = readiness
    for field in (
        "resource_readiness_updated_at",
        "prepared_binding",
        "prepared_resources",
        "prepared_content_set_id",
        "prepared_at",
        "prepared_expires_at",
    ):
        if field in previous:
            updated[field] = copy.deepcopy(previous[field])
    if readiness != "ready":
        _clear_prepared_content(updated)
    return updated


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
    parsed.setdefault("content_category", None)
    parsed.setdefault("preferred_locale", "")
    readiness = str(parsed.get("resource_readiness") or "")
    if readiness == "ready" and prepared_resource_pair(parsed, now=now) is None:
        _clear_prepared_content(parsed)
        parsed["resource_readiness"] = "retryable"
    elif readiness in RESOURCE_READINESS_VALUES - {"ready"}:
        _clear_prepared_content(parsed)
    elif readiness not in RESOURCE_READINESS_VALUES:
        parsed.pop("resource_readiness", None)
    return parsed
