"""North American Chinese Parenting AI Agent - Backend.

This backend exposes mock prototype endpoints for:
  - Family / children profiles
  - Feed cards (daily tips, hot news, product recommendations)
  - Chat sessions with predefined script-driven AI responses
    (real LLM interface is wired but disabled via USE_REAL_LLM=false)
  - Task list (today / weekly) with check-in reflections
  - Privacy settings
  - Lightweight analytics counters for card impressions/clicks
"""

from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import uuid
import asyncio
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Literal

from pydantic import BaseModel, Field


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "parenting_ai")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
USE_REAL_LLM = os.environ.get("USE_REAL_LLM", "false").lower() == "true"

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="Parenting AI Agent")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat()


class Child(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    nickname: str
    birth_date: str  # ISO date string e.g. "2023-06-01"
    gender: Literal["boy", "girl", "other"] = "other"
    allergies: List[str] = Field(default_factory=list)
    notes: str = ""
    created_at: str = Field(default_factory=lambda: iso(utc_now()))


class ChildCreate(BaseModel):
    nickname: str
    birth_date: str
    gender: Literal["boy", "girl", "other"] = "other"
    allergies: List[str] = Field(default_factory=list)
    notes: str = ""


class FeedCard(BaseModel):
    id: str
    type: Literal["tip", "news", "product"]
    type_label: str
    title: str
    summary: str
    image_url: Optional[str] = None
    cta: str = "问问AI →"


class ChatMessage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str
    role: Literal["ai", "user"]
    text: str
    image_base64: Optional[str] = None  # data URL preview for prototype
    quick_replies: List[str] = Field(default_factory=list)
    transition: Optional[dict] = None  # e.g. {"kind": "tasks_generated", "count": 3}
    created_at: str = Field(default_factory=lambda: iso(utc_now()))


class ChatSession(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    source_card_id: Optional[str] = None
    script_key: str = "tip_food"  # which mock script to follow
    step: int = 0
    created_at: str = Field(default_factory=lambda: iso(utc_now()))


class StartChatRequest(BaseModel):
    card_id: Optional[str] = None
    title: Optional[str] = None
    script_key: Optional[str] = None  # "tip_food", "news_bilingual", "product_monitor", "image_emergency", "free"


class UserMessageIn(BaseModel):
    text: Optional[str] = ""
    image_base64: Optional[str] = None


class Task(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    scope: Literal["today", "week"] = "today"
    source: str = ""  # e.g. "来自你和AI的对话 · 6月18日"
    done: bool = False
    progress_done: int = 0  # for weekly
    progress_total: int = 7
    reflection: Optional[dict] = None  # {"mood": "😊", "note": "..."}
    created_at: str = Field(default_factory=lambda: iso(utc_now()))
    completed_at: Optional[str] = None


class TaskUpdate(BaseModel):
    done: Optional[bool] = None
    mood: Optional[str] = None
    note: Optional[str] = None


class PrivacySettings(BaseModel):
    allow_history_training: bool = True
    daily_push: bool = True
    anonymous_community_share: bool = False
    language: Literal["zh", "en"] = "zh"


# ---------------------------------------------------------------------------
# Static mock feed
# ---------------------------------------------------------------------------
FEED_CARDS: List[FeedCard] = [
    FeedCard(
        id="card_food_picky",
        type="tip",
        type_label="科普",
        title="18个月宝宝突然只吃3种食物，正常吗？",
        summary="“食物新恐惧期”是18–36个月最常见的发育阶段。我们梳理了3个最关键的应对原则。",
        image_url="https://images.unsplash.com/photo-1604908554027-93fc287e8ba3?w=600",
    ),
    FeedCard(
        id="card_bilingual_school",
        type="news",
        type_label="热点",
        title="是否该让孩子上双语学校？华人家长吵翻了",
        summary="湾区一所私立双语小学的招生政策引爆了华人妈妈群，正反两派各执一词。",
        image_url="https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=600",
    ),
    FeedCard(
        id="card_baby_monitor",
        type="product",
        type_label="推荐",
        title="这款婴儿监视器值得买吗？",
        summary="对比3款北美热销监视器的隐私政策、夜视清晰度和延迟，附我们的实测建议。",
        image_url="https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=600",
    ),
    FeedCard(
        id="card_sleep_routine",
        type="tip",
        type_label="科普",
        title="2岁前后建立入睡仪式，到底有多重要？",
        summary="睡前30分钟固定的“仪式”比哄睡时长更影响夜醒次数。今晚就可以做的3件事。",
        image_url="https://images.unsplash.com/photo-1566004100631-35d015d6a491?w=600",
    ),
    FeedCard(
        id="card_screen_time",
        type="news",
        type_label="热点",
        title="AAP 更新屏幕时间指南，多伦多妈妈群炸了",
        summary="新版指南把“互动性”作为关键标准——和爷爷视频不算屏幕时间？看看大家怎么吵。",
        image_url="https://images.unsplash.com/photo-1503602642458-232111445657?w=600",
    ),
    FeedCard(
        id="card_thermometer",
        type="product",
        type_label="推荐",
        title="额温枪 vs 耳温枪，新手家长怎么选？",
        summary="北美儿科医生最常推荐的3款，覆盖0–5岁不同月龄，附AI辨别异常体温的方法。",
        image_url="https://images.unsplash.com/photo-1584555613483-1c5f3ce97b9b?w=600",
    ),
]


# ---------------------------------------------------------------------------
# Mock AI scripts: deterministic step-by-step replies
# ---------------------------------------------------------------------------
SCRIPTS: dict = {
    "tip_food": [
        {
            "role": "ai",
            "text": "你刚刚看到的这条「18个月宝宝突然只吃3种食物，正常吗」——我看到你点进来了。想具体聊聊你家宝宝的情况吗？",
            "quick_replies": ["我家也是这样", "这是真的吗", "随便看看"],
        },
        {
            "role": "ai",
            "text": "嗯，这其实非常常见，专业上叫 food neophobia（食物新恐惧期）。先问你两件事：宝宝现在主要只吃哪3种？最近有没有体重下降？",
            "quick_replies": ["白米饭/面条/牛奶", "没有体重下降", "有一点下降"],
        },
        {
            "role": "ai",
            "text": "好的，体重稳定就先不用焦虑。这阶段的核心策略是“反复轻量曝光”+ 减少压力：\n\n• 每餐桌上至少放1样新食物，但不强迫吃\n• 把新食物和孩子已经接受的食物放在一起\n• 一次只引入一种新食物，连续7–10天\n\n要不要我帮你做一个本周的小计划？",
            "quick_replies": ["要，帮我做计划", "我再想想"],
        },
        {
            "role": "ai",
            "text": "好嘞，已为你生成3个本周任务，包含每日记录和一个轻量挑战。",
            "transition": {"kind": "tasks_generated", "count": 3},
        },
    ],
    "news_bilingual": [
        {
            "role": "ai",
            "text": "你点的这条「是否该让孩子上双语学校？华人家长吵翻了」最近确实很热。你是已经在做决定，还是想先听听双方观点？",
            "quick_replies": ["我在做决定", "想听双方观点", "随便看看"],
        },
        {
            "role": "ai",
            "text": "理解。北美华人圈里这个话题有3个真实的分歧点：\n\n1) 英文学术深度 vs 中文文化认同\n2) 同伴语言环境的影响\n3) 转学回主流学校的难度\n\n你最担心的是哪一个？",
            "quick_replies": ["英文学术深度", "中文文化认同", "转学难度"],
        },
        {
            "role": "ai",
            "text": "嗯，这是最多家长卡住的点。我可以基于你家娃的月龄和你的优先级，给你一个“决策清单”——5个你这周可以做的小动作，帮你更有底气地做决定。要不要？",
            "quick_replies": ["好，生成清单", "先不用"],
        },
        {
            "role": "ai",
            "text": "已为你生成5个本周任务，帮你结构化收集信息。",
            "transition": {"kind": "tasks_generated", "count": 5},
        },
    ],
    "product_monitor": [
        {
            "role": "ai",
            "text": "你点的「婴儿监视器值得买吗」——华人家长在北美选这类产品，隐私政策其实比清晰度更重要。你家是新生儿还是已经会爬了？",
            "quick_replies": ["新生儿", "会爬了", "随便看看"],
        },
        {
            "role": "ai",
            "text": "好的。基于这个阶段，我建议你重点对比3款：Nanit / Owlet / VTech。要不要我帮你列一个对比清单，包含价格、隐私政策、订阅费？",
            "quick_replies": ["要", "先不用"],
        },
        {
            "role": "ai",
            "text": "已为你生成2个本周任务，帮你做出更安心的购买决定。",
            "transition": {"kind": "tasks_generated", "count": 2},
        },
    ],
    "image_emergency": [
        {
            "role": "ai",
            "text": "收到照片了。我看到的情况：体温显示 38.7°C，属于中度发烧。先确认几件事：宝宝多大？精神状态怎么样？有没有其他症状（咳嗽/腹泻/皮疹）？",
            "quick_replies": ["18个月，精神还可以", "有咳嗽", "什么都没有"],
        },
        {
            "role": "ai",
            "text": "好的。38.7°C 在 18 个月宝宝身上，如果精神状态尚可且没有其他急症征兆，**通常可以居家观察 24 小时**。但请注意红旗信号：抽搐、呼吸急促、嗜睡叫不醒、皮疹突现。\n\n以下是附近可联系的医疗资源：",
            "transition": {"kind": "hospital_card"},
        },
        {
            "role": "ai",
            "text": "我会每隔几个小时主动来问问你，需要的话随时回我体温读数就行。",
            "quick_replies": ["好，谢谢", "现在还好"],
        },
    ],
    "free": [
        {
            "role": "ai",
            "text": "Hi，我是你的育儿助手。你今天想聊点什么？可以是吃饭、睡觉、情绪、或者你刚刚看到的任何一条内容。",
            "quick_replies": ["睡眠问题", "吃饭挑食", "随便聊聊"],
        },
        {
            "role": "ai",
            "text": "好的，再多告诉我一点情况，比如孩子月龄、最近一周观察到的具体变化，我才能给你更具体的建议。",
        },
        {
            "role": "ai",
            "text": "明白了。要不要我帮你把这周可以做的几件事整理成一个简单清单？",
            "quick_replies": ["好的", "先不用"],
        },
        {
            "role": "ai",
            "text": "好嘞，已为你生成3个本周任务。",
            "transition": {"kind": "tasks_generated", "count": 3},
        },
    ],
}


CARD_TO_SCRIPT = {
    "card_food_picky": "tip_food",
    "card_bilingual_school": "news_bilingual",
    "card_baby_monitor": "product_monitor",
    "card_sleep_routine": "tip_food",
    "card_screen_time": "news_bilingual",
    "card_thermometer": "product_monitor",
}


CARD_TASKS = {
    "tip_food": [
        {"title": "今天晚餐桌上放一样新食物（不强迫吃）", "scope": "today"},
        {"title": "记录宝宝今日实际进食的种类", "scope": "today"},
        {"title": "本周连续7天，每天尝试一次新食物", "scope": "week", "progress_total": 7},
    ],
    "news_bilingual": [
        {"title": "今晚和伴侣聊10分钟，列出你们最在意的3件事", "scope": "today"},
        {"title": "联系1位已经送孩子去双语学校的朋友", "scope": "today"},
        {"title": "本周收集3所候选学校的真实家长反馈", "scope": "week", "progress_total": 7},
        {"title": "本周参观至少1所学校", "scope": "week", "progress_total": 7},
        {"title": "周末和伴侣坐下来做一次结构化讨论", "scope": "today"},
    ],
    "product_monitor": [
        {"title": "今天对比 Nanit / Owlet / VTech 的隐私政策", "scope": "today"},
        {"title": "本周内完成购买决策", "scope": "week", "progress_total": 7},
    ],
    "image_emergency": [
        {"title": "每3小时复测一次体温，记录在app里", "scope": "today"},
        {"title": "如出现红旗信号立即联系医生", "scope": "today"},
    ],
    "free": [
        {"title": "今天选一个小目标坚持10分钟", "scope": "today"},
        {"title": "本周和孩子做一件“专注陪伴”的事", "scope": "week", "progress_total": 7},
        {"title": "睡前花5分钟回顾今天3件好事", "scope": "today"},
    ],
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _doc(collection, query):
    """find one and strip _id."""
    doc = await collection.find_one(query, {"_id": 0})
    return doc


async def _docs(collection, query=None, sort=None, limit: int = 200):
    cursor = collection.find(query or {}, {"_id": 0})
    if sort:
        cursor = cursor.sort(*sort)
    return await cursor.to_list(limit)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@api_router.get("/")
async def root():
    return {"app": "parenting-ai", "use_real_llm": USE_REAL_LLM}


# ---- Children ----
@api_router.get("/children", response_model=List[Child])
async def list_children():
    docs = await _docs(db.children, sort=("created_at", 1))
    return [Child(**d) for d in docs]


@api_router.post("/children", response_model=Child)
async def add_child(body: ChildCreate):
    child = Child(**body.dict())
    await db.children.insert_one(child.dict())
    return child


@api_router.put("/children/{child_id}", response_model=Child)
async def update_child(child_id: str, body: ChildCreate):
    existing = await _doc(db.children, {"id": child_id})
    if not existing:
        raise HTTPException(404, "child not found")
    updated = {**existing, **body.dict()}
    await db.children.update_one({"id": child_id}, {"$set": body.dict()})
    return Child(**updated)


@api_router.delete("/children/{child_id}")
async def delete_child(child_id: str):
    await db.children.delete_one({"id": child_id})
    return {"ok": True}


# ---- Feed ----
@api_router.get("/feed", response_model=List[FeedCard])
async def get_feed(shuffle: bool = False):
    cards = list(FEED_CARDS)
    if shuffle:
        import random
        random.shuffle(cards)
    return cards


class AnalyticsEvent(BaseModel):
    event: str  # "impression" | "click_ask_ai" | "scroll_depth"
    card_id: Optional[str] = None
    card_type: Optional[str] = None
    value: Optional[int] = None


@api_router.post("/analytics")
async def track_event(ev: AnalyticsEvent):
    doc = ev.dict()
    doc["ts"] = iso(utc_now())
    await db.analytics.insert_one(doc)
    return {"ok": True}


@api_router.get("/analytics/summary")
async def analytics_summary():
    events = await _docs(db.analytics, sort=("ts", -1), limit=1000)
    out: dict = {}
    for e in events:
        key = (e.get("event"), e.get("card_type"))
        out[str(key)] = out.get(str(key), 0) + 1
    return out


# ---- Chat ----
@api_router.post("/chat/sessions", response_model=ChatSession)
async def start_session(body: StartChatRequest):
    script_key = body.script_key or (CARD_TO_SCRIPT.get(body.card_id or "", "free"))
    title = body.title or "和育儿助手聊天"
    if body.card_id:
        for c in FEED_CARDS:
            if c.id == body.card_id:
                title = c.title
                break
    session = ChatSession(
        title=title,
        source_card_id=body.card_id,
        script_key=script_key,
        step=0,
    )
    await db.chat_sessions.insert_one(session.dict())
    # Seed first AI message
    first = SCRIPTS[script_key][0]
    msg = ChatMessage(
        session_id=session.id,
        role="ai",
        text=first["text"],
        quick_replies=first.get("quick_replies", []),
        transition=first.get("transition"),
    )
    await db.chat_messages.insert_one(msg.dict())
    await db.chat_sessions.update_one(
        {"id": session.id}, {"$set": {"step": 1}}
    )
    return session


@api_router.get("/chat/sessions", response_model=List[ChatSession])
async def list_sessions():
    docs = await _docs(db.chat_sessions, sort=("created_at", -1))
    return [ChatSession(**d) for d in docs]


@api_router.get("/chat/sessions/{session_id}/messages", response_model=List[ChatMessage])
async def get_messages(session_id: str):
    docs = await _docs(db.chat_messages, {"session_id": session_id}, sort=("created_at", 1))
    return [ChatMessage(**d) for d in docs]


@api_router.post("/chat/sessions/{session_id}/messages")
async def post_user_message(session_id: str, body: UserMessageIn):
    session_doc = await _doc(db.chat_sessions, {"id": session_id})
    if not session_doc:
        raise HTTPException(404, "session not found")

    # Save user message
    user_msg = ChatMessage(
        session_id=session_id,
        role="user",
        text=body.text or ("[图片]" if body.image_base64 else ""),
        image_base64=body.image_base64,
    )
    await db.chat_messages.insert_one(user_msg.dict())

    script_key = session_doc["script_key"]
    # If user uploaded an image and we are in free / first step, switch to emergency script
    if body.image_base64 and script_key in ("free",):
        script_key = "image_emergency"
        await db.chat_sessions.update_one(
            {"id": session_id}, {"$set": {"script_key": script_key, "step": 0}}
        )
        session_doc["step"] = 0
        session_doc["script_key"] = script_key

    step = session_doc.get("step", 0)
    script = SCRIPTS.get(script_key, SCRIPTS["free"])

    # Build AI reply
    ai_messages: List[ChatMessage] = []
    if step < len(script):
        nxt = script[step]
        ai_messages.append(
            ChatMessage(
                session_id=session_id,
                role="ai",
                text=nxt["text"],
                quick_replies=nxt.get("quick_replies", []),
                transition=nxt.get("transition"),
            )
        )
        new_step = step + 1
    else:
        ai_messages.append(
            ChatMessage(
                session_id=session_id,
                role="ai",
                text="嗯，我先记下了。你随时回来继续，我会保持上下文。",
            )
        )
        new_step = step

    for m in ai_messages:
        await db.chat_messages.insert_one(m.dict())

    await db.chat_sessions.update_one(
        {"id": session_id}, {"$set": {"step": new_step}}
    )

    # If transition triggers task generation, seed tasks
    for m in ai_messages:
        if m.transition and m.transition.get("kind") == "tasks_generated":
            await _generate_tasks_for(script_key, session_doc.get("title", "对话"))

    return {
        "user_message": user_msg.dict(),
        "ai_messages": [m.dict() for m in ai_messages],
    }


async def _generate_tasks_for(script_key: str, session_title: str):
    templates = CARD_TASKS.get(script_key, CARD_TASKS["free"])
    src = f"来自你和AI的对话 · {datetime.now().strftime('%-m月%-d日') if hasattr(datetime, 'now') else ''}"
    # safe format for environments without %-m
    src = f"来自你和AI的对话 · {datetime.now().strftime('%m月%d日').lstrip('0').replace('月0', '月')}"
    for t in templates:
        task = Task(
            title=t["title"],
            scope=t["scope"],
            progress_total=t.get("progress_total", 7),
            source=src,
        )
        await db.tasks.insert_one(task.dict())


# ---- Tasks ----
@api_router.get("/tasks", response_model=List[Task])
async def list_tasks(scope: Optional[str] = None):
    q = {"scope": scope} if scope in ("today", "week") else {}
    docs = await _docs(db.tasks, q, sort=("created_at", -1))
    return [Task(**d) for d in docs]


@api_router.patch("/tasks/{task_id}", response_model=Task)
async def update_task(task_id: str, body: TaskUpdate):
    existing = await _doc(db.tasks, {"id": task_id})
    if not existing:
        raise HTTPException(404, "task not found")

    patch: dict = {}
    if body.done is not None:
        patch["done"] = body.done
        if body.done:
            patch["completed_at"] = iso(utc_now())
            if existing.get("scope") == "week":
                patch["progress_done"] = min(
                    existing.get("progress_total", 7),
                    existing.get("progress_done", 0) + 1,
                )
        else:
            patch["completed_at"] = None

    if body.mood is not None or body.note is not None:
        patch["reflection"] = {
            "mood": body.mood or (existing.get("reflection") or {}).get("mood"),
            "note": body.note or (existing.get("reflection") or {}).get("note", ""),
        }

    if patch:
        await db.tasks.update_one({"id": task_id}, {"$set": patch})

    updated = {**existing, **patch}
    return Task(**updated)


@api_router.get("/tasks/insights")
async def task_insights():
    tasks = await _docs(db.tasks, sort=("created_at", -1), limit=500)
    completed = [t for t in tasks if t.get("done")]
    streak = 0
    # Naive streak count: consecutive 'today' tasks completed in last 7 days
    today = utc_now().date()
    completed_dates = set()
    for t in completed:
        ts = t.get("completed_at")
        if ts:
            try:
                completed_dates.add(datetime.fromisoformat(ts.replace("Z", "+00:00")).date())
            except Exception:
                pass
    for i in range(7):
        d = today - timedelta(days=i)
        if d in completed_dates:
            streak += 1
        else:
            if i > 0:
                break
    return {
        "total_completed": len(completed),
        "streak_days": streak,
        "weekly_progress": sum(t.get("progress_done", 0) for t in tasks if t.get("scope") == "week"),
    }


# ---- Privacy ----
@api_router.get("/privacy", response_model=PrivacySettings)
async def get_privacy():
    doc = await _doc(db.privacy, {"id": "singleton"})
    if not doc:
        ps = PrivacySettings()
        await db.privacy.insert_one({"id": "singleton", **ps.dict()})
        return ps
    doc.pop("id", None)
    return PrivacySettings(**doc)


@api_router.put("/privacy", response_model=PrivacySettings)
async def update_privacy(body: PrivacySettings):
    await db.privacy.update_one(
        {"id": "singleton"}, {"$set": body.dict()}, upsert=True
    )
    return body


@api_router.post("/privacy/wipe")
async def wipe_all():
    await asyncio.gather(
        db.children.delete_many({}),
        db.chat_sessions.delete_many({}),
        db.chat_messages.delete_many({}),
        db.tasks.delete_many({}),
        db.analytics.delete_many({}),
        db.privacy.delete_many({}),
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Mount
# ---------------------------------------------------------------------------
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
