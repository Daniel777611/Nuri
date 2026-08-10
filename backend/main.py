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
from backend import llm_usage, locales, memstore, runtime, stores
from backend.feed import delivery as feed_delivery
from backend.feed import signals as feed_signals
from backend.nuri_core import dialogue_reply as core_dialogue_reply
from backend.nuri_core import knowledge_store as core_knowledge_store
from backend.nuri_core import outcome as core_outcome
from backend.nuri_core import outcome_store as core_outcome_store
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
    elapsed_ms as _ms,
    now as _now,
    oai,
)

def _get_supabase():
    """The Supabase handle, resolved through the runtime module every call.

    A wrapper rather than `get_supabase as _get_supabase`, because the import
    form binds the function object: patching `runtime.get_supabase` would then
    reach every store module and silently miss this one, which is the worst
    possible half. One seam, and it is `backend.runtime.get_supabase`.
    """
    return runtime.get_supabase()


# ── App ───────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def _lifespan(_app: FastAPI):
    anyio.to_thread.current_default_thread_limiter().total_tokens = THREAD_LIMIT
    yield

app = FastAPI(title="Family Growth Radar API", lifespan=_lifespan)


@app.middleware("http")
async def _correlate_llm_calls(request: Request, call_next):
    """Give every request an id so the provider calls it fans out into can be
    costed as one unit.

    A single feed preparation reaches the provider up to nine times through
    four layers; without a shared id those are nine unrelated rows and the
    per-action cost — the number that decides whether to cut anything — can't
    be reconstructed."""
    llm_usage.new_request_id()
    llm_usage.set_user(None)
    return await call_next(request)


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
# The Supabase-unavailable fallbacks live in backend/memstore.py. Reached
# through the module rather than bound to local names: a local binding is
# captured at import, so a test that swaps memstore.privacy would leave this
# file reading the original dict while the store layer wrote to the new one —
# a monkeypatch that silently stops applying, which is worse than one that
# fails loudly.



stores.DEFAULT_PRIVACY = {
    "allow_history_training": True,
    "allow_external_content_research": False,
    "daily_push": True,
    "anonymous_community_share": False,
    "language": "zh-CN",
}
stores.PRIVACY_STORAGE_UNAVAILABLE = "_storage_unavailable"

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
    # Every authenticated route passes through here, which makes this the one
    # place that can attribute the whole call tree below it to an account.
    llm_usage.set_user(uid)
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

# The generic persistence layer moved to backend/stores.py, and the
# recommendation-engagement stream — the second half of 4 结果学习模型 — to
# backend/nuri_core/outcome_store.py. Aliased for the routes below.





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



# Chat command Linda (or any whitelisted reviewer) types inline to correct a
# reply: "#fix <什么地方不对>". It never reaches the user — it gets distilled
# into a reusable rule instead. Only accounts listed in fix_reviewers can
# trigger it, or any parent who happens to type "#fix ..." gets hijacked.

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
    llm_usage.record("feed.gen_cards", "gpt-5.5", usage=getattr(resp, "usage", None))
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
        await stores.delete_snapshots(uid)
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
    return [c for c in memstore.children if not uid or c.get("user_id") == uid]

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
    memstore.children.append(child)
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
    for i, c in enumerate(memstore.children):
        if c["id"] == child_id and (not uid or c.get("user_id") == uid):
            memstore.children[i] = {**c, **updates}
            await _invalidate_child_recommendations(uid)
            return memstore.children[i]
    raise HTTPException(404, "child not found")

@api.delete("/children/{child_id}")
async def delete_child(child_id: str, uid: Optional[str] = Depends(_opt_uid)):
    sb = _get_supabase()
    if sb and uid:
        await anyio.to_thread.run_sync(
            lambda: sb.table("children").delete().eq("id", child_id).eq("user_id", uid).execute()
        )
        await _invalidate_child_recommendations(uid)
        return {"ok": True}
    memstore.children[:] = [c for c in memstore.children
                    if not (c["id"] == child_id and (not uid or c.get("user_id") == uid))]
    await _invalidate_child_recommendations(uid)
    return {"ok": True}

# ── Feed ──────────────────────────────────────────────────────────────────────
# The conversation read and the delivery contract moved to backend/feed/.
# Aliased for the route handlers below, which are the last thing left in this
# file that calls them.



@api.get("/feed/personalized")
async def get_personalized_feed(
    count: int = 4,
    presentation: Literal["topic_cards", "category_cards"] = "topic_cards",
    uid: str = Depends(_req_uid),
):
    """Return learning topics tied to this parent's real main conversation."""

    context = await feed_signals.load_recent_main_chat(uid)
    await core_family_store.attach_child_recommendation_context(uid, context)
    has_profile_category_context = bool(
        context.get("help_preference") or context.get("info_source")
    )
    behavior_events = (
        await core_outcome_store.get_events(uid)
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
    items, used_conversation = feed_signals.rank_learning_content(
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
            feed_delivery.category_feed_card(
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
    feed_delivery.log_personalized_feed_decision(uid, context, items)
    urgent_suppressed = feed_delivery.context_requires_urgent_handoff(context)
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
            reviewed = feed_delivery.reviewed_category_resource_pair(
                reviewed_source,
                preferred_locale,
                str(item["content_category"]),
                topic_context,
            )
            item["resource_pair_complete"] = len(reviewed) == 2
        else:
            reviewed = feed_delivery.reviewed_resources_for_context(
                reviewed_source,
                preferred_locale,
                topic_context,
            )
        item["resource_summary"] = summarize_resource_slots(reviewed, preferred_locale)
        item["resource_blueprint"] = feed_delivery.resource_blueprint(item.get("content_category"))
        if item.get("is_dynamic_research_card"):
            if urgent_suppressed:
                item["curation_mode"] = "dynamic_research_suppressed"
                item["resource_status"] = "urgent_suppressed"
            elif not runtime.content_research_oai:
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
                    and runtime.content_research_oai
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
    await feed_delivery.attach_recommendation_snapshots(uid, items, context)
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
        snapshot = await stores.get_snapshot(
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
        and feed_delivery.prepared_snapshot_set_meets_source_contract(snapshots)
    ):
        return {
            "resource_readiness": "ready",
            "prepared_content_set_id": next(iter(ready_set_ids)),
            "recommendation_set_id": next(iter(ready_set_ids)),
            "publication_state": "published",
            "items": feed_delivery.prepare_response_items(snapshots),
        }

    preparing = [
        snapshot
        if prepared_resource_pair(snapshot)
        else snapshot_with_resource_readiness(snapshot, "preparing")
        for snapshot in snapshots
    ]
    if not await stores.persist_snapshots(uid, preparing):
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
        and feed_delivery.prepared_snapshot_set_meets_source_contract(snapshots)
    ):
        return {
            "resource_readiness": "ready",
            "prepared_content_set_id": next(iter(persisted_ready_ids)),
            "recommendation_set_id": next(iter(persisted_ready_ids)),
            "publication_state": "published",
            "items": feed_delivery.prepare_response_items(snapshots),
        }
    first = snapshots[0]
    context = await feed_signals.load_recent_main_chat(
        uid,
        preferred_session_id=first.get("session_id"),
        through_created_at=first.get("context_created_at"),
    )
    await core_family_store.attach_child_recommendation_context(uid, context)
    context = locales.with_requested_preferred_locale(
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
        or feed_delivery.context_requires_urgent_handoff(context)
    ):
        retryable = await feed_delivery.mark_prepare_retryable(uid, snapshots)
        return feed_delivery.prepare_retry_or_previous_payload(retryable)

    behavior_events = await core_outcome_store.get_events(uid)
    ranked, _ = feed_signals.rank_learning_content(
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
    if not card and card_id.startswith(feed_signals.DYNAMIC_RESEARCH_CARD_PREFIX):
        card = feed_signals.restore_dynamic_research_card_from_snapshot(first, include_detail=True)
    if not card:
        retryable = await feed_delivery.mark_prepare_retryable(uid, snapshots)
        return feed_delivery.prepare_retry_or_previous_payload(retryable)
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
    research = await feed_delivery.research_card_detail_resources(
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
        #
        # `retry_failed` rather than `force`: bypassing the *negative* cache is
        # all the above argues for. `force` additionally discarded successful
        # bundles, which meant the most expensive call in the system ran with
        # no cache at all on its hottest path.
        retry_failed=True,
        call_label="prepare",
    )
    resources = feed_delivery.attach_featured_evidence_anchor(
        list((research or {}).get("resources") or [])
    )
    pairs_by_category = {
        category: feed_delivery.delivery_contract_pair(
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
        dynamic_diagnostics = feed_delivery.delivery_gate_diagnostics(
            resources,
            preferred_locale,
        )
        reviewed = reviewed_learning_resource_bundle(
            card=card,
            preferred_locale=preferred_locale,
        )
        reviewed_resources = feed_delivery.attach_featured_evidence_anchor(
            list((reviewed or {}).get("resources") or [])
        )
        reviewed_pairs = {
            category: feed_delivery.delivery_contract_pair(
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
            fallback_diagnostics = feed_delivery.delivery_gate_diagnostics(
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
            retryable = await feed_delivery.mark_prepare_retryable(uid, snapshots)
            return feed_delivery.prepare_retry_or_previous_payload(retryable)

    # Publish one coherent source mode. A provider result uses fresh cited
    # destinations; a provider outage may use only the exact manually verified
    # whitelist lane. Legacy reviewed-library resources cannot enter either.
    option_pool = list(resources)
    option_pool = feed_delivery.attach_featured_evidence_anchor(option_pool)

    def build_pair_options(pool: list[dict]) -> dict[str, list[list[dict]]]:
        options: dict[str, list[list[dict]]] = {}
        used_category_orgs: set[str] = set()
        for category in CONTENT_CATEGORIES:
            category_options = feed_delivery.category_resource_pair_options(
                pool,
                category,
                excluded_primary_orgs=used_category_orgs,
                preferred_locale=preferred_locale,
                require_dynamic=not reviewed_fallback_used,
            )
            options[category] = category_options
            if category_options:
                used_category_orgs.update(
                    feed_delivery.resource_parent_org_id(resource)
                    for pair in category_options
                    for resource in pair
                    if feed_delivery.resource_parent_org_id(resource)
                )
        return options

    pair_options_by_category = build_pair_options(option_pool)

    # There used to be a loop here that searched up to two further bundles so a
    # later "换一个" could switch between prepared pairs instead of waiting.
    #
    # It was removed because it fired on nearly every preparation and was not
    # actually in the background. A pair is one article crossed with one video,
    # and the primary bundle's floor is exactly one of each per category, so
    # `len(options) < 2` held unless the model returned a third item in all
    # three categories — the maximum bundle. Each iteration was another full
    # research run (a bundle plus up to two repair passes), awaited inside the
    # request, which put up to six extra provider calls on a request that had
    # already published a complete set.
    #
    # The alternative it existed to avoid is not that bad: with no second pair,
    # the refresh route below falls through to a live search. That pays for one
    # research run when a parent actually taps, instead of pre-paying for six on
    # every preparation against the chance that someone might.

    if any(not options for options in pair_options_by_category.values()):
        print(
            json.dumps(
                {
                    "event": "content_research.pair_options_incomplete",
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
        retryable = await feed_delivery.mark_prepare_retryable(uid, snapshots)
        return feed_delivery.prepare_retry_or_previous_payload(retryable)

    content_set_id = feed_delivery.prepared_content_set_id(snapshots, option_pool)
    prepared = [
        snapshot_with_prepared_resource_pairs(
            snapshot,
            pair_options_by_category[str(snapshot["content_category"])],
            content_set_id=content_set_id,
        )
        for snapshot in snapshots
    ]
    if not await stores.persist_snapshots(uid, prepared):
        await feed_delivery.mark_prepare_retryable(uid, snapshots)
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
                            "parent_org_id": feed_delivery.resource_parent_org_id(resource),
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
        "items": feed_delivery.prepare_response_items(prepared),
    }


@api.get("/feed")
async def get_feed(shuffle: bool = False):
    gen_cards = await stores.get_gen_cards()
    cards = list(FEED_CARDS) + gen_cards
    if shuffle:
        random.shuffle(cards)
    return cards

@api.get("/feed/alt")
async def get_alt_card(exclude: str = ""):
    gen_cards = await stores.get_gen_cards()
    exclude_ids = {e for e in exclude.split(",") if e}
    pool = [c for c in (FEED_CARDS + ALT_FEED_CARDS + gen_cards) if c["id"] not in exclude_ids]
    if not pool:
        pool = list(ALT_FEED_CARDS)
    return random.choice(pool)

@api.get("/feed/search")
async def search_feed(q: str = "", type: Optional[str] = None):
    gen_cards = await stores.get_gen_cards()
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
    feed_mode = await stores.get_feed_mode()
    if feed_mode == "alt":
        pool = list(FEED_CARDS + ALT_FEED_CARDS)
        random.shuffle(pool)
        return pool[:body.count]
    keywords = list(body.keywords or [])
    if not keywords and body.session_id and oai:
        msgs = memstore.messages.get(body.session_id, [])
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
                llm_usage.record(
                    "feed.keywords", "gpt-5.4-mini",
                    usage=getattr(kw_resp, "usage", None),
                )
                keywords = [k.strip() for k in kw_resp.choices[0].message.content.split(",") if k.strip()][:5]
            except Exception:
                pass
    if not keywords:
        keywords = ["婴幼儿发展", "育儿健康", "早期教育"]
    new_cards = await anyio.to_thread.run_sync(
        lambda: _gen_feed_cards_sync(keywords, body.count)
    )
    await stores.save_gen_cards(new_cards)
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
    is_dynamic_request = card_id.startswith(feed_signals.DYNAMIC_RESEARCH_CARD_PREFIX)
    if card_id in LEARNING_CONTENT_BY_ID or is_dynamic_request:
        snapshot = (
            await stores.get_snapshot(uid, recommendation_id)
            if uid and recommendation_id
            else None
        )
        if recommendation_id and not snapshot:
            raise HTTPException(404, "recommendation not found")
        if snapshot and snapshot.get("card_id") != card_id:
            raise HTTPException(404, "recommendation not found")
        snapshot_source_contract_ready = bool(
            snapshot
            and feed_delivery.prepared_snapshot_set_meets_source_contract([snapshot])
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
            context = await feed_signals.load_recent_main_chat(
                uid,
                preferred_session_id=session_id,
                through_created_at=context_created_at,
            )
            await core_family_store.attach_child_recommendation_context(uid, context)
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
        context = locales.with_requested_preferred_locale(context, selected_locale)
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
        ranked, _ = feed_signals.rank_learning_content(
            context.get("messages") or [],
            count=len(LEARNING_CONTENT_CARDS),
            session_id=context.get("session_id"),
            context_created_at=context.get("context_created_at"),
            context_state=context.get("state", "no_history"),
            include_detail=True,
            behavior_events=(
                await core_outcome_store.get_events(uid)
                if uid and context.get("state") == "ready"
                else []
            ),
        )
        card = next((item for item in ranked if item["id"] == card_id), None)
        if not card and snapshot and is_dynamic_request:
            card = feed_signals.restore_dynamic_research_card_from_snapshot(
                snapshot,
                include_detail=True,
            )
        if not card:
            raise HTTPException(404, "card not found")
        if context.get("child_age_context"):
            card["child_age_context"] = context["child_age_context"]
        if selected_content_category in CONTENT_CATEGORIES:
            meta = feed_delivery.CATEGORY_CARD_META[str(selected_content_category)]
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
            card["resources"] = feed_delivery.reviewed_category_resource_pair(
                card.get("resources", []),
                preferred_locale,
                str(selected_content_category),
                card if apply_recommendation_context else None,
            )
            card["resource_pair_complete"] = len(card["resources"]) == 2
        else:
            card["resources"] = feed_delivery.reviewed_resources_for_context(
                card.get("resources", []),
                preferred_locale,
                card if apply_recommendation_context else None,
            )
        urgent_suppressed = feed_delivery.context_requires_urgent_handoff(context)
        research_eligible = bool(
            uid
            and runtime.content_research_oai
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
                await feed_delivery.record_resource_delivery(
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
            and runtime.content_research_oai
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
            await feed_delivery.record_resource_delivery(
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
        card["resource_blueprint"] = feed_delivery.resource_blueprint(selected_content_category)
        card["resource_summary"] = summarize_resource_slots(
            card["resources"], preferred_locale
        )
        feed_delivery.decorate_delivery_card(card, card["resources"])
        return card

    gen_cards = await stores.get_gen_cards()
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
        and not card_id.startswith(feed_signals.DYNAMIC_RESEARCH_CARD_PREFIX)
    ):
        raise HTTPException(404, "card not found")
    snapshot = await stores.get_snapshot(uid, recommendation_id)
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
    context = await feed_signals.load_recent_main_chat(
        uid,
        preferred_session_id=session_id,
        through_created_at=context_created_at,
    )
    await core_family_store.attach_child_recommendation_context(uid, context)
    # Category-card snapshots keep the language selected by the account at feed
    # generation time.  Legacy clients may still use the old request override.
    selected_locale = (
        str(snapshot.get("preferred_locale") or "") if snapshot else ""
    ) or preferred_locale
    context = locales.with_requested_preferred_locale(context, selected_locale)
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
    if feed_delivery.context_requires_urgent_handoff(context):
        return {"research_status": "urgent_suppressed"}
    ranked, _ = feed_signals.rank_learning_content(
        context.get("messages") or [],
        count=len(LEARNING_CONTENT_CARDS),
        session_id=context.get("session_id"),
        context_created_at=context.get("context_created_at"),
        context_state=context.get("state", "no_history"),
        include_detail=True,
        behavior_events=(
            await core_outcome_store.get_events(uid)
            if context.get("state") == "ready"
            else []
        ),
    )
    card = next((item for item in ranked if item["id"] == card_id), None)
    if (
        not card
        and snapshot
        and card_id.startswith(feed_signals.DYNAMIC_RESEARCH_CARD_PREFIX)
    ):
        card = feed_signals.restore_dynamic_research_card_from_snapshot(
            snapshot,
            include_detail=True,
        )
    if not card:
        raise HTTPException(404, "card not found")
    if context.get("child_age_context"):
        card["child_age_context"] = context["child_age_context"]
    if selected_content_category in CONTENT_CATEGORIES:
        meta = feed_delivery.CATEGORY_CARD_META[str(selected_content_category)]
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
        if snapshot and feed_delivery.prepared_snapshot_set_meets_source_contract([snapshot])
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
            if not await stores.persist_snapshots(uid, [switched]):
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE,
                    "Prepared resources could not be persisted",
                )
            switched_pairs = prepared_resource_pairs(switched)
            active_resources = prepared_resource_pair(switched) or []
            await core_outcome_store.append_events(
                uid,
                [
                    core_outcome_store.new_event(
                        event="content_refresh",
                        card_id=card_id,
                        recommendation_id=recommendation_id,
                        content_category=str(selected_content_category or ""),
                        locale=str(context.get("preferred_locale") or "zh-CN"),
                    )
                ],
            )
            await feed_delivery.record_resource_delivery(
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
                "resource_blueprint": feed_delivery.resource_blueprint(selected_content_category),
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
        await core_outcome_store.append_events(
            uid,
            [
                core_outcome_store.new_event(
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
    # `call_label` belongs in here for the same reason — the plain detail load
    # gets its label from the callee's default rather than a fourth kwarg.
    if refresh or extra_excluded_urls:
        research_kwargs.update(
            force=refresh,
            extra_excluded_urls=extra_excluded_urls,
            call_label="detail_refresh" if refresh else "detail",
        )
    research = await feed_delivery.research_card_detail_resources(**research_kwargs)
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
                "resource_blueprint": feed_delivery.resource_blueprint(
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
                "resource_blueprint": feed_delivery.resource_blueprint(selected_content_category),
            }
        if card.get("is_dynamic_research_card"):
            return {
                "resources": [],
                "research_status": "unavailable",
                "fallback_reason": "no_complete_verified_bundle",
                "resource_blueprint": feed_delivery.resource_blueprint(selected_content_category),
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
            reviewed_resources = feed_delivery.reviewed_resources_for_context(
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
            "resource_blueprint": feed_delivery.resource_blueprint(selected_content_category),
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
            "resource_blueprint": feed_delivery.resource_blueprint(selected_content_category),
            "resource_summary": summarize_resource_slots([], preferred_locale),
        }
    if selected_content_category in CONTENT_CATEGORIES:
        live_pair = feed_delivery.delivery_contract_pair(
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
                "resource_blueprint": feed_delivery.resource_blueprint(selected_content_category),
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
        core_outcome_store.new_event(
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
        await core_outcome_store.append_events(uid, resource_events)
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
        "resource_blueprint": feed_delivery.resource_blueprint(selected_content_category),
        "resource_summary": summarize_resource_slots(resources, preferred_locale),
    }

# ── Collections ───────────────────────────────────────────────────────────────
MAX_COLLECTIONS = 12

@api.get("/collections")
async def list_collections(uid: Optional[str] = Depends(_opt_uid)):
    return await stores.list_collections(uid or "anon")

@api.post("/collections")
async def create_collection(body: CollectionCreate, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    existing = await stores.list_collections(key)
    if len(existing) >= MAX_COLLECTIONS:
        raise HTTPException(400, f"已达上限，最多创建 {MAX_COLLECTIONS} 个收藏夹")
    col = await stores.create_collection(key, body.name)
    return col

@api.put("/collections/{col_id}")
async def rename_collection(col_id: str, body: CollectionRename, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    ok = await stores.rename_collection(key, col_id, body.name)
    if not ok:
        raise HTTPException(404, "收藏夹不存在")
    return {"id": col_id, "name": body.name}

@api.delete("/collections/{col_id}")
async def delete_collection(col_id: str, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    await stores.delete_collection(key, col_id)
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
            ids = memstore.favorites.get(key, set())
            col_map = memstore.fav_cols.get(key, {})
    else:
        ids = memstore.favorites.get(key, set())
        col_map = memstore.fav_cols.get(key, {})
    gen_cards = await stores.get_gen_cards()
    by_id = {
        c["id"]: c
        for c in FEED_CARDS + ALT_FEED_CARDS + LEARNING_CONTENT_CARDS + gen_cards
    }
    return [{**by_id[cid], "collection_id": col_map.get(cid)} for cid in ids if cid in by_id]

@api.post("/favorites/toggle")
async def toggle_favorite(body: FavToggle, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    favorited = await stores.toggle_fav(key, body.card_id)
    return {"favorited": favorited, "card_id": body.card_id}

@api.post("/favorites/save")
async def save_favorite(body: FavSave, uid: Optional[str] = Depends(_opt_uid)):
    key = uid or "anon"
    saved = await stores.save_fav(key, body.card_id, body.collection_id)
    return {"saved": saved, "card_id": body.card_id, "collection_id": body.collection_id}

# ── Analytics ─────────────────────────────────────────────────────────────────
@api.post("/analytics")
async def track_event(ev: AnalyticsIn):
    memstore.analytics.append({**ev.dict(), "ts": _now()})
    return {"ok": True}


@api.post("/recommendations/events", status_code=status.HTTP_202_ACCEPTED)
async def track_recommendation_event(
    body: RecommendationEventIn,
    uid: str = Depends(_req_uid),
):
    """Persist a bounded recommendation signal without conversation text/PII."""

    privacy = await stores.get_privacy(uid, fail_closed=True)
    if privacy.get(stores.PRIVACY_STORAGE_UNAVAILABLE):
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
    _, persisted = await core_outcome_store.append_events(uid, [normalized])
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
        for session in memstore.sessions.values()
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
        for message in memstore.messages.get(session_id, [])
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

    session_messages = memstore.messages.get(session["id"], [])
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


async def _existing_session_for(uid: str) -> Optional[dict]:
    """The account's one conversation, if it has been created already."""
    sb = _get_supabase()
    if sb:
        try:
            res = await anyio.to_thread.run_sync(
                lambda: sb.table("chat_sessions").select("*")
                .eq("user_id", uid).order("created_at").limit(1).execute()
            )
            return (res.data or [None])[0]
        except Exception as e:
            print(f"[warn] existing_session_for: {e}")
            return None
    return next(
        (s for s in memstore.sessions.values() if s.get("user_id") == uid), None
    )


@api.post("/chat/sessions")
async def start_session(body: StartChatRequest, uid: Optional[str] = Depends(_opt_uid)):
    # A parent has one conversation, for the life of the account, holding
    # everything they have ever said. This route used to insert a row every time
    # it was called and leave the client to decide whether it wanted one, which
    # it did by listing sessions and picking the first without a source_card_id
    # — so two requests that raced each made their own. Accounts accumulated up
    # to nine, each opening with its own model-written greeting: five such calls
    # on gpt-5.5 in one afternoon, 42% of the day's tokens, for conversations
    # nobody asked to start.
    #
    # Returning what already exists makes the route idempotent, which is what
    # the client was trying and failing to achieve from the outside.
    # one_session_per_user_migration.sql enforces it underneath.
    if uid:
        existing = await _existing_session_for(uid)
        if existing:
            return existing

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
            # The check above is not atomic, so two first-ever requests from one
            # account can both reach here. The unique index lets exactly one
            # win; the loser must adopt that row rather than fall back to
            # memory, or the account ends up with two conversations again —
            # which is the whole failure this route exists to prevent.
            if uid:
                winner = await _existing_session_for(uid)
                if winner:
                    return winner
            print(f"[warn] start_session insert error: {e}")
            memstore.sessions[session["id"]] = session
            memstore.messages[session["id"]] = []
    else:
        memstore.sessions[session["id"]] = session
        memstore.messages[session["id"]] = []

    # Fetch profile info for a personalised greeting and ongoing context
    profile, children = await core_family_store.load_profile(uid)
    nickname = profile.get("nickname", "")
    profile_ctx = core_family_store.profile_ctx(profile, children)

    gen_cards = await stores.get_gen_cards()
    ctx = _card_ctx(card_id, gen_cards) if card_id else ""
    style_ctx = await core_dialogue_reply.get_style_rules_ctx()
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
            lambda: core_dialogue_reply.nuri_reply_sync([{"role": "user", "text": intro_prompt}], "", "", profile_ctx, style_ctx)
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
        memstore.messages[session["id"]].append(first_msg)

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
    sessions = list(memstore.sessions.values())
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
    memstore.sessions.pop(session_id, None)
    memstore.messages.pop(session_id, None)

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
    return memstore.messages.get(session_id, [])

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
        session = memstore.sessions.get(session_id)
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

    profile, children = await core_family_store.load_profile(owner_uid)
    context_hints = dict(profile)
    if children:
        context_hints["children"] = children
    await core_family_store.save_normalized_input(
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
        msgs = memstore.messages.setdefault(session_id, [])
        msgs.append(user_msg)

    # "#fix <反馈>" is an internal command for reviewers to correct the AI's
    # last reply — it never reaches the parent as a normal turn. See
    # core_dialogue_reply.distill_style_rule_sync / nuri_style_rules.
    fix_text = None
    stripped_text = (body.text or "").strip()
    if stripped_text.startswith(core_dialogue_reply.FIX_KEYWORD) and await core_dialogue_reply.is_fix_reviewer(owner_uid):
        fix_text = stripped_text[len(core_dialogue_reply.FIX_KEYWORD):].strip()

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
                llm_usage.record(
                    "chat.session_title", "gpt-5.4-mini",
                    usage=getattr(title_resp, "usage", None),
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
            elif session_id in memstore.sessions:
                memstore.sessions[session_id]["title"] = new_title

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
    rule = await anyio.to_thread.run_sync(lambda: core_dialogue_reply.distill_style_rule_sync(prior_ai_text, fix_text))
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
            gen_cards=stores.get_gen_cards,
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
        history_window=core_dialogue_reply.HISTORY_WINDOW,
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
    profile_ctx = core_family_store.profile_ctx(turn.context_hints, turn.context_hints.get("children"))
    gen_cards, memory_ctx, follow_ctx, style_ctx, internal_ctx, routed = await asyncio.gather(
        stores.get_gen_cards(),
        core_family_store.get_memory_context(turn.owner_uid),
        core_family_store.get_follow_up_context(turn.owner_uid),
        core_dialogue_reply.get_style_rules_ctx(),
        anyio.to_thread.run_sync(core_knowledge_store.internal_rules_ctx, body.text or ""),
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
    core_dialogue_reply.nuri_messages concatenate the blocks the old way."""
    if rc.plan is None:
        return None, None
    return rc.plan.system_prompt(core_dialogue_reply.NURI_PERSONA + core_dialogue_reply.NURI_JSON_SUFFIX), rc.plan.history_window


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
    if not allow or core_dialogue_reply.user_declined_tasks(user_text) or core_dialogue_reply.urgent_task_suppressed(user_text, ai_text):
        return None
    explicit_request = core_dialogue_reply.user_requested_tasks(user_text)
    task_list = core_dialogue_reply.normalize_task_proposals(reply.get("task_proposals"))
    if not (explicit_request or reply.get("suggest_tasks")):
        return None

    requested_count = core_dialogue_reply.requested_task_count(user_text) if explicit_request else None
    if requested_count and task_list:
        task_list = task_list[:requested_count]

    started = time.perf_counter()
    if not task_list or (requested_count and len(task_list) < requested_count):
        task_context = msgs + [{"role": "ai", "text": ai_text}]
        try:
            fallback_tasks = await anyio.to_thread.run_sync(
                lambda: core_dialogue_reply.gen_tasks_ai_sync(task_context, requested_count)
            )
            task_list = core_dialogue_reply.normalize_task_proposals(task_list + fallback_tasks)
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
            lambda: core_dialogue_reply.nuri_reply_sync(
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
            core_family.extract_and_upsert_memories, turn.msgs + [ai_msg], turn.owner_uid, session_id
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
                async for kind, value in core_dialogue_reply.nuri_reply_stream(
                    turn.msgs, rc.card, rc.memory, rc.profile, rc.style,
                    rc.internal, rc.sources, metrics, system_prompt, history_window,
                ):
                    if kind == "delta":
                        yield _sse({"type": "delta", "text": value})
                    else:
                        reply = value
                reply = reply or dict(core_dialogue_reply.NURI_FALLBACK)
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
            await core_family.extract_and_upsert_memories(*args)

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
    tasks = [t for t in memstore.tasks if t.get("user_id") == uid]
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
        existing = next((item for item in memstore.tasks if item["id"] == task_id), None)
        if existing:
            return existing
    memstore.tasks.append(task)
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
                        core_family.extract_and_upsert_memories,
                        [{"role": "user", "text": reflection_text}], uid, task_id, "task_reflection",
                    )
                return result
            return t
        except HTTPException:
            raise
        except Exception as e:
            print(f"[warn] update_task error: {e}")
    for t in memstore.tasks:
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
    memstore.tasks[:] = [t for t in memstore.tasks if t["id"] != task_id]

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
    memstore.tasks[:] = [
        t for t in memstore.tasks
        if not (t.get("user_id", uid) == uid and t.get("done") and not t.get("is_favorited"))
    ]
    return {"ok": True}

@api.get("/tasks/insights")
async def task_insights(uid: Optional[str] = Depends(_opt_uid)):
    sb = _get_supabase()
    source: list = memstore.tasks
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
    settings = await stores.get_privacy(uid, fail_closed=bool(uid))
    if settings.get(stores.PRIVACY_STORAGE_UNAVAILABLE):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Privacy settings are temporarily unavailable",
        )
    return stores.normalized_privacy_settings(settings)

@api.put("/privacy")
async def update_privacy(body: PrivacySettings, uid: Optional[str] = Depends(_opt_uid)):
    settings = await stores.set_privacy(uid, body.model_dump())
    if uid and settings.get("allow_history_training") is False:
        await stores.delete_snapshots(uid)
        await core_outcome_store.delete_events(uid)
    return settings

@api.post("/privacy/wipe")
async def wipe_all(uid: Optional[str] = Depends(_opt_uid)):
    if uid:
        # Keep an explicit opt-out tombstone instead of deleting the privacy
        # row.  If any later deletion fails, history must remain disabled rather
        # than falling back to the default-on setting while user data survives.
        await stores.set_privacy(
            uid,
            {
                "allow_history_training": False,
                "allow_external_content_research": False,
                "daily_push": False,
                "anonymous_community_share": False,
                "language": "zh-CN",
            },
        )
        await stores.delete_snapshots(uid)
        await core_outcome_store.delete_events(uid)
        memstore.children[:] = [c for c in memstore.children if c.get("user_id") != uid]
        memstore.tasks[:]    = [t for t in memstore.tasks    if t.get("user_id") != uid]
        for sid in [s for s, d in memstore.sessions.items() if d.get("user_id") == uid]:
            memstore.sessions.pop(sid, None); memstore.messages.pop(sid, None)
        memstore.favorites.pop(uid, None)
    else:
        memstore.children.clear(); memstore.tasks.clear()
        memstore.sessions.clear(); memstore.messages.clear()
        memstore.favorites.clear(); memstore.analytics.clear(); memstore.privacy.clear()
        memstore.recommendation_snapshots.clear()
        memstore.recommendation_events.clear(); memstore.recommendation_event_locks.clear()
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
    internal_ctx = core_knowledge_store.internal_rules_ctx(question)
    system = (core_dialogue_reply.NURI_PERSONA
              + "\n\n以下是本次對話的參考文獻節錄，可作為輔助依據。NURI 應優先運用自身的兒童發展與育兒專業知識作答，文獻內容僅供參考補充。無論文獻是否涵蓋問題，都請盡力提供有幫助的回應，避免直接回答「我不知道」或「抱歉，我無法回答」。\n"
              + citation)
    if internal_ctx:
        system += f"\n\n{internal_ctx}"
    resp = oai.chat.completions.create(
        model="gpt-5.5",
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": f"問題：{question}\n\n參考文獻：\n{context}"}],
    )
    llm_usage.record("legacy.ask", "gpt-5.5", usage=getattr(resp, "usage", None))
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
    already, total = await anyio.to_thread.run_sync(core_knowledge_store.is_indexed, doc_id)
    if already:
        return {"doc_id": doc_id, "total_chunks": total, "namespace": VECTOR_NAMESPACE, "already_indexed": True}
    text   = await anyio.to_thread.run_sync(core_knowledge_store.read_pdf, pdf_bytes)
    chunks = await anyio.to_thread.run_sync(core_knowledge_store.chunk_text, text)
    total  = await anyio.to_thread.run_sync(core_knowledge_store.upsert_doc, doc_id, chunks)
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
    already, total = await anyio.to_thread.run_sync(core_knowledge_store.is_indexed, doc_id)
    if already:
        return {"doc_id": doc_id, "total_chunks": total, "namespace": VECTOR_NAMESPACE, "already_indexed": True}
    text   = await anyio.to_thread.run_sync(core_knowledge_store.read_pdf, pdf_bytes)
    chunks = await anyio.to_thread.run_sync(core_knowledge_store.chunk_text, text)
    total  = await anyio.to_thread.run_sync(core_knowledge_store.upsert_doc, doc_id, chunks)
    return {"doc_id": doc_id, "total_chunks": total, "namespace": VECTOR_NAMESPACE, "already_indexed": False}

@app.post("/ask")
async def ask(req: AskRequest):
    if not _get_supabase():
        raise HTTPException(503, "Supabase not configured")
    if not oai:
        raise HTTPException(503, "OpenAI not configured")
    chunks, scores = await anyio.to_thread.run_sync(core_knowledge_store.retrieve, req.question, req.top_k, req.doc_id)
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
# core_dialogue_reply.get_style_rules_ctx / core_dialogue_reply.nuri_reply_sync）。
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

# 允许使用聊天里 "#fix" 指令的账号白名单，见 core_dialogue_reply.is_fix_reviewer。
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


# ── Provider spend ───────────────────────────────────────────────────────────
# chat_turn_logs answers "was that turn slow". These answer "where did the
# money go", which turned out to be a different question with a different
# answer: the reply model is a minority of the bill, and the calls that are not
# a chat turn at all had never been counted.

def _llm_price_table() -> dict[str, tuple[float, float]]:
    """USD per million tokens, as {model: [input, output]}, from LLM_PRICE_TABLE.

    Deliberately env-configured with no built-in defaults. Hardcoding a price
    list means it is wrong the first time a rate changes, and a confidently
    wrong cost column is worse than an absent one — the token counts below are
    measured, and anything derived from them should be visibly a local
    assumption. Ranking by tokens works with this unset.
    """
    raw = os.getenv("LLM_PRICE_TABLE", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        table: dict[str, tuple[float, float]] = {}
        for model, pair in parsed.items():
            table[str(model)] = (float(pair[0]), float(pair[1]))
        return table
    except Exception as e:
        print(f"[warn] LLM_PRICE_TABLE ignored ({type(e).__name__}: {e})")
        return {}


@app.get("/admin/llm-usage/summary")
async def admin_llm_usage_summary(
    days: int = 7, user_id: Optional[str] = None, sample: int = 5000,
    _: None = Depends(_require_admin),
):
    """Total provider spend for a window, broken down by call site and model."""
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    days = max(1, min(days, 90))
    sample = max(1, min(sample, 20000))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

    def _query():
        q = sb.table("llm_call_logs").select(
            "call_site,model,api,request_id,duration_ms,prompt_tokens,"
            "completion_tokens,total_tokens,reasoning_tokens,cached_prompt_tokens,"
            "tool_calls,status,created_at"
        ).gte("created_at", since)
        if user_id:
            q = q.eq("user_id", user_id)
        return q.order("created_at", desc=True).limit(sample).execute()

    try:
        res = await anyio.to_thread.run_sync(_query)
    except Exception as e:
        raise HTTPException(503, f"llm usage unavailable: {e}")
    rows = getattr(res, "data", None) or []

    prices = _llm_price_table()

    def cost(row: dict) -> Optional[float]:
        price = prices.get(str(row.get("model") or ""))
        if not price:
            return None
        prompt_in = int(row.get("prompt_tokens") or 0)
        cached = int(row.get("cached_prompt_tokens") or 0)
        # Cached input bills at a fraction; without splitting it out, a working
        # cache looks like no saving at all.
        fresh = max(0, prompt_in - cached)
        return (
            fresh * price[0] / 1_000_000
            + cached * price[0] * 0.1 / 1_000_000
            + int(row.get("completion_tokens") or 0) * price[1] / 1_000_000
        )

    def blank() -> dict:
        return {
            "calls": 0, "errors": 0, "prompt_tokens": 0, "completion_tokens": 0,
            "reasoning_tokens": 0, "cached_prompt_tokens": 0, "total_tokens": 0,
            "tool_calls": 0, "duration_ms": 0, "cost_usd": 0.0, "priced_calls": 0,
        }

    def accumulate(bucket: dict, row: dict) -> None:
        bucket["calls"] += 1
        if row.get("status") != "ok":
            bucket["errors"] += 1
        for field in (
            "prompt_tokens", "completion_tokens", "reasoning_tokens",
            "cached_prompt_tokens", "total_tokens", "tool_calls", "duration_ms",
        ):
            bucket[field] += int(row.get(field) or 0)
        row_cost = cost(row)
        if row_cost is not None:
            bucket["cost_usd"] += row_cost
            bucket["priced_calls"] += 1

    by_site: dict[str, dict] = {}
    by_model: dict[str, dict] = {}
    by_request: dict[str, dict] = {}
    overall = blank()
    for row in rows:
        accumulate(overall, row)
        accumulate(by_site.setdefault(str(row.get("call_site") or "?"), blank()), row)
        accumulate(by_model.setdefault(str(row.get("model") or "?"), blank()), row)
        rid = str(row.get("request_id") or "")
        if rid:
            accumulate(by_request.setdefault(rid, blank()), row)

    def finish(bucket: dict) -> dict:
        out = dict(bucket)
        out["cost_usd"] = round(out["cost_usd"], 4) if out["priced_calls"] else None
        out["avg_tool_calls"] = (
            round(out["tool_calls"] / out["calls"], 1) if out["calls"] else 0
        )
        # The share that decides what to cut. Falls back to tokens when no price
        # table is configured, so the ranking is never empty.
        basis = out["cost_usd"] if out["cost_usd"] is not None else out["total_tokens"]
        total_basis = (
            overall["cost_usd"] if overall["priced_calls"] else overall["total_tokens"]
        )
        out["share"] = round(basis / total_basis, 4) if total_basis else 0
        return out

    def ranked(buckets: dict[str, dict], key: str) -> list[dict]:
        return sorted(
            ({key: name, **finish(bucket)} for name, bucket in buckets.items()),
            key=lambda item: item["total_tokens"],
            reverse=True,
        )

    overall_out = finish(overall)
    return {
        "window_days": days,
        "sampled_calls": len(rows),
        "truncated": len(rows) >= sample,
        "pricing_configured": bool(prices),
        "total": overall_out,
        "by_call_site": ranked(by_site, "call_site"),
        "by_model": ranked(by_model, "model"),
        # One row per HTTP request, worst first: this is what shows a single
        # user action fanning out into a double-digit number of provider calls.
        "worst_requests": sorted(
            (
                {"request_id": rid, **finish(bucket)}
                for rid, bucket in by_request.items()
            ),
            key=lambda item: item["total_tokens"],
            reverse=True,
        )[:20],
    }


@app.get("/admin/llm-usage")
async def admin_list_llm_calls(
    call_site: Optional[str] = None, request_id: Optional[str] = None,
    user_id: Optional[str] = None, status_filter: Optional[str] = None,
    limit: int = 50, offset: int = 0, _: None = Depends(_require_admin),
):
    """Raw provider calls, newest first. Filter by request_id to expand one
    user action into the calls it actually made."""
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    def _query():
        q = sb.table("llm_call_logs").select("*", count="exact")
        if call_site:
            q = q.eq("call_site", call_site)
        if request_id:
            q = q.eq("request_id", request_id)
        if user_id:
            q = q.eq("user_id", user_id)
        if status_filter:
            q = q.eq("status", status_filter)
        return q.order("created_at", desc=True).range(offset, offset + limit).execute()

    try:
        res = await anyio.to_thread.run_sync(_query)
    except Exception as e:
        raise HTTPException(503, f"llm usage unavailable: {e}")
    rows = getattr(res, "data", None) or []
    return {
        "calls": rows[:limit],
        "has_more": len(rows) > limit,
        "total": getattr(res, "count", None),
        "offset": offset,
        "limit": limit,
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
    return {"feed_gen_mode": await stores.get_feed_mode()}

@app.put("/admin/settings")
async def admin_update_settings(body: FeedModeUpdate, _: None = Depends(_require_admin)):
    await stores.set_feed_mode(body.mode)
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
            follow_up = await core_family_store.take_due_follow_up(uid)
            if follow_up:
                nickname = user.get("nickname") or "家长"
                text = await core_dialogue_reply.compose_follow_up_message(nickname, follow_up)
                if text:
                    await anyio.to_thread.run_sync(
                        lambda _to=user["email"], _b=text:
                        _send_email_smtp(_to, f"NURI 想问问你 | {follow_up['topic']}", _b)
                    )
                    await core_family_store.mark_follow_up_asked(follow_up["id"])
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
                    llm_usage.record(
                        "push.keywords", "gpt-4.1-mini",
                        usage=getattr(kw_resp, "usage", None), user_id=uid,
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
            await stores.save_gen_cards([card])

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
