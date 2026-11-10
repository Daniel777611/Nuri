"""Community: parent-to-parent questions, relationships, P2P chat, AI consent.

Contract source: the Figma handoff "Community 后端接口交接" (定稿版本 file
AdHDK7uLqyzvgbzm1FlM6F, node 216-13472), written for the frozen web/iOS 1027
build whose Community screens still run on a local reducer. Every path below
is one of its PROPOSED capability groups P01–P36, under /api/community/v1.
Where the handoff left a product decision open, this module takes the
conservative side; each choice is listed in backend/docs/community_api.md.

Rules every route here keeps (handoff §4):

* AUTH_MEMBER — the actor is the token's account, never a body field; every
  read re-checks authorship / delivery / membership.
* PUBLIC_DTO — other parents only ever see `public_parent()`; never the
  account id, email, birthday or the NURI profile.
* WRITE_KEY — creating writes take a client key; the same key and content
  returns the first result, the same key with other content is refused.
* VERSION — state transitions accept `expected_version` and refuse stale ones.
* PAGE — every list is {items, next_cursor, has_more}, paged on a bigint seq.
* NO_AI_BY_DEFAULT — only polish / translation / transcription call a model,
  each behind its own consent check. P2P messages never touch the NURI chat.

Storage is the same Supabase handle as the rest of the backend, resolved
through `runtime.get_supabase` on every call (the one test seam).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import math
import os
import random
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from io import BytesIO
from typing import Any, Callable, Literal, Optional

import anyio
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field

from backend import llm_usage, push_service, runtime

PREFIX = "/api/community/v1"

# ── Limits (handoff §4 "仍未批准的限制": defaults until product signs off) ────
PAGE_DEFAULT = 20
PAGE_MAX = 50
QUESTION_MAX = 1000
REPLY_MAX = 2000
COMMENT_MAX = 1000
MESSAGE_MAX = 2000
ABOUT_MAX = 300
DISPLAY_NAME_MAX = 30
CITY_MAX = 60
MESSAGE_MEDIA_MAX = 9
QUESTIONS_PER_DAY = int(os.getenv("COMMUNITY_QUESTIONS_PER_DAY", "10"))
INVITATIONS_PER_DAY = int(os.getenv("COMMUNITY_INVITATIONS_PER_DAY", "20"))
DELIVERY_FANOUT = int(os.getenv("COMMUNITY_DELIVERY_FANOUT", "5"))
# D06 (meeting 2026-11-06): a received question can be answered for 30 days.
DELIVERY_TTL_DAYS = int(os.getenv("COMMUNITY_DELIVERY_TTL_DAYS", "30"))
# D04: rank recipients by family fit, then let the AI order the shortlist by
# relevance to the question. Off → the rule-based score alone.
AI_MATCHING = os.getenv("COMMUNITY_AI_MATCHING", "1") == "1"
MATCH_SHORTLIST = 20
MATCH_TIMEOUT_S = float(os.getenv("COMMUNITY_MATCH_TIMEOUT_S", "8"))
MEDIA_UPLOAD_TTL_MIN = 30
MEDIA_ACCESS_TTL_S = 300
MEDIA_BUCKET = os.getenv("COMMUNITY_MEDIA_BUCKET", "community-media")
MEDIA_MAX_BYTES = 2_500_000  # the existing NURI single-image ceiling
MEDIA_MIMES = {"image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp"}
AI_MODEL = os.getenv("COMMUNITY_AI_MODEL", "gpt-5-mini")
AI_TIMEOUT_S = float(os.getenv("COMMUNITY_AI_TIMEOUT_S", "20"))
#: Polish, translate and match are short rewrites, not reasoning problems. At the
#: model default they spent 128–384 reasoning tokens and 2.4–8 s a call in prod
#: (2026-11-10); the router uses "minimal" for the same model at ~2 s.
AI_REASONING_EFFORT = os.getenv("COMMUNITY_AI_REASONING_EFFORT", "minimal")
#: The app's own NURI AI consent version (native-ios/src/aiConsent.ts). The
#: client sends what the parent agreed to; a stale version is CONSENT_REQUIRED.
NURI_AI_CONSENT_VERSION = os.getenv("NURI_AI_CONSENT_VERSION", "2026-10-01.1")
#: The notice the two-party consent sheet shows (consent frame 188:65175).
# D12: consent covers the whole conversation, history included; a new notice.
AI_NOTICE_VERSION = os.getenv("COMMUNITY_AI_NOTICE_VERSION", "2026-11-06.1")
AI_PURPOSES = ("conversation_notes", "translation")

#: Frontend intent chips, by the index the 1027 reducer uses (CommunityFinal
#: intent screen / CommunityProfileEditor). The index is a UI detail; the code
#: is the contract.
INTENT_CODES = (
    "share_parenting_ideas",   # 交流育儿智慧
    "talk_parenting",          # 聊聊育儿心事
    "similar_experiences",     # 与我经历相似
    "outings_with_children",   # 和我一起遛娃
    "nearby_parents",          # 在我附近
    "casual_chat",             # 随便聊聊
)
ROLE_FILTERS = ("any", "mom", "dad")
DISTANCE_FILTERS = (1, 3, 5, 10)  # miles, the UI's options
ANONYMOUS_NAME = "匿名家长"

CommunityKind = Literal[
    "community_question", "community_reply", "community_invitation",
    "community_conversation", "community_ai_consent",
]

# ── Errors (handoff §4 错误分类建议) ──────────────────────────────────────────

_CODE_STATUS = {
    "NOT_FOUND_OR_NOT_ACCESSIBLE": (404, False),
    "VALIDATION_FAILED": (422, False),
    "QUESTION_CLOSED": (409, False),
    "DELIVERY_LOCKED": (409, False),
    "RELATIONSHIP_NOT_ALLOWED": (403, False),
    "BLOCKED_OR_DISCONNECTED": (403, False),
    "CONSENT_REQUIRED": (403, False),
    "CONSENT_REVOKED_OR_CHANGED": (409, False),
    "IDEMPOTENCY_CONFLICT": (409, False),
    "VERSION_CONFLICT": (409, False),
    "MEDIA_NOT_READY_OR_NOT_OWNED": (422, False),
    "RATE_LIMITED": (429, True),
    "STORAGE_OR_SERVICE_UNAVAILABLE": (503, True),
}


class CommunityError(HTTPException):
    """An HTTPException that names its Community code.

    main._http_error reads `error_code` / `retryable` / `extra` so the envelope
    stays the existing {detail, error{code,...}, request_id} shape while a 409
    is no longer always SESSION_CONFLICT.
    """

    def __init__(self, code: str, message: str, *, extra: Optional[dict] = None,
                 retry_after_s: Optional[int] = None):
        status_code, retryable = _CODE_STATUS[code]
        headers = {"Retry-After": str(retry_after_s)} if retry_after_s else None
        super().__init__(status_code, message, headers=headers)
        self.error_code = code
        self.retryable = retryable
        self.extra = extra or {}


def _not_found(what: str = "resource") -> CommunityError:
    # One answer for "does not exist" and "not yours": never confirm existence.
    return CommunityError("NOT_FOUND_OR_NOT_ACCESSIBLE", f"{what} not found")


def _invalid(message: str) -> CommunityError:
    return CommunityError("VALIDATION_FAILED", message)


class _UniqueViolation(Exception):
    pass


def _is_unique_violation(exc: Exception) -> bool:
    code = getattr(exc, "code", None)
    if code == "23505":
        return True
    text = str(exc)
    return "23505" in text or "duplicate key" in text


# ── Storage plumbing ─────────────────────────────────────────────────────────

def _sb():
    sb = runtime.get_supabase()
    if sb is None:
        raise CommunityError("STORAGE_OR_SERVICE_UNAVAILABLE", "Community storage unavailable")
    return sb


async def _db(fn: Callable[[], Any]) -> Any:
    """Run one blocking Supabase call. Storage faults never look like data."""
    try:
        return await anyio.to_thread.run_sync(fn)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - classified below
        if _is_unique_violation(exc):
            raise _UniqueViolation(str(exc)) from exc
        print(f"[community] storage error: {type(exc).__name__}: {exc}")
        raise CommunityError(
            "STORAGE_OR_SERVICE_UNAVAILABLE", "Community storage unavailable",
        ) from exc


async def _select(table: str, build: Callable[[Any], Any]) -> list[dict]:
    sb = _sb()
    res = await _db(lambda: build(sb.table(table).select("*")).execute())
    return list(getattr(res, "data", None) or [])


async def _one(table: str, build: Callable[[Any], Any]) -> Optional[dict]:
    rows = await _select(table, lambda q: build(q).limit(1))
    return rows[0] if rows else None


async def _insert(table: str, row: dict) -> dict:
    sb = _sb()
    res = await _db(lambda: sb.table(table).insert(row).execute())
    data = list(getattr(res, "data", None) or [])
    if not data:
        raise CommunityError("STORAGE_OR_SERVICE_UNAVAILABLE", "Community write was not confirmed")
    return data[0]


async def _update(table: str, patch: dict, build: Callable[[Any], Any]) -> list[dict]:
    sb = _sb()
    res = await _db(lambda: build(sb.table(table).update(patch)).execute())
    return list(getattr(res, "data", None) or [])


async def _delete(table: str, build: Callable[[Any], Any]) -> list[dict]:
    sb = _sb()
    res = await _db(lambda: build(sb.table(table).delete()).execute())
    return list(getattr(res, "data", None) or [])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime] = None) -> str:
    return (value or _now()).isoformat()


def _parse_ts(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _fingerprint(payload: dict) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


async def _create_once(table: str, *, match: dict, key_col: str, key: str,
                       fingerprint: str, row: dict) -> tuple[dict, bool]:
    """WRITE_KEY: insert `row` once per (match, key).

    Same key + same content → the first row, created=False. Same key + other
    content → IDEMPOTENCY_CONFLICT. A concurrent duplicate insert loses the
    unique race and resolves to the winner the same way.
    """

    def lookup(q):
        for col, value in match.items():
            q = q.eq(col, value)
        return q.eq(key_col, key)

    def resolve(existing: dict) -> tuple[dict, bool]:
        if existing.get("request_fingerprint") != fingerprint:
            raise CommunityError(
                "IDEMPOTENCY_CONFLICT",
                "This request key was already used with different content",
            )
        return existing, False

    existing = await _one(table, lookup)
    if existing:
        return resolve(existing)
    try:
        return await _insert(table, {**row, key_col: key, "request_fingerprint": fingerprint}), True
    except _UniqueViolation:
        existing = await _one(table, lookup)
        if existing:
            return resolve(existing)
        raise


def _page_size(value: Optional[int]) -> int:
    if value is None:
        return PAGE_DEFAULT
    if value < 1 or value > PAGE_MAX:
        raise _invalid(f"page_size must be between 1 and {PAGE_MAX}")
    return value


def _decode_cursor(cursor: Optional[str]) -> Optional[int]:
    if not cursor:
        return None
    try:
        decoded = json.loads(base64.urlsafe_b64decode(cursor.encode() + b"==").decode())
        value = int(decoded["s"])
    except (ValueError, KeyError, TypeError, binascii.Error, json.JSONDecodeError):
        raise _invalid("cursor is not valid")
    if value < 0:
        raise _invalid("cursor is not valid")
    return value


def _encode_cursor(seq: Any) -> str:
    return base64.urlsafe_b64encode(json.dumps({"s": int(seq)}).encode()).decode().rstrip("=")


def _page(rows: list[dict], size: int, *, key: str = "seq") -> tuple[list[dict], Optional[str], bool]:
    """rows were fetched newest-first with limit size+1."""
    has_more = len(rows) > size
    rows = rows[:size]
    next_cursor = _encode_cursor(rows[-1][key]) if has_more and rows else None
    return rows, next_cursor, has_more


async def _seq_page(table: str, build: Callable[[Any], Any], cursor: Optional[str],
                    size: int) -> tuple[list[dict], Optional[str], bool]:
    before = _decode_cursor(cursor)

    def q(query):
        query = build(query)
        if before is not None:
            query = query.lt("seq", before)
        return query.order("seq", desc=True).limit(size + 1)

    return _page(await _select(table, q), size)


def _clean_text(value: Optional[str], *, field: str, max_len: int, required: bool = True) -> str:
    text = (value or "").strip()
    if required and not text:
        raise _invalid(f"{field} must not be empty")
    if len(text) > max_len:
        raise _invalid(f"{field} must be at most {max_len} characters")
    return text


def _check_version(row: dict, expected: Optional[int]) -> None:
    if expected is not None and int(row.get("version") or 1) != expected:
        raise CommunityError(
            "VERSION_CONFLICT", "This changed on another device; reload and try again",
            extra={"current_version": int(row.get("version") or 1)},
        )


async def _versioned_update(table: str, row: dict, patch: dict, *, id_col: str = "id") -> dict:
    """Compare-and-set on `version`: a concurrent change makes this a conflict."""
    current = int(row.get("version") or 1)
    updated = await _update(
        table, {**patch, "version": current + 1},
        lambda q: q.eq(id_col, row[id_col]).eq("version", current),
    )
    if not updated:
        raise CommunityError("VERSION_CONFLICT", "This changed on another device; reload and try again")
    return updated[0]


async def _rate_limit(table: str, actor_col: str, uid: str, limit: int) -> None:
    since = _iso(_now() - timedelta(days=1))
    rows = await _select(table, lambda q: q.eq(actor_col, uid).gte("created_at", since).limit(limit + 1))
    if len(rows) >= limit:
        raise CommunityError("RATE_LIMITED", "Daily limit reached; try again later",
                             retry_after_s=3600)


def _pair(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


# ── Identity, preferences, visibility ────────────────────────────────────────

DEFAULT_PREFERENCES = {
    "parent_message_notifications_enabled": True,
    "profile_hidden": False,
    "auto_translate_messages": False,
    "version": 0,
}


async def _profile(uid: str) -> Optional[dict]:
    return await _one("community_profiles", lambda q: q.eq("user_id", uid))


async def _profiles(uids: list[str]) -> dict[str, dict]:
    uids = sorted({u for u in uids if u})
    if not uids:
        return {}
    rows = await _select("community_profiles", lambda q: q.in_("user_id", uids))
    return {row["user_id"]: row for row in rows}


async def _profile_by_public(parent_id: str) -> Optional[dict]:
    try:
        uuid.UUID(str(parent_id))
    except ValueError:
        return None
    return await _one("community_profiles", lambda q: q.eq("public_id", str(parent_id)))


async def _roles(uids: list[str]) -> dict[str, str]:
    uids = sorted({u for u in uids if u})
    if not uids:
        return {}
    rows = await _select("users", lambda q: q.in_("id", uids))
    return {row["id"]: row.get("parent_role") or "" for row in rows}


async def _preferences(uid: str) -> dict:
    row = await _one("community_preferences", lambda q: q.eq("user_id", uid))
    return {**DEFAULT_PREFERENCES, **(row or {})}


async def _block_sets(uid: str) -> tuple[set[str], set[str]]:
    """(people I blocked, people who blocked me)."""
    mine = await _select("community_blocks", lambda q: q.eq("blocker_id", uid))
    theirs = await _select("community_blocks", lambda q: q.eq("blocked_id", uid))
    return {r["blocked_id"] for r in mine}, {r["blocker_id"] for r in theirs}


async def _blocked_between(a: str, b: str) -> tuple[bool, bool]:
    a_b = await _one("community_blocks", lambda q: q.eq("blocker_id", a).eq("blocked_id", b))
    b_a = await _one("community_blocks", lambda q: q.eq("blocker_id", b).eq("blocked_id", a))
    return bool(a_b), bool(b_a)


async def _relationship(a: str, b: str) -> Optional[dict]:
    low, high = _pair(a, b)
    return await _one("community_relationships", lambda q: q.eq("user_low", low).eq("user_high", high))


async def _conversation_between(a: str, b: str) -> Optional[dict]:
    low, high = _pair(a, b)
    return await _one("community_conversations", lambda q: q.eq("user_low", low).eq("user_high", high))


def _role_label(role: str) -> Optional[str]:
    # The UI filters 妈妈/爸爸 only; other roles stay unlabelled publicly.
    return role if role in ("mom", "dad") else None


def public_parent(profile: dict, role: str = "") -> dict:
    """The whitelist DTO (PUBLIC_DTO). Nothing else about an account leaves.

    `role` is the parent's own community tag (D03), never the account's
    parent_role; the argument is kept for callers and ignored.
    """
    return {
        "parent_id": str(profile["public_id"]),
        "display_name": profile.get("display_name") or "",
        "about": profile.get("about") or "",
        "city": profile.get("city_label") or "",
        "intents": list(profile.get("intent_codes") or []),
        "role": _role_label(profile.get("gender_tag") or ""),
        "gender_tag": profile.get("gender_tag"),
        "avatar": {"media_id": str(profile["avatar_media_id"])} if profile.get("avatar_media_id") else None,
    }


def anonymous_parent() -> dict:
    return {"parent_id": None, "display_name": ANONYMOUS_NAME, "about": "", "city": "",
            "intents": [], "role": None, "avatar": None, "anonymous": True}


async def _require_profile(uid: str) -> dict:
    profile = await _profile(uid)
    if not profile:
        raise _invalid("Create a community profile first")
    return profile


async def _visible_target(uid: str, parent_id: str) -> tuple[str, dict]:
    """Resolve a public parent id the viewer may see: (account id, profile).

    Invisible (404): unknown ids, yourself, anyone who blocked you, and hidden
    profiles you have no existing relationship or invitation with.
    """
    profile = await _profile_by_public(parent_id)
    if not profile or profile["user_id"] == uid:
        raise _not_found("parent")
    target = profile["user_id"]
    _i_blocked, they_blocked = await _blocked_between(uid, target)
    if they_blocked:
        raise _not_found("parent")
    if (await _preferences(target)).get("profile_hidden"):
        rel = await _relationship(uid, target)
        if not (rel and rel.get("state") == "active") and not await _pending_between(uid, target):
            raise _not_found("parent")
    return target, profile


async def _pending_between(a: str, b: str) -> list[dict]:
    one = await _select("community_invitations",
                        lambda q: q.eq("sender_id", a).eq("recipient_id", b).eq("state", "pending"))
    two = await _select("community_invitations",
                        lambda q: q.eq("sender_id", b).eq("recipient_id", a).eq("state", "pending"))
    return one + two


async def _relation_view(uid: str, target: str) -> dict:
    """What the viewer's relationship with `target` is, and what they may do."""
    i_blocked, _ = await _blocked_between(uid, target)
    rel = await _relationship(uid, target)
    conv = await _conversation_between(uid, target)
    pending = await _pending_between(uid, target)
    sent = next((p for p in pending if p["sender_id"] == uid), None)
    received = next((p for p in pending if p["recipient_id"] == uid), None)
    if i_blocked:
        state, actions = "blocked_by_me", ["unblock"]
    elif rel and rel.get("state") == "active":
        state, actions = "connected", ["message", "disconnect", "block"]
    elif received:
        state, actions = "invitation_received", ["accept_invitation", "decline_invitation", "block"]
    elif sent:
        state, actions = "invitation_sent", ["block"]
    else:
        state = "disconnected" if rel else "none"
        actions = ["invite", "block"]
    return {
        "state": state,
        "relationship_id": str(rel["id"]) if rel else None,
        "invitation_id": str((received or sent)["id"]) if (received or sent) else None,
        "conversation_id": str(conv["id"]) if conv and state == "connected" else None,
        "allowed_actions": actions,
    }


# ── Notifications (community events on notification_events) ─────────────────

_NOTIFY_TEXT = {
    # Lock-screen text stays vague by design (§4.1 of the push spec): no
    # question body, no message text, no names.
    "community_question": ("有家长想听听你的经验", "打开 NURI 社区看看这个问题"),
    "community_reply": ("你的问题有了新的回应", "打开 NURI 社区查看"),
    "community_invitation": ("有家长想和你建立联系", "打开 NURI 社区查看邀请"),
    "community_conversation": ("你收到一条家长消息", "打开 NURI 社区查看"),
    "community_ai_consent": ("有家长邀请 Nuri 参与你们的对话", "需要你确认后才会开启"),
}


async def _notify(recipient: str, kind: CommunityKind, business_id: str, target: dict,
                  *, actor: Optional[str] = None) -> None:
    """Queue one community event; never fails the business write it follows.

    Deduped on the business event, so a retried write cannot notify twice.
    Skipped when the recipient turned parent messages off or blocked the actor.
    """
    try:
        if not (await _preferences(recipient)).get("parent_message_notifications_enabled", True):
            return
        if actor:
            blocked_actor, _ = await _blocked_between(recipient, actor)
            if blocked_actor:
                return
        title, body = _NOTIFY_TEXT[kind]
        row = {
            "user_id": recipient,
            "type": "chat",
            "title": title,
            "body": body,
            "route": "/notifications/pending",
            "data": {"kind": kind, "target": {"kind": kind, **target}},
            "thread_id": "community",
            "collapse_id": f"{kind}-{business_id}"[:64],
            "dedupe_key": f"community:{kind}:{business_id}:{recipient}",
            "scheduled_at": _iso(),
            "full_content": body,
            "status": "queued",
        }
        await push_service._queue(_sb(), row)
    except Exception as exc:  # noqa: BLE001 - a notification is best effort
        print(f"[community] notify skipped: {type(exc).__name__}")


# ── Request models ───────────────────────────────────────────────────────────

class _Strict(BaseModel):
    # Undeclared fields are refused rather than silently dropped (handoff E02).
    model_config = ConfigDict(extra="forbid")


ClientKey = Field(..., min_length=8, max_length=128)


class ProfilePatch(_Strict):
    display_name: Optional[str] = Field(None, max_length=DISPLAY_NAME_MAX * 2)
    about: Optional[str] = Field(None, max_length=ABOUT_MAX * 2)
    city: Optional[str] = Field(None, max_length=CITY_MAX * 2)
    intents: Optional[list[str]] = Field(None, max_length=len(INTENT_CODES))
    # D03: chosen in the community onboarding.
    gender_tag: Optional[Literal["mom", "dad", "other"]] = None
    avatar_media_id: Optional[str] = None
    clear_avatar: bool = False
    # Coarse location for distance filters; null with share_location=false clears it.
    share_location: Optional[bool] = None
    latitude: Optional[float] = Field(None, ge=-90, le=90)
    longitude: Optional[float] = Field(None, ge=-180, le=180)
    expected_version: Optional[int] = None
    client_request_id: Optional[str] = Field(None, max_length=128)


class PolishIn(_Strict):
    text: str = Field(..., max_length=QUESTION_MAX * 2)
    language: str = Field("zh-CN", max_length=16)
    ai_consent_version: str = Field(..., max_length=64)
    client_request_id: str = ClientKey


class QuestionIn(_Strict):
    body: str = Field(..., max_length=QUESTION_MAX * 2)
    original_language: str = Field("zh-CN", max_length=16)
    version_source: Literal["original", "polished"] = "original"
    polish_id: Optional[str] = None
    anonymous: bool = False
    show_child_age: bool = False
    client_request_id: str = ClientKey


class TransitionItem(_Strict):
    question_id: str
    expected_version: Optional[int] = None


class TransitionIn(_Strict):
    action: Literal["close", "delete"]
    items: list[TransitionItem] = Field(..., min_length=1, max_length=50)
    confirmed: bool = False
    client_request_id: str = ClientKey


class ResponseIn(_Strict):
    body: str = Field(..., max_length=REPLY_MAX * 2)
    language: str = Field("zh-CN", max_length=16)
    anonymous: bool = False
    expected_version: Optional[int] = None
    client_request_id: str = ClientKey


class CommentIn(_Strict):
    body: str = Field(..., max_length=COMMENT_MAX * 2)
    language: str = Field("zh-CN", max_length=16)
    client_message_id: str = ClientKey


class InvitationIn(_Strict):
    target_parent_id: str
    client_request_id: str = ClientKey


class InvitationDecisionIn(_Strict):
    decision: Literal["accept", "decline"]
    expected_version: Optional[int] = None
    client_request_id: str = ClientKey


class BlockIn(_Strict):
    confirmed: bool = False
    client_request_id: Optional[str] = Field(None, max_length=128)


class ConversationIn(_Strict):
    target_parent_id: Optional[str] = None
    relationship_id: Optional[str] = None
    client_request_id: str = ClientKey


class MessageIn(_Strict):
    text: str = Field("", max_length=MESSAGE_MAX * 2)
    media_ids: list[str] = Field(default_factory=list, max_length=MESSAGE_MEDIA_MAX)
    language: str = Field("zh-CN", max_length=16)
    client_message_id: str = ClientKey


class ReadCursorIn(_Strict):
    last_read_seq: int = Field(..., ge=0)
    client_request_id: Optional[str] = Field(None, max_length=128)


class PreferencesPatch(_Strict):
    parent_message_notifications_enabled: Optional[bool] = None
    profile_hidden: Optional[bool] = None
    auto_translate_messages: Optional[bool] = None
    expected_version: Optional[int] = None
    client_request_id: Optional[str] = Field(None, max_length=128)


class ConsentRequestIn(_Strict):
    purpose: Literal["conversation_notes", "translation"] = "conversation_notes"
    notice_version: str = Field(..., max_length=64)
    client_request_id: str = ClientKey


class ConsentDecisionIn(_Strict):
    decision: Literal["allow", "decline"]
    notice_version: str = Field(..., max_length=64)
    expected_version: Optional[int] = None
    client_request_id: str = ClientKey


class RevokeIn(_Strict):
    purpose: Optional[Literal["conversation_notes", "translation"]] = None
    client_request_id: Optional[str] = Field(None, max_length=128)


class TranslationIn(_Strict):
    target_language: str = Field(..., min_length=2, max_length=16)
    ai_consent_version: str = Field(..., max_length=64)
    client_request_id: str = ClientKey


class TranscriptionIn(_Strict):
    audio_base64: str
    locale: Optional[str] = Field(None, max_length=32)
    ai_consent_version: str = Field(..., max_length=64)
    client_request_id: str = ClientKey


class MediaUploadIn(_Strict):
    purpose: Literal["avatar", "message"]
    mime_type: str = Field(..., max_length=64)
    byte_size: int = Field(..., gt=0)
    sha256: str = Field(..., min_length=64, max_length=64)
    client_request_id: str = ClientKey


class MediaCompleteIn(_Strict):
    client_request_id: Optional[str] = Field(None, max_length=128)


REPORT_REASONS = ("harassment", "sexual", "hate", "child_safety", "self_harm", "spam", "other")


class ReportIn(_Strict):
    target_kind: Literal["question", "reply", "comment", "message", "parent"]
    target_id: str = Field(..., min_length=1, max_length=64)
    reason: Literal["harassment", "sexual", "hate", "child_safety", "self_harm", "spam", "other"]
    note: Optional[str] = Field(None, max_length=1000)
    # Also block the author. Not offered for anonymous content: a block list
    # entry would tell the reporter who wrote it.
    block: bool = False


class ReportReviewIn(BaseModel):
    status: Literal["actioned", "dismissed", "pending"]
    reviewer_note: Optional[str] = Field(None, max_length=500)
    remove_content: bool = False


class MediaDirectIn(_Strict):
    purpose: Literal["avatar", "message"]
    # A base64 image data URI; ~3.4 MB of text for the 2.5 MB image ceiling.
    data_uri: str = Field(..., max_length=3_400_000)
    client_request_id: str = ClientKey


# ── P01–P03 Profiles ─────────────────────────────────────────────────────────

def _own_profile_dto(profile: dict, role: str, prefs: dict) -> dict:
    return {
        "exists": True,
        "profile": {
            **public_parent(profile, role),
            "location_shared": profile.get("approx_lat") is not None,
            "version": int(profile.get("version") or 1),
            "updated_at": profile.get("updated_at"),
        },
        "visibility": "hidden" if prefs.get("profile_hidden") else "visible",
        "public_preview": public_parent(profile, role),
        "editable_fields": ["display_name", "about", "city", "intents", "avatar_media_id", "share_location"],
        "intent_options": list(INTENT_CODES),
    }


async def get_my_profile(uid: str) -> dict:
    profile = await _profile(uid)
    if not profile:
        # Explicitly "not created": never a fixture such as "Nina".
        return {"exists": False, "profile": None, "visibility": None, "public_preview": None,
                "editable_fields": ["display_name", "about", "city", "intents", "avatar_media_id", "share_location"],
                "intent_options": list(INTENT_CODES)}
    roles = await _roles([uid])
    return _own_profile_dto(profile, roles.get(uid, ""), await _preferences(uid))


async def patch_my_profile(uid: str, body: ProfilePatch) -> dict:
    profile = await _profile(uid)
    patch: dict[str, Any] = {}
    if body.display_name is not None:
        patch["display_name"] = _clean_text(body.display_name, field="display_name", max_len=DISPLAY_NAME_MAX)
    if body.gender_tag is not None:
        patch["gender_tag"] = body.gender_tag
    if body.about is not None:
        patch["about"] = _clean_text(body.about, field="about", max_len=ABOUT_MAX, required=False)
    if body.city is not None:
        patch["city_label"] = _clean_text(body.city, field="city", max_len=CITY_MAX, required=False)
    if body.intents is not None:
        unknown = [code for code in body.intents if code not in INTENT_CODES]
        if unknown:
            raise _invalid(f"unknown intents: {', '.join(unknown)}")
        patch["intent_codes"] = [code for code in INTENT_CODES if code in set(body.intents)]
    if body.share_location is False:
        patch["approx_lat"] = patch["approx_lng"] = None
    elif body.share_location:
        if body.latitude is None or body.longitude is None:
            raise _invalid("latitude and longitude are required to share a location")
        # ~1 km: enough for "within 1 mile", never a home address.
        patch["approx_lat"] = round(body.latitude, 2)
        patch["approx_lng"] = round(body.longitude, 2)
    avatar_row = None
    if body.clear_avatar:
        patch["avatar_media_id"] = None
    elif body.avatar_media_id is not None:
        avatar_row = await _own_media(uid, body.avatar_media_id)
        if avatar_row["purpose"] != "avatar" or avatar_row["state"] not in ("ready", "committed"):
            raise CommunityError("MEDIA_NOT_READY_OR_NOT_OWNED", "Avatar is not ready")
        patch["avatar_media_id"] = avatar_row["id"]

    if profile is None and "display_name" not in patch:
        # D01: the first profile starts from the account's name.
        account = await _one("users", lambda q: q.eq("id", uid))
        nickname = (account or {}).get("nickname") or ""
        if not nickname.strip():
            raise _invalid("display_name is required to create a community profile")
        patch["display_name"] = _clean_text(nickname, field="display_name", max_len=DISPLAY_NAME_MAX)
    if profile is None:
        row = {"user_id": uid, "about": "", "city_label": "", "intent_codes": [],
               **patch, "updated_at": _iso()}
        try:
            profile = await _insert("community_profiles", row)
        except _UniqueViolation:
            raise CommunityError("VERSION_CONFLICT", "Profile was created on another device; reload")
    else:
        _check_version(profile, body.expected_version)
        if patch:
            profile = await _versioned_update("community_profiles", profile,
                                              {**patch, "updated_at": _iso()}, id_col="user_id")
    if "display_name" in patch:
        await _sync_account_name(uid, patch["display_name"])
    if avatar_row and avatar_row["state"] != "committed":
        await _update("community_media", {"state": "committed", "bound_to": "avatar", "updated_at": _iso()},
                      lambda q: q.eq("id", avatar_row["id"]))
    roles = await _roles([uid])
    return _own_profile_dto(profile, roles.get(uid, ""), await _preferences(uid))


async def _sync_account_name(uid: str, name: str) -> None:
    """D01: a community name change is the account's name change too."""
    await _update("users", {"nickname": name}, lambda q: q.eq("id", uid))
    try:
        from backend.nuri_core import family as core_family
        core_family.invalidate(uid)
    except Exception:  # noqa: BLE001 - a cache miss is harmless
        pass


async def sync_name_from_account(uid: str, nickname: str) -> None:
    """D01, the other direction: PUT /auth/me renames the community profile.

    Best effort: the account rename already succeeded, and a missing profile
    (or the community tables not yet migrated) is not an error.
    """
    name = (nickname or "").strip()[:DISPLAY_NAME_MAX]
    if not name:
        return
    try:
        await _update("community_profiles", {"display_name": name, "updated_at": _iso()},
                      lambda q: q.eq("user_id", uid))
    except Exception as exc:  # noqa: BLE001
        print(f"[community] name sync skipped: {type(exc).__name__}")


async def get_parent(uid: str, parent_id: str) -> dict:
    target, profile = await _visible_target(uid, parent_id)
    roles = await _roles([target])
    return {"parent": public_parent(profile, roles.get(target, "")),
            "relationship": await _relation_view(uid, target)}


# ── P04 Discovery ────────────────────────────────────────────────────────────

def _miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


async def recommendations(uid: str, role: str = "any", distance_miles: Optional[int] = None,
                          intents: Optional[str] = None, cursor: Optional[str] = None,
                          page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    if role not in ROLE_FILTERS:
        raise _invalid(f"role must be one of {', '.join(ROLE_FILTERS)}")
    if distance_miles is not None and distance_miles not in DISTANCE_FILTERS:
        raise _invalid("distance_miles must be one of 1, 3, 5, 10")
    wanted = [code for code in (intents or "").split(",") if code]
    if any(code not in INTENT_CODES for code in wanted):
        raise _invalid("unknown intent filter")
    me = await _require_profile(uid)
    if distance_miles is not None and me.get("approx_lat") is None:
        raise _invalid("Share an approximate location to filter by distance")

    i_blocked, blocked_me = await _block_sets(uid)
    contacts = {row["other"] for row in await _active_relationships(uid)}
    before = _decode_cursor(cursor)
    batch = 200
    candidates = await _select("community_profiles", lambda q: (
        (q.lt("seq", before) if before is not None else q).neq("user_id", uid)
        .order("seq", desc=True).limit(batch)))
    ids = [c["user_id"] for c in candidates]
    hidden_rows = await _select("community_preferences", lambda q: q.in_("user_id", ids)) if ids else []
    hidden = {row["user_id"] for row in hidden_rows if row.get("profile_hidden")}
    roles = await _roles(ids)
    items: list[dict] = []
    last_seq = None
    for cand in candidates:
        last_seq = cand["seq"]
        other = cand["user_id"]
        if other in i_blocked or other in blocked_me or other in hidden or other in contacts:
            continue
        if role != "any" and cand.get("gender_tag") != role:
            continue
        shared = [c for c in (cand.get("intent_codes") or []) if c in set(me.get("intent_codes") or [])]
        if wanted and not set(wanted) & set(cand.get("intent_codes") or []):
            continue
        distance = None
        if me.get("approx_lat") is not None and cand.get("approx_lat") is not None:
            distance = round(_miles(me["approx_lat"], me["approx_lng"],
                                    cand["approx_lat"], cand["approx_lng"]) * 2) / 2
        if distance_miles is not None and (distance is None or distance > distance_miles):
            continue
        items.append({
            "parent": public_parent(cand, roles.get(other, "")),
            # Rounded to half a mile, and only when both shared a location.
            "distance_miles": distance,
            "shared_intents": shared,
            "relationship": await _relation_view(uid, other),
        })
        if len(items) > size:
            break
    has_more = len(items) > size or len(candidates) == batch
    if len(items) > size:
        items = items[:size]
        # Resume after the last item actually returned.
        last_seq = next(c["seq"] for c in candidates
                        if str(c["public_id"]) == items[-1]["parent"]["parent_id"])
    return {
        "items": items,
        "next_cursor": _encode_cursor(last_seq) if has_more and last_seq is not None else None,
        "has_more": has_more,
        "filters": {"roles": list(ROLE_FILTERS), "distance_miles": list(DISTANCE_FILTERS),
                    "intents": list(INTENT_CODES)},
    }


# ── P05 Polish, P29 Translation, P30 Transcription (the only AI calls) ───────

def _require_nuri_consent(version: str) -> None:
    if version != NURI_AI_CONSENT_VERSION:
        raise CommunityError("CONSENT_REQUIRED", "AI consent is missing or out of date",
                             extra={"required_version": NURI_AI_CONSENT_VERSION})


async def _complete(call_site: str, uid: str, system: str, text: str) -> str:
    client = runtime.aoai
    if not client:
        raise CommunityError("STORAGE_OR_SERVICE_UNAVAILABLE", "AI is unavailable")
    started = time.perf_counter()
    messages = [{"role": "system", "content": system}, {"role": "user", "content": text}]
    try:
        try:
            resp = await client.chat.completions.create(
                model=AI_MODEL, messages=messages, timeout=AI_TIMEOUT_S,
                **({"reasoning_effort": AI_REASONING_EFFORT} if AI_REASONING_EFFORT else {}),
            )
        except Exception as exc:  # noqa: BLE001
            # A model that takes no reasoning_effort: same call without it.
            if not AI_REASONING_EFFORT or "reasoning" not in str(exc):
                raise
            resp = await client.chat.completions.create(model=AI_MODEL, messages=messages, timeout=AI_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        llm_usage.record(call_site, AI_MODEL, user_id=uid, status="error",
                         duration_ms=runtime.elapsed_ms(started), error=type(exc).__name__)
        raise CommunityError("STORAGE_OR_SERVICE_UNAVAILABLE", "AI request failed") from exc
    llm_usage.record(call_site, AI_MODEL, usage=getattr(resp, "usage", None), user_id=uid,
                     duration_ms=runtime.elapsed_ms(started))
    out = (resp.choices[0].message.content or "").strip() if getattr(resp, "choices", None) else ""
    if not out:
        raise CommunityError("STORAGE_OR_SERVICE_UNAVAILABLE", "AI returned nothing")
    return out


_POLISH_SYSTEM = (
    "You tidy a parent's question to other parents. Keep the meaning, the language "
    "({lang}) and the first person. Fix wording and make it clear and warm. Remove "
    "names, addresses, phone numbers and exact birthdays. Return only the question."
)
_TRANSLATE_SYSTEM = (
    "Translate the parent's chat message into {lang}. Return only the translation."
)


def _ai_dto(row: dict) -> dict:
    return {"id": str(row["id"]), "kind": row["kind"], "state": row.get("state", "succeeded"),
            "text": row.get("output_text") or "", "target_language": row.get("target_language"),
            "created_at": row.get("created_at")}


async def polish_question(uid: str, body: PolishIn) -> dict:
    _require_nuri_consent(body.ai_consent_version)
    text = _clean_text(body.text, field="text", max_len=QUESTION_MAX)
    fp = _fingerprint({"text": text, "language": body.language})
    existing = await _one("community_ai_requests", lambda q: q.eq("user_id", uid)
                          .eq("kind", "polish").eq("client_request_id", body.client_request_id))
    if existing:
        if existing["request_fingerprint"] != fp:
            raise CommunityError("IDEMPOTENCY_CONFLICT", "This request key was already used with different content")
        return {"original": text, "polish": _ai_dto(existing)}
    out = await _complete("community.polish", uid, _POLISH_SYSTEM.format(lang=body.language), text)
    row, _ = await _create_once(
        "community_ai_requests", match={"user_id": uid, "kind": "polish"},
        key_col="client_request_id", key=body.client_request_id, fingerprint=fp,
        row={"user_id": uid, "kind": "polish", "target_language": body.language, "output_text": out},
    )
    # The original is returned untouched next to the draft: the parent picks.
    return {"original": text, "polish": _ai_dto(row)}


async def translate_message(uid: str, message_id: str, body: TranslationIn) -> dict:
    _require_nuri_consent(body.ai_consent_version)
    message = await _one("community_messages", lambda q: q.eq("id", message_id))
    if not message:
        raise _not_found("message")
    conv, _other = await _member_conversation(uid, str(message["conversation_id"]))
    if message["sender_id"] != uid:
        # Someone else's words go to a provider only with both parents' consent.
        state = await _ai_state(conv)
        if not state["purposes"]["translation"]["effective"]:
            raise CommunityError("CONSENT_REQUIRED", "Both parents must allow translation in this conversation")
        effective_from = state["purposes"]["translation"]["effective_from_seq"] or 0
        if int(message["seq"]) <= int(effective_from):
            raise CommunityError("CONSENT_REQUIRED", "This message predates the consent")
    fp = _fingerprint({"message_id": message_id, "target": body.target_language})
    existing = await _one("community_ai_requests", lambda q: q.eq("user_id", uid)
                          .eq("kind", "translation").eq("client_request_id", body.client_request_id))
    if existing:
        if existing["request_fingerprint"] != fp:
            raise CommunityError("IDEMPOTENCY_CONFLICT", "This request key was already used with different content")
        row = existing
    else:
        out = await _complete("community.translate", uid,
                              _TRANSLATE_SYSTEM.format(lang=body.target_language), message.get("body") or "")
        row, _ = await _create_once(
            "community_ai_requests", match={"user_id": uid, "kind": "translation"},
            key_col="client_request_id", key=body.client_request_id, fingerprint=fp,
            row={"user_id": uid, "kind": "translation", "message_id": message_id,
                 "target_language": body.target_language, "output_text": out},
        )
    # A separate object: message.body is never overwritten.
    return {"message_id": message_id, "original": {"text": message.get("body") or "",
                                                     "language": message.get("language")},
            "translation": _ai_dto(row)}


async def transcribe(uid: str, body: TranscriptionIn) -> dict:
    _require_nuri_consent(body.ai_consent_version)
    fp = _fingerprint({"audio": hashlib.sha256(body.audio_base64.encode()).hexdigest(),
                       "locale": body.locale})
    existing = await _one("community_ai_requests", lambda q: q.eq("user_id", uid)
                          .eq("kind", "transcription").eq("client_request_id", body.client_request_id))
    if existing:
        if existing["request_fingerprint"] != fp:
            raise CommunityError("IDEMPOTENCY_CONFLICT", "This request key was already used with different content")
        return {"draft_text": existing.get("output_text") or "", "transcription": _ai_dto(existing)}
    # Reuse the existing /api/chat/transcribe path (limits, provider, logging);
    # imported here because main imports this module.
    from backend import main as _main

    result = await _main.transcribe_audio(
        _main.TranscribeIn(audio_base64=body.audio_base64, locale=body.locale), uid)
    text = (result or {}).get("text", "")
    row, _ = await _create_once(
        "community_ai_requests", match={"user_id": uid, "kind": "transcription"},
        key_col="client_request_id", key=body.client_request_id, fingerprint=fp,
        row={"user_id": uid, "kind": "transcription", "target_language": body.locale, "output_text": text},
    )
    # Draft text only: nothing is sent and the audio is not stored.
    return {"draft_text": text, "transcription": _ai_dto(row)}


# ── P06–P10 Questions ────────────────────────────────────────────────────────

async def _child_age_months(uid: str) -> Optional[int]:
    rows = await _select("children", lambda q: q.eq("user_id", uid))
    today = _now().date()
    ages = []
    for row in rows:
        try:
            born = date.fromisoformat(str(row.get("birth_date"))[:10])
        except ValueError:
            continue
        if born > today:
            continue  # a baby on the way has no age to show
        ages.append((today.year - born.year) * 12 + today.month - born.month - (today.day < born.day))
    # The youngest child: the one a new parent question is most likely about.
    return min(ages) if ages else None


async def _reply_counts(question_ids: list[str]) -> dict[str, int]:
    if not question_ids:
        return {}
    rows = await _select("community_replies", lambda q: q.in_("question_id", question_ids))
    counts: dict[str, int] = {}
    for row in rows:
        counts[str(row["question_id"])] = counts.get(str(row["question_id"]), 0) + 1
    return counts


async def _author_identity(question: dict, profiles: Optional[dict] = None) -> dict:
    if question.get("anonymous"):
        return anonymous_parent()
    profiles = profiles if profiles is not None else await _profiles([question["author_id"]])
    profile = profiles.get(question["author_id"])
    if not profile:
        return anonymous_parent()
    roles = await _roles([question["author_id"]])
    return {**public_parent(profile, roles.get(question["author_id"], "")), "anonymous": False}


async def _question_dto(uid: str, question: dict, *, reply_count: Optional[int] = None,
                        profiles: Optional[dict] = None) -> dict:
    mine = question["author_id"] == uid
    if reply_count is None:
        reply_count = (await _reply_counts([str(question["id"])])).get(str(question["id"]), 0)
    actions = []
    if mine and question["status"] == "open":
        actions = ["close", "delete", "comment_all"]
    elif mine:
        actions = ["delete"]
    return {
        "question_id": str(question["id"]),
        "body": question["body"],
        "original_language": question.get("original_language"),
        "version_source": question.get("version_source"),
        "anonymous": bool(question.get("anonymous")),
        "show_child_age": bool(question.get("show_child_age")),
        "child_age_months": question.get("child_age_months") if question.get("show_child_age") else None,
        "status": question["status"],
        "reply_count": reply_count,
        "author": await _author_identity(question, profiles),
        "is_mine": mine,
        "allowed_actions": actions,
        "version": int(question.get("version") or 1),
        "created_at": question.get("created_at"),
        "updated_at": question.get("updated_at"),
    }


async def _family_features(uids: list[str], profiles: dict[str, dict]) -> dict[str, dict]:
    """What D04 matches on: youngest child's age, region, family concerns."""
    if not uids:
        return {}
    users = {u["id"]: u for u in await _select("users", lambda q: q.in_("id", uids))}
    children = await _select("children", lambda q: q.in_("user_id", uids))
    today = _now().date()
    ages: dict[str, list[int]] = {}
    for child in children:
        try:
            born = date.fromisoformat(str(child.get("birth_date"))[:10])
        except ValueError:
            continue
        if born <= today:
            ages.setdefault(child["user_id"], []).append(
                (today.year - born.year) * 12 + today.month - born.month - (today.day < born.day))
    out = {}
    for uid in uids:
        user, profile = users.get(uid) or {}, profiles.get(uid) or {}
        region = (profile.get("city_label") or user.get("city") or "").strip().lower()
        out[uid] = {"age": min(ages[uid]) if ages.get(uid) else None, "region": region,
                    "concerns": set(user.get("top_concerns") or []),
                    "intents": list(profile.get("intent_codes") or [])}
    return out


def _fit(asker: dict, other: dict) -> float:
    """Rule-based family fit, 0–1: child age, region, shared concerns."""
    age = 0.0
    if asker["age"] is not None and other["age"] is not None:
        age = max(0.0, 1 - abs(asker["age"] - other["age"]) / 24)  # within two years
    region = 1.0 if asker["region"] and asker["region"] == other["region"] else 0.0
    union = asker["concerns"] | other["concerns"]
    concerns = len(asker["concerns"] & other["concerns"]) / len(union) if union else 0.0
    return 0.4 * age + 0.25 * region + 0.35 * concerns


def _age_band(months: Optional[int]) -> str:
    if months is None:
        return "unknown"
    return f"{months} months" if months < 24 else f"{months // 12} years"


async def _ai_rank(question: dict, shortlist: list[str], features: dict[str, dict], asker: dict) -> list[str]:
    """D04 "让ai写": order the shortlist by relevance to the question.

    The model sees the question and, per candidate, only a number, a child age
    band, concern codes, intents and whether the region matches — no names, ids
    or free text about anyone else. Any failure keeps the rule-based order.
    """
    if not AI_MATCHING or len(shortlist) <= 1 or not runtime.aoai:
        return shortlist
    lines = []
    for index, uid in enumerate(shortlist):
        f = features[uid]
        lines.append(f"{index}: child {_age_band(f['age'])}; concerns {','.join(sorted(f['concerns'])) or '-'}; "
                     f"intents {','.join(f['intents']) or '-'}; same region {'yes' if f['region'] and f['region'] == asker['region'] else 'no'}")
    system = ("You match a parent's question to other parents who could answer it from experience. "
              "Rank the candidates by how well their family situation fits the question. "
              "Reply with only the candidate numbers, best first, comma separated.")
    text = f"Question: {question['body']}\nAsker's child: {_age_band(asker['age'])}\nCandidates:\n" + "\n".join(lines)
    try:
        out = await _timed_complete(question["author_id"], system, text)
    except Exception:  # noqa: BLE001 - ranking is an improvement, never a requirement
        return shortlist
    order: list[str] = []
    for token in out.replace("\n", ",").split(","):
        token = token.strip()
        if token.isdigit() and int(token) < len(shortlist) and shortlist[int(token)] not in order:
            order.append(shortlist[int(token)])
    return order + [uid for uid in shortlist if uid not in order]


async def _timed_complete(uid: str, system: str, text: str) -> str:
    with anyio.fail_after(MATCH_TIMEOUT_S):
        return await _complete("community.match", uid, system, text)


async def _deliver(question: dict) -> int:
    """Hand a new question to up to DELIVERY_FANOUT parents (meeting D04).

    Eligible: other parents with a visible community profile and no block in
    either direction. Ranked by family fit — youngest child's age, region and
    shared family concerns — then the AI orders the top MATCH_SHORTLIST by
    relevance to the question (falls back to the rule order on any failure).
    """
    author = question["author_id"]
    i_blocked, blocked_me = await _block_sets(author)
    pool = await _select("community_profiles", lambda q: q.neq("user_id", author)
                         .order("updated_at", desc=True).limit(200))
    ids = [p["user_id"] for p in pool]
    hidden_rows = await _select("community_preferences", lambda q: q.in_("user_id", ids)) if ids else []
    hidden = {row["user_id"] for row in hidden_rows if row.get("profile_hidden")}
    eligible = [i for i in ids if i not in i_blocked and i not in blocked_me and i not in hidden]
    profiles = {p["user_id"]: p for p in pool}
    author_profile = await _profiles([author])
    features = await _family_features(eligible + [author], {**profiles, **author_profile})
    asker = features[author]
    # Ties are broken at random so the same parents are not always first.
    ranked = sorted(eligible, key=lambda uid: (_fit(asker, features[uid]), random.random()), reverse=True)
    shortlist = await _ai_rank(question, ranked[:MATCH_SHORTLIST], features, asker)
    chosen = (shortlist + ranked[MATCH_SHORTLIST:])[:DELIVERY_FANOUT]
    expires = _iso(_now() + timedelta(days=DELIVERY_TTL_DAYS))
    rows = []
    for recipient in chosen:
        try:
            rows.append(await _insert("community_question_deliveries", {
                "question_id": question["id"], "recipient_id": recipient,
                "state": "waiting", "expires_at": expires,
            }))
        except _UniqueViolation:
            continue
    await asyncio.gather(*(
        _notify(row["recipient_id"], "community_question", str(row["id"]),
                {"delivery_id": str(row["id"]), "question_id": str(question["id"])}, actor=author)
        for row in rows))
    return len(rows)


async def create_question(uid: str, body: QuestionIn,
                          schedule: Optional[Callable[..., Any]] = None) -> dict:
    """Publish a question. Delivery (ranking, the AI shortlist, notifications)
    runs after the response when `schedule` is given — it took 5–7 s in prod,
    and the parent should not wait on it to see "sent"."""
    await _require_profile(uid)
    text = _clean_text(body.body, field="body", max_len=QUESTION_MAX)
    if body.version_source == "polished":
        if not body.polish_id:
            raise _invalid("polish_id is required for a polished question")
        polish = await _one("community_ai_requests", lambda q: q.eq("id", body.polish_id)
                            .eq("user_id", uid).eq("kind", "polish"))
        if not polish:
            raise _not_found("polish")
    fp = _fingerprint({"body": text, "lang": body.original_language, "src": body.version_source,
                       "polish": body.polish_id, "anon": body.anonymous, "age": body.show_child_age})
    existing = await _one("community_questions", lambda q: q.eq("author_id", uid)
                          .eq("client_request_id", body.client_request_id))
    if not existing:
        await _rate_limit("community_questions", "author_id", uid, QUESTIONS_PER_DAY)
    row, created = await _create_once(
        "community_questions", match={"author_id": uid}, key_col="client_request_id",
        key=body.client_request_id, fingerprint=fp,
        row={
            "author_id": uid, "body": text, "original_language": body.original_language,
            "version_source": body.version_source, "polish_id": body.polish_id,
            "anonymous": body.anonymous, "show_child_age": body.show_child_age,
            "child_age_months": await _child_age_months(uid) if body.show_child_age else None,
            "status": "open", "updated_at": _iso(),
        },
    )
    deliveries = [] if created else await _select("community_question_deliveries",
                                                  lambda q: q.eq("question_id", row["id"]))
    # A retry of a question whose background delivery never landed delivers it
    # now; deliveries are unique per (question, recipient), so this is safe.
    pending_delivery = created or not deliveries
    if pending_delivery and schedule is not None:
        schedule(_deliver, row)
        delivery = {"recipient_count": None, "state": "delivering"}
    else:
        if pending_delivery:
            await _deliver(row)
            deliveries = await _select("community_question_deliveries", lambda q: q.eq("question_id", row["id"]))
        delivery = {"recipient_count": len(deliveries), "state": "delivered" if deliveries else "no_recipients"}
    return {
        "question": await _question_dto(uid, row),
        "delivery": delivery,
        # Publishing is synchronous; the operation is already terminal.
        "operation": {"operation_id": f"question:{row['id']}", "state": "succeeded"},
        "created": created,
    }


async def get_operation(uid: str, operation_id: str) -> dict:
    kind, _, resource_id = operation_id.partition(":")
    if kind != "question" or not resource_id:
        raise _not_found("operation")
    question = await _one("community_questions", lambda q: q.eq("id", resource_id).eq("author_id", uid))
    if not question:
        raise _not_found("operation")
    return {"operation_id": operation_id, "state": "succeeded",
            "resource": {"kind": "question", "id": str(question["id"])},
            "retryable": False}


async def my_questions(uid: str, status_filter: str = "all", q: Optional[str] = None,
                       cursor: Optional[str] = None, page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    if status_filter not in ("all", "open", "closed"):
        raise _invalid("status must be all, open or closed")
    search = (q or "").strip()

    def build(query):
        query = query.eq("author_id", uid)
        query = query.neq("status", "deleted") if status_filter == "all" else query.eq("status", status_filter)
        if search:
            query = query.ilike("body", f"%{search}%")
        return query

    rows, next_cursor, has_more = await _seq_page("community_questions", build, cursor, size)
    counts = await _reply_counts([str(r["id"]) for r in rows])
    profiles = await _profiles([uid])
    return {"items": [await _question_dto(uid, r, reply_count=counts.get(str(r["id"]), 0), profiles=profiles)
                      for r in rows],
            "next_cursor": next_cursor, "has_more": has_more}


async def _visible_question(uid: str, question_id: str) -> tuple[dict, Optional[dict]]:
    """(question, my delivery) for its author or one of its recipients."""
    try:
        uuid.UUID(str(question_id))
    except ValueError:
        raise _not_found("question")
    question = await _one("community_questions", lambda q: q.eq("id", question_id))
    if not question or question["status"] == "deleted":
        raise _not_found("question")
    if question["author_id"] == uid:
        return question, None
    delivery = await _one("community_question_deliveries",
                          lambda q: q.eq("question_id", question_id).eq("recipient_id", uid))
    if not delivery:
        raise _not_found("question")
    return question, delivery


async def get_question(uid: str, question_id: str) -> dict:
    question, delivery = await _visible_question(uid, question_id)
    dto = await _question_dto(uid, question)
    if delivery:
        delivery = await _expire_if_due(delivery)
        dto["delivery"] = _delivery_meta(delivery)
    return {"question": dto}


async def _lock_deliveries(question_id: str, reason: str) -> None:
    await _update("community_question_deliveries",
                  {"state": "locked", "lock_reason": reason, "updated_at": _iso()},
                  lambda q: q.eq("question_id", question_id).eq("state", "waiting"))


async def transition_questions(uid: str, body: TransitionIn) -> dict:
    if not body.confirmed:
        raise _invalid("confirmed must be true: closing or deleting needs an explicit confirmation")
    results = []
    # Per item, not all-or-nothing: each result says what really happened.
    for item in body.items:
        try:
            question = await _one("community_questions",
                                  lambda q, i=item: q.eq("id", i.question_id).eq("author_id", uid))
            if not question or question["status"] == "deleted":
                raise _not_found("question")
            _check_version(question, item.expected_version)
            target = "closed" if body.action == "close" else "deleted"
            if question["status"] != target:
                patch = {"status": target, "updated_at": _iso()}
                patch["closed_at" if target == "closed" else "deleted_at"] = _iso()
                question = await _versioned_update("community_questions", question, patch)
                await _lock_deliveries(str(question["id"]),
                                       "question_closed" if target == "closed" else "question_deleted")
            results.append({"question_id": item.question_id, "ok": True,
                            "status": question["status"], "version": int(question["version"])})
        except CommunityError as exc:
            results.append({"question_id": item.question_id, "ok": False,
                            "error": {"code": exc.error_code, "message": exc.detail, **exc.extra}})
    return {"action": body.action, "results": results,
            "all_succeeded": all(r["ok"] for r in results)}


# ── P11–P14 Deliveries, responses, replies, comments ─────────────────────────

def _delivery_meta(d: dict) -> dict:
    return {"delivery_id": str(d["id"]), "state": d["state"], "lock_reason": d.get("lock_reason"),
            "expires_at": d.get("expires_at"), "version": int(d.get("version") or 1)}


async def _expire_if_due(delivery: dict) -> dict:
    expires = _parse_ts(delivery.get("expires_at"))
    if delivery["state"] == "waiting" and expires and expires <= _now():
        updated = await _update("community_question_deliveries",
                                {"state": "locked", "lock_reason": "expired", "updated_at": _iso(),
                                 "version": int(delivery.get("version") or 1) + 1},
                                lambda q: q.eq("id", delivery["id"]).eq("state", "waiting"))
        if updated:
            return updated[0]
        return await _one("community_question_deliveries", lambda q: q.eq("id", delivery["id"])) or delivery
    return delivery


async def my_deliveries(uid: str, tab: str = "waiting", cursor: Optional[str] = None,
                        page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    if tab not in ("waiting", "replied", "locked"):
        raise _invalid("tab must be waiting, replied or locked")
    # Bring due expiries into the locked tab before reading either tab.
    await _update("community_question_deliveries",
                  {"state": "locked", "lock_reason": "expired", "updated_at": _iso()},
                  lambda q: q.eq("recipient_id", uid).eq("state", "waiting").lte("expires_at", _iso()))
    rows, next_cursor, has_more = await _seq_page(
        "community_question_deliveries", lambda q: q.eq("recipient_id", uid).eq("state", tab), cursor, size)
    qids = [str(r["question_id"]) for r in rows]
    questions = {str(q["id"]): q for q in
                 (await _select("community_questions", lambda q: q.in_("id", qids)) if qids else [])}
    replies = {str(r["delivery_id"]): r for r in
               (await _select("community_replies", lambda q: q.in_("delivery_id", [str(r["id"]) for r in rows]))
                if rows else [])}
    counts = await _reply_counts(qids)
    profiles = await _profiles([q["author_id"] for q in questions.values()])
    items = []
    for d in rows:
        question = questions.get(str(d["question_id"]))
        if not question or question["status"] == "deleted":
            continue
        reply = replies.get(str(d["id"]))
        items.append({
            **_delivery_meta(d),
            "question": await _question_dto(uid, question, reply_count=counts.get(str(question["id"]), 0),
                                            profiles=profiles),
            "my_reply": _reply_core(reply) if reply else None,
        })
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more}


def _reply_core(reply: dict) -> dict:
    return {"reply_id": str(reply["id"]), "thread_id": str(reply["id"]), "body": reply["body"],
            "language": reply.get("language"), "anonymous": bool(reply.get("anonymous")),
            "created_at": reply.get("created_at")}


async def respond(uid: str, delivery_id: str, body: ResponseIn) -> dict:
    await _require_profile(uid)
    delivery = await _one("community_question_deliveries",
                          lambda q: q.eq("id", delivery_id).eq("recipient_id", uid))
    if not delivery:
        raise _not_found("delivery")
    text = _clean_text(body.body, field="body", max_len=REPLY_MAX)
    fp = _fingerprint({"delivery": delivery_id, "body": text, "lang": body.language, "anon": body.anonymous})
    existing = await _one("community_replies", lambda q: q.eq("author_id", uid)
                          .eq("client_request_id", body.client_request_id))
    if existing:
        # A resend of a reply that already landed: same answer, not a second one.
        if existing["request_fingerprint"] != fp:
            raise CommunityError("IDEMPOTENCY_CONFLICT", "This request key was already used with different content")
        delivery = await _one("community_question_deliveries", lambda q: q.eq("id", delivery_id)) or delivery
        return {"reply": _reply_core(existing), "delivery": _delivery_meta(delivery), "created": False}
    delivery = await _expire_if_due(delivery)
    if delivery["state"] == "replied":
        raise CommunityError("DELIVERY_LOCKED", "This question was already answered",
                             extra={"lock_reason": "already_replied"})
    if delivery["state"] == "locked":
        reason = delivery.get("lock_reason")
        code = "QUESTION_CLOSED" if reason == "question_closed" else "DELIVERY_LOCKED"
        raise CommunityError(code, "This question can no longer be answered", extra={"lock_reason": reason})
    _check_version(delivery, body.expected_version)
    question = await _one("community_questions", lambda q: q.eq("id", delivery["question_id"]))
    if not question or question["status"] != "open":
        raise CommunityError("QUESTION_CLOSED", "This question was closed")
    try:
        reply, created = await _create_once(
            "community_replies", match={"author_id": uid}, key_col="client_request_id",
            key=body.client_request_id, fingerprint=fp,
            row={"question_id": question["id"], "delivery_id": delivery_id, "author_id": uid,
                 "body": text, "language": body.language, "anonymous": body.anonymous},
        )
    except _UniqueViolation:
        # delivery_id is unique: another device answered first.
        raise CommunityError("DELIVERY_LOCKED", "This question was already answered",
                             extra={"lock_reason": "already_replied"})
    delivery = await _versioned_update("community_question_deliveries", delivery,
                                       {"state": "replied", "updated_at": _iso()})
    if created:
        await _notify(question["author_id"], "community_reply", str(reply["id"]),
                      {"question_id": str(question["id"]), "thread_id": str(reply["id"])}, actor=uid)
    return {"reply": _reply_core(reply), "delivery": _delivery_meta(delivery), "created": created}


async def _reply_identity(reply: dict, profiles: dict, roles: dict) -> dict:
    if reply.get("anonymous"):
        return anonymous_parent()
    profile = profiles.get(reply["author_id"])
    if not profile:
        return anonymous_parent()
    return {**public_parent(profile, roles.get(reply["author_id"], "")), "anonymous": False}


async def list_replies(uid: str, question_id: str, cursor: Optional[str] = None,
                       page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    question, delivery = await _visible_question(uid, question_id)
    mine = question["author_id"] == uid

    def build(q):
        q = q.eq("question_id", question_id)
        # The asker reads every experience; a responder reads only their own.
        return q if mine else q.eq("author_id", uid)

    rows, next_cursor, has_more = await _seq_page("community_replies", build, cursor, size)
    authors = [r["author_id"] for r in rows]
    profiles, roles = await _profiles(authors), await _roles(authors)
    comments = await _select("community_comments", lambda q: q.eq("question_id", question_id))
    by_thread: dict[str, int] = {}
    for c in comments:
        key = str(c["reply_id"]) if c.get("reply_id") else "all"
        by_thread[key] = by_thread.get(key, 0) + 1
    items = []
    for r in rows:
        items.append({**_reply_core(r), "author": await _reply_identity(r, profiles, roles),
                      "is_mine": r["author_id"] == uid, "comment_count": by_thread.get(str(r["id"]), 0),
                      "allowed_actions": ["comment"] if question["status"] == "open" else []})
    can_read_all = mine or (delivery and delivery["state"] == "replied")
    return {
        "question": await _question_dto(uid, question),
        "all_thread": {"thread_id": "all", "comment_count": by_thread.get("all", 0),
                       "can_post": mine and question["status"] == "open"} if can_read_all else None,
        "items": items, "next_cursor": next_cursor, "has_more": has_more,
    }


async def _thread_access(uid: str, question: dict, thread_id: str) -> tuple[Optional[dict], bool, list[str]]:
    """(reply or None for 'all', may_post, other participants to notify)."""
    asker = question["author_id"]
    if thread_id == "all":
        responders = [r["author_id"] for r in
                      await _select("community_replies", lambda q: q.eq("question_id", question["id"]))]
        if uid != asker and uid not in responders:
            raise _not_found("thread")
        return None, uid == asker, [r for r in responders if r != uid] if uid == asker else []
    try:
        uuid.UUID(thread_id)
    except ValueError:
        raise _not_found("thread")
    reply = await _one("community_replies", lambda q: q.eq("id", thread_id).eq("question_id", question["id"]))
    if not reply or uid not in (asker, reply["author_id"]):
        raise _not_found("thread")
    other = reply["author_id"] if uid == asker else asker
    return reply, True, [other] if other != uid else []


async def _comment_identity(comment: dict, question: dict, replies: dict, profiles: dict, roles: dict) -> dict:
    author = comment["author_id"]
    if author == question["author_id"]:
        anonymous = bool(question.get("anonymous"))
    else:
        own = next((r for r in replies.values() if r["author_id"] == author), None)
        anonymous = bool(own and own.get("anonymous"))
    if anonymous or author not in profiles:
        return anonymous_parent()
    return {**public_parent(profiles[author], roles.get(author, "")), "anonymous": False}


async def list_comments(uid: str, question_id: str, thread_id: str, cursor: Optional[str] = None,
                        page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    question, _ = await _visible_question(uid, question_id)
    reply, may_post, _ = await _thread_access(uid, question, thread_id)

    def build(q):
        q = q.eq("question_id", question_id)
        return q.is_("reply_id", "null") if reply is None else q.eq("reply_id", reply["id"])

    rows, next_cursor, has_more = await _seq_page("community_comments", build, cursor, size)
    replies = {str(r["id"]): r for r in
               await _select("community_replies", lambda q: q.eq("question_id", question_id))}
    authors = [r["author_id"] for r in rows]
    profiles, roles = await _profiles(authors), await _roles(authors)
    return {
        "thread_id": thread_id,
        "can_post": may_post and question["status"] == "open",
        "items": [{"comment_id": str(c["id"]), "body": c["body"], "language": c.get("language"),
                   "seq": int(c["seq"]), "created_at": c.get("created_at"), "is_mine": c["author_id"] == uid,
                   "author": await _comment_identity(c, question, replies, profiles, roles)} for c in rows],
        "next_cursor": next_cursor, "has_more": has_more,
    }


async def post_comment(uid: str, question_id: str, thread_id: str, body: CommentIn) -> dict:
    question, _ = await _visible_question(uid, question_id)
    reply, may_post, others = await _thread_access(uid, question, thread_id)
    text = _clean_text(body.body, field="body", max_len=COMMENT_MAX)
    fp = _fingerprint({"q": question_id, "t": thread_id, "body": text, "lang": body.language})
    existing = await _one("community_comments", lambda q: q.eq("author_id", uid)
                          .eq("client_message_id", body.client_message_id))
    if not existing:
        if question["status"] != "open":
            raise CommunityError("QUESTION_CLOSED", "This question was closed")
        if not may_post:
            raise CommunityError("RELATIONSHIP_NOT_ALLOWED", "Only the asker can reply to everyone")
        for other in others if reply is not None else []:
            i_blocked, they_blocked = await _blocked_between(uid, other)
            if i_blocked or they_blocked:
                raise CommunityError("BLOCKED_OR_DISCONNECTED", "This thread is no longer available")
    comment, created = await _create_once(
        "community_comments", match={"author_id": uid}, key_col="client_message_id",
        key=body.client_message_id, fingerprint=fp,
        row={"question_id": question_id, "reply_id": reply["id"] if reply else None,
             "author_id": uid, "body": text, "language": body.language},
    )
    if created:
        for other in others:
            await _notify(other, "community_reply", f"comment-{comment['id']}",
                          {"question_id": question_id, "thread_id": thread_id}, actor=uid)
    replies = {str(r["id"]): r for r in
               await _select("community_replies", lambda q: q.eq("question_id", question_id))}
    profiles, roles = await _profiles([uid]), await _roles([uid])
    return {"comment": {"comment_id": str(comment["id"]), "body": comment["body"],
                        "language": comment.get("language"), "seq": int(comment["seq"]),
                        "created_at": comment.get("created_at"), "is_mine": True,
                        "author": await _comment_identity(comment, question, replies, profiles, roles)},
            "created": created}


# ── P15–P19 Invitations, contacts, disconnect, blocks ────────────────────────

async def _active_relationships(uid: str) -> list[dict]:
    low = await _select("community_relationships", lambda q: q.eq("user_low", uid).eq("state", "active"))
    high = await _select("community_relationships", lambda q: q.eq("user_high", uid).eq("state", "active"))
    return [{**r, "other": r["user_high"] if r["user_low"] == uid else r["user_low"]} for r in low + high]


async def _invitation_dto(uid: str, inv: dict) -> dict:
    other = inv["recipient_id"] if inv["sender_id"] == uid else inv["sender_id"]
    profiles, roles = await _profiles([other]), await _roles([other])
    profile = profiles.get(other)
    return {"invitation_id": str(inv["id"]),
            "direction": "sent" if inv["sender_id"] == uid else "received",
            "state": inv["state"], "version": int(inv.get("version") or 1),
            "parent": public_parent(profile, roles.get(other, "")) if profile else None,
            "created_at": inv.get("created_at"), "decided_at": inv.get("decided_at")}


async def list_invitations(uid: str, direction: str = "received", state: str = "pending",
                           cursor: Optional[str] = None, page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    if direction not in ("received", "sent"):
        raise _invalid("direction must be received or sent")
    if state not in ("pending", "accepted", "declined", "cancelled", "all"):
        raise _invalid("unknown invitation state")
    col = "recipient_id" if direction == "received" else "sender_id"

    def build(q):
        q = q.eq(col, uid)
        return q if state == "all" else q.eq("state", state)

    rows, next_cursor, has_more = await _seq_page("community_invitations", build, cursor, size)
    return {"items": [await _invitation_dto(uid, r) for r in rows],
            "next_cursor": next_cursor, "has_more": has_more}


async def _activate_relationship(a: str, b: str) -> dict:
    low, high = _pair(a, b)
    rel = await _relationship(a, b)
    if rel and rel["state"] == "active":
        return rel
    if rel:
        return await _versioned_update("community_relationships", rel,
                                       {"state": "active", "disconnected_by": None, "updated_at": _iso()})
    try:
        return await _insert("community_relationships",
                             {"user_low": low, "user_high": high, "state": "active", "updated_at": _iso()})
    except _UniqueViolation:
        return await _activate_relationship(a, b)


async def send_invitation(uid: str, body: InvitationIn) -> dict:
    await _require_profile(uid)
    target, _profile_row = await _visible_target(uid, body.target_parent_id)
    i_blocked, _ = await _blocked_between(uid, target)
    if i_blocked:
        raise CommunityError("BLOCKED_OR_DISCONNECTED", "Unblock this parent first")
    fp = _fingerprint({"target": body.target_parent_id})
    existing = await _one("community_invitations", lambda q: q.eq("sender_id", uid)
                          .eq("client_request_id", body.client_request_id))
    if existing:
        if existing["request_fingerprint"] != fp:
            raise CommunityError("IDEMPOTENCY_CONFLICT", "This request key was already used with different content")
        return {"invitation": await _invitation_dto(uid, existing),
                "relationship": await _relation_view(uid, target), "created": False}
    rel = await _relationship(uid, target)
    if rel and rel["state"] == "active":
        return {"invitation": None, "relationship": await _relation_view(uid, target), "created": False}
    # Crossing invitations merge: inviting someone who already invited you
    # accepts theirs (handoff D09), so there is never a double pending pair.
    theirs = await _one("community_invitations", lambda q: q.eq("sender_id", target)
                        .eq("recipient_id", uid).eq("state", "pending"))
    if theirs:
        await _activate_relationship(uid, target)
        accepted = await _versioned_update("community_invitations", theirs,
                                           {"state": "accepted", "decided_at": _iso()})
        await _notify(target, "community_invitation", f"accepted-{accepted['id']}",
                      {"invitation_id": str(accepted["id"])}, actor=uid)
        return {"invitation": await _invitation_dto(uid, accepted),
                "relationship": await _relation_view(uid, target), "created": False}
    mine = await _one("community_invitations", lambda q: q.eq("sender_id", uid)
                      .eq("recipient_id", target).eq("state", "pending"))
    if mine:
        return {"invitation": await _invitation_dto(uid, mine),
                "relationship": await _relation_view(uid, target), "created": False}
    await _rate_limit("community_invitations", "sender_id", uid, INVITATIONS_PER_DAY)
    try:
        inv, created = await _create_once(
            "community_invitations", match={"sender_id": uid}, key_col="client_request_id",
            key=body.client_request_id, fingerprint=fp,
            row={"sender_id": uid, "recipient_id": target, "state": "pending"},
        )
    except _UniqueViolation:
        # The one-pending-per-pair index: another device sent it first.
        inv = await _one("community_invitations", lambda q: q.eq("sender_id", uid)
                         .eq("recipient_id", target).eq("state", "pending"))
        if not inv:
            raise
        created = False
    if created:
        await _notify(target, "community_invitation", str(inv["id"]),
                      {"invitation_id": str(inv["id"])}, actor=uid)
    # Pending only: sending never makes two parents contacts by itself.
    return {"invitation": await _invitation_dto(uid, inv),
            "relationship": await _relation_view(uid, target), "created": created}


async def decide_invitation(uid: str, invitation_id: str, body: InvitationDecisionIn) -> dict:
    inv = await _one("community_invitations", lambda q: q.eq("id", invitation_id).eq("recipient_id", uid))
    if not inv:
        raise _not_found("invitation")
    target_state = "accepted" if body.decision == "accept" else "declined"
    if inv["state"] == target_state:
        return {"invitation": await _invitation_dto(uid, inv),
                "relationship": await _relation_view(uid, inv["sender_id"])}
    if inv["state"] != "pending":
        raise CommunityError("VERSION_CONFLICT", "This invitation was already handled",
                             extra={"state": inv["state"]})
    _check_version(inv, body.expected_version)
    if body.decision == "accept":
        i_blocked, they_blocked = await _blocked_between(uid, inv["sender_id"])
        if i_blocked or they_blocked:
            raise CommunityError("BLOCKED_OR_DISCONNECTED", "This invitation is no longer available")
        # Relationship first: if the invitation update then fails, a retry
        # finds the relationship already active and converges.
        await _activate_relationship(uid, inv["sender_id"])
    inv = await _versioned_update("community_invitations", inv, {"state": target_state, "decided_at": _iso()})
    if body.decision == "accept":
        await _notify(inv["sender_id"], "community_invitation", f"accepted-{inv['id']}",
                      {"invitation_id": str(inv["id"])}, actor=uid)
    return {"invitation": await _invitation_dto(uid, inv),
            "relationship": await _relation_view(uid, inv["sender_id"])}


async def list_contacts(uid: str, q: Optional[str] = None, cursor: Optional[str] = None,
                        page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    before = _decode_cursor(cursor)
    search = (q or "").strip().lower()

    def build(col):
        def inner(query):
            query = query.eq(col, uid).eq("state", "active")
            if before is not None:
                query = query.lt("seq", before)
            return query.order("seq", desc=True).limit(200 if search else size + 1)
        return inner

    rows = (await _select("community_relationships", build("user_low"))
            + await _select("community_relationships", build("user_high")))
    rows.sort(key=lambda r: int(r["seq"]), reverse=True)
    others = [r["user_high"] if r["user_low"] == uid else r["user_low"] for r in rows]
    profiles, roles = await _profiles(others), await _roles(others)
    items = []
    for rel, other in zip(rows, others):
        profile = profiles.get(other)
        if not profile:
            continue
        if search and search not in (profile.get("display_name") or "").lower():
            continue
        conv = await _conversation_between(uid, other)
        items.append({"relationship_id": str(rel["id"]), "seq": int(rel["seq"]), "state": rel["state"],
                      "version": int(rel.get("version") or 1),
                      "parent": public_parent(profile, roles.get(other, "")),
                      "conversation_id": str(conv["id"]) if conv else None,
                      "allowed_actions": ["message", "disconnect", "block"]})
    page, next_cursor, has_more = _page(items, size)
    for item in page:
        item.pop("seq", None)
    return {"items": page, "next_cursor": next_cursor, "has_more": has_more}


async def _revoke_ai(conv: Optional[dict], *, purpose: Optional[str] = None) -> Optional[dict]:
    """Bump the conversation epoch and end every open consent in the old one."""
    if not conv:
        return None
    epoch = int(conv.get("ai_epoch") or 0)
    updated = await _update("community_conversations", {"ai_epoch": epoch + 1},
                            lambda q: q.eq("id", conv["id"]).eq("ai_epoch", epoch))
    open_requests = await _select("community_ai_consent_requests", lambda q: q.eq("conversation_id", conv["id"]))
    for req in open_requests:
        if req["state"] in ("pending", "effective"):
            new_state = "revoked" if (purpose is None or req["purpose"] == purpose) else "superseded"
            await _update("community_ai_consent_requests",
                          {"state": new_state, "revoked_at": _iso(),
                           "version": int(req.get("version") or 1) + 1},
                          lambda q, r=req: q.eq("id", r["id"]))
    return updated[0] if updated else await _one("community_conversations", lambda q: q.eq("id", conv["id"]))


async def disconnect(uid: str, relationship_id: str, expected_version: Optional[int] = None,
                     confirmed: bool = False) -> dict:
    if not confirmed:
        raise _invalid("confirmed must be true to disconnect")
    rel = await _one("community_relationships", lambda q: q.eq("id", relationship_id))
    if not rel or uid not in (rel["user_low"], rel["user_high"]):
        raise _not_found("relationship")
    other = rel["user_high"] if rel["user_low"] == uid else rel["user_low"]
    if rel["state"] == "active":
        _check_version(rel, expected_version)
        rel = await _versioned_update("community_relationships", rel,
                                      {"state": "disconnected", "disconnected_by": uid, "updated_at": _iso()})
        # History stays; AI participation stops now.
        await _revoke_ai(await _conversation_between(uid, other))
    return {"relationship_id": str(rel["id"]), "state": rel["state"], "version": int(rel["version"]),
            "ai_effective": False}


async def list_blocks(uid: str, cursor: Optional[str] = None, page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    rows, next_cursor, has_more = await _seq_page("community_blocks", lambda q: q.eq("blocker_id", uid),
                                                  cursor, size)
    others = [r["blocked_id"] for r in rows]
    profiles, roles = await _profiles(others), await _roles(others)
    return {"items": [{"parent": public_parent(profiles[o], roles.get(o, "")), "blocked_at": r.get("created_at")}
                      for r, o in zip(rows, others) if o in profiles],
            "next_cursor": next_cursor, "has_more": has_more}


async def block(uid: str, parent_id: str, body: BlockIn) -> dict:
    if not body.confirmed:
        raise _invalid("confirmed must be true to block")
    profile = await _profile_by_public(parent_id)
    if not profile or profile["user_id"] == uid:
        raise _not_found("parent")
    target = profile["user_id"]
    existing = await _one("community_blocks", lambda q: q.eq("blocker_id", uid).eq("blocked_id", target))
    if not existing:
        try:
            await _insert("community_blocks", {"blocker_id": uid, "blocked_id": target})
        except _UniqueViolation:
            pass
    # Everything that lets the two reach each other ends with the block.
    rel = await _relationship(uid, target)
    if rel and rel["state"] == "active":
        await _versioned_update("community_relationships", rel,
                                {"state": "disconnected", "disconnected_by": uid, "updated_at": _iso()})
    for inv in await _pending_between(uid, target):
        await _update("community_invitations", {"state": "cancelled", "decided_at": _iso(),
                                                "version": int(inv.get("version") or 1) + 1},
                      lambda q, i=inv: q.eq("id", i["id"]).eq("state", "pending"))
    for author, recipient in ((uid, target), (target, uid)):
        qids = [str(q["id"]) for q in await _select("community_questions", lambda q, a=author: q.eq("author_id", a))]
        if qids:
            await _update("community_question_deliveries",
                          {"state": "locked", "lock_reason": "unavailable", "updated_at": _iso()},
                          lambda q, r=recipient, ids=qids: q.in_("question_id", ids)
                          .eq("recipient_id", r).eq("state", "waiting"))
    await _revoke_ai(await _conversation_between(uid, target))
    roles = await _roles([target])
    return {"blocked": True, "parent": public_parent(profile, roles.get(target, "")),
            "relationship": await _relation_view(uid, target)}


async def unblock(uid: str, parent_id: str, confirmed: bool = False) -> dict:
    if not confirmed:
        raise _invalid("confirmed must be true to unblock")
    profile = await _profile_by_public(parent_id)
    if not profile:
        raise _not_found("parent")
    target = profile["user_id"]
    await _delete("community_blocks", lambda q: q.eq("blocker_id", uid).eq("blocked_id", target))
    # Unblocking restores nothing: no contact, no AI, no invitations.
    return {"blocked": False, "relationship": await _relation_view(uid, target)}


# ── P20–P23 Inbox, conversations, messages, read cursor ──────────────────────

async def _member_conversation(uid: str, conversation_id: str) -> tuple[dict, str]:
    try:
        uuid.UUID(str(conversation_id))
    except ValueError:
        raise _not_found("conversation")
    conv = await _one("community_conversations", lambda q: q.eq("id", conversation_id))
    if not conv or uid not in (conv["user_low"], conv["user_high"]):
        raise _not_found("conversation")
    return conv, conv["user_high"] if conv["user_low"] == uid else conv["user_low"]


async def _may_message(uid: str, other: str) -> None:
    i_blocked, they_blocked = await _blocked_between(uid, other)
    rel = await _relationship(uid, other)
    if i_blocked or they_blocked or (rel and rel["state"] != "active"):
        # A block always also disconnects, so "they blocked me" reads exactly
        # like "we are disconnected": the block itself is never disclosed.
        raise CommunityError("BLOCKED_OR_DISCONNECTED", "You can no longer message this parent")
    if not rel:
        raise CommunityError("RELATIONSHIP_NOT_ALLOWED", "Connect with this parent first")


async def _unread(conv: dict, uid: str) -> int:
    cursor = await _one("community_read_cursors", lambda q: q.eq("conversation_id", conv["id"]).eq("user_id", uid))
    last = int((cursor or {}).get("last_read_seq") or 0)
    rows = await _select("community_messages", lambda q: q.eq("conversation_id", conv["id"])
                         .gt("seq", last).neq("sender_id", uid).limit(100))
    return len(rows)


async def _conversation_dto(uid: str, conv: dict) -> dict:
    other = conv["user_high"] if conv["user_low"] == uid else conv["user_low"]
    profiles, roles = await _profiles([other]), await _roles([other])
    rel = await _relationship(uid, other)
    blocked = any(await _blocked_between(uid, other))
    can_send = bool(rel and rel["state"] == "active" and not blocked)
    ai = await _ai_state(conv)
    return {
        "conversation_id": str(conv["id"]),
        "parent": public_parent(profiles[other], roles.get(other, "")) if other in profiles else None,
        "relationship_state": "blocked_or_disconnected" if not can_send and rel else (rel or {}).get("state", "none"),
        "allowed_actions": ["send_message", "request_ai", "mark_read"] if can_send else ["mark_read"],
        "ai": {"effective": ai["effective"], "epoch": ai["epoch"]},
        "last_message_seq": conv.get("last_message_seq"),
        "last_message_at": conv.get("last_message_at"),
    }


async def start_conversation(uid: str, body: ConversationIn) -> dict:
    if bool(body.target_parent_id) == bool(body.relationship_id):
        raise _invalid("Give exactly one of target_parent_id or relationship_id")
    if body.relationship_id:
        rel = await _one("community_relationships", lambda q: q.eq("id", body.relationship_id))
        if not rel or uid not in (rel["user_low"], rel["user_high"]):
            raise _not_found("relationship")
        other = rel["user_high"] if rel["user_low"] == uid else rel["user_low"]
    else:
        other, _ = await _visible_target(uid, body.target_parent_id)
    await _may_message(uid, other)
    conv = await _conversation_between(uid, other)
    if not conv:
        low, high = _pair(uid, other)
        try:
            conv = await _insert("community_conversations", {"user_low": low, "user_high": high, "ai_epoch": 0})
        except _UniqueViolation:
            conv = await _conversation_between(uid, other)
    # AI is off until both parents agree; opening a chat never turns it on.
    return {"conversation": await _conversation_dto(uid, conv)}


def _message_dto(uid: str, m: dict) -> dict:
    return {"message_id": str(m["id"]), "conversation_id": str(m["conversation_id"]),
            "seq": int(m["seq"]), "sender": "me" if m["sender_id"] == uid else "parent",
            "text": m.get("body") or "", "media": [{"media_id": str(i)} for i in (m.get("media_ids") or [])],
            "language": m.get("language"), "created_at": m.get("created_at"), "state": "saved",
            "client_message_id": m.get("client_message_id") if m["sender_id"] == uid else None}


async def list_messages(uid: str, conversation_id: str, cursor: Optional[str] = None,
                        page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    conv, _ = await _member_conversation(uid, conversation_id)
    rows, next_cursor, has_more = await _seq_page(
        "community_messages", lambda q: q.eq("conversation_id", conversation_id), cursor, size)
    # Newest page first; within the page oldest → newest, like the NURI chat.
    return {"conversation": await _conversation_dto(uid, conv),
            "items": [_message_dto(uid, m) for m in reversed(rows)],
            "next_cursor": next_cursor, "has_more": has_more}


async def send_message(uid: str, conversation_id: str, body: MessageIn) -> dict:
    conv, other = await _member_conversation(uid, conversation_id)
    text = _clean_text(body.text, field="text", max_len=MESSAGE_MAX, required=not body.media_ids)
    if len(set(body.media_ids)) != len(body.media_ids):
        raise _invalid("media_ids must not repeat")
    fp = _fingerprint({"c": conversation_id, "text": text, "media": body.media_ids, "lang": body.language})
    existing = await _one("community_messages", lambda q: q.eq("sender_id", uid)
                          .eq("client_message_id", body.client_message_id))
    if existing:
        if existing["request_fingerprint"] != fp:
            raise CommunityError("IDEMPOTENCY_CONFLICT", "This request key was already used with different content")
        return {"message": _message_dto(uid, existing), "created": False}
    await _may_message(uid, other)
    media_rows = []
    for media_id in body.media_ids:
        row = await _own_media(uid, media_id)
        if row["purpose"] != "message" or row["state"] != "ready":
            raise CommunityError("MEDIA_NOT_READY_OR_NOT_OWNED", "An attachment is not ready",
                                 extra={"media_id": media_id})
        media_rows.append(row)
    message, created = await _create_once(
        "community_messages", match={"sender_id": uid}, key_col="client_message_id",
        key=body.client_message_id, fingerprint=fp,
        row={"conversation_id": conversation_id, "sender_id": uid, "body": text,
             "media_ids": body.media_ids, "language": body.language},
    )
    if created:
        for row in media_rows:
            await _update("community_media", {"state": "committed", "bound_to": f"message:{message['id']}",
                                              "updated_at": _iso()},
                          lambda q, r=row: q.eq("id", r["id"]).eq("state", "ready"))
        seq = int(message["seq"])
        moved = await _update("community_conversations",
                              {"last_message_seq": seq, "last_message_at": message.get("created_at") or _iso()},
                              lambda q: q.eq("id", conversation_id).lt("last_message_seq", seq))
        if not moved:
            await _update("community_conversations",
                          {"last_message_seq": seq, "last_message_at": message.get("created_at") or _iso()},
                          lambda q: q.eq("id", conversation_id).is_("last_message_seq", "null"))
        # The sender has read their own message.
        await _advance_cursor(conversation_id, uid, seq)
        await _notify(other, "community_conversation", str(message["id"]),
                      {"conversation_id": conversation_id, "message_seq": seq}, actor=uid)
    # Saved is not delivered and not read: the state says only "saved".
    return {"message": _message_dto(uid, message), "created": created}


async def _advance_cursor(conversation_id: str, uid: str, seq: int) -> int:
    current = await _one("community_read_cursors",
                         lambda q: q.eq("conversation_id", conversation_id).eq("user_id", uid))
    if current is None:
        try:
            await _insert("community_read_cursors", {"conversation_id": conversation_id, "user_id": uid,
                                                     "last_read_seq": seq, "updated_at": _iso()})
            return seq
        except _UniqueViolation:
            current = await _one("community_read_cursors",
                                 lambda q: q.eq("conversation_id", conversation_id).eq("user_id", uid))
    if int(current["last_read_seq"]) >= seq:
        return int(current["last_read_seq"])  # monotonic: never moves back
    await _update("community_read_cursors", {"last_read_seq": seq, "updated_at": _iso()},
                  lambda q: q.eq("conversation_id", conversation_id).eq("user_id", uid).lt("last_read_seq", seq))
    return seq


async def put_read_cursor(uid: str, conversation_id: str, body: ReadCursorIn) -> dict:
    conv, _ = await _member_conversation(uid, conversation_id)
    if body.last_read_seq > 0:
        message = await _one("community_messages", lambda q: q.eq("conversation_id", conversation_id)
                             .eq("seq", body.last_read_seq))
        if not message:
            raise _invalid("last_read_seq is not a message of this conversation")
    seq = await _advance_cursor(conversation_id, uid, body.last_read_seq)
    return {"conversation_id": conversation_id, "last_read_seq": seq, "unread_count": await _unread(conv, uid)}


async def inbox(uid: str, cursor: Optional[str] = None, page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    before = _decode_cursor(cursor)

    def build(col):
        def inner(q):
            q = q.eq(col, uid).gt("last_message_seq", 0)
            if before is not None:
                q = q.lt("last_message_seq", before)
            return q.order("last_message_seq", desc=True).limit(size + 1)
        return inner

    convs = (await _select("community_conversations", build("user_low"))
             + await _select("community_conversations", build("user_high")))
    convs.sort(key=lambda c: int(c["last_message_seq"]), reverse=True)
    page, next_cursor, has_more = _page(convs, size, key="last_message_seq")
    items = []
    for conv in page:
        last = await _one("community_messages", lambda q, c=conv: q.eq("conversation_id", c["id"])
                          .eq("seq", c["last_message_seq"]))
        preview = ""
        if last:
            preview = (last.get("body") or "")[:80] or ("[图片]" if last.get("media_ids") else "")
        items.append({**await _conversation_dto(uid, conv), "kind": "conversation",
                      "last_message": {"preview": preview, "sender": "me" if last and last["sender_id"] == uid
                                       else "parent", "seq": conv["last_message_seq"]} if last else None,
                      "unread_count": await _unread(conv, uid)})
    pending = await _select("community_invitations", lambda q: q.eq("recipient_id", uid).eq("state", "pending"))
    waiting = await _select("community_question_deliveries", lambda q: q.eq("recipient_id", uid)
                            .eq("state", "waiting").gt("expires_at", _iso()))
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more,
            "summary": {"pending_invitations": len(pending), "waiting_questions": len(waiting),
                        "unread_conversations": sum(1 for i in items if i["unread_count"])}}


# ── P24 Preferences ──────────────────────────────────────────────────────────

def _prefs_dto(row: dict) -> dict:
    return {k: bool(row.get(k, DEFAULT_PREFERENCES[k])) for k in
            ("parent_message_notifications_enabled", "profile_hidden", "auto_translate_messages")} | {
        "version": int(row.get("version") or 0)}


async def get_preferences(uid: str) -> dict:
    return _prefs_dto(await _preferences(uid))


async def patch_preferences(uid: str, body: PreferencesPatch) -> dict:
    patch = {k: v for k, v in body.model_dump().items()
             if k in ("parent_message_notifications_enabled", "profile_hidden", "auto_translate_messages")
             and v is not None}
    row = await _one("community_preferences", lambda q: q.eq("user_id", uid))
    if row is None:
        if body.expected_version not in (None, 0):
            raise CommunityError("VERSION_CONFLICT", "Preferences changed; reload", extra={"current_version": 0})
        try:
            row = await _insert("community_preferences", {"user_id": uid, **DEFAULT_PREFERENCES,
                                                          **patch, "version": 1, "updated_at": _iso()})
        except _UniqueViolation:
            raise CommunityError("VERSION_CONFLICT", "Preferences changed; reload")
        return _prefs_dto(row)
    _check_version(row, body.expected_version)
    if patch:
        row = await _versioned_update("community_preferences", row, {**patch, "updated_at": _iso()},
                                      id_col="user_id")
    return _prefs_dto(row)


# ── P25–P28 Two-party AI consent ─────────────────────────────────────────────

async def _ai_state(conv: dict) -> dict:
    epoch = int(conv.get("ai_epoch") or 0)
    requests = await _select("community_ai_consent_requests", lambda q: q.eq("conversation_id", conv["id"])
                             .eq("epoch", epoch))
    purposes = {}
    for purpose in AI_PURPOSES:
        req = next((r for r in sorted(requests, key=lambda r: str(r.get("created_at") or ""), reverse=True)
                    if r["purpose"] == purpose and r["state"] in ("pending", "effective")), None)
        purposes[purpose] = {"effective": bool(req and req["state"] == "effective"),
                             "request_id": str(req["id"]) if req else None,
                             "state": req["state"] if req else "off",
                             "effective_from_seq": req.get("effective_from_seq") if req else None}
    return {"epoch": epoch, "effective": purposes["conversation_notes"]["effective"], "purposes": purposes}


async def _consent_dto(uid: str, req: dict) -> dict:
    decisions = await _select("community_ai_consent_decisions", lambda q: q.eq("request_id", req["id"]))
    mine = next((d for d in decisions if d["user_id"] == uid), None)
    theirs = next((d for d in decisions if d["user_id"] != uid), None)
    return {"request_id": str(req["id"]), "conversation_id": str(req["conversation_id"]),
            "purpose": req["purpose"], "provider": req["provider"], "notice_version": req["notice_version"],
            "state": req["state"], "epoch": int(req["epoch"]), "version": int(req.get("version") or 1),
            "initiated_by": "me" if req["initiator_id"] == uid else "parent",
            "my_decision": mine["decision"] if mine else "pending",
            "parent_decision": theirs["decision"] if theirs else "pending",
            "effective": req["state"] == "effective",
            "effective_from_seq": req.get("effective_from_seq"),
            "created_at": req.get("created_at"), "decided_at": req.get("decided_at")}


async def request_ai_consent(uid: str, conversation_id: str, body: ConsentRequestIn) -> dict:
    conv, other = await _member_conversation(uid, conversation_id)
    await _may_message(uid, other)
    if body.notice_version != AI_NOTICE_VERSION:
        raise CommunityError("CONSENT_REVOKED_OR_CHANGED", "The consent notice changed; show the new one",
                             extra={"notice_version": AI_NOTICE_VERSION})
    epoch = int(conv.get("ai_epoch") or 0)
    fp = _fingerprint({"c": conversation_id, "p": body.purpose, "n": body.notice_version})
    existing = await _one("community_ai_consent_requests", lambda q: q.eq("initiator_id", uid)
                          .eq("client_request_id", body.client_request_id))
    if existing:
        if existing["request_fingerprint"] != fp:
            raise CommunityError("IDEMPOTENCY_CONFLICT", "This request key was already used with different content")
        return {"request": await _consent_dto(uid, existing), "created": False}
    state = (await _ai_state(conv))["purposes"][body.purpose]
    if state["request_id"]:
        # One open request per purpose and epoch; asking again returns it.
        req = await _one("community_ai_consent_requests", lambda q: q.eq("id", state["request_id"]))
        return {"request": await _consent_dto(uid, req), "created": False}
    req, created = await _create_once(
        "community_ai_consent_requests", match={"initiator_id": uid}, key_col="client_request_id",
        key=body.client_request_id, fingerprint=fp,
        row={"conversation_id": conversation_id, "initiator_id": uid, "purpose": body.purpose,
             "provider": "openai", "notice_version": body.notice_version, "epoch": epoch, "state": "pending"},
    )
    if created:
        # Asking is the initiator's own consent — never the other parent's.
        await _insert("community_ai_consent_decisions", {"request_id": req["id"], "user_id": uid,
                                                         "decision": "allow", "notice_version": body.notice_version})
        await _notify(other, "community_ai_consent", str(req["id"]),
                      {"conversation_id": conversation_id, "consent_request_id": str(req["id"])}, actor=uid)
    return {"request": await _consent_dto(uid, req), "created": created}


async def decide_ai_consent(uid: str, request_id: str, body: ConsentDecisionIn) -> dict:
    req = await _one("community_ai_consent_requests", lambda q: q.eq("id", request_id))
    if not req:
        raise _not_found("consent request")
    conv, other = await _member_conversation(uid, str(req["conversation_id"]))
    if int(req["epoch"]) != int(conv.get("ai_epoch") or 0) or req["state"] in ("revoked", "superseded"):
        # An old sheet cannot restart consent that was revoked since.
        raise CommunityError("CONSENT_REVOKED_OR_CHANGED", "This consent request is no longer current")
    if body.notice_version != req["notice_version"]:
        raise CommunityError("CONSENT_REVOKED_OR_CHANGED", "The consent notice changed",
                             extra={"notice_version": req["notice_version"]})
    _check_version(req, body.expected_version)
    if req["state"] == "declined":
        if body.decision == "decline":
            return {"request": await _consent_dto(uid, req)}
        raise CommunityError("CONSENT_REVOKED_OR_CHANGED", "This request was declined; ask again")
    if req["state"] == "effective" and body.decision == "decline":
        # Declining consent already in force is a revoke.
        conv = await _revoke_ai(conv, purpose=req["purpose"])
        req = await _one("community_ai_consent_requests", lambda q: q.eq("id", request_id))
        return {"request": await _consent_dto(uid, req)}
    if body.decision == "allow":
        await _may_message(uid, other)
    existing = await _one("community_ai_consent_decisions", lambda q: q.eq("request_id", request_id).eq("user_id", uid))
    if existing and existing["decision"] == body.decision and req["state"] != "pending":
        return {"request": await _consent_dto(uid, req)}
    if existing:
        await _update("community_ai_consent_decisions", {"decision": body.decision, "decided_at": _iso(),
                                                         "notice_version": body.notice_version},
                      lambda q: q.eq("request_id", request_id).eq("user_id", uid))
    else:
        await _insert("community_ai_consent_decisions", {"request_id": request_id, "user_id": uid,
                                                         "decision": body.decision,
                                                         "notice_version": body.notice_version})
    decisions = await _select("community_ai_consent_decisions", lambda q: q.eq("request_id", request_id))
    members = {conv["user_low"], conv["user_high"]}
    allowed = {d["user_id"] for d in decisions if d["decision"] == "allow"
               and d["notice_version"] == req["notice_version"]}
    if body.decision == "decline":
        req = await _versioned_update("community_ai_consent_requests", req,
                                      {"state": "declined", "decided_at": _iso()})
    elif allowed >= members:
        # Effective from now on: nothing said before consent is covered.
        req = await _versioned_update("community_ai_consent_requests", req,
                                      {"state": "effective", "decided_at": _iso(),
                                       "effective_from_seq": 0})  # D12: all content, history included
    return {"request": await _consent_dto(uid, req)}


async def revoke_ai(uid: str, conversation_id: str, purpose: Optional[str] = None) -> dict:
    conv, _ = await _member_conversation(uid, conversation_id)
    if purpose is not None and purpose not in AI_PURPOSES:
        raise _invalid("unknown purpose")
    # Either parent may switch it off at any time, without re-consenting first.
    conv = await _revoke_ai(conv, purpose=purpose)
    state = await _ai_state(conv)
    return {"conversation_id": conversation_id, "effective": state["effective"],
            "epoch": state["epoch"], "purposes": state["purposes"]}


async def ai_activity(uid: str, conversation_id: str) -> dict:
    conv, _ = await _member_conversation(uid, conversation_id)
    state = await _ai_state(conv)
    requests = {}
    for purpose, info in state["purposes"].items():
        if info["request_id"]:
            req = await _one("community_ai_consent_requests", lambda q, i=info: q.eq("id", i["request_id"]))
            requests[purpose] = await _consent_dto(uid, req)
        else:
            requests[purpose] = None
    # No AI job runs on P2P conversations yet: "effective" is consent on
    # record, never "recording" or "summarising".
    return {"conversation_id": conversation_id, "epoch": state["epoch"], "effective": state["effective"],
            "purposes": state["purposes"], "requests": requests, "operations": [],
            "notice_version": AI_NOTICE_VERSION}


# ── P31–P34 Media ────────────────────────────────────────────────────────────

async def _own_media(uid: str, media_id: str) -> dict:
    try:
        uuid.UUID(str(media_id))
    except ValueError:
        raise CommunityError("MEDIA_NOT_READY_OR_NOT_OWNED", "Unknown media")
    row = await _one("community_media", lambda q: q.eq("id", media_id).eq("owner_id", uid))
    if not row or row["state"] == "deleted":
        raise CommunityError("MEDIA_NOT_READY_OR_NOT_OWNED", "Unknown media")
    return row


def _media_dto(row: dict) -> dict:
    return {"media_id": str(row["id"]), "purpose": row["purpose"], "state": row["state"],
            "mime_type": row.get("validated_mime") or row.get("declared_mime"),
            "byte_size": row.get("byte_size"), "width": row.get("width"), "height": row.get("height"),
            "reject_reason": row.get("reject_reason"), "expires_at": row.get("expires_at")}


def _bucket():
    sb = _sb()
    return sb.storage.from_(MEDIA_BUCKET)


async def create_upload(uid: str, body: MediaUploadIn) -> dict:
    mime = body.mime_type.lower().replace("image/jpg", "image/jpeg")
    if mime not in MEDIA_MIMES:
        raise _invalid("Only JPEG, PNG and WebP images are supported")
    if body.byte_size > MEDIA_MAX_BYTES:
        raise _invalid(f"Images must be at most {MEDIA_MAX_BYTES} bytes")
    fp = _fingerprint({"purpose": body.purpose, "mime": mime, "size": body.byte_size, "sha": body.sha256.lower()})
    media_id = str(uuid.uuid4())
    path = f"{uid}/{media_id}.{MEDIA_MIMES[mime]}"
    row, created = await _create_once(
        "community_media", match={"owner_id": uid}, key_col="client_request_id",
        key=body.client_request_id, fingerprint=fp,
        row={"id": media_id, "owner_id": uid, "purpose": body.purpose, "state": "upload_authorized",
             "declared_mime": mime, "byte_size": body.byte_size, "sha256": body.sha256.lower(),
             "storage_path": path,
             "expires_at": _iso(_now() + timedelta(minutes=MEDIA_UPLOAD_TTL_MIN)), "updated_at": _iso()},
    )
    upload = None
    if row["state"] == "upload_authorized":
        signed = await _db(lambda: _bucket().create_signed_upload_url(row["storage_path"]))
        upload = {"method": "PUT", "url": signed.get("signed_url") or signed.get("signedUrl"),
                  "token": signed.get("token"), "headers": {"Content-Type": row["declared_mime"]},
                  "expires_at": row["expires_at"]}
    return {"media": _media_dto(row), "upload": upload,
            "constraints": {"mime_types": list(MEDIA_MIMES), "max_bytes": MEDIA_MAX_BYTES}}


async def complete_upload(uid: str, upload_id: str) -> dict:
    row = await _own_media(uid, upload_id)
    if row["state"] != "upload_authorized":
        return {"media": _media_dto(row)}  # already decided: same answer again
    if (_parse_ts(row.get("expires_at")) or _now()) < _now():
        row = (await _update("community_media", {"state": "rejected", "reject_reason": "expired",
                                                 "updated_at": _iso()}, lambda q: q.eq("id", row["id"])))[0]
        return {"media": _media_dto(row)}
    try:
        raw = await anyio.to_thread.run_sync(lambda: _bucket().download(row["storage_path"]))
    except Exception:
        raise CommunityError("MEDIA_NOT_READY_OR_NOT_OWNED", "The upload has not arrived yet")
    reason, mime, width, height = _inspect_image(raw, row)
    if reason:
        await _db(lambda: _bucket().remove([row["storage_path"]]))
        patch = {"state": "rejected", "reject_reason": reason, "updated_at": _iso()}
    else:
        patch = {"state": "ready", "validated_mime": mime, "width": width, "height": height,
                 "updated_at": _iso()}
    updated = await _update("community_media", patch,
                            lambda q: q.eq("id", row["id"]).eq("state", "upload_authorized"))
    row = updated[0] if updated else await _own_media(uid, upload_id)
    return {"media": _media_dto(row)}


def _inspect_image(raw: bytes, row: dict) -> tuple[Optional[str], Optional[str], Optional[int], Optional[int]]:
    """Check the real bytes, never the client's extension or MIME."""
    from PIL import Image

    from backend.nuri_core import image_input

    if not raw or len(raw) != int(row["byte_size"]):
        return "size_mismatch", None, None, None
    if hashlib.sha256(raw).hexdigest() != row["sha256"]:
        return "checksum_mismatch", None, None, None
    fmt = MEDIA_MIMES[row["declared_mime"]]
    try:
        image_input.validate_image_data_uri(f"data:image/{fmt};base64,{base64.b64encode(raw).decode()}")
    except image_input.InvalidChatImage:
        return "invalid_image", None, None, None
    with Image.open(BytesIO(raw)) as opened:
        width, height = opened.size
    return None, row["declared_mime"], width, height


async def upload_direct(uid: str, body: MediaDirectIn) -> dict:
    """P31+P32 in one call: the image travels through the backend, which checks
    the real bytes before they are stored and returns a ready media id.

    Native clients cannot reliably PUT raw bytes to a signed URL, and a phone
    image is well under the request limit, so this is the path the apps use.
    The signed-upload pair above stays for larger media later.
    """
    from PIL import Image

    from backend.nuri_core import image_input

    try:
        normalized = image_input.validate_image_data_uri(body.data_uri)
    except image_input.InvalidChatImage as exc:
        raise _invalid(str(exc))
    if not normalized:
        raise _invalid("data_uri must not be empty")
    header, payload = normalized.split(",", 1)
    fmt = header.split("/", 1)[1].split(";", 1)[0]
    raw = base64.b64decode(payload)
    sha = hashlib.sha256(raw).hexdigest()
    fp = _fingerprint({"purpose": body.purpose, "sha": sha})
    existing = await _one("community_media", lambda q: q.eq("owner_id", uid)
                          .eq("client_request_id", body.client_request_id))
    if existing:
        if existing["request_fingerprint"] != fp:
            raise CommunityError("IDEMPOTENCY_CONFLICT", "This request key was already used with different content")
        return {"media": _media_dto(existing), "created": False}
    with Image.open(BytesIO(raw)) as opened:
        width, height = opened.size
    media_id = str(uuid.uuid4())
    path = f"{uid}/{media_id}.{fmt}"
    mime = f"image/{fmt}"
    await _db(lambda: _bucket().upload(path, raw, {"content-type": mime, "upsert": "false"}))
    row, created = await _create_once(
        "community_media", match={"owner_id": uid}, key_col="client_request_id",
        key=body.client_request_id, fingerprint=fp,
        row={"id": media_id, "owner_id": uid, "purpose": body.purpose, "state": "ready",
             "declared_mime": mime, "validated_mime": mime, "byte_size": len(raw), "sha256": sha,
             "width": width, "height": height, "storage_path": path,
             "expires_at": _iso(_now() + timedelta(minutes=MEDIA_UPLOAD_TTL_MIN)), "updated_at": _iso()},
    )
    if not created:
        # A concurrent retry won: drop the copy this call stored.
        await _db(lambda: _bucket().remove([path]))
    return {"media": _media_dto(row), "created": created}


async def media_access(uid: str, media_id: str) -> dict:
    try:
        uuid.UUID(str(media_id))
    except ValueError:
        raise _not_found("media")
    row = await _one("community_media", lambda q: q.eq("id", media_id))
    if not row or row["state"] in ("deleted", "rejected"):
        raise _not_found("media")
    allowed = row["owner_id"] == uid
    if not allowed and row["state"] == "committed":
        bound = row.get("bound_to") or ""
        if bound.startswith("message:"):
            message = await _one("community_messages", lambda q: q.eq("id", bound.split(":", 1)[1]))
            if message:
                conv = await _one("community_conversations", lambda q: q.eq("id", message["conversation_id"]))
                allowed = bool(conv and uid in (conv["user_low"], conv["user_high"]))
        elif bound == "avatar":
            profile = await _profile(row["owner_id"])
            _, they_blocked = await _blocked_between(uid, row["owner_id"])
            allowed = bool(profile and str(profile.get("avatar_media_id")) == str(row["id"]) and not they_blocked)
    if not allowed:
        raise _not_found("media")
    if row["state"] not in ("ready", "committed"):
        raise CommunityError("MEDIA_NOT_READY_OR_NOT_OWNED", "Media is not ready")
    signed = await _db(lambda: _bucket().create_signed_url(row["storage_path"], MEDIA_ACCESS_TTL_S))
    url = signed.get("signedURL") or signed.get("signedUrl") or signed.get("signed_url")
    return {"media": _media_dto(row), "access": {"url": url, "expires_in_s": MEDIA_ACCESS_TTL_S}}


async def delete_media(uid: str, media_id: str) -> dict:
    row = await _own_media(uid, media_id)
    if row["state"] == "committed":
        # Sent media belongs to the conversation; a draft remove cannot take it.
        raise CommunityError("MEDIA_NOT_READY_OR_NOT_OWNED", "Sent media cannot be deleted as a draft")
    try:
        await _db(lambda: _bucket().remove([row["storage_path"]]))
    except CommunityError:
        pass  # the object may never have been uploaded; the row still goes
    updated = await _update("community_media", {"state": "deleted", "updated_at": _iso()},
                            lambda q: q.eq("id", row["id"]).neq("state", "committed"))
    if not updated:
        raise CommunityError("MEDIA_NOT_READY_OR_NOT_OWNED", "Sent media cannot be deleted as a draft")
    return {"media_id": media_id, "state": "deleted"}


# ── Reports (Google Play UGC policy) ─────────────────────────────────────────

async def _report_target(uid: str, kind: str, target_id: str) -> tuple[Optional[str], str, bool]:
    """(author account id, text snapshot, author is anonymous) for something
    the reporter can actually see; anything else is a 404."""
    if kind == "parent":
        profile = await _profile_by_public(target_id)
        if not profile or profile["user_id"] == uid:
            raise _not_found("parent")
        return profile["user_id"], f"{profile.get('display_name') or ''}\n{profile.get('about') or ''}".strip(), False
    try:
        uuid.UUID(target_id)
    except ValueError:
        raise _not_found(kind)
    if kind == "question":
        question, _ = await _visible_question(uid, target_id)
        return question["author_id"], question["body"], bool(question.get("anonymous"))
    if kind == "reply":
        reply = await _one("community_replies", lambda q: q.eq("id", target_id))
        if not reply:
            raise _not_found("reply")
        question, _ = await _visible_question(uid, str(reply["question_id"]))
        if uid not in (question["author_id"], reply["author_id"]):
            raise _not_found("reply")
        return reply["author_id"], reply["body"], bool(reply.get("anonymous"))
    if kind == "comment":
        comment = await _one("community_comments", lambda q: q.eq("id", target_id))
        if not comment:
            raise _not_found("comment")
        question, _ = await _visible_question(uid, str(comment["question_id"]))
        await _thread_access(uid, question, str(comment["reply_id"]) if comment.get("reply_id") else "all")
        author = comment["author_id"]
        if author == question["author_id"]:
            anonymous = bool(question.get("anonymous"))
        else:
            own = await _one("community_replies", lambda q: q.eq("question_id", question["id"]).eq("author_id", author))
            anonymous = bool(own and own.get("anonymous"))
        return author, comment["body"], anonymous
    message = await _one("community_messages", lambda q: q.eq("id", target_id))
    if not message:
        raise _not_found("message")
    await _member_conversation(uid, str(message["conversation_id"]))
    media = f" [{len(message.get('media_ids') or [])} photo(s)]" if message.get("media_ids") else ""
    return message["sender_id"], (message.get("body") or "") + media, False


async def file_report(uid: str, body: ReportIn) -> dict:
    author, snapshot, anonymous = await _report_target(uid, body.target_kind, body.target_id)
    if author == uid:
        raise _invalid("You cannot report your own content")
    note = _clean_text(body.note, field="note", max_len=500, required=False) or None
    row = {"reporter_id": uid, "target_kind": body.target_kind, "target_id": body.target_id,
           "reported_user_id": author, "reason": body.reason, "note": note,
           "snapshot": (snapshot or "")[:4000], "status": "pending", "updated_at": _iso()}
    existing = await _one("community_reports", lambda q: q.eq("reporter_id", uid)
                          .eq("target_kind", body.target_kind).eq("target_id", body.target_id))
    if existing:
        # One report per parent and target; a second one updates the reason.
        report = (await _update("community_reports", {"reason": body.reason, "note": note, "status": "pending",
                                                      "updated_at": _iso()},
                                lambda q: q.eq("id", existing["id"])))[0]
    else:
        try:
            report = await _insert("community_reports", row)
        except _UniqueViolation:
            report = await _one("community_reports", lambda q: q.eq("reporter_id", uid)
                                .eq("target_kind", body.target_kind).eq("target_id", body.target_id))
    print(f"[community] report filed kind={body.target_kind} reason={body.reason}")
    blocked = False
    if body.block and author and not anonymous:
        profile = await _profile(author)
        if profile:
            await block(uid, str(profile["public_id"]), BlockIn(confirmed=True))
            blocked = True
    # "received" is the truth: the report is queued for a person to review.
    return {"report_id": str(report["id"]), "status": "received", "blocked": blocked,
            "block_available": not anonymous}


async def admin_list_reports(status_filter: str = "pending", limit: int = 100) -> dict:
    if status_filter not in ("pending", "actioned", "dismissed", "all"):
        raise _invalid("status must be pending, actioned, dismissed or all")
    rows = await _select("community_reports", lambda q: (q if status_filter == "all" else q.eq("status", status_filter))
                         .order("created_at", desc=True).limit(max(1, min(limit, 200))))
    people = sorted({r[k] for r in rows for k in ("reporter_id", "reported_user_id") if r.get(k)})
    users = {u["id"]: u for u in (await _select("users", lambda q: q.in_("id", people)) if people else [])}
    counts: dict[str, int] = {}
    for r in rows:
        if r.get("reported_user_id"):
            counts[r["reported_user_id"]] = counts.get(r["reported_user_id"], 0) + 1
    label = lambda uid: (users.get(uid) or {}).get("nickname") or (users.get(uid) or {}).get("email") or "Unknown"
    return {"status": status_filter, "total": len(rows), "rows": [{
        "id": str(r["id"]), "target_kind": r["target_kind"], "target_id": r["target_id"],
        "reason": r["reason"], "note": r.get("note"), "snapshot": r.get("snapshot") or "",
        "status": r["status"], "content_removed": bool(r.get("content_removed")),
        "reviewer_note": r.get("reviewer_note"), "created_at": r.get("created_at"), "reviewed_at": r.get("reviewed_at"),
        "reporter": label(r["reporter_id"]),
        "reported": label(r["reported_user_id"]) if r.get("reported_user_id") else None,
        "reported_email": (users.get(r.get("reported_user_id")) or {}).get("email"),
        "reports_against_reported": counts.get(r.get("reported_user_id"), 0),
    } for r in rows]}


async def admin_review_report(report_id: str, body: ReportReviewIn) -> dict:
    try:
        uuid.UUID(report_id)
    except ValueError:
        raise _not_found("report")
    report = await _one("community_reports", lambda q: q.eq("id", report_id))
    if not report:
        raise _not_found("report")
    removed = bool(report.get("content_removed"))
    if body.remove_content and not removed:
        kind, target = report["target_kind"], report["target_id"]
        if kind == "question":
            await _update("community_questions", {"status": "deleted", "deleted_at": _iso(), "updated_at": _iso()},
                          lambda q: q.eq("id", target))
            await _lock_deliveries(target, "question_deleted")
        elif kind == "reply":
            await _delete("community_replies", lambda q: q.eq("id", target))
        elif kind == "comment":
            await _delete("community_comments", lambda q: q.eq("id", target))
        elif kind == "message":
            await _delete("community_messages", lambda q: q.eq("id", target))
        elif kind == "parent" and report.get("reported_user_id"):
            # A parent is taken out of recommendations and new contact.
            await patch_preferences(report["reported_user_id"], PreferencesPatch(profile_hidden=True))
        removed = True
        # Every open report on the same target is settled with it.
        await _update("community_reports", {"content_removed": True, "updated_at": _iso()},
                      lambda q: q.eq("target_kind", kind).eq("target_id", target))
    updated = (await _update("community_reports", {
        "status": body.status, "reviewer_note": (body.reviewer_note or None),
        "content_removed": removed, "reviewed_at": _iso() if body.status != "pending" else None, "updated_at": _iso(),
    }, lambda q: q.eq("id", report_id)))[0]
    return {"id": report_id, "status": updated["status"], "content_removed": bool(updated.get("content_removed"))}


# ── P35–P36 Community notifications ──────────────────────────────────────────

def _decode_ts_cursor(cursor: Optional[str]) -> Optional[tuple[str, str]]:
    if not cursor:
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode() + b"==").decode())
        return str(data["t"]), str(data["i"])
    except (ValueError, KeyError, TypeError, binascii.Error, json.JSONDecodeError):
        raise _invalid("cursor is not valid")


def _notification_dto(row: dict) -> dict:
    data = row.get("data") or {}
    return {"notification_id": str(row["id"]), "kind": data.get("kind"), "title": row.get("title"),
            "body": row.get("body"), "target": data.get("target"), "created_at": row.get("created_at"),
            "read_at": row.get("read_at")}


async def list_notifications(uid: str, cursor: Optional[str] = None, page_size: Optional[int] = None) -> dict:
    size = _page_size(page_size)
    after = _decode_ts_cursor(cursor)

    def build(q):
        q = q.eq("user_id", uid).like("data->>kind", "community_%").neq("status", "cancelled")
        if after:
            q = q.lte("created_at", after[0])
        return q.order("created_at", desc=True).order("id", desc=True).limit(size + 50)

    rows = await _select("notification_events", build)
    if after:
        rows = [r for r in rows if (str(r["created_at"]), str(r["id"])) < after]
    has_more = len(rows) > size
    rows = rows[:size]
    next_cursor = None
    if has_more and rows:
        next_cursor = base64.urlsafe_b64encode(json.dumps(
            {"t": str(rows[-1]["created_at"]), "i": str(rows[-1]["id"])}).encode()).decode().rstrip("=")
    return {"items": [_notification_dto(r) for r in rows], "next_cursor": next_cursor, "has_more": has_more}


async def _own_community_event(uid: str, notification_id: str) -> dict:
    try:
        uuid.UUID(str(notification_id))
    except ValueError:
        raise _not_found("notification")
    row = await _one("notification_events", lambda q: q.eq("id", notification_id))
    if not row or row.get("user_id") != uid or not str((row.get("data") or {}).get("kind", "")).startswith("community_"):
        raise _not_found("notification")
    return row


async def notification_target(uid: str, notification_id: str) -> dict:
    """Re-check the target against today's permissions before the app goes there."""
    row = await _own_community_event(uid, notification_id)
    target = dict((row.get("data") or {}).get("target") or {})
    kind = target.get("kind")
    try:
        if kind == "community_question":
            await get_question(uid, target["question_id"])
        elif kind == "community_reply":
            question, _ = await _visible_question(uid, target["question_id"])
            await _thread_access(uid, question, target.get("thread_id") or "all")
        elif kind == "community_invitation":
            inv = await _one("community_invitations", lambda q: q.eq("id", target["invitation_id"]))
            if not inv or uid not in (inv["sender_id"], inv["recipient_id"]):
                raise _not_found("invitation")
            target["state"] = inv["state"]
        elif kind in ("community_conversation", "community_ai_consent"):
            conv, other = await _member_conversation(uid, target["conversation_id"])
            i_blocked, they_blocked = await _blocked_between(uid, other)
            if i_blocked or they_blocked:
                raise _not_found("conversation")
        else:
            raise _not_found("target")
    except CommunityError as exc:
        return {"notification_id": notification_id, "accessible": False, "target": None,
                "reason": exc.error_code}
    return {"notification_id": notification_id, "accessible": True, "target": target, "reason": None}


async def mark_notification_read(uid: str, notification_id: str) -> dict:
    row = await _own_community_event(uid, notification_id)
    if not row.get("read_at"):
        updated = await _update("notification_events", {"read_at": _iso()},
                                lambda q: q.eq("id", notification_id).is_("read_at", "null"))
        row = updated[0] if updated else (await _own_community_event(uid, notification_id))
    return {"notification_id": notification_id, "read_at": row.get("read_at")}


# ── Routes ───────────────────────────────────────────────────────────────────

def build_router(req_uid: Callable) -> APIRouter:
    """Mount every capability group; `req_uid` is main's account check."""
    r = APIRouter(prefix=PREFIX, tags=["community"])
    U = Depends(req_uid)
    PageQ = Query(None, ge=1, le=PAGE_MAX)

    @r.get("/profiles/me")
    async def _p01(uid: str = U): return await get_my_profile(uid)

    @r.patch("/profiles/me")
    async def _p02(body: ProfilePatch, uid: str = U): return await patch_my_profile(uid, body)

    @r.get("/parents/{parent_id}")
    async def _p03(parent_id: str, uid: str = U): return await get_parent(uid, parent_id)

    @r.get("/recommendations")
    async def _p04(role: str = "any", distance_miles: Optional[int] = None, intents: Optional[str] = None,
                   cursor: Optional[str] = None, page_size: Optional[int] = PageQ, uid: str = U):
        return await recommendations(uid, role, distance_miles, intents, cursor, page_size)

    @r.post("/question-polishes")
    async def _p05(body: PolishIn, uid: str = U): return await polish_question(uid, body)

    @r.post("/questions", status_code=status.HTTP_201_CREATED)
    async def _p06(body: QuestionIn, response: Response, background: BackgroundTasks, uid: str = U):
        result = await create_question(uid, body, schedule=background.add_task)
        if not result["created"]:
            response.status_code = status.HTTP_200_OK
        return result

    @r.get("/operations/{operation_id}")
    async def _p07(operation_id: str, uid: str = U): return await get_operation(uid, operation_id)

    @r.get("/me/questions")
    async def _p08(status_filter: str = Query("all", alias="status"), q: Optional[str] = Query(None, max_length=100),
                   cursor: Optional[str] = None, page_size: Optional[int] = PageQ, uid: str = U):
        return await my_questions(uid, status_filter, q, cursor, page_size)

    @r.get("/questions/{question_id}")
    async def _p09(question_id: str, uid: str = U): return await get_question(uid, question_id)

    @r.post("/questions/batch-transitions")
    async def _p10(body: TransitionIn, uid: str = U): return await transition_questions(uid, body)

    @r.get("/me/question-deliveries")
    async def _p11(tab: str = "waiting", cursor: Optional[str] = None, page_size: Optional[int] = PageQ,
                   uid: str = U):
        return await my_deliveries(uid, tab, cursor, page_size)

    @r.post("/question-deliveries/{delivery_id}/responses", status_code=status.HTTP_201_CREATED)
    async def _p12(delivery_id: str, body: ResponseIn, response: Response, uid: str = U):
        result = await respond(uid, delivery_id, body)
        if not result["created"]:
            response.status_code = status.HTTP_200_OK
        return result

    @r.get("/questions/{question_id}/replies")
    async def _p13(question_id: str, cursor: Optional[str] = None, page_size: Optional[int] = PageQ, uid: str = U):
        return await list_replies(uid, question_id, cursor, page_size)

    @r.get("/questions/{question_id}/reply-threads/{thread_id}/comments")
    async def _p14a(question_id: str, thread_id: str, cursor: Optional[str] = None,
                    page_size: Optional[int] = PageQ, uid: str = U):
        return await list_comments(uid, question_id, thread_id, cursor, page_size)

    @r.post("/questions/{question_id}/reply-threads/{thread_id}/comments", status_code=status.HTTP_201_CREATED)
    async def _p14b(question_id: str, thread_id: str, body: CommentIn, response: Response, uid: str = U):
        result = await post_comment(uid, question_id, thread_id, body)
        if not result["created"]:
            response.status_code = status.HTTP_200_OK
        return result

    @r.get("/invitations")
    async def _p15a(direction: str = "received", state: str = "pending", cursor: Optional[str] = None,
                    page_size: Optional[int] = PageQ, uid: str = U):
        return await list_invitations(uid, direction, state, cursor, page_size)

    @r.post("/invitations")
    async def _p15b(body: InvitationIn, uid: str = U): return await send_invitation(uid, body)

    @r.post("/invitations/{invitation_id}/decisions")
    async def _p16(invitation_id: str, body: InvitationDecisionIn, uid: str = U):
        return await decide_invitation(uid, invitation_id, body)

    @r.get("/me/contacts")
    async def _p17(q: Optional[str] = Query(None, max_length=60), cursor: Optional[str] = None,
                   page_size: Optional[int] = PageQ, uid: str = U):
        return await list_contacts(uid, q, cursor, page_size)

    @r.delete("/relationships/{relationship_id}")
    async def _p18(relationship_id: str, confirmed: bool = False, expected_version: Optional[int] = None,
                   client_request_id: Optional[str] = None, uid: str = U):
        return await disconnect(uid, relationship_id, expected_version, confirmed)

    @r.get("/me/blocks")
    async def _p19a(cursor: Optional[str] = None, page_size: Optional[int] = PageQ, uid: str = U):
        return await list_blocks(uid, cursor, page_size)

    @r.put("/me/blocks/{parent_id}")
    async def _p19b(parent_id: str, body: BlockIn, uid: str = U): return await block(uid, parent_id, body)

    @r.delete("/me/blocks/{parent_id}")
    async def _p19c(parent_id: str, confirmed: bool = False, client_request_id: Optional[str] = None,
                    uid: str = U):
        return await unblock(uid, parent_id, confirmed)

    @r.get("/me/inbox")
    async def _p20(cursor: Optional[str] = None, page_size: Optional[int] = PageQ, uid: str = U):
        return await inbox(uid, cursor, page_size)

    @r.post("/conversations")
    async def _p21(body: ConversationIn, uid: str = U): return await start_conversation(uid, body)

    @r.get("/conversations/{conversation_id}/messages")
    async def _p22a(conversation_id: str, cursor: Optional[str] = None, page_size: Optional[int] = PageQ,
                    uid: str = U):
        return await list_messages(uid, conversation_id, cursor, page_size)

    @r.post("/conversations/{conversation_id}/messages", status_code=status.HTTP_201_CREATED)
    async def _p22b(conversation_id: str, body: MessageIn, response: Response, uid: str = U):
        result = await send_message(uid, conversation_id, body)
        if not result["created"]:
            response.status_code = status.HTTP_200_OK
        return result

    @r.put("/conversations/{conversation_id}/read-cursor")
    async def _p23(conversation_id: str, body: ReadCursorIn, uid: str = U):
        return await put_read_cursor(uid, conversation_id, body)

    @r.get("/preferences")
    async def _p24a(uid: str = U): return await get_preferences(uid)

    @r.patch("/preferences")
    async def _p24b(body: PreferencesPatch, uid: str = U): return await patch_preferences(uid, body)

    @r.post("/conversations/{conversation_id}/ai-consent-requests")
    async def _p25(conversation_id: str, body: ConsentRequestIn, uid: str = U):
        return await request_ai_consent(uid, conversation_id, body)

    @r.put("/ai-consent-requests/{request_id}/my-decision")
    async def _p26(request_id: str, body: ConsentDecisionIn, uid: str = U):
        return await decide_ai_consent(uid, request_id, body)

    @r.delete("/conversations/{conversation_id}/ai-participation")
    async def _p27(conversation_id: str, purpose: Optional[str] = None, client_request_id: Optional[str] = None,
                   uid: str = U):
        return await revoke_ai(uid, conversation_id, purpose)

    @r.get("/conversations/{conversation_id}/ai-participation")
    async def _p28(conversation_id: str, uid: str = U): return await ai_activity(uid, conversation_id)

    @r.post("/messages/{message_id}/translations")
    async def _p29(message_id: str, body: TranslationIn, uid: str = U):
        return await translate_message(uid, message_id, body)

    @r.post("/transcriptions")
    async def _p30(body: TranscriptionIn, uid: str = U): return await transcribe(uid, body)

    @r.post("/media/uploads")
    async def _p31(body: MediaUploadIn, uid: str = U): return await create_upload(uid, body)

    @r.post("/media", status_code=status.HTTP_201_CREATED)
    async def _p31_direct(body: MediaDirectIn, response: Response, uid: str = U):
        result = await upload_direct(uid, body)
        if not result["created"]:
            response.status_code = status.HTTP_200_OK
        return result

    @r.post("/media/uploads/{upload_id}/complete")
    async def _p32(upload_id: str, body: Optional[MediaCompleteIn] = None, uid: str = U):
        return await complete_upload(uid, upload_id)

    @r.get("/media/{media_id}/access")
    async def _p33(media_id: str, uid: str = U): return await media_access(uid, media_id)

    @r.delete("/media/{media_id}")
    async def _p34(media_id: str, uid: str = U): return await delete_media(uid, media_id)

    @r.post("/reports", status_code=status.HTTP_201_CREATED)
    async def _report(body: ReportIn, uid: str = U): return await file_report(uid, body)

    @r.get("/me/notifications")
    async def _p35(cursor: Optional[str] = None, page_size: Optional[int] = PageQ, uid: str = U):
        return await list_notifications(uid, cursor, page_size)

    @r.get("/me/notifications/{notification_id}/target")
    async def _p36a(notification_id: str, uid: str = U): return await notification_target(uid, notification_id)

    @r.post("/me/notifications/{notification_id}/read")
    async def _p36b(notification_id: str, uid: str = U): return await mark_notification_read(uid, notification_id)

    return r
