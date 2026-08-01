"""Privacy-safe feedback features for the personalized learning recommender.

The first production version deliberately uses small, explainable weights.  It
does not store conversation text, resource titles, or user identifiers.  The
helpers in this module are deterministic so ranking behaviour can be evaluated
and changed without coupling it to FastAPI or Supabase.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional
from urllib.parse import parse_qs, urlsplit, urlunsplit


MAX_EVENTS_PER_USER = 240
EVENT_RETENTION_DAYS = 120
RECENT_RESOURCE_EXCLUSION_DAYS = 30

LEARNING_EVENT_NAMES = frozenset(
    {
        "feed_impression",
        "card_open",
        "detail_view",
        "detail_dwell",
        "external_resource_click",
        "favorite",
        "continue_chat",
        "helpful",
        "not_relevant",
        "resource_impression",
        # Internal delivery event.  It is intentionally absent from the
        # public Pydantic request contract in main.py.
        "resource_delivered",
    }
)

_HOST_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_YOUTUBE_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YOUTUBE_HOSTS = frozenset(
    {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtube-nocookie.com",
        "www.youtube-nocookie.com",
        "youtu.be",
        "www.youtu.be",
    }
)


def event_storage_key(uid: str) -> str:
    """Return a non-identifying key for the existing app_settings table."""

    digest = hashlib.sha256(uid.encode("utf-8")).hexdigest()
    return f"recommendation_events:v1:{digest}"


def _parse_timestamp(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def canonical_resource_url(value: object) -> str:
    """Canonicalize a public HTTPS resource URL without private query data.

    Ordinary pages lose their entire query string and fragment, since either
    can contain account identifiers or access tokens.  Direct YouTube links
    retain only a syntactically valid public video id.  Malformed authority or
    port syntax is rejected instead of leaking an exception to an API caller.
    """

    if not isinstance(value, str) or len(value) > 2048:
        return ""
    raw = value.strip()
    if not raw or any(ord(character) < 33 for character in raw):
        return ""
    try:
        parts = urlsplit(raw)
        hostname = (parts.hostname or "").casefold()
        port = parts.port
    except (UnicodeError, ValueError):
        return ""
    if (
        parts.scheme.casefold() != "https"
        or not hostname
        or parts.username is not None
        or parts.password is not None
        or port not in (None, 443)
    ):
        return ""

    try:
        hostname = hostname.encode("idna").decode("ascii")
    except UnicodeError:
        return ""
    if (
        hostname == "localhost"
        or "." not in hostname
        or hostname.endswith((".localhost", ".local", ".internal"))
        or any(not _HOST_LABEL_RE.fullmatch(label) for label in hostname.split("."))
    ):
        return ""
    try:
        # Resource links are expected to use stable publisher hostnames.  IP
        # literals are both unstable and a common way to smuggle internal URLs.
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        return ""

    if hostname in _YOUTUBE_HOSTS:
        path_parts = [part for part in parts.path.split("/") if part]
        video_id = ""
        if hostname in {"youtu.be", "www.youtu.be"} and path_parts:
            video_id = path_parts[0]
        elif len(path_parts) >= 2 and path_parts[0] in {"embed", "live", "shorts"}:
            video_id = path_parts[1]
        elif parts.path.rstrip("/") == "/watch":
            try:
                video_id = (parse_qs(parts.query).get("v") or [""])[0]
            except ValueError:
                return ""
        if not _YOUTUBE_VIDEO_ID_RE.fullmatch(video_id):
            return ""
        return f"https://www.youtube.com/watch?v={video_id}"

    path = parts.path or "/"
    if path != "/":
        path = path.rstrip("/") or "/"
    return urlunsplit(("https", hostname, path, "", ""))


def resource_url_hash(value: object) -> str:
    """Return a non-reversible equality key for a valid canonical URL."""

    canonical = canonical_resource_url(value)
    if not canonical:
        return ""
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalize_event(
    payload: object,
    *,
    occurred_at: str,
    trusted_resource_url: bool = False,
) -> Optional[dict]:
    """Return a bounded event safe to persist, or ``None`` when unsupported.

    Client-provided URLs are never persisted verbatim.  They contribute only a
    deterministic hash of the strict canonical URL.  A server-created
    ``resource_delivered`` event may opt in to keeping the canonical public URL
    so the research service can avoid delivering it again.
    """

    if not isinstance(payload, dict):
        return None
    event = str(payload.get("event") or "").strip()
    card_id = str(payload.get("card_id") or "").strip()
    if event not in LEARNING_EVENT_NAMES or not card_id or len(card_id) > 128:
        return None

    result: dict = {
        "event_id": str(payload.get("client_event_id") or payload.get("event_id") or "")[:80],
        "event": event,
        "card_id": card_id,
        "occurred_at": occurred_at,
    }
    bounded_strings = {
        "recommendation_id": 128,
        "feed_request_id": 80,
        "resource_id": 160,
        "resource_kind": 16,
        "content_category": 24,
        "locale": 12,
        "reason": 32,
    }
    for field, limit in bounded_strings.items():
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            result[field] = value.strip()[:limit]

    stored_url_hash = payload.get("resource_url_hash")
    if isinstance(stored_url_hash, str) and re.fullmatch(
        r"[0-9a-f]{64}", stored_url_hash
    ):
        # Preserve an already-normalized row during retention pruning.  The
        # public API schema does not accept this implementation-only field.
        result["resource_url_hash"] = stored_url_hash

    resource_url = canonical_resource_url(payload.get("resource_url"))
    if resource_url:
        result["resource_url_hash"] = resource_url_hash(resource_url)
        if trusted_resource_url and event == "resource_delivered":
            result["resource_url"] = resource_url

    for field, lower, upper in (
        ("position", 0, 50),
        ("duration_ms", 0, 1_800_000),
        ("value", -1, 1),
    ):
        value = payload.get(field)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            result[field] = max(lower, min(upper, value))
    return result


def prune_events(
    events: object,
    *,
    now: Optional[datetime] = None,
    limit: int = MAX_EVENTS_PER_USER,
) -> list[dict]:
    """Validate, deduplicate, expire, and bound a user's event history."""

    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = current - timedelta(days=EVENT_RETENTION_DAYS)
    normalized: list[tuple[datetime, dict]] = []
    seen_ids: set[str] = set()
    if not isinstance(events, list):
        return []
    for item in events:
        if not isinstance(item, dict):
            continue
        timestamp = _parse_timestamp(item.get("occurred_at"))
        if not timestamp or timestamp < cutoff or timestamp > current + timedelta(minutes=5):
            continue
        clean = normalize_event(
            item,
            occurred_at=timestamp.isoformat(),
            trusted_resource_url=item.get("event") == "resource_delivered",
        )
        if not clean:
            continue
        event_id = str(clean.get("event_id") or "")
        if event_id and event_id in seen_ids:
            continue
        if event_id:
            seen_ids.add(event_id)
        normalized.append((timestamp, clean))
    normalized.sort(key=lambda pair: pair[0])
    return [item for _, item in normalized[-max(1, limit) :]]


def recent_resource_urls(
    events: Iterable[dict],
    *,
    now: Optional[datetime] = None,
    limit: int = 90,
) -> list[str]:
    """Return recently shown/opened resources, newest first, for hard exclusion."""

    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = current - timedelta(days=RECENT_RESOURCE_EXCLUSION_DAYS)
    candidates: list[tuple[datetime, str]] = []
    for item in events:
        if item.get("event") not in {"resource_delivered", "external_resource_click"}:
            continue
        timestamp = _parse_timestamp(item.get("occurred_at"))
        url = canonical_resource_url(item.get("resource_url"))
        if timestamp and timestamp >= cutoff and url:
            candidates.append((timestamp, url))
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    seen: set[str] = set()
    urls: list[str] = []
    for _, url in candidates:
        if url in seen:
            continue
        seen.add(url)
        urls.append(url)
        if len(urls) >= limit:
            break
    return urls


def card_behavior_signal(
    card_id: str,
    events: Iterable[dict],
    *,
    now: Optional[datetime] = None,
) -> dict:
    """Compute affinity plus freshness penalties for one candidate card.

    Conversation relevance remains the eligibility gate in ``main.py``.  This
    signal only reorders eligible topics and suppresses items a parent has
    explicitly rejected or repeatedly ignored.
    """

    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    last_14_days = current - timedelta(days=14)
    last_30_days = current - timedelta(days=30)
    impressions = 0
    positive = 0
    negative = 0
    temporary_negative = 0
    content_refresh_reasons: set[str] = set()
    last_negative: Optional[datetime] = None
    last_temporary_negative: Optional[datetime] = None
    last_positive: Optional[datetime] = None
    last_3_days = current - timedelta(days=3)

    for item in events:
        if str(item.get("card_id") or "") != card_id:
            continue
        timestamp = _parse_timestamp(item.get("occurred_at"))
        if not timestamp:
            continue
        event = item.get("event")
        if event == "feed_impression" and timestamp >= last_14_days:
            impressions += 1
        elif event == "not_relevant" and timestamp >= last_30_days:
            reason = str(item.get("reason") or "topic_mismatch")
            if reason == "topic_mismatch":
                negative += 1
                last_negative = max(last_negative or timestamp, timestamp)
            elif reason == "not_now" and timestamp >= last_3_days:
                temporary_negative += 1
                last_temporary_negative = max(
                    last_temporary_negative or timestamp,
                    timestamp,
                )
            elif reason in {
                "already_seen",
                "repetitive",
                "wrong_language",
                "source_not_useful",
            }:
                # These describe the delivered resource set, not the parent's
                # interest in the conversation topic.  They should trigger a
                # fresh content set without teaching the topic ranker that an
                # otherwise relevant need is unwanted.
                content_refresh_reasons.add(reason)
        elif event == "helpful" and timestamp >= last_30_days:
            positive += 8
            last_positive = max(last_positive or timestamp, timestamp)
        elif event == "favorite" and timestamp >= last_30_days:
            if item.get("value", 1) == 1:
                positive += 6
                last_positive = max(last_positive or timestamp, timestamp)
            elif item.get("value") == 0:
                # Removing a favorite is a weak item signal, not a later
                # positive action that can erase an explicit topic rejection.
                negative += 2
        elif event == "external_resource_click" and timestamp >= last_30_days:
            positive += 3
            last_positive = max(last_positive or timestamp, timestamp)
        elif event == "continue_chat" and timestamp >= last_30_days:
            positive += 4
            last_positive = max(last_positive or timestamp, timestamp)
        elif event == "detail_dwell" and timestamp >= last_30_days:
            duration_ms = int(item.get("duration_ms") or 0)
            if duration_ms >= 45_000:
                positive += 3
                last_positive = max(last_positive or timestamp, timestamp)

    # One delivery is normal. Repeated delivery without a meaningful action is
    # the first-stage equivalent of YouTube's freshness/ignore signal.
    freshness_penalty = -min(12, max(0, impressions - 1) * 3)
    explicit_negative = bool(
        last_negative and (not last_positive or last_negative >= last_positive)
    )
    explicit_penalty = -24 if explicit_negative else -min(6, negative * 2)
    temporary_penalty = (
        -6
        if last_temporary_negative
        and (not last_positive or last_temporary_negative >= last_positive)
        else 0
    )
    affinity = min(10, positive)
    return {
        "score": affinity + freshness_penalty + explicit_penalty + temporary_penalty,
        "affinity": affinity,
        "freshness_penalty": freshness_penalty,
        "explicit_negative": explicit_negative,
        "temporary_penalty": temporary_penalty,
        "content_refresh_reasons": sorted(content_refresh_reasons),
        "impression_count_14d": impressions,
    }
