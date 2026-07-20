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

import io, json, os, uuid, hashlib, random
from datetime import datetime, timezone, timedelta, date
from pathlib import Path
from typing import List, Literal, Optional

import anyio
import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, BackgroundTasks, Depends, HTTPException, Header, UploadFile, File, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from openai import OpenAI
from pydantic import BaseModel, EmailStr, Field

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

oai = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None

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
app = FastAPI(title="Family Growth Radar API")
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
    base = {k: doc[k] for k in ("id","email","nickname","city","parent_role","top_concerns","created_at")}
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
    nickname: str = Field(..., min_length=1)
    city: str     = Field(..., min_length=1)
    parent_role: ParentRole = "mom"
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

class PrivacySettings(BaseModel):
    allow_history_training:   bool = True
    daily_push:               bool = True
    anonymous_community_share: bool = False
    language: Literal["zh","en"] = "zh"

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

以合法 JSON 格式回复：{"text": "...", "quick_replies": [...], "suggest_tasks": false}

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

suggest_tasks（只在全部条件满足时才设为true，否则一律false）：
- 对话里出现了具体的育儿场景、困扰或目标（不是泛泛聊天）
- 你已充分了解了背景，知道给什么任务有意义
- 自然到了"我来帮你整理几件可以做的事"的时机
- 本次对话还没生成过任务"""

# 单一持续对话不再按话题分成多个 session，历史会无限增长。每轮都把全部历史
# 发给模型既贵又慢，长期还会撞上模型的上下文长度上限。这里只带最近的原文，
# 更早的重要信息依赖 memory_ctx（user_memories，每轮都在后台持续提炼）保留，
# 而不是逐字重放整段历史。
_HISTORY_WINDOW = 40

def _nuri_reply_sync(
    history: list[dict], card_ctx: str = "", memory_ctx: str = "",
    profile_ctx: str = "", style_ctx: str = "",
) -> dict:
    if not oai:
        return {"text": "AI 暂时不可用。", "quick_replies": [], "suggest_tasks": False}
    system = NURI_PERSONA + _NURI_JSON_SUFFIX
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
    try:
        resp = oai.chat.completions.create(
            model="gpt-5.5", messages=msgs,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "nuri_reply",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string"},
                            "quick_replies": {"type": "array", "items": {"type": "string"}},
                            "suggest_tasks": {"type": "boolean"},
                        },
                        "required": ["text", "quick_replies", "suggest_tasks"],
                        "additionalProperties": False,
                    },
                },
            },
        )
        data = json.loads(resp.choices[0].message.content)
        return {
            "text": data.get("text", ""),
            "quick_replies": data.get("quick_replies", [])[:3],
            "suggest_tasks": bool(data.get("suggest_tasks", False)),
        }
    except Exception as e:
        print(f"[error] _nuri_reply_sync failed: {type(e).__name__}: {e}")
        return {"text": "抱歉，AI 暂时无法回应，请稍后再试。", "quick_replies": [], "suggest_tasks": False}

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

def _profile_ctx(row: dict) -> str:
    """Turn a parent's onboarding answers (role/city/concerns) into a short
    prompt block, so NURI knows who it's talking to from the first reply
    instead of only picking this up after enough chat history accumulates."""
    parts = []
    role = _PARENT_ROLE_LABELS.get(row.get("parent_role"))
    if role:
        parts.append(f"身份：{role}")
    city = row.get("city")
    if city:
        parts.append(f"所在城市：{city}")
    concerns = [_CONCERN_LABELS.get(c, c) for c in (row.get("top_concerns") or [])]
    if concerns:
        parts.append(f"主要关心：{'、'.join(concerns)}")
    return "；".join(parts)

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

# Chat command Linda (or any admin reviewer) types inline to correct a reply:
# "#fix <什么地方不对>". It never reaches the user — it gets distilled into a
# reusable rule instead. See _distill_style_rule_sync / nuri_style_rules.
FIX_KEYWORD = "#fix"

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
        "parent_role": body.parent_role, "top_concerns": list(body.top_concerns),
        "hashed_password": _hash_pw(body.password), "created_at": _now(),
    }
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
    nickname = ""
    profile_ctx = ""
    if uid and sb:
        try:
            nr = await anyio.to_thread.run_sync(
                lambda: sb.table("users").select("nickname,city,parent_role,top_concerns")
                .eq("id", uid).maybe_single().execute()
            )
            row = nr.data or {}
            nickname = row.get("nickname", "")
            profile_ctx = _profile_ctx(row)
        except Exception:
            pass

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

@api.post("/chat/sessions/{session_id}/messages")
async def post_message(
    session_id: str, body: UserMessageIn, background_tasks: BackgroundTasks,
    uid: Optional[str] = Depends(_opt_uid),
):
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

    context_hints: dict = {}
    if owner_uid and sb:
        try:
            ur = await anyio.to_thread.run_sync(
                lambda: sb.table("users").select("parent_role,top_concerns").eq("id", owner_uid).maybe_single().execute()
            )
            if ur and ur.data:
                context_hints = {"parent_role": ur.data.get("parent_role"), "top_concerns": ur.data.get("top_concerns")}
        except Exception:
            pass
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
    if stripped_text.startswith(FIX_KEYWORD):
        fix_text = stripped_text[len(FIX_KEYWORD):].strip()

    user_turns = sum(1 for m in msgs if m["role"] == "user")
    already_generated = any(
        (m.get("transition") or {}).get("kind") == "task_suggestion"
        for m in msgs if m["role"] == "ai"
    )

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

    transition = None
    quick_replies: list = []

    if fix_text:
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
                ai_text = f"已记录调整：{rule['rule']}"
            except Exception as e:
                print(f"[warn] #fix insert error: {e}")
                ai_text = "调整没能存上，稍后在后台重试一下。"
        else:
            ai_text = "没能提炼出规则，换个说法再试一次？"
    elif oai:
        gen_cards = await _db_get_gen_cards()
        ctx = _card_ctx(session.get("source_card_id") or "", gen_cards)
        memory_ctx = await _get_memory_context(owner_uid)
        profile_ctx = _profile_ctx(context_hints)
        style_ctx = await _get_style_rules_ctx()
        reply = await anyio.to_thread.run_sync(lambda: _nuri_reply_sync(msgs, ctx, memory_ctx, profile_ctx, style_ctx))
        ai_text = reply["text"]
        quick_replies = reply.get("quick_replies", [])
        # Let NURI decide when to suggest tasks via suggest_tasks flag. These
        # are only drafts — nothing is persisted to the tasks table until the
        # parent taps "添加计划" on a specific card (POST /tasks).
        if reply.get("suggest_tasks") and not already_generated:
            task_list = await anyio.to_thread.run_sync(lambda: _gen_tasks_ai_sync(msgs))
            if task_list:
                transition = {"kind": "task_suggestion", "tasks": task_list}
    else:
        script_key = session.get("script_key", "free")
        script = SCRIPTS.get(script_key, SCRIPTS["free"])
        step = session.get("step", 0)
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
        msgs.append(ai_msg)

    if oai and owner_uid:
        background_tasks.add_task(_extract_and_upsert_memories, msgs + [ai_msg], owner_uid, session_id)

    return {"user_message": user_msg, "ai_messages": [ai_msg]}

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
_DEFAULT_PRIVACY = {"allow_history_training": True, "daily_push": True, "anonymous_community_share": False, "language": "zh"}

@api.get("/privacy")
async def get_privacy(uid: Optional[str] = Depends(_opt_uid)):
    return _privacy.get(uid or "singleton", _DEFAULT_PRIVACY)

@api.put("/privacy")
async def update_privacy(body: PrivacySettings, uid: Optional[str] = Depends(_opt_uid)):
    _privacy[uid or "singleton"] = body.dict()
    return body

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
    return "\n".join(p.extract_text() or "" for p in reader.pages)

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
    resp = oai.embeddings.create(model="text-embedding-3-large", input=texts, dimensions=EMBED_DIM)
    return [d.embedding for d in resp.data]

def _embed_one(text: str) -> List[float]:
    resp = oai.embeddings.create(model="text-embedding-3-large", input=text, dimensions=EMBED_DIM)
    return resp.data[0].embedding

def _is_indexed(doc_id: str):
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    res = (
        sb.table(VECTOR_TABLE)
        .select("id", count="exact")
        .eq("namespace", VECTOR_NAMESPACE)
        .eq("doc_id", doc_id)
        .limit(1)
        .execute()
    )
    total = int(getattr(res, "count", 0) or 0)
    return total > 0, total or None

def _upsert_doc(doc_id: str, chunks: List[str]) -> int:
    sb = _get_supabase()
    if not sb:
        raise HTTPException(503, "Supabase not configured")
    vecs_data = _embed_batch(chunks)
    rows = [
        {
            "id": f"{doc_id}-{i}",
            "namespace": VECTOR_NAMESPACE,
            "doc_id": doc_id,
            "chunk_id": i,
            "content": c,
            "embedding": v,
            "metadata": {"doc_id": doc_id, "chunk_id": i},
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

def _generate_rag_answer(question: str, chunks: List[str], book_name: Optional[str] = None) -> str:
    context = "\n\n".join(f"[Chunk {i+1}]\n{c}" for i, c in enumerate(chunks))
    citation = ('\n在回答結束時，另起一行，僅引用上方參考文獻中明確出現的理論或概念名稱，格式為：參考自「[文獻中出現的理論或概念名稱]」理論。若文獻未明確提及任何理論名稱，則省略此行。'
                if book_name else "")
    system = (NURI_PERSONA
              + "\n\n以下是本次對話的參考文獻節錄，可作為輔助依據。NURI 應優先運用自身的兒童發展與育兒專業知識作答，文獻內容僅供參考補充。無論文獻是否涵蓋問題，都請盡力提供有幫助的回應，避免直接回答「我不知道」或「抱歉，我無法回答」。\n"
              + citation)
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
