"""
backend/main.py
Unified backend for Family Growth Radar.
- /api/*  : React Native frontend API (in-memory storage)
- /index /ask : Supabase pgvector RAG endpoints (optional)

Table of contents (search for the "── name ──" marker to jump to a section):
  Setup                  imports, env vars, optional Supabase/pypdf deps
  App                    FastAPI app, CORS, /api router
  In-memory stores       fallback storage used when Supabase is unavailable
  Auth helpers           password hashing, JWT issue/verify, uid dependencies
  Supabase persistence   DB-backed helpers for feed cards / favorites / collections
  Pydantic models        request/response schemas for /api/*
  Admin models           request schemas for /admin/*
  Static feed data       seed cards, chat scripts, per-card task templates
  Daily email push       SMTP sender + fallback conversation scripts
  NURI persona           system prompt for the NURI chat persona
  Input & memory         normalized_inputs logging + user_memories extraction/retrieval
  NURI AI helpers        chat reply / card generation / task generation via OpenAI
  Auth routes            /api/auth/*
  Children               /api/children*
  Feed                   /api/feed*
  Collections            /api/collections*
  Favorites              /api/favorites*
  Analytics              /api/analytics
  Chat                   /api/chat/sessions*
  Tasks                  /api/tasks*
  Privacy                /api/privacy*
  Legacy RAG routes      /, /health, /index, /ask (static + PDF ingest)
  RAG helper functions   PDF parsing, chunking, embeddings, retrieval
  Admin endpoints        /admin/books, /admin/settings, /admin/discover, /admin/style-rules
  Daily push admin       /admin/daily-push*
"""

import asyncio, io, json, os, time, uuid, hashlib, random, re
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta, date, time as dt_time
from typing import List, Literal, NamedTuple, Optional
from urllib.parse import urlparse

import anyio
import bcrypt
import jwt
from fastapi import FastAPI, APIRouter, BackgroundTasks, Depends, HTTPException, Header, Request, UploadFile, File, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from backend.nuri_core import CorePorts, PIPELINE_VERSION, TurnBundle, run_turn_context
from backend.nuri_core import dialogue as core_dialogue
from backend.nuri_core import family as core_family
from backend.nuri_core import family_store as core_family_store
from backend.nuri_core import dialogue_reply as core_dialogue_reply
from backend.nuri_core import knowledge_store as core_knowledge_store
from backend.nuri_core import outcome as core_outcome
from backend.nuri_core import provenance as core_provenance
from backend.router import NO_ROUTE, TurnRoute, route_metrics, route_turn
from backend.websearch import (
    get_provider as get_search_provider,
    load_domain_rules,
    search_sources,
    sources_prompt_block,
)
from pydantic import BaseModel, EmailStr, Field, field_validator
from starlette.background import BackgroundTask

try:
    from backend.content_library import (
        AUTHORITY_VIDEO_FORBIDDEN_PARENT_ORG_IDS,
        CASE_FORBIDDEN_PARENT_ORG_IDS,
        LEARNING_CONTENT_BY_ID,
        LEARNING_CONTENT_CARDS,
        ENGLISH_AUTHORITY_SOURCE_PARENT_ORG_IDS,
        FEATURED_FORBIDDEN_PARENT_ORG_IDS,
        US_AUTHORITY_SOURCE_PARENT_ORG_IDS,
        case_article_reader_experience_status,
        is_trusted_resource_url,
        order_learning_resources,
        resource_parent_org_id as policy_resource_parent_org_id,
        source_parent_org_id,
    )
    from backend.content_research import (
        CONTENT_CATEGORIES,
        MAX_TOTAL_RESEARCH_RESOURCES,
        MIN_TOTAL_RESEARCH_RESOURCES,
        DELIVERY_SOURCE_CONTRACT_VERSION,
        delivery_lane_rejection_reason,
        redact_conversation_text,
        research_learning_resources,
        reviewed_learning_resource_bundle,
        reviewed_resource_matches_context,
        summarize_resource_slots,
    )
    from backend.recommendation_snapshots import (
        build_snapshot,
        carry_prepared_resource_state,
        parse_snapshot,
        prepared_resource_pair,
        prepared_resource_pairs,
        serialize_snapshot,
        snapshot_with_active_resource_pair,
        snapshot_with_prepared_resource_pair,
        snapshot_with_prepared_resource_pairs,
        snapshot_with_resource_readiness,
        snapshot_storage_key,
        snapshot_storage_prefix,
        SNAPSHOT_CONTEXT_VERSION,
        SNAPSHOT_VERSION,
    )
    from backend.recommendation_feedback import (
        EVENT_RETENTION_DAYS,
        LEARNING_EVENT_NAMES,
        MAX_EVENTS_PER_USER,
        card_behavior_signal,
        category_preference_mix,
        event_storage_key,
        normalize_event,
        prune_events,
        recent_resource_urls,
        weighted_category_for_window,
    )
except ImportError:  # Supports `python backend/main.py` during local debugging.
    from content_library import (  # type: ignore
        AUTHORITY_VIDEO_FORBIDDEN_PARENT_ORG_IDS,
        CASE_FORBIDDEN_PARENT_ORG_IDS,
        LEARNING_CONTENT_BY_ID,
        LEARNING_CONTENT_CARDS,
        ENGLISH_AUTHORITY_SOURCE_PARENT_ORG_IDS,
        FEATURED_FORBIDDEN_PARENT_ORG_IDS,
        US_AUTHORITY_SOURCE_PARENT_ORG_IDS,
        case_article_reader_experience_status,
        is_trusted_resource_url,
        order_learning_resources,
        resource_parent_org_id as policy_resource_parent_org_id,
        source_parent_org_id,
    )
    from content_research import (  # type: ignore
        CONTENT_CATEGORIES,
        MAX_TOTAL_RESEARCH_RESOURCES,
        MIN_TOTAL_RESEARCH_RESOURCES,
        DELIVERY_SOURCE_CONTRACT_VERSION,
        delivery_lane_rejection_reason,
        redact_conversation_text,
        research_learning_resources,
        reviewed_learning_resource_bundle,
        reviewed_resource_matches_context,
        summarize_resource_slots,
    )
    from recommendation_snapshots import (  # type: ignore
        build_snapshot,
        carry_prepared_resource_state,
        parse_snapshot,
        prepared_resource_pair,
        prepared_resource_pairs,
        serialize_snapshot,
        snapshot_with_active_resource_pair,
        snapshot_with_prepared_resource_pair,
        snapshot_with_prepared_resource_pairs,
        snapshot_with_resource_readiness,
        snapshot_storage_key,
        snapshot_storage_prefix,
        SNAPSHOT_CONTEXT_VERSION,
        SNAPSHOT_VERSION,
    )
    from recommendation_feedback import (  # type: ignore
        EVENT_RETENTION_DAYS,
        LEARNING_EVENT_NAMES,
        MAX_EVENTS_PER_USER,
        card_behavior_signal,
        category_preference_mix,
        event_storage_key,
        normalize_event,
        prune_events,
        recent_resource_urls,
        weighted_category_for_window,
    )


# ── Runtime ──────────────────────────────────────────────────────────────────
# Configuration, the OpenAI clients and the Supabase handle live in
# backend/runtime.py so that modules other than this one can reach them without
# importing a file that builds a FastAPI app at import time. Re-exported here
# because a great deal of code — and several tests — still reads them off
# `backend.main`.
from backend.runtime import (  # noqa: E402
    ADMIN_KEY,
    APP_URL,
    Client,
    EMBED_DIM,
    FRONTEND_DIST,
    INTERNAL_MIN_SIMILARITY,
    INTERNAL_NAMESPACE,
    INTERNAL_TOP_K,
    JWT_ALG,
    JWT_EXP_MIN,
    JWT_SECRET,
    OPENAI_API_KEY,
    OPENAI_CONTENT_RESEARCH_CONCURRENCY,
    OPENAI_CONTENT_RESEARCH_MODEL,
    OPENAI_CONTENT_RESEARCH_TIMEOUT_S,
    OPENAI_FAST_TIMEOUT_S,
    OPENAI_MAX_RETRIES,
    OPENAI_TASKS_TIMEOUT_S,
    OPENAI_TIMEOUT_S,
    PdfReader,
    RECOMMENDATION_SNAPSHOT_SECRET,
    SMTP_FROM,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_USER,
    SUPABASE_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL,
    THREAD_LIMIT,
    VECTOR_NAMESPACE,
    VECTOR_TABLE,
    _SUPABASE_OK,
    aoai,
    content_research_limiter,
    content_research_oai,
    elapsed_ms as _ms,
    get_supabase as _get_supabase,
    now as _now,
    oai,
)

# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def _lifespan(_app: FastAPI):
    anyio.to_thread.current_default_thread_limiter().total_tokens = THREAD_LIMIT
    yield

app = FastAPI(title="Family Growth Radar API", lifespan=_lifespan)


@app.middleware("http")
async def _protect_personalized_feed_cache(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    is_private_feed = path.endswith("/feed/personalized") or bool(
        re.search(r"/feed/[^/]+/(?:detail|research)$", path)
    )
    if is_private_feed:
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Vary"] = "Authorization"
    return response
api = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory stores ─────────────────────────────────────────────────────────
_users_email: dict[str, dict] = {}     # email -> user doc
_users_id:    dict[str, dict] = {}     # id    -> user doc
_children:    list[dict]      = []
_sessions:    dict[str, dict] = {}     # session_id -> session doc
_messages:    dict[str, list] = {}     # session_id -> [msg, ...]
_tasks:       list[dict]      = []
_favorites:   dict[str, set]  = {}     # uid_or_anon -> {card_id, ...}
_collections: dict[str, list] = {}     # uid_or_anon -> [{id, name, created_at}]
_fav_cols:    dict[str, dict] = {}     # uid_or_anon -> {card_id: collection_id|None}
_analytics:   list[dict]      = []
_privacy:     dict[str, dict] = {}     # uid_or_singleton -> settings
_recommendation_snapshots: dict[tuple[str, str], dict] = {}
_recommendation_events: dict[str, list[dict]] = {}
_recommendation_event_locks: dict[str, asyncio.Lock] = {}
_recommendation_events_table_available: Optional[bool] = None
_feed_gen_mode: str           = "ai"  # fallback when Supabase is unavailable

_SUPPORTED_PREFERRED_LOCALES = frozenset({"zh-CN", "zh-TW", "en"})


def _normalize_preferred_locale(value: object) -> str:
    if value == "zh":
        return "zh-CN"
    if isinstance(value, str) and value in _SUPPORTED_PREFERRED_LOCALES:
        return value
    return "zh-CN"


def _with_requested_preferred_locale(
    context: dict,
    requested_locale: Optional[str],
) -> dict:
    """Apply a one-request resource locale without mutating saved privacy."""

    effective_locale = (
        requested_locale
        if requested_locale in _SUPPORTED_PREFERRED_LOCALES
        else _normalize_preferred_locale(context.get("preferred_locale"))
    )
    return {**context, "preferred_locale": effective_locale}


_DEFAULT_PRIVACY = {
    "allow_history_training": True,
    "allow_external_content_research": False,
    "daily_push": True,
    "anonymous_community_share": False,
    "language": "zh-CN",
}
_PRIVACY_STORAGE_UNAVAILABLE = "_storage_unavailable"

# ── Auth helpers ──────────────────────────────────────────────────────────────
_bearer = HTTPBearer(auto_error=False)

def _hash_pw(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()

def _verify_pw(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False

def _make_token(uid: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": uid, "iat": now, "exp": now + timedelta(minutes=JWT_EXP_MIN)},
        JWT_SECRET, algorithm=JWT_ALG,
    )

def _decode_token(token: str) -> Optional[str]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG]).get("sub")
    except jwt.PyJWTError:
        return None

async def _opt_uid(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> Optional[str]:
    if creds and creds.scheme.lower() == "bearer":
        return _decode_token(creds.credentials)
    return None

async def _req_uid(creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer)) -> str:
    uid = await _opt_uid(creds)
    if not uid:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing or invalid token",
                            headers={"WWW-Authenticate": "Bearer"})
    return uid

def _to_public(doc: dict) -> dict:
    # .get, not [k]: parent_role is absent when unanswered, and a KeyError here
    # would 500 /auth/me — which the client reads as a dead session.
    base = {k: doc.get(k) for k in ("id","email","nickname","city","parent_role","top_concerns","created_at")}
    base.update({
        "concern_other":        doc.get("concern_other", ""),
        "hobbies":              doc.get("hobbies", ""),
        "help_preference":      doc.get("help_preference", ""),
        "info_source":          doc.get("info_source", ""),
        "content_frequency":    doc.get("content_frequency", ""),
        "onboarding_completed": bool(doc.get("onboarding_completed", False)),
    })
    return base

# ── Supabase persistence helpers ──────────────────────────────────────────────

async def _db_get_gen_cards() -> list[dict]:
    sb = _get_supabase()
    if not sb:
        return []
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("feed_cards").select("*").order("created_at", desc=True).limit(50).execute()
        )
        return res.data or []
    except Exception as e:
        print(f"[warn] _db_get_gen_cards: {e}")
        return []

async def _db_save_gen_cards(cards: list[dict]):
    sb = _get_supabase()
    if not sb or not cards:
        return
    # Replace previous batch — delete all stored gen cards first
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("feed_cards").delete().eq("source", "ai").execute()
        )
    except Exception as e:
        print(f"[warn] _db_save_gen_cards delete: {e}")
    rows = [
        {
            "id": card["id"], "type": card["type"], "type_label": card["type_label"],
            "cta": card.get("cta", "问问AI →"), "title": card["title"],
            "summary": card.get("summary", ""), "body": card.get("body", ""),
            "tags": card.get("tags", []), "hook_line": card.get("hook_line", ""),
            "image_url": card.get("image_url", ""), "keywords": card.get("keywords", []),
            "source": card.get("source", "ai"), "created_at": _now(),
        }
        for card in cards
    ]
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("feed_cards").insert(rows).execute()
        )
    except Exception as e:
        print(f"[warn] _db_save_gen_cards insert: {e}")

async def _db_get_feed_mode() -> str:
    sb = _get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings").select("value").eq("key", "feed_gen_mode").maybe_single().execute()
            )
            if res.data:
                return str(res.data.get("value", "ai"))
        except Exception as e:
            print(f"[warn] _db_get_feed_mode: {e}")
    return _feed_gen_mode

async def _db_set_feed_mode(mode: str):
    global _feed_gen_mode
    _feed_gen_mode = mode
    sb = _get_supabase()
    if sb:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings").upsert(
                    {"key": "feed_gen_mode", "value": mode, "updated_at": _now()},
                    on_conflict="key"
                ).execute()
            )
        except Exception as e:
            print(f"[warn] _db_set_feed_mode: {e}")


def _normalized_privacy_settings(value: object) -> dict:
    settings = dict(_DEFAULT_PRIVACY)
    if not isinstance(value, dict):
        return settings
    for key in (
        "allow_history_training",
        "allow_external_content_research",
        "daily_push",
        "anonymous_community_share",
    ):
        if isinstance(value.get(key), bool):
            settings[key] = value[key]
    settings["language"] = _normalize_preferred_locale(value.get("language"))
    return settings


def _privacy_storage_key(uid: str) -> str:
    # app_settings predates per-user preferences and may be visible to broader
    # database roles in older installations. Do not place a raw user ID in it.
    digest = hashlib.sha256(uid.encode("utf-8")).hexdigest()
    return f"user_privacy:{digest}"


async def _db_get_privacy(uid: Optional[str], fail_closed: bool = False) -> dict:
    """Load per-user privacy settings from the existing app_settings table.

    Namespaced keys avoid a new migration while still surviving Vercel cold
    starts. If storage is temporarily unavailable and no warm cache exists,
    conversation personalization fails closed.
    """

    key = uid or "singleton"
    cached = _privacy.get(key)
    sb = _get_supabase()
    if sb and uid:
        try:
            result = await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings")
                .select("value")
                .eq("key", _privacy_storage_key(uid))
                .limit(1)
                .execute()
            )
            rows = list(getattr(result, "data", None) or [])
            if rows:
                stored_value = rows[0].get("value")
                if isinstance(stored_value, str):
                    stored_value = json.loads(stored_value)
                settings = _normalized_privacy_settings(stored_value)
                _privacy[key] = settings
                return settings

            # A successful query with no row means this user has never changed
            # the default.  It is not a storage failure and must not be
            # presented as an explicit privacy opt-out.  The database is the
            # source of truth, so also replace any stale process-local value.
            settings = dict(_DEFAULT_PRIVACY)
            _privacy[key] = settings
            return settings
        except Exception as exc:
            print(f"[warn] _db_get_privacy: {exc}")
            if fail_closed:
                return {
                    **_DEFAULT_PRIVACY,
                    "allow_history_training": False,
                    _PRIVACY_STORAGE_UNAVAILABLE: True,
                }
    elif uid and fail_closed:
        return {
            **_DEFAULT_PRIVACY,
            "allow_history_training": False,
            _PRIVACY_STORAGE_UNAVAILABLE: True,
        }
    return _normalized_privacy_settings(cached)


async def _db_set_privacy(uid: Optional[str], settings: dict) -> dict:
    key = uid or "singleton"
    normalized = _normalized_privacy_settings(settings)
    previous = _privacy.get(key)
    _privacy[key] = normalized
    sb = _get_supabase()
    if uid and not sb:
        if previous is None:
            _privacy.pop(key, None)
        else:
            _privacy[key] = previous
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Privacy settings could not be saved",
        )
    if sb and uid:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings").upsert(
                    {
                        "key": _privacy_storage_key(uid),
                        "value": json.dumps(normalized, ensure_ascii=False),
                        "updated_at": _now(),
                    },
                    on_conflict="key",
                ).execute()
            )
        except Exception as exc:
            if previous is None:
                _privacy.pop(key, None)
            else:
                _privacy[key] = previous
            print(f"[warn] _db_set_privacy: {exc}")
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Privacy settings could not be saved",
            ) from exc
    return normalized


async def _db_delete_privacy(uid: str) -> None:
    _privacy.pop(uid, None)
    sb = _get_supabase()
    if not sb:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Privacy settings could not be deleted",
        )
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .eq("key", _privacy_storage_key(uid))
            .execute()
        )
    except Exception as exc:
        print(f"[warn] _db_delete_privacy: {exc}")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Privacy settings could not be deleted",
        ) from exc


async def _db_persist_recommendation_snapshots(
    uid: str,
    snapshots: list[dict],
) -> bool:
    """Atomically persist encrypted recommendation snapshots when storage exists."""

    if not snapshots:
        return True
    sb = _get_supabase()
    if not sb or not RECOMMENDATION_SNAPSHOT_SECRET:
        return False
    ready_snapshots = [
        snapshot for snapshot in snapshots if prepared_resource_pair(snapshot)
    ]
    nonready_snapshots = [
        snapshot for snapshot in snapshots if not prepared_resource_pair(snapshot)
    ]

    def rows_for(values: list[dict]) -> list[dict]:
        return [
            {
                "key": snapshot_storage_key(uid, snapshot["recommendation_id"]),
                "value": serialize_snapshot(
                    snapshot,
                    secret=RECOMMENDATION_SNAPSHOT_SECRET,
                ),
                "updated_at": _now(),
            }
            for snapshot in values
        ]

    try:
        if nonready_snapshots:
            nonready_rows = rows_for(nonready_snapshots)
            # DO NOTHING on conflict is the monotonicity boundary. An old
            # preparing/retryable/feed write can create a snapshot, but can
            # never replace a complete pair published by a newer invocation.
            await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings")
                .upsert(
                    nonready_rows,
                    on_conflict="key",
                    ignore_duplicates=True,
                )
                .execute()
            )
        if ready_snapshots:
            ready_rows = rows_for(ready_snapshots)
            await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings")
                .upsert(ready_rows, on_conflict="key")
                .execute()
            )
    except Exception as exc:
        print(f"[warn] recommendation snapshot persistence failed: {exc}")
        return False

    for snapshot in ready_snapshots:
        _recommendation_snapshots[(uid, snapshot["recommendation_id"])] = snapshot
    # Resolve insert-vs-conflict from durable storage before caching or exposing
    # a non-ready snapshot. Only a complete durable pair is allowed to replace
    # the caller's state. If storage still says ``preparing``, a provider
    # failure in this invocation must remain ``retryable`` in the response so
    # the client can schedule another attempt.
    for snapshot in nonready_snapshots:
        current = await _db_get_recommendation_snapshot_persistent(
            uid,
            snapshot["recommendation_id"],
        )
        if current and prepared_resource_pair(current):
            snapshot.clear()
            snapshot.update(current)
        _recommendation_snapshots[(uid, snapshot["recommendation_id"])] = snapshot
    return True



async def _db_get_recommendation_snapshot(
    uid: str,
    recommendation_id: Optional[str],
) -> Optional[dict]:
    if not recommendation_id:
        return None
    try:
        snapshot_storage_key(uid, recommendation_id)
    except ValueError:
        return None

    cached = parse_snapshot(_recommendation_snapshots.get((uid, recommendation_id)))
    try:
        snapshot = await _db_get_recommendation_snapshot_persistent(
            uid,
            recommendation_id,
        )
    except HTTPException:
        if cached:
            return cached
        raise
    if snapshot:
        _recommendation_snapshots[(uid, recommendation_id)] = snapshot
        return snapshot
    return cached


async def _db_get_recommendation_snapshot_persistent(
    uid: str,
    recommendation_id: Optional[str],
) -> Optional[dict]:
    """Read storage directly so stale process state cannot downgrade ready data."""

    if not recommendation_id:
        return None
    try:
        key = snapshot_storage_key(uid, recommendation_id)
    except ValueError:
        return None
    sb = _get_supabase()
    if not sb:
        return None
    try:
        result = await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .select("value")
            .eq("key", key)
            .limit(1)
            .execute()
        )
        rows = list(getattr(result, "data", None) or [])
        snapshot = (
            parse_snapshot(
                rows[0].get("value"),
                secret=RECOMMENDATION_SNAPSHOT_SECRET,
            )
            if rows and RECOMMENDATION_SNAPSHOT_SECRET
            else None
        )
        return snapshot
    except Exception as exc:
        print(f"[warn] recommendation snapshot lookup failed: {exc}")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation context is temporarily unavailable",
        ) from exc


async def _db_delete_recommendation_snapshots(uid: str) -> None:
    for cache_key in [key for key in _recommendation_snapshots if key[0] == uid]:
        _recommendation_snapshots.pop(cache_key, None)
    sb = _get_supabase()
    if not sb:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation history could not be deleted",
        )
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .like("key", f"{snapshot_storage_prefix(uid)}%")
            .execute()
        )
    except Exception as exc:
        print(f"[warn] recommendation snapshot delete failed: {exc}")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation history could not be deleted",
        ) from exc


_RECOMMENDATION_EVENTS_TABLE = "recommendation_events"
_RECOMMENDATION_EVENTS_LIMIT = MAX_EVENTS_PER_USER
_RECOMMENDATION_EVENTS_CLEANUP_PAGE = 1000
_RECOMMENDATION_EVENTS_DELETE_BATCH = 50


def _recommendation_events_table_missing(exc: Exception) -> bool:
    """Recognise the PostgREST/Postgres errors emitted before migration.

    Only an absent table activates the legacy JSON fallback. Other database
    failures must not silently resume read/modify/write persistence, because
    doing so would reintroduce cross-instance lost updates.
    """

    code = str(getattr(exc, "code", "") or "").upper()
    details = " ".join(
        str(value)
        for value in (
            exc,
            getattr(exc, "message", ""),
            getattr(exc, "details", ""),
        )
    ).casefold()
    if code in {"42P01", "PGRST205"}:
        return True
    return "recommendation_events" in details and any(
        marker in details
        for marker in (
            "does not exist",
            "could not find",
            "schema cache",
            "undefined table",
            "undefined_table",
        )
    )


def _recommendation_event_row(uid: str, event: dict) -> dict:
    """Map a normalized signal to one append-only database row."""

    metadata = {
        key: value
        for key, value in event.items()
        if key not in {"event_id", "event", "card_id", "occurred_at"}
    }
    return {
        "user_id": uid,
        "event_id": str(event["event_id"]),
        "event_type": str(event["event"]),
        "card_id": str(event["card_id"]),
        "occurred_at": str(event["occurred_at"]),
        "event_data": metadata,
    }


def _recommendation_event_setting_prefix(uid: str) -> str:
    """Return the non-identifying per-event fallback key prefix."""

    user_digest = hashlib.sha256(uid.encode("utf-8")).hexdigest()
    return f"recommendation_event:v2:{user_digest}:"


def _recommendation_event_setting_key(uid: str, event_id: str) -> str:
    event_digest = hashlib.sha256(event_id.encode("utf-8")).hexdigest()
    return f"{_recommendation_event_setting_prefix(uid)}{event_digest}"


def _recommendation_event_setting_rows(uid: str, events: list[dict]) -> list[dict]:
    """Map events to independently upsertable app_settings rows."""

    return [
        {
            "key": _recommendation_event_setting_key(uid, str(event["event_id"])),
            "value": json.dumps(event, ensure_ascii=False),
            "updated_at": str(event["occurred_at"]),
        }
        for event in events
    ]


def _recommendation_event_retention_cutoff() -> str:
    """Return the UTC cutoff shared by logical and physical retention."""

    return (
        datetime.now(timezone.utc) - timedelta(days=EVENT_RETENTION_DAYS)
    ).isoformat()


async def _db_cleanup_recommendation_event_table(sb: object, uid: str) -> None:
    """Physically enforce age and count retention in the migrated row table.

    The stale delete is handled entirely by PostgREST.  Overflow is paged from
    the first row beyond the newest bounded history and removed in batches;
    repeatedly reading from the same offset also handles histories larger than
    PostgREST's normal 1,000-row response cap.
    """

    cutoff = _recommendation_event_retention_cutoff()
    await anyio.to_thread.run_sync(
        lambda: sb.table(_RECOMMENDATION_EVENTS_TABLE)
        .delete()
        .eq("user_id", uid)
        .lt("occurred_at", cutoff)
        .execute()
    )
    while True:
        result = await anyio.to_thread.run_sync(
            lambda: sb.table(_RECOMMENDATION_EVENTS_TABLE)
            .select("event_id")
            .eq("user_id", uid)
            .order("occurred_at", desc=True)
            .range(
                _RECOMMENDATION_EVENTS_LIMIT,
                _RECOMMENDATION_EVENTS_LIMIT
                + _RECOMMENDATION_EVENTS_CLEANUP_PAGE
                - 1,
            )
            .execute()
        )
        event_ids = [
            str(row.get("event_id"))
            for row in list(getattr(result, "data", None) or [])
            if isinstance(row, dict) and row.get("event_id")
        ]
        if not event_ids:
            return
        for start in range(0, len(event_ids), _RECOMMENDATION_EVENTS_DELETE_BATCH):
            batch = event_ids[start : start + _RECOMMENDATION_EVENTS_DELETE_BATCH]
            await anyio.to_thread.run_sync(
                lambda batch=batch: sb.table(_RECOMMENDATION_EVENTS_TABLE)
                .delete()
                .eq("user_id", uid)
                .in_("event_id", batch)
                .execute()
            )


async def _db_cleanup_recommendation_event_settings(sb: object, uid: str) -> None:
    """Physically enforce retention for migration-free atomic v2 rows."""

    prefix = _recommendation_event_setting_prefix(uid)
    cutoff = _recommendation_event_retention_cutoff()
    await anyio.to_thread.run_sync(
        lambda: sb.table("app_settings")
        .delete()
        .like("key", f"{prefix}%")
        .lt("updated_at", cutoff)
        .execute()
    )
    while True:
        result = await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .select("key")
            .like("key", f"{prefix}%")
            .order("updated_at", desc=True)
            .range(
                _RECOMMENDATION_EVENTS_LIMIT,
                _RECOMMENDATION_EVENTS_LIMIT
                + _RECOMMENDATION_EVENTS_CLEANUP_PAGE
                - 1,
            )
            .execute()
        )
        keys = [
            str(row.get("key"))
            for row in list(getattr(result, "data", None) or [])
            if isinstance(row, dict) and row.get("key")
        ]
        if not keys:
            break
        for start in range(0, len(keys), _RECOMMENDATION_EVENTS_DELETE_BATCH):
            batch = keys[start : start + _RECOMMENDATION_EVENTS_DELETE_BATCH]
            await anyio.to_thread.run_sync(
                lambda batch=batch: sb.table("app_settings")
                .delete()
                .like("key", f"{prefix}%")
                .in_("key", batch)
                .execute()
            )

    # v1 is no longer appended, so compacting its single legacy JSON value
    # cannot race with a writer.  Keep it only for rollout compatibility while
    # enforcing the same physical age/count boundary as both append-only paths.
    legacy_key = event_storage_key(uid)
    legacy_result = await anyio.to_thread.run_sync(
        lambda: sb.table("app_settings")
        .select("value")
        .eq("key", legacy_key)
        .limit(1)
        .execute()
    )
    legacy_rows = list(getattr(legacy_result, "data", None) or [])
    if not legacy_rows:
        return
    legacy: object = (
        legacy_rows[0].get("value")
        if isinstance(legacy_rows[0], dict)
        else None
    )
    if isinstance(legacy, str):
        try:
            legacy = json.loads(legacy)
        except (TypeError, ValueError):
            legacy = []
    retained = prune_events(legacy)
    if retained == legacy:
        return
    if not retained:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .eq("key", legacy_key)
            .execute()
        )
        return
    await anyio.to_thread.run_sync(
        lambda: sb.table("app_settings")
        .upsert(
            {
                "key": legacy_key,
                "value": json.dumps(retained, ensure_ascii=False),
                "updated_at": _now(),
            },
            on_conflict="key",
        )
        .execute()
    )


async def _db_cleanup_recommendation_events_best_effort(
    sb: object,
    uid: str,
    *,
    include_row_table: bool,
) -> None:
    """Run retention without changing the success of an already-stored event."""

    if include_row_table:
        try:
            await _db_cleanup_recommendation_event_table(sb, uid)
        except Exception as exc:
            print(
                "[warn] recommendation event row retention cleanup failed: "
                f"{type(exc).__name__}"
            )
    # Clean rollout fallback rows even after the table becomes available so an
    # environment cannot retain old v2 rows forever following its migration.
    try:
        await _db_cleanup_recommendation_event_settings(sb, uid)
    except Exception as exc:
        print(
            "[warn] settings recommendation event retention cleanup failed: "
            f"{type(exc).__name__}"
        )


def _recommendation_event_from_row(row: object) -> Optional[dict]:
    """Restore and revalidate a signal loaded from the row table."""

    if not isinstance(row, dict):
        return None
    metadata: object = row.get("event_data")
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (TypeError, ValueError):
            metadata = {}
    payload = dict(metadata) if isinstance(metadata, dict) else {}
    event_type = row.get("event_type")
    payload.update(
        {
            "event_id": row.get("event_id"),
            "event": event_type,
            "card_id": row.get("card_id"),
        }
    )
    occurred_at = row.get("occurred_at")
    if isinstance(occurred_at, datetime):
        occurred_at = occurred_at.isoformat()
    if not isinstance(occurred_at, str):
        return None
    return normalize_event(
        payload,
        occurred_at=occurred_at,
        trusted_resource_url=event_type == "resource_delivered",
    )


async def _db_get_recommendation_events_settings(
    uid: str,
    *,
    cached: Optional[list[dict]] = None,
) -> list[dict]:
    """Read atomic per-event settings plus the read-only legacy JSON value."""

    sb = _get_supabase()
    if not sb:
        return prune_events(cached or [])
    try:
        per_event_result = await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .select("value")
            .like("key", f"{_recommendation_event_setting_prefix(uid)}%")
            .order("updated_at", desc=True)
            .limit(_RECOMMENDATION_EVENTS_LIMIT)
            .execute()
        )
        legacy_result = await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .select("value")
            .eq("key", event_storage_key(uid))
            .limit(1)
            .execute()
        )
        per_event_rows = list(getattr(per_event_result, "data", None) or [])
        stored_events: list[object] = []
        for row in per_event_rows:
            stored: object = row.get("value") if isinstance(row, dict) else None
            if isinstance(stored, str):
                try:
                    stored = json.loads(stored)
                except (TypeError, ValueError):
                    continue
            stored_events.append(stored)

        # v1 was one mutable JSON array. It remains read-only so an in-flight
        # migration cannot lose old learning signals, but all new writes use a
        # unique v2 key per event.
        legacy_rows = list(getattr(legacy_result, "data", None) or [])
        legacy: object = legacy_rows[0].get("value") if legacy_rows else []
        if isinstance(legacy, str):
            try:
                legacy = json.loads(legacy)
            except (TypeError, ValueError):
                legacy = []
        if isinstance(legacy, list):
            stored_events.extend(legacy)
        return prune_events(stored_events)
    except Exception as exc:
        print(f"[warn] settings recommendation event lookup failed: {type(exc).__name__}")
        return prune_events(cached or [])


async def _db_get_recommendation_events(uid: str) -> list[dict]:
    """Load bounded, privacy-safe recommendation behaviour for one user."""

    global _recommendation_events_table_available
    cached = _recommendation_events.get(uid)
    sb = _get_supabase()
    if not sb:
        return prune_events(cached or [])
    if _recommendation_events_table_available is False:
        events = await _db_get_recommendation_events_settings(uid, cached=cached)
        _recommendation_events[uid] = events
        return events
    try:
        result = await anyio.to_thread.run_sync(
            lambda: sb.table(_RECOMMENDATION_EVENTS_TABLE)
            .select("event_id,event_type,card_id,occurred_at,event_data")
            .eq("user_id", uid)
            .order("occurred_at", desc=True)
            .limit(_RECOMMENDATION_EVENTS_LIMIT)
            .execute()
        )
        rows = list(getattr(result, "data", None) or [])
        row_events = [
            event for row in rows if (event := _recommendation_event_from_row(row))
        ]
        # Continue reading rollout rows after the table appears. This closes the
        # deployment window where one instance has already discovered the new
        # table while another has just written an atomic v2 settings row.
        settings_events = await _db_get_recommendation_events_settings(uid)
        events = prune_events(
            [*row_events, *settings_events]
        )
        _recommendation_events_table_available = True
        _recommendation_events[uid] = events
        return events
    except Exception as exc:
        if _recommendation_events_table_missing(exc):
            _recommendation_events_table_available = False
            events = await _db_get_recommendation_events_settings(uid, cached=cached)
            _recommendation_events[uid] = events
            return events
        # Feedback may refine a recommendation but must never make the home feed
        # unavailable. A warm process can still use its bounded local copy.
        print(f"[warn] recommendation event lookup failed: {type(exc).__name__}")
        return prune_events(cached or [])


async def _db_append_recommendation_events(
    uid: str,
    payloads: list[dict],
) -> tuple[list[dict], bool]:
    """Atomically append idempotent event rows across backend instances."""

    global _recommendation_events_table_available
    if not payloads:
        return await _db_get_recommendation_events(uid), True
    lock = _recommendation_event_locks.setdefault(uid, asyncio.Lock())
    async with lock:
        existing = await _db_get_recommendation_events(uid)
        known_ids = {
            str(item.get("event_id") or "")
            for item in existing
            if item.get("event_id")
        }
        merged = list(existing)
        prepared: list[dict] = []
        for payload in payloads:
            item = dict(payload)
            event_id = str(item.get("event_id") or uuid.uuid4())[:80]
            item["event_id"] = event_id
            if event_id and event_id in known_ids:
                continue
            merged.append(item)
            prepared.append(item)
            if event_id:
                known_ids.add(event_id)
        merged = prune_events(merged)
        _recommendation_events[uid] = merged

        if not prepared:
            return merged, True

        sb = _get_supabase()
        if not sb:
            return merged, False
        if _recommendation_events_table_available is False:
            try:
                await anyio.to_thread.run_sync(
                    lambda: sb.table("app_settings").upsert(
                        _recommendation_event_setting_rows(uid, prepared),
                        on_conflict="key",
                        ignore_duplicates=True,
                    ).execute()
                )
                await _db_cleanup_recommendation_events_best_effort(
                    sb,
                    uid,
                    include_row_table=False,
                )
                stored = await _db_get_recommendation_events_settings(
                    uid,
                    cached=merged,
                )
                _recommendation_events[uid] = stored
                return stored, True
            except Exception as settings_exc:
                print(
                    "[warn] settings recommendation event persistence failed: "
                    f"{type(settings_exc).__name__}"
                )
                return merged, False
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table(_RECOMMENDATION_EVENTS_TABLE)
                .upsert(
                    [_recommendation_event_row(uid, event) for event in prepared],
                    on_conflict="user_id,event_id",
                    ignore_duplicates=True,
                )
                .execute()
            )
            _recommendation_events_table_available = True
            await _db_cleanup_recommendation_events_best_effort(
                sb,
                uid,
                include_row_table=True,
            )
            # Re-read so this process immediately sees events appended by other
            # instances between its initial read and atomic insert.
            return await _db_get_recommendation_events(uid), True
        except Exception as exc:
            if _recommendation_events_table_missing(exc):
                _recommendation_events_table_available = False
                # The migration-free fallback still appends atomically: every
                # event owns a unique app_settings key. Never rewrite the old
                # per-user JSON array, which could lose concurrent events.
                try:
                    await anyio.to_thread.run_sync(
                        lambda: sb.table("app_settings").upsert(
                            _recommendation_event_setting_rows(uid, prepared),
                            on_conflict="key",
                            ignore_duplicates=True,
                        ).execute()
                    )
                    await _db_cleanup_recommendation_events_best_effort(
                        sb,
                        uid,
                        include_row_table=False,
                    )
                    stored = await _db_get_recommendation_events_settings(
                        uid,
                        cached=merged,
                    )
                    _recommendation_events[uid] = stored
                    return stored, True
                except Exception as settings_exc:
                    print(
                        "[warn] settings recommendation event persistence failed: "
                        f"{type(settings_exc).__name__}"
                    )
                    return merged, False
            print(f"[warn] recommendation event persistence failed: {type(exc).__name__}")
            return merged, False


async def _db_delete_recommendation_events(uid: str) -> None:
    global _recommendation_events_table_available
    _recommendation_events.pop(uid, None)
    _recommendation_event_locks.pop(uid, None)
    sb = _get_supabase()
    if not sb:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation feedback could not be deleted",
        )
    if _recommendation_events_table_available is not False:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table(_RECOMMENDATION_EVENTS_TABLE)
                .delete()
                .eq("user_id", uid)
                .execute()
            )
            _recommendation_events_table_available = True
        except Exception as exc:
            if _recommendation_events_table_missing(exc):
                _recommendation_events_table_available = False
            else:
                print(f"[warn] recommendation event delete failed: {exc}")
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    "Recommendation feedback could not be deleted",
                ) from exc

    # Delete both the atomic v2 fallback rows and read-only v1 compatibility
    # value. Once every environment has the new table these remain harmless
    # no-ops and guarantee privacy erasure of rollout data.
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .like("key", f"{_recommendation_event_setting_prefix(uid)}%")
            .execute()
        )
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings")
            .delete()
            .eq("key", event_storage_key(uid))
            .execute()
        )
    except Exception as exc:
        print(f"[warn] settings recommendation event delete failed: {exc}")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation feedback could not be deleted",
        ) from exc


def _new_recommendation_event(
    *,
    event: str,
    card_id: str,
    trusted_resource_url: bool = False,
    **payload: object,
) -> dict:
    occurred_at = _now()
    normalized = normalize_event(
        {
            "event_id": str(uuid.uuid4()),
            "event": event,
            "card_id": card_id,
            **payload,
        },
        occurred_at=occurred_at,
        trusted_resource_url=trusted_resource_url,
    )
    if not normalized:  # All server-created callers use the allowlist.
        raise ValueError("invalid recommendation event")
    return normalized


async def _db_list_fav_ids(uid: str) -> set:
    sb = _get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").select("card_id").eq("user_id", uid).execute()
            )
            return {r["card_id"] for r in (res.data or [])}
        except Exception as e:
            print(f"[warn] _db_list_fav_ids: {e}")
    return _favorites.get(uid, set())

async def _db_toggle_fav(uid: str, card_id: str) -> bool:
    sb = _get_supabase()
    if sb:
        try:
            existing = await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").select("id").eq("user_id", uid).eq("card_id", card_id).execute()
            )
            if existing.data:
                await anyio.to_thread.run_sync(
                    lambda: sb.table("favorites").delete().eq("user_id", uid).eq("card_id", card_id).execute()
                )
                return False
            await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").insert({"user_id": uid, "card_id": card_id}).execute()
            )
            return True
        except Exception as e:
            print(f"[warn] _db_toggle_fav: {e}")
    # fallback
    _favorites.setdefault(uid, set())
    if card_id in _favorites[uid]:
        _favorites[uid].discard(card_id)
        return False
    _favorites[uid].add(card_id)
    return True

async def _db_list_collections(uid: str) -> list:
    sb = _get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("collections").select("id,name,created_at").eq("user_id", uid).order("created_at").execute()
            )
            return res.data or []
        except Exception as e:
            print(f"[warn] _db_list_collections: {e}")
    return _collections.get(uid, [])

async def _db_create_collection(uid: str, name: str) -> dict:
    now = _now()
    sb = _get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("collections").insert({"user_id": uid, "name": name}).execute()
            )
            return res.data[0]
        except Exception as e:
            print(f"[warn] _db_create_collection: {e}")
    col = {"id": str(uuid.uuid4()), "name": name, "created_at": now}
    _collections.setdefault(uid, []).append(col)
    return col

async def _db_rename_collection(uid: str, col_id: str, name: str) -> bool:
    sb = _get_supabase()
    if sb:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("collections").update({"name": name}).eq("id", col_id).eq("user_id", uid).execute()
            )
            return True
        except Exception as e:
            print(f"[warn] _db_rename_collection: {e}")
    for col in _collections.get(uid, []):
        if col["id"] == col_id:
            col["name"] = name
            return True
    return False

async def _db_delete_collection(uid: str, col_id: str) -> bool:
    sb = _get_supabase()
    if sb:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("collections").delete().eq("id", col_id).eq("user_id", uid).execute()
            )
            return True
        except Exception as e:
            print(f"[warn] _db_delete_collection: {e}")
    cols = _collections.get(uid, [])
    _collections[uid] = [c for c in cols if c["id"] != col_id]
    return True

async def _db_save_fav(uid: str, card_id: str, collection_id: str) -> bool:
    """Save card to collection. If already in that collection, removes it (toggle). Returns saved state."""
    sb = _get_supabase()
    if sb:
        try:
            existing = await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").select("id,collection_id").eq("user_id", uid).eq("card_id", card_id).execute()
            )
            if existing.data:
                row = existing.data[0]
                if row.get("collection_id") == collection_id:
                    await anyio.to_thread.run_sync(
                        lambda: sb.table("favorites").delete().eq("user_id", uid).eq("card_id", card_id).execute()
                    )
                    return False
                await anyio.to_thread.run_sync(
                    lambda: sb.table("favorites").update({"collection_id": collection_id}).eq("user_id", uid).eq("card_id", card_id).execute()
                )
                return True
            await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").insert({"user_id": uid, "card_id": card_id, "collection_id": collection_id}).execute()
            )
            return True
        except Exception as e:
            print(f"[warn] _db_save_fav: {e}")
    # fallback in-memory
    _favorites.setdefault(uid, set())
    _fav_cols.setdefault(uid, {})
    if card_id in _favorites[uid] and _fav_cols[uid].get(card_id) == collection_id:
        _favorites[uid].discard(card_id)
        _fav_cols[uid].pop(card_id, None)
        return False
    _favorites[uid].add(card_id)
    _fav_cols[uid][card_id] = collection_id
    return True

# ── Pydantic models ───────────────────────────────────────────────────────────
ParentRole = Literal["mom", "dad", "grandparent", "other"]
Concern    = Literal[
    "sleep", "food", "emotion", "development", "parenting",
    "health", "childcare", "family", "unknown", "other",
]

class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6)
    nickname: str = ""
    city: str = ""
    # Nothing in the signup or onboarding flow asks for this, so it has no
    # default: guessing "mom" put a wrong fact in the prompt for every dad and
    # grandparent. Left unset, the profile block simply omits the role.
    parent_role: Optional[ParentRole] = None
    top_concerns: List[Concern] = Field(default_factory=list)

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserUpdate(BaseModel):
    nickname:     Optional[str]          = None
    city:         Optional[str]          = None
    parent_role:  Optional[ParentRole]   = None
    top_concerns: Optional[List[Concern]] = None
    concern_other:      Optional[str]  = None
    hobbies:            Optional[str]  = None
    help_preference:    Optional[str]  = None
    info_source:        Optional[str]  = None
    content_frequency:  Optional[str]  = None
    onboarding_completed: Optional[bool] = None

class ChildCreate(BaseModel):
    nickname:   str
    birth_date: date
    gender: Literal["boy","girl","other"] = "other"
    allergies: List[str] = Field(default_factory=list)
    notes: str = ""

    @field_validator("birth_date")
    @classmethod
    def validate_birth_date(cls, value: date) -> date:
        if value > date.today():
            raise ValueError("birth_date cannot be in the future")
        return value

class FavToggle(BaseModel):
    card_id: str

class FavSave(BaseModel):
    card_id:       str
    collection_id: str

class CollectionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=20)

class CollectionRename(BaseModel):
    name: str = Field(..., min_length=1, max_length=20)

class AnalyticsIn(BaseModel):
    event:     str
    card_id:   Optional[str] = None
    card_type: Optional[str] = None
    value:     Optional[int] = None


class RecommendationEventIn(BaseModel):
    """Strict, text-free contract for recommendation learning signals."""

    client_event_id: Optional[str] = Field(None, min_length=8, max_length=80)
    event: Literal[
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
        "content_refresh",
    ]
    card_id: str = Field(..., min_length=1, max_length=128)
    recommendation_id: Optional[str] = Field(None, max_length=128)
    feed_request_id: Optional[str] = Field(None, max_length=80)
    resource_id: Optional[str] = Field(None, max_length=160)
    resource_url: Optional[str] = Field(None, max_length=2048)
    resource_kind: Optional[Literal["article", "video"]] = None
    content_category: Optional[Literal["authority", "featured", "case"]] = None
    locale: Optional[Literal["zh-CN", "zh-TW", "en"]] = None
    position: Optional[int] = Field(None, ge=0, le=50)
    duration_ms: Optional[int] = Field(None, ge=0, le=1_800_000)
    value: Optional[int] = Field(None, ge=-1, le=1)
    reason: Optional[
        Literal[
            "topic_mismatch",
            "already_seen",
            "repetitive",
            "wrong_language",
            "source_not_useful",
            "not_now",
            "too_long",
            "too_commercial",
        ]
    ] = None

class StartChatRequest(BaseModel):
    card_id:    Optional[str] = None
    title:      Optional[str] = None
    script_key: Optional[str] = None

class UserMessageIn(BaseModel):
    text:         Optional[str] = ""
    image_base64: Optional[str] = None

class TaskCreate(BaseModel):
    title:       str
    description: Optional[str] = ""
    steps:       Optional[list[str]] = None
    task_type:   Optional[str] = "interaction"
    scope:       Literal["today", "week"] = "today"
    due_date:    Optional[str] = None
    source_message_id: Optional[str] = Field(None, max_length=128)
    suggestion_index: Optional[int] = Field(None, ge=0, le=20)

class TaskUpdate(BaseModel):
    done: Optional[bool] = None
    mood: Optional[str]  = None
    note: Optional[str]  = None
    is_favorited: Optional[bool] = None
    backfilled: Optional[bool] = None

class PrivacySettings(BaseModel):
    allow_history_training:   bool = True
    allow_external_content_research: bool = False
    daily_push:               bool = True
    anonymous_community_share: bool = False
    language: Literal["zh", "zh-CN", "zh-TW", "en"] = "zh-CN"


class ResearchPrepareItem(BaseModel):
    card_id: str = Field(min_length=1, max_length=128)
    recommendation_id: str = Field(min_length=1, max_length=80)


class ResearchPrepareRequest(BaseModel):
    items: List[ResearchPrepareItem] = Field(min_length=3, max_length=3)

class AskRequest(BaseModel):
    question:  str
    top_k:     int          = 5
    doc_id:    Optional[str] = None
    book_name: Optional[str] = None

# ── Admin models ─────────────────────────────────────────────────────────────
class IndexFromUrlRequest(BaseModel):
    url:      str
    filename: str = "upload.pdf"

class BookMeta(BaseModel):
    doc_id:      str
    title:       str
    category:    Optional[str] = None
    chunk_count: Optional[int] = None

class BookUpdate(BaseModel):
    enabled:  Optional[bool] = None
    title:    Optional[str]  = None
    category: Optional[str]  = None

class GenerateCardsRequest(BaseModel):
    session_id: Optional[str]       = None
    keywords:   Optional[List[str]] = None
    count:      int                 = Field(default=3, ge=1, le=6)

class FeedModeUpdate(BaseModel):
    mode: Literal["ai", "alt"]

class DailyPushToggle(BaseModel):
    enabled: bool

class StyleRuleCreate(BaseModel):
    rule:        str
    category:    Optional[str] = None
    source_note: Optional[str] = None

class StyleRuleUpdate(BaseModel):
    rule:     Optional[str]  = None
    category: Optional[str]  = None
    active:   Optional[bool] = None

class FixReviewerAdd(BaseModel):
    email: EmailStr

def _require_admin(x_admin_key: str = Header(default="")):
    if not ADMIN_KEY or x_admin_key != ADMIN_KEY:
        raise HTTPException(403, "Invalid or missing admin key")

# ── Static feed data ──────────────────────────────────────────────────────────
FEED_CARDS = [
    {"id":"card_food_picky",     "type":"tip",     "type_label":"科普", "cta":"问问AI →",
     "title":"18个月宝宝突然只吃3种食物，正常吗？",
     "summary":"\"食物新恐惧期\"是18–36个月最常见的发育阶段。我们梳理了3个最关键的应对原则。",
     "image_url":"https://images.unsplash.com/photo-1604908554027-93fc287e8ba3?w=600"},
    {"id":"card_bilingual_school","type":"news",    "type_label":"热点", "cta":"问问AI →",
     "title":"是否该让孩子上双语学校？华人家长吵翻了",
     "summary":"湾区一所私立双语小学的招生政策引爆了华人妈妈群，正反两派各执一词。",
     "image_url":"https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=600"},
    {"id":"card_baby_monitor",   "type":"product", "type_label":"推荐", "cta":"问问AI →",
     "title":"这款婴儿监视器值得买吗？",
     "summary":"对比3款北美热销监视器的隐私政策、夜视清晰度和延迟，附我们的实测建议。",
     "image_url":"https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600"},
    {"id":"card_sleep_routine",  "type":"tip",     "type_label":"科普", "cta":"问问AI →",
     "title":"2岁前后建立入睡仪式，到底有多重要？",
     "summary":"睡前30分钟固定的\"仪式\"比哄睡时长更影响夜醒次数。今晚就可以做的3件事。",
     "image_url":"https://images.unsplash.com/photo-1566004100631-35d015d6a491?w=600"},
    {"id":"card_screen_time",    "type":"news",    "type_label":"热点", "cta":"问问AI →",
     "title":"AAP 更新屏幕时间指南，多伦多妈妈群炸了",
     "summary":"新版指南把\"互动性\"作为关键标准——和爷爷视频不算屏幕时间？看看大家怎么吵。",
     "image_url":"https://images.unsplash.com/photo-1503602642458-232111445657?w=600"},
    {"id":"card_thermometer",    "type":"product", "type_label":"推荐", "cta":"问问AI →",
     "title":"额温枪 vs 耳温枪，新手家长怎么选？",
     "summary":"北美儿科医生最常推荐的3款，覆盖0–5岁不同月龄，附AI辨别异常体温的方法。",
     "image_url":"https://images.unsplash.com/photo-1584555613483-1c5f3ce97b9b?w=600"},
]

ALT_FEED_CARDS = [
    {"id":"alt_tantrum",  "type":"tip",     "type_label":"科普", "cta":"问问AI →",
     "title":"2岁宝宝当众尖叫怎么办？6步冷静法",
     "summary":"terrible twos 不是病——但你可以提前练好这套话术，关键时刻不慌。",
     "image_url":"https://images.unsplash.com/photo-1602030638412-bb8dcc0bc8b0?w=600"},
    {"id":"alt_daycare",  "type":"news",    "type_label":"热点", "cta":"问问AI →",
     "title":"纽约 daycare 学费再涨15%，华人妈妈群讨论留职还是辞职",
     "summary":"月费 $2800+ 已是常态。这一波算账，可能让你重新思考一年内的职业规划。",
     "image_url":"https://images.unsplash.com/photo-1587653263995-422546a7a569?w=600"},
    {"id":"alt_carseat",  "type":"product", "type_label":"推荐", "cta":"问问AI →",
     "title":"0-4岁安全座椅，到底要不要买 Nuna？",
     "summary":"对比 Nuna / Britax / Graco 在北美的真实事故评分和长期使用反馈。",
     "image_url":"https://images.unsplash.com/photo-1581952976147-5a2d15560349?w=600"},
    {"id":"alt_potty",    "type":"tip",     "type_label":"科普", "cta":"问问AI →",
     "title":"如厕训练，到底什么时候开始最合适？",
     "summary":"北美儿科和国内传统经验有不少分歧，先看孩子准备好的5个信号。",
     "image_url":"https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=600"},
    {"id":"alt_winter",   "type":"news",    "type_label":"热点", "cta":"问问AI →",
     "title":"加拿大冬天到底要不要带娃出门玩雪？",
     "summary":"-15°C 的多伦多家长群因为这个话题分裂了，背后其实是两种育儿文化。",
     "image_url":"https://images.unsplash.com/photo-1518091043644-c1d4457512c6?w=600"},
]

CARD_DETAILS: dict = {
    "card_food_picky":      {"body":"上周我在妈妈群看到一位姐姐发的求助：她家18个月的宝宝突然只肯吃白米饭、面条和酸奶。其实这阶段在儿科里有专门的名字，叫 food neophobia——食物新恐惧期。研究显示，18到36个月几乎是每个孩子都会经历的发育节点。\n\n三件最关键的小事：\n1. 每餐桌上放一样新食物，但不要强迫吃。\n2. 新食物搭配老熟悉，混搭比单独上更容易接受。\n3. 一次只引入一种新食物，连续7–10天。重复曝光比丰富度更重要。","tags":["#18月龄","#挑食","#辅食"],"hook_line":"看完想知道你家宝宝是不是也这样？"},
    "card_bilingual_school":{"body":"湾区一所私立双语小学最近改了招生政策，要求父母至少一方流利中文。妈妈群直接炸了。\n\n支持的一派说：中文环境是稀缺的，错过6岁前的语言敏感期，以后再想补就难了。\n\n反对的一派说：学术深度永远是英语的天花板，双语学校的英语阅读进度往往慢于主流学校。\n\n与其问「该不该上」，不如先问自己：你最在意的3件事是什么？","tags":["#双语教育","#择校","#华人家长"],"hook_line":"你家也在纠结这个选择吗？"},
    "card_baby_monitor":    {"body":"选婴儿监视器，华人家长在北美有一个特别的痛点：隐私。大部分热销监视器都是云端方案——视频先传到厂商服务器，再分发给你的手机。\n\n对比3款：\n• Nanit：画面最清晰，AI睡眠分析很强，但数据全部上云。\n• Owlet：主打「袜子+摄像头」二合一，能监测心率血氧。\n• VTech：传统点对点信号，完全不联网，隐私感最强。\n\n选哪个，本质上是在「功能感」和「安全感」之间做取舍。","tags":["#婴儿监视器","#选品","#隐私"],"hook_line":"想结合你家情况，听听我的建议？"},
    "card_sleep_routine":   {"body":"如果让我只推荐一件事帮你的孩子睡得更好，我会说：入睡仪式。\n\n2岁前后的宝宝，对「接下来要发生什么」特别敏感。如果每天晚上都是「洗澡→换睡衣→关大灯→读绘本→拥抱→上床」，他的大脑会在第一步就开始分泌褪黑素。\n\n几个关键诀窍：\n1. 从洗澡开始倒计时，水温降下来本身就触发睡意。\n2. 绘本永远是同一类——温柔、低饱和、句子短。\n3. 最后5分钟不再说话，只是身体接触。","tags":["#睡眠","#入睡仪式","#幼儿"],"hook_line":"想为你家做一个本周睡眠计划吗？"},
    "card_screen_time":     {"body":"AAP今年更新了屏幕时间指南，把「互动性」作为关键标准——和爷爷视频通话，不再算「屏幕时间」。这让很多华人家庭松了口气。\n\n但群里也有不同声音：新标准是不是给了家长偷懒的借口？\n\n真正该问自己的3个问题：\n1. 屏幕之后，孩子是更躁动还是更平静？\n2. 屏幕之外，他还在做哪些事？\n3. 你和孩子在一起的时间，是不是有相当一部分被设备打断了？","tags":["#屏幕时间","#AAP","#育儿争议"],"hook_line":"想聊聊你家的屏幕规则吗？"},
    "card_thermometer":     {"body":"额温枪 vs 耳温枪，常见的3款：\n• Braun Thermoscan 7：耳温枪经典款，年龄校准准确，缺点是耳道太小时偏差大。\n• iHealth 额温枪：非接触、几秒出数，适合睡着的宝宝；但环境温度变化会影响读数。\n• Frida Baby 3-in-1：耳额双用，价位中等，适合「什么都想试」的家庭。\n\n比型号更重要的是：每次测3次取中间值，记录趋势，而不是只看绝对值。","tags":["#温度计","#发烧","#新手家长"],"hook_line":"拍张读数发给我，AI 可以帮你判断？"},
}

CARD_TO_SCRIPT = {
    "card_food_picky":      "tip_food",
    "card_bilingual_school":"news_bilingual",
    "card_baby_monitor":    "product_monitor",
    "card_sleep_routine":   "tip_food",
    "card_screen_time":     "news_bilingual",
    "card_thermometer":     "product_monitor",
}

CARD_TASKS = {
    "tip_food": [
        {"title": "今天晚餐桌上放一样新食物（不强迫吃）", "scope": "today", "task_type": "care",
         "description": "食物新恐惧期很正常，重点是让孩子看到、接触，不强求吃下去。",
         "steps": ["挑一样孩子没吃过的食物", "和大人的餐食一起摆盘，不单独强调", "孩子不吃也不催促，收走即可"]},
        {"title": "记录宝宝今日实际进食的种类", "scope": "today", "task_type": "observation",
         "description": "先摸清孩子真实的饮食范围，再决定要不要调整。",
         "steps": ["三餐+加餐都记一下吃了什么", "标注是主动吃还是被喂"]},
        {"title": "本周连续7天，每天尝试一次新食物", "scope": "week", "progress_total": 7, "task_type": "care",
         "description": "重复暴露是克服挑食最有效的办法之一，通常需要8-10次接触。",
         "steps": ["每天固定一餐加入1样新食物", "记录孩子的反应（尝了/拒绝/爱吃）"]},
    ],
    "news_bilingual": [
        {"title": "今晚和伴侣聊10分钟，列出你们最在意的3件事", "scope": "today", "task_type": "interaction",
         "description": "教育选择是家庭决定，先对齐彼此最在意的点，避免后面反复拉扯。",
         "steps": ["各自写下最在意的3件事", "对照看哪些一致、哪些有分歧"]},
        {"title": "联系1位已经送孩子去双语学校的朋友", "scope": "today", "task_type": "observation",
         "description": "真实家长的反馈比宣传资料更可靠。",
         "steps": ["列出认识的相关家长", "发消息约个10分钟电话"]},
        {"title": "本周收集3所候选学校的真实家长反馈", "scope": "week", "progress_total": 7, "task_type": "observation",
         "description": "多方交叉验证，避免只看到学校一面之词。",
         "steps": ["每所学校至少找1位在读家长", "问入学后最意外的一点是什么"]},
        {"title": "本周参观至少1所学校", "scope": "week", "progress_total": 7, "task_type": "observation",
         "description": "实地看比资料更能感受到氛围是否合适。",
         "steps": ["预约开放日或参观时段", "留意课堂氛围和师生互动"]},
        {"title": "周末和伴侣坐下来做一次结构化讨论", "scope": "today", "task_type": "interaction",
         "description": "把这周收集到的信息汇总，做一次有结论的讨论，而不是零散聊。",
         "steps": ["带着收集到的反馈和参观笔记", "列出仍需要确认的问题"]},
    ],
    "product_monitor": [
        {"title": "今天对比 Nanit / Owlet / VTech 的隐私政策", "scope": "today", "task_type": "observation",
         "description": "婴儿监视器涉及家庭隐私数据，选购前先看清数据怎么存、谁能访问。",
         "steps": ["查每家的数据存储位置和加密方式", "看是否支持本地存储、无需云端"]},
        {"title": "本周内完成购买决策", "scope": "week", "progress_total": 7, "task_type": "care",
         "description": "给自己一个明确期限，避免选择困难拖太久。",
         "steps": ["列出3个候选的优先级", "对照预算和隐私顾虑做最终决定"]},
    ],
    "free": [
        {"title": "今天选一个小目标坚持10分钟", "scope": "today", "task_type": "selfcare",
         "description": "小而具体的目标更容易真正完成。",
         "steps": ["挑一件今天想做的小事", "设10分钟专注去做"]},
        {"title": "本周和孩子做一件\"专注陪伴\"的事", "scope": "week", "progress_total": 7, "task_type": "interaction",
         "description": "放下手机，全情投入的陪伴比时长更重要。",
         "steps": ["每天挑10-15分钟不被打断的时间", "让孩子主导玩什么"]},
        {"title": "睡前花5分钟回顾今天3件好事", "scope": "today", "task_type": "selfcare",
         "description": "简单的感恩记录有助于缓解育儿疲惫感。",
         "steps": ["睡前想3件今天顺利/开心的小事", "写下来或者说给伴侣听"]},
    ],
}

# ── Daily email push helpers ──────────────────────────────────────────────────

def _send_email_smtp(to_addr: str, subject: str, body: str) -> None:
    import smtplib, ssl
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart
    from email.header import Header

    sender = SMTP_FROM or SMTP_USER
    msg = MIMEMultipart()
    msg["Subject"] = Header(subject, "utf-8").encode()
    msg["From"] = sender
    msg["To"] = to_addr
    msg.attach(MIMEText(body, "plain", "utf-8"))
    raw = msg.as_bytes()

    ctx = ssl.create_default_context()
    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx) as s:
            s.login(SMTP_USER, SMTP_PASSWORD)
            s.sendmail(sender, to_addr, raw)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
            s.ehlo()
            s.starttls(context=ctx)
            s.login(SMTP_USER, SMTP_PASSWORD)
            s.sendmail(sender, to_addr, raw)

# Fallback scripts (used when OpenAI is not configured)
SCRIPTS: dict = {
    "tip_food": [
        {"role":"ai","text":"你刚刚看到的这条「18个月宝宝突然只吃3种食物，正常吗」——我看到你点进来了。想具体聊聊你家宝宝的情况吗？","quick_replies":["我家也是这样","这是真的吗","随便看看"]},
        {"role":"ai","text":"嗯，这其实非常常见，专业上叫 food neophobia（食物新恐惧期）。先问你两件事：宝宝现在主要只吃哪3种？最近有没有体重下降？","quick_replies":["白米饭/面条/牛奶","没有体重下降","有一点下降"]},
        {"role":"ai","text":"好的，体重稳定就先不用焦虑。核心策略是\"反复轻量曝光\"+ 减少压力：\n\n• 每餐桌上至少放1样新食物，但不强迫吃\n• 把新食物和孩子已经接受的食物放在一起\n• 一次只引入一种新食物，连续7–10天\n\n要不要我帮你做一个本周的小计划？","quick_replies":["要，帮我做计划","我再想想"]},
        {"role":"ai","text":"好嘞，已为你生成3个本周任务，包含每日记录和一个轻量挑战。","transition":{"kind":"tasks_generated","count":3}},
    ],
    "news_bilingual": [
        {"role":"ai","text":"你点的这条「是否该让孩子上双语学校？华人家长吵翻了」最近确实很热。你是已经在做决定，还是想先听听双方观点？","quick_replies":["我在做决定","想听双方观点","随便看看"]},
        {"role":"ai","text":"北美华人圈里这个话题有3个真实的分歧点：\n\n1) 英文学术深度 vs 中文文化认同\n2) 同伴语言环境的影响\n3) 转学回主流学校的难度\n\n你最担心的是哪一个？","quick_replies":["英文学术深度","中文文化认同","转学难度"]},
        {"role":"ai","text":"嗯，这是最多家长卡住的点。我可以给你一个\"决策清单\"——5个你这周可以做的小动作，帮你更有底气地做决定。要不要？","quick_replies":["好，生成清单","先不用"]},
        {"role":"ai","text":"已为你生成5个本周任务，帮你结构化收集信息。","transition":{"kind":"tasks_generated","count":5}},
    ],
    "product_monitor": [
        {"role":"ai","text":"你点的「婴儿监视器值得买吗」——华人家长在北美选这类产品，隐私政策其实比清晰度更重要。你家是新生儿还是已经会爬了？","quick_replies":["新生儿","会爬了","随便看看"]},
        {"role":"ai","text":"好的。基于这个阶段，我建议你重点对比3款：Nanit / Owlet / VTech。要不要我帮你列一个对比清单？","quick_replies":["要","先不用"]},
        {"role":"ai","text":"已为你生成2个本周任务，帮你做出更安心的购买决定。","transition":{"kind":"tasks_generated","count":2}},
    ],
    "free": [
        {"role":"ai","text":"Hi，我是你的育儿助手 NURI。你今天想聊点什么？可以是吃饭、睡觉、情绪、或者你刚刚看到的任何一条内容。","quick_replies":["睡眠问题","吃饭挑食","随便聊聊"]},
        {"role":"ai","text":"好的，再多告诉我一点情况，比如孩子月龄、最近一周观察到的具体变化，我才能给你更具体的建议。"},
        {"role":"ai","text":"明白了。要不要我帮你把这周可以做的几件事整理成一个简单清单？","quick_replies":["好的","先不用"]},
        {"role":"ai","text":"好嘞，已为你生成3个本周任务。","transition":{"kind":"tasks_generated","count":3}},
    ],
}

# ── NURI persona ──────────────────────────────────────────────────────────────
# ── 3 对话与主动模型 ──────────────────────────────────────────────────────────
# The persona, the reply calls, the task-card contract, the streamed-JSON
# parser, the #fix distillation and the proactive check-in now live in
# backend/nuri_core/dialogue_reply.py. Aliased for the chat routes below.
NURI_PERSONA = core_dialogue_reply.NURI_PERSONA
_NURI_JSON_SUFFIX = core_dialogue_reply.NURI_JSON_SUFFIX
_NURI_RESPONSE_FORMAT = core_dialogue_reply.NURI_RESPONSE_FORMAT
_NURI_FALLBACK = core_dialogue_reply.NURI_FALLBACK
_HISTORY_WINDOW = core_dialogue_reply.HISTORY_WINDOW
REPLY_REASONING_EFFORT = core_dialogue_reply.REPLY_REASONING_EFFORT
_reply_model_kwargs = core_dialogue_reply.reply_model_kwargs
_nuri_messages = core_dialogue_reply.nuri_messages
_parse_nuri_reply = core_dialogue_reply.parse_nuri_reply
_nuri_reply_sync = core_dialogue_reply.nuri_reply_sync
_nuri_reply_stream = core_dialogue_reply.nuri_reply_stream
_partial_json_string = core_dialogue_reply.partial_json_string
_task_intent = core_dialogue_reply.task_intent
_user_requested_tasks = core_dialogue_reply.user_requested_tasks
_user_declined_tasks = core_dialogue_reply.user_declined_tasks
_urgent_task_suppressed = core_dialogue_reply.urgent_task_suppressed
_requested_task_count = core_dialogue_reply.requested_task_count
_normalize_task_proposals = core_dialogue_reply.normalize_task_proposals
def _card_ctx(card_id: str, gen_cards: list[dict] | None = None) -> str:
    for c in FEED_CARDS + ALT_FEED_CARDS + LEARNING_CONTENT_CARDS + (gen_cards or []):
        if c["id"] == card_id:
            d = CARD_DETAILS.get(card_id, {})
            body = d.get("body") or c.get("body", "")
            resources = c.get("resources") or []
            resource_ctx = ""
            if resources:
                resource_ctx = "\n延伸资源：" + "；".join(
                    f"{item.get('publisher', '')}《{item.get('title', '')}》"
                    for item in resources
                )
            return f"标题：{c['title']}\n摘要：{c['summary']}\n{body}{resource_ctx}"
    return ""

# ── 1 家庭模型 ────────────────────────────────────────────────────────────────
# Identity, stage, memories, follow-ups and the normalized input log now live in
# backend/nuri_core/family_store.py, with the state assembly and its cache in
# family.py. Aliased under their old private names because the routes below,
# the ports wiring and several tests all still call them that; the aliases go
# once those move out of this file too.
_MEMORY_CATEGORY_LABELS = core_family_store.MEMORY_CATEGORY_LABELS
_PARENT_ROLE_LABELS = core_family_store.PARENT_ROLE_LABELS
_CONCERN_LABELS = core_family_store.CONCERN_LABELS
_HELP_PREF_LABELS = core_family_store.HELP_PREF_LABELS
_INFO_SOURCE_LABELS = core_family_store.INFO_SOURCE_LABELS
_GENDER_LABELS = core_family_store.GENDER_LABELS
_PROFILE_FIELDS = core_family_store.PROFILE_FIELDS
MEMORY_MIN_USER_CHARS = core_family_store.MEMORY_MIN_USER_CHARS
FOLLOW_UP_INTERVALS = core_family_store.FOLLOW_UP_INTERVALS
FOLLOW_UP_DEFAULT_DAYS = core_family_store.FOLLOW_UP_DEFAULT_DAYS
FOLLOW_UP_EXPIRE_DAYS = core_family_store.FOLLOW_UP_EXPIRE_DAYS

_age_in_months = core_family_store.age_in_months
_age_label = core_family_store.age_label
_safe_child_recommendation_context = core_family_store.safe_child_recommendation_context
_attach_child_recommendation_context = core_family_store.attach_child_recommendation_context
_profile_ctx = core_family_store.profile_ctx
_load_profile = core_family_store.load_profile
_save_normalized_input = core_family_store.save_normalized_input
_extract_memories_sync = core_family_store.extract_memories_sync
_upsert_memories = core_family_store.upsert_memories
_worth_extracting = core_family_store.worth_extracting
_follow_up_due_at = core_family_store.follow_up_due_at
_upsert_follow_ups = core_family_store.upsert_follow_ups
_get_follow_up_context = core_family_store.get_follow_up_context
_take_due_follow_up = core_family_store.take_due_follow_up
_mark_follow_up_asked = core_family_store.mark_follow_up_asked
_get_memory_context = core_family_store.get_memory_context
_extract_and_upsert_memories = core_family.extract_and_upsert_memories


class _TurnMetrics:
    """Collects one chat turn's cost while the turn runs.

    Nothing here may raise or add latency: it's a plain accumulator, and the
    single write happens after the reply has already reached the parent.
    """

    def __init__(self, *, streamed: bool):
        self.row: dict = {
            "id": str(uuid.uuid4()),
            "streamed": streamed,
            "model": "",
            "status": "ok",
            "suggested_tasks": False,
        }
        self._t0 = time.perf_counter()

    def mark(self, key: str, start: float) -> None:
        self.row[key] = _ms(start)

    def set(self, **fields) -> None:
        self.row.update(fields)

    def record_prompt(self, msgs: list[dict], blocks: dict) -> None:
        system = msgs[0]["content"] if msgs else ""
        history = msgs[1:]
        self.row.update({
            "system_chars": len(system),
            "history_msgs": len(history),
            "history_chars": sum(len(m.get("content") or "") for m in history),
            "memory_chars": len(blocks.get("memory") or ""),
            "style_chars": len(blocks.get("style") or ""),
            "internal_chars": len(blocks.get("internal") or ""),
            "profile_chars": len(blocks.get("profile") or ""),
            "card_chars": len(blocks.get("card") or ""),
        })

    def record_usage(self, usage) -> None:
        if not usage:
            return
        self.row["prompt_tokens"] = getattr(usage, "prompt_tokens", None)
        self.row["completion_tokens"] = getattr(usage, "completion_tokens", None)

    async def flush(self, *, session_id: str, user_id: Optional[str], reply_text: str) -> None:
        sb = _get_supabase()
        if not sb:
            return
        self.row.update({
            "session_id": session_id,
            "user_id": user_id,
            "reply_chars": len(reply_text or ""),
            "total_ms": _ms(self._t0),
            "created_at": _now(),
        })
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("chat_turn_logs").insert(self.row).execute()
            )
        except Exception as e:
            # A metrics table must never cost a turn. Most likely cause is the
            # migration not having been run yet.
            print(f"[warn] chat_turn_logs insert: {e}")
            # The four-model columns arrive with four_model_migration.sql.
            # Deploying ahead of it would otherwise drop every turn metric,
            # including the ones that have been collected all along — so retry
            # with just the columns the linear pipeline already wrote.
            legacy = {k: v for k, v in self.row.items()
                      if k not in core_provenance.TurnTrace.FLAT_COLUMNS}
            if len(legacy) == len(self.row):
                return
            try:
                await anyio.to_thread.run_sync(
                    lambda: sb.table("chat_turn_logs").insert(legacy).execute()
                )
                print("[warn] logged without four-model columns; run four_model_migration.sql")
            except Exception as e2:
                print(f"[warn] chat_turn_logs retry failed: {e2}")



_compose_follow_up_message = core_dialogue_reply.compose_follow_up_message
# Chat command Linda (or any whitelisted reviewer) types inline to correct a
# reply: "#fix <什么地方不对>". It never reaches the user — it gets distilled
# into a reusable rule instead. Only accounts listed in fix_reviewers can
# trigger it, or any parent who happens to type "#fix ..." gets hijacked.
FIX_KEYWORD = core_dialogue_reply.FIX_KEYWORD
_is_fix_reviewer = core_dialogue_reply.is_fix_reviewer
_distill_style_rule_sync = core_dialogue_reply.distill_style_rule_sync
_get_style_rules_ctx = core_dialogue_reply.get_style_rules_ctx

# Seed offsets per type so tip/news/product get visually distinct images
_TYPE_SEED_OFFSET = {"tip": 0, "news": 100, "product": 200}

def _pick_card_image(card_type: str, card_id: str = "") -> str:
    seed = abs(hash(card_id or card_type)) % 1000 + _TYPE_SEED_OFFSET.get(card_type, 0)
    return f"https://picsum.photos/seed/{seed}/600/400"

def _gen_feed_cards_sync(keywords: list[str], count: int = 3) -> list[dict]:
    if not oai:
        return []
    type_labels = {"tip": "科普", "news": "热点", "product": "推荐"}
    resp = oai.chat.completions.create(
        model="gpt-5.5",
        messages=[{"role": "user", "content":
            f"你是育儿内容编辑，根据以下关键词为北美华人家长生成{count}条育儿知识卡片。\n\n"
            f"关键词：{', '.join(keywords)}\n\n"
            f'以JSON返回：{{"cards": [{{"type": "tip/news/product", "title": "标题（25字内）", '
            f'"summary": "摘要（50字内）", "body": "详细内容（150字内）", '
            f'"tags": ["#标签"], "hook_line": "互动钩子（15字内）"}}]}}\n\n'
            f"type: tip=科普知识 news=热点讨论 product=产品推荐\n"
            f"每张卡针对不同关键词，内容实用具体，有北美生活背景"
        }],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "feed_cards",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "cards": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "enum": ["tip", "news", "product"]},
                                    "title": {"type": "string"},
                                    "summary": {"type": "string"},
                                    "body": {"type": "string"},
                                    "tags": {"type": "array", "items": {"type": "string"}},
                                    "hook_line": {"type": "string"},
                                },
                                "required": ["type", "title", "summary", "body", "tags", "hook_line"],
                                "additionalProperties": False,
                            },
                        }
                    },
                    "required": ["cards"],
                    "additionalProperties": False,
                },
            },
        },
    )
    try:
        data = json.loads(resp.choices[0].message.content)
        cards = []
        for card in data.get("cards", [])[:count]:
            card_type = card.get("type", "tip")
            if card_type not in type_labels:
                card_type = "tip"
            cid = f"gen_{uuid.uuid4().hex[:8]}"
            cards.append({
                "id": cid,
                "type": card_type,
                "type_label": type_labels[card_type],
                "cta": "问问AI →",
                "title": card.get("title", ""),
                "summary": card.get("summary", ""),
                "body": card.get("body", ""),
                "tags": card.get("tags", []),
                "hook_line": card.get("hook_line", "想了解更多？"),
                "image_url": _pick_card_image(card_type, cid),
                "keywords": keywords,
                "source": "ai",
            })
        return cards
    except Exception:
        return []

_gen_tasks_ai_sync = core_dialogue_reply.gen_tasks_ai_sync

# ── Auth routes ───────────────────────────────────────────────────────────────
@api.post("/auth/register", status_code=201)
async def register(body: UserRegister):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Database not configured")
    email = body.email.lower()
    try:
        existing = await anyio.to_thread.run_sync(
            lambda: sb.table("users").select("id").eq("email", email).execute()
        )
        if existing.data:
            raise HTTPException(400, "该邮箱已注册")
    except HTTPException:
        raise
    except Exception as e:
        print(f"[warn] register email-check error: {e}")
    doc = {
        "id": str(uuid.uuid4()), "email": email,
        "nickname": body.nickname, "city": body.city,
        "top_concerns": list(body.top_concerns),
        "hashed_password": _hash_pw(body.password), "created_at": _now(),
    }
    # Omitted rather than sent as null: the column is still NOT NULL on
    # databases that haven't run parent_role_nullable_migration.sql, where an
    # explicit null fails the insert. Omitting works either way — the old
    # schema falls back to its default, the migrated one stores null.
    if body.parent_role:
        doc["parent_role"] = body.parent_role
    try:
        await anyio.to_thread.run_sync(lambda: sb.table("users").insert(doc).execute())
    except Exception as e:
        err = str(e)
        if "23505" in err or "duplicate" in err.lower() or "unique" in err.lower():
            raise HTTPException(400, "该邮箱已注册")
        print(f"[error] register insert error: {e}")
        raise HTTPException(500, "注册失败，请稍后重试")
    return {"access_token": _make_token(doc["id"]), "token_type": "bearer", "user": _to_public(doc)}

@api.post("/auth/login")
async def login(body: UserLogin):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Database not configured")
    res = await anyio.to_thread.run_sync(
        lambda: sb.table("users").select("*").eq("email", body.email.lower()).execute()
    )
    if not res.data or not _verify_pw(body.password, res.data[0]["hashed_password"]):
        raise HTTPException(401, "邮箱或密码错误")
    doc = res.data[0]
    return {"access_token": _make_token(doc["id"]), "token_type": "bearer", "user": _to_public(doc)}

@api.get("/auth/me")
async def me(uid: str = Depends(_req_uid)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Database not configured")
    res = await anyio.to_thread.run_sync(
        lambda: sb.table("users").select("*").eq("id", uid).execute()
    )
    if not res.data:
        raise HTTPException(404, "user not found")
    return _to_public(res.data[0])

@api.put("/auth/me")
async def update_me(body: UserUpdate, uid: str = Depends(_req_uid)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Database not configured")
    res = await anyio.to_thread.run_sync(
        lambda: sb.table("users").select("*").eq("id", uid).execute()
    )
    if not res.data:
        raise HTTPException(404, "user not found")
    updates = {k: v for k, v in body.dict(exclude_unset=True).items() if v is not None}
    if updates:
        await anyio.to_thread.run_sync(
            lambda: sb.table("users").update(updates).eq("id", uid).execute()
        )
        core_family.invalidate(uid)
    doc = {**res.data[0], **updates}
    return _to_public(doc)

# ── Children ──────────────────────────────────────────────────────────────────
def _child_payload(body: ChildCreate) -> dict:
    """Serialize a validated child model without losing the date-only value."""

    return body.model_dump(mode="json")


async def _invalidate_child_recommendations(uid: Optional[str]) -> None:
    """Best-effort cleanup; profile fingerprints still reject stale snapshots."""

    if not uid:
        return
    # A child's age band is the strongest condition a directive can carry, so
    # the family model's cached state has to go with the recommendations.
    core_family.invalidate(uid)
    try:
        await _db_delete_recommendation_snapshots(uid)
    except Exception as exc:
        # Child profile writes must not look failed after the database already
        # accepted them.  The profile fingerprint is the correctness backstop.
        print(f"[warn] child recommendation cleanup failed: {type(exc).__name__}")


@api.get("/children")
async def list_children(uid: Optional[str] = Depends(_opt_uid)):
    sb = _get_supabase()
    if sb and uid:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("children")
                .select("*")
                .eq("user_id", uid)
                .order("created_at", desc=False)
                .execute()
            )
            return res.data or []
        except Exception as e:
            print(f"[warn] listChildren Supabase error: {e}")
    return [c for c in _children if not uid or c.get("user_id") == uid]

@api.post("/children", status_code=201)
async def add_child(body: ChildCreate, uid: Optional[str] = Depends(_opt_uid)):
    child = {"id": str(uuid.uuid4()), "created_at": _now(), **_child_payload(body)}
    if uid:
        child["user_id"] = uid
    sb = _get_supabase()
    if sb and uid:
        await anyio.to_thread.run_sync(lambda: sb.table("children").insert(child).execute())
        await _invalidate_child_recommendations(uid)
        return child
    _children.append(child)
    await _invalidate_child_recommendations(uid)
    return child

@api.put("/children/{child_id}")
async def update_child(child_id: str, body: ChildCreate, uid: Optional[str] = Depends(_opt_uid)):
    updates = _child_payload(body)
    sb = _get_supabase()
    if sb and uid:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("children")
            .update(updates)
            .eq("id", child_id)
            .eq("user_id", uid)
            .execute()
        )
        if res.data:
            await _invalidate_child_recommendations(uid)
            return res.data[0]
        raise HTTPException(404, "child not found")
    for i, c in enumerate(_children):
        if c["id"] == child_id and (not uid or c.get("user_id") == uid):
            _children[i] = {**c, **updates}
            await _invalidate_child_recommendations(uid)
            return _children[i]
    raise HTTPException(404, "child not found")

@api.delete("/children/{child_id}")
async def delete_child(child_id: str, uid: Optional[str] = Depends(_opt_uid)):
    global _children
    sb = _get_supabase()
    if sb and uid:
        await anyio.to_thread.run_sync(
            lambda: sb.table("children").delete().eq("id", child_id).eq("user_id", uid).execute()
        )
        await _invalidate_child_recommendations(uid)
        return {"ok": True}
    _children = [c for c in _children
                 if not (c["id"] == child_id and (not uid or c.get("user_id") == uid))]
    await _invalidate_child_recommendations(uid)
    return {"ok": True}

# ── Feed ──────────────────────────────────────────────────────────────────────
def _recommendation_activity_key(row: dict) -> tuple[str, str]:
    return (str(row.get("created_at") or ""), str(row.get("id") or ""))


_ACCOUNT_HISTORY_SESSION_LIMIT = 5
_ACCOUNT_HISTORY_USER_MESSAGE_LIMIT = 18
_CURRENT_SESSION_USER_HISTORY_LIMIT = 24


def _safe_context_message(message: dict, *, context_scope: str) -> dict:
    """Return only the conversation fields needed by recommendation ranking."""

    return {
        "id": message.get("id"),
        "session_id": message.get("session_id"),
        "role": message.get("role"),
        "text": str(message.get("text") or ""),
        "created_at": message.get("created_at"),
        "context_scope": context_scope,
    }


def _recent_account_user_signals(
    messages: list[dict],
    *,
    current_session_id: str,
) -> list[dict]:
    """Select a bounded, balanced set of user-authored account history.

    The caller must already have scoped ``messages`` to one authenticated user
    and excluded card-linked sessions.  We keep at most five other main chats
    and at most four messages from any one chat so a long stale conversation
    cannot drown out the current request.
    """

    selected: list[dict] = []
    session_counts: dict[str, int] = {}
    for message in sorted(messages, key=_recommendation_activity_key, reverse=True):
        session_id = str(message.get("session_id") or "")
        if not session_id or session_id == current_session_id:
            continue
        if message.get("role") != "user" or not str(message.get("text") or "").strip():
            continue
        if session_id not in session_counts:
            if len(session_counts) >= _ACCOUNT_HISTORY_SESSION_LIMIT:
                continue
            session_counts[session_id] = 0
        if session_counts[session_id] >= 4:
            continue
        session_counts[session_id] += 1
        selected.append(message)
        if len(selected) >= _ACCOUNT_HISTORY_USER_MESSAGE_LIMIT:
            break
    return [
        _safe_context_message(message, context_scope="account_history")
        for message in reversed(selected)
    ]


def _recent_main_chat_from_memory(
    uid: str,
    limit: int = 12,
    preferred_session_id: Optional[str] = None,
    through_created_at: Optional[str] = None,
) -> dict:
    """Resolve the user's real main conversation without trusting a client ID."""

    sessions = [
        session
        for session in _sessions.values()
        if session.get("user_id") == uid and not session.get("source_card_id")
    ]
    if not sessions:
        return {"state": "no_history", "session_id": None, "messages": []}

    session_ids = {session["id"] for session in sessions}
    all_user_messages = [
        {**message, "session_id": message.get("session_id") or session_id}
        for session_id in session_ids
        for message in _messages.get(session_id, [])
        if message.get("role") == "user" and str(message.get("text") or "").strip()
    ]
    last_user_message = max(
        all_user_messages,
        key=_recommendation_activity_key,
        default=None,
    )
    preferred_session = next(
        (session for session in sessions if session.get("id") == preferred_session_id),
        None,
    )
    if preferred_session_id and not preferred_session:
        return {
            "state": "context_not_found",
            "session_id": None,
            "messages": [],
            "context_created_at": None,
            "history_session_count": 0,
            "history_user_message_count": 0,
        }
    if preferred_session:
        session = preferred_session
        preferred_messages = [
            message
            for message in _messages.get(session["id"], [])
            if not through_created_at
            or str(message.get("created_at") or "") <= through_created_at
        ]
        last_user_message = next(
            (
                message
                for message in reversed(
                    sorted(preferred_messages, key=_recommendation_activity_key)
                )
                if message.get("role") == "user"
                and str(message.get("text") or "").strip()
            ),
            None,
        )
    elif last_user_message:
        session = next(
            item for item in sessions if item["id"] == last_user_message.get("session_id")
        )
    else:
        session = max(sessions, key=_recommendation_activity_key)

    all_current_messages = sorted(
        [
            message
            for message in _messages.get(session["id"], [])
            if not through_created_at
            or str(message.get("created_at") or "") <= through_created_at
        ],
        key=_recommendation_activity_key,
    )
    messages = all_current_messages[-limit:]
    safe_messages = [
        _safe_context_message(
            {**message, "session_id": message.get("session_id") or session["id"]},
            context_scope="current_session",
        )
        for message in messages
        if message.get("role") in {"user", "ai", "assistant"}
    ]
    recent_message_ids = {
        str(message.get("id") or "") for message in safe_messages if message.get("id")
    }
    bounded_current_user_messages = [
        item
        for item in all_current_messages
        if item.get("role") == "user" and str(item.get("text") or "").strip()
    ][-_CURRENT_SESSION_USER_HISTORY_LIMIT:]
    deeper_current_user_messages = [
        _safe_context_message(
            {**message, "session_id": message.get("session_id") or session["id"]},
            context_scope="current_session_history",
        )
        for message in bounded_current_user_messages
        if str(message.get("id") or "") not in recent_message_ids
    ]
    history_messages = (
        []
        if preferred_session_id or through_created_at
        else _recent_account_user_signals(
            all_user_messages,
            current_session_id=session["id"],
        )
    )
    return {
        "state": "ready" if last_user_message else "no_user_message",
        "session_id": session.get("id"),
        "messages": [
            *history_messages,
            *deeper_current_user_messages,
            *safe_messages,
        ],
        "context_created_at": (safe_messages[-1].get("created_at") if safe_messages else None),
        "history_session_count": len(
            {message.get("session_id") for message in history_messages}
        ),
        "history_user_message_count": len(history_messages),
        "current_session_user_message_count": sum(
            1
            for message in [*deeper_current_user_messages, *safe_messages]
            if message.get("role") == "user"
        ),
    }


async def _load_recent_main_chat(
    uid: str,
    limit: int = 12,
    preferred_session_id: Optional[str] = None,
    through_created_at: Optional[str] = None,
) -> dict:
    """Load recent main-chat context scoped to ``uid``.

    Card-linked conversations are intentionally excluded.  When Supabase is
    temporarily unavailable we return a safe default state instead of exposing
    another user's process-local data or breaking the home screen.
    """

    privacy = await _db_get_privacy(uid, fail_closed=True)
    preferred_locale = _normalize_preferred_locale(privacy.get("language"))
    external_research_allowed = bool(
        privacy.get("allow_external_content_research") is True
    )
    if privacy.get(_PRIVACY_STORAGE_UNAVAILABLE):
        return {
            "state": "unavailable",
            "session_id": None,
            "messages": [],
            "preferred_locale": preferred_locale,
            "external_research_allowed": False,
        }
    if privacy.get("allow_history_training") is False:
        return {
            "state": "privacy_off",
            "session_id": None,
            "messages": [],
            "preferred_locale": preferred_locale,
            "external_research_allowed": False,
        }

    sb = _get_supabase()
    if not sb:
        return {
            **_recent_main_chat_from_memory(
                uid, limit, preferred_session_id, through_created_at
            ),
            "preferred_locale": preferred_locale,
            "external_research_allowed": external_research_allowed,
        }

    try:
        session_res = await anyio.to_thread.run_sync(
            lambda: sb.table("chat_sessions")
            .select("id,title,source_card_id,created_at")
            .eq("user_id", uid)
            .execute()
        )
        main_sessions = [
            session
            for session in (session_res.data or [])
            if not session.get("source_card_id")
        ]
        if not main_sessions:
            return {
                "state": "no_history",
                "session_id": None,
                "messages": [],
                "preferred_locale": preferred_locale,
                "external_research_allowed": external_research_allowed,
            }

        session_ids = [session["id"] for session in main_sessions]
        preferred_session = next(
            (
                item
                for item in main_sessions
                if item.get("id") == preferred_session_id
            ),
            None,
        )
        if preferred_session_id and not preferred_session:
            return {
                "state": "context_not_found",
                "session_id": None,
                "messages": [],
                "context_created_at": None,
                "history_session_count": 0,
                "history_user_message_count": 0,
                "preferred_locale": preferred_locale,
                "external_research_allowed": external_research_allowed,
            }
        if preferred_session:
            session = preferred_session
        else:
            # This first query only identifies the active main conversation.
            # Account history is loaded separately below; otherwise a long
            # current chat can consume the global PostgREST limit and erase all
            # continuity signals from the user's other conversations.
            latest_user_res = await anyio.to_thread.run_sync(
                lambda: sb.table("chat_messages")
                .select("id,session_id,role,text,created_at")
                .in_("session_id", session_ids)
                .eq("role", "user")
                .order("created_at", desc=True)
                .order("id", desc=True)
                .limit(1)
                .execute()
            )
            last_user_message = ((latest_user_res.data or []) or [None])[0]
            if last_user_message:
                session = next(
                    item
                    for item in main_sessions
                    if item["id"] == last_user_message.get("session_id")
                )
            else:
                session = max(main_sessions, key=_recommendation_activity_key)

        def load_context_messages():
            query = (
                sb.table("chat_messages")
                .select("id,session_id,role,text,created_at")
                .eq("session_id", session["id"])
            )
            if through_created_at:
                query = query.lte("created_at", through_created_at)
            return (
                query.order("created_at", desc=True)
                .order("id", desc=True)
                .limit(limit)
                .execute()
            )

        message_res = await anyio.to_thread.run_sync(load_context_messages)
        current_messages = list(reversed(message_res.data or []))

        def load_current_user_history():
            query = (
                sb.table("chat_messages")
                .select("id,session_id,role,text,created_at")
                .eq("session_id", session["id"])
                .eq("role", "user")
            )
            if through_created_at:
                query = query.lte("created_at", through_created_at)
            return (
                query.order("created_at", desc=True)
                .order("id", desc=True)
                .limit(_CURRENT_SESSION_USER_HISTORY_LIMIT)
                .execute()
            )

        current_user_history_res = await anyio.to_thread.run_sync(
            load_current_user_history
        )
        recent_message_ids = {
            str(message.get("id") or "")
            for message in current_messages
            if message.get("id")
        }
        deeper_current_user_messages = [
            _safe_context_message(
                message,
                context_scope="current_session_history",
            )
            for message in reversed(current_user_history_res.data or [])
            if str(message.get("id") or "") not in recent_message_ids
        ]
        history_messages: list[dict] = []
        if not preferred_session_id and not through_created_at:
            history_sessions = sorted(
                (
                    item
                    for item in main_sessions
                    if item.get("id") != session["id"]
                ),
                key=_recommendation_activity_key,
                reverse=True,
            )[:_ACCOUNT_HISTORY_SESSION_LIMIT]

            async def load_history_session(history_session_id: str):
                return await anyio.to_thread.run_sync(
                    lambda: sb.table("chat_messages")
                    .select("id,session_id,role,text,created_at")
                    .eq("session_id", history_session_id)
                    .eq("role", "user")
                    .order("created_at", desc=True)
                    .order("id", desc=True)
                    # Fetch enough from each candidate session for the global
                    # 18-message selector below to find durable themes. A fixed
                    # four-message slice hid older but repeatedly important
                    # context in accounts with one long historical main chat.
                    .limit(_ACCOUNT_HISTORY_USER_MESSAGE_LIMIT)
                    .execute()
                )

            history_results = await asyncio.gather(
                *(
                    load_history_session(str(item["id"]))
                    for item in history_sessions
                )
            )
            history_user_messages = [
                message
                for result in history_results
                for message in (result.data or [])
            ]
            history_messages = _recent_account_user_signals(
                history_user_messages,
                current_session_id=session["id"],
            )
        messages = [
            *history_messages,
            *deeper_current_user_messages,
            *[
                _safe_context_message(message, context_scope="current_session")
                for message in current_messages
                if message.get("role") in {"user", "ai", "assistant"}
            ],
        ]
        session_has_user_message = any(
            message.get("role") == "user"
            and str(message.get("text") or "").strip()
            for message in [*deeper_current_user_messages, *current_messages]
        )
        return {
            "state": "ready" if session_has_user_message else "no_user_message",
            "session_id": session.get("id"),
            "messages": messages,
            "context_created_at": (
                current_messages[-1].get("created_at") if current_messages else None
            ),
            "history_session_count": len(
                {message.get("session_id") for message in history_messages}
            ),
            "history_user_message_count": len(history_messages),
            "current_session_user_message_count": sum(
                1
                for message in [*deeper_current_user_messages, *current_messages]
                if message.get("role") == "user"
            ),
            "preferred_locale": preferred_locale,
            "external_research_allowed": external_research_allowed,
        }
    except Exception as exc:
        print(f"[warn] personalized feed conversation lookup failed: {exc}")
        return {
            "state": "unavailable",
            "session_id": None,
            "messages": [],
            "preferred_locale": preferred_locale,
            "external_research_allowed": False,
        }


_CONVERSATION_MATCH_MIN_SCORE = 8
_WEAK_MATCH_TERMS = frozenset(
    {
        "沟通",
        "表达",
        "互动",
        "连接",
        "安全",
        "压力",
        "play",
        "words",
        "behavior",
        "food",
        # Age alone describes context, not the family's current goal.  It may
        # support a development match but must not beat an explicit language,
        # sleep or behavior concern.
        "月龄",
        "9个月",
        "九个月",
        "10个月",
        "十个月",
        "11个月",
        "十一个月",
        "一岁",
    }
)
_NEGATION_MARKERS = (
    "不是",
    "并不是",
    "不属于",
    "不用",
    "无需",
    "不要聊",
    "不想聊",
    "无关",
    "没关系",
    "没有关系",
    "not about",
    "unrelated",
    "isn't",
    "is not",
    "isnt",
    "aren't",
    "are not",
    "not ",
    "don't mean",
    "do not mean",
    "is unrelated",
    "isn't related",
)
_TOPIC_CLAUSE_BOUNDARIES = (
    "，",
    ",",
    "。",
    ".",
    "！",
    "!",
    "？",
    "?",
    "；",
    ";",
    "\n",
    " but ",
    " however ",
    "而是",
    "但是",
    "但",
)
_FOLLOW_UP_MARKERS = (
    "任务",
    "怎么做",
    "怎么办",
    "具体",
    "继续",
    "给我",
    "建议",
    "接下来",
    "哪些",
    "什么引导",
    "什么样的引导",
    "如何",
)
_ACTION_REQUEST_LABELS = (
    ("任务", "可执行任务"),
    ("方案", "可执行方案"),
    ("计划", "行动计划"),
    ("练习", "日常练习"),
    ("步骤", "具体步骤"),
    ("怎么做", "具体做法"),
    ("怎么办", "具体做法"),
    ("action plan", "行动方案"),
    ("task", "可执行任务"),
)
_ACTION_ONLY_FILLERS = (
    "也",
    "再",
    "请",
    "帮我",
    "给我",
    "可以",
    "能不能",
    "想要",
    "需要",
    "一些",
    "几个",
    "一个",
    "具体",
    "接下来",
    "现在",
    "吧",
    "吗",
    "呢",
    "please",
    "give me",
    "some",
    "a",
    "an",
    "the",
    "for me",
    "create",
    "make",
    "can you",
    "could you",
    "would you",
    "你",
    "适合我的",
    "適合我的",
    "适合我",
    "適合我",
    "个",
    "個",
    "项",
    "項",
    "条",
    "條",
)
_TOPIC_SIGNAL_ALIASES: dict[str, tuple[str, ...]] = {
    "learn_language_milestones": (
        "发声",
        "轮流发声",
        "音节",
        "重复音节",
        "模仿音节",
        "学他发音",
        "学她发音",
        "咿呀",
        "语音理解",
        "模仿声音",
        "声音回应",
        "回应名字",
        "名字反应",
        "叫他或她时会回应",
        "叫他时会回应",
        "叫她时会回应",
        "听到名字会回应",
        "短句回应",
    ),
    "learn_serve_and_return": (
        "轮流互动",
        "轮流回应",
        "跟随孩子",
        "陪孩子",
        "陪娃",
        "陪他的时间",
        "陪她的时间",
        "陪孩子的时间",
        "陪宝宝的时间",
        "陪娃的时间",
        "陪伴时间",
        "没空陪孩子",
        "没空陪他",
        "没空陪她",
        "很少陪孩子",
        "很少陪他",
        "很少陪她",
        "主要是妈妈在照顾",
        "主要是妈妈再照顾",
        "主要是爸爸在照顾",
        "主要是爸爸再照顾",
        "主要由妈妈照顾",
        "主要由爸爸照顾",
    ),
}
_PRODUCT_META_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:为什么|为何|为啥|怎么|怎么会|还是|又|一直|现在|这里|这个地方)?"
        r"[^，。！？,;!?\n]{0,10}(?:没有|没|未|不显示|看不到|找不到|没收到)"
        r"[^，。！？,;!?\n]{0,16}(?:任[务務]卡(?:片)?|推送卡片|推荐卡片|推薦卡片)",
        r"(?:任[务務]卡(?:片)?|推送卡片|推荐卡片|推薦卡片)"
        r"[^，。！？,;!?\n]{0,16}(?:在哪|在哪里|不见|不見|没有|沒有|没了|沒了|"
        r"不显示|不顯示|看不到|找不到|没生成|沒生成|未生成)",
        r"(?:系统|系統|页面|頁面|首页|首頁|应用|應用|app|nuri|你)"
        r"[^，。！？,;!?\n]{0,16}(?:没有|沒有|没|沒|未|不)"
        r"[^，。！？,;!?\n]{0,12}(?:生成|显示|顯示|给|給)"
        r"[^，。！？,;!?\n]{0,8}(?:任[务務]卡(?:片)?|推荐卡片|推薦卡片)",
        r"\b(?:why|where|how come)\b[^.?!\n]{0,32}"
        r"\b(?:task cards?|recommendation cards?)\b|"
        r"\b(?:task cards?|recommendation cards?)\b[^.?!\n]{0,24}"
        r"\b(?:missing|not showing|not generated|gone)\b",
    )
)
_RECOMMENDATION_FEEDBACK_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:(?:这个|這個|这条|這條|这些|這些)\s*)?"
        r"(?:这段内容|這段內容|这段推荐|這段推薦|推荐(?:卡片|内容)?|"
        r"推薦(?:卡片|內容)?|推送(?:卡片|内容|內容)?|"
        r"卡片|你给的(?:推荐|内容|卡片)|你給的(?:推薦|內容|卡片))"
        r"[^，。！？,;!?\n]{0,24}(?:不相关|不相關|无关|無關|不准确|不準確|"
        r"不够准确|不夠準確|不合适|不合適|不适合|不適合|"
        r"关系不大|關係不大|不是我想要的)",
        r"(?:不相关|不相關|无关|無關|不准确|不準確|不够准确|不夠準確)"
        r"[^，。！？,;!?\n]{0,16}(?:推荐|推薦|推送|内容|內容|卡片|对话|對話)",
        r"\b(?:this|these|the|your)?\s*"
        r"(?:recommendations?|suggestions?|recommended\s+content|suggested\s+content|"
        r"content|cards?)\b[^.?!\n]{0,32}"
        r"\b(?:irrelevant|not\s+relevant|inaccurate|not\s+accurate|"
        r"unsuitable|not\s+suitable)\b",
        r"\b(?:irrelevant|not\s+relevant|inaccurate|not\s+accurate|"
        r"unsuitable|not\s+suitable)\b[^.?!\n]{0,32}"
        r"\b(?:recommendations?|suggestions?|content|cards?)\b",
    )
)
_CONVERSATION_META_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:我们|我們).{0,8}(?:讨论过|討論過|聊过|聊過).{0,8}(?:什么|什麼)",
        r"你.{0,8}(?:记得|記得).{0,8}(?:什么|什麼)",
        r"你.{0,8}(?:认为|認為|觉得|覺得)我.{0,12}(?:什么样|什麼樣).{0,8}(?:父亲|父親|爸爸|母亲|母親|妈妈|媽媽)",
        r"\bwhat\s+(?:have|did)\s+we\s+(?:discuss(?:ed)?|talk(?:ed)?\s+about)\b",
        r"\bwhat\s+do\s+you\s+remember\s+about\s+me\b",
        r"\bwhat\s+kind\s+of\s+(?:father|mother|parent)\s+do\s+you\s+think\s+i\s+am\b",
    )
)
_GENERIC_CONTEXT_REQUEST_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"你?.{0,6}(?:认为|認為|觉得|覺得)?我(?:现在|現在)?"
        r".{0,6}最需要.{0,8}(?:什么样|什麼樣|什么|什麼)?"
        r".{0,6}(?:引导|引導|帮助|幫助|建议|建議|支持)",
        r"(?:结合|結合|根据|根據).{0,12}(?:我的情况|我的情況|我们的对话|我們的對話)"
        r".{0,12}(?:给我|給我|推荐|推薦|建议|建議)",
    )
)
_CONTEXT_CORRECTION_ONLY_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"^我?(?:并|並)?(?:没有|沒有|没|沒|不是|并不是|並不是|不觉得|不覺得|不认为|不認為)"
        r".{0,12}(?:愧疚|内疚|內疚|自责|自責|后悔|後悔|焦虑|焦慮)[啊呀吧呢]?$",
    )
)
_NON_PARENTING_TOPIC_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:只|只是|仅仅|僅僅).{0,10}(?:创业|創業|公司|工作|生意)"
        r".{0,12}(?:没有|沒有|没|沒|未|不).{0,8}(?:谈|談|聊|说|說|涉及)"
        r".{0,6}(?:孩子|宝宝|寶寶|育儿|育兒)",
        r"(?:创业|創業|公司|工作|生意).{0,12}(?:和|与|與)"
        r".{0,6}(?:孩子|宝宝|寶寶|育儿|育兒).{0,6}(?:无关|無關|没关系|沒關係)",
        r"(?:这次|這次|这里|這裡|当前|當前)?\s*"
        r"(?:没有|沒有|没|沒|未|不在|不是在)"
        r".{0,4}(?:谈|談|聊|说|說|讨论|討論|涉及)"
        r".{0,10}(?:孩子|宝宝|寶寶|育儿|育兒|陪伴|亲子|親子)",
    )
)
_PARENTING_CONTEXT_TERMS = (
    "孩子",
    "宝宝",
    "寶寶",
    "宝贝",
    "寶貝",
    "育儿",
    "育兒",
    "亲子",
    "親子",
    "陪伴",
    "陪他",
    "陪她",
    "照顾他",
    "照顧他",
    "照顾她",
    "照顧她",
    "儿子",
    "兒子",
    "女儿",
    "女兒",
)
_DYNAMIC_PARENTING_DOMAIN_TERMS = (
    "child",
    "children",
    "baby",
    "parent",
    "family",
    "caregiver",
    "father",
    "mother",
    "dad",
    "mom",
    "school",
    "preschool",
    "daycare",
    "父亲",
    "父親",
    "母亲",
    "母親",
    "爸爸",
    "妈妈",
    "媽媽",
    "家长",
    "家長",
    "家庭",
    "照顾者",
    "照顧者",
    "蒙特梭利",
    "montessori",
    "森林学校",
    "森林學校",
    "forest school",
    "幼儿园",
    "幼兒園",
    "托育",
    "早教",
    "学校",
    "學校",
    "堂兄",
    "堂姐",
    "亲属",
    "親屬",
    "霸凌",
    "移居",
)
_CONTEXT_REJECTION_MARKERS = (
    "不想继续",
    "不要继续",
    "别再",
    "不再聊",
    "换个话题",
    "换一个话题",
    "另一个话题",
    "别聊",
    "不想聊",
    "stop talking",
    "don't continue",
    "do not continue",
    "change the subject",
    "different topic",
    "move on",
)
_ACKNOWLEDGEMENT_ONLY = frozenset(
    {"谢谢", "谢谢你", "好的", "好", "明白了", "知道了", "收到", "ok", "okay", "thanks", "thank you"}
)
_DYNAMIC_RESEARCH_CARD_PREFIX = "learn_conversation_"


def _is_acknowledgement_only(text: str) -> bool:
    """Recognize one or more acknowledgement phrases with no real topic."""

    normalized = re.sub(r"[\s，。！？,.!?]+", "", text.casefold())
    if not normalized:
        return True
    tokens = sorted(
        {
            re.sub(r"[\s，。！？,.!?]+", "", value.casefold())
            for value in _ACKNOWLEDGEMENT_ONLY
        },
        key=len,
        reverse=True,
    )
    residue = normalized
    for token in tokens:
        residue = residue.replace(token, "")
    return not residue


def _is_product_meta_request(text: str) -> bool:
    """Exclude feedback about NURI's UI/cards from parenting-topic ranking."""

    normalized = " ".join((text or "").strip().split())
    return bool(normalized) and any(
        pattern.search(normalized) for pattern in _PRODUCT_META_PATTERNS
    )


def _is_recommendation_feedback(text: str) -> bool:
    normalized = " ".join((text or "").strip().split())
    return bool(normalized) and any(
        pattern.search(normalized) for pattern in _RECOMMENDATION_FEEDBACK_PATTERNS
    )


def _is_conversation_meta_request(text: str) -> bool:
    normalized = " ".join((text or "").strip().split())
    return bool(normalized) and any(
        pattern.search(normalized) for pattern in _CONVERSATION_META_PATTERNS
    )


def _is_context_correction_only(text: str) -> bool:
    normalized = " ".join((text or "").strip().split()).strip("，。！？,.!?；;：:")
    return bool(normalized) and any(
        pattern.fullmatch(normalized)
        for pattern in _CONTEXT_CORRECTION_ONLY_PATTERNS
    )


def _is_explicitly_non_parenting_topic(text: str) -> bool:
    normalized = " ".join((text or "").strip().split())
    return bool(normalized) and any(
        pattern.search(normalized) for pattern in _NON_PARENTING_TOPIC_PATTERNS
    )


def _is_generic_context_request(text: str) -> bool:
    normalized = " ".join((text or "").strip().split()).strip(
        "，。！？,.!?；;：:"
    )
    if _is_action_only_request(normalized):
        return True
    return bool(normalized) and any(
        pattern.fullmatch(normalized) for pattern in _GENERIC_CONTEXT_REQUEST_PATTERNS
    )


def _clean_parenting_signal(text: str) -> str:
    """Remove product/conversation feedback clauses, preserving family facts."""

    normalized = " ".join((text or "").strip().split())
    if not normalized:
        return ""
    clauses = re.split(
        r"(?:[，,。！？!?；;]+|但是|但|不过|不過|其实|其實|然而)",
        normalized,
    )
    kept: list[str] = []
    for raw_clause in clauses:
        clause = raw_clause.strip(" \t\r\n，。！？,.!?；;：:")
        if not clause:
            continue
        if (
            _is_product_meta_request(clause)
            or _is_recommendation_feedback(clause)
            or _is_conversation_meta_request(clause)
            or _is_context_correction_only(clause)
            or _is_explicitly_non_parenting_topic(clause)
        ):
            continue
        kept.append(clause)
    return "，".join(kept)


def _current_action_intent(text: str) -> Optional[str]:
    casefolded = text.casefold()
    return next(
        (label for marker, label in _ACTION_REQUEST_LABELS if marker in casefolded),
        None,
    )


def _recommendation_intent_code(text: str) -> str:
    casefolded = text.casefold()
    if _current_action_intent(casefolded):
        return "action_plan"
    if any(marker in casefolded for marker in ("比较", "对比", "区别", "怎么选", "选择", " vs ", " versus ")):
        return "compare"
    if any(
        marker in casefolded
        for marker in (
            "我很累",
            "我撑不住",
            "我快崩溃",
            "我很焦虑",
            "安慰我",
            "陪陪我",
            "support me",
        )
    ):
        return "support"
    return "learn"


def _is_action_only_request(text: str) -> bool:
    """Detect generic requests such as “给我一些任务吧” without a topic."""

    if not _current_action_intent(text):
        return False
    residue = text.casefold()
    for marker, _label in _ACTION_REQUEST_LABELS:
        if re.fullmatch(r"[a-z][a-z ]*", marker):
            suffix = "s?" if marker == "task" else ""
            residue = re.sub(
                rf"(?<![a-z0-9]){re.escape(marker)}{suffix}(?![a-z0-9])",
                " ",
                residue,
            )
        else:
            residue = residue.replace(marker, "")
    for filler in _ACTION_ONLY_FILLERS:
        if re.fullmatch(r"[a-z][a-z ]*", filler):
            residue = re.sub(
                rf"(?<![a-z0-9]){re.escape(filler)}(?![a-z0-9])",
                " ",
                residue,
            )
        else:
            residue = residue.replace(filler, "")
    residue = re.sub(r"(?:\d+|[一二两兩三四五六七八九十百几幾]+)", "", residue)
    residue = re.sub(r"[^a-z0-9\u3400-\u9fff]+", "", residue)
    return not residue


def _conversation_goal_signal(messages: list[dict]) -> tuple[str, str]:
    """Return the nearest concrete user goal and whether it is cross-session."""

    user_messages = [
        message
        for message in messages
        if message.get("role") == "user" and str(message.get("text") or "").strip()
    ]
    current_messages = [
        message
        for message in user_messages
        if message.get("context_scope") != "account_history"
    ]
    history_messages = [
        message
        for message in user_messages
        if message.get("context_scope") == "account_history"
    ]
    for scope, candidates in (
        ("current_session", current_messages),
        ("account_history", history_messages),
    ):
        for message in reversed(candidates):
            raw_text = str(message.get("text") or "").strip()
            text = _clean_parenting_signal(raw_text)
            if (
                _is_acknowledgement_only(text)
                or _is_generic_context_request(raw_text)
                or not text
            ):
                continue
            return text, scope
    latest = _clean_parenting_signal(
        str((current_messages or history_messages or [{}])[-1].get("text") or "")
    )
    return latest, "current_session" if current_messages else "account_history"


def _conversation_topic_excerpt(messages: list[dict], limit: int = 84) -> str:
    """Return a short, redacted description of the latest real user topic."""

    latest, _scope = _conversation_goal_signal(messages)
    topic = " ".join(redact_conversation_text(latest, 240).split())
    topic = topic.strip(" \t\r\n，。！？,.!?；;：:")
    if len(topic) > limit:
        topic = f"{topic[: limit - 1].rstrip()}…"
    return topic


def _has_parenting_domain_signal(topic: str) -> bool:
    normalized = " ".join((topic or "").casefold().split())
    if not normalized:
        return False
    if _matched_terms(
        normalized,
        [*_PARENTING_CONTEXT_TERMS, *_DYNAMIC_PARENTING_DOMAIN_TERMS],
    ):
        return True
    for card in LEARNING_CONTENT_CARDS:
        terms = [
            *card.get("match_terms", []),
            *_TOPIC_SIGNAL_ALIASES.get(str(card.get("id") or ""), ()),
        ]
        if _matched_terms(normalized, terms):
            return True
    return False


def _is_dynamic_topic_candidate(topic: str) -> bool:
    if _is_acknowledgement_only(topic):
        return False
    if _is_generic_context_request(topic):
        return False
    if (
        _is_product_meta_request(topic)
        or _is_recommendation_feedback(topic)
        or _is_conversation_meta_request(topic)
        or _is_explicitly_non_parenting_topic(topic)
    ):
        return False
    if not _has_parenting_domain_signal(topic):
        return False
    # “换个话题” alone contains no topic to research.  Once the user names a
    # concrete new subject, the longer message remains eligible.
    if len(topic) <= 60 and any(
        marker in topic.casefold() for marker in _CONTEXT_REJECTION_MARKERS
    ):
        return False
    return True


def _dynamic_research_card_id(
    *,
    session_id: Optional[str],
    context_created_at: Optional[str],
    topic: str,
) -> str:
    """Build an addressable ID without placing conversation text in the URL."""

    normalized_topic = " ".join(topic.casefold().split())
    material = "\n".join(
        (session_id or "no-session", context_created_at or "no-time", normalized_topic)
    )
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:20]
    return f"{_DYNAMIC_RESEARCH_CARD_PREFIX}{digest}"


def _build_dynamic_research_card(
    messages: list[dict],
    *,
    session_id: Optional[str],
    context_created_at: Optional[str],
    include_detail: bool,
) -> Optional[dict]:
    """Create a transient card for a real topic outside the reviewed library.

    A dynamic card deliberately has no static resources.  Presenting a sleep,
    emotion or development bundle under an unrelated topic (for example,
    Montessori school choice) is more misleading than showing a bounded
    research state.  The research endpoint only publishes a complete verified
    six-to-nine item bundle; the frontend hides category shelves until that
    quality threshold is met.
    """

    topic = _conversation_topic_excerpt(messages)
    if not _is_dynamic_topic_candidate(topic):
        return None
    card_id = _dynamic_research_card_id(
        session_id=session_id,
        context_created_at=context_created_at,
        topic=topic,
    )
    latest_current_user_text = next(
        (
            str(message.get("text") or "")
            for message in reversed(messages)
            if message.get("role") == "user"
            and message.get("context_scope") != "account_history"
        ),
        topic,
    )
    intent_source = (
        topic
        if (
            _is_product_meta_request(latest_current_user_text)
            or _is_recommendation_feedback(latest_current_user_text)
            or _is_conversation_meta_request(latest_current_user_text)
            or _is_context_correction_only(latest_current_user_text)
        )
        else latest_current_user_text
    )
    card = {
        "id": card_id,
        "topic": topic,
        "topic_label": topic,
        "type": "tip",
        "type_label": "对话精选",
        "cta": "为这次对话检索内容",
        "publisher": "NURI 个性化内容研究",
        "title": f"继续了解：{topic}",
        "summary": (
            "NURI 会依据这次对话，分别核验权威内容、精彩解读和真实家庭案例。"
        ),
        "personalization_reason": f"因为你最近和 NURI 聊到“{topic}”",
        "is_conversation_match": True,
        "is_dynamic_research_card": True,
        "related_session_id": session_id,
        "context_created_at": context_created_at,
        "recommendation_focus": topic,
        "recommendation_intent": _recommendation_intent_code(intent_source),
        "recommendation_score": _CONVERSATION_MATCH_MIN_SCORE,
    }
    if include_detail:
        card.update(
            {
                "body": (
                    "这是根据你刚刚提出的具体问题建立的学习主题。完成外部检索后，"
                    "这里只会展示六至九项通过来源、语言和内容核验的结果：三个类别，"
                    "每类至少一篇文章和一个视频；第三项只有同样可靠时才会加入。"
                ),
                "hook_line": "让 NURI 围绕这次真实对话继续筛选。",
                "tags": ["#对话相关", "#个性化检索"],
                "resources": [],
            }
        )
    return card


def _restore_dynamic_research_card_from_snapshot(
    snapshot: dict,
    *,
    include_detail: bool,
) -> Optional[dict]:
    """Rebuild a novel-topic card when its goal came from account history.

    A detail request deliberately reloads only the bound main session.  For a
    generic current follow-up such as “给我任务”, that session may not contain
    the concrete cross-session topic that originally created the dynamic card.
    The snapshot keeps only the bounded, redacted focus required to restore it.
    """

    focus = str(snapshot.get("recommendation_focus") or "").strip()
    if not focus:
        return None
    card = _build_dynamic_research_card(
        [
            {
                "role": "user",
                "text": focus,
                "context_scope": "current_session",
            }
        ],
        session_id=snapshot.get("session_id"),
        context_created_at=snapshot.get("context_created_at"),
        include_detail=include_detail,
    )
    if card:
        card["id"] = snapshot["card_id"]
    return card


def _term_occurrences(text: str, term: str) -> list[tuple[int, int]]:
    """Find complete English terms and literal CJK phrases."""

    if not text or not term:
        return []
    normalized_term = term.casefold()
    if re.fullmatch(r"[a-z0-9][a-z0-9 '\-]*", normalized_term):
        pattern = re.compile(
            rf"(?<![a-z0-9]){re.escape(normalized_term)}(?![a-z0-9])",
            re.IGNORECASE,
        )
        return [(match.start(), match.end()) for match in pattern.finditer(text)]

    positions: list[tuple[int, int]] = []
    start = 0
    while True:
        index = text.find(normalized_term, start)
        if index < 0:
            break
        positions.append((index, index + len(normalized_term)))
        start = index + max(1, len(normalized_term))
    return positions


def _term_is_present(text: str, term: str) -> bool:
    """Return True when at least one occurrence is not locally negated."""

    for start, end in _term_occurrences(text, term):
        clause_start = 0
        clause_end = len(text)
        for boundary in _TOPIC_CLAUSE_BOUNDARIES:
            previous = text.rfind(boundary, 0, start)
            if previous >= 0:
                clause_start = max(clause_start, previous + len(boundary))
            following = text.find(boundary, end)
            if following >= 0:
                clause_end = min(clause_end, following)
        clause = text[clause_start:clause_end]
        if not any(marker in clause for marker in _NEGATION_MARKERS):
            return True
    return False


def _matched_terms(text: str, terms: list[object]) -> list[str]:
    """Return specific, non-overlapping topic signals found in ``text``."""

    matches = {
        str(raw_term).casefold()
        for raw_term in terms
        if str(raw_term).strip() and _term_is_present(text, str(raw_term).casefold())
    }
    ordered = sorted(matches, key=lambda value: (-len(value), value))
    selected: list[str] = []
    for term in ordered:
        if any(term in more_specific for more_specific in selected):
            continue
        selected.append(term)
    return selected


def _signal_score(matches: list[str], strong_base: int, weak_base: int, bonus_cap: int) -> int:
    if not matches:
        return 0
    has_strong_signal = any(term not in _WEAK_MATCH_TERMS for term in matches)
    base = strong_base if has_strong_signal else weak_base
    return base + min(bonus_cap, max(0, len(matches) - 1))


def _is_context_follow_up(text: str) -> bool:
    casefolded = text.casefold()
    if _is_acknowledgement_only(text):
        return False
    if any(marker in casefolded for marker in _CONTEXT_REJECTION_MARKERS):
        return False
    return any(marker in casefolded for marker in _FOLLOW_UP_MARKERS)


def _conversation_focus_for_terms(
    messages: list[dict], terms: list[object]
) -> tuple[str, str]:
    """Return the closest substantive user statement matching one card."""

    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        raw_text = str(message.get("text") or "").strip()
        text = _clean_parenting_signal(raw_text)
        if (
            not text
            or _is_acknowledgement_only(text)
            or _is_generic_context_request(raw_text)
        ):
            continue
        if _matched_terms(text.casefold(), terms):
            scope = (
                "account_history"
                if message.get("context_scope") == "account_history"
                else "current_session"
            )
            return text, scope
    return "", "current_session"


def _rank_learning_content(
    messages: list[dict],
    count: int = 4,
    session_id: Optional[str] = None,
    context_created_at: Optional[str] = None,
    context_state: str = "ready",
    include_detail: bool = False,
    behavior_events: Optional[list[dict]] = None,
) -> tuple[list[dict], bool]:
    """Rank candidates by conversation relevance, affinity, and freshness."""

    raw_current_user_texts = [
        str(message.get("text") or "").strip()
        for message in messages
        if message.get("role") == "user" and str(message.get("text") or "").strip()
        and message.get("context_scope") != "account_history"
    ]
    raw_historical_user_texts = [
        str(message.get("text") or "").strip()
        for message in messages
        if message.get("role") == "user" and str(message.get("text") or "").strip()
        and message.get("context_scope") == "account_history"
    ]
    current_user_texts = [
        cleaned
        for text in raw_current_user_texts
        if (cleaned := _clean_parenting_signal(text))
    ]
    historical_user_texts = [
        cleaned
        for text in raw_historical_user_texts
        if (cleaned := _clean_parenting_signal(text))
    ]
    user_texts = [*historical_user_texts, *current_user_texts]
    raw_last_user_text = raw_current_user_texts[-1] if raw_current_user_texts else ""
    cleaned_last_user_text = _clean_parenting_signal(raw_last_user_text)
    latest_meta_feedback = bool(raw_last_user_text) and (
        _is_product_meta_request(raw_last_user_text)
        or _is_recommendation_feedback(raw_last_user_text)
        or _is_conversation_meta_request(raw_last_user_text)
        or _is_context_correction_only(raw_last_user_text)
    )
    latest_meta_only = latest_meta_feedback and not cleaned_last_user_text
    generic_context_request = _is_generic_context_request(raw_last_user_text)
    topical_current_user_texts = [
        cleaned
        for raw_text in raw_current_user_texts
        if (cleaned := _clean_parenting_signal(raw_text))
        and not _is_acknowledgement_only(cleaned)
        and not _is_generic_context_request(raw_text)
    ]
    # Partition only substantive family statements.  Generic task/guidance
    # requests, corrections and product feedback therefore do not consume the
    # four-message topical window in a long-running main conversation.
    last_user_text = (
        topical_current_user_texts[-1].casefold()
        if topical_current_user_texts
        else ""
    )
    previous_user_text = " ".join(topical_current_user_texts[-4:-1]).casefold()
    older_user_text = " ".join(topical_current_user_texts[:-4]).casefold()
    substantive_history_texts = [
        cleaned
        for raw_text in raw_historical_user_texts
        if (cleaned := _clean_parenting_signal(raw_text))
        and not _is_acknowledgement_only(cleaned)
        and not _is_generic_context_request(raw_text)
    ]
    latest_history_text = (
        substantive_history_texts[-1].casefold()
        if substantive_history_texts
        else ""
    )
    older_history_text = " ".join(substantive_history_texts[:-1]).casefold()
    allow_assistant_context = (
        not latest_meta_only and _is_context_follow_up(raw_last_user_text)
    )
    action_intent = (
        None if latest_meta_only else _current_action_intent(raw_last_user_text)
    )
    action_only_request = _is_action_only_request(raw_last_user_text)
    inherit_prior_context = generic_context_request or latest_meta_only
    goal_text, goal_scope = _conversation_goal_signal(messages)
    safe_goal = " ".join(redact_conversation_text(goal_text, 160).split())
    if len(safe_goal) > 48:
        safe_goal = f"{safe_goal[:47].rstrip()}…"

    last_user_index = max(
        (
            index
            for index, message in enumerate(messages)
            if message.get("role") == "user"
            and message.get("context_scope") != "account_history"
        ),
        default=-1,
    )
    assistants_after_user = [
        str(message.get("text") or "").strip()
        for message in messages[last_user_index + 1 :]
        if message.get("role") in {"ai", "assistant"}
        and str(message.get("text") or "").strip()
    ]
    assistants_before_user = [
        str(message.get("text") or "").strip()
        for message in messages[:last_user_index]
        if message.get("role") in {"ai", "assistant"}
        and str(message.get("text") or "").strip()
    ]
    if latest_meta_only:
        assistant_context_text = ""
    elif assistants_after_user:
        assistant_context_text = assistants_after_user[-1].casefold()
    elif allow_assistant_context and assistants_before_user:
        # A short follow-up such as “给我几个任务” legitimately refers to the
        # immediately preceding NURI answer.  Explicit topic switches do not.
        assistant_context_text = assistants_before_user[-1].casefold()
    else:
        assistant_context_text = ""

    ranked: list[
        tuple[int, int, int, int, dict, Optional[str], str, str, dict]
    ] = []
    for index, card in enumerate(LEARNING_CONTENT_CARDS):
        terms = [
            *card.get("match_terms", []),
            *_TOPIC_SIGNAL_ALIASES.get(str(card.get("id") or ""), ()),
        ]
        latest_matches = _matched_terms(last_user_text, terms)
        recent_matches = _matched_terms(previous_user_text, terms)
        older_matches = _matched_terms(older_user_text, terms)
        latest_history_matches = _matched_terms(latest_history_text, terms)
        older_history_matches = _matched_terms(older_history_text, terms)
        assistant_matches = _matched_terms(assistant_context_text, terms)

        latest_score = _signal_score(latest_matches, 14, 5, 3)
        recent_score = _signal_score(recent_matches, 10, 3, 3)
        # Older statements provide continuity, but cannot outweigh a concrete
        # need the parent expressed more recently.  This matters in one long
        # main chat where a topic may have been repeated many times before the
        # user's situation changed (for example, a busy parent asking for
        # short, high-quality ways to connect after discussing milestones).
        older_matching_message_count = sum(
            1
            for text in topical_current_user_texts[:-4]
            if _matched_terms(text.casefold(), terms)
        )
        # One old mention stays below the personalization threshold.  A topic
        # the parent returned to several times remains eligible as a secondary
        # card even when a newer concern becomes Top-1.  This preserves durable
        # themes such as repeated questions about a child's key developmental
        # window without letting one stale aside outrank the current need.
        older_repeat_bonus = min(4, max(0, older_matching_message_count - 1))
        older_score = (
            _signal_score(older_matches, 5, 1, 1) + older_repeat_bonus
        )
        # Cross-session history is continuity, not the present request.  It can
        # resolve a generic “give me a task” follow-up, but otherwise remains a
        # weak preference signal and cannot establish a personalized match.
        history_score = _signal_score(
            latest_history_matches,
            8 if inherit_prior_context and not recent_matches else 3,
            2 if inherit_prior_context and not recent_matches else 1,
            2,
        )
        history_score += _signal_score(older_history_matches, 1, 0, 1)
        user_signal_score = latest_score + recent_score + older_score + history_score
        assistant_score = 0
        if assistant_context_text and (latest_matches or recent_matches or history_score):
            # Assistant text may clarify a user-established goal, never create
            # one.  This prevents a broad AI aside such as “精细动作” from
            # outranking the parent's explicit language-interaction concern.
            assistant_score = _signal_score(assistant_matches, 3, 1, 1)
        conversation_score = user_signal_score + assistant_score
        behavior = card_behavior_signal(
            str(card.get("id") or ""),
            behavior_events or [],
        )
        score = conversation_score + int(behavior.get("score") or 0)

        reason_term = next(
            (
                candidate
                for candidates in (
                    latest_matches,
                    recent_matches,
                    latest_history_matches,
                    assistant_matches,
                )
                for candidate in candidates
                if candidate not in _WEAK_MATCH_TERMS
            ),
            None,
        )
        focus_text, focus_scope = _conversation_focus_for_terms(messages, terms)
        ranked.append(
            (
                score,
                conversation_score,
                user_signal_score,
                index,
                card,
                reason_term,
                focus_text,
                focus_scope,
                behavior,
            )
        )

    def _eligible_match(item: tuple) -> bool:
        return bool(
            item[1] >= _CONVERSATION_MATCH_MIN_SCORE
            and item[2] >= _CONVERSATION_MATCH_MIN_SCORE
            and not item[8].get("explicit_negative")
        )

    # A prior click must never manufacture relevance for an unrelated current
    # conversation. Eligible conversation candidates come first; behaviour and
    # freshness only reorder candidates inside that pool.
    ranked.sort(
        key=lambda item: (
            not _eligible_match(item),
            -item[0],
            -item[1],
            item[3],
        )
    )
    has_conversation_match = bool(
        raw_current_user_texts
        and ranked
        and any(_eligible_match(item) for item in ranked)
    )
    has_explicitly_rejected_match = bool(
        raw_current_user_texts
        and any(
            item[1] >= _CONVERSATION_MATCH_MIN_SCORE
            and item[2] >= _CONVERSATION_MATCH_MIN_SCORE
            and item[8].get("explicit_negative")
            for item in ranked
        )
    )
    selected: list[dict] = []
    for (
        score,
        conversation_score,
        user_signal_score,
        _,
        card,
        reason_term,
        focus_text,
        focus_scope,
        behavior,
    ) in ranked[
        : max(1, min(count, len(LEARNING_CONTENT_CARDS)))
    ]:
        safe_focus = " ".join(redact_conversation_text(focus_text, 160).split())
        if len(safe_focus) > 48:
            safe_focus = f"{safe_focus[:47].rstrip()}…"
        if not safe_focus:
            safe_focus = safe_goal
        if (
            conversation_score >= _CONVERSATION_MATCH_MIN_SCORE
            and user_signal_score >= _CONVERSATION_MATCH_MIN_SCORE
            and has_conversation_match
            and not behavior.get("explicit_negative")
        ):
            if latest_meta_only and safe_focus:
                continuity = (
                    "结合你最近其他对话里提到的"
                    if focus_scope == "account_history"
                    else "延续你之前提到的"
                )
                reason = (
                    f"{continuity}“{safe_focus}”，"
                    f"这篇内容与“{card['topic_label']}”直接相关"
                )
            elif action_intent and safe_focus:
                continuity = "结合你最近其他对话里提到的" if focus_scope == "account_history" else "延续你提到的"
                reason = (
                    f"你现在想要{action_intent}，{continuity}“{safe_focus}”；"
                    f"这篇内容与“{card['topic_label']}”直接相关"
                )
            elif inherit_prior_context and safe_focus:
                continuity = "结合你最近其他对话里提到的" if focus_scope == "account_history" else "延续你之前提到的"
                reason = (
                    f"{continuity}“{safe_focus}”，"
                    f"这篇内容与“{card['topic_label']}”直接相关"
                )
            elif reason_term:
                reason = (
                    f"因为你最近重点聊到“{reason_term}”，"
                    f"这篇内容与“{card['topic_label']}”直接相关"
                )
            else:
                reason = f"因为你最近和 NURI 聊到了“{card['topic_label']}”"
            related_session_id = session_id
            is_match = True
        elif context_state == "privacy_off":
            reason = "你已关闭对话个性化，这是 NURI 的可信来源精选"
            related_session_id = None
            is_match = False
        elif context_state == "unavailable":
            reason = "近期对话暂时无法读取，这是 NURI 的可信来源精选"
            related_session_id = None
            is_match = False
        elif not user_texts:
            reason = "还没有足够的近期对话，这是 NURI 的可信来源精选"
            related_session_id = None
            is_match = False
        else:
            reason = "NURI 从可信育儿来源中为你补充精选"
            related_session_id = None
            is_match = False

        hidden_fields = {"match_terms"}
        if not include_detail:
            hidden_fields.update({"body", "hook_line", "resources", "tags"})
        public_card = {key: value for key, value in card.items() if key not in hidden_fields}
        public_card.update(
            {
                "personalization_reason": reason,
                "is_conversation_match": is_match,
                "related_session_id": related_session_id,
            }
        )
        if is_match:
            public_card.update(
                {
                    "recommendation_focus": safe_focus or reason_term or card["topic_label"],
                    "recommendation_intent": _recommendation_intent_code(
                        raw_last_user_text
                        if action_intent
                        else (safe_focus or goal_text)
                    ),
                    "recommendation_score": score,
                    "reason_codes": [
                        "recent_conversation",
                        *(
                            ["learned_preference"]
                            if int(behavior.get("affinity") or 0) > 0
                            else []
                        ),
                        *(
                            ["freshness_adjusted"]
                            if int(behavior.get("freshness_penalty") or 0) < 0
                            else []
                        ),
                    ],
                }
            )
        selected.append(public_card)

    if (
        not has_conversation_match
        and not has_explicitly_rejected_match
        and context_state == "ready"
        and raw_current_user_texts
    ):
        dynamic_card = _build_dynamic_research_card(
            messages,
            session_id=session_id,
            context_created_at=context_created_at,
            include_detail=include_detail,
        )
        if dynamic_card:
            selected = [dynamic_card, *selected[: max(0, count - 1)]]
            has_conversation_match = True
    return selected, has_conversation_match


_CATEGORY_CARD_META = {
    "authority": {
        "label": "权威来源",
        "eyebrow": "事实与安全底线",
        "description": "来自政府、大学、医院、医学组织或专业期刊。",
        "fallback_title": "权威机构如何看“{topic_label}”",
        "fallback_publisher": "NURI 权威来源筛选",
    },
    "featured": {
        "label": "精选内容",
        "eyebrow": "清楚、实用、值得看",
        "description": "专业可靠、讲解精彩，也适合家庭直接使用。",
        "fallback_title": "围绕“{topic_label}”的实用方法精选",
        "fallback_publisher": "NURI 编辑精选",
    },
    "case": {
        "label": "真实案例",
        "eyebrow": "其他家庭的真实实践",
        "description": "用具体家庭经历呈现过程、调整与可借鉴做法。",
        "fallback_title": "其他家庭如何面对“{topic_label}”",
        "fallback_publisher": "NURI 真实家庭案例",
    },
}


_DELIVERY_ACTION_STEPS = {
    "authority": [
        "先看与孩子当前阶段对应的观察点",
        "用一周时间记录最常出现的行为和变化",
        "如果持续担心，带着记录咨询儿科或儿童发展专业人员",
    ],
    "featured": [
        "今天选择一个本来就会发生的日常场景",
        "照着内容示范练习五分钟，不额外增加复杂任务",
        "观察孩子的回应，明天只调整一个小地方",
    ],
    "case": [
        "先找出案例与你家处境最相似的一点",
        "只借鉴一个低风险做法试一周",
        "根据孩子反应调整，不把单个家庭经验当作诊断或保证",
    ],
}


def _resource_parent_org_id(resource: dict) -> str:
    """Return a stable organization key for package-level diversity."""

    # Never trust an externally supplied ``parent_org_id``. The shared source
    # policy derives identity from registered destination/evidence domains,
    # then reviewed publisher aliases or a deterministic host/creator fallback.
    return policy_resource_parent_org_id(resource)


def _resource_with_delivery_metadata(resource: dict) -> dict:
    """Add bounded presentation metadata without inventing source facts."""

    value = dict(resource)
    value["parent_org_id"] = _resource_parent_org_id(value)
    value.setdefault("author", "")
    value.setdefault("updated_at", "")
    if not isinstance(value.get("estimated_minutes"), int):
        value["estimated_minutes"] = 4 if value.get("kind") == "article" else 5
    return value


def _delivery_locale_priority(resource: dict, preferred_locale: Optional[str]) -> int:
    """Rank delivery language without letting an English fallback lead zh-CN.

    A Chinese account first sees an institution's official Chinese edition,
    then an original/allowlisted Chinese destination.  A NURI-guided English
    article remains a last-resort reading fallback.  English-audio video is
    ranked after every Chinese option (and the delivery gate normally rejects
    it entirely), so provider result order can never promote it accidentally.
    """

    if preferred_locale != "zh-CN":
        return 0
    kind = str(resource.get("kind") or "")
    translation_type = str(resource.get("translation_type") or "")
    source_language = str(resource.get("source_language") or "").casefold()
    content_locale = str(resource.get("content_locale") or "").casefold()
    display_locale = str(resource.get("display_locale") or "")
    spoken_language = str(resource.get("spoken_language") or "").casefold()

    # Video language is a hard user-experience boundary: subtitles, a Chinese
    # guide, or a localized title do not turn English audio into Chinese video.
    if kind == "video" and spoken_language not in {
        "mandarin",
        "putonghua",
        "chinese",
        "国语",
        "普通话",
        "华语",
    }:
        return 90
    if translation_type == "official_translation" and display_locale == "zh-CN":
        return 0
    # For a Simplified-Chinese account, verified Mandarin is the actual video
    # language requirement. A Taiwan Mandarin explanation should not be pushed
    # below a lower-quality mainland clip solely because its metadata uses
    # Traditional Chinese; the visible region/script label is still retained.
    if kind == "video" and display_locale == "zh-CN":
        return 1
    if display_locale == "zh-CN" and (
        source_language in {"zh", "zh-cn", "chinese", "mandarin"}
        or content_locale in {"zh", "zh-cn", "chinese", "mandarin"}
    ):
        return 1
    if (
        translation_type == "original"
        and (
            source_language in {"zh-tw", "traditional-chinese"}
            or content_locale in {"zh-tw", "traditional-chinese"}
        )
    ):
        return 5
    if (
        kind == "article"
        and source_language == "en"
        and translation_type == "nuri_guide"
        and display_locale == "zh-CN"
    ):
        return 10
    return 50


def _delivery_resource_sort_key(
    resource: dict,
    preferred_locale: Optional[str],
    content_category: str,
) -> tuple[int, int, int, int]:
    """Sort by language, editorial quality, authority, then freshness."""

    quality_priority = 0
    substance_status = str(
        resource.get("content_substance_status") or ""
    ).casefold()
    readability_status = str(
        resource.get("featured_readability_status") or ""
    ).casefold()
    case_process_status = str(
        resource.get("case_process_status") or ""
    ).casefold()
    case_reader_status = str(
        resource.get("case_reader_experience_status")
        or case_article_reader_experience_status(resource.get("url"))
    ).casefold()
    if str(resource.get("kind") or "") == "video":
        if substance_status in {"ad_like", "rejected"}:
            quality_priority = 90
        elif substance_status != "verified":
            quality_priority = 1
    if content_category == "featured":
        if readability_status == "rejected":
            quality_priority = 90
        elif readability_status != "verified":
            quality_priority = max(quality_priority, 1)
    if content_category == "case":
        if case_process_status in {"promotion_only", "rejected"}:
            quality_priority = 90
        elif case_process_status != "verified":
            quality_priority = max(quality_priority, 1)
        if str(resource.get("kind") or "") == "article":
            if case_reader_status == "rejected":
                quality_priority = 90
            elif case_reader_status != "verified":
                quality_priority = max(quality_priority, 1)

    authority_priority = 0
    if content_category == "authority":
        if _is_us_authority_resource(resource):
            authority_priority = 0
        elif _resource_parent_org_id(resource) in ENGLISH_AUTHORITY_SOURCE_PARENT_ORG_IDS:
            authority_priority = 1
        else:
            authority_priority = 2
    return (
        _delivery_locale_priority(resource, preferred_locale),
        quality_priority,
        authority_priority,
        0 if resource.get("research_source") == "openai_web_search" else 1,
    )


def _delivery_contract_pair(
    resources: list[dict],
    content_category: str,
    preferred_locale: str,
    *,
    require_dynamic: bool = True,
) -> list[dict]:
    """Select one publishable article/video pair that satisfies the lane contract."""

    matching = [
        _resource_with_delivery_metadata(resource)
        for resource in resources
        if str(resource.get("content_category") or "") == content_category
        and not delivery_lane_rejection_reason(
            resource,
            preferred_locale,
            require_dynamic=require_dynamic,
        )
    ]
    matching.sort(
        key=lambda resource: _delivery_resource_sort_key(
            resource,
            preferred_locale,
            content_category,
        )
    )
    pair: list[dict] = []
    for kind in ("article", "video"):
        resource = next(
            (item for item in matching if item.get("kind") == kind),
            None,
        )
        if resource:
            pair.append(resource)
    return pair


def _prepared_snapshot_set_meets_source_contract(snapshots: list[dict]) -> bool:
    """Reject previously prepared packages created under the old source rules."""

    if not snapshots or any(
        snapshot.get("version") != SNAPSHOT_VERSION
        or snapshot.get("context_version") != SNAPSHOT_CONTEXT_VERSION
        or snapshot.get("source_contract_version")
        != DELIVERY_SOURCE_CONTRACT_VERSION
        for snapshot in snapshots
    ):
        return False
    for snapshot in snapshots:
        category = str(snapshot.get("content_category") or "")
        locale = str(snapshot.get("preferred_locale") or "zh-CN")
        pairs = prepared_resource_pairs(snapshot)
        if not pairs:
            return False
        if any(
            len(
                _delivery_contract_pair(
                    pair["resources"],
                    category,
                    locale,
                    require_dynamic=False,
                )
            )
            != 2
            for pair in pairs
        ):
            return False
    return True


def _delivery_gate_diagnostics(
    resources: list[dict],
    locale: str,
    *,
    require_dynamic: bool = True,
) -> dict:
    reasons: dict[str, int] = {}
    accepted = {category: {"article": 0, "video": 0} for category in CONTENT_CATEGORIES}
    for resource in resources:
        category = str(resource.get("content_category") or "")
        kind = str(resource.get("kind") or "")
        reason = delivery_lane_rejection_reason(
            resource,
            locale,
            require_dynamic=require_dynamic,
        )
        if reason:
            reasons[reason] = reasons.get(reason, 0) + 1
        elif category in accepted and kind in accepted[category]:
            accepted[category][kind] += 1
    return {"accepted_slots": accepted, "rejection_counts": reasons}


def _attach_featured_evidence_anchor(resources: list[dict]) -> list[dict]:
    """Bind every featured item to the vetted authority lane in its package."""

    normalized = [_resource_with_delivery_metadata(resource) for resource in resources]
    authority_article = next(
        (
            resource
            for resource in normalized
            if resource.get("content_category") == "authority"
            and resource.get("kind") == "article"
        ),
        None,
    )
    if not authority_article:
        return normalized
    anchor = {
        "title": str(authority_article.get("title") or "")[:180],
        "publisher": str(authority_article.get("publisher") or "")[:140],
        "url": str(authority_article.get("url") or ""),
        "source_tier": "authority",
    }
    for resource in normalized:
        if resource.get("content_category") == "featured":
            resource["evidence_anchor"] = dict(anchor)
    return normalized


def _category_resource_pair_options(
    resources: list[dict],
    content_category: str,
    *,
    excluded_primary_orgs: Optional[set[str]] = None,
    preferred_locale: Optional[str] = None,
    require_dynamic: bool = True,
    max_pairs: int = 3,
) -> list[list[dict]]:
    """Build a primary pair and instant alternatives from a validated pool."""

    matching = [
        _resource_with_delivery_metadata(resource)
        for resource in resources
        if str(resource.get("content_category") or "") == content_category
        and (
            not preferred_locale
            or not delivery_lane_rejection_reason(
                resource,
                preferred_locale,
                require_dynamic=require_dynamic,
            )
        )
    ]
    articles = [resource for resource in matching if resource.get("kind") == "article"]
    videos = [resource for resource in matching if resource.get("kind") == "video"]
    articles.sort(
        key=lambda resource: _delivery_resource_sort_key(
            resource,
            preferred_locale,
            content_category,
        )
    )
    videos.sort(
        key=lambda resource: _delivery_resource_sort_key(
            resource,
            preferred_locale,
            content_category,
        )
    )
    candidates: list[list[dict]] = []
    seen: set[tuple[str, str]] = set()
    for article in articles:
        for video in videos:
            signature = (
                str(article.get("url") or ""),
                str(video.get("url") or ""),
            )
            if signature in seen:
                continue
            seen.add(signature)
            candidates.append([article, video])
    candidates.sort(
        key=lambda pair: (
            max(
                _delivery_locale_priority(resource, preferred_locale)
                for resource in pair
            ),
            sum(
                _delivery_locale_priority(resource, preferred_locale)
                for resource in pair
            ),
            # Source diversity is a tie-breaker inside the same language tier;
            # it must never force a Chinese user onto an English or less-local
            # destination merely to avoid reusing an institution.
            sum(
                _delivery_resource_sort_key(
                    resource,
                    preferred_locale,
                    content_category,
                )[1]
                for resource in pair
            ),
            # Source diversity matters only after both resources satisfy the
            # strongest editorial-quality tier. A different publisher cannot
            # compensate for an ad-like video or a hard-to-read article.
            sum(
                _resource_parent_org_id(resource)
                in (excluded_primary_orgs or set())
                for resource in pair
            ),
            pair[0].get("research_source") != "openai_web_search",
            pair[1].get("research_source") != "openai_web_search",
        )
    )
    if not candidates:
        return []
    # Pick a strong primary, then maximize *both* format changes.  With two
    # articles and two videos this yields A1+V1, A2+V2 before A1+V2, so a
    # parent asking for another group does not immediately see half the same
    # content again.  Only a genuinely sparse pool is allowed to reuse one
    # side of the pair.
    selected = [candidates.pop(0)]
    used_article_urls = {str(selected[0][0].get("url") or "")}
    used_video_urls = {str(selected[0][1].get("url") or "")}
    while candidates and len(selected) < max(1, max_pairs):
        candidates.sort(
            key=lambda pair: (
                -max(
                    _delivery_locale_priority(resource, preferred_locale)
                    for resource in pair
                ),
                -sum(
                    _delivery_locale_priority(resource, preferred_locale)
                    for resource in pair
                ),
                str(pair[0].get("url") or "") not in used_article_urls
                and str(pair[1].get("url") or "") not in used_video_urls,
                str(pair[0].get("url") or "") not in used_article_urls,
                str(pair[1].get("url") or "") not in used_video_urls,
                pair[0].get("research_source") == "openai_web_search",
                pair[1].get("research_source") == "openai_web_search",
            ),
            reverse=True,
        )
        chosen = candidates.pop(0)
        selected.append(chosen)
        used_article_urls.add(str(chosen[0].get("url") or ""))
        used_video_urls.add(str(chosen[1].get("url") or ""))
    return selected


def _compact_stage_label(card: dict) -> str:
    raw = str(card.get("child_age_context") or "").strip()
    if "：" in raw:
        raw = raw.split("：", 1)[1]
    return raw[:80] or "当前发展阶段"


def _delivery_title(card: dict, content_category: str, resources: list[dict]) -> str:
    locale = str(card.get("preferred_locale") or "zh-CN")
    article = next(
        (resource for resource in resources if resource.get("kind") == "article"),
        {},
    )
    topic = str(card.get("topic_label") or card.get("topic") or "这个问题").strip()
    if locale == "en":
        source_title = str(article.get("title") or topic).strip()
        prefixes = {
            "authority": "What the evidence says",
            "featured": "A practical method to try today",
            "case": "How a similar family approached it",
        }
        return f"{prefixes[content_category]}: {source_title}"[:180]
    stage = _compact_stage_label(card)
    templates = {
        "authority": f"{stage}的“{topic}”：哪些进展值得观察",
        "featured": f"今天就能做：把“{topic}”变成一个日常小练习",
        "case": f"相似家庭如何一步步面对“{topic}”",
    }
    return templates[content_category][:180]


def _decorate_delivery_card(card: dict, resources: list[dict]) -> None:
    """Apply the user-facing learning-capsule contract to one card."""

    category = str(card.get("content_category") or "")
    if category not in CONTENT_CATEGORIES:
        return
    pair = [_resource_with_delivery_metadata(resource) for resource in resources]
    article = next((resource for resource in pair if resource.get("kind") == "article"), {})
    video = next((resource for resource in pair if resource.get("kind") == "video"), {})
    card["delivery_title"] = _delivery_title(card, category, pair)
    card["source_label"] = str(article.get("publisher") or card.get("publisher") or "")
    article_language = str(article.get("language") or "").strip()
    video_language = str(video.get("language") or "").strip()
    card["language_label"] = " · ".join(
        value for value in (article_language, video_language) if value
    )[:120]
    estimated_minutes = sum(
        int(resource.get("estimated_minutes") or 0) for resource in pair
    )
    card["estimated_time_label"] = (
        f"约 {estimated_minutes} 分钟" if estimated_minutes else "约 5–10 分钟"
    )
    card["applicable_stage"] = _compact_stage_label(card)
    focus = str(
        card.get("recommendation_focus")
        or card.get("topic_label")
        or card.get("topic")
        or "这个问题"
    ).strip()
    category_intro = {
        "authority": "先用权威依据判断当前阶段值得观察什么，再决定是否需要进一步咨询。",
        "featured": "这组内容把可靠结论转成今天就能尝试的做法，并优先照顾你的现实时间限制。",
        "case": "这个真实家庭案例用于理解过程和调整方法，不代表普遍效果或医学建议。",
    }[category]
    card["guide"] = (
        f"这组内容围绕你最近提到的“{focus[:80]}”，并结合"
        f"{_compact_stage_label(card)}筛选。{category_intro}"
    )[:300]
    card["action_steps"] = list(_DELIVERY_ACTION_STEPS[category])


def _resource_blueprint(
    content_category: Optional[str] = None,
) -> dict[str, list[str]]:
    if content_category in CONTENT_CATEGORIES:
        return {str(content_category): ["article", "video"]}
    # Each editorial lane offers a real choice while preserving format
    # diversity. The third slot is quality-gated rather than quota-filled.
    return {
        category: ["article", "video", "article_or_video_optional"]
        for category in CONTENT_CATEGORIES
    }


def _select_category_resource_pair(
    resources: list[dict],
    content_category: Optional[str],
    preferred_locale: Optional[str] = None,
) -> list[dict]:
    """Return at most one article and one video for one editorial lane."""

    if content_category not in CONTENT_CATEGORIES:
        return list(resources)
    matching = [
        resource
        for resource in resources
        if str(resource.get("content_category") or "") == content_category
        and _reviewed_editorial_quality_allowed(resource)
    ]
    # Language fitness is the first ordering axis.  Among equally localized
    # authority items, prefer verified U.S. public-health, pediatric and
    # university sources without trusting model-authored country labels.
    matching.sort(
        key=lambda resource: _delivery_resource_sort_key(
            resource,
            preferred_locale,
            str(content_category),
        )
    )
    pair: list[dict] = []
    for kind in ("article", "video"):
        selected = next(
            (resource for resource in matching if resource.get("kind") == kind),
            None,
        )
        if selected:
            pair.append(selected)
    return pair


def _reviewed_editorial_quality_allowed(resource: dict) -> bool:
    """Apply lane-quality exclusions before a reviewed pair reaches the UI."""

    category = str(resource.get("content_category") or "")
    kind = str(resource.get("kind") or "")
    org_id = _resource_parent_org_id(resource)
    if category == "featured" and org_id in FEATURED_FORBIDDEN_PARENT_ORG_IDS:
        return False
    if (
        category == "authority"
        and kind == "video"
        and org_id in AUTHORITY_VIDEO_FORBIDDEN_PARENT_ORG_IDS
    ):
        return False
    if category == "case" and org_id in CASE_FORBIDDEN_PARENT_ORG_IDS:
        return False
    if (
        category == "case"
        and kind == "article"
        and case_article_reader_experience_status(resource.get("url")) == "rejected"
    ):
        return False
    if category == "case":
        case_process_status = str(
            resource.get("case_process_status") or ""
        ).casefold()
        if case_process_status in {"promotion_only", "rejected"}:
            return False
        if case_process_status != "verified":
            return False
        if (
            kind == "video"
            and str(resource.get("content_substance_status") or "").casefold()
            != "verified"
        ):
            return False
    if kind == "video" and str(
        resource.get("content_substance_status") or ""
    ).casefold() in {"ad_like", "rejected"}:
        return False
    return not (
        category == "featured"
        and str(resource.get("featured_readability_status") or "").casefold()
        == "rejected"
    )


_YOUTUBE_HOSTS = frozenset(
    {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
)
_REVIEWED_US_AUTHORITY_VIDEO_IDS = frozenset(
    {
        "sleep-aap-video",
        "food-aap-video",
        "development-cdc-video",
        "language-cdc-video",
        "safety-aap-video",
    }
)


def _safe_https_hostname(url: object) -> str:
    """Return a normalized host only for an ordinary, safe HTTPS URL."""

    try:
        parsed = urlparse(str(url or ""))
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        return ""
    return parsed.hostname.rstrip(".").lower()


def _is_direct_us_authority_url(url: object) -> bool:
    host = _safe_https_hostname(url)
    if not host or host in _YOUTUBE_HOSTS:
        return False
    return source_parent_org_id(url) in US_AUTHORITY_SOURCE_PARENT_ORG_IDS


def _is_us_authority_resource(resource: dict) -> bool:
    """Recognize real U.S. institutions without trusting model country labels."""

    url = str(resource.get("url") or "")
    if _is_direct_us_authority_url(url):
        return True

    host = _safe_https_hostname(url)
    if host not in _YOUTUBE_HOSTS:
        return False

    # A hosted video needs evidence beyond a mutable publisher/country string.
    # Reviewed AAP/CDC IDs are tied to manually checked URLs.  Dynamic results
    # can qualify only when they cite the corresponding institution page.
    if (
        str(resource.get("id") or "") in _REVIEWED_US_AUTHORITY_VIDEO_IDS
        and is_trusted_resource_url(url)
    ):
        return True
    return any(
        _is_direct_us_authority_url(resource.get(field))
        for field in (
            "evidence_url",
            "authority_evidence_url",
            "publisher_evidence_url",
            "source_evidence_url",
        )
    )


def _reviewed_category_resource_pair(
    resources: list[dict],
    locale: str,
    content_category: Optional[str],
    topic_context: Optional[dict] = None,
) -> list[dict]:
    """Select a stable same-language article/video pair for a category card.

    The conversation-aware filter is preferred.  If it removes one format, the
    manually reviewed resources on the same base topic are allowed to fill that
    format; this never crosses topic, category or language boundaries.
    """

    reviewed = _reviewed_resources_for_context(resources, locale, topic_context)
    pair = _select_category_resource_pair(
        reviewed,
        content_category,
        preferred_locale=locale,
    )
    # Never refill a missing format from an unfiltered pool.  That old fallback
    # could put a 10–12 month article back beside a 30 month recommendation.
    # A stage-correct single format is safer than a visually complete wrong-age
    # pair; live research may later supply the missing format.
    return pair


def _category_feed_card(
    base_card: dict,
    content_category: str,
    locale: str,
    *,
    context_state: str,
) -> dict:
    """Present one ranked topic as a clearly labelled editorial-lane card."""

    card = dict(base_card)
    card["preferred_locale"] = locale
    meta = _CATEGORY_CARD_META[content_category]
    library_resources = LEARNING_CONTENT_BY_ID.get(
        str(base_card.get("id") or ""), {}
    ).get("resources", [])
    topic_context = (
        base_card
        if base_card.get("child_age_context")
        or (context_state == "ready" and base_card.get("is_conversation_match"))
        else None
    )
    pair = _reviewed_category_resource_pair(
        library_resources,
        locale,
        content_category,
        topic_context,
    )
    article = next(
        (resource for resource in pair if resource.get("kind") == "article"),
        None,
    )
    topic_label = str(
        card.get("topic_label") or card.get("topic") or "这个育儿问题"
    ).strip()
    card.update(
        {
            "content_category": content_category,
            "content_category_label": meta["label"],
            "content_category_eyebrow": meta["eyebrow"],
            "content_category_description": meta["description"],
            "type_label": meta["label"],
            "resource_pair_complete": len(pair) == 2,
            "resource_summary": summarize_resource_slots(pair, locale),
            # When no reviewed article survives the language, age and topic
            # gates, do not repeat the base topic headline across all three
            # editorial lanes or imply that its publisher supplied every lane.
            # These labels describe the pending lane honestly until research
            # produces a concrete article title on the detail page.
            "title": meta["fallback_title"].format(topic_label=topic_label),
            "publisher": meta["fallback_publisher"],
            "headline_source": "category_fallback",
        }
    )
    # The card is about the concrete content the user will open, while the
    # topic and NURI guide remain available on the detail page.
    if (
        (context_state != "ready" or not content_research_oai)
        and article
        and str(article.get("title") or "").strip()
    ):
        card["title"] = article["title"]
        card["summary"] = article.get("description") or card.get("summary")
        card["publisher"] = article.get("publisher") or card.get("publisher")
        card["headline_source"] = "reviewed_article"
    _decorate_delivery_card(card, pair)
    return card


def _resource_matches_preferred_locale(resource: dict, locale: str) -> bool:
    """Keep Chinese fallbacks available without disguising their script.

    Exact reviewed Traditional-Chinese parent/editorial pages are a better
    fallback for a Chinese account than an English original. Their existing
    ``language`` and region labels remain visible, so this does not present a
    Taiwan source as Simplified Chinese.
    """

    locales = resource.get("locales") or []
    if locale not in locales:
        return False
    if locale != "zh-CN":
        return True
    reviewed_chinese_fallback = bool(
        resource.get("research_source") == "reviewed_whitelist"
        and str(resource.get("content_category") or "") in {"featured", "case"}
        and (
            str(resource.get("content_category") or "") != "case"
            or str(resource.get("case_process_status") or "").casefold()
            == "verified"
        )
        and (
            str(resource.get("source_region") or "").upper() == "TW"
            or str(resource.get("script_language") or "") == "zh-Hant"
        )
    )
    if reviewed_chinese_fallback:
        return True
    if (
        str(resource.get("kind") or "") == "video"
        and str(resource.get("spoken_language") or "").casefold()
        in {"mandarin", "putonghua", "chinese", "国语", "普通话", "华语"}
    ):
        # Spoken Mandarin is the hard boundary for zh-CN video delivery. Keep
        # the Taiwan/Traditional label visible, but do not discard a stronger
        # Mandarin explanation because its publishing metadata is zh-Hant.
        return True
    if str(resource.get("source_region") or "").upper() == "TW":
        return False
    if str(resource.get("script_language") or "") == "zh-Hant":
        return False
    identity = " ".join(
        str(resource.get(field) or "")
        for field in ("language", "publisher", "trust_note", "recognition")
    )
    return not any(
        marker in identity for marker in ("繁体", "繁體", "台湾", "台灣", "臺灣")
    )


def _reviewed_resources_for_context(
    resources: list[dict],
    locale: str,
    topic_context: Optional[dict] = None,
) -> list[dict]:
    """Return reviewed items that are trusted, locale-correct and relevant."""

    return order_learning_resources(
        [
            resource
            for resource in resources
            if is_trusted_resource_url(str(resource.get("url") or ""))
            and not (
                str(resource.get("content_category") or "") == "case"
                and str(resource.get("kind") or "") == "article"
                and case_article_reader_experience_status(resource.get("url"))
                == "rejected"
            )
            and _resource_matches_preferred_locale(resource, locale)
            and (
                topic_context is None
                or reviewed_resource_matches_context(resource, topic_context)
            )
        ],
        locale,
    )


def _research_safety_identifier(uid: str) -> str:
    """Create a stable, privacy-preserving API safety identifier."""

    digest = hashlib.sha256(f"nuri-content:{uid}".encode("utf-8")).hexdigest()
    return f"nuri_{digest[:32]}"


def _context_requires_urgent_handoff(context: dict) -> bool:
    """Keep emergencies out of learning-content research."""

    recent_text = "\n".join(
        str(message.get("text") or "")
        for message in (context.get("messages") or [])[-6:]
    )
    return bool(recent_text and _urgent_task_suppressed(recent_text))


async def _research_card_detail_resources(
    *,
    card: dict,
    context: dict,
    uid: Optional[str],
    force: bool = False,
    extra_excluded_urls: Optional[list[str]] = None,
) -> Optional[dict]:
    """Run bounded, validated web research for a conversation-matched detail."""

    # Safety is evaluated before consent/provider eligibility.  Emergency text
    # must never be used for external research, regardless of the user's saved
    # privacy setting or the availability of an OpenAI client.
    if _context_requires_urgent_handoff(context):
        return None
    if (
        not uid
        or not content_research_oai
        or not context.get("external_research_allowed")
        or context.get("state") != "ready"
        or not context.get("messages")
        or not card.get("is_conversation_match")
    ):
        return None
    behavior_events = await _db_get_recommendation_events(uid)
    excluded_urls = list(
        dict.fromkeys(
            [
                *recent_resource_urls(behavior_events),
                *(extra_excluded_urls or []),
            ]
        )
    )[:120]
    feedback_preferences = card_behavior_signal(
        str(card.get("id") or ""), behavior_events
    ).get("content_refresh_reasons") or []
    try:
        return await anyio.to_thread.run_sync(
            lambda: research_learning_resources(
                content_research_oai,
                card=card,
                messages=context.get("messages") or [],
                preferred_locale=str(context.get("preferred_locale") or "zh-CN"),
                model=OPENAI_CONTENT_RESEARCH_MODEL,
                safety_identifier=_research_safety_identifier(uid),
                force=force,
                excluded_urls=excluded_urls,
                feedback_preferences=feedback_preferences,
            ),
            limiter=content_research_limiter,
        )
    except Exception as exc:
        # Dynamic research is an enhancement.  A provider outage, timeout, bad
        # result or incomplete quality bundle must never break the reviewed detail.
        print(f"[warn] conversation content research fell back: {type(exc).__name__}")
        return {"_provider_failure": "retryable"}


def _prepared_content_set_id(snapshots: list[dict], _resources: list[dict]) -> str:
    first = snapshots[0]
    # Bind the public set ID to the frozen recommendation group, not to one
    # provider response. Two Vercel instances may finish equivalent research
    # concurrently; a stable ID lets either completed response open whichever
    # valid winner is durably stored, instead of turning the first link stale.
    material = {
        "card_id": first.get("card_id"),
        "session_id": first.get("session_id"),
        "context_created_at": first.get("context_created_at"),
        "child_profile_fingerprint": first.get("child_profile_fingerprint"),
        "preferred_locale": first.get("preferred_locale"),
        "recommendations": sorted(
            (
                str(snapshot.get("recommendation_id") or ""),
                str(snapshot.get("content_category") or ""),
            )
            for snapshot in snapshots
        ),
    }
    digest = hashlib.sha256(
        json.dumps(material, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return f"pcs_{digest[:24]}"


def _prepare_response_items(snapshots: list[dict]) -> list[dict]:
    items: list[dict] = []
    for snapshot in snapshots:
        pair = prepared_resource_pair(snapshot)
        pair_pool = prepared_resource_pairs(snapshot)
        readiness = "ready" if pair else str(
            snapshot.get("resource_readiness") or "retryable"
        )
        if readiness not in {"preparing", "ready", "retryable"}:
            readiness = "retryable"
        item = {
            "card_id": snapshot.get("card_id"),
            "recommendation_id": snapshot.get("recommendation_id"),
            "content_category": snapshot.get("content_category"),
            "resource_readiness": readiness,
            "resource_pair_complete": bool(pair),
            "prepared_content_set_id": (
                snapshot.get("prepared_content_set_id") if pair else None
            ),
            "resources": pair or [],
            "active_pair_id": pair_pool[0]["pair_id"] if pair_pool else None,
            "alternate_resource_pairs": pair_pool[1:],
            "alternate_count": max(0, len(pair_pool) - 1),
            "research_status": "ready" if pair else readiness,
        }
        if pair:
            article = next(
                resource for resource in pair if resource.get("kind") == "article"
            )
            item["title"] = article.get("title")
            item["publisher"] = article.get("publisher")
            item["source_label"] = article.get("publisher")
            item["child_age_context"] = snapshot.get("child_age_context") or ""
            item["preferred_locale"] = (
                snapshot.get("preferred_locale") or "zh-CN"
            )
            item["topic_label"] = snapshot.get("recommendation_focus") or "这个问题"
            item["recommendation_focus"] = snapshot.get("recommendation_focus") or ""
            _decorate_delivery_card(item, pair)
        items.append(item)
    return items


def _prepare_retry_or_previous_payload(snapshots: list[dict]) -> dict:
    """Keep a complete previous set published while its upgrade is retryable."""

    pairs = [prepared_resource_pair(snapshot) for snapshot in snapshots]
    set_ids = {
        str(snapshot.get("prepared_content_set_id") or "")
        for snapshot, pair in zip(snapshots, pairs)
        if pair
    }
    if (
        all(pairs)
        and len(set_ids) == 1
        and _prepared_snapshot_set_meets_source_contract(snapshots)
    ):
        previous_set_id = next(iter(set_ids))
        return {
            "resource_readiness": "ready",
            "prepared_content_set_id": previous_set_id,
            "recommendation_set_id": previous_set_id,
            "publication_state": "published",
            "upgrade_state": "preparing",
            "items": _prepare_response_items(snapshots),
        }
    return {
        "resource_readiness": "retryable",
        "prepared_content_set_id": None,
        "recommendation_set_id": None,
        "publication_state": "preparing",
        "items": _prepare_response_items(snapshots),
    }


async def _mark_prepare_retryable(uid: str, snapshots: list[dict]) -> list[dict]:
    retryable: list[dict] = []
    for snapshot in snapshots:
        current = await _db_get_recommendation_snapshot_persistent(
            uid,
            snapshot.get("recommendation_id"),
        )
        if current and prepared_resource_pair(current) and _prepared_snapshot_set_meets_source_contract([current]):
            retryable.append(current)
        elif prepared_resource_pair(snapshot) and _prepared_snapshot_set_meets_source_contract([snapshot]):
            retryable.append(snapshot)
        else:
            # Failure is returned to this caller, but is intentionally not an
            # app_settings write: a stale failed request must never downgrade a
            # pair concurrently published by another Vercel invocation.
            retryable.append(
                snapshot_with_resource_readiness(snapshot, "retryable")
            )
    return retryable


async def _record_resource_delivery(
    *,
    uid: str,
    card_id: str,
    recommendation_id: Optional[str],
    content_category: Optional[str],
    preferred_locale: str,
    resources: list[dict],
) -> None:
    events = [
        _new_recommendation_event(
            event="resource_delivered",
            card_id=card_id,
            trusted_resource_url=True,
            recommendation_id=recommendation_id,
            resource_id=str(resource.get("id") or ""),
            resource_url=str(resource.get("url") or ""),
            resource_kind=str(resource.get("kind") or ""),
            content_category=str(
                resource.get("content_category") or content_category or ""
            ),
            locale=(resource.get("locales") or [preferred_locale])[0],
            position=index,
        )
        for index, resource in enumerate(resources)
        if resource.get("id") and resource.get("url")
    ]
    if events:
        await _db_append_recommendation_events(uid, events)


def _log_personalized_feed_decision(uid: str, context: dict, items: list[dict]) -> None:
    """Emit ranking diagnostics without storing conversation text or user IDs."""

    try:
        user_messages = [
            message
            for message in (context.get("messages") or [])
            if message.get("role") == "user"
        ]
        payload = {
            "event": "personalized_feed_ranked",
            "user_ref": hashlib.sha256(
                f"nuri-feed:{uid}".encode("utf-8")
            ).hexdigest()[:12],
            "context_state": context.get("state", "no_history"),
            "message_count": len(context.get("messages") or []),
            "user_message_count": len(user_messages),
            "current_session_user_message_count": int(
                context.get("current_session_user_message_count") or 0
            ),
            "account_history_user_message_count": int(
                context.get("history_user_message_count") or 0
            ),
            "filtered_product_feedback_count": sum(
                1
                for message in user_messages
                if _is_product_meta_request(str(message.get("text") or ""))
                or _is_recommendation_feedback(str(message.get("text") or ""))
            ),
            "selected": [
                {
                    "id": str(item.get("id") or ""),
                    "match": bool(item.get("is_conversation_match")),
                    "dynamic": bool(item.get("is_dynamic_research_card")),
                    "score": item.get("recommendation_score"),
                }
                for item in items
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        # Observability must never be allowed to break a parent's home feed.
        print(f"[warn] personalized feed diagnostics failed: {type(exc).__name__}")


# ── Snapshot -> card, the delivery half ──────────────────────────────────────
# These two read and write recommendation snapshots, but what they do with one
# is decorate a home card — which is this layer's job, not the store's. They
# sat among the _db_* helpers and called _decorate_delivery_card and
# _prepared_snapshot_set_meets_source_contract back out of it, which made the
# store and delivery layers mutually dependent and neither of them separable.
# Here the dependency runs one way: delivery calls the store.
def _apply_prepared_snapshot_to_feed_card(card: dict, snapshot: dict) -> None:
    """Expose a prepared, binding-validated pair on its matching home card."""

    source_contract_ready = _prepared_snapshot_set_meets_source_contract([snapshot])
    pair = prepared_resource_pair(snapshot) if source_contract_ready else None
    pair_pool = prepared_resource_pairs(snapshot) if source_contract_ready else []
    readiness = str(snapshot.get("resource_readiness") or "")
    if pair:
        article = next(resource for resource in pair if resource.get("kind") == "article")
        card["resource_readiness"] = "ready"
        card["resource_pair_complete"] = True
        card["prepared_content_set_id"] = snapshot.get("prepared_content_set_id")
        card["resource_summary"] = summarize_resource_slots(
            pair,
            str(snapshot.get("preferred_locale") or "zh-CN"),
        )
        card["resources"] = pair
        card["active_pair_id"] = pair_pool[0]["pair_id"] if pair_pool else None
        card["alternate_resource_pairs"] = pair_pool[1:]
        card["alternate_count"] = max(0, len(pair_pool) - 1)
        card["title"] = article.get("title") or card.get("title")
        card["summary"] = article.get("description") or card.get("summary")
        card["publisher"] = article.get("publisher") or card.get("publisher")
        card["headline_source"] = "prepared_article"
        _decorate_delivery_card(card, pair)
        return
    if card.get("resource_readiness") == "ready" and card.get("resource_pair_complete"):
        card["prepared_content_set_id"] = None
        return
    card["resource_readiness"] = (
        readiness if readiness in {"preparing", "retryable"} else "preparing"
    )
    card["prepared_content_set_id"] = None


async def _attach_recommendation_snapshots(
    uid: str,
    cards: list[dict],
    context: dict,
) -> list[dict]:
    """Persist one bounded snapshot per conversation-matched card.

    ``app_settings`` already exists in every deployed NURI database, so this
    adds stable detail links without making a schema migration a prerequisite.
    A process-local copy keeps local preview/tests useful; the legacy session
    and cutoff fields remain on every card as a safe compatibility fallback.
    """

    pairs: list[tuple[dict, dict]] = []
    for card in cards:
        if not card.get("is_conversation_match"):
            continue
        snapshot = build_snapshot(uid, card, context)
        requested_readiness = str(card.get("resource_readiness") or "")
        if requested_readiness in {"preparing", "retryable"}:
            snapshot["resource_readiness"] = requested_readiness
        try:
            previous = await _db_get_recommendation_snapshot(
                uid,
                snapshot["recommendation_id"],
            )
        except HTTPException:
            previous = None
        if previous:
            snapshot = carry_prepared_resource_state(previous, snapshot)
        pairs.append((card, snapshot))

    if not pairs:
        return cards

    persisted = await _db_persist_recommendation_snapshots(
        uid,
        [snapshot for _, snapshot in pairs],
    )

    for card, snapshot in pairs:
        if persisted:
            card["recommendation_id"] = snapshot["recommendation_id"]
            card["recommendation_context_status"] = "persisted"
            _apply_prepared_snapshot_to_feed_card(card, snapshot)
        else:
            card.pop("recommendation_id", None)
            card["recommendation_context_status"] = "legacy_fallback"
    return cards


@api.get("/feed/personalized")
async def get_personalized_feed(
    count: int = 4,
    presentation: Literal["topic_cards", "category_cards"] = "topic_cards",
    uid: str = Depends(_req_uid),
):
    """Return learning topics tied to this parent's real main conversation."""

    context = await _load_recent_main_chat(uid)
    await _attach_child_recommendation_context(uid, context)
    has_profile_category_context = bool(
        context.get("help_preference") or context.get("info_source")
    )
    behavior_events = (
        await _db_get_recommendation_events(uid)
        if context.get("state") == "ready"
        or (
            context.get("state") == "no_history"
            and has_profile_category_context
        )
        else []
    )
    category_mix = category_preference_mix(
        context.get("help_preference"),
        context.get("info_source"),
        behavior_events,
    )
    initial_content_category = weighted_category_for_window(uid, category_mix)
    requested_count = max(1, min(count, 3 if presentation == "category_cards" else 6))
    items, used_conversation = _rank_learning_content(
        context.get("messages") or [],
        count=1 if presentation == "category_cards" else requested_count,
        session_id=context.get("session_id"),
        context_created_at=context.get("context_created_at"),
        context_state=context.get("state", "no_history"),
        behavior_events=behavior_events,
    )
    first_match = next(
        (item for item in items if item.get("is_conversation_match")),
        None,
    )
    preferred_locale = str(context.get("preferred_locale") or "zh-CN")
    if presentation == "category_cards" and items:
        primary = dict(first_match or items[0])
        if context.get("child_age_context"):
            # The card title/summary and reviewed pair are constructed below,
            # so derived age context must be present before that work happens.
            primary["child_age_context"] = context["child_age_context"]
        items = [
            _category_feed_card(
                primary,
                content_category,
                preferred_locale,
                context_state=str(context.get("state") or "no_history"),
            )
            for content_category in CONTENT_CATEGORIES[:requested_count]
        ]
        for item in items:
            item_category = str(item.get("content_category") or "")
            item["category_preference_weight"] = int(
                category_mix.get(item_category, 0)
            )
            item["is_primary_exposure_category"] = (
                item_category == initial_content_category
            )
    if context.get("state") == "privacy_off":
        mode = "default_privacy"
    elif used_conversation:
        mode = "conversation"
    elif context.get("help_preference") or context.get("info_source"):
        mode = "profile"
    elif context.get("state") == "unavailable":
        mode = "default_unavailable"
    else:
        mode = "default"
    _log_personalized_feed_decision(uid, context, items)
    urgent_suppressed = _context_requires_urgent_handoff(context)
    for item in items:
        if context.get("child_age_context"):
            item["child_age_context"] = context["child_age_context"]
        if item.get("is_conversation_match"):
            item["context_created_at"] = context.get("context_created_at")
        reviewed_source = LEARNING_CONTENT_BY_ID.get(item["id"], {}).get("resources", [])
        topic_context = (
            item
            if context.get("child_age_context")
            or (
                context.get("state") == "ready"
                and item.get("is_conversation_match")
            )
            else None
        )
        if item.get("content_category") in CONTENT_CATEGORIES:
            reviewed = _reviewed_category_resource_pair(
                reviewed_source,
                preferred_locale,
                str(item["content_category"]),
                topic_context,
            )
            item["resource_pair_complete"] = len(reviewed) == 2
        else:
            reviewed = _reviewed_resources_for_context(
                reviewed_source,
                preferred_locale,
                topic_context,
            )
        item["resource_summary"] = summarize_resource_slots(reviewed, preferred_locale)
        item["resource_blueprint"] = _resource_blueprint(item.get("content_category"))
        if item.get("is_dynamic_research_card"):
            if urgent_suppressed:
                item["curation_mode"] = "dynamic_research_suppressed"
                item["resource_status"] = "urgent_suppressed"
            elif not content_research_oai:
                item["curation_mode"] = "dynamic_research_unavailable"
                item["resource_status"] = "unavailable"
            elif not context.get("external_research_allowed"):
                item["curation_mode"] = "dynamic_research_consent_required"
                item["resource_status"] = "consent_required"
            else:
                item["curation_mode"] = "conversation_web_research"
                item["resource_status"] = "research_on_open"
        else:
            if urgent_suppressed:
                item["curation_mode"] = "research_suppressed"
                item["resource_status"] = "urgent_suppressed"
            else:
                item["curation_mode"] = (
                    "conversation_web_research"
                    if item.get("is_conversation_match")
                    and content_research_oai
                    and context.get("external_research_allowed")
                    else "reviewed_library"
                )
                item["resource_status"] = (
                    "research_on_open"
                    if item["curation_mode"] == "conversation_web_research"
                    else "reviewed"
                )
        if item.get("resource_pair_complete"):
            item["resource_readiness"] = "ready"
            # Reviewed resources are already policy-, locale- and age-gated.
            # Publish the strict pair immediately instead of blocking the home
            # card on live research. Dynamic preparation can still upgrade all
            # three lanes atomically, while provider latency or failure never
            # makes already-reviewed content unavailable to the user.
            item["resources"] = reviewed
            item["research_status"] = (
                "reviewed_fallback"
                if item.get("resource_status") == "research_on_open"
                else "ready"
            )
        elif item.get("resource_status") == "research_on_open":
            # A genuinely novel topic has no reviewed pair to fall back to, so
            # it still waits for the authenticated batch preparation endpoint.
            item["resource_readiness"] = "preparing"
            item.pop("resources", None)
        else:
            item["resource_readiness"] = "retryable"
        item["prepared_content_set_id"] = None
    await _attach_recommendation_snapshots(uid, items, context)
    feed_request_id = str(uuid.uuid4())
    for rank, item in enumerate(items, start=1):
        item["rank"] = rank
    return {
        "items": items,
        "feed_request_id": feed_request_id,
        "model_version": (
            "questionnaire-behavior-category-pairs-v2"
            if presentation == "category_cards"
            else "conversation-quality-child-age-cn-repair-v4"
        ),
        "personalization_mode": mode,
        "category_mix": category_mix,
        "initial_content_category": initial_content_category,
        "matched_topic": (first_match or {}).get("topic"),
        "related_session_id": (first_match or {}).get("related_session_id"),
        "context_status": context.get("state", "no_history"),
        "history_session_count": int(context.get("history_session_count") or 0),
        "history_user_message_count": int(
            context.get("history_user_message_count") or 0
        ),
        "generated_at": _now(),
    }


@api.post("/feed/research/prepare")
async def prepare_feed_research(
    body: ResearchPrepareRequest,
    uid: str = Depends(_req_uid),
):
    """Prepare at most three editorial lanes with one complete research bundle."""

    snapshots: list[dict] = []
    seen_categories: set[str] = set()
    for requested in body.items:
        snapshot = await _db_get_recommendation_snapshot(
            uid,
            requested.recommendation_id,
        )
        if not snapshot or snapshot.get("card_id") != requested.card_id:
            raise HTTPException(404, "recommendation not found")
        category = str(snapshot.get("content_category") or "")
        if category not in CONTENT_CATEGORIES or category in seen_categories:
            raise HTTPException(422, "recommendation categories must be unique")
        seen_categories.add(category)
        snapshots.append(snapshot)

    if seen_categories != set(CONTENT_CATEGORIES):
        raise HTTPException(422, "all recommendation categories are required")

    group_fields = (
        "card_id",
        "session_id",
        "context_created_at",
        "child_profile_fingerprint",
        "preferred_locale",
        "context_version",
    )
    expected_group = tuple(snapshots[0].get(field) for field in group_fields)
    if any(
        tuple(snapshot.get(field) for field in group_fields) != expected_group
        for snapshot in snapshots[1:]
    ):
        raise HTTPException(422, "recommendations do not share one frozen context")

    ready_pairs = [prepared_resource_pair(snapshot) for snapshot in snapshots]
    ready_set_ids = {
        str(snapshot.get("prepared_content_set_id") or "")
        for snapshot, pair in zip(snapshots, ready_pairs)
        if pair
    }
    ready_pair_pools = [prepared_resource_pairs(snapshot) for snapshot in snapshots]
    if (
        all(ready_pairs)
        and len(ready_set_ids) == 1
        and all(pair_pool for pair_pool in ready_pair_pools)
        and _prepared_snapshot_set_meets_source_contract(snapshots)
    ):
        return {
            "resource_readiness": "ready",
            "prepared_content_set_id": next(iter(ready_set_ids)),
            "recommendation_set_id": next(iter(ready_set_ids)),
            "publication_state": "published",
            "items": _prepare_response_items(snapshots),
        }

    preparing = [
        snapshot
        if prepared_resource_pair(snapshot)
        else snapshot_with_resource_readiness(snapshot, "preparing")
        for snapshot in snapshots
    ]
    if not await _db_persist_recommendation_snapshots(uid, preparing):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Prepared resources could not be persisted",
        )
    snapshots = preparing
    persisted_ready_pairs = [prepared_resource_pair(snapshot) for snapshot in snapshots]
    persisted_ready_ids = {
        str(snapshot.get("prepared_content_set_id") or "")
        for snapshot, pair in zip(snapshots, persisted_ready_pairs)
        if pair
    }
    persisted_pair_pools = [
        prepared_resource_pairs(snapshot) for snapshot in snapshots
    ]
    if (
        all(persisted_ready_pairs)
        and len(persisted_ready_ids) == 1
        and all(pair_pool for pair_pool in persisted_pair_pools)
        and _prepared_snapshot_set_meets_source_contract(snapshots)
    ):
        return {
            "resource_readiness": "ready",
            "prepared_content_set_id": next(iter(persisted_ready_ids)),
            "recommendation_set_id": next(iter(persisted_ready_ids)),
            "publication_state": "published",
            "items": _prepare_response_items(snapshots),
        }
    first = snapshots[0]
    context = await _load_recent_main_chat(
        uid,
        preferred_session_id=first.get("session_id"),
        through_created_at=first.get("context_created_at"),
    )
    await _attach_child_recommendation_context(uid, context)
    context = _with_requested_preferred_locale(
        context,
        str(first.get("preferred_locale") or "") or None,
    )
    if (
        context.get("state") != "ready"
        or context.get("session_id") != first.get("session_id")
        or (
            first.get("child_profile_fingerprint")
            and first.get("child_profile_fingerprint")
            != context.get("child_profile_fingerprint")
        )
        or _context_requires_urgent_handoff(context)
    ):
        retryable = await _mark_prepare_retryable(uid, snapshots)
        return _prepare_retry_or_previous_payload(retryable)

    behavior_events = await _db_get_recommendation_events(uid)
    ranked, _ = _rank_learning_content(
        context.get("messages") or [],
        count=len(LEARNING_CONTENT_CARDS),
        session_id=context.get("session_id"),
        context_created_at=context.get("context_created_at"),
        context_state=context.get("state", "no_history"),
        include_detail=True,
        behavior_events=behavior_events,
    )
    card_id = str(first.get("card_id") or "")
    card = next((item for item in ranked if item["id"] == card_id), None)
    if not card and card_id.startswith(_DYNAMIC_RESEARCH_CARD_PREFIX):
        card = _restore_dynamic_research_card_from_snapshot(first, include_detail=True)
    if not card:
        retryable = await _mark_prepare_retryable(uid, snapshots)
        return _prepare_retry_or_previous_payload(retryable)
    if context.get("child_age_context"):
        card["child_age_context"] = context["child_age_context"]
    for field in (
        "personalization_reason",
        "recommendation_focus",
        "recommendation_intent",
        "recommendation_score",
    ):
        if first.get(field) not in (None, ""):
            card[field] = first[field]
    card["is_conversation_match"] = True
    preferred_locale = str(first.get("preferred_locale") or "zh-CN")
    research = await _research_card_detail_resources(
        card=card,
        context=context,
        uid=uid,
        # Non-ready snapshots are durably kept as ``preparing`` so a stale
        # failed invocation can never overwrite a concurrently completed pair.
        # Consequently a later user retry cannot distinguish itself from the
        # first attempt via persisted readiness.  Always bypass the short-lived
        # negative research cache here.  The research layer's per-key inflight
        # event still collapses concurrent calls, and a durable ready set has
        # already returned above without reaching this provider boundary.
        force=True,
    )
    resources = _attach_featured_evidence_anchor(
        list((research or {}).get("resources") or [])
    )
    pairs_by_category = {
        category: _delivery_contract_pair(
            resources,
            category,
            preferred_locale,
        )
        for category in CONTENT_CATEGORIES
    }
    complete_bundle = bool(
        research
        and research.get("_provider_failure") != "retryable"
        and MIN_TOTAL_RESEARCH_RESOURCES <= len(resources) <= MAX_TOTAL_RESEARCH_RESOURCES
        and all(
            len(pair) == 2
            and {str(resource.get("kind") or "") for resource in pair}
            == {"article", "video"}
            for pair in pairs_by_category.values()
        )
    )
    reviewed_fallback_used = False
    if not complete_bundle:
        dynamic_diagnostics = _delivery_gate_diagnostics(
            resources,
            preferred_locale,
        )
        reviewed = reviewed_learning_resource_bundle(
            card=card,
            preferred_locale=preferred_locale,
        )
        reviewed_resources = _attach_featured_evidence_anchor(
            list((reviewed or {}).get("resources") or [])
        )
        reviewed_pairs = {
            category: _delivery_contract_pair(
                reviewed_resources,
                category,
                preferred_locale,
                require_dynamic=False,
            )
            for category in CONTENT_CATEGORIES
        }
        reviewed_complete = bool(
            reviewed
            and MIN_TOTAL_RESEARCH_RESOURCES
            <= len(reviewed_resources)
            <= MAX_TOTAL_RESEARCH_RESOURCES
            and all(
                len(pair) == 2
                and {str(resource.get("kind") or "") for resource in pair}
                == {"article", "video"}
                for pair in reviewed_pairs.values()
            )
        )
        print(
            json.dumps(
                {
                    "event": "content_research.prepare_incomplete",
                    "card_id": card_id,
                    "locale": str(first.get("preferred_locale") or ""),
                    "cache_bypassed": True,
                    "provider_failure": bool(
                        research
                        and research.get("_provider_failure") == "retryable"
                    ),
                    "resource_count": len(resources),
                    "reviewed_fallback_available": reviewed_complete,
                    "source_contract_version": DELIVERY_SOURCE_CONTRACT_VERSION,
                    **dynamic_diagnostics,
                    "slot_counts": {
                        category: {
                            kind: sum(
                                1
                                for resource in pairs_by_category[category]
                                if str(resource.get("kind") or "") == kind
                            )
                            for kind in ("article", "video")
                        }
                        for category in CONTENT_CATEGORIES
                    },
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
            flush=True,
        )
        if reviewed_complete:
            research = reviewed
            resources = reviewed_resources
            pairs_by_category = reviewed_pairs
            complete_bundle = True
            reviewed_fallback_used = True
        else:
            fallback_diagnostics = _delivery_gate_diagnostics(
                reviewed_resources,
                preferred_locale,
                require_dynamic=False,
            )
            print(
                json.dumps(
                    {
                        "event": "content_research.reviewed_fallback_incomplete",
                        "card_id": card_id,
                        "locale": preferred_locale,
                        "resource_count": len(reviewed_resources),
                        "source_contract_version": DELIVERY_SOURCE_CONTRACT_VERSION,
                        **fallback_diagnostics,
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                ),
                flush=True,
            )
            retryable = await _mark_prepare_retryable(uid, snapshots)
            return _prepare_retry_or_previous_payload(retryable)

    # Publish one coherent source mode. A provider result uses fresh cited
    # destinations; a provider outage may use only the exact manually verified
    # whitelist lane. Legacy reviewed-library resources cannot enter either.
    option_pool = list(resources)
    option_pool = _attach_featured_evidence_anchor(option_pool)

    def build_pair_options(pool: list[dict]) -> dict[str, list[list[dict]]]:
        options: dict[str, list[list[dict]]] = {}
        used_category_orgs: set[str] = set()
        for category in CONTENT_CATEGORIES:
            category_options = _category_resource_pair_options(
                pool,
                category,
                excluded_primary_orgs=used_category_orgs,
                preferred_locale=preferred_locale,
                require_dynamic=not reviewed_fallback_used,
            )
            options[category] = category_options
            if category_options:
                used_category_orgs.update(
                    _resource_parent_org_id(resource)
                    for pair in category_options
                    for resource in pair
                    if _resource_parent_org_id(resource)
                )
        return options

    pair_options_by_category = build_pair_options(option_pool)

    # A novel topic has no reviewed alternates.  Search up to two bounded
    # reserve bundles in the background so "换一个" normally remains an
    # in-memory/snapshot switch instead of another user-visible wait.
    if (
        not reviewed_fallback_used
        and any(len(options) < 2 for options in pair_options_by_category.values())
    ):
        excluded_option_urls = [
            str(resource.get("url") or "") for resource in option_pool
        ]
        for _reserve_attempt in range(2):
            try:
                reserve = await _research_card_detail_resources(
                    card=card,
                    context=context,
                    uid=uid,
                    force=True,
                    extra_excluded_urls=excluded_option_urls,
                )
            except Exception as exc:
                # Reserve preparation is best effort.  It must never roll back
                # the already complete primary six-slot bundle.
                print(
                    f"[warn] reserve content preparation stopped: {type(exc).__name__}"
                )
                break
            reserve_resources = list((reserve or {}).get("resources") or [])
            if not reserve_resources:
                break
            known_urls = {
                str(resource.get("url") or "") for resource in option_pool
            }
            additions = [
                resource
                for resource in reserve_resources
                if str(resource.get("url") or "") not in known_urls
            ]
            if not additions:
                break
            option_pool.extend(additions)
            excluded_option_urls.extend(
                str(resource.get("url") or "") for resource in additions
            )
            option_pool = _attach_featured_evidence_anchor(option_pool)
            pair_options_by_category = build_pair_options(option_pool)
            if all(
                len(options) >= 2
                for options in pair_options_by_category.values()
            ):
                break

    if any(not options for options in pair_options_by_category.values()):
        print(
            json.dumps(
                {
                    "event": "content_research.reserve_incomplete",
                    "card_id": card_id,
                    "locale": preferred_locale,
                    "source_contract_version": DELIVERY_SOURCE_CONTRACT_VERSION,
                    "pair_counts": {
                        category: len(options)
                        for category, options in pair_options_by_category.items()
                    },
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
            flush=True,
        )
        retryable = await _mark_prepare_retryable(uid, snapshots)
        return _prepare_retry_or_previous_payload(retryable)

    content_set_id = _prepared_content_set_id(snapshots, option_pool)
    prepared = [
        snapshot_with_prepared_resource_pairs(
            snapshot,
            pair_options_by_category[str(snapshot["content_category"])],
            content_set_id=content_set_id,
        )
        for snapshot in snapshots
    ]
    if not await _db_persist_recommendation_snapshots(uid, prepared):
        await _mark_prepare_retryable(uid, snapshots)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Prepared resources could not be persisted",
        )
    print(
        json.dumps(
            {
                "event": "content_research.package_published",
                "card_id": card_id,
                "locale": preferred_locale,
                "content_set_id": content_set_id,
                "source_contract_version": DELIVERY_SOURCE_CONTRACT_VERSION,
                "source_mode": (
                    "reviewed_whitelist"
                    if reviewed_fallback_used
                    else "openai_web_search"
                ),
                "lanes": {
                    category: [
                        {
                            "kind": resource.get("kind"),
                            "parent_org_id": _resource_parent_org_id(resource),
                            "translation_type": resource.get("translation_type"),
                            "source_language": resource.get("source_language"),
                            "display_locale": resource.get("display_locale"),
                            "spoken_language": resource.get("spoken_language"),
                        }
                        for resource in pair_options_by_category[category][0]
                    ]
                    for category in CONTENT_CATEGORIES
                },
            },
            ensure_ascii=False,
            sort_keys=True,
        ),
        flush=True,
    )
    return {
        "resource_readiness": "ready",
        "prepared_content_set_id": content_set_id,
        "recommendation_set_id": content_set_id,
        "publication_state": "published",
        "research_status": (
            "reviewed_whitelist" if reviewed_fallback_used else "ready"
        ),
        "items": _prepare_response_items(prepared),
    }


@api.get("/feed")
async def get_feed(shuffle: bool = False):
    gen_cards = await _db_get_gen_cards()
    cards = list(FEED_CARDS) + gen_cards
    if shuffle:
        random.shuffle(cards)
    return cards

@api.get("/feed/alt")
async def get_alt_card(exclude: str = ""):
    gen_cards = await _db_get_gen_cards()
    exclude_ids = {e for e in exclude.split(",") if e}
    pool = [c for c in (FEED_CARDS + ALT_FEED_CARDS + gen_cards) if c["id"] not in exclude_ids]
    if not pool:
        pool = list(ALT_FEED_CARDS)
    return random.choice(pool)

@api.get("/feed/search")
async def search_feed(q: str = "", type: Optional[str] = None):
    gen_cards = await _db_get_gen_cards()
    q_lower = q.lower().strip()
    all_cards = FEED_CARDS + ALT_FEED_CARDS + LEARNING_CONTENT_CARDS + gen_cards
    if not q_lower:
        results = all_cards
    else:
        results = []
        for c in all_cards:
            detail = CARD_DETAILS.get(c["id"], {})
            haystack = " ".join([
                c.get("title", ""),
                c.get("summary", ""),
                c.get("body", detail.get("body", "")),
                " ".join(c.get("tags", detail.get("tags", []))),
                " ".join(c.get("keywords", [])),
            ]).lower()
            if q_lower in haystack:
                results.append(c)
    if type:
        results = [c for c in results if c.get("type") == type]
    return results

@api.post("/feed/generate")
async def generate_feed_cards(body: GenerateCardsRequest, uid: Optional[str] = Depends(_opt_uid)):
    feed_mode = await _db_get_feed_mode()
    if feed_mode == "alt":
        pool = list(FEED_CARDS + ALT_FEED_CARDS)
        random.shuffle(pool)
        return pool[:body.count]
    keywords = list(body.keywords or [])
    if not keywords and body.session_id and oai:
        msgs = _messages.get(body.session_id, [])
        user_texts = [m.get("text", "") for m in msgs if m.get("role") == "user" and m.get("text")]
        if user_texts:
            combined = " ".join(user_texts[-5:])
            try:
                kw_resp = await anyio.to_thread.run_sync(lambda: oai.chat.completions.create(
                    model="gpt-5.4-mini",
                    messages=[{"role": "user", "content":
                        f"从以下育儿对话中提取3-5个关键词（名词短语，用逗号分隔）：\n{combined}\n\n只返回关键词，不要解释。"
                    }],
                ))
                keywords = [k.strip() for k in kw_resp.choices[0].message.content.split(",") if k.strip()][:5]
            except Exception:
                pass
    if not keywords:
        keywords = ["婴幼儿发展", "育儿健康", "早期教育"]
    new_cards = await anyio.to_thread.run_sync(
        lambda: _gen_feed_cards_sync(keywords, body.count)
    )
    await _db_save_gen_cards(new_cards)
    return new_cards

@api.get("/feed/{card_id}/detail")
async def get_card_detail(
    card_id: str,
    session_id: Optional[str] = None,
    context_created_at: Optional[str] = None,
    recommendation_id: Optional[str] = None,
    prepared_content_set_id: Optional[str] = None,
    content_category: Optional[Literal["authority", "featured", "case"]] = None,
    preferred_locale: Optional[Literal["zh-CN", "zh-TW", "en"]] = None,
    uid: Optional[str] = Depends(_opt_uid),
):
    is_dynamic_request = card_id.startswith(_DYNAMIC_RESEARCH_CARD_PREFIX)
    if card_id in LEARNING_CONTENT_BY_ID or is_dynamic_request:
        snapshot = (
            await _db_get_recommendation_snapshot(uid, recommendation_id)
            if uid and recommendation_id
            else None
        )
        if recommendation_id and not snapshot:
            raise HTTPException(404, "recommendation not found")
        if snapshot and snapshot.get("card_id") != card_id:
            raise HTTPException(404, "recommendation not found")
        snapshot_source_contract_ready = bool(
            snapshot
            and _prepared_snapshot_set_meets_source_contract([snapshot])
        )
        snapshot_prepared_pair = (
            prepared_resource_pair(snapshot)
            if snapshot_source_contract_ready
            else None
        )
        expected_content_set_id = (
            str(snapshot.get("prepared_content_set_id") or "") if snapshot else ""
        )
        if snapshot_prepared_pair and prepared_content_set_id != expected_content_set_id:
            raise HTTPException(404, "prepared content set not found")
        if prepared_content_set_id and not snapshot_prepared_pair:
            raise HTTPException(409, "Prepared resources are not ready")
        snapshot_category = (
            str(snapshot.get("content_category") or "") if snapshot else ""
        )
        if snapshot_category and content_category and snapshot_category != content_category:
            raise HTTPException(404, "recommendation not found")
        selected_content_category = snapshot_category or content_category
        if snapshot:
            session_id = snapshot.get("session_id")
            context_created_at = snapshot.get("context_created_at")
        if uid:
            context = await _load_recent_main_chat(
                uid,
                preferred_session_id=session_id,
                through_created_at=context_created_at,
            )
            await _attach_child_recommendation_context(uid, context)
        else:
            context = {
                "state": "no_history",
                "session_id": None,
                "messages": [],
                "preferred_locale": "zh-CN",
                "external_research_allowed": False,
            }
        # New category-card snapshots freeze the account language used when the
        # recommendation was generated. Legacy links keep the old request-
        # scoped override for backward compatibility, but the current client no
        # longer exposes a manual language switch.
        selected_locale = (
            str(snapshot.get("preferred_locale") or "")
            if snapshot
            else ""
        ) or preferred_locale
        context = _with_requested_preferred_locale(context, selected_locale)
        if snapshot and (
            context.get("state") != "ready"
            or context.get("session_id") != snapshot.get("session_id")
            or (
                snapshot.get("child_profile_fingerprint")
                and snapshot.get("child_profile_fingerprint")
                != context.get("child_profile_fingerprint")
            )
        ):
            # A persisted recommendation must never resurrect conversation-
            # derived context after history personalization is disabled, wiped,
            # or no longer verifiably available.
            raise HTTPException(404, "recommendation not found")
        ranked, _ = _rank_learning_content(
            context.get("messages") or [],
            count=len(LEARNING_CONTENT_CARDS),
            session_id=context.get("session_id"),
            context_created_at=context.get("context_created_at"),
            context_state=context.get("state", "no_history"),
            include_detail=True,
            behavior_events=(
                await _db_get_recommendation_events(uid)
                if uid and context.get("state") == "ready"
                else []
            ),
        )
        card = next((item for item in ranked if item["id"] == card_id), None)
        if not card and snapshot and is_dynamic_request:
            card = _restore_dynamic_research_card_from_snapshot(
                snapshot,
                include_detail=True,
            )
        if not card:
            raise HTTPException(404, "card not found")
        if context.get("child_age_context"):
            card["child_age_context"] = context["child_age_context"]
        if selected_content_category in CONTENT_CATEGORIES:
            meta = _CATEGORY_CARD_META[str(selected_content_category)]
            card["content_category"] = selected_content_category
            card["content_category_label"] = meta["label"]
            card["content_category_eyebrow"] = meta["eyebrow"]
            card["content_category_description"] = meta["description"]
            card["type_label"] = meta["label"]
        if snapshot and context.get("state") == "ready":
            for field in (
                "personalization_reason",
                "recommendation_focus",
                "recommendation_intent",
                "recommendation_score",
            ):
                if snapshot.get(field) not in (None, ""):
                    card[field] = snapshot[field]
            card["recommendation_id"] = snapshot["recommendation_id"]
            card["recommendation_context_status"] = "snapshot"
            card["is_conversation_match"] = True
            card["related_session_id"] = snapshot.get("session_id")
            card["context_created_at"] = snapshot.get("context_created_at")
        elif recommendation_id:
            card["recommendation_context_status"] = "legacy_fallback"
        preferred_locale = str(context.get("preferred_locale") or "zh-CN")
        apply_recommendation_context = bool(
            context.get("child_age_context")
            or (
                context.get("state") == "ready"
                and card.get("is_conversation_match")
            )
        )
        if selected_content_category in CONTENT_CATEGORIES:
            card["resources"] = _reviewed_category_resource_pair(
                card.get("resources", []),
                preferred_locale,
                str(selected_content_category),
                card if apply_recommendation_context else None,
            )
            card["resource_pair_complete"] = len(card["resources"]) == 2
        else:
            card["resources"] = _reviewed_resources_for_context(
                card.get("resources", []),
                preferred_locale,
                card if apply_recommendation_context else None,
            )
        urgent_suppressed = _context_requires_urgent_handoff(context)
        research_eligible = bool(
            uid
            and content_research_oai
            and not urgent_suppressed
            and context.get("external_research_allowed")
            and context.get("state") == "ready"
            and context.get("messages")
            and card.get("is_conversation_match")
        )
        prepared_pair = snapshot_prepared_pair
        if prepared_pair:
            pair_pool = prepared_resource_pairs(snapshot)
            card["resources"] = prepared_pair
            card["resource_pair_complete"] = True
            card["resource_readiness"] = "ready"
            card["research_status"] = "ready"
            card["prepared_content_set_id"] = snapshot.get(
                "prepared_content_set_id"
            )
            card["active_pair_id"] = pair_pool[0]["pair_id"] if pair_pool else None
            card["alternate_resource_pairs"] = pair_pool[1:]
            card["alternate_count"] = max(0, len(pair_pool) - 1)
            article = next(
                resource
                for resource in prepared_pair
                if resource.get("kind") == "article"
            )
            card["title"] = article.get("title") or card.get("title")
            card["summary"] = article.get("description") or card.get("summary")
            card["publisher"] = article.get("publisher") or card.get("publisher")
            card["headline_source"] = "prepared_article"
            if uid:
                await _record_resource_delivery(
                    uid=uid,
                    card_id=card_id,
                    recommendation_id=recommendation_id,
                    content_category=selected_content_category,
                    preferred_locale=preferred_locale,
                    resources=prepared_pair,
                )
        elif research_eligible and card.get("resource_pair_complete"):
            # The reviewed pair is a safe, locale- and stage-gated baseline.
            # Serve it immediately while live research remains an optional
            # refresh; a prepared snapshot replaces it atomically when ready.
            card["research_status"] = "reviewed_fallback"
            card["resource_readiness"] = "ready"
            card["prepared_content_set_id"] = None
        elif research_eligible:
            # Novel topics without a reviewed pair still require preparation.
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Prepared resources are not ready",
            )
        elif urgent_suppressed:
            card["research_status"] = "urgent_suppressed"
            card["resource_readiness"] = "retryable"
            card["prepared_content_set_id"] = None
        elif (
            uid
            and card.get("is_conversation_match")
            and content_research_oai
            and not context.get("external_research_allowed")
        ):
            card["research_status"] = "consent_required"
            card["resource_readiness"] = (
                "ready" if card.get("resource_pair_complete") else "retryable"
            )
            card["prepared_content_set_id"] = None
        elif card.get("is_dynamic_research_card"):
            card["research_status"] = "unavailable"
            card["resource_readiness"] = "retryable"
            card["prepared_content_set_id"] = None
        else:
            card["research_status"] = "reviewed_fallback"
            card["resource_readiness"] = (
                "ready" if card.get("resource_pair_complete") else "retryable"
            )
            card["prepared_content_set_id"] = None
        if (
            uid
            and not prepared_pair
            and card.get("resource_readiness") == "ready"
            and card.get("resources")
        ):
            await _record_resource_delivery(
                uid=uid,
                card_id=card_id,
                recommendation_id=recommendation_id,
                content_category=selected_content_category,
                preferred_locale=preferred_locale,
                resources=card["resources"],
            )
        card["preferred_locale"] = preferred_locale
        card["refresh_available"] = bool(
            research_eligible
            and (prepared_pair or card.get("resource_pair_complete"))
        )
        card["resource_blueprint"] = _resource_blueprint(selected_content_category)
        card["resource_summary"] = summarize_resource_slots(
            card["resources"], preferred_locale
        )
        _decorate_delivery_card(card, card["resources"])
        return card

    gen_cards = await _db_get_gen_cards()
    for c in FEED_CARDS + ALT_FEED_CARDS + gen_cards:
        if c["id"] == card_id:
            if card_id in CARD_DETAILS:
                extra = CARD_DETAILS[card_id]
            else:
                extra = {
                    "body": c.get("body", c["summary"]),
                    "tags": c.get("tags", []),
                    "hook_line": c.get("hook_line", "想了解更多？"),
                }
            return {**c, **extra}
    raise HTTPException(404, "card not found")


@api.post("/feed/{card_id}/research")
async def get_card_research(
    card_id: str,
    session_id: Optional[str] = None,
    context_created_at: Optional[str] = None,
    recommendation_id: Optional[str] = None,
    content_category: Optional[Literal["authority", "featured", "case"]] = None,
    preferred_locale: Optional[Literal["zh-CN", "zh-TW", "en"]] = None,
    refresh: bool = False,
    exclude_resource_ids: Optional[str] = None,
    target_pair_id: Optional[str] = None,
    uid: str = Depends(_req_uid),
):
    """Return a complete conversation-aware 6–9 item bundle or a safe fallback."""

    if (
        card_id not in LEARNING_CONTENT_BY_ID
        and not card_id.startswith(_DYNAMIC_RESEARCH_CARD_PREFIX)
    ):
        raise HTTPException(404, "card not found")
    snapshot = await _db_get_recommendation_snapshot(uid, recommendation_id)
    if recommendation_id and not snapshot:
        raise HTTPException(404, "recommendation not found")
    if snapshot and snapshot.get("card_id") != card_id:
        raise HTTPException(404, "recommendation not found")
    snapshot_category = str(snapshot.get("content_category") or "") if snapshot else ""
    if snapshot_category and content_category and snapshot_category != content_category:
        raise HTTPException(404, "recommendation not found")
    selected_content_category = snapshot_category or content_category
    if snapshot:
        session_id = snapshot.get("session_id")
        context_created_at = snapshot.get("context_created_at")
    context = await _load_recent_main_chat(
        uid,
        preferred_session_id=session_id,
        through_created_at=context_created_at,
    )
    await _attach_child_recommendation_context(uid, context)
    # Category-card snapshots keep the language selected by the account at feed
    # generation time.  Legacy clients may still use the old request override.
    selected_locale = (
        str(snapshot.get("preferred_locale") or "") if snapshot else ""
    ) or preferred_locale
    context = _with_requested_preferred_locale(context, selected_locale)
    if snapshot and (
        context.get("state") != "ready"
        or context.get("session_id") != snapshot.get("session_id")
        or (
            snapshot.get("child_profile_fingerprint")
            and snapshot.get("child_profile_fingerprint")
            != context.get("child_profile_fingerprint")
        )
    ):
        raise HTTPException(404, "recommendation not found")
    # This gate deliberately precedes the external-research consent branch.
    # An emergency always returns the same non-research state, whether consent
    # is on or off, and no provider call is attempted.
    if _context_requires_urgent_handoff(context):
        return {"research_status": "urgent_suppressed"}
    ranked, _ = _rank_learning_content(
        context.get("messages") or [],
        count=len(LEARNING_CONTENT_CARDS),
        session_id=context.get("session_id"),
        context_created_at=context.get("context_created_at"),
        context_state=context.get("state", "no_history"),
        include_detail=True,
        behavior_events=(
            await _db_get_recommendation_events(uid)
            if context.get("state") == "ready"
            else []
        ),
    )
    card = next((item for item in ranked if item["id"] == card_id), None)
    if (
        not card
        and snapshot
        and card_id.startswith(_DYNAMIC_RESEARCH_CARD_PREFIX)
    ):
        card = _restore_dynamic_research_card_from_snapshot(
            snapshot,
            include_detail=True,
        )
    if not card:
        raise HTTPException(404, "card not found")
    if context.get("child_age_context"):
        card["child_age_context"] = context["child_age_context"]
    if selected_content_category in CONTENT_CATEGORIES:
        meta = _CATEGORY_CARD_META[str(selected_content_category)]
        card["content_category"] = selected_content_category
        card["content_category_label"] = meta["label"]
        card["content_category_eyebrow"] = meta["eyebrow"]
        card["content_category_description"] = meta["description"]
        card["type_label"] = meta["label"]
    if snapshot and context.get("state") == "ready":
        for field in (
            "personalization_reason",
            "recommendation_focus",
            "recommendation_intent",
            "recommendation_score",
        ):
            if snapshot.get(field) not in (None, ""):
                card[field] = snapshot[field]
        card["recommendation_id"] = snapshot["recommendation_id"]
        card["recommendation_context_status"] = "snapshot"
        card["is_conversation_match"] = True
        card["related_session_id"] = snapshot.get("session_id")
        card["context_created_at"] = snapshot.get("context_created_at")
    if not card.get("is_conversation_match"):
        return {
            "research_status": "reviewed_fallback",
            **(
                {"refresh_status": "not_available", "has_more": False}
                if refresh
                else {}
            ),
        }
    prepared_pairs = (
        prepared_resource_pairs(snapshot)
        if snapshot and _prepared_snapshot_set_meets_source_contract([snapshot])
        else []
    )
    if refresh and prepared_pairs:
        if target_pair_id and not re.fullmatch(r"pair_[a-f0-9]{16}", target_pair_id):
            raise HTTPException(422, "invalid target_pair_id")
        selected_pair_id = target_pair_id or (
            prepared_pairs[1]["pair_id"] if len(prepared_pairs) > 1 else ""
        )
        if selected_pair_id:
            try:
                switched = snapshot_with_active_resource_pair(
                    snapshot,
                    selected_pair_id,
                )
            except ValueError as exc:
                raise HTTPException(404, "prepared resource pair not found") from exc
            if not await _db_persist_recommendation_snapshots(uid, [switched]):
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    "Prepared resources could not be persisted",
                )
            switched_pairs = prepared_resource_pairs(switched)
            active_resources = prepared_resource_pair(switched) or []
            await _db_append_recommendation_events(
                uid,
                [
                    _new_recommendation_event(
                        event="content_refresh",
                        card_id=card_id,
                        recommendation_id=recommendation_id,
                        content_category=str(selected_content_category or ""),
                        locale=str(context.get("preferred_locale") or "zh-CN"),
                    )
                ],
            )
            await _record_resource_delivery(
                uid=uid,
                card_id=card_id,
                recommendation_id=recommendation_id,
                content_category=selected_content_category,
                preferred_locale=str(context.get("preferred_locale") or "zh-CN"),
                resources=active_resources,
            )
            return {
                "resources": active_resources,
                "content_set_id": switched.get("prepared_content_set_id"),
                "prepared_content_set_id": switched.get("prepared_content_set_id"),
                "active_pair_id": switched_pairs[0]["pair_id"],
                "alternate_resource_pairs": switched_pairs[1:],
                "alternate_count": max(0, len(switched_pairs) - 1),
                "research_status": "ready",
                "refresh_status": "switched_prepared",
                "has_more": len(switched_pairs) > 1,
                "resource_blueprint": _resource_blueprint(selected_content_category),
                "resource_summary": summarize_resource_slots(
                    active_resources,
                    str(context.get("preferred_locale") or "zh-CN"),
                ),
            }
    if not context.get("external_research_allowed"):
        return {
            "research_status": "consent_required",
            **(
                {"refresh_status": "not_available", "has_more": False}
                if refresh
                else {}
            ),
        }
    excluded_ids = {
        resource_id
        for resource_id in (exclude_resource_ids or "").split(",")[:20]
        if re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", resource_id)
    }
    extra_excluded_urls = [
        str(resource.get("url") or "")
        for resource in (card.get("resources") or [])
        if str(resource.get("id") or "") in excluded_ids
        and resource.get("url")
    ]
    if refresh:
        await _db_append_recommendation_events(
            uid,
            [
                _new_recommendation_event(
                    event="content_refresh",
                    card_id=card_id,
                    recommendation_id=recommendation_id,
                    content_category=str(selected_content_category or ""),
                    locale=str(context.get("preferred_locale") or "zh-CN"),
                )
            ],
        )
    research_kwargs: dict[str, object] = {
        "card": card,
        "context": context,
        "uid": uid,
    }
    # Preserve the original internal call contract for ordinary detail loads;
    # refresh-only controls are supplied only when the caller requests them.
    # This also keeps older instrumentation and test doubles compatible.
    if refresh or extra_excluded_urls:
        research_kwargs.update(
            force=refresh,
            extra_excluded_urls=extra_excluded_urls,
        )
    research = await _research_card_detail_resources(**research_kwargs)
    retryable_provider_failure = bool(
        research and research.get("_provider_failure") == "retryable"
    )
    if retryable_provider_failure:
        if refresh:
            # The client deliberately receives no resources here, so it keeps
            # the currently visible pair and may offer another retry.
            return {
                "research_status": "temporarily_unavailable",
                "refresh_status": "temporarily_unavailable",
                "has_more": True,
                "resource_blueprint": _resource_blueprint(
                    selected_content_category
                ),
            }
        research = None
    if not research:
        preferred_locale = str(context.get("preferred_locale") or "zh-CN")
        if refresh:
            return {
                "research_status": "refresh_unavailable",
                "refresh_status": "no_alternative",
                "has_more": False,
                "resource_blueprint": _resource_blueprint(selected_content_category),
            }
        if card.get("is_dynamic_research_card"):
            return {
                "resources": [],
                "research_status": "unavailable",
                "fallback_reason": "no_complete_verified_bundle",
                "resource_blueprint": _resource_blueprint(selected_content_category),
                "resource_summary": summarize_resource_slots(
                    [], preferred_locale
                ),
            }
        # Preserve only reviewed resources that pass the same locale, trust and
        # conversation-context gates as the initial detail response. A failed
        # live search must not blank a verified list, and it must not resurrect
        # the old Taiwan/Traditional-Chinese fallbacks either.
        if selected_content_category in CONTENT_CATEGORIES:
            # Personalized category lanes publish only fresh searched content.
            # The static library remains available elsewhere, but it cannot be
            # relabelled as the result of this conversation after a provider
            # failure.
            reviewed_resources = []
        else:
            reviewed_resources = _reviewed_resources_for_context(
                card.get("resources", []),
                preferred_locale,
                card,
            )
        return {
            "resources": reviewed_resources,
            "research_status": (
                "reviewed_fallback" if reviewed_resources else "unavailable"
            ),
            "fallback_reason": "no_complete_verified_bundle",
            "resource_blueprint": _resource_blueprint(selected_content_category),
            "resource_summary": summarize_resource_slots(
                reviewed_resources, preferred_locale
            ),
        }
    preferred_locale = str(context.get("preferred_locale") or "zh-CN")
    full_resources = research["resources"]
    full_dynamic_count = int(research.get("dynamic_resource_count") or 0)
    resource_count = len(full_resources)
    complete_dynamic_bundle = bool(
        MIN_TOTAL_RESEARCH_RESOURCES
        <= resource_count
        <= MAX_TOTAL_RESEARCH_RESOURCES
        and full_dynamic_count == resource_count
    )
    if (
        card.get("is_dynamic_research_card")
        and not complete_dynamic_bundle
    ):
        # There is no topic-appropriate reviewed fallback for a novel subject.
        # Never relabel unrelated library resources as personalized results.
        return {
            "resources": [],
            "research_status": "unavailable",
            **(
                {"refresh_status": "no_alternative", "has_more": False}
                if refresh
                else {}
            ),
            "resource_blueprint": _resource_blueprint(selected_content_category),
            "resource_summary": summarize_resource_slots([], preferred_locale),
        }
    if selected_content_category in CONTENT_CATEGORIES:
        live_pair = _delivery_contract_pair(
            full_resources,
            str(selected_content_category),
            preferred_locale,
        )
        live_by_kind = {
            str(resource.get("kind") or ""): resource for resource in live_pair
        }
        if (
            len(live_by_kind) < 2
            and not card.get("is_dynamic_research_card")
            and not refresh
        ):
            # Do not repair a fresh category with a fixed old static resource.
            pass
        resources = [
            live_by_kind[kind]
            for kind in ("article", "video")
            if kind in live_by_kind
        ]
        if len(resources) != 2:
            return {
                "resources": [],
                "research_status": (
                    "refresh_unavailable" if refresh else "unavailable"
                ),
                **(
                    {"refresh_status": "no_alternative", "has_more": False}
                    if refresh
                    else {}
                ),
                "fallback_reason": "no_complete_verified_pair",
                "resource_blueprint": _resource_blueprint(selected_content_category),
                "resource_summary": summarize_resource_slots([], preferred_locale),
            }
        dynamic_count = sum(
            resource.get("research_source") == "openai_web_search"
            for resource in resources
        )
        if complete_dynamic_bundle and not any(
            resource.get("research_source") == "reviewed_library"
            for resource in resources
        ):
            dynamic_count = len(resources)
        reviewed_count = len(resources) - dynamic_count
        research_status = (
            "fresh" if dynamic_count == len(resources) else "hybrid" if dynamic_count else "reviewed_fallback"
        )
    else:
        resources = full_resources
        dynamic_count = full_dynamic_count
        reviewed_count = int(research.get("reviewed_resource_count") or 0)
        research_status = (
            "fresh"
            if complete_dynamic_bundle
            else "hybrid"
            if dynamic_count
            else "reviewed_fallback"
        )
    content_set_id = str(uuid.uuid4())
    resource_events = [
        _new_recommendation_event(
            event="resource_delivered",
            card_id=card_id,
            trusted_resource_url=True,
            recommendation_id=recommendation_id,
            resource_id=str(resource.get("id") or ""),
            resource_url=str(resource.get("url") or ""),
            resource_kind=str(resource.get("kind") or ""),
            content_category=str(resource.get("content_category") or ""),
            locale=(resource.get("locales") or [preferred_locale])[0],
            position=index,
        )
        for index, resource in enumerate(resources)
        if resource.get("id") and resource.get("url")
    ]
    if resource_events:
        await _db_append_recommendation_events(uid, resource_events)
    return {
        "resources": resources,
        "content_set_id": content_set_id,
        "research_status": research_status,
        "refresh_status": "refreshed" if refresh else "ready",
        "has_more": True,
        "research_query": research.get("query"),
        "research_editor_note": research.get("editor_note"),
        "research_source_count": research.get("cited_source_count", 0),
        "dynamic_resource_count": dynamic_count,
        "reviewed_resource_count": reviewed_count,
        "resource_blueprint": _resource_blueprint(selected_content_category),
        "resource_summary": summarize_resource_slots(resources, preferred_locale),
    }

# ── Collections ───────────────────────────────────────────────────────────────
MAX_COLLECTIONS = 12

@api.get("/collections")
async def list_collections(uid: Optional[str] = Depends(_opt_uid)):
    return await _db_list_collections(uid or "anon")

@api.post("/collections")
async def create_collection(body: CollectionCreate, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    existing = await _db_list_collections(key)
    if len(existing) >= MAX_COLLECTIONS:
        raise HTTPException(400, f"已达上限，最多创建 {MAX_COLLECTIONS} 个收藏夹")
    col = await _db_create_collection(key, body.name)
    return col

@api.put("/collections/{col_id}")
async def rename_collection(col_id: str, body: CollectionRename, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    ok = await _db_rename_collection(key, col_id, body.name)
    if not ok:
        raise HTTPException(404, "收藏夹不存在")
    return {"id": col_id, "name": body.name}

@api.delete("/collections/{col_id}")
async def delete_collection(col_id: str, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    await _db_delete_collection(key, col_id)
    return {"ok": True}

# ── Favorites ─────────────────────────────────────────────────────────────────
@api.get("/favorites")
async def list_favorites(uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    sb = _get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("favorites").select("card_id,collection_id").eq("user_id", key).execute()
            )
            rows = res.data or []
            col_map = {r["card_id"]: r.get("collection_id") for r in rows}
            ids = set(col_map.keys())
        except Exception as e:
            print(f"[warn] list_favorites: {e}")
            ids = _favorites.get(key, set())
            col_map = _fav_cols.get(key, {})
    else:
        ids = _favorites.get(key, set())
        col_map = _fav_cols.get(key, {})
    gen_cards = await _db_get_gen_cards()
    by_id = {
        c["id"]: c
        for c in FEED_CARDS + ALT_FEED_CARDS + LEARNING_CONTENT_CARDS + gen_cards
    }
    return [{**by_id[cid], "collection_id": col_map.get(cid)} for cid in ids if cid in by_id]

@api.post("/favorites/toggle")
async def toggle_favorite(body: FavToggle, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    favorited = await _db_toggle_fav(key, body.card_id)
    return {"favorited": favorited, "card_id": body.card_id}

@api.post("/favorites/save")
async def save_favorite(body: FavSave, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    saved = await _db_save_fav(key, body.card_id, body.collection_id)
    return {"saved": saved, "card_id": body.card_id, "collection_id": body.collection_id}

# ── Analytics ─────────────────────────────────────────────────────────────────
@api.post("/analytics")
async def track_event(ev: AnalyticsIn):
    _analytics.append({**ev.dict(), "ts": _now()})
    return {"ok": True}


@api.post("/recommendations/events", status_code=status.HTTP_202_ACCEPTED)
async def track_recommendation_event(
    body: RecommendationEventIn,
    uid: str = Depends(_req_uid),
):
    """Persist a bounded recommendation signal without conversation text/PII."""

    privacy = await _db_get_privacy(uid, fail_closed=True)
    if privacy.get(_PRIVACY_STORAGE_UNAVAILABLE):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recommendation settings are temporarily unavailable",
        )
    if privacy.get("allow_history_training") is False:
        return {"accepted": False, "reason": "personalization_disabled"}

    raw = body.model_dump(exclude_none=True)
    raw.setdefault("client_event_id", str(uuid.uuid4()))
    normalized = normalize_event(raw, occurred_at=_now())
    if not normalized or normalized.get("event") not in LEARNING_EVENT_NAMES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid event")
    if normalized.get("event") == "not_relevant" and not normalized.get("reason"):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "A not_relevant event requires a reason",
        )
    if normalized.get("event") != "not_relevant" and normalized.get("reason"):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Feedback reason is only valid for not_relevant events",
        )
    _, persisted = await _db_append_recommendation_events(uid, [normalized])
    return {
        "accepted": True,
        "persisted": persisted,
        "event_id": normalized.get("event_id"),
    }

# ── Chat ──────────────────────────────────────────────────────────────────────
def _chat_preview_row(row: Optional[dict], include_role: bool = False) -> Optional[dict]:
    if not row:
        return None
    preview = {
        "id": row.get("id"),
        "text": row.get("text") or "",
        "created_at": row.get("created_at"),
    }
    if include_role:
        preview["role"] = row.get("role")
    return preview


def _chat_activity_key(row: dict) -> tuple[str, str]:
    # Supabase timestamps are ISO-8601 strings, so lexical ordering preserves
    # chronology. The id provides a deterministic tie-break for equal times.
    return (str(row.get("created_at") or ""), str(row.get("id") or ""))


def _main_chat_preview_payload(
    session: Optional[dict] = None,
    last_message: Optional[dict] = None,
    last_user_message: Optional[dict] = None,
) -> dict:
    if not session:
        return {
            "has_conversation": False,
            "session_id": None,
            "title": None,
            "last_activity_at": None,
            "last_user_message": None,
            "last_message": None,
        }
    return {
        "has_conversation": True,
        "session_id": session.get("id"),
        "title": session.get("title"),
        "last_activity_at": (
            (last_message or {}).get("created_at") or session.get("created_at")
        ),
        "last_user_message": _chat_preview_row(last_user_message),
        "last_message": _chat_preview_row(last_message, include_role=True),
    }


def _main_chat_preview_from_memory(uid: str) -> dict:
    sessions = [
        session
        for session in _sessions.values()
        if session.get("user_id") == uid and not session.get("source_card_id")
    ]
    if not sessions:
        return _main_chat_preview_payload()

    session_ids = {session["id"] for session in sessions}
    all_messages = [
        {
            **message,
            "session_id": message.get("session_id") or session_id,
        }
        for session_id in session_ids
        for message in _messages.get(session_id, [])
    ]
    last_user_message = max(
        (message for message in all_messages if message.get("role") == "user"),
        key=_chat_activity_key,
        default=None,
    )
    if last_user_message:
        session = next(
            item
            for item in sessions
            if item["id"] == last_user_message.get("session_id")
        )
    else:
        session = max(sessions, key=_chat_activity_key)

    session_messages = _messages.get(session["id"], [])
    last_message = max(session_messages, key=_chat_activity_key, default=None)
    return _main_chat_preview_payload(session, last_message, last_user_message)


@api.get("/chat/main/preview")
async def get_main_chat_preview(uid: str = Depends(_req_uid)):
    """Return a small, read-only resume snapshot for the signed-in parent.

    The main conversation containing the parent's most recent message is
    selected, so a newly created AI-only greeting cannot hide real history.
    Only the text fields needed by the home card are returned; images,
    transitions, and full history stay out of the payload.
    """
    sb = _get_supabase()
    if not sb:
        return _main_chat_preview_from_memory(uid)

    try:
        session_res = await anyio.to_thread.run_sync(
            lambda: sb.table("chat_sessions")
            .select("id,title,source_card_id,created_at")
            .eq("user_id", uid)
            .execute()
        )
        main_sessions = [
            session
            for session in (session_res.data or [])
            if not session.get("source_card_id")
        ]
        if not main_sessions:
            return _main_chat_preview_payload()

        session_ids = [session["id"] for session in main_sessions]
        user_message_res = await anyio.to_thread.run_sync(
            lambda: sb.table("chat_messages")
            .select("id,session_id,role,text,created_at")
            .in_("session_id", session_ids)
            .eq("role", "user")
            .order("created_at", desc=True)
            .order("id", desc=True)
            .limit(1)
            .execute()
        )
        last_user_message = (user_message_res.data or [None])[0]
        if last_user_message:
            session = next(
                item
                for item in main_sessions
                if item["id"] == last_user_message.get("session_id")
            )
        else:
            session = max(main_sessions, key=_chat_activity_key)

        message_res = await anyio.to_thread.run_sync(
            lambda: sb.table("chat_messages")
            .select("id,session_id,role,text,created_at")
            .eq("session_id", session["id"])
            .order("created_at", desc=True)
            .order("id", desc=True)
            .limit(1)
            .execute()
        )
        last_message = (message_res.data or [None])[0]
        return _main_chat_preview_payload(session, last_message, last_user_message)
    except Exception as exc:
        print(f"[warn] get_main_chat_preview error: {exc}")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Conversation preview is temporarily unavailable",
        ) from exc


@api.post("/chat/sessions")
async def start_session(body: StartChatRequest, uid: Optional[str] = Depends(_opt_uid)):
    card_id = body.card_id
    title = body.title or "和NURI聊天"
    if card_id:
        for c in FEED_CARDS + LEARNING_CONTENT_CARDS:
            if c["id"] == card_id:
                title = c["title"]
                break

    session = {
        "id": str(uuid.uuid4()), "title": title,
        "source_card_id": card_id, "step": 1,
        "script_key": CARD_TO_SCRIPT.get(card_id or "", "free"),
        "created_at": _now(),
    }
    if uid:
        session["user_id"] = uid

    sb = _get_supabase()
    if sb:
        try:
            await anyio.to_thread.run_sync(lambda: sb.table("chat_sessions").insert(session).execute())
        except Exception as e:
            print(f"[warn] start_session insert error: {e}")
            _sessions[session["id"]] = session
            _messages[session["id"]] = []
    else:
        _sessions[session["id"]] = session
        _messages[session["id"]] = []

    # Fetch profile info for a personalised greeting and ongoing context
    profile, children = await _load_profile(uid)
    nickname = profile.get("nickname", "")
    profile_ctx = _profile_ctx(profile, children)

    gen_cards = await _db_get_gen_cards()
    ctx = _card_ctx(card_id, gen_cards) if card_id else ""
    style_ctx = await _get_style_rules_ctx()
    name_part = f"用户的名字是{nickname}，" if nickname else ""
    quick_replies: list = []
    if oai:
        if ctx:
            intro_prompt = (
                f"{name_part}用户刚看完这条育儿内容：{ctx[:200]}。"
                "用专业顾问的口吻简短开场：先用名字打招呼（如果有），"
                "再说一句对这个话题的专业观察或家长常见的误区，让对方感受到你的专业和真实关心。"
                "不要问问题，不要客服腔，控制在3句话以内。"
            )
        else:
            intro_prompt = (
                f"{name_part}用户来找你聊育儿。"
                "用专业顾问的口吻打招呼：先用名字问候（如果有），"
                "简短介绍自己是专注儿童发展的育儿顾问NURI，"
                "再说一句真诚的、让父母感受到被理解和支持的话。"
                "语气温暖但沉稳，不油腻，不问问题，控制在3句话以内。"
            )
        reply = await anyio.to_thread.run_sync(
            lambda: _nuri_reply_sync([{"role": "user", "text": intro_prompt}], "", "", profile_ctx, style_ctx)
        )
        first_text = reply["text"]
        quick_replies = reply.get("quick_replies", [])
    else:
        script_key = session["script_key"]
        first_step = SCRIPTS.get(script_key, SCRIPTS["free"])[0]
        first_text = first_step["text"]
        quick_replies = first_step.get("quick_replies", [])

    first_msg = {
        "id": str(uuid.uuid4()), "session_id": session["id"],
        "role": "ai", "text": first_text,
        "quick_replies": quick_replies, "transition": None, "created_at": _now(),
    }
    if sb:
        try:
            await anyio.to_thread.run_sync(lambda: sb.table("chat_messages").insert(first_msg).execute())
        except Exception as e:
            print(f"[warn] start_session msg insert error: {e}")
    else:
        _messages[session["id"]].append(first_msg)

    return session

@api.get("/chat/sessions")
async def list_sessions(uid: Optional[str] = Depends(_opt_uid)):
    sb = _get_supabase()
    if sb and uid:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("chat_sessions")
                .select("*")
                .eq("user_id", uid)
                .order("created_at", desc=True)
                .execute()
            )
            return res.data or []
        except Exception as e:
            print(f"[warn] list_sessions error: {e}")
    sessions = list(_sessions.values())
    if uid:
        sessions = [s for s in sessions if s.get("user_id") == uid]
    return sorted(sessions, key=lambda s: s["created_at"], reverse=True)

@api.delete("/chat/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, uid: Optional[str] = Depends(_opt_uid)):
    sb = _get_supabase()
    if sb:
        try:
            # Delete by id only — user_id may be null for sessions created
            # before auth was introduced, so we don't filter by user_id here.
            await anyio.to_thread.run_sync(
                lambda: sb.table("chat_sessions").delete().eq("id", session_id).execute()
            )
            return
        except Exception as e:
            print(f"[warn] delete_session error: {e}")
    _sessions.pop(session_id, None)
    _messages.pop(session_id, None)

@api.get("/chat/sessions/{session_id}/messages")
async def get_messages(session_id: str):
    sb = _get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("chat_messages")
                .select("*")
                .eq("session_id", session_id)
                .order("created_at", desc=False)
                .execute()
            )
            return res.data or []
        except Exception as e:
            print(f"[warn] get_messages error: {e}")
    return _messages.get(session_id, [])

class _Turn(NamedTuple):
    """Everything established about a chat turn before the AI reply is produced.
    Shared by the blocking and streaming endpoints."""
    session: dict
    owner_uid: Optional[str]
    user_msg: dict
    msgs: list
    context_hints: dict
    fix_text: Optional[str]


async def _prepare_turn(session_id: str, body: "UserMessageIn", uid: Optional[str]) -> _Turn:
    sb = _get_supabase()

    # Load session
    session = None
    if sb:
        try:
            sr = await anyio.to_thread.run_sync(
                lambda: sb.table("chat_sessions").select("*").eq("id", session_id).execute()
            )
            session = sr.data[0] if sr.data else None
        except Exception as e:
            print(f"[warn] post_message load session: {e}")
    if not session:
        session = _sessions.get(session_id)
    if not session:
        raise HTTPException(404, "session not found")

    owner_uid = uid or session.get("user_id")

    user_msg = {
        "id": str(uuid.uuid4()), "session_id": session_id,
        "role": "user",
        "text": body.text or ("[图片]" if body.image_base64 else ""),
        "image_base64": body.image_base64,
        "quick_replies": [], "transition": None, "created_at": _now(),
    }

    profile, children = await _load_profile(owner_uid)
    context_hints = dict(profile)
    if children:
        context_hints["children"] = children
    await _save_normalized_input(
        user_id=owner_uid, session_id=session_id,
        source="card_chat" if session.get("source_card_id") else "chat",
        raw_text=body.text or "", raw_image_base64=body.image_base64,
        card_ref={"card_id": session.get("source_card_id")} if session.get("source_card_id") else None,
        context_hints=context_hints,
    )

    # Persist user message and load full history for AI
    msgs: list = []
    if sb:
        try:
            await anyio.to_thread.run_sync(lambda: sb.table("chat_messages").insert(user_msg).execute())
            mr = await anyio.to_thread.run_sync(
                lambda: sb.table("chat_messages")
                .select("role,text,transition")
                .eq("session_id", session_id)
                .order("created_at", desc=False)
                .execute()
            )
            msgs = mr.data or []
        except Exception as e:
            print(f"[warn] post_message msgs load: {e}")
    if not msgs:
        msgs = _messages.setdefault(session_id, [])
        msgs.append(user_msg)

    # "#fix <反馈>" is an internal command for reviewers to correct the AI's
    # last reply — it never reaches the parent as a normal turn. See
    # _distill_style_rule_sync / nuri_style_rules.
    fix_text = None
    stripped_text = (body.text or "").strip()
    if stripped_text.startswith(FIX_KEYWORD) and await _is_fix_reviewer(owner_uid):
        fix_text = stripped_text[len(FIX_KEYWORD):].strip()

    user_turns = sum(1 for m in msgs if m["role"] == "user")
    await _maybe_set_title(session, session_id, body, fix_text, user_turns)
    return _Turn(session, owner_uid, user_msg, msgs, context_hints, fix_text)


async def _maybe_set_title(
    session: dict, session_id: str, body: "UserMessageIn",
    fix_text: Optional[str], user_turns: int,
) -> None:
    sb = _get_supabase()
    # Auto-generate a short title on the first user message
    if not fix_text and user_turns == 1:
        first_text = body.text or ""
        if oai and first_text:
            try:
                title_resp = await anyio.to_thread.run_sync(
                    lambda: oai.chat.completions.create(
                        model="gpt-5.4-mini",
                        messages=[{"role": "user", "content": f"用10字以内总结这句话的话题，只输出话题词，不加标点：{first_text}"}],
                        max_completion_tokens=20,
                        timeout=OPENAI_FAST_TIMEOUT_S,
                    )
                )
                new_title = title_resp.choices[0].message.content.strip()[:20]
            except Exception:
                new_title = first_text[:15]
        else:
            new_title = first_text[:15] if first_text else session.get("title", "")
        if new_title:
            if sb:
                try:
                    await anyio.to_thread.run_sync(
                        lambda: sb.table("chat_sessions").update({"title": new_title}).eq("id", session_id).execute()
                    )
                except Exception:
                    pass
            elif session_id in _sessions:
                _sessions[session_id]["title"] = new_title

async def _fix_reply(msgs: list, fix_text: str, uid: Optional[str] = None) -> str:
    """Handle a reviewer's `#fix` correction: distil it into a reusable style
    rule instead of answering the parent.

    Also the strongest learning signal the system gets: a reviewer objecting to
    a reply is a labelled negative on every directive that shaped it, which is
    worth more than any inference from a parent's silence.
    """
    sb = _get_supabase()
    prior_ai_text = next(
        (m.get("text", "") for m in reversed(msgs[:-1]) if m.get("role") == "ai"), ""
    )
    rule = await anyio.to_thread.run_sync(lambda: _distill_style_rule_sync(prior_ai_text, fix_text))
    if sb and rule.get("rule"):
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("nuri_style_rules").insert({
                    "id": str(uuid.uuid4()), "rule": rule["rule"], "category": rule.get("category"),
                    "source_note": fix_text, "active": True, "created_by": "chat:#fix",
                }).execute()
            )
            # The new rule has to be visible on the next turn, not in two
            # minutes, or a reviewer testing a correction sees the old reply.
            core_dialogue.clear_cache()
            await core_outcome.observe_latest(uid=uid, signal="fix", ports=_core_ports())
            return f"已记录调整：{rule['rule']}"
        except Exception as e:
            print(f"[warn] #fix insert error: {e}")
            return "调整没能存上，稍后在后台重试一下。"
    return "没能提炼出规则，换个说法再试一次？"


async def _scripted_reply(session: dict, session_id: str) -> tuple:
    """Canned script used when no OpenAI key is configured."""
    sb = _get_supabase()
    script_key = session.get("script_key", "free")
    script = SCRIPTS.get(script_key, SCRIPTS["free"])
    step = session.get("step", 0)
    transition = None
    quick_replies: list = []
    sources: list = []
    if step < len(script):
        nxt = script[step]
        ai_text = nxt["text"]
        transition = nxt.get("transition")
        quick_replies = nxt.get("quick_replies", [])
        new_step = step + 1
    else:
        ai_text = "嗯，我先记下了。你随时回来继续，我会保持上下文。"
        new_step = step
    if transition and transition.get("kind") == "tasks_generated":
        transition = {
            "kind": "task_suggestion",
            "tasks": CARD_TASKS.get(script_key, CARD_TASKS["free"]),
        }
    if sb:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("chat_sessions").update({"step": new_step}).eq("id", session_id).execute()
            )
        except Exception:
            pass
    else:
        session["step"] = new_step
    return ai_text, quick_replies, transition


class _ReplyContext(NamedTuple):
    """Everything assembled before the reply model is called. A NamedTuple
    rather than a bare tuple because it now carries eight things, and
    positional unpacking of eight was one refactor away from a silent mix-up.

    Field-compatible with nuri_core.TurnBundle on purpose: both pipelines hand
    the same names to the same reply call, so switching between them changes
    what is in the system prompt and nothing else about the turn."""
    card: str
    memory: str
    profile: str
    style: str
    internal: str
    sources: str                       # rendered allow-list, "" when not searching
    route: "TurnRoute"
    search_results: list               # SearchResult objects behind `sources`
    #: Set only by the four-model pipeline. When present the dialogue model has
    #: already rendered the system prompt and the blocks above are duplicates
    #: kept for logging and for the A/B comparison.
    plan: object = None
    trace: object = None
    family: object = None
    evidence: object = None


async def _route_and_search(
    turn: _Turn, profile_ctx: str, metrics: Optional["_TurnMetrics"],
) -> tuple["TurnRoute", list]:
    """Decide what this turn needs from the outside, then fetch it.

    Serial by nature — the search can't start until the router has produced a
    query — but the pair runs concurrently with the other context blocks, so
    only the part that isn't hidden behind them lands on first-token latency.

    Distinct from content_research.py, which prepares the home feed's cards
    ahead of time. This one runs inside the turn and feeds the reply's
    citations; the two share the source_domains trust table but nothing else.

    Both halves already degrade to "nothing" on failure, so this needs no error
    handling of its own.
    """
    started = time.perf_counter()
    route = await route_turn(
        turn.msgs, client=aoai, child_context=profile_ctx,
    )
    if metrics:
        metrics.mark("route_ms", started)
        metrics.set(**route_metrics(route))
    if not route.needs_search:
        return route, []

    started = time.perf_counter()
    results = await search_sources(
        route.search_query, zh_query=route.search_query_zh,
        scope=route.search_scope, is_medical=route.is_medical,
        sb=_get_supabase(),
    )
    if metrics:
        metrics.mark("search_ms", started)
        metrics.set(search_hits=len(results), search_provider=get_search_provider().name)
    return route, results


#: Which turn pipeline builds the prompt. "four_model" runs the four
#: subsystems in backend/nuri_core; "linear" is the original single-gather
#: path. Both are kept deliberately: the point of the four-model build is to be
#: measured against this one, and a flag is the only honest way to do that.
NURI_PIPELINE = os.getenv("NURI_PIPELINE", "four_model")

_core_ports_singleton: Optional[CorePorts] = None


def _core_ports() -> CorePorts:
    """The application surface handed to nuri_core.

    Built lazily and once. Most of what a subsystem needs now lives in its own
    store module and is named here directly, so this reads as the wiring
    diagram: which subsystem gets which capability. What remains injected
    rather than imported is the part still owned by this file — the generated
    feed cards and the card context that renders them — plus the two seams
    tests actually substitute.
    """
    global _core_ports_singleton
    if _core_ports_singleton is None:
        _core_ports_singleton = CorePorts(
            supabase=_get_supabase,
            aoai=aoai,
            to_thread=anyio.to_thread.run_sync,
            # 1 家庭模型
            load_profile=core_family_store.load_profile,
            profile_ctx=core_family_store.profile_ctx,
            age_label=core_family_store.age_label,
            age_months=core_family_store.age_in_months,
            memory_context=core_family_store.get_memory_context,
            follow_up_context=core_family_store.get_follow_up_context,
            # 2 知识与决策模型
            internal_rules=core_knowledge_store.internal_rules_ctx,
            search_sources=search_sources,
            sources_prompt_block=sources_prompt_block,
            search_provider_name=lambda: get_search_provider().name,
            # 3 对话与主动模型
            persona=core_dialogue_reply.NURI_PERSONA,
            style_rules=core_dialogue_reply.get_style_rules_ctx,
            card_ctx=_card_ctx,
            gen_cards=_db_get_gen_cards,
            # 横切 Safety Layer
            is_urgent=core_dialogue_reply.urgent_task_suppressed,
        )
    return _core_ports_singleton


async def _reply_context_four_model(
    turn: _Turn, body: "UserMessageIn", metrics: Optional["_TurnMetrics"] = None,
) -> _ReplyContext:
    """Build the turn through 家庭 / 知识与决策 / 对话与主动 / 结果学习.

    The metrics row keeps its existing shape — `route_ms`, `search_ms`,
    `context_ms` and the route columns all still land where they did — because
    the whole exercise is a comparison, and a comparison against a moved
    goalpost is not one.
    """
    def _on_route(route) -> None:
        if metrics and route is not None:
            metrics.set(**route_metrics(route))

    bundle: TurnBundle = await run_turn_context(
        history=turn.msgs,
        user_text=body.text or "",
        uid=turn.owner_uid,
        context_hints=turn.context_hints,
        ports=_core_ports(),
        route_turn=route_turn,
        source_card_id=turn.session.get("source_card_id") or "",
        history_window=_HISTORY_WINDOW,
        on_route_done=_on_route,
    )

    trace = bundle.trace
    if metrics:
        metrics.set(**trace.metrics_row())
        # The three the linear pipeline already reports, under their existing
        # names, so a dashboard built on them keeps working across the switch.
        metrics.set(
            context_ms=trace.timings.get("context", 0),
            route_ms=trace.timings.get("route", 0),
            search_ms=trace.timings.get("search", 0),
        )
        if bundle.search_results:
            metrics.set(
                search_hits=len(bundle.search_results),
                search_provider=get_search_provider().name,
            )

    return _ReplyContext(
        card=bundle.card,
        memory=bundle.memory,
        profile=bundle.profile,
        style=bundle.style,
        internal=bundle.internal,
        sources=bundle.sources,
        route=bundle.route or NO_ROUTE,
        search_results=list(bundle.search_results),
        plan=bundle.plan,
        trace=trace,
        family=bundle.family,
        evidence=bundle.evidence,
    )


async def _reply_context(
    turn: _Turn, body: "UserMessageIn", metrics: Optional["_TurnMetrics"] = None,
) -> _ReplyContext:
    """Gather the prompt context blocks. The I/O-bound ones run concurrently
    rather than as serial round trips before the reply starts."""
    if NURI_PIPELINE == "four_model":
        return await _reply_context_four_model(turn, body, metrics)
    started = time.perf_counter()
    profile_ctx = _profile_ctx(turn.context_hints, turn.context_hints.get("children"))
    gen_cards, memory_ctx, follow_ctx, style_ctx, internal_ctx, routed = await asyncio.gather(
        _db_get_gen_cards(),
        _get_memory_context(turn.owner_uid),
        _get_follow_up_context(turn.owner_uid),
        _get_style_rules_ctx(),
        anyio.to_thread.run_sync(_internal_rules_ctx, body.text or ""),
        _route_and_search(turn, profile_ctx, metrics),
    )
    route, results = routed
    if metrics:
        metrics.mark("context_ms", started)
    return _ReplyContext(
        card=_card_ctx(turn.session.get("source_card_id") or "", gen_cards),
        # Appended to the memory block rather than given a heading of its own:
        # both answer "what does NURI already know about this family", and a
        # separate section invites the model to work through it as a checklist.
        memory=(memory_ctx + ("\n\n" + follow_ctx if follow_ctx else "")),
        profile=profile_ctx,
        style=style_ctx,
        internal=internal_ctx,
        sources=sources_prompt_block(results),
        route=route,
        search_results=results,
    )


def _plan_prompt(rc: _ReplyContext) -> tuple[Optional[str], Optional[int]]:
    """The system message the dialogue model rendered, or (None, None) to let
    _nuri_messages concatenate the blocks the old way."""
    if rc.plan is None:
        return None, None
    return rc.plan.system_prompt(NURI_PERSONA + _NURI_JSON_SUFFIX), rc.plan.history_window


async def _after_turn(rc: _ReplyContext, turn: _Turn, session_id: str) -> None:
    """Close the four-model loop once the reply has already been delivered.

    Two writes, both optional. `outcome.record` opens a learning row that a
    later signal — a `#fix`, an adopted task, a "没帮上忙" — attaches itself to;
    `provenance.persist` stores the trace this branch exists to compare. Either
    can fail without the parent noticing, which is why both run here and not on
    the reply path.
    """
    if rc.plan is None or rc.trace is None:
        return
    ports = _core_ports()
    await core_outcome.record(
        uid=turn.owner_uid,
        session_id=session_id,
        turn_id=rc.trace.turn_id,
        topic=getattr(rc.evidence, "topic", "") or "",
        risk_tier=getattr(rc.evidence, "risk_tier", "none"),
        directive_ids=rc.trace.directive_ids,
        ports=ports,
    )
    await core_provenance.persist(
        rc.trace, session_id=session_id, user_id=turn.owner_uid, ports=ports,
    )


async def _task_suggestion(
    reply: dict, msgs: list, user_text: str, ai_text: str,
    metrics: Optional["_TurnMetrics"] = None,
    allow: bool = True,
) -> Optional[dict]:
    """Build task drafts for either supported trigger.

    The primary reply returns task proposals alongside its actionable guidance,
    keeping the cards faithful to the plan already shown. A deterministic intent
    recognizer guarantees that a parent's direct request still triggers even if
    the model's boolean is conservative. The older second model call remains only
    as a fallback when a triggered reply contains no usable proposals.

    On the streaming path this runs *after* the reply is already on the parent's
    screen, so a failure here must never take the reply down with it — the turn
    just arrives without task cards.
    """
    # `allow` is the safety layer's gate, already decided for this turn. It
    # subsumes the urgency check below rather than replacing it: the linear
    # pipeline has no safety layer, so both paths keep the same floor.
    if not allow or _user_declined_tasks(user_text) or _urgent_task_suppressed(user_text, ai_text):
        return None
    explicit_request = _user_requested_tasks(user_text)
    task_list = _normalize_task_proposals(reply.get("task_proposals"))
    if not (explicit_request or reply.get("suggest_tasks")):
        return None

    requested_count = _requested_task_count(user_text) if explicit_request else None
    if requested_count and task_list:
        task_list = task_list[:requested_count]

    started = time.perf_counter()
    if not task_list or (requested_count and len(task_list) < requested_count):
        task_context = msgs + [{"role": "ai", "text": ai_text}]
        try:
            fallback_tasks = await anyio.to_thread.run_sync(
                lambda: _gen_tasks_ai_sync(task_context, requested_count)
            )
            task_list = _normalize_task_proposals(task_list + fallback_tasks)
            if requested_count:
                task_list = task_list[:requested_count]
        except Exception as e:
            print(f"[warn] task suggestion failed: {type(e).__name__}: {e}")
            if metrics:
                metrics.mark("tasks_ms", started)
            return None
    if metrics:
        metrics.mark("tasks_ms", started)
        metrics.set(suggested_tasks=bool(task_list))
    return {
        "kind": "task_suggestion",
        "trigger": "explicit_request" if explicit_request else "actionable_reply",
        "tasks": task_list,
    } if task_list else None


def _cited_sources(
    cited: Optional[list], results: list, metrics: Optional["_TurnMetrics"] = None,
) -> list[dict]:
    """Turn the model's citation indices into the links the app renders.

    The model only ever emits numbers, so the URLs here come from the search
    results this backend fetched — a hallucinated link is not merely discouraged
    but unrepresentable. Out-of-range indices are dropped rather than clamped;
    guessing which source was meant would defeat the point.
    """
    out, seen = [], set()
    for n in cited or []:
        if not isinstance(n, int) or not (1 <= n <= len(results)) or n in seen:
            continue
        seen.add(n)
        r = results[n - 1]
        out.append({
            "n": n, "title": r.title, "url": r.url,
            "site_name": r.site_name, "lang": r.lang, "tier": r.tier,
        })
    if metrics:
        metrics.set(cited_sources=len(out))
    return out


async def _persist_ai_turn(
    session_id: str, turn: _Turn, ai_text: str,
    quick_replies: list, transition: Optional[dict], sources: Optional[list] = None,
) -> dict:
    sb = _get_supabase()
    ai_msg = {
        "id": str(uuid.uuid4()), "session_id": session_id,
        "role": "ai", "text": ai_text,
        "quick_replies": quick_replies, "transition": transition,
        "sources": sources or [], "created_at": _now(),
    }
    if sb:
        try:
            await anyio.to_thread.run_sync(lambda: sb.table("chat_messages").insert(ai_msg).execute())
        except Exception as e:
            print(f"[warn] post_message ai_msg insert: {e}")
            # `sources` arrives with message_sources_migration.sql. Deploying
            # ahead of that migration would otherwise stop every AI reply from
            # being saved at all, which is far worse than losing the links —
            # so drop the new column and keep the message.
            legacy = {k: v for k, v in ai_msg.items() if k != "sources"}
            try:
                await anyio.to_thread.run_sync(
                    lambda: sb.table("chat_messages").insert(legacy).execute()
                )
                print("[warn] saved without `sources`; run message_sources_migration.sql")
            except Exception as e2:
                print(f"[warn] ai_msg insert retry failed: {e2}")
    else:
        turn.msgs.append(ai_msg)
    return ai_msg


@api.post("/chat/sessions/{session_id}/messages")
async def post_message(
    session_id: str, body: UserMessageIn, background_tasks: BackgroundTasks,
    uid: Optional[str] = Depends(_opt_uid),
):
    """Non-streaming turn. Kept as the fallback for clients that can't consume
    the SSE endpoint below (and for hosts that buffer streamed responses)."""
    metrics = _TurnMetrics(streamed=False)
    turn = await _prepare_turn(session_id, body, uid)
    transition = None
    quick_replies: list = []
    # Both the #fix and scripted branches below skip the model, and so produce
    # no citations; without this the persist call a few lines down raises.
    sources: list = []
    rc: Optional[_ReplyContext] = None

    if turn.fix_text:
        ai_text = await _fix_reply(turn.msgs, turn.fix_text, turn.owner_uid)
    elif oai:
        rc = await _reply_context(turn, body, metrics)
        system_prompt, history_window = _plan_prompt(rc)
        reply = await anyio.to_thread.run_sync(
            lambda: _nuri_reply_sync(
                turn.msgs, rc.card, rc.memory, rc.profile, rc.style,
                rc.internal, rc.sources, metrics, system_prompt, history_window,
            )
        )
        ai_text = reply["text"]
        quick_replies = reply.get("quick_replies", [])
        sources = _cited_sources(reply.get("cited"), rc.search_results, metrics)
        transition = await _task_suggestion(
            reply, turn.msgs, body.text or "", ai_text, metrics,
            allow=rc.plan.allow_task_cards if rc.plan else True,
        )
    else:
        ai_text, quick_replies, transition = await _scripted_reply(turn.session, session_id)

    ai_msg = await _persist_ai_turn(session_id, turn, ai_text, quick_replies, transition, sources)

    # Logged after the reply is built, and only for real model turns — a #fix
    # command or the canned script isn't a generation worth measuring.
    if oai and not turn.fix_text:
        background_tasks.add_task(
            metrics.flush, session_id=session_id, user_id=turn.owner_uid, reply_text=ai_text,
        )
        if rc is not None:
            background_tasks.add_task(_after_turn, rc, turn, session_id)

    if oai and turn.owner_uid:
        background_tasks.add_task(
            _extract_and_upsert_memories, turn.msgs + [ai_msg], turn.owner_uid, session_id
        )

    return {"user_message": turn.user_msg, "ai_messages": [ai_msg]}


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@api.post("/chat/sessions/{session_id}/messages/stream")
async def post_message_stream(
    session_id: str, body: UserMessageIn, uid: Optional[str] = Depends(_opt_uid),
):
    """Same turn as post_message, delivered as Server-Sent Events so the reply
    renders as it's generated instead of after a several-second wait.

    Events are `{"type": "delta"|"done"|"error", ...}`. The turn is prepared
    before the response starts so a bad session can still 404 normally; once
    streaming begins, failures arrive as an error event.
    """
    metrics = _TurnMetrics(streamed=True)
    turn = await _prepare_turn(session_id, body, uid)
    # Filled in once the turn is complete; read by the background task below.
    finished: dict = {}

    async def events():
        transition = None
        quick_replies: list = []
        sources: list = []
        try:
            if turn.fix_text:
                ai_text = await _fix_reply(turn.msgs, turn.fix_text, turn.owner_uid)
                yield _sse({"type": "delta", "text": ai_text})
            elif aoai:
                rc = await _reply_context(turn, body, metrics)
                system_prompt, history_window = _plan_prompt(rc)
                reply = None
                async for kind, value in _nuri_reply_stream(
                    turn.msgs, rc.card, rc.memory, rc.profile, rc.style,
                    rc.internal, rc.sources, metrics, system_prompt, history_window,
                ):
                    if kind == "delta":
                        yield _sse({"type": "delta", "text": value})
                    else:
                        reply = value
                reply = reply or dict(_NURI_FALLBACK)
                ai_text = reply["text"]
                quick_replies = reply.get("quick_replies", [])
                sources = _cited_sources(reply.get("cited"), rc.search_results, metrics)
                # The primary reply normally already carries proposals. If it
                # does not, the fallback call still runs only after the text is
                # visible, so it cannot delay the parent's first token.
                transition = await _task_suggestion(
                    reply, turn.msgs, body.text or "", ai_text, metrics,
                    allow=rc.plan.allow_task_cards if rc.plan else True,
                )
                finished["rc"] = rc
            else:
                ai_text, quick_replies, transition = await _scripted_reply(
                    turn.session, session_id
                )
                yield _sse({"type": "delta", "text": ai_text})

            ai_msg = await _persist_ai_turn(session_id, turn, ai_text, quick_replies, transition, sources)
            yield _sse({
                "type": "done",
                "user_message": turn.user_msg,
                "ai_messages": [ai_msg],
            })

            if aoai and not turn.fix_text:
                finished["metrics_reply"] = ai_text
            if oai and turn.owner_uid:
                finished["memory_args"] = (turn.msgs + [ai_msg], turn.owner_uid, session_id)
        except Exception as e:
            print(f"[error] post_message_stream failed: {type(e).__name__}: {e}")
            metrics.set(status="error", error=f"{type(e).__name__}: {e}"[:500])
            finished["metrics_reply"] = ""
            yield _sse({"type": "error", "message": "AI 暂时无法回应，请稍后再试。"})

    async def after_stream():
        """Runs after the stream closes. Starlette awaits this, so it still
        completes on hosts that freeze the process once a response is done —
        which a bare asyncio task would not survive."""
        reply_text = finished.get("metrics_reply")
        if reply_text is not None:
            await metrics.flush(
                session_id=session_id, user_id=turn.owner_uid, reply_text=reply_text,
            )
        rc = finished.get("rc")
        if rc is not None:
            await _after_turn(rc, turn, session_id)
        args = finished.get("memory_args")
        if args:
            await _extract_and_upsert_memories(*args)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        background=BackgroundTask(after_stream),
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Tells nginx-style proxies not to buffer, which would defeat streaming.
            "X-Accel-Buffering": "no",
        },
    )

# ── Tasks ─────────────────────────────────────────────────────────────────────
@api.get("/tasks")
async def list_tasks(scope: Optional[str] = None, uid: str = Depends(_req_uid)):
    sb = _get_supabase()
    if sb and uid:
        try:
            q = sb.table("tasks").select("*").eq("user_id", uid)
            if scope in ("today", "week"):
                q = q.eq("scope", scope)
            res = await anyio.to_thread.run_sync(
                lambda: q.order("created_at", desc=True).execute()
            )
            return res.data or []
        except Exception as e:
            print(f"[warn] list_tasks error: {e}")
    tasks = [t for t in _tasks if t.get("user_id") == uid]
    if scope in ("today", "week"):
        tasks = [t for t in tasks if t["scope"] == scope]
    return sorted(tasks, key=lambda t: t["created_at"], reverse=True)

@api.post("/tasks", status_code=201)
async def create_task(body: TaskCreate, uid: str = Depends(_req_uid)):
    due = date.today() + timedelta(days=0 if body.scope == "today" else 7)
    is_suggestion = (
        body.source_message_id is not None and body.suggestion_index is not None
    )
    source = (
        f"NURI 对话:{body.source_message_id}:{body.suggestion_index}"
        if is_suggestion else "手动添加"
    )
    task_id = (
        str(uuid.uuid5(uuid.NAMESPACE_URL, f"nuri-task:{uid}:{source}"))
        if is_suggestion else str(uuid.uuid4())
    )
    task = {
        "id": task_id, "title": body.title, "scope": body.scope,
        "source": source, "done": False, "progress_done": 0,
        "progress_total": 7 if body.scope == "week" else 1,
        "reflection": None, "created_at": _now(), "completed_at": None,
        "task_type": body.task_type or "interaction",
        "description": body.description or "",
        "steps": body.steps or [],
        "due_date": body.due_date or due.isoformat(),
        "is_favorited": False,
        "backfilled": False,
    }
    task["user_id"] = uid
    sb = _get_supabase()
    if sb:
        def find_existing():
            return (
                sb.table("tasks").select("*")
                .eq("id", task_id).eq("user_id", uid).limit(1).execute()
            )

        if is_suggestion:
            try:
                existing = await anyio.to_thread.run_sync(find_existing)
                if existing.data:
                    return existing.data[0]
            except Exception as e:
                print(f"[warn] create_task idempotency lookup error: {e}")
        try:
            await anyio.to_thread.run_sync(lambda: sb.table("tasks").insert(task).execute())
            return task
        except Exception as e:
            # A concurrent retry can lose the insert race against the same
            # deterministic proposal ID. Return the winning row, not an error.
            if is_suggestion:
                try:
                    existing = await anyio.to_thread.run_sync(find_existing)
                    if existing.data:
                        return existing.data[0]
                except Exception as lookup_error:
                    print(f"[warn] create_task retry lookup error: {lookup_error}")
            print(f"[warn] create_task insert error: {e}")
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Task could not be saved",
            ) from e
    if is_suggestion:
        existing = next((item for item in _tasks if item["id"] == task_id), None)
        if existing:
            return existing
    _tasks.append(task)
    return task

@api.patch("/tasks/{task_id}")
async def update_task(
    task_id: str, body: TaskUpdate, background_tasks: BackgroundTasks,
    uid: Optional[str] = Depends(_opt_uid),
):
    sb = _get_supabase()
    if sb and uid:
        try:
            tr = await anyio.to_thread.run_sync(
                lambda: sb.table("tasks").select("*").eq("id", task_id).eq("user_id", uid).execute()
            )
            if not tr.data:
                raise HTTPException(404, "task not found")
            t = tr.data[0]
            updates: dict = {}
            if body.done is not None:
                updates["done"] = body.done
                updates["completed_at"] = _now() if body.done else None
                if body.done and t.get("scope") == "week":
                    updates["progress_done"] = min(t.get("progress_total", 7), t.get("progress_done", 0) + 1)
            if body.mood is not None or body.note is not None:
                prev = t.get("reflection") or {}
                updates["reflection"] = {
                    "mood": body.mood or prev.get("mood"),
                    "note": body.note or prev.get("note", ""),
                }
            if body.is_favorited is not None:
                updates["is_favorited"] = body.is_favorited
            if body.backfilled is not None:
                updates["backfilled"] = body.backfilled
            if updates:
                res = await anyio.to_thread.run_sync(
                    lambda: sb.table("tasks").update(updates).eq("id", task_id).execute()
                )
                result = res.data[0] if res.data else {**t, **updates}
                if oai and body.note:
                    reflection_text = f"任务「{t.get('title', '')}」的反馈：{body.note}"
                    background_tasks.add_task(
                        _extract_and_upsert_memories,
                        [{"role": "user", "text": reflection_text}], uid, task_id, "task_reflection",
                    )
                return result
            return t
        except HTTPException:
            raise
        except Exception as e:
            print(f"[warn] update_task error: {e}")
    for t in _tasks:
        if t["id"] != task_id:
            continue
        if body.done is not None:
            t["done"] = body.done
            if body.done:
                t["completed_at"] = _now()
                if t["scope"] == "week":
                    t["progress_done"] = min(t["progress_total"], t["progress_done"] + 1)
            else:
                t["completed_at"] = None
        if body.mood is not None or body.note is not None:
            prev = t.get("reflection") or {}
            t["reflection"] = {"mood": body.mood or prev.get("mood"), "note": body.note or prev.get("note", "")}
        if body.is_favorited is not None:
            t["is_favorited"] = body.is_favorited
        if body.backfilled is not None:
            t["backfilled"] = body.backfilled
        return t
    raise HTTPException(404, "task not found")

@api.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: str, uid: Optional[str] = Depends(_opt_uid)):
    sb = _get_supabase()
    if sb and uid:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("tasks").delete().eq("id", task_id).eq("user_id", uid).execute()
            )
            return
        except Exception as e:
            print(f"[warn] delete_task error: {e}")
    global _tasks
    _tasks = [t for t in _tasks if t["id"] != task_id]

@api.post("/tasks/clear-completed")
async def clear_completed_tasks(uid: Optional[str] = Depends(_opt_uid)):
    """Delete completed, non-favorited tasks. Favorited tasks are kept."""
    sb = _get_supabase()
    if sb and uid:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("tasks").delete()
                .eq("user_id", uid).eq("done", True).eq("is_favorited", False)
                .execute()
            )
            return {"ok": True}
        except Exception as e:
            print(f"[warn] clear_completed_tasks error: {e}")
    global _tasks
    _tasks = [
        t for t in _tasks
        if not (t.get("user_id", uid) == uid and t.get("done") and not t.get("is_favorited"))
    ]
    return {"ok": True}

@api.get("/tasks/insights")
async def task_insights(uid: Optional[str] = Depends(_opt_uid)):
    sb = _get_supabase()
    source: list = _tasks
    if sb and uid:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("tasks").select("done,scope,progress_done,completed_at").eq("user_id", uid).execute()
            )
            source = res.data or []
        except Exception as e:
            print(f"[warn] task_insights error: {e}")
    completed = [t for t in source if t.get("done")]
    today = datetime.now(timezone.utc).date()
    done_dates: set = set()
    for t in completed:
        ts = t.get("completed_at")
        if ts:
            try:
                done_dates.add(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).date())
            except Exception:
                pass
    streak = 0
    for i in range(7):
        if (today - timedelta(days=i)) in done_dates:
            streak += 1
        elif i > 0:
            break
    return {
        "total_completed": len(completed),
        "streak_days": streak,
        "weekly_progress": sum(t.get("progress_done", 0) for t in source if t.get("scope") == "week"),
    }

# ── Privacy ───────────────────────────────────────────────────────────────────
@api.get("/privacy")
async def get_privacy(uid: Optional[str] = Depends(_opt_uid)):
    settings = await _db_get_privacy(uid, fail_closed=bool(uid))
    if settings.get(_PRIVACY_STORAGE_UNAVAILABLE):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Privacy settings are temporarily unavailable",
        )
    return _normalized_privacy_settings(settings)

@api.put("/privacy")
async def update_privacy(body: PrivacySettings, uid: Optional[str] = Depends(_opt_uid)):
    settings = await _db_set_privacy(uid, body.model_dump())
    if uid and settings.get("allow_history_training") is False:
        await _db_delete_recommendation_snapshots(uid)
        await _db_delete_recommendation_events(uid)
    return settings

@api.post("/privacy/wipe")
async def wipe_all(uid: Optional[str] = Depends(_opt_uid)):
    global _children, _tasks
    if uid:
        # Keep an explicit opt-out tombstone instead of deleting the privacy
        # row.  If any later deletion fails, history must remain disabled rather
        # than falling back to the default-on setting while user data survives.
        await _db_set_privacy(
            uid,
            {
                "allow_history_training": False,
                "allow_external_content_research": False,
                "daily_push": False,
                "anonymous_community_share": False,
                "language": "zh-CN",
            },
        )
        await _db_delete_recommendation_snapshots(uid)
        await _db_delete_recommendation_events(uid)
        _children = [c for c in _children if c.get("user_id") != uid]
        _tasks    = [t for t in _tasks    if t.get("user_id") != uid]
        for sid in [s for s, d in _sessions.items() if d.get("user_id") == uid]:
            _sessions.pop(sid, None); _messages.pop(sid, None)
        _favorites.pop(uid, None)
    else:
        _children.clear(); _tasks.clear()
        _sessions.clear(); _messages.clear()
        _favorites.clear(); _analytics.clear(); _privacy.clear()
        _recommendation_snapshots.clear()
        _recommendation_events.clear(); _recommendation_event_locks.clear()
    return {"ok": True}

# ── Mount /api router ─────────────────────────────────────────────────────────
app.include_router(api)

# ── Legacy RAG routes: static & health ─────────────────────────────────────────
@app.get("/")
async def root():
    index = FRONTEND_DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    return {"msg": "Family Growth Radar backend", "endpoints": ["/api", "/health", "/index", "/ask", "/docs"]}

@app.get("/health")
async def health():
    return {
        "ok": True,
        "supabase": bool(_SUPABASE_OK and SUPABASE_URL and SUPABASE_KEY),
        "vector_store": "supabase",
        "openai": oai is not None,
        # Which turn pipeline this deployment is actually running. The A/B is
        # driven by an env var, so "which one is prod on right now" has to be
        # answerable without reading the Vercel dashboard.
        "pipeline": NURI_PIPELINE,
        "pipeline_version": PIPELINE_VERSION if NURI_PIPELINE == "four_model" else "",
    }

# ── RAG helper functions ───────────────────────────────────────────────────────
# The vector stores and the embedding/chunking behind them now live in
# backend/nuri_core/knowledge_store.py. Aliased for the /index, /ask and
# /admin/books routes below, which still call them by their old names.
_read_pdf = core_knowledge_store.read_pdf
_chunk_text = core_knowledge_store.chunk_text
_embed_batch = core_knowledge_store.embed_batch
_embed_one = core_knowledge_store.embed_one
_is_indexed = core_knowledge_store.is_indexed
_upsert_doc = core_knowledge_store.upsert_doc
_retrieve = core_knowledge_store.retrieve
_retrieve_internal = core_knowledge_store.retrieve_internal
_internal_rules_ctx = core_knowledge_store.internal_rules_ctx


def _generate_rag_answer(question: str, chunks: List[str], book_name: Optional[str] = None) -> str:
    """Answer a /ask question from retrieved book chunks, in NURI's voice.

    Stays here rather than in knowledge_store because of the persona: this
    writes prose as NURI, which makes it the dialogue model's business, and a
    retrieval module that imports a persona is the tangle this split exists to
    undo. It belongs beside the other reply calls.
    """
    context = "\n\n".join(f"[Chunk {i+1}]\n{c}" for i, c in enumerate(chunks))
    citation = ('\n在回答結束時，另起一行，僅引用上方參考文獻中明確出現的理論或概念名稱，格式為：參考自「[文獻中出現的理論或概念名稱]」理論。若文獻未明確提及任何理論名稱，則省略此行。'
                if book_name else "")
    internal_ctx = _internal_rules_ctx(question)
    system = (NURI_PERSONA
              + "\n\n以下是本次對話的參考文獻節錄，可作為輔助依據。NURI 應優先運用自身的兒童發展與育兒專業知識作答，文獻內容僅供參考補充。無論文獻是否涵蓋問題，都請盡力提供有幫助的回應，避免直接回答「我不知道」或「抱歉，我無法回答」。\n"
              + citation)
    if internal_ctx:
        system += f"\n\n{internal_ctx}"
    resp = oai.chat.completions.create(
        model="gpt-5.5",
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": f"問題：{question}\n\n參考文獻：\n{context}"}],
    )
    return resp.choices[0].message.content

# ── Legacy RAG routes: PDF ingest & ask ────────────────────────────────────────
@app.post("/index")
async def index_pdf(file: UploadFile = File(...)):
    if not _get_supabase():
        raise HTTPException(503, "Supabase not configured")
    if not oai:
        raise HTTPException(503, "OpenAI not configured")
    pdf_bytes = await file.read()
    doc_id = hashlib.sha1(pdf_bytes).hexdigest()[:12]
    already, total = await anyio.to_thread.run_sync(_is_indexed, doc_id)
    if already:
        return {"doc_id": doc_id, "total_chunks": total, "namespace": VECTOR_NAMESPACE, "already_indexed": True}
    text   = await anyio.to_thread.run_sync(_read_pdf, pdf_bytes)
    chunks = await anyio.to_thread.run_sync(_chunk_text, text)
    total  = await anyio.to_thread.run_sync(_upsert_doc, doc_id, chunks)
    return {"doc_id": doc_id, "total_chunks": total, "namespace": VECTOR_NAMESPACE, "already_indexed": False}

@api.post("/index-from-url")
async def index_from_url(req: IndexFromUrlRequest):
    """Index a PDF fetched from a URL (e.g. Supabase Storage). Bypasses Vercel 4.5MB payload limit."""
    if not _get_supabase():
        raise HTTPException(503, "Supabase not configured")
    if not oai:
        raise HTTPException(503, "OpenAI not configured")
    import urllib.request
    with urllib.request.urlopen(req.url) as r:
        pdf_bytes = r.read()
    doc_id = hashlib.sha1(pdf_bytes).hexdigest()[:12]
    already, total = await anyio.to_thread.run_sync(_is_indexed, doc_id)
    if already:
        return {"doc_id": doc_id, "total_chunks": total, "namespace": VECTOR_NAMESPACE, "already_indexed": True}
    text   = await anyio.to_thread.run_sync(_read_pdf, pdf_bytes)
    chunks = await anyio.to_thread.run_sync(_chunk_text, text)
    total  = await anyio.to_thread.run_sync(_upsert_doc, doc_id, chunks)
    return {"doc_id": doc_id, "total_chunks": total, "namespace": VECTOR_NAMESPACE, "already_indexed": False}

@app.post("/ask")
async def ask(req: AskRequest):
    if not _get_supabase():
        raise HTTPException(503, "Supabase not configured")
    if not oai:
        raise HTTPException(503, "OpenAI not configured")
    chunks, scores = await anyio.to_thread.run_sync(_retrieve, req.question, req.top_k, req.doc_id)
    answer = await anyio.to_thread.run_sync(_generate_rag_answer, req.question, chunks, req.book_name)
    return {"answer": answer, "chunks": chunks, "scores": scores}

# ── Admin endpoints ───────────────────────────────────────────────────────────

@app.get("/admin/books")
async def admin_list_books(_: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    res = sb.table("books").select("*").order("created_at", desc=True).execute()
    return {"books": getattr(res, "data", None) or []}

@app.post("/admin/books")
async def admin_upsert_book(meta: BookMeta, _: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    row: dict = {"doc_id": meta.doc_id, "title": meta.title, "enabled": True}
    if meta.category is not None:
        row["category"] = meta.category
    if meta.chunk_count is not None:
        row["chunk_count"] = meta.chunk_count
    sb.table("books").upsert(row, on_conflict="doc_id").execute()
    return {"ok": True}

@app.patch("/admin/books/{doc_id}")
async def admin_update_book(doc_id: str, update: BookUpdate, _: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    patch = {k: v for k, v in update.dict().items() if v is not None}
    if not patch:
        raise HTTPException(400, "Nothing to update")
    sb.table("books").update(patch).eq("doc_id", doc_id).execute()
    return {"ok": True}

@app.delete("/admin/books/{doc_id}")
async def admin_delete_book(doc_id: str, _: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    sb.table("books").delete().eq("doc_id", doc_id).execute()
    return {"ok": True}

# NURI 的"规则文档"：由 #fix 聊天指令自动写入，也可以在这里直接管理。
# 每次生成回复都会把 active=true 的规则整段注入 system prompt（见
# _get_style_rules_ctx / _nuri_reply_sync）。
@app.get("/admin/style-rules")
async def admin_list_style_rules(_: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    res = sb.table("nuri_style_rules").select("*").order("created_at", desc=True).execute()
    return {"rules": getattr(res, "data", None) or []}

@app.post("/admin/style-rules", status_code=201)
async def admin_create_style_rule(body: StyleRuleCreate, _: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    row = {
        "id": str(uuid.uuid4()), "rule": body.rule, "category": body.category,
        "source_note": body.source_note, "active": True, "created_by": "admin",
    }
    sb.table("nuri_style_rules").insert(row).execute()
    return row

@app.patch("/admin/style-rules/{rule_id}")
async def admin_update_style_rule(rule_id: str, update: StyleRuleUpdate, _: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    patch = {k: v for k, v in update.dict().items() if v is not None}
    if not patch:
        raise HTTPException(400, "Nothing to update")
    patch["updated_at"] = _now()
    sb.table("nuri_style_rules").update(patch).eq("id", rule_id).execute()
    return {"ok": True}

@app.delete("/admin/style-rules/{rule_id}")
async def admin_delete_style_rule(rule_id: str, _: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    sb.table("nuri_style_rules").delete().eq("id", rule_id).execute()
    return {"ok": True}

# 允许使用聊天里 "#fix" 指令的账号白名单，见 _is_fix_reviewer。
@app.get("/admin/fix-reviewers")
async def admin_list_fix_reviewers(_: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    res = sb.table("fix_reviewers").select("user_id,added_at").order("added_at", desc=True).execute()
    rows = res.data or []
    if not rows:
        return {"reviewers": []}
    uids = [r["user_id"] for r in rows]
    ures = sb.table("users").select("id,email,nickname").in_("id", uids).execute()
    umap = {u["id"]: u for u in (ures.data or [])}
    return {"reviewers": [
        {**r, "email": umap.get(r["user_id"], {}).get("email"), "nickname": umap.get(r["user_id"], {}).get("nickname")}
        for r in rows
    ]}

@app.post("/admin/fix-reviewers", status_code=201)
async def admin_add_fix_reviewer(body: FixReviewerAdd, _: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    ur = sb.table("users").select("id,email,nickname").eq("email", body.email.lower()).maybe_single().execute()
    if not ur.data:
        raise HTTPException(404, "找不到这个邮箱对应的账号")
    uid = ur.data["id"]
    sb.table("fix_reviewers").upsert({"user_id": uid}).execute()
    return {"user_id": uid, "email": ur.data["email"], "nickname": ur.data.get("nickname")}

@app.delete("/admin/fix-reviewers/{user_id}")
async def admin_remove_fix_reviewer(user_id: str, _: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    sb.table("fix_reviewers").delete().eq("user_id", user_id).execute()
    return {"ok": True}

@app.get("/admin/memories")
async def admin_list_memories(
    user_id: str, status: Optional[str] = None, category: Optional[str] = None,
    limit: int = 50, _: None = Depends(_require_admin),
):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    q = sb.table("user_memories").select("*").eq("user_id", user_id)
    if status:
        q = q.eq("status", status)
    if category:
        q = q.eq("category", category)
    res = q.order("updated_at", desc=True).limit(limit).execute()
    return {"memories": getattr(res, "data", None) or []}

# ── Chat turn logs (performance monitoring) ──────────────────────────────────
# Named turn-logs, not logs: vercel.json routes /admin/logs to the SPA page that
# reads these, so the two must not share a path.

def _percentile(values: list[int], pct: float) -> Optional[int]:
    """Nearest-rank percentile. Small samples here, so no interpolation."""
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round(pct / 100 * (len(ordered) - 1))))
    return ordered[idx]


@app.get("/admin/turn-logs")
async def admin_list_turn_logs(
    user_id: Optional[str] = None, status: Optional[str] = None,
    limit: int = 50, offset: int = 0, _: None = Depends(_require_admin),
):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    def _query():
        q = sb.table("chat_turn_logs").select("*", count="exact")
        if user_id:
            q = q.eq("user_id", user_id)
        if status:
            q = q.eq("status", status)
        # One extra beyond the page so the client knows there's a next page
        # without needing the count to be exact.
        return q.order("created_at", desc=True).range(offset, offset + limit).execute()

    try:
        res = await anyio.to_thread.run_sync(_query)
    except Exception as e:
        raise HTTPException(503, f"turn logs unavailable: {e}")
    rows = getattr(res, "data", None) or []
    return {
        "logs": rows[:limit],
        "has_more": len(rows) > limit,
        "total": getattr(res, "count", None),
        "offset": offset,
        "limit": limit,
    }


@app.get("/admin/turn-logs/summary")
async def admin_turn_logs_summary(
    user_id: Optional[str] = None, days: int = 7, sample: int = 1000,
    _: None = Depends(_require_admin),
):
    """Aggregate recent turns. Computed in Python over a bounded sample rather
    than in SQL, so it needs no extra database views to stay in sync."""
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    days = max(1, min(days, 90))
    sample = max(1, min(sample, 5000))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    def _query():
        q = sb.table("chat_turn_logs").select(
            "total_ms,model_ms,context_ms,first_token_ms,tasks_ms,reply_chars,"
            "prompt_tokens,completion_tokens,history_msgs,history_chars,system_chars,"
            "status,streamed,suggested_tasks,created_at"
        ).gte("created_at", since)
        if user_id:
            q = q.eq("user_id", user_id)
        return q.order("created_at", desc=True).limit(sample).execute()

    try:
        res = await anyio.to_thread.run_sync(_query)
    except Exception as e:
        raise HTTPException(503, f"turn logs unavailable: {e}")
    rows = getattr(res, "data", None) or []

    def nums(field: str) -> list[int]:
        return [r[field] for r in rows if isinstance(r.get(field), (int, float))]

    def stats(field: str) -> dict:
        vals = nums(field)
        return {
            "count": len(vals),
            "avg": round(sum(vals) / len(vals)) if vals else None,
            "p50": _percentile(vals, 50),
            "p95": _percentile(vals, 95),
            "max": max(vals) if vals else None,
        }

    total = len(rows)
    return {
        "window_days": days,
        "turns": total,
        "streamed": sum(1 for r in rows if r.get("streamed")),
        "failed": sum(1 for r in rows if r.get("status") != "ok"),
        "suggested_tasks": sum(1 for r in rows if r.get("suggested_tasks")),
        "latency_ms": {
            "total": stats("total_ms"),
            "model": stats("model_ms"),
            "context": stats("context_ms"),
            "first_token": stats("first_token_ms"),
            "tasks": stats("tasks_ms"),
        },
        "length": {
            "reply_chars": stats("reply_chars"),
            "history_msgs": stats("history_msgs"),
            "history_chars": stats("history_chars"),
            "system_chars": stats("system_chars"),
        },
        "tokens": {
            "prompt": stats("prompt_tokens"),
            "completion": stats("completion_tokens"),
        },
    }


# ── Account administration ───────────────────────────────────────────────────

@app.get("/admin/accounts")
async def admin_list_accounts(
    q: Optional[str] = None, limit: int = 50, offset: int = 0,
    _: None = Depends(_require_admin),
):
    """Search accounts by email or nickname, with per-account activity counts so
    a test account can be told apart from a real one before deleting it."""
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    def _query():
        sel = sb.table("users").select(
            "id,email,nickname,city,parent_role,top_concerns,onboarding_completed,created_at",
            count="exact",
        )
        if q:
            safe = q.replace(",", " ").replace("*", " ").strip()
            if safe:
                sel = sel.or_(f"email.ilike.%{safe}%,nickname.ilike.%{safe}%")
        return sel.order("created_at", desc=True).range(offset, offset + limit).execute()

    try:
        res = await anyio.to_thread.run_sync(_query)
    except Exception as e:
        raise HTTPException(503, f"accounts unavailable: {e}")
    rows = getattr(res, "data", None) or []
    page = rows[:limit]

    async def _counts(uid: str) -> dict:
        async def one(table: str) -> int:
            try:
                r = await anyio.to_thread.run_sync(
                    lambda: sb.table(table).select("id", count="exact")
                    .eq("user_id", uid).limit(1).execute()
                )
                return getattr(r, "count", None) or 0
            except Exception:
                return 0
        children, sessions, turns = await asyncio.gather(
            one("children"), one("chat_sessions"), one("chat_turn_logs")
        )
        return {"children": children, "sessions": sessions, "turns": turns}

    if page:
        counts = await asyncio.gather(*(_counts(r["id"]) for r in page))
        for row, c in zip(page, counts):
            row.update(c)
    return {
        "accounts": page,
        "has_more": len(rows) > limit,
        "total": getattr(res, "count", None),
        "offset": offset,
        "limit": limit,
    }


@app.delete("/admin/accounts/{user_id}")
async def admin_delete_account(user_id: str, _: None = Depends(_require_admin)):
    """Delete an account and everything belonging to it.

    Foreign keys cascade users -> chat_sessions -> chat_messages, and cover
    children, tasks, normalized_inputs, user_memories, email_logs and
    chat_turn_logs, so this single delete leaves nothing behind. It is not
    recoverable — the caller is responsible for confirming intent.
    """
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    try:
        found = await anyio.to_thread.run_sync(
            lambda: sb.table("users").select("id,email").eq("id", user_id).execute()
        )
    except Exception as e:
        raise HTTPException(503, f"lookup failed: {e}")
    rows = getattr(found, "data", None) or []
    if not rows:
        raise HTTPException(404, "account not found")
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("users").delete().eq("id", user_id).execute()
        )
    except Exception as e:
        print(f"[error] admin_delete_account {user_id}: {e}")
        raise HTTPException(500, "delete failed")
    print(f"[admin] deleted account {user_id} <{rows[0].get('email')}>")
    return {"deleted": user_id, "email": rows[0].get("email")}


@app.get("/admin/settings")
async def admin_get_settings(_: None = Depends(_require_admin)):
    return {"feed_gen_mode": await _db_get_feed_mode()}

@app.put("/admin/settings")
async def admin_update_settings(body: FeedModeUpdate, _: None = Depends(_require_admin)):
    await _db_set_feed_mode(body.mode)
    return {"feed_gen_mode": body.mode}

@app.get("/admin/discover")
async def admin_discover(_: None = Depends(_require_admin)):
    """Return doc_ids present in rag_chunks but not yet in books table."""
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    chunks_res = sb.rpc("distinct_chunk_doc_ids", {"p_namespace": VECTOR_NAMESPACE}).execute()
    all_chunks = {r["doc_id"]: r["chunk_count"] for r in (getattr(chunks_res, "data", None) or [])}
    books_res = sb.table("books").select("doc_id").execute()
    registered = {r["doc_id"] for r in (getattr(books_res, "data", None) or [])}
    unregistered = [
        {"doc_id": doc_id, "chunk_count": count}
        for doc_id, count in all_chunks.items()
        if doc_id not in registered
    ]
    return {"unregistered": unregistered}

# ── Daily email push admin endpoints ─────────────────────────────────────────

@app.get("/admin/daily-push")
async def admin_get_daily_push(_: None = Depends(_require_admin)):
    sb = _get_supabase()
    enabled = False
    last_sent = None
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings")
                .select("key,value")
                .in_("key", ["daily_push_enabled", "daily_push_last_sent"])
                .execute()
            )
            for row in (res.data or []):
                if row["key"] == "daily_push_enabled":
                    enabled = str(row["value"]).lower() == "true"
                elif row["key"] == "daily_push_last_sent":
                    last_sent = row["value"]
        except Exception as e:
            print(f"[warn] admin_get_daily_push: {e}")
    return {
        "enabled": enabled,
        "last_sent": last_sent,
        "smtp_configured": bool(SMTP_USER and SMTP_PASSWORD),
    }

@app.put("/admin/daily-push")
async def admin_set_daily_push(body: DailyPushToggle, _: None = Depends(_require_admin)):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Database not configured")
    await anyio.to_thread.run_sync(
        lambda: sb.table("app_settings").upsert(
            {"key": "daily_push_enabled", "value": str(body.enabled).lower(), "updated_at": _now()},
            on_conflict="key",
        ).execute()
    )
    return {"enabled": body.enabled}

@app.post("/admin/daily-push/trigger")
async def admin_trigger_daily_push(_: None = Depends(_require_admin)):
    if not SMTP_USER or not SMTP_PASSWORD:
        raise HTTPException(400, "SMTP 未配置，请先在服务器环境变量中设置 SMTP_USER / SMTP_PASSWORD")
    if not oai:
        raise HTTPException(503, "OpenAI 未配置，无法生成个性化卡片")
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Database not configured")

    users_res = await anyio.to_thread.run_sync(
        # daily_push is the parent's own setting on the profile screen. It was
        # never consulted here, so anyone who turned "接收每日推送提醒" off kept
        # receiving mail — and unprompted check-ins make that worse, not better.
        # `neq false` rather than `eq true` so rows predating
        # privacy_settings_migration.sql (null) keep their previous behaviour
        # instead of everyone silently going quiet on deploy.
        lambda: sb.table("users").select("id,email,nickname,top_concerns")
        .neq("daily_push", False).execute()
    )
    users = users_res.data or []
    if not users:
        return {"sent": 0, "failed": 0, "errors": [], "message": "没有注册用户"}

    sent, failed, errors = 0, 0, []
    _concern_kw = {
        "sleep": "婴幼儿睡眠", "food": "宝宝辅食", "emotion": "儿童情绪管理",
        "development": "儿童发展", "parenting": "正向教养", "health": "儿童健康",
        "childcare": "托育与幼儿园", "family": "家庭教养观念",
    }

    for user in users:
        uid = user["id"]
        try:
            # A due follow-up outranks the generic card: being asked "9/1 托嬰
            # 適應得如何" is worth more to a parent than any article. One family
            # gets at most one per day, because the push runs daily and this
            # takes only the single oldest item — five things due at once is a
            # to-do list, not someone remembering to ask after you.
            follow_up = await _take_due_follow_up(uid)
            if follow_up:
                nickname = user.get("nickname") or "家长"
                text = await _compose_follow_up_message(nickname, follow_up)
                if text:
                    await anyio.to_thread.run_sync(
                        lambda _to=user["email"], _b=text:
                        _send_email_smtp(_to, f"NURI 想问问你 | {follow_up['topic']}", _b)
                    )
                    await _mark_follow_up_asked(follow_up["id"])
                    sent += 1
                    continue
                # Composing failed: leave it pending for tomorrow and fall
                # through to the card rather than sending nothing at all.

            # 1. Collect recent user messages from the last 5 sessions
            sessions_res = await anyio.to_thread.run_sync(
                lambda _uid=uid: sb.table("chat_sessions")
                .select("id")
                .eq("user_id", _uid)
                .order("created_at", desc=True)
                .limit(5)
                .execute()
            )
            session_ids = [s["id"] for s in (sessions_res.data or [])]
            user_texts: list[str] = []
            for sid in session_ids:
                msgs_res = await anyio.to_thread.run_sync(
                    lambda _sid=sid: sb.table("chat_messages")
                    .select("text")
                    .eq("session_id", _sid)
                    .eq("role", "user")
                    .order("created_at", desc=True)
                    .limit(10)
                    .execute()
                )
                user_texts.extend(
                    m["text"] for m in (msgs_res.data or [])
                    if m.get("text") and m["text"] != "[图片]"
                )
                if len(user_texts) >= 20:
                    break

            # 2. Extract keywords from chat history; fall back to user concerns
            keywords: list[str] = []
            if user_texts:
                combined = " ".join(user_texts[:15])
                try:
                    kw_resp = await anyio.to_thread.run_sync(
                        lambda: oai.chat.completions.create(
                            model="gpt-4.1-mini",
                            messages=[{"role": "user", "content":
                                f"从以下育儿对话中提取3-5个关键词（名词短语，用逗号分隔）：\n{combined}\n\n只返回关键词，不要解释。"
                            }],
                            max_completion_tokens=30,
                        )
                    )
                    keywords = [k.strip() for k in kw_resp.choices[0].message.content.split(",") if k.strip()][:5]
                except Exception as e:
                    print(f"[warn] keyword extract {uid}: {e}")

            if not keywords:
                concerns = user.get("top_concerns") or []
                keywords = [_concern_kw[c] for c in concerns if c in _concern_kw][:3]
            if not keywords:
                keywords = ["育儿健康", "儿童发展", "北美华人育儿"]

            # 3. Generate 1 AI card tailored to this user's context
            cards = await anyio.to_thread.run_sync(
                lambda: _gen_feed_cards_sync(keywords, 1)
            )
            if not cards:
                raise ValueError("AI 卡片生成失败")
            card = cards[0]

            # 4. Persist card so /detail/:id works
            await _db_save_gen_cards([card])

            # 5. Build and send email
            preview_src = card.get("body") or card.get("summary", "")
            preview = preview_src[:40].rstrip() + "..." if len(preview_src) > 40 else preview_src
            link = f"{APP_URL}/detail/{card['id']}"
            nickname = user.get("nickname") or "家长"
            subject = f"今日育儿 | {card['title']}"
            email_body = (
                f"{nickname}，你好！\n\n"
                f"{card['title']}\n\n"
                f"{preview}\n\n"
                f"点击查看完整内容并和 AI 深聊：\n{link}\n\n"
                f"---\nFamily Growth Radar · 每日育儿内容"
            )
            await anyio.to_thread.run_sync(
                lambda _to=user["email"], _s=subject, _b=email_body: _send_email_smtp(_to, _s, _b)
            )

            # 6. Log
            log_row = {"user_id": uid, "email": user["email"], "card_id": card["id"], "sent_at": _now()}
            await anyio.to_thread.run_sync(
                lambda _r=log_row: sb.table("email_logs").insert(_r).execute()
            )
            sent += 1
        except Exception as e:
            failed += 1
            errors.append(f"{user.get('email', uid)}: {str(e)[:100]}")
            print(f"[error] daily push {uid}: {e}")

    # Update last_sent timestamp
    try:
        now_str = _now()
        await anyio.to_thread.run_sync(
            lambda: sb.table("app_settings").upsert(
                {"key": "daily_push_last_sent", "value": now_str, "updated_at": now_str},
                on_conflict="key",
            ).execute()
        )
    except Exception as e:
        print(f"[warn] daily_push update last_sent: {e}")

    return {"sent": sent, "failed": failed, "errors": errors[:20]}

# ── Frontend SPA fallback ─────────────────────────────────────────────────────
# Must stay the LAST route registered: Starlette matches routes in registration
# order, and this GET catch-all would otherwise shadow every literal GET route
# defined after it (that's what happened to /health and /admin/* before this).
@app.get("/{full_path:path}", include_in_schema=False)
async def frontend_fallback(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(404, "API route not found")
    candidate = (FRONTEND_DIST / full_path).resolve()
    try:
        candidate.relative_to(FRONTEND_DIST.resolve())
    except ValueError:
        raise HTTPException(404, "Not found")
    if candidate.is_file():
        return FileResponse(candidate)
    index = FRONTEND_DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(404, "Frontend build not found")
