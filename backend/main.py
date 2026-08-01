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

import asyncio, io, json, os, time, uuid, hashlib, random
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta, date, time as dt_time
from pathlib import Path
from typing import List, Literal, NamedTuple, Optional

import anyio
import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, BackgroundTasks, Depends, HTTPException, Header, UploadFile, File, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from openai import AsyncOpenAI, OpenAI

from backend.router import TurnRoute, route_metrics, route_turn
from backend.websearch import (
    get_provider as get_search_provider,
    load_domain_rules,
    search_sources,
    sources_prompt_block,
)
from pydantic import BaseModel, EmailStr, Field, field_validator
from starlette.background import BackgroundTask

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
SUPABASE_KEY     = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
VECTOR_NAMESPACE = os.getenv("VECTOR_NAMESPACE", "pdf")
FRONTEND_DIST    = Path(__file__).resolve().parents[1] / "frontend" / "dist"
VECTOR_TABLE     = os.getenv("SUPABASE_VECTOR_TABLE", "rag_chunks")
# Internal knowledge base: NURI-authored guidance treated as mandatory rules,
# distinct from VECTOR_NAMESPACE (external reference books). Ingested via
# backend/scripts/ingest_internal_docs.py, not the /admin/books flow.
INTERNAL_NAMESPACE      = os.getenv("INTERNAL_VECTOR_NAMESPACE", "internal")
INTERNAL_TOP_K          = int(os.getenv("INTERNAL_TOP_K", "3"))
INTERNAL_MIN_SIMILARITY = float(os.getenv("INTERNAL_MIN_SIMILARITY", "0.5"))
# Falls back to a value committed in this file; _warn_on_insecure_config()
# reports it at startup, because nothing else would.
JWT_SECRET       = os.getenv("JWT_SECRET", "dev-secret-change-in-prod")
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

#: The fallback baked into the source. Anyone who can read the repository can
#: read this, so a deployment still using it can have session tokens forged for
#: any account — no password needed, since the token *is* the credential.
_DEV_JWT_SECRET = "dev-secret-change-in-prod"


def _warn_on_insecure_config() -> None:
    """Say so, loudly, at startup rather than never.

    Not fatal: local development should keep working without a .env. But the
    failure mode this guards against is silent — an unset JWT_SECRET behaves
    exactly like a correctly configured one until someone notices they can mint
    tokens, and there is no way to detect it from outside the deployment.
    """
    if JWT_SECRET == _DEV_JWT_SECRET:
        print("[SECURITY] JWT_SECRET is unset and falling back to the value "
              "committed in main.py. Anyone with repository access can forge a "
              "session token for any account. Set JWT_SECRET in the environment "
              "(Production *and* Preview).")
    if not ADMIN_KEY:
        print("[SECURITY] ADMIN_KEY is unset; /admin endpoints have no shared "
              "secret to check against.")


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    anyio.to_thread.current_default_thread_limiter().total_tokens = THREAD_LIMIT
    _warn_on_insecure_config()
    # Pull source_domains in before the first parent is waiting on it. The read
    # is cached for SOURCE_DOMAINS_TTL_S, so without this the first chat turn
    # after every cold start pays a database round trip in front of its first
    # visible token. Failure is fine — load_domain_rules re-reads on demand.
    try:
        await load_domain_rules(_get_supabase())
    except Exception as e:
        print(f"[warn] source_domains warmup: {type(e).__name__}: {e}")
    yield

app = FastAPI(title="Family Growth Radar API", lifespan=_lifespan)
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
_feed_gen_mode: str           = "ai"  # fallback when Supabase is unavailable

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
        # Carried on /auth/me and /auth/login so a fresh install picks up the
        # parent's UI language at launch, without waiting for the settings
        # screen to be opened. Empty — not the default — when nothing is stored
        # (including before privacy_settings_migration.sql runs), so the client
        # can tell "no preference on file" from "the parent chose Simplified"
        # and doesn't overwrite a local choice with a made-up one.
        "language":             _normalize_language(doc["language"]) if doc.get("language") else "",
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

class TaskUpdate(BaseModel):
    done: Optional[bool] = None
    mood: Optional[str]  = None
    note: Optional[str]  = None
    is_favorited: Optional[bool] = None
    backfilled: Optional[bool] = None

def _normalize_language(value: object) -> str:
    """Map whatever the client sends onto a supported UI language.

    This used to be a `Literal["zh","en"]` while the app sent "zh-CN"/"zh-TW",
    so every tap on the language switch 422'd and the setting looked like a dead
    button. Normalising rather than rejecting keeps any future mismatch cosmetic
    instead of turning it into a broken control.
    """
    raw = str(value or "").strip().replace("_", "-").lower()
    if raw.startswith("en"):
        return "en"
    if raw in ("zh-tw", "zh-hk", "zh-mo") or "hant" in raw:
        return "zh-TW"
    return "zh-CN"

class PrivacySettings(BaseModel):
    allow_history_training:   bool = True
    daily_push:               bool = True
    anonymous_community_share: bool = False
    # Deliberately a plain str + normaliser, not a Literal: see above.
    language: str = "zh-CN"

    @field_validator("language", mode="before")
    @classmethod
    def _clean_language(cls, v: object) -> str:
        return _normalize_language(v)

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

【先照顾说话的人，再处理事情】
这是最容易做丢的一件事，也是家长最先感觉到的。顺序不能颠倒：先接住他这句话里的
情绪或处境，再进入内容。
- 肯定要具体到只有他适用。「宝宝已经 8 公斤，一路以母奶为主，这真的很不容易」
  远胜过「你做得很好」——后者对谁都能说，所以对谁都没用
- 看得出家长在硬撑（半夜起来挤奶、全职带、一直忍着不说累），就直接讲出来：
  「一边照顾宝宝、一边还要半夜起来挤奶，真的辛苦了」
- 家长表达担心时，先把那个担心用他自己的话复述回去，让他知道你真的听懂了：
  「听到你说『怎么喝都喝不饱』，我很能理解你的担心」
- 聊完孩子，记得回头问他自己：最近睡得好吗、累不累、有没有一点喘口气的时间
- 家长说的困难如果很多家庭都会遇到，明说「很多爸爸妈妈也会这样」，
  减少他觉得是自己没做好的那份自责
- 这不是客服腔。客服腔是「当然！」「太棒了！」这种谁都能收到的话；
  嘘寒问暖是具体的、只对着眼前这个人说的。不要因为怕油腻就冷掉

【给建议时给的是选择，不是步骤】
- 同一个育儿难题通常不只一种解法。给建议时给 2-3 个取向不同的做法，让父母按自家情况挑
- "不同做法"指彼此可以互相替换的路径，例如：温和渐进 vs 一次到位；改环境 vs 改互动方式；先调整孩子 vs 先调整大人的节奏
- 绝对不要把同一个方法的先后步骤编号成 1234，伪装成多个选项。步骤是"先做这个再做那个"，选项是"做这个或者做那个"，两者不能混着摆
- 每个做法都简短说清楚：适合什么情况、大概会发生什么、要观察什么
- 如果这件事真的只有一条稳妥的路（例如牵涉安全或需要就医），就直说只有一条，并说明为什么不建议别的做法——不要为了凑数硬编出三个

【每次回复都以一个问句收尾】
- 收尾的问句只问一件事，而且要接着刚才聊的内容，不要突兀跳题
- 从下面几类里挑当下最自然的一类：
  · 追踪型：延续之前聊过的事，问后来怎么样了（例：上次你提到宝宝开始吃副食品，这几天有比较愿意尝试新食物吗？）
  · 发展提醒型：按孩子的实际月龄／年龄，问一个这阶段常见的变化（例：4个月"最近宝宝开始会抓玩具了吗？"；9个月"有没有开始扶着站？"；2岁"最近说『不要』变多了吗？"）
  · 家长关心型：关心的是爸妈本人，不是孩子（例：最近照顾孩子，你还好吗？／最近有没有一件让你觉得很开心的小事？）
  · 探索型：慢慢补齐家庭背景，一次只问一件，不要做成问卷（例：家里通常是谁陪孩子最多？／家里平常最重视什么？）
- 如果从已知信息看得出孩子正接近某个人生事件（快满整岁、要上托婴或幼儿园、准备戒奶或戒尿布、家里要迎接新生儿、生日或节日、打疫苗前后、要出远门），可以主动用它开一个新话题，并说明你为什么想到这件事（例：我记得下周 Abi 就要满两岁了，很多孩子这个阶段开始更想自己做决定，你有没有观察到什么新变化？）
- 刚讲完一段比较重的建议时，收尾问句要轻，不要再抛一个需要长篇回答的问题

【语气】
- 沉稳、温暖，有专业感，像一位你信任的儿科医生朋友
- 口语化但不随意，用词简单、直接，不堆砌术语
- 不用"当然！""太棒了！"等客服腔。但"不油腻"指的是不要空洞的热情，
  不是要你收起温度——具体的关心永远不算油腻，见上面【先照顾说话的人】"""

# ── NURI AI helper ────────────────────────────────────────────────────────────
_NURI_JSON_SUFFIX = """

以合法 JSON 格式回复：{"text": "...", "cited": []}

text：
- 语言跟随对方在这条消息里使用的语言/文字，不要擅自切换
- 先判断这条回复属于哪一种，长度和结构差别很大：
  · 还在了解情况、准备追问（信息不够，没法下结论）：只做两件事——简短回应对方刚说的一句话，然后问一个具体问题。不要在这个阶段列可能原因、摆多个假设、给成套建议，那是"结论阶段"才做的事，提前做会让人觉得在看报告而不是聊天
  · 已经有足够信息、要下结论/给建议/整理任务/推荐资源：可以写得完整、分点、说明原因，不要为了精简砍掉关键推理和细节。分点摆的是几个可以互相替换的做法，不是同一个做法的先后步骤
- 先回应对方刚分享的内容（可以自然提一句你记得的细节），再自然延伸，不要用模板化开场白
- 口语化但有专业感
- 结尾一定要有一个问句，类型按上面【每次回复都以一个问句收尾】挑

cited（你在正文里引用了哪几条来源）：
- 只填系统给你的来源清单里的编号，例如 [1] [3] 就填 [1, 3]
- 正文里标了几号，这里就填几号，两边必须一致
- 没有来源清单、或者没有一条真的用得上，就填 []
- 你永远不需要、也绝对不要自己写出网址"""

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
                # Indices into the numbered source list in the prompt — never
                # URLs. The model physically cannot invent a link it was not
                # given, which is the one guarantee worth designing the schema
                # around for a parenting product.
                "cited": {"type": "array", "items": {"type": "integer"}},
            },
            "required": ["text", "cited"],
            "additionalProperties": False,
        },
    },
}

# suggest_tasks is deliberately absent: the router decides task cards now, so
# the reply model no longer votes on it. See backend/router.py.
_NURI_FALLBACK = {"text": "抱歉，AI 暂时无法回应，请稍后再试。", "quick_replies": [], "cited": []}

#: The reply model's deliberation budget. Measured on gpt-5.5 with the full
#: persona and a source list: 22.2s at the default, 12.5s at "low" — for
#: output that was structurally identical (same three distinct approaches, the
#: same three citations, the same closing question). "minimal" is not accepted
#: by this model. Set to "" to send no parameter at all.
REPLY_REASONING_EFFORT = os.getenv("REPLY_REASONING_EFFORT", "low")


def _reply_model_kwargs() -> dict:
    return {"reasoning_effort": REPLY_REASONING_EFFORT} if REPLY_REASONING_EFFORT else {}



# Three exchanges lifted from a real consultation run by the one person on the
# team with first-hand user experience. Rules describe a voice; examples are the
# voice, and the model imitates the second far more reliably than the first.
#
# Trimmed hard on purpose — this rides on every turn. Each one carries something
# the rules can only gesture at: refusing to advise before understanding,
# reframing a parent's goal instead of executing it, and answering a logistics
# question by first noticing the person asking it.
_NURI_EXAMPLES = """

以下是团队里最贴近用户的同事的真实对话片段。学的是这种说话方式——不是照抄内容。

【示例一：资讯不足时，先问再答】
家长：餵四個月的寶寶吃副食品米泥 很抗拒，喝奶都很愛喝
NURI：謝謝你分享，我想先多了解一下寶寶目前的狀況，再一起判斷是不是還沒準備好，還是只是需要調整餵食方式。想請問你幾個問題：
1. 寶寶現在是剛滿四個月，還是已經四個多月了？
2. 他看到湯匙就把嘴巴閉起來，還是願意含一下，但會吐出來或一直推掉？
3. 一天大概試幾次？每次大約吃幾口？

【示例二：家长的目标方向可议时，先同理再重构】
家长：因為他喝奶需求太大了 才想著要給他吃點東西 不要一直喝奶
NURI：💜 我能理解你的想法，很多爸爸媽媽看到寶寶一直討奶，都會想：「是不是奶已經不夠了？是不是該趕快開始吃副食品？」
其實在四到六個月這段時間，寶寶進入快速成長期，有些孩子會出現一段時間特別愛喝奶的情況，這不一定代表需要靠副食品來增加飽足感。副食品主要是幫助練習咀嚼、吞嚥和認識不同食物，而不是用來取代奶。
💜 我想再了解一下，是什麼讓你覺得壓力比較大呢？是因為寶寶一直討奶，幾乎沒有時間休息？還是擔心奶好像不夠？

【示例三：先看见家长这个人，再回答问题】
家长：全母奶 最近開始搭配一餐配方奶 200ml5餐 目前8公斤
NURI：謝謝你分享，也想跟你說一句，你真的辛苦了。寶寶現在已經 8 公斤，而且一路以母奶為主，這真的很不容易。
我比較想了解的是，是什麼讓你最近覺得壓力比較大呢？我們可以一起找找真正讓你覺得累的原因，再看看有沒有更適合你們的方式。"""


def _nuri_messages(
    history: list[dict], card_ctx: str = "", memory_ctx: str = "",
    profile_ctx: str = "", style_ctx: str = "", internal_ctx: str = "",
    sources_ctx: str = "", will_suggest_tasks: bool = False,
) -> list[dict]:
    """Assemble the system prompt and history window. Shared by the blocking and
    streaming reply paths so the two can't drift apart."""
    system = NURI_PERSONA + _NURI_EXAMPLES + _NURI_JSON_SUFFIX
    if will_suggest_tasks:
        # The task cards render directly under this reply's text, so the reply
        # has to lead into them. Without this the parent gets an answer that
        # never mentions tasks, followed by three task cards.
        system += (
            "\n\n本轮回复结束后，会在你的回复下方给家长几张可以执行的任务卡片。"
            "请在结尾自然地引出它们（例如提一句你帮他整理了几件可以做的事），"
            "但不要把任务内容写进正文，也不要编号列出来——卡片会自己显示。"
        )
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
    if sources_ctx:
        # Last, and after the internal rules on purpose: external pages are the
        # weakest tier of context NURI has, and the block itself says so.
        system += f"\n\n{sources_ctx}"
    msgs = [{"role": "system", "content": system}]
    for m in history[-_HISTORY_WINDOW:]:
        role = "user" if m["role"] == "user" else "assistant"
        content = m.get("text") or ""
        if content:
            msgs.append({"role": role, "content": content})
    return msgs

def _unescape_stray_newlines(text: str) -> str:
    """Repair a reply whose paragraph breaks arrived double-escaped.

    The model occasionally emits "\\n\\n" inside the JSON string rather than a
    real break, so json.loads yields a literal backslash-n that renders as
    visible characters mid-sentence. Only applied when there are no real
    newlines to begin with, so a correctly formatted reply is never touched.
    """
    if "\n" in text or "\\n" not in text:
        return text
    return text.replace("\\r\\n", "\n").replace("\\n", "\n")


def _parse_nuri_reply(raw: str) -> dict:
    data = json.loads(raw)
    return {
        "text": _unescape_stray_newlines(data.get("text", "")),
        # Retired: the app no longer renders suggested replies, so the model is
        # no longer asked for them. Kept in the shape so persistence, the
        # scripted fallback and existing rows all stay as they are.
        "quick_replies": [],
        "cited": [n for n in (data.get("cited") or []) if isinstance(n, int)],
    }

def _nuri_reply_sync(
    history: list[dict], card_ctx: str = "", memory_ctx: str = "",
    profile_ctx: str = "", style_ctx: str = "", internal_ctx: str = "",
    sources_ctx: str = "", will_suggest_tasks: bool = False,
    metrics: Optional["_TurnMetrics"] = None,
) -> dict:
    if not oai:
        return {"text": "AI 暂时不可用。", "quick_replies": [], "cited": []}
    msgs = _nuri_messages(history, card_ctx, memory_ctx, profile_ctx, style_ctx,
                          internal_ctx, sources_ctx, will_suggest_tasks)
    if metrics:
        metrics.set(model="gpt-5.5")
        metrics.record_prompt(msgs, {
            "card": card_ctx, "memory": memory_ctx, "profile": profile_ctx,
            "style": style_ctx, "internal": internal_ctx, "sources": sources_ctx,
        })
    started = time.perf_counter()
    try:
        resp = oai.chat.completions.create(
            model="gpt-5.5", messages=msgs, response_format=_NURI_RESPONSE_FORMAT,
            **_reply_model_kwargs(),
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
    sources_ctx: str = "", will_suggest_tasks: bool = False,
    metrics: Optional["_TurnMetrics"] = None,
):
    """Yield ("delta", chunk) as the reply text arrives, then ("final", reply)."""
    if not aoai:
        yield "final", {"text": "AI 暂时不可用。", "quick_replies": [], "cited": []}
        return
    msgs = _nuri_messages(history, card_ctx, memory_ctx, profile_ctx, style_ctx,
                          internal_ctx, sources_ctx, will_suggest_tasks)
    if metrics:
        metrics.set(model="gpt-5.5")
        metrics.record_prompt(msgs, {
            "card": card_ctx, "memory": memory_ctx, "profile": profile_ctx,
            "style": style_ctx, "internal": internal_ctx, "sources": sources_ctx,
        })
    buf = ""
    sent = 0
    started = time.perf_counter()
    try:
        stream = await aoai.chat.completions.create(
            model="gpt-5.5", messages=msgs, response_format=_NURI_RESPONSE_FORMAT, stream=True,
            **_reply_model_kwargs(),
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
            yield "final", {"text": salvaged, "quick_replies": [], "cited": []}
        else:
            yield "final", dict(_NURI_FALLBACK)

def _card_ctx(card_id: str, gen_cards: list[dict] | None = None) -> str:
    for c in FEED_CARDS + ALT_FEED_CARDS + (gen_cards or []):
        if c["id"] == card_id:
            d = CARD_DETAILS.get(card_id, {})
            body = d.get("body") or c.get("body", "")
            return f"标题：{c['title']}\n摘要：{c['summary']}\n{body}"
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
_LANGUAGE_LABELS = {"zh-CN": "简体中文", "zh-TW": "繁體中文", "en": "English"}


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
    # The app's language switch is a statement of preference, not a hard lock —
    # a parent who types English in a zh-TW UI still wants an English answer.
    lang = _LANGUAGE_LABELS.get(row.get("language"))
    if lang:
        block += (
            f"\n这位家长把界面语言设成了{lang}，默认就用{lang}回复。"
            "但如果他这条消息用的是别的语言或字体，仍然跟随他当下用的那种。"
        )
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
    async def _language():
        # Selected apart from _PROFILE_FIELDS on purpose: this column arrives
        # with privacy_settings_migration.sql, and folding it into the main
        # select would make one missing column drop the whole profile block.
        try:
            r = await anyio.to_thread.run_sync(
                lambda: sb.table("users").select("language")
                .eq("id", user_id).maybe_single().execute()
            )
            return ((r.data if r else None) or {}).get("language") or ""
        except Exception as e:
            print(f"[warn] _load_profile language: {e}")
            return ""
    profile, children, language = await asyncio.gather(_user(), _children(), _language())
    if language:
        profile = {**profile, "language": _normalize_language(language)}
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

def _extract_memories_sync(history: list[dict]) -> dict:
    """Ask a small model what to remember, and what to come back to.

    Two outputs from one call because they are read off the same exchange and a
    second round trip would buy nothing: memories are what stays true about this
    family, follow-ups are what to ask about later.
    """
    if not oai:
        return {"memories": [], "follow_ups": []}
    convo = "\n".join(
        f"{'用户' if m['role'] == 'user' else 'NURI'}: {m.get('text', '')}"
        for m in history[-8:] if m.get("text")
    )
    if not convo.strip():
        return {"memories": [], "follow_ups": []}
    system = (
        "从下面这段育儿助手对话里提取两种东西。两者都没有就都返回空数组，不要勉强凑数。\n\n"
        "memories：值得长期记住的、稳定的事实——长期偏好、过敏史、育儿理念上的坚持、"
        "孩子的持续性状态。不要提取一次性的、当下情绪化的、或还不确定的内容。\n\n"
        "follow_ups：过一段时间值得回头关心一次的事。包括家长提到的有日期的安排"
        "（几号开始托婴、哪天回诊、下周满两岁），也包括正在进行、需要一段时间才看得出结果的事"
        "（在戒尿布、刚换睡眠作息、在试新食材），以及 NURI 自己刚承诺过要之后再看的事。\n"
        "- topic：4-8 字的短标题，同一件事每次都要用同样的写法，这是去重的依据"
        "（例如固定写「托婴适应」，不要一次写「托婴」一次写「上托婴中心的适应」）\n"
        "- note：一句话说清楚要问什么，要带上具体背景，让之后问起来不像罐头问候\n"
        "- due_date：家长明确讲了日期就填 YYYY-MM-DD，没讲就填空字符串。"
        "一段话里出现好几个日期时，填最值得回头关心的那个未来日期"
        "（例如同时提到「7/30 签约」和「9/1 开始托婴」，要问的是入托适应，就填 9/1）\n"
        "- 纯粹的情绪倾诉、已经解决完的事、不需要再追问的闲聊，不要放进来"
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
                            "follow_ups": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        # Short handle, reused as the dedupe key.
                                        "topic": {"type": "string"},
                                        "note": {"type": "string"},
                                        # "" when the parent named no date; the
                                        # topic then decides the interval.
                                        "due_date": {"type": "string"},
                                    },
                                    "required": ["topic", "note", "due_date"],
                                    "additionalProperties": False,
                                },
                            },
                        },
                        "required": ["memories", "follow_ups"],
                        "additionalProperties": False,
                    },
                },
            },
        )
        data = json.loads(resp.choices[0].message.content)
        return {
            "memories": data.get("memories", [])[:5],
            "follow_ups": data.get("follow_ups", [])[:3],
        }
    except Exception as e:
        print(f"[error] _extract_memories_sync failed: {type(e).__name__}: {e}")
        return {"memories": [], "follow_ups": []}

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

# Default gap before checking back, when the parent didn't give a date. Without
# these most follow-ups would never come due: "最近在戒尿布" is worth revisiting
# but carries no deadline of its own. Keyed by the topic words the extractor is
# told to use; anything unmatched falls back to the default.
FOLLOW_UP_INTERVALS = {
    "睡眠": 4, "喂养": 5, "餵養": 5, "副食品": 5, "辅食": 5,
    "就医": 3, "就醫": 3, "生病": 3, "发烧": 2, "發燒": 2, "疫苗": 3,
    "情绪": 7, "情緒": 7, "行为": 7, "行為": 7,
    "发展": 21, "發展": 21, "里程碑": 21,
    "托婴": 14, "托嬰": 14, "入园": 14, "幼儿园": 14, "幼兒園": 14,
    "戒奶": 14, "戒尿布": 14, "断奶": 14, "斷奶": 14,
}
FOLLOW_UP_DEFAULT_DAYS = int(os.getenv("FOLLOW_UP_DEFAULT_DAYS", "7"))
#: Anything not asked within this window of falling due is stale — a parenting
#: situation a month old has usually resolved itself, and asking about it reads
#: as not having been paying attention.
FOLLOW_UP_EXPIRE_DAYS = int(os.getenv("FOLLOW_UP_EXPIRE_DAYS", "30"))


def _follow_up_due_at(item: dict) -> tuple[str, str]:
    """Resolve when to come back to something, and record where the date came
    from. A parent-stated date is used as given; otherwise the topic decides."""
    stated = (item.get("due_date") or "").strip()
    if stated:
        try:
            d = date.fromisoformat(stated[:10])
            # A date already in the past was probably mentioned as history
            # rather than as a plan; check in tomorrow instead of never.
            if d < date.today():
                d = date.today() + timedelta(days=1)
            return datetime.combine(d, dt_time(9, 0), tzinfo=timezone.utc).isoformat(), "stated"
        except (ValueError, TypeError):
            pass
    topic = (item.get("topic") or "") + (item.get("note") or "")
    days = next((v for k, v in FOLLOW_UP_INTERVALS.items() if k in topic), FOLLOW_UP_DEFAULT_DAYS)
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(), "inferred"


async def _upsert_follow_ups(
    items: list[dict], *, user_id: str, source_id: Optional[str],
) -> None:
    """One open follow-up per topic. A parent who mentions 托嬰 across four turns
    should be asked once, not four times — the partial unique index enforces it,
    and this refreshes the existing row rather than failing on the conflict."""
    sb = _get_supabase()
    if not sb or not items:
        return
    now = _now()
    for item in items[:3]:
        topic = (item.get("topic") or "").strip()
        if not topic:
            continue
        due_at, due_source = _follow_up_due_at(item)
        try:
            existing = await anyio.to_thread.run_sync(
                lambda: sb.table("follow_ups").select("id,due_source")
                .eq("user_id", user_id).eq("topic", topic).eq("status", "pending").execute()
            )
            if existing.data:
                row_id = existing.data[0]["id"]
                # Never let an inferred date overwrite one the parent gave.
                patch = {"note": (item.get("note") or "").strip(), "updated_at": now}
                if not (existing.data[0].get("due_source") == "stated" and due_source == "inferred"):
                    patch.update({"due_at": due_at, "due_source": due_source})
                await anyio.to_thread.run_sync(
                    lambda: sb.table("follow_ups").update(patch).eq("id", row_id).execute()
                )
            else:
                row = {
                    "id": str(uuid.uuid4()), "user_id": user_id, "child_id": None,
                    "topic": topic, "note": (item.get("note") or "").strip(),
                    "due_at": due_at, "due_source": due_source,
                    "source_message_id": source_id, "status": "pending",
                    "created_at": now, "updated_at": now,
                }
                await anyio.to_thread.run_sync(
                    lambda: sb.table("follow_ups").insert(row).execute()
                )
        except Exception as e:
            print(f"[warn] _upsert_follow_ups topic={topic}: {e}")


async def _get_follow_up_context(user_id: Optional[str], limit: int = 3) -> str:
    """Open follow-ups that have come due, for the reply prompt.

    This is the quieter of the two channels. The scheduled check-in is what
    makes a parent feel remembered; this one just stops NURI from asking about
    副食品 while the parent is already talking about it, and lets it close the
    loop naturally when they happen to be here anyway.
    """
    if not user_id:
        return ""
    sb = _get_supabase()
    if not sb:
        return ""
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("follow_ups").select("topic,note,due_at")
            .eq("user_id", user_id).eq("status", "pending")
            .lte("due_at", _now()).order("due_at").limit(limit).execute()
        )
        rows = res.data or []
    except Exception as e:
        print(f"[warn] _get_follow_up_context: {e}")
        return ""
    if not rows:
        return ""
    lines = "\n".join(f"- {r['topic']}：{r.get('note') or ''}" for r in rows)
    return (
        "之前聊过、现在到了可以回头关心一下的事：\n" + lines +
        "\n如果和家长这一轮说的自然接得上，就顺势关心一句；接不上就不要硬提，"
        "更不要一次问完好几件。"
    )


async def _take_due_follow_up(user_id: str) -> Optional[dict]:
    """The single oldest due item for this family, expiring anything stale.

    One at a time, deliberately. A family can easily have five things due at
    once — sleep, solids, daycare, a check-up — and a digest of all five is a
    to-do list rather than someone remembering to ask after you.
    """
    sb = _get_supabase()
    if not sb:
        return None
    cutoff = (datetime.now(timezone.utc) - timedelta(days=FOLLOW_UP_EXPIRE_DAYS)).isoformat()
    try:
        # Aged-out items are retired first, so a long-abandoned topic can't sit
        # at the head of the queue blocking everything behind it.
        await anyio.to_thread.run_sync(
            lambda: sb.table("follow_ups").update({"status": "expired", "updated_at": _now()})
            .eq("user_id", user_id).eq("status", "pending").lt("due_at", cutoff).execute()
        )
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("follow_ups").select("id,topic,note,due_at")
            .eq("user_id", user_id).eq("status", "pending")
            .lte("due_at", _now()).order("due_at").limit(1).execute()
        )
        rows = res.data or []
        return rows[0] if rows else None
    except Exception as e:
        print(f"[warn] _take_due_follow_up {user_id}: {e}")
        return None


async def _compose_follow_up_message(nickname: str, item: dict) -> str:
    """Write the check-in in NURI's voice, not from a template.

    Uses the reply model and the accumulated style rules on purpose: a canned
    "关于X，最近怎么样？" would undo the thing this feature exists to create.
    """
    if not oai:
        return ""
    style_ctx = await _get_style_rules_ctx()
    system = (
        NURI_PERSONA + _NURI_EXAMPLES
        + ("\n\n运营团队根据实际反馈持续积累的回复规则，必须遵守：\n" + style_ctx if style_ctx else "")
        + "\n\n现在不是在回复家长，而是你主动想起了之前聊过的一件事，写一则简短的问候。"
        "\n- 只写 2-4 句，不要给建议、不要列点、不要引用来源"
        "\n- 说清楚你记得的是什么，让他知道你不是群发"
        "\n- 以一个好回答的问句结尾"
        "\n- 直接输出正文，不要标题、不要署名"
    )
    user = f"家长称呼：{nickname}\n之前聊过的事：{item['topic']}\n具体情况：{item.get('note') or ''}"
    try:
        resp = await anyio.to_thread.run_sync(
            lambda: oai.chat.completions.create(
                model="gpt-5.5",
                messages=[{"role": "system", "content": system},
                          {"role": "user", "content": user}],
                **_reply_model_kwargs(),
            )
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as e:
        print(f"[warn] _compose_follow_up_message: {e}")
        return ""


async def _mark_follow_up_asked(follow_up_id: str) -> None:
    sb = _get_supabase()
    if not sb:
        return
    try:
        now = _now()
        await anyio.to_thread.run_sync(
            lambda: sb.table("follow_ups")
            .update({"status": "asked", "asked_at": now, "updated_at": now})
            .eq("id", follow_up_id).execute()
        )
    except Exception as e:
        print(f"[warn] _mark_follow_up_asked {follow_up_id}: {e}")


async def _extract_and_upsert_memories(
    history: list[dict], user_id: str, source_id: str, source_type: str = "chat",
) -> None:
    """Runs as a fire-and-forget background task so memory extraction never adds
    latency to the chat reply (or task update) the user is waiting on.

    Follow-ups are extracted by the same call rather than by the router: the
    router runs before the reply exists, and many things worth coming back to
    are ones NURI itself just promised ("等他準備好了再開始也不遲"). Here the
    whole exchange is available, and it costs no extra round trip.
    """
    try:
        extracted = await anyio.to_thread.run_sync(lambda: _extract_memories_sync(history))
        memories = extracted if isinstance(extracted, list) else extracted.get("memories", [])
        await _upsert_memories(memories, user_id=user_id, child_id=None, source_type=source_type, source_id=source_id)
        if isinstance(extracted, dict):
            await _upsert_follow_ups(extracted.get("follow_ups", []), user_id=user_id, source_id=source_id)
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

def _gen_tasks_ai_sync(msgs: list[dict]) -> list[dict]:
    """Generate 2-4 contextual tasks from conversation history via AI."""
    if not oai:
        return []
    history = "\n".join(
        f"{'用户' if m['role'] == 'user' else 'NURI'}: {m.get('text', '')}"
        for m in msgs[-14:]
        if m.get("text") and not (m.get("transition") or {}).get("kind")
    )
    resp = oai.chat.completions.create(
        model="gpt-5.5",
        # Same deliberation budget as the reply. Drafting task cards from a
        # transcript is closer to extraction than to reasoning, and this runs on
        # every turn the router asks for cards.
        **_reply_model_kwargs(),
        messages=[{"role": "user", "content":
            f"根据以下育儿对话，生成2-4个具体可执行的小任务。\n\n{history}\n\n"
            '以JSON返回：{"tasks": [{"title": "任务（20字内）", "scope": "today或week", '
            '"task_type": "interaction|observation|care|selfcare", "description": "一句话任务说明", '
            '"steps": ["具体做法1", "具体做法2"]}]}\n'
            "- 任务必须针对对话中的具体情况，不要泛泛的通用任务\n"
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
        return json.loads(resp.choices[0].message.content).get("tasks", [])[:4]
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
    all_cards = FEED_CARDS + ALT_FEED_CARDS + gen_cards
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
async def get_card_detail(card_id: str):
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
    by_id = {c["id"]: c for c in FEED_CARDS + ALT_FEED_CARDS + gen_cards}
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
@api.post("/chat/sessions")
async def start_session(body: StartChatRequest, uid: Optional[str] = Depends(_opt_uid)):
    card_id = body.card_id
    title = body.title or "和NURI聊天"
    if card_id:
        for c in FEED_CARDS:
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
    already_generated: bool


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
    already_generated = any(
        (m.get("transition") or {}).get("kind") == "task_suggestion"
        for m in msgs if m["role"] == "ai"
    )

    await _maybe_set_title(session, session_id, body, fix_text, user_turns)
    return _Turn(session, owner_uid, user_msg, msgs, context_hints, fix_text, already_generated)


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


async def _scripted_reply(session: dict, session_id: str, already_generated: bool) -> tuple:
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
    if transition and transition.get("kind") == "tasks_generated" and not already_generated:
        transition = {
            "kind": "task_suggestion",
            "tasks": CARD_TASKS.get(script_key, CARD_TASKS["free"]),
        }
    elif transition and transition.get("kind") == "tasks_generated":
        transition = None
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
    rather than a bare tuple because it now carries seven things, and positional
    unpacking of seven was one refactor away from a silent mix-up."""
    card: str
    memory: str
    profile: str
    style: str
    internal: str
    sources: str                       # rendered allow-list, "" when not searching
    route: "TurnRoute"
    search_results: list               # SearchResult objects behind `sources`


async def _route_and_search(
    turn: _Turn, profile_ctx: str, metrics: Optional["_TurnMetrics"],
) -> tuple["TurnRoute", list]:
    """Decide what this turn needs, then fetch it.

    Serial by nature — the search can't start until the router has produced a
    query — but the pair runs concurrently with the other context blocks, so
    only the part that isn't hidden behind them lands on first-token latency.

    Both halves already degrade to "nothing" on failure, so this needs no
    error handling of its own.
    """
    started = time.perf_counter()
    route = await route_turn(
        turn.msgs, client=aoai, child_context=profile_ctx,
        already_generated=turn.already_generated,
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


async def _reply_context(
    turn: _Turn, body: "UserMessageIn", metrics: Optional["_TurnMetrics"] = None,
) -> _ReplyContext:
    """Gather the prompt context blocks. The I/O-bound ones run concurrently
    rather than as serial round trips before the reply starts."""
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
        # Appended to the memory block rather than given its own: both answer
        # "what does NURI already know about this family", and a separate
        # heading would just invite the model to work through it as a checklist.
        memory=(memory_ctx + ("\n\n" + follow_ctx if follow_ctx else "")),
        profile=profile_ctx,
        style=style_ctx,
        internal=internal_ctx,
        sources=sources_prompt_block(results),
        route=route,
        search_results=results,
    )


async def _task_suggestion(
    route: "TurnRoute", msgs: list,
    metrics: Optional["_TurnMetrics"] = None,
) -> Optional[dict]:
    """Draft task cards, when the router asked for them. These are only drafts —
    nothing is persisted to the tasks table until the parent taps "添加计划" on a
    specific card (POST /tasks).

    The gate used to be a boolean the reply model set while writing its answer,
    judged against four subjective sentences, which is why testers said the
    cards appeared with no discernible rule. It is now a dedicated router
    decision with a logged reason (see backend/router.py).

    Generation reads only the conversation, never the reply being written
    alongside it, which is what lets this run concurrently with the reply
    instead of after it. A failure here must never take the reply down — the
    turn just arrives without task cards.
    """
    if not route.suggest_tasks:
        return None
    started = time.perf_counter()
    try:
        task_list = await anyio.to_thread.run_sync(lambda: _gen_tasks_ai_sync(msgs))
    except Exception as e:
        print(f"[warn] task suggestion failed: {type(e).__name__}: {e}")
        if metrics:
            metrics.mark("tasks_ms", started)
        return None
    if metrics:
        metrics.mark("tasks_ms", started)
        metrics.set(suggested_tasks=bool(task_list))
    return {"kind": "task_suggestion", "tasks": task_list} if task_list else None


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

    sources: list = []

    if turn.fix_text:
        ai_text = await _fix_reply(turn.msgs, turn.fix_text)
    elif oai:
        rc = await _reply_context(turn, body, metrics)
        # Task drafting reads only the conversation, so it runs alongside the
        # reply rather than after it — the extra model call no longer adds to
        # the turn's wall time.
        reply, transition = await asyncio.gather(
            anyio.to_thread.run_sync(
                lambda: _nuri_reply_sync(
                    turn.msgs, rc.card, rc.memory, rc.profile, rc.style,
                    rc.internal, rc.sources, rc.route.suggest_tasks, metrics,
                )
            ),
            _task_suggestion(rc.route, turn.msgs, metrics),
        )
        ai_text = reply["text"]
        quick_replies = reply.get("quick_replies", [])
        sources = _cited_sources(reply.get("cited"), rc.search_results, metrics)
    else:
        ai_text, quick_replies, transition = await _scripted_reply(
            turn.session, session_id, turn.already_generated
        )

    ai_msg = await _persist_ai_turn(session_id, turn, ai_text, quick_replies, transition, sources)

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
        sources: list = []
        try:
            if turn.fix_text:
                ai_text = await _fix_reply(turn.msgs, turn.fix_text)
                yield _sse({"type": "delta", "text": ai_text})
            elif aoai:
                rc = await _reply_context(turn, body, metrics)
                # Started before the first token and awaited after the last, so
                # by the time the text finishes streaming the cards are usually
                # already drafted. Task drafting reads only the conversation, so
                # it doesn't need the reply it's running alongside.
                tasks_job = asyncio.create_task(
                    _task_suggestion(rc.route, turn.msgs, metrics)
                )
                reply = None
                try:
                    async for kind, value in _nuri_reply_stream(
                        turn.msgs, rc.card, rc.memory, rc.profile, rc.style,
                        rc.internal, rc.sources, rc.route.suggest_tasks, metrics,
                    ):
                        if kind == "delta":
                            yield _sse({"type": "delta", "text": value})
                        else:
                            reply = value
                finally:
                    # Even if streaming blew up, the drafting task must be
                    # collected — an orphaned task logs "never retrieved".
                    try:
                        transition = await tasks_job
                    except Exception as e:
                        print(f"[warn] task suggestion failed: {type(e).__name__}: {e}")
                reply = reply or dict(_NURI_FALLBACK)
                ai_text = reply["text"]
                quick_replies = reply.get("quick_replies", [])
                sources = _cited_sources(reply.get("cited"), rc.search_results, metrics)
            else:
                ai_text, quick_replies, transition = await _scripted_reply(
                    turn.session, session_id, turn.already_generated
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
async def list_tasks(scope: Optional[str] = None, uid: Optional[str] = Depends(_opt_uid)):
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
    tasks = [t for t in _tasks if not uid or t.get("user_id") == uid]
    if scope in ("today", "week"):
        tasks = [t for t in tasks if t["scope"] == scope]
    return sorted(tasks, key=lambda t: t["created_at"], reverse=True)

@api.post("/tasks", status_code=201)
async def create_task(body: TaskCreate, uid: Optional[str] = Depends(_opt_uid)):
    due = date.today() + timedelta(days=0 if body.scope == "today" else 7)
    task = {
        "id": str(uuid.uuid4()), "title": body.title, "scope": body.scope,
        "source": "手动添加", "done": False, "progress_done": 0,
        "progress_total": 7 if body.scope == "week" else 1,
        "reflection": None, "created_at": _now(), "completed_at": None,
        "task_type": body.task_type or "interaction",
        "description": body.description or "",
        "steps": body.steps or [],
        "due_date": body.due_date or due.isoformat(),
        "is_favorited": False,
        "backfilled": False,
    }
    if uid:
        task["user_id"] = uid
    sb = _get_supabase()
    if sb and uid:
        try:
            await anyio.to_thread.run_sync(lambda: sb.table("tasks").insert(task).execute())
            return task
        except Exception as e:
            print(f"[warn] create_task insert error: {e}")
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
_DEFAULT_PRIVACY = {
    "allow_history_training": True, "daily_push": True,
    "anonymous_community_share": False, "language": "zh-CN",
}
_PRIVACY_FIELDS = ",".join(_DEFAULT_PRIVACY)

@api.get("/privacy")
async def get_privacy(uid: Optional[str] = Depends(_opt_uid)):
    """Settings live on the users row. They used to live only in `_privacy`, a
    module-level dict — which on serverless means the next request can land on a
    cold instance that never saw the write, so a saved preference silently
    reverted. The dict is still the fallback for local runs without Supabase."""
    sb = _get_supabase()
    if uid and sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("users").select(_PRIVACY_FIELDS)
                .eq("id", uid).maybe_single().execute()
            )
            row = (res.data if res else None) or {}
            if row:
                merged = {**_DEFAULT_PRIVACY, **{k: v for k, v in row.items() if v is not None}}
                merged["language"] = _normalize_language(merged["language"])
                return merged
        except Exception as e:
            print(f"[warn] get_privacy: {e}")
    return _privacy.get(uid or "singleton", _DEFAULT_PRIVACY)

@api.put("/privacy")
async def update_privacy(body: PrivacySettings, uid: Optional[str] = Depends(_opt_uid)):
    settings = body.dict()
    _privacy[uid or "singleton"] = settings
    sb = _get_supabase()
    if uid and sb:
        try:
            await anyio.to_thread.run_sync(
                lambda: sb.table("users").update(settings).eq("id", uid).execute()
            )
        except Exception as e:
            # Surface it. A swallowed failure here is what made the language
            # switch look like it worked and then quietly revert on reload.
            print(f"[warn] update_privacy persist: {e}")
            raise HTTPException(503, "设置暂时无法保存，请稍后再试")
    return settings

@api.post("/privacy/wipe")
async def wipe_all(uid: Optional[str] = Depends(_opt_uid)):
    global _children, _tasks
    if uid:
        _children = [c for c in _children if c.get("user_id") != uid]
        _tasks    = [t for t in _tasks    if t.get("user_id") != uid]
        for sid in [s for s, d in _sessions.items() if d.get("user_id") == uid]:
            _sessions.pop(sid, None); _messages.pop(sid, None)
        _favorites.pop(uid, None); _privacy.pop(uid, None)
    else:
        _children.clear(); _tasks.clear()
        _sessions.clear(); _messages.clear()
        _favorites.clear(); _analytics.clear(); _privacy.clear()
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
            "status,streamed,suggested_tasks,created_at,"
            "route_ok,needs_search,is_medical,search_hits,cited_sources,"
            "route_ms,search_ms"
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
        # The three numbers that say whether external sources are working, and
        # they have to be read together. route_failed high means the router is
        # broken; searched high with cited near zero means search runs but
        # nothing it returns is worth citing — a different problem entirely,
        # and invisible if you only track one of them.
        "route_failed": sum(1 for r in rows if r.get("route_ok") is False),
        "searched": sum(1 for r in rows if r.get("needs_search")),
        "medical": sum(1 for r in rows if r.get("is_medical")),
        "cited": sum(1 for r in rows if (r.get("cited_sources") or 0) > 0),
        "latency_ms": {
            "total": stats("total_ms"),
            "model": stats("model_ms"),
            "context": stats("context_ms"),
            "first_token": stats("first_token_ms"),
            "tasks": stats("tasks_ms"),
            "route": stats("route_ms"),
            "search": stats("search_ms"),
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
        # receiving mail — and the proactive check-ins make that worse, not
        # better. `neq false` rather than `eq true` so rows predating
        # privacy_settings_migration.sql (null) keep their previous behaviour
        # instead of silently going quiet.
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
            # 0. A due follow-up outranks a generic card. This is the whole
            # point of the feature: being asked "9/1 托嬰適應得如何" beats any
            # article, and one family gets at most one of these because the
            # push runs once a day and takes the single oldest item.
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
