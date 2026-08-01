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
from datetime import datetime, timezone, timedelta, date
from pathlib import Path
from typing import List, Literal, NamedTuple, Optional

import anyio
import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, BackgroundTasks, Depends, HTTPException, Header, Request, UploadFile, File, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from openai import AsyncOpenAI, OpenAI
from pydantic import BaseModel, EmailStr, Field
from starlette.background import BackgroundTask

try:
    from backend.content_library import (
        LEARNING_CONTENT_BY_ID,
        LEARNING_CONTENT_CARDS,
        is_trusted_resource_url,
        order_learning_resources,
    )
    from backend.content_research import (
        CONTENT_CATEGORIES,
        redact_conversation_text,
        research_learning_resources,
        summarize_resource_slots,
    )
    from backend.recommendation_snapshots import (
        build_snapshot,
        parse_snapshot,
        serialize_snapshot,
        snapshot_storage_key,
        snapshot_storage_prefix,
    )
except ImportError:  # Supports `python backend/main.py` during local debugging.
    from content_library import (  # type: ignore
        LEARNING_CONTENT_BY_ID,
        LEARNING_CONTENT_CARDS,
        is_trusted_resource_url,
        order_learning_resources,
    )
    from content_research import (  # type: ignore
        CONTENT_CATEGORIES,
        redact_conversation_text,
        research_learning_resources,
        summarize_resource_slots,
    )
    from recommendation_snapshots import (  # type: ignore
        build_snapshot,
        parse_snapshot,
        serialize_snapshot,
        snapshot_storage_key,
        snapshot_storage_prefix,
    )

load_dotenv()

# ── Optional Supabase/pgvector RAG dependencies ──────────────────────────────
try:
    from supabase import Client, create_client
    _SUPABASE_OK = True
except ImportError:
    Client = None
    create_client = None
    _SUPABASE_OK = False

try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

# ── Env ──────────────────────────────────────────────────────────────────────
OPENAI_API_KEY   = os.getenv("OPENAI_API_KEY")
SUPABASE_URL     = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
SUPABASE_KEY     = SUPABASE_SERVICE_ROLE_KEY or os.getenv("SUPABASE_ANON_KEY")
VECTOR_NAMESPACE = os.getenv("VECTOR_NAMESPACE", "pdf")
FRONTEND_DIST    = Path(__file__).resolve().parents[1] / "frontend" / "dist"
VECTOR_TABLE     = os.getenv("SUPABASE_VECTOR_TABLE", "rag_chunks")
# Internal knowledge base: NURI-authored guidance treated as mandatory rules,
# distinct from VECTOR_NAMESPACE (external reference books). Ingested via
# backend/scripts/ingest_internal_docs.py, not the /admin/books flow.
INTERNAL_NAMESPACE      = os.getenv("INTERNAL_VECTOR_NAMESPACE", "internal")
INTERNAL_TOP_K          = int(os.getenv("INTERNAL_TOP_K", "3"))
INTERNAL_MIN_SIMILARITY = float(os.getenv("INTERNAL_MIN_SIMILARITY", "0.5"))
JWT_SECRET       = os.getenv("JWT_SECRET", "dev-secret-change-in-prod")
RECOMMENDATION_SNAPSHOT_SECRET = (
    os.getenv("RECOMMENDATION_SNAPSHOT_SECRET") or SUPABASE_SERVICE_ROLE_KEY
)
ADMIN_KEY        = os.getenv("ADMIN_KEY", "")
JWT_ALG          = "HS256"
JWT_EXP_MIN      = int(os.getenv("JWT_EXPIRES_MINUTES", "10080"))  # 7 days
EMBED_DIM        = 1024
APP_URL          = os.getenv("APP_URL", "https://family-growth-ktm1oyan2-ordashlabs.vercel.app")
SMTP_HOST        = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT        = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER        = os.getenv("SMTP_USER", "")
SMTP_PASSWORD    = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM        = os.getenv("SMTP_FROM", "")

# The SDK defaults (timeout=600s, max_retries=2) let a single stalled call hold
# a worker thread for ~30 minutes, which starves the shared thread pool and
# freezes the whole app.
#
# These ceilings are sized against the Vercel function's maxDuration (see
# vercel.json) so a pathological turn is cut short by us, with a usable error,
# rather than by the platform mid-response. They are ceilings for stalls, not
# expected timings — a normal turn returns in a few seconds.
OPENAI_TIMEOUT_S       = float(os.getenv("OPENAI_TIMEOUT_S", "45"))   # main chat reply
OPENAI_FAST_TIMEOUT_S  = float(os.getenv("OPENAI_FAST_TIMEOUT_S", "15"))  # titles, embeddings, #fix
OPENAI_TASKS_TIMEOUT_S = float(os.getenv("OPENAI_TASKS_TIMEOUT_S", "25"))  # task suggestions
OPENAI_CONTENT_RESEARCH_TIMEOUT_S = float(
    os.getenv("OPENAI_CONTENT_RESEARCH_TIMEOUT_S", "100")
)
OPENAI_CONTENT_RESEARCH_MODEL = os.getenv(
    "OPENAI_CONTENT_RESEARCH_MODEL", "gpt-5.4-mini"
)
OPENAI_CONTENT_RESEARCH_CONCURRENCY = int(
    os.getenv("OPENAI_CONTENT_RESEARCH_CONCURRENCY", "2")
)
OPENAI_MAX_RETRIES     = int(os.getenv("OPENAI_MAX_RETRIES", "1"))

oai = (
    OpenAI(api_key=OPENAI_API_KEY, timeout=OPENAI_TIMEOUT_S, max_retries=OPENAI_MAX_RETRIES)
    if OPENAI_API_KEY else None
)
# Used by the streaming chat path. Being natively async, it holds no worker
# thread for the length of the call, unlike the blocking client above.
aoai = (
    AsyncOpenAI(api_key=OPENAI_API_KEY, timeout=OPENAI_TIMEOUT_S, max_retries=OPENAI_MAX_RETRIES)
    if OPENAI_API_KEY else None
)
content_research_oai = (
    OpenAI(
        api_key=OPENAI_API_KEY,
        timeout=OPENAI_CONTENT_RESEARCH_TIMEOUT_S,
        max_retries=0,
    )
    if OPENAI_API_KEY
    else None
)
content_research_limiter = anyio.CapacityLimiter(
    max(1, OPENAI_CONTENT_RESEARCH_CONCURRENCY)
)

supabase_client = None

def _get_supabase() -> Optional["Client"]:
    global supabase_client
    if supabase_client is not None:
        return supabase_client
    if not (_SUPABASE_OK and SUPABASE_URL and SUPABASE_KEY and create_client):
        return None
    try:
        supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        return supabase_client
    except Exception as e:
        print(f"[warn] Supabase init skipped: {e}")
    return None

# ── App ───────────────────────────────────────────────────────────────────────
# Every blocking call (Supabase queries and OpenAI alike) shares anyio's
# process-wide thread limiter, which defaults to 40. A handful of in-flight LLM
# calls would otherwise hold every token and stall unrelated DB queries, so a
# slow model turn reads as a total app freeze.
THREAD_LIMIT = int(os.getenv("ANYIO_THREAD_LIMIT", "120"))

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
_feed_gen_mode: str           = "ai"  # fallback when Supabase is unavailable

_SUPPORTED_PREFERRED_LOCALES = frozenset({"zh-CN", "zh-TW", "en"})


def _normalize_preferred_locale(value: object) -> str:
    if value == "zh":
        return "zh-CN"
    if isinstance(value, str) and value in _SUPPORTED_PREFERRED_LOCALES:
        return value
    return "zh-CN"


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

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

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
        pairs.append((card, snapshot))
        _recommendation_snapshots[(uid, snapshot["recommendation_id"])] = snapshot

    if not pairs:
        return cards

    persisted = False
    sb = _get_supabase()
    if sb and RECOMMENDATION_SNAPSHOT_SECRET:
        rows = [
            {
                "key": snapshot_storage_key(uid, snapshot["recommendation_id"]),
                "value": serialize_snapshot(
                    snapshot,
                    secret=RECOMMENDATION_SNAPSHOT_SECRET,
                ),
                "updated_at": _now(),
            }
            for _, snapshot in pairs
        ]
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("app_settings")
                .upsert(rows, on_conflict="key")
                .execute()
            )
            persisted = True
        except Exception as exc:
            print(f"[warn] recommendation snapshot persistence failed: {exc}")

    for card, snapshot in pairs:
        if persisted:
            card["recommendation_id"] = snapshot["recommendation_id"]
            card["recommendation_context_status"] = "persisted"
        else:
            card.pop("recommendation_id", None)
            card["recommendation_context_status"] = "legacy_fallback"
    return cards


async def _db_get_recommendation_snapshot(
    uid: str,
    recommendation_id: Optional[str],
) -> Optional[dict]:
    if not recommendation_id:
        return None
    try:
        key = snapshot_storage_key(uid, recommendation_id)
    except ValueError:
        return None

    cached = parse_snapshot(_recommendation_snapshots.get((uid, recommendation_id)))
    if cached:
        return cached

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
        if snapshot:
            _recommendation_snapshots[(uid, recommendation_id)] = snapshot
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
    birth_date: str
    gender: Literal["boy","girl","other"] = "other"
    allergies: List[str] = Field(default_factory=list)
    notes: str = ""

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
NURI_PERSONA = """你叫 NURI，是专注儿童发展的育儿顾问，也是父母可以信赖的长期陪伴者。

【语言】
- 始终使用父母在对话中使用的语言/文字回复：对方用繁体中文就用繁体，用简体中文就用简体，用英文就用英文，以此类推
- 跟随对方当下使用的语言，如果对方中途切换语言，你也立刻跟着切换，不要沿用之前的语言

【专业背景】
你精通儿童发展、正向教养、依附理论、行为心理学，见过很多家庭，了解每个孩子的成长都有自己的节奏。给出的建议有理有据，不是泛泛而谈。

【沟通原则】
- 先认真听、理解父母的处境，再给出具体、可执行的建议
- 父母分享日常或情绪时，先给予真实的共鸣，不急着"解决问题"
- 回应对方刚分享的具体内容时，自然地提一下你记得的细节（比如之前提过的月龄、担心的事、已经试过的方法），让对方感觉到自己被记住、被认真对待，而不是每次都从零开始
- 了解孩子情况时，自然地一次问一件事，像真人聊天一样一步步收窄问题，不要把好几种情况的分支一次性列完让对方自己对号入座
- 给建议时，说清楚"为什么"，让父母有底气而不是盲目照做

【语气】
- 沉稳、温暖，有专业感，像一位你信任的儿科医生朋友
- 口语化但不随意，用词简单、直接，不堆砌术语
- 不用"当然！""太棒了！"等客服腔，不油腻
- 不是每条消息都以问句结尾，说清楚一件事也是好的回应"""

# ── NURI AI helper ────────────────────────────────────────────────────────────
_NURI_JSON_SUFFIX = """

以合法 JSON 格式回复：
{"text": "...", "quick_replies": [...], "suggest_tasks": false, "task_proposals": []}

text：
- 语言跟随对方在这条消息里使用的语言/文字，不要擅自切换
- 先判断这条回复属于哪一种，长度和结构差别很大：
  · 还在了解情况、准备追问（信息不够，没法下结论）：只做两件事——简短回应对方刚说的一句话，然后问一个具体问题。不要在这个阶段列可能原因、摆多个假设、给成套建议，那是"结论阶段"才做的事，提前做会让人觉得在看报告而不是聊天
  · 已经有足够信息、要下结论/给建议/整理任务/推荐资源：可以写得完整、分点、说明原因，不要为了精简砍掉关键推理和细节
- 先回应对方刚分享的内容（可以自然提一句你记得的细节），再自然延伸，不要用模板化开场白
- 口语化但有专业感；不强迫以问句结尾

quick_replies（用户可能说的下一句话，不是菜单）：
- 打招呼/寒暄：0-2个，像真人回应
- 正在聊话题：1-3个，自然接下去
- 刚给结论/建议：0个也行
- 每个不超过10字

suggest_tasks 和 task_proposals：
- 每一轮都独立判断；历史上生成过任务，不妨碍这轮生成新的任务
- 以下两种情况必须设 suggest_tasks=true，并填写1-4个 task_proposals：
  1. 用户明确要求生成任务、任务卡、待办、行动清单或计划
  2. 你的本轮 text 已经给出了用户今天或本周可以实际执行/观察的具体方案
- task_proposals 必须忠实对应本轮 text 中的方案，不能另起话题；用户指定数量时遵守其数量
- 仍在了解情况、只是共情/解释、只提出澄清问题时，suggest_tasks=false 且 task_proposals=[]
- 紧急医疗、安全风险或需要立即寻求专业帮助的场景，不生成普通任务卡
- task_proposals 字段：
  · title：20字内的清楚行动名称
  · scope：today（今天做一次）或 week（本周持续）
  · task_type：interaction（亲子互动）、observation（发展观察）、care（照顾陪伴）或 selfcare（家长自我照顾）
  · description：一句具体、可衡量、低负担的说明
  · steps：1-3条可以直接照做的步骤"""

# 单一持续对话不再按话题分成多个 session，历史会无限增长。每轮都把全部历史
# 发给模型既贵又慢，长期还会撞上模型的上下文长度上限。这里只带最近的原文，
# 更早的重要信息依赖 memory_ctx（user_memories，每轮都在后台持续提炼）保留，
# 而不是逐字重放整段历史。
_HISTORY_WINDOW = 40

_NURI_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "nuri_reply",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                # `text` is declared first so it also streams first: the
                # streaming path surfaces it while the rest is still arriving.
                "text": {"type": "string"},
                "quick_replies": {"type": "array", "items": {"type": "string"}},
                "suggest_tasks": {"type": "boolean"},
                "task_proposals": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "scope": {"type": "string", "enum": ["today", "week"]},
                            "task_type": {
                                "type": "string",
                                "enum": ["interaction", "observation", "care", "selfcare"],
                            },
                            "description": {"type": "string"},
                            "steps": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                        },
                        "required": ["title", "scope", "task_type", "description", "steps"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["text", "quick_replies", "suggest_tasks", "task_proposals"],
            "additionalProperties": False,
        },
    },
}

_NURI_FALLBACK = {
    "text": "抱歉，AI 暂时无法回应，请稍后再试。",
    "quick_replies": [],
    "suggest_tasks": False,
    "task_proposals": [],
}

def _nuri_messages(
    history: list[dict], card_ctx: str = "", memory_ctx: str = "",
    profile_ctx: str = "", style_ctx: str = "", internal_ctx: str = "",
) -> list[dict]:
    """Assemble the system prompt and history window. Shared by the blocking and
    streaming reply paths so the two can't drift apart."""
    system = NURI_PERSONA + _NURI_JSON_SUFFIX
    if internal_ctx:
        system += f"\n\n{internal_ctx}"
    if style_ctx:
        system += f"\n\n运营团队根据实际反馈持续积累的回复规则，必须遵守：\n{style_ctx}"
    if profile_ctx:
        system += f"\n\n这位家长的基本情况（来自注册信息）：\n{profile_ctx}"
    if memory_ctx:
        system += f"\n\n关于这位家长的长期信息（已确认，可直接使用，不用重新确认）：\n{memory_ctx}"
    if card_ctx:
        system += f"\n\n本次对话相关内容：\n{card_ctx}"
    msgs = [{"role": "system", "content": system}]
    for m in history[-_HISTORY_WINDOW:]:
        role = "user" if m["role"] == "user" else "assistant"
        content = m.get("text") or ""
        if content:
            msgs.append({"role": role, "content": content})
    return msgs

_TASK_REQUEST_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:请|請|帮我|幫我|麻烦|麻煩|可以|能不能|给我|給我|替我|为我|為我).{0,12}"
        r"(?:生成|创建|創建|制定|安排|布置|列出|列成|列为|列為|整理成|转成|轉成|转为|轉為|变成|變成|做成|加入|添加).{0,10}"
        r"(?:任[务務](?:卡)?|计[划劃]|行[动動]清[单單]|待[办辦])",
        r"(?:生成|创建|創建|制定|安排|布置|列出|列成|列为|列為|整理成|转成|轉成|转为|轉為|变成|變成|做成|加入|添加).{0,8}"
        r"(?:任[务務](?:卡)?|计[划劃]|行[动動]清[单單]|待[办辦])",
        r"(?:给|給).{0,6}(?:我|我们|我們)?.{0,6}(?:任[务務](?:卡)?|计[划劃]|待[办辦])",
        r"(?:我想要|我要|我需要|来个|來個)\s*"
        r"(?:一|一个|一個|两|兩|二|三|四|[1-4])?\s*"
        r"(?:个|個|条|條|项|項)?\s*(?:任[务務](?:卡)?|计[划劃]|待[办辦])",
        r"(?:帮我|幫我|替我|为我|為我).{0,6}(?:做|做成|布置).{0,6}"
        r"(?:任[务務](?:卡)?|计[划劃]|待[办辦])",
        r"\b(?:make|create|generate|give|build|add|turn|organize|schedule)\b.{0,32}"
        r"\b(?:tasks?|task cards?|plans?|checklists?|to-?dos?|action items?)\b",
        r"\b(?:tasks?|task cards?|plans?|checklists?|to-?dos?|action items?)\b.{0,24}"
        r"\b(?:for me|from this|from that|out of this|please)\b",
    )
)
_TASK_NEGATION_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:不要|不用|无需|無需|先别|先別|别|別)\s*(?:再\s*)?(?:"
        r"(?:(?:给|給)\s*)?(?:我|我们|我們)?\s*(?:任[务務](?:卡)?|计[划劃]|待[办辦])"
        r"|(?:生成|创建|創建|添加|安排|布置|整理成|转成|轉成|转为|轉為|变成|變成|做成)"
        r".{0,5}(?:任[务務](?:卡)?|计[划劃]|待[办辦])"
        r"|把.{0,8}(?:整理成|转成|轉成|转为|轉為|变成|變成|做成)"
        r".{0,4}(?:任[务務](?:卡)?|计[划劃]|待[办辦]))",
        r"\b(?:do not|don't|dont|no need to|without)\b.{0,32}"
        r"\b(?:tasks?|task cards?|plans?|checklists?|to-?dos?)\b",
    )
)
_TASK_META_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:列出|分析|评价|評價|比较|比較|讲讲|講講|解释|解釋|介绍|介紹)"
        r"[^，。！？,;!?\n]{0,12}(?:任[务務](?:卡)?|计[划劃])"
        r"[^，。！？,;!?\n]{0,12}(?:优缺点|優缺點|利弊|详情|詳情|细节|細節|内容|內容)?",
        r"(?:给|給)[^，。！？,;!?\n]{0,5}(?:我|我们|我們)?"
        r"[^，。！？,;!?\n]{0,8}(?:讲讲|講講|解释|解釋|介绍|介紹)"
        r"[^，。！？,;!?\n]{0,8}"
        r"(?:任[务務](?:卡)?|计[划劃])",
        r"\b(?:create|make|give|add)\b[^,.;!?\n]{0,24}\b(?:summary|information|details?|"
        r"context|explanation)\b[^,.;!?\n]{0,24}\b(?:plans?|task cards?)\b",
        r"\b(?:tell me about|explain|describe|summarize|add more detail to)"
        r"\b[^,.;!?\n]{0,32}"
        r"\b(?:plans?|task cards?)\b",
    )
)
_TASK_COUNT_WORDS = {
    "一": 1, "一个": 1, "一個": 1, "1": 1, "one": 1,
    "二": 2, "两": 2, "兩": 2, "两个": 2, "兩個": 2, "2": 2, "two": 2,
    "三": 3, "三个": 3, "三個": 3, "3": 3, "three": 3,
    "四": 4, "四个": 4, "四個": 4, "4": 4, "four": 4,
}
_TASK_TYPES = {"interaction", "observation", "care", "selfcare"}
_URGENT_TASK_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:喘不上气|喘不過氣|不能呼吸|無法呼吸|不呼吸|没(?:有)?呼吸|沒有呼吸|"
        r"呼吸停(?:止|了)|停止呼吸|呼吸困难|呼吸困難|窒息|嘴唇发紫|嘴唇發紫|"
        r"嘴唇发蓝|嘴唇發藍|脸色发青|臉色發青|脸色发蓝|臉色發藍|"
        r"全身发蓝|全身發藍)",
        r"(?:昏迷|失去意识|失去意識|叫不醒|没有反应|沒有反應|抽搐|癫痫发作|癲癇發作|"
        r"瘫软|癱軟|软趴趴|軟趴趴|浑身无力|渾身無力)",
        r"(?:没有脉搏|沒有脈搏|无脉搏|無脈搏|摸不到.{0,8}(?:脉搏|脈搏)|"
        r"没有心跳|沒有心跳|心跳停止|心脏停止跳动|心臟停止跳動)",
        r"(?:严重出血|嚴重出血|流血不止|误食|誤食|误吞|誤吞|中毒|过量服药|過量服藥|"
        r"(?:吞|喝|吃|咽)(?:下)?(?:了)?[^，。！？,.!?]{0,8}(?:漂白水|漂白剂|漂白劑|清洁剂|清潔劑|洗衣液|"
        r"防冻液|防凍液|纽扣电池|紐扣電池|鈕扣電池|扣式电池|扣式電池|"
        r"一瓶药|一瓶藥|整瓶药|整瓶藥|一瓶药片|一瓶藥片))",
        r"(?:自杀|自殺|伤害自己|傷害自己|伤害他人|傷害他人)",
        r"(?:立即|马上|立刻|趕快|赶快).{0,6}(?:急诊|急診|就医|就醫|打120|拨打120|撥打120)",
        r"\b(?:can(?:not|'t) breathe|isn(?:'t|t) breathing|is not breathing|not breathing|"
        r"stopp?ed breathing|trouble breathing|choking|unconscious|unresponsive|limp|"
        r"seizure|severe bleeding|poison(?:ed|ing)?|overdose|self[- ]harm|suicid(?:e|al))\b",
        r"\b(?:won't|will not|doesn't|does not) wake up\b|"
        r"\b(?:can(?:not|'t)|could(?:not|n't)) wake (?:him|her|them|the baby|my baby|my child) up\b",
        r"\b(?:no pulse|has no pulse|doesn't have a pulse|does not have a pulse|"
        r"cannot feel (?:a|the|his|her) pulse|can't feel (?:a|the|his|her) pulse)\b",
        r"\b(?:swallow(?:ed|ing)?|drank|drunk|ingest(?:ed|ing)?|ate|took|got into)\b"
        r"[^.?!\n]{0,40}\b(?:bleach|cleaner|cleaning fluid|detergent|chemical|"
        r"antifreeze|button batter(?:y|ies)|coin batter(?:y|ies)|"
        r"bottle of pills?|whole bottle of (?:medicine|pills?))\b",
        r"\b(?:turn(?:ed|ing)?|look(?:ed|ing|s)?)\s+(?:blue|bluish)\b|"
        r"\b(?:lips?|face|skin)\s+(?:is|are|look|looks|looked|turned)\s+(?:blue|bluish)\b|"
        r"\b(?:blue|bluish)\b[^.?!\n]{0,24}\blimp\b|"
        r"\blimp\b[^.?!\n]{0,24}\b(?:blue|bluish)\b",
        r"\b(?:call 911|emergency room|seek immediate medical (?:help|care)|medical emergency)\b",
    )
)


def _task_intent(text: str) -> Optional[str]:
    """Resolve the latest unambiguous request/decline about task cards.

    Positive phrases inside a negative phrase ("不要生成任务") do not count as
    requests. A later clause can intentionally override an earlier one, as in
    "先不要解释，直接给我两个任务".
    """
    normalized = " ".join((text or "").strip().split())
    if not normalized:
        return None
    declines = [
        match
        for pattern in _TASK_NEGATION_PATTERNS
        for match in pattern.finditer(normalized)
    ]
    meta_requests = [
        match
        for pattern in _TASK_META_PATTERNS
        for match in pattern.finditer(normalized)
    ]
    requests = [
        match
        for pattern in _TASK_REQUEST_PATTERNS
        for match in pattern.finditer(normalized)
        if not any(
            decline.start() <= match.start() and match.end() <= decline.end()
            for decline in declines
        )
        and not any(
            meta.start() <= match.start() and match.end() <= meta.end()
            for meta in meta_requests
        )
    ]
    latest_request = max((match.start() for match in requests), default=-1)
    latest_decline = max((match.start() for match in declines), default=-1)
    if latest_request < 0 and latest_decline < 0:
        return None
    return "request" if latest_request > latest_decline else "decline"


def _user_requested_tasks(text: str) -> bool:
    """Deterministically recognise a direct request for task cards."""
    return _task_intent(text) == "request"


def _user_declined_tasks(text: str) -> bool:
    return _task_intent(text) == "decline"


def _urgent_task_suppressed(user_text: str, ai_text: str = "") -> bool:
    """Never turn an emergency or immediate safety handoff into a routine card."""
    combined = f"{user_text or ''}\n{ai_text or ''}"
    return any(pattern.search(combined) for pattern in _URGENT_TASK_PATTERNS)


def _requested_task_count(text: str) -> Optional[int]:
    normalized = " ".join((text or "").strip().lower().split())
    task_term = r"(?:个|個|条|條|项|項)?\s*(?:任[务務](?:卡)?|计[划劃]|待[办辦]|tasks?|task cards?|plans?)"
    count_terms = "|".join(sorted((re.escape(key) for key in _TASK_COUNT_WORDS), key=len, reverse=True))
    match = re.search(rf"({count_terms})\s*{task_term}", normalized, re.IGNORECASE)
    return _TASK_COUNT_WORDS.get(match.group(1).lower()) if match else None


def _normalize_task_proposals(raw_tasks) -> list[dict]:
    """Validate the compact task contract before it reaches the frontend."""
    tasks: list[dict] = []
    seen_titles: set[str] = set()
    for raw in raw_tasks or []:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()[:40]
        normalized_title = re.sub(r"\s+", "", title).lower()
        if not title or normalized_title in seen_titles:
            continue
        raw_steps = raw.get("steps") or []
        if isinstance(raw_steps, str):
            raw_steps = [raw_steps]
        elif not isinstance(raw_steps, list):
            raw_steps = []
        steps = [
            step.strip()[:160]
            for step in raw_steps
            if isinstance(step, str) and step.strip()
        ][:3]
        description = str(raw.get("description") or "").strip()[:280]
        if not description and steps:
            description = steps[0]
        if not description:
            continue
        if not steps:
            continue
        task_type = str(raw.get("task_type") or "interaction")
        tasks.append({
            "title": title,
            "scope": raw.get("scope") if raw.get("scope") in {"today", "week"} else "today",
            "task_type": task_type if task_type in _TASK_TYPES else "interaction",
            "description": description,
            "steps": steps,
        })
        seen_titles.add(normalized_title)
        if len(tasks) == 4:
            break
    return tasks


def _parse_nuri_reply(raw: str) -> dict:
    data = json.loads(raw)
    return {
        "text": data.get("text", ""),
        "quick_replies": data.get("quick_replies", [])[:3],
        "suggest_tasks": bool(data.get("suggest_tasks", False)),
        "task_proposals": _normalize_task_proposals(data.get("task_proposals")),
    }

def _nuri_reply_sync(
    history: list[dict], card_ctx: str = "", memory_ctx: str = "",
    profile_ctx: str = "", style_ctx: str = "", internal_ctx: str = "",
    metrics: Optional["_TurnMetrics"] = None,
) -> dict:
    if not oai:
        return {
            "text": "AI 暂时不可用。",
            "quick_replies": [],
            "suggest_tasks": False,
            "task_proposals": [],
        }
    msgs = _nuri_messages(history, card_ctx, memory_ctx, profile_ctx, style_ctx, internal_ctx)
    if metrics:
        metrics.set(model="gpt-5.5")
        metrics.record_prompt(msgs, {
            "card": card_ctx, "memory": memory_ctx, "profile": profile_ctx,
            "style": style_ctx, "internal": internal_ctx,
        })
    started = time.perf_counter()
    try:
        resp = oai.chat.completions.create(
            model="gpt-5.5", messages=msgs, response_format=_NURI_RESPONSE_FORMAT,
        )
        if metrics:
            metrics.mark("model_ms", started)
            metrics.record_usage(getattr(resp, "usage", None))
            metrics.set(finish_reason=getattr(resp.choices[0], "finish_reason", None))
        return _parse_nuri_reply(resp.choices[0].message.content)
    except Exception as e:
        print(f"[error] _nuri_reply_sync failed: {type(e).__name__}: {e}")
        if metrics:
            metrics.mark("model_ms", started)
            metrics.set(status="fallback", error=f"{type(e).__name__}: {e}"[:500])
        return dict(_NURI_FALLBACK)

_JSON_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}

def _partial_json_string(buf: str, key: str) -> str:
    """Decode as much of the string value of `key` as `buf` currently contains.

    The model streams a JSON object, so mid-flight the buffer holds a truncated
    document that json.loads can't touch. This reads just the one field, stopping
    cleanly at a half-arrived escape sequence rather than emitting a broken
    character that would have to be corrected on the next chunk.
    """
    marker = f'"{key}"'
    i = buf.find(marker)
    if i < 0:
        return ""
    i += len(marker)
    while i < len(buf) and buf[i].isspace():
        i += 1
    if i >= len(buf) or buf[i] != ":":
        return ""
    i += 1
    while i < len(buf) and buf[i].isspace():
        i += 1
    if i >= len(buf) or buf[i] != '"':
        return ""
    i += 1

    out: list[str] = []
    while i < len(buf):
        c = buf[i]
        if c == '"':
            break
        if c != "\\":
            out.append(c)
            i += 1
            continue
        if i + 1 >= len(buf):
            break
        esc = buf[i + 1]
        if esc != "u":
            out.append(_JSON_ESCAPES.get(esc, esc))
            i += 2
            continue
        if i + 6 > len(buf):
            break
        try:
            cp = int(buf[i + 2:i + 6], 16)
        except ValueError:
            break
        # A high surrogate is only meaningful once its partner has arrived;
        # emitting it alone would produce an unencodable lone surrogate.
        if 0xD800 <= cp <= 0xDBFF:
            if i + 12 > len(buf) or buf[i + 6:i + 8] != "\\u":
                break
            try:
                low = int(buf[i + 8:i + 12], 16)
            except ValueError:
                break
            out.append(chr(0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00)))
            i += 12
            continue
        out.append(chr(cp))
        i += 6
    return "".join(out)

async def _nuri_reply_stream(
    history: list[dict], card_ctx: str = "", memory_ctx: str = "",
    profile_ctx: str = "", style_ctx: str = "", internal_ctx: str = "",
    metrics: Optional["_TurnMetrics"] = None,
):
    """Yield ("delta", chunk) as the reply text arrives, then ("final", reply)."""
    if not aoai:
        yield "final", {
            "text": "AI 暂时不可用。",
            "quick_replies": [],
            "suggest_tasks": False,
            "task_proposals": [],
        }
        return
    msgs = _nuri_messages(history, card_ctx, memory_ctx, profile_ctx, style_ctx, internal_ctx)
    if metrics:
        metrics.set(model="gpt-5.5")
        metrics.record_prompt(msgs, {
            "card": card_ctx, "memory": memory_ctx, "profile": profile_ctx,
            "style": style_ctx, "internal": internal_ctx,
        })
    buf = ""
    sent = 0
    started = time.perf_counter()
    try:
        stream = await aoai.chat.completions.create(
            model="gpt-5.5", messages=msgs, response_format=_NURI_RESPONSE_FORMAT, stream=True,
            # Without this the streamed response reports no token usage at all.
            stream_options={"include_usage": True},
        )
        async for chunk in stream:
            # The usage-bearing chunk carries no choices, so read it before the
            # skip below or the token counts are silently dropped.
            if metrics and getattr(chunk, "usage", None):
                metrics.record_usage(chunk.usage)
            if not chunk.choices:
                continue
            # getattr: metrics must never be the reason a turn dies, so don't
            # assume every chunk shape carries this field.
            reason = getattr(chunk.choices[0], "finish_reason", None)
            if metrics and reason:
                metrics.set(finish_reason=reason)
            piece = chunk.choices[0].delta.content or ""
            if not piece:
                continue
            buf += piece
            text = _partial_json_string(buf, "text")
            if len(text) > sent:
                if metrics and not sent:
                    metrics.mark("first_token_ms", started)
                yield "delta", text[sent:]
                sent = len(text)
        if metrics:
            metrics.mark("model_ms", started)
        yield "final", _parse_nuri_reply(buf)
    except Exception as e:
        print(f"[error] _nuri_reply_stream failed: {type(e).__name__}: {e}")
        if metrics:
            metrics.mark("model_ms", started)
            metrics.set(status="fallback", error=f"{type(e).__name__}: {e}"[:500])
        # Anything already streamed stays on screen; only the tail is lost.
        salvaged = _partial_json_string(buf, "text")
        if salvaged:
            yield "final", {
                "text": salvaged,
                "quick_replies": [],
                "suggest_tasks": False,
                "task_proposals": [],
            }
        else:
            yield "final", dict(_NURI_FALLBACK)

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

# ── Input normalization & long-term memory ───────────────────────────────────
_MEMORY_CATEGORY_LABELS = {
    "preference": "家庭偏好",
    "constraint": "约束条件",
    "concern": "家长关注点",
    "child_state": "孩子当前状态",
    "fact": "其他信息",
}

_PARENT_ROLE_LABELS = {
    "mom": "妈妈", "dad": "爸爸", "grandparent": "祖父母/外祖父母", "other": "其他家庭照顾者",
}
_CONCERN_LABELS = {
    "sleep": "睡眠", "food": "饮食", "emotion": "情绪", "development": "发展",
    "parenting": "教养方式", "health": "健康", "childcare": "托育",
    "family": "家庭关系", "unknown": "还不确定", "other": "其他",
}
# Onboarding asks the parent how they want to be answered, so these map to
# instructions rather than to descriptions.
_HELP_PREF_LABELS = {
    "research": "希望看到专业研究和知识依据，可以适度引用理论",
    "experience": "希望听到真实家长的经验分享，多用具体情境而不是理论",
    "analysis": "希望一步一步分析原因，先讲清楚为什么再给做法",
    "actionable": "希望直接拿到可执行的方法，少铺垫",
}
_INFO_SOURCE_LABELS = {
    "research": "专业研究／论文", "expert": "医师或专家",
    "parents": "其他家长经验", "all": "都会参考",
}
_GENDER_LABELS = {"boy": "男孩", "girl": "女孩"}


def _age_label(birth_date: str) -> str:
    """Render a birth date as an age NURI can reason about. Advice for a
    6-month-old and a 6-year-old share almost nothing, so this is the single
    most load-bearing fact in the profile."""
    try:
        born = date.fromisoformat(str(birth_date)[:10])
    except (ValueError, TypeError):
        return ""
    today = date.today()
    months = (today.year - born.year) * 12 + (today.month - born.month)
    if today.day < born.day:
        months -= 1
    if months < 0:
        return ""
    if months < 24:
        return f"{months}个月" if months else "未满1个月"
    years, rest = divmod(months, 12)
    return f"{years}岁{rest}个月" if rest else f"{years}岁"


def _profile_ctx(row: dict, children: Optional[list] = None) -> str:
    """Turn the onboarding answers into a prompt block, so NURI knows who it's
    talking to from the first reply instead of only picking this up once enough
    chat history has accumulated.

    Everything the questionnaire collects belongs here — anything omitted is a
    question the parent answered for nothing.
    """
    parts = []
    nickname = (row.get("nickname") or "").strip()
    if nickname:
        parts.append(f"称呼：{nickname}")
    role = _PARENT_ROLE_LABELS.get(row.get("parent_role"))
    if role:
        parts.append(f"身份：{role}")
    city = (row.get("city") or "").strip()
    if city:
        parts.append(f"所在城市：{city}")

    concerns = [_CONCERN_LABELS.get(c, c) for c in (row.get("top_concerns") or [])]
    other = (row.get("concern_other") or "").strip()
    if other:
        concerns = [c for c in concerns if c != "其他"] + [other]
    if concerns:
        parts.append(f"主要关心：{'、'.join(concerns)}")

    hobbies = (row.get("hobbies") or "").strip()
    if hobbies:
        parts.append(f"没带孩子时喜欢：{hobbies}")
    info_source = _INFO_SOURCE_LABELS.get(row.get("info_source"))
    if info_source:
        parts.append(f"比较信任的信息来源：{info_source}")

    for child in children or []:
        desc = []
        name = (child.get("nickname") or "").strip()
        age = _age_label(child.get("birth_date"))
        if age:
            desc.append(age)
        gender = _GENDER_LABELS.get(child.get("gender"))
        if gender:
            desc.append(gender)
        allergies = [a for a in (child.get("allergies") or []) if a]
        if allergies:
            desc.append(f"过敏：{'、'.join(allergies)}")
        notes = (child.get("notes") or "").strip()
        if notes:
            desc.append(notes)
        if desc:
            parts.append(f"孩子{('（' + name + '）') if name else ''}：{'，'.join(desc)}")

    block = "；".join(parts)
    help_pref = _HELP_PREF_LABELS.get(row.get("help_preference"))
    if help_pref:
        block += f"\n这位家长{help_pref}。在不违反上述规则的前提下，按这个偏好来组织回答。"
    return block

_PROFILE_FIELDS = (
    "nickname,city,parent_role,top_concerns,concern_other,hobbies,"
    "help_preference,info_source"
)

async def _load_profile(user_id: Optional[str]) -> tuple[dict, list]:
    """Fetch the profile answers and children behind the prompt block.

    One loader for every caller: the chat path used to select a narrower column
    set than _profile_ctx reads, so answers the parent had given were silently
    dropped in chat while showing up in the intro message.
    """
    sb = _get_supabase()
    if not user_id or not sb:
        return {}, []
    async def _user():
        try:
            r = await anyio.to_thread.run_sync(
                lambda: sb.table("users").select(_PROFILE_FIELDS)
                .eq("id", user_id).maybe_single().execute()
            )
            return (r.data if r else None) or {}
        except Exception as e:
            print(f"[warn] _load_profile user: {e}")
            return {}
    async def _children():
        try:
            r = await anyio.to_thread.run_sync(
                lambda: sb.table("children").select("nickname,birth_date,gender,allergies,notes")
                .eq("user_id", user_id).execute()
            )
            return r.data or []
        except Exception as e:
            print(f"[warn] _load_profile children: {e}")
            return []
    profile, children = await asyncio.gather(_user(), _children())
    return profile, children


def _ms(start: float) -> int:
    """Elapsed milliseconds since a perf_counter() reading."""
    return int((time.perf_counter() - start) * 1000)


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


async def _save_normalized_input(
    *, user_id: Optional[str], session_id: Optional[str], source: str,
    raw_text: str = "", raw_image_base64: Optional[str] = None,
    card_ref: Optional[dict] = None, context_hints: Optional[dict] = None,
    child_id: Optional[str] = None,
) -> None:
    """Log every user turn through one canonical shape before it reaches the router/LLM."""
    sb = _get_supabase()
    if not sb:
        return
    row = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "child_id": child_id,
        "session_id": session_id,
        "source": source,
        "raw_text": raw_text,
        "normalized_text": raw_text.strip(),
        "normalization_version": "v1",
        "raw_image_base64": raw_image_base64,
        "card_ref": card_ref,
        "context_hints": context_hints or {},
        "created_at": _now(),
    }
    try:
        await anyio.to_thread.run_sync(lambda: sb.table("normalized_inputs").insert(row).execute())
    except Exception as e:
        print(f"[warn] _save_normalized_input: {e}")

def _extract_memories_sync(history: list[dict]) -> list[dict]:
    """Ask a small model whether this conversation contains stable, reusable facts."""
    if not oai:
        return []
    convo = "\n".join(
        f"{'用户' if m['role'] == 'user' else 'NURI'}: {m.get('text', '')}"
        for m in history[-8:] if m.get("text")
    )
    if not convo.strip():
        return []
    system = (
        "从下面这段育儿助手对话里，提取值得长期记住的、稳定的事实。"
        "只提取明确、稳定、以后有用的信息（长期偏好、过敏史、育儿理念上的坚持、孩子的持续性状态等），"
        "不要提取一次性的、当下情绪化的、或还不确定的内容。没有就返回空数组，不要勉强凑数。"
    )
    try:
        resp = oai.chat.completions.create(
            model="gpt-5.4-mini",
            messages=[{"role": "system", "content": system}, {"role": "user", "content": convo}],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "memory_extraction",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "memories": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "category": {
                                            "type": "string",
                                            "enum": ["preference", "concern", "child_state", "fact", "constraint"],
                                        },
                                        "key": {"type": "string"},
                                        "value": {"type": "string"},
                                        "confidence": {"type": "number"},
                                    },
                                    "required": ["category", "key", "value", "confidence"],
                                    "additionalProperties": False,
                                },
                            },
                        },
                        "required": ["memories"],
                        "additionalProperties": False,
                    },
                },
            },
        )
        data = json.loads(resp.choices[0].message.content)
        return data.get("memories", [])[:5]
    except Exception as e:
        print(f"[error] _extract_memories_sync failed: {type(e).__name__}: {e}")
        return []

async def _upsert_memories(
    memories: list[dict], *, user_id: str, child_id: Optional[str],
    source_type: str, source_id: Optional[str],
) -> None:
    """Write by (user_id, child_id, category, key); only replace value/confidence
    when the new read is at least as confident, so a low-confidence guess can't
    clobber an already-confirmed fact."""
    sb = _get_supabase()
    if not sb or not memories:
        return
    now = _now()
    for m in memories:
        key = (m.get("key") or "").strip()
        value = (m.get("value") or "").strip()
        category = m.get("category") or "fact"
        confidence = float(m.get("confidence") or 0.7)
        if not key or not value:
            continue
        try:
            q = sb.table("user_memories").select("id,confidence").eq("user_id", user_id).eq("category", category).eq("key", key)
            q = q.is_("child_id", "null") if child_id is None else q.eq("child_id", child_id)
            existing = await anyio.to_thread.run_sync(lambda: q.execute())
            if existing.data:
                row_id = existing.data[0]["id"]
                old_confidence = existing.data[0].get("confidence") or 0
                updates = {"source_id": source_id, "last_confirmed_at": now, "updated_at": now}
                if confidence >= old_confidence:
                    updates["value"] = value
                    updates["confidence"] = confidence
                await anyio.to_thread.run_sync(lambda: sb.table("user_memories").update(updates).eq("id", row_id).execute())
            else:
                row = {
                    "id": str(uuid.uuid4()), "user_id": user_id, "child_id": child_id,
                    "category": category, "key": key, "value": value, "confidence": confidence,
                    "source_type": source_type, "source_id": source_id, "status": "active",
                    "created_at": now, "updated_at": now, "last_confirmed_at": now,
                }
                await anyio.to_thread.run_sync(lambda: sb.table("user_memories").insert(row).execute())
        except Exception as e:
            print(f"[warn] _upsert_memories key={key}: {e}")

async def _extract_and_upsert_memories(
    history: list[dict], user_id: str, source_id: str, source_type: str = "chat",
) -> None:
    """Runs as a fire-and-forget background task so memory extraction never adds
    latency to the chat reply (or task update) the user is waiting on."""
    try:
        memories = await anyio.to_thread.run_sync(lambda: _extract_memories_sync(history))
        await _upsert_memories(memories, user_id=user_id, child_id=None, source_type=source_type, source_id=source_id)
    except Exception as e:
        print(f"[warn] _extract_and_upsert_memories: {e}")

async def _get_memory_context(user_id: Optional[str], limit: int = 12) -> str:
    """Fetch active long-term memories for the Context Builder, grouped by category
    so the prompt reads as a stable profile block rather than a flat dump."""
    if not user_id:
        return ""
    sb = _get_supabase()
    if not sb:
        return ""
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("user_memories").select("category,key,value")
            .eq("user_id", user_id).eq("status", "active")
            .order("updated_at", desc=True).limit(limit).execute()
        )
        rows = res.data or []
    except Exception as e:
        print(f"[warn] _get_memory_context: {e}")
        return ""
    if not rows:
        return ""
    grouped: dict[str, list[str]] = {}
    for r in rows:
        label = _MEMORY_CATEGORY_LABELS.get(r["category"], "其他信息")
        grouped.setdefault(label, []).append(r["value"])
    return "\n".join(f"{label}：{'；'.join(values)}" for label, values in grouped.items())

# Chat command Linda (or any whitelisted reviewer) types inline to correct a
# reply: "#fix <什么地方不对>". It never reaches the user — it gets distilled
# into a reusable rule instead. See _distill_style_rule_sync / nuri_style_rules.
# Only accounts listed in fix_reviewers can trigger it — otherwise any real
# parent who happens to type "#fix ..." would get hijacked instead of a reply.
FIX_KEYWORD = "#fix"

async def _is_fix_reviewer(uid: Optional[str]) -> bool:
    if not uid:
        return False
    sb = _get_supabase()
    if not sb:
        return False
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("fix_reviewers").select("user_id").eq("user_id", uid).maybe_single().execute()
        )
        return bool(res.data)
    except Exception as e:
        print(f"[warn] _is_fix_reviewer: {e}")
        return False

def _distill_style_rule_sync(prior_ai_text: str, feedback: str) -> dict:
    """Turn a raw #fix correction into a reusable rule that generalizes to
    similar situations, rather than a one-off patch quoting this exact reply."""
    if not oai:
        return {"rule": feedback, "category": "other"}
    system = (
        "你在帮 NURI（一个育儿顾问 AI）的运营人员，把她对某条 AI 回复的具体修改意见，"
        "转写成一条可以长期复用、适用于类似场景的行为规则。规则要泛化，不要照抄这一次的具体内容，"
        "用一句话说清楚以后遇到类似情况该怎么做。"
    )
    user_content = f"AI 刚才的回复：\n{prior_ai_text or '（无）'}\n\n运营人员的修改意见：\n{feedback}"
    try:
        resp = oai.chat.completions.create(
            model="gpt-5.4-mini",
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user_content}],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "style_rule",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "rule": {"type": "string"},
                            "category": {
                                "type": "string",
                                "enum": ["tone", "length", "empathy", "accuracy", "other"],
                            },
                        },
                        "required": ["rule", "category"],
                        "additionalProperties": False,
                    },
                },
            },
            timeout=OPENAI_FAST_TIMEOUT_S,
        )
        data = json.loads(resp.choices[0].message.content)
        return {"rule": (data.get("rule") or "").strip(), "category": data.get("category", "other")}
    except Exception as e:
        print(f"[error] _distill_style_rule_sync failed: {type(e).__name__}: {e}")
        return {"rule": feedback, "category": "other"}

async def _get_style_rules_ctx(limit: int = 50) -> str:
    """Fetch the active, accumulated style rules for injection into every
    reply — this is what makes a #fix correction 'stick' going forward."""
    sb = _get_supabase()
    if not sb:
        return ""
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("nuri_style_rules").select("rule")
            .eq("active", True).order("created_at", desc=True).limit(limit).execute()
        )
        rows = res.data or []
    except Exception as e:
        print(f"[warn] _get_style_rules_ctx: {e}")
        return ""
    if not rows:
        return ""
    return "\n".join(f"- {r['rule']}" for r in rows)

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

def _gen_tasks_ai_sync(
    msgs: list[dict], requested_count: Optional[int] = None,
) -> list[dict]:
    """Fallback task generation when the primary structured reply has no cards."""
    if not oai:
        return []
    history = "\n".join(
        f"{'用户' if m['role'] == 'user' else 'NURI'}: {m.get('text', '')}"
        for m in msgs[-14:]
        if m.get("text") and not (m.get("transition") or {}).get("kind")
    )
    resp = oai.chat.completions.create(
        model="gpt-5.5",
        messages=[{"role": "user", "content":
            f"根据以下育儿对话，生成"
            f"{requested_count if requested_count else '1-3'}个具体可执行的小任务。\n\n"
            f"{history}\n\n"
            '以JSON返回：{"tasks": [{"title": "任务（20字内）", "scope": "today或week", '
            '"task_type": "interaction|observation|care|selfcare", "description": "一句话任务说明", '
            '"steps": ["具体做法1", "具体做法2"]}]}\n'
            "- 对话最后一条 NURI 回复是刚刚给用户的方案，任务必须优先忠实转换其中的行动\n"
            "- 任务必须针对对话中的具体情况，不要泛泛的通用任务\n"
            "- 不要创建内容重叠的任务；每张卡只承载一个清楚行动\n"
            "- today=今天完成，week=本周持续追踪\n"
            "- task_type：interaction=亲子互动，observation=发展观察，care=照顾陪伴，selfcare=自我照顾\n"
            "- steps 给1-3条具体做法，不是套话\n"
            "- 如果对话信息不足，返回空数组"
        }],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "task_list",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "tasks": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {"type": "string"},
                                    "scope": {"type": "string", "enum": ["today", "week"]},
                                    "task_type": {
                                        "type": "string",
                                        "enum": ["interaction", "observation", "care", "selfcare"],
                                    },
                                    "description": {"type": "string"},
                                    "steps": {"type": "array", "items": {"type": "string"}},
                                },
                                "required": ["title", "scope", "task_type", "description", "steps"],
                                "additionalProperties": False,
                            },
                        }
                    },
                    "required": ["tasks"],
                    "additionalProperties": False,
                },
            },
        },
        timeout=OPENAI_TASKS_TIMEOUT_S,
    )
    try:
        tasks = _normalize_task_proposals(
            json.loads(resp.choices[0].message.content).get("tasks", [])
        )
        return tasks[:requested_count] if requested_count else tasks
    except Exception:
        return []


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
    doc = {**res.data[0], **updates}
    return _to_public(doc)

# ── Children ──────────────────────────────────────────────────────────────────
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
    child = {"id": str(uuid.uuid4()), "created_at": _now(), **body.dict()}
    if uid:
        child["user_id"] = uid
    sb = _get_supabase()
    if sb and uid:
        await anyio.to_thread.run_sync(lambda: sb.table("children").insert(child).execute())
        return child
    _children.append(child)
    return child

@api.put("/children/{child_id}")
async def update_child(child_id: str, body: ChildCreate, uid: Optional[str] = Depends(_opt_uid)):
    sb = _get_supabase()
    if sb and uid:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("children")
            .update(body.dict())
            .eq("id", child_id)
            .eq("user_id", uid)
            .execute()
        )
        if res.data:
            return res.data[0]
        raise HTTPException(404, "child not found")
    for i, c in enumerate(_children):
        if c["id"] == child_id and (not uid or c.get("user_id") == uid):
            _children[i] = {**c, **body.dict()}
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
        return {"ok": True}
    _children = [c for c in _children
                 if not (c["id"] == child_id and (not uid or c.get("user_id") == uid))]
    return {"ok": True}

# ── Feed ──────────────────────────────────────────────────────────────────────
def _recommendation_activity_key(row: dict) -> tuple[str, str]:
    return (str(row.get("created_at") or ""), str(row.get("id") or ""))


_ACCOUNT_HISTORY_SESSION_LIMIT = 5
_ACCOUNT_HISTORY_USER_MESSAGE_LIMIT = 18


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

    messages = sorted(
        [
            message
            for message in _messages.get(session["id"], [])
            if not through_created_at
            or str(message.get("created_at") or "") <= through_created_at
        ],
        key=_recommendation_activity_key,
    )[-limit:]
    safe_messages = [
        _safe_context_message(
            {**message, "session_id": message.get("session_id") or session["id"]},
            context_scope="current_session",
        )
        for message in messages
        if message.get("role") in {"user", "ai", "assistant"}
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
        "messages": [*history_messages, *safe_messages],
        "context_created_at": (safe_messages[-1].get("created_at") if safe_messages else None),
        "history_session_count": len(
            {message.get("session_id") for message in history_messages}
        ),
        "history_user_message_count": len(history_messages),
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
                    .limit(4)
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
            *[
                _safe_context_message(message, context_scope="current_session")
                for message in current_messages
                if message.get("role") in {"user", "ai", "assistant"}
            ],
        ]
        session_has_user_message = any(
            message.get("role") == "user"
            and str(message.get("text") or "").strip()
            for message in current_messages
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
)
_TOPIC_SIGNAL_ALIASES: dict[str, tuple[str, ...]] = {
    "learn_language_milestones": (
        "发声",
        "轮流发声",
        "咿呀",
        "语音理解",
        "模仿声音",
        "声音回应",
        "短句回应",
    ),
    "learn_serve_and_return": ("轮流互动", "轮流回应", "跟随孩子"),
}
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
        residue = residue.replace(marker, "")
    for filler in _ACTION_ONLY_FILLERS:
        residue = residue.replace(filler, "")
    residue = re.sub(r"[^a-z0-9\u3400-\u9fff]+", "", residue)
    return len(residue) < 3


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
            text = str(message.get("text") or "").strip()
            if _is_acknowledgement_only(text) or _is_action_only_request(text):
                continue
            return text, scope
    latest = str((current_messages or history_messages or [{}])[-1].get("text") or "")
    return latest, "current_session" if current_messages else "account_history"


def _conversation_topic_excerpt(messages: list[dict], limit: int = 84) -> str:
    """Return a short, redacted description of the latest real user topic."""

    latest, _scope = _conversation_goal_signal(messages)
    topic = " ".join(redact_conversation_text(latest, 240).split())
    topic = topic.strip(" \t\r\n，。！？,.!?；;：:")
    if len(topic) > limit:
        topic = f"{topic[: limit - 1].rstrip()}…"
    return topic


def _is_dynamic_topic_candidate(topic: str) -> bool:
    if _is_acknowledgement_only(topic):
        return False
    if _is_action_only_request(topic):
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
    3x2 bundle; the frontend hides category shelves until that bundle exists.
    """

    topic = _conversation_topic_excerpt(messages)
    if not _is_dynamic_topic_candidate(topic):
        return None
    card_id = _dynamic_research_card_id(
        session_id=session_id,
        context_created_at=context_created_at,
        topic=topic,
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
        "recommendation_intent": _recommendation_intent_code(
            next(
                (
                    str(message.get("text") or "")
                    for message in reversed(messages)
                    if message.get("role") == "user"
                    and message.get("context_scope") != "account_history"
                ),
                topic,
            )
        ),
        "recommendation_score": _CONVERSATION_MATCH_MIN_SCORE,
    }
    if include_detail:
        card.update(
            {
                "body": (
                    "这是根据你刚刚提出的具体问题建立的学习主题。完成外部检索后，"
                    "这里只会展示六项通过来源、语言和内容核验的结果：三个类别，"
                    "每类各一篇文章和一个视频。"
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


def _rank_learning_content(
    messages: list[dict],
    count: int = 4,
    session_id: Optional[str] = None,
    context_created_at: Optional[str] = None,
    context_state: str = "ready",
    include_detail: bool = False,
) -> tuple[list[dict], bool]:
    """Deterministically rank reviewed content against recent conversation text."""

    current_user_texts = [
        str(message.get("text") or "").strip()
        for message in messages
        if message.get("role") == "user" and str(message.get("text") or "").strip()
        and message.get("context_scope") != "account_history"
    ]
    historical_user_texts = [
        str(message.get("text") or "").strip()
        for message in messages
        if message.get("role") == "user" and str(message.get("text") or "").strip()
        and message.get("context_scope") == "account_history"
    ]
    user_texts = [*historical_user_texts, *current_user_texts]
    last_user_text = (current_user_texts[-1] if current_user_texts else "").casefold()
    previous_user_text = " ".join(current_user_texts[-4:-1]).casefold()
    older_user_text = " ".join(current_user_texts[:-4]).casefold()
    substantive_history_texts = [
        text
        for text in historical_user_texts
        if not _is_acknowledgement_only(text)
        and not _is_action_only_request(text)
    ]
    latest_history_text = (
        substantive_history_texts[-1].casefold()
        if substantive_history_texts
        else ""
    )
    older_history_text = " ".join(substantive_history_texts[:-1]).casefold()
    allow_assistant_context = _is_context_follow_up(last_user_text)
    action_intent = _current_action_intent(last_user_text)
    action_only_request = _is_action_only_request(last_user_text)
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
    if assistants_after_user:
        assistant_context_text = assistants_after_user[-1].casefold()
    elif allow_assistant_context and assistants_before_user:
        # A short follow-up such as “给我几个任务” legitimately refers to the
        # immediately preceding NURI answer.  Explicit topic switches do not.
        assistant_context_text = assistants_before_user[-1].casefold()
    else:
        assistant_context_text = ""

    ranked: list[tuple[int, int, int, dict, Optional[str]]] = []
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
        older_score = _signal_score(older_matches, 4, 1, 1)
        # Cross-session history is continuity, not the present request.  It can
        # resolve a generic “give me a task” follow-up, but otherwise remains a
        # weak preference signal and cannot establish a personalized match.
        history_score = _signal_score(
            latest_history_matches,
            8 if action_only_request and not recent_matches else 3,
            2 if action_only_request and not recent_matches else 1,
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
        score = user_signal_score + assistant_score

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
        ranked.append((score, user_signal_score, index, card, reason_term))

    ranked.sort(key=lambda item: (-item[0], -item[1], item[2]))
    has_conversation_match = bool(
        current_user_texts
        and ranked
        and ranked[0][0] >= _CONVERSATION_MATCH_MIN_SCORE
        and ranked[0][1] >= _CONVERSATION_MATCH_MIN_SCORE
    )
    selected: list[dict] = []
    for score, user_signal_score, _, card, reason_term in ranked[
        : max(1, min(count, len(LEARNING_CONTENT_CARDS)))
    ]:
        if (
            score >= _CONVERSATION_MATCH_MIN_SCORE
            and user_signal_score >= _CONVERSATION_MATCH_MIN_SCORE
            and has_conversation_match
        ):
            if action_intent and safe_goal:
                continuity = "结合你最近其他对话里提到的" if goal_scope == "account_history" else "延续你提到的"
                reason = (
                    f"你现在想要{action_intent}，{continuity}“{safe_goal}”；"
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
                    "recommendation_focus": safe_goal or reason_term or card["topic_label"],
                    "recommendation_intent": _recommendation_intent_code(last_user_text),
                    "recommendation_score": score,
                }
            )
        selected.append(public_card)

    if not has_conversation_match and context_state == "ready" and current_user_texts:
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


def _resource_blueprint() -> dict[str, list[str]]:
    return {category: ["article", "video"] for category in CONTENT_CATEGORIES}


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
) -> Optional[dict]:
    """Run one bounded web-research pass for a conversation-matched detail page."""

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
    try:
        return await anyio.to_thread.run_sync(
            lambda: research_learning_resources(
                content_research_oai,
                card=card,
                messages=context.get("messages") or [],
                preferred_locale=str(context.get("preferred_locale") or "zh-CN"),
                model=OPENAI_CONTENT_RESEARCH_MODEL,
                safety_identifier=_research_safety_identifier(uid),
            ),
            limiter=content_research_limiter,
        )
    except Exception as exc:
        # Dynamic research is an enhancement.  A provider outage, timeout, bad
        # result or incomplete 3x2 bundle must never break the reviewed detail.
        print(f"[warn] conversation content research fell back: {type(exc).__name__}")
        return None


@api.get("/feed/personalized")
async def get_personalized_feed(count: int = 4, uid: str = Depends(_req_uid)):
    """Return learning topics tied to this parent's real main conversation."""

    context = await _load_recent_main_chat(uid)
    items, used_conversation = _rank_learning_content(
        context.get("messages") or [],
        count=max(1, min(count, 6)),
        session_id=context.get("session_id"),
        context_created_at=context.get("context_created_at"),
        context_state=context.get("state", "no_history"),
    )
    first_match = next(
        (item for item in items if item.get("is_conversation_match")),
        None,
    )
    if context.get("state") == "privacy_off":
        mode = "default_privacy"
    elif used_conversation:
        mode = "conversation"
    elif context.get("state") == "unavailable":
        mode = "default_unavailable"
    else:
        mode = "default"
    preferred_locale = str(context.get("preferred_locale") or "zh-CN")
    urgent_suppressed = _context_requires_urgent_handoff(context)
    for item in items:
        if item.get("is_conversation_match"):
            item["context_created_at"] = context.get("context_created_at")
        reviewed = LEARNING_CONTENT_BY_ID.get(item["id"], {}).get("resources", [])
        item["resource_summary"] = summarize_resource_slots(reviewed, preferred_locale)
        item["resource_blueprint"] = _resource_blueprint()
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
    await _attach_recommendation_snapshots(uid, items, context)
    return {
        "items": items,
        "personalization_mode": mode,
        "matched_topic": (first_match or {}).get("topic"),
        "related_session_id": (first_match or {}).get("related_session_id"),
        "context_status": context.get("state", "no_history"),
        "history_session_count": int(context.get("history_session_count") or 0),
        "history_user_message_count": int(
            context.get("history_user_message_count") or 0
        ),
        "generated_at": _now(),
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
        if snapshot:
            session_id = snapshot.get("session_id")
            context_created_at = snapshot.get("context_created_at")
        if uid:
            context = await _load_recent_main_chat(
                uid,
                preferred_session_id=session_id,
                through_created_at=context_created_at,
            )
        else:
            context = {
                "state": "no_history",
                "session_id": None,
                "messages": [],
                "preferred_locale": "zh-CN",
                "external_research_allowed": False,
            }
        if snapshot and (
            context.get("state") != "ready"
            or context.get("session_id") != snapshot.get("session_id")
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
        )
        card = next((item for item in ranked if item["id"] == card_id), None)
        if not card and snapshot and is_dynamic_request:
            card = _restore_dynamic_research_card_from_snapshot(
                snapshot,
                include_detail=True,
            )
        if not card:
            raise HTTPException(404, "card not found")
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
        trusted_resources = [
            resource
            for resource in card.get("resources", [])
            if is_trusted_resource_url(str(resource.get("url") or ""))
        ]
        preferred_locale = str(context.get("preferred_locale") or "zh-CN")
        card["resources"] = order_learning_resources(
            trusted_resources,
            preferred_locale,
        )
        # Return the reviewed library immediately.  The client then calls the
        # research endpoint and can show these resources while web search runs.
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
        if urgent_suppressed:
            card["research_status"] = "urgent_suppressed"
        elif research_eligible:
            card["research_status"] = "pending"
        elif (
            uid
            and card.get("is_conversation_match")
            and content_research_oai
            and not context.get("external_research_allowed")
        ):
            card["research_status"] = "consent_required"
        elif card.get("is_dynamic_research_card"):
            card["research_status"] = "unavailable"
        else:
            card["research_status"] = "reviewed_fallback"
        card["preferred_locale"] = preferred_locale
        card["resource_blueprint"] = _resource_blueprint()
        card["resource_summary"] = summarize_resource_slots(
            card["resources"], preferred_locale
        )
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
    uid: str = Depends(_req_uid),
):
    """Return a complete conversation-aware 3x2 bundle or a safe fallback state."""

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
    if snapshot:
        session_id = snapshot.get("session_id")
        context_created_at = snapshot.get("context_created_at")
    context = await _load_recent_main_chat(
        uid,
        preferred_session_id=session_id,
        through_created_at=context_created_at,
    )
    if snapshot and (
        context.get("state") != "ready"
        or context.get("session_id") != snapshot.get("session_id")
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
        return {"research_status": "reviewed_fallback"}
    if not context.get("external_research_allowed"):
        return {"research_status": "consent_required"}
    research = await _research_card_detail_resources(card=card, context=context, uid=uid)
    if not research:
        if card.get("is_dynamic_research_card"):
            return {
                "resources": [],
                "research_status": "unavailable",
                "resource_blueprint": _resource_blueprint(),
                "resource_summary": summarize_resource_slots(
                    [], str(context.get("preferred_locale") or "zh-CN")
                ),
            }
        return {"research_status": "reviewed_fallback"}
    preferred_locale = str(context.get("preferred_locale") or "zh-CN")
    resources = research["resources"]
    dynamic_count = int(research.get("dynamic_resource_count") or 0)
    if card.get("is_dynamic_research_card") and dynamic_count != 6:
        # There is no topic-appropriate reviewed fallback for a novel subject.
        # Never relabel unrelated library resources as personalized results.
        return {
            "resources": [],
            "research_status": "unavailable",
            "resource_blueprint": _resource_blueprint(),
            "resource_summary": summarize_resource_slots([], preferred_locale),
        }
    research_status = (
        "fresh" if dynamic_count == 6 else "hybrid" if dynamic_count else "reviewed_fallback"
    )
    return {
        "resources": resources,
        "research_status": research_status,
        "research_query": research.get("query"),
        "research_editor_note": research.get("editor_note"),
        "research_source_count": research.get("cited_source_count", 0),
        "dynamic_resource_count": dynamic_count,
        "reviewed_resource_count": int(research.get("reviewed_resource_count") or 0),
        "resource_blueprint": _resource_blueprint(),
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

async def _fix_reply(msgs: list, fix_text: str) -> str:
    """Handle a reviewer's `#fix` correction: distil it into a reusable style
    rule instead of answering the parent."""
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


async def _reply_context(
    turn: _Turn, body: "UserMessageIn", metrics: Optional["_TurnMetrics"] = None,
) -> tuple:
    """Gather the five prompt context blocks. The four I/O-bound ones run
    concurrently rather than as serial round trips before the reply starts."""
    started = time.perf_counter()
    gen_cards, memory_ctx, style_ctx, internal_ctx = await asyncio.gather(
        _db_get_gen_cards(),
        _get_memory_context(turn.owner_uid),
        _get_style_rules_ctx(),
        anyio.to_thread.run_sync(_internal_rules_ctx, body.text or ""),
    )
    if metrics:
        metrics.mark("context_ms", started)
    return (
        _card_ctx(turn.session.get("source_card_id") or "", gen_cards),
        memory_ctx,
        _profile_ctx(turn.context_hints, turn.context_hints.get("children")),
        style_ctx,
        internal_ctx,
    )


async def _task_suggestion(
    reply: dict, msgs: list, user_text: str, ai_text: str,
    metrics: Optional["_TurnMetrics"] = None,
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
    if _user_declined_tasks(user_text) or _urgent_task_suppressed(user_text, ai_text):
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


async def _persist_ai_turn(
    session_id: str, turn: _Turn, ai_text: str,
    quick_replies: list, transition: Optional[dict],
) -> dict:
    sb = _get_supabase()
    ai_msg = {
        "id": str(uuid.uuid4()), "session_id": session_id,
        "role": "ai", "text": ai_text,
        "quick_replies": quick_replies, "transition": transition, "created_at": _now(),
    }
    if sb:
        try:
            await anyio.to_thread.run_sync(lambda: sb.table("chat_messages").insert(ai_msg).execute())
        except Exception as e:
            print(f"[warn] post_message ai_msg insert: {e}")
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

    if turn.fix_text:
        ai_text = await _fix_reply(turn.msgs, turn.fix_text)
    elif oai:
        ctx, memory_ctx, profile_ctx, style_ctx, internal_ctx = await _reply_context(turn, body, metrics)
        reply = await anyio.to_thread.run_sync(
            lambda: _nuri_reply_sync(
                turn.msgs, ctx, memory_ctx, profile_ctx, style_ctx, internal_ctx, metrics
            )
        )
        ai_text = reply["text"]
        quick_replies = reply.get("quick_replies", [])
        transition = await _task_suggestion(
            reply, turn.msgs, body.text or "", ai_text, metrics
        )
    else:
        ai_text, quick_replies, transition = await _scripted_reply(turn.session, session_id)

    ai_msg = await _persist_ai_turn(session_id, turn, ai_text, quick_replies, transition)

    # Logged after the reply is built, and only for real model turns — a #fix
    # command or the canned script isn't a generation worth measuring.
    if oai and not turn.fix_text:
        background_tasks.add_task(
            metrics.flush, session_id=session_id, user_id=turn.owner_uid, reply_text=ai_text,
        )

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
        try:
            if turn.fix_text:
                ai_text = await _fix_reply(turn.msgs, turn.fix_text)
                yield _sse({"type": "delta", "text": ai_text})
            elif aoai:
                ctx, memory_ctx, profile_ctx, style_ctx, internal_ctx = await _reply_context(turn, body, metrics)
                reply = None
                async for kind, value in _nuri_reply_stream(
                    turn.msgs, ctx, memory_ctx, profile_ctx, style_ctx, internal_ctx, metrics
                ):
                    if kind == "delta":
                        yield _sse({"type": "delta", "text": value})
                    else:
                        reply = value
                reply = reply or dict(_NURI_FALLBACK)
                ai_text = reply["text"]
                quick_replies = reply.get("quick_replies", [])
                # The primary reply normally already carries proposals. If it
                # does not, the fallback call still runs only after the text is
                # visible, so it cannot delay the parent's first token.
                transition = await _task_suggestion(
                    reply, turn.msgs, body.text or "", ai_text, metrics
                )
            else:
                ai_text, quick_replies, transition = await _scripted_reply(
                    turn.session, session_id
                )
                yield _sse({"type": "delta", "text": ai_text})

            ai_msg = await _persist_ai_turn(session_id, turn, ai_text, quick_replies, transition)
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
    }

# ── RAG helper functions ───────────────────────────────────────────────────────
def _read_pdf(pdf_bytes: bytes) -> str:
    if PdfReader is None:
        raise HTTPException(503, "pypdf not installed")
    reader = PdfReader(io.BytesIO(pdf_bytes))
    text = "\n".join(p.extract_text() or "" for p in reader.pages)
    return text.replace("\x00", "")  # postgres text columns reject NUL bytes

def _chunk_text(text: str, size: int = 1200, overlap: int = 150) -> List[str]:
    text = text.replace("\r\n", "\n")
    chunks, start, n = [], 0, len(text)
    while start < n:
        end = min(start + size, n)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == n:
            break
        start = max(0, end - overlap)
    return chunks

def _embed_batch(texts: List[str]) -> List[List[float]]:
    # Ingest-time only, and batches can be large — keep the longer client default.
    resp = oai.embeddings.create(model="text-embedding-3-large", input=texts, dimensions=EMBED_DIM)
    return [d.embedding for d in resp.data]

def _embed_one(text: str) -> List[float]:
    resp = oai.embeddings.create(
        model="text-embedding-3-large", input=text, dimensions=EMBED_DIM,
        timeout=OPENAI_FAST_TIMEOUT_S,
    )
    return resp.data[0].embedding

def _is_indexed(doc_id: str, namespace: str = VECTOR_NAMESPACE):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    res = (
        sb.table(VECTOR_TABLE)
        .select("id", count="exact")
        .eq("namespace", namespace)
        .eq("doc_id", doc_id)
        .limit(1)
        .execute()
    )
    total = int(getattr(res, "count", 0) or 0)
    return total > 0, total or None

def _upsert_doc(doc_id: str, chunks: List[str], namespace: str = VECTOR_NAMESPACE, extra_metadata: Optional[dict] = None) -> int:
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    vecs_data = _embed_batch(chunks)
    base_meta = extra_metadata or {}
    rows = [
        {
            "id": f"{doc_id}-{i}",
            "namespace": namespace,
            "doc_id": doc_id,
            "chunk_id": i,
            "content": c,
            "embedding": v,
            "metadata": {**base_meta, "doc_id": doc_id, "chunk_id": i},
        }
        for i, (c, v) in enumerate(zip(chunks, vecs_data))
    ]
    for start in range(0, len(rows), 100):
        sb.table(VECTOR_TABLE).upsert(rows[start:start + 100], on_conflict="id").execute()
    return len(chunks)

def _retrieve(question: str, top_k: int, doc_id: Optional[str]):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")

    # When no specific doc requested, restrict to enabled books only.
    enabled_doc_ids = None
    if doc_id is None:
        try:
            books_res = sb.table("books").select("doc_id").eq("enabled", True).execute()
            rows = getattr(books_res, "data", None) or []
            if rows:
                enabled_doc_ids = [r["doc_id"] for r in rows]
            # If books table is empty / missing, enabled_doc_ids stays None → search all.
        except Exception:
            pass

    qv = _embed_one(question)
    res = sb.rpc(
        "match_rag_chunks",
        {
            "query_embedding": qv,
            "match_count": top_k,
            "filter_doc_id": doc_id,
            "filter_doc_ids": enabled_doc_ids,
            "filter_namespace": VECTOR_NAMESPACE,
        },
    ).execute()
    matches = getattr(res, "data", None) or []
    chunks, scores = [], []
    for m in (matches or []):
        text = (m or {}).get("content", "")
        if text:
            chunks.append(text)
            scores.append(float((m or {}).get("similarity", 0)))
    return chunks, scores

def _retrieve_internal(question: str, top_k: int = INTERNAL_TOP_K):
    """Top-k similarity search over the internal (must-follow) namespace.
    Unlike _retrieve, there's no books/enabled gating — every ingested
    internal doc is eligible. Matches below INTERNAL_MIN_SIMILARITY are
    dropped so an off-topic message doesn't drag in unrelated internal
    guidance mislabeled as mandatory."""
    sb = _get_supabase()
    if not sb or not oai:
        return [], []
    qv = _embed_one(question)
    # No filter_doc_ids here (unlike _retrieve): internal docs have no
    # books-style enable/disable toggle, every ingested doc is eligible.
    res = sb.rpc(
        "match_rag_chunks",
        {
            "query_embedding": qv,
            "match_count": top_k,
            "filter_doc_id": None,
            "filter_namespace": INTERNAL_NAMESPACE,
        },
    ).execute()
    matches = getattr(res, "data", None) or []
    chunks, scores = [], []
    for m in (matches or []):
        score = float((m or {}).get("similarity", 0))
        text = (m or {}).get("content", "")
        if text and score >= INTERNAL_MIN_SIMILARITY:
            chunks.append(text)
            scores.append(score)
    return chunks, scores

def _internal_rules_ctx(question: str, top_k: int = INTERNAL_TOP_K) -> str:
    if not question or not question.strip():
        return ""
    try:
        chunks, _ = _retrieve_internal(question, top_k)
    except Exception as e:
        print(f"[warn] _internal_rules_ctx: {e}")
        return ""
    if not chunks:
        return ""
    body = "\n\n".join(f"[內部準則 {i+1}]\n{c}" for i, c in enumerate(chunks))
    return ("以下是內部知識庫中與本次對話相關的準則，必須嚴格遵守，其優先級高於任何外部參考文獻、書籍引用，"
            "以及你自身的一般知識。若內部準則與其他資料衝突，一律以內部準則為準：\n" + body)

def _generate_rag_answer(question: str, chunks: List[str], book_name: Optional[str] = None) -> str:
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
        lambda: sb.table("users").select("id,email,nickname,top_concerns").execute()
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
