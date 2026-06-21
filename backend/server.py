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


class FeedCardDetail(FeedCard):
    body: str = ""
    tags: List[str] = Field(default_factory=list)
    hook_line: str = "看完想知道你家宝宝是不是也这样？"


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


# Detail page content per card (story-style ~300-500 chars)
CARD_DETAILS: dict = {
    "card_food_picky": {
        "body": "上周我在妈妈群看到一位姐姐发的求助：她家18个月的宝宝突然只肯吃白米饭、面条和酸奶，看到绿色蔬菜就闭嘴扭头。这种场景，太熟悉了。\n\n其实这阶段在儿科里有专门的名字，叫 food neophobia——食物新恐惧期。研究显示，18到36个月几乎是每个孩子都会经历的一个发育节点：他们开始对食物的颜色、质地、形状变得敏感，会本能地「先怀疑、再接受」。这不是叛逆，也不是被你惯坏了。\n\n那能做什么？三件最关键的小事：\n1. 每餐桌上放一样新食物，但不要强迫吃。哪怕只是看一眼、摸一下，都是接受过程的一部分。\n2. 新食物搭配老熟悉——把宝宝喜欢的米饭和一点点新蔬菜放一起，比单独上一盘陌生菜更容易接受。\n3. 一次只引入一种新食物，连续7–10天。重复曝光比丰富度更重要。\n\n但最难的，其实是家长的心态：你不焦虑，孩子就不会从你的表情里学到「吃饭是件紧张的事」。",
        "tags": ["#18月龄", "#挑食", "#辅食"],
        "hook_line": "看完想知道你家宝宝是不是也这样？",
    },
    "card_bilingual_school": {
        "body": "湾区一所私立双语小学最近改了招生政策，要求父母至少一方流利中文。妈妈群直接炸了。\n\n支持的一派说：在北美，中文环境是稀缺的，错过6岁前的语言敏感期，以后再想补就难了。送孩子去双语学校，至少能保住听说读写四项基本功，文化认同也是一笔隐形资产。\n\n反对的一派说：学术深度永远是英语的天花板。双语学校的英语阅读和写作进度往往慢于主流学校，等高中要拼 GPA、SAT、AP 的时候，可能反而吃亏。而且转回主流学校之后的衔接也是个大问题。\n\n其实这件事没有标准答案。真正影响决定的不是「中文重要还是英语重要」，而是：你家这个孩子的语言天赋、社交风格、你和伴侣的时间精力、未来5–10年的搬家计划。\n\n所以与其问「该不该上」，不如先问自己：你最在意的3件事是什么？",
        "tags": ["#双语教育", "#择校", "#华人家长"],
        "hook_line": "你家也在纠结这个选择吗？",
    },
    "card_baby_monitor": {
        "body": "选婴儿监视器这件事，华人家长在北美其实有一个特别的痛点：隐私。\n\n大部分美区热销的监视器都是云端方案——视频先传到厂商的服务器，再分发给你的手机。听起来很方便，但一旦想到孩子的睡眠画面被打包加密上传到一家公司，很多家长就睡不着觉了。\n\n所以我们重点对比了3款：\n• Nanit：画面最清晰，AI 睡眠分析很强，但订阅费贵，且数据全部上云。\n• Owlet：主打「袜子+摄像头」二合一，能监测心率血氧，曾因 FDA 警告下架重新上架。\n• VTech：传统点对点信号，完全不联网，画面相对粗糙但安全感最高。\n\n选哪个，本质上是在「功能感」和「安全感」之间做取舍。如果你家是新生儿、且家里 wifi 信号好，Nanit 的睡眠分析确实值这个钱；如果你介意隐私、或者只是想看到孩子是否还在床上，VTech 完全够用。",
        "tags": ["#婴儿监视器", "#选品", "#隐私"],
        "hook_line": "想结合你家情况，听听我的建议？",
    },
    "card_sleep_routine": {
        "body": "如果让我只推荐一件事帮你的孩子睡得更好，我会说：入睡仪式。\n\n2岁前后的宝宝，对「接下来要发生什么」特别敏感。如果每天晚上都是「洗澡 → 换睡衣 → 关大灯 → 读绘本 → 拥抱 → 上床」，他的大脑会在第一步就开始分泌褪黑素准备入睡。仪式比时长更重要——哪怕只有20分钟，只要顺序固定，效果就比每天哄一小时还稳定。\n\n几个我自己反复验证过的小诀窍：\n1. 从洗澡开始倒计时：水温降下来的过程本身就会让体温微降，触发睡意。\n2. 绘本永远是同一类——温柔、低饱和、句子短。这不是看新故事的时间。\n3. 关大灯、留小夜灯，让光照从亮到暗，模拟自然黄昏。\n4. 最后5分钟不再说话，只是身体接触。\n\n这套仪式一旦建立，夜醒次数会肉眼可见地减少。",
        "tags": ["#睡眠", "#入睡仪式", "#幼儿"],
        "hook_line": "想为你家做一个本周睡眠计划吗？",
    },
    "card_screen_time": {
        "body": "AAP（美国儿科学会）今年更新了屏幕时间指南，把「互动性」作为关键标准——也就是说，和爷爷视频通话，不再算「屏幕时间」。\n\n这一改，让很多华人家庭松了口气。我们这一代孩子的祖父母大多在国内，视频是仅有的「见面」方式。如果按旧标准，一周视频几次就快超标了。\n\n但群里也有不同声音：新标准是不是给了家长偷懒的借口？孩子拿着 iPad 跟一个动画「互动」，也算互动吗？算游戏吗？算学习吗？\n\n我的看法是：指南只是工具，不是答案。真正该问自己的3个问题：\n1. 屏幕之后，孩子是更躁动还是更平静？\n2. 屏幕之外，他还在做哪些事？（户外、阅读、自由玩耍）\n3. 你和孩子在一起的时间，是不是有相当一部分被设备打断了？\n\n如果三个答案都让你安心，规则可以宽一点。",
        "tags": ["#屏幕时间", "#AAP", "#育儿争议"],
        "hook_line": "想聊聊你家的屏幕规则吗？",
    },
    "card_thermometer": {
        "body": "新手家长第一次量体温的紧张，我永远记得。\n\n38.0°C 还是 37.9°C？要不要送急诊？北美的儿科医生大多会告诉你：3个月以下任何发烧都去 ER，3个月以上看精神状态。但前提是，你得先有一支靠谱的温度计。\n\n额温枪 vs 耳温枪，常见的3款：\n• Braun Thermoscan 7：耳温枪经典款，年龄校准准确，缺点是耳道太小或太多耳屎时偏差大。\n• iHealth 额温枪：非接触、几秒出数，适合睡着的宝宝；但环境温度变化会影响读数。\n• Frida Baby 3-in-1：耳额双用，价位中等，适合「什么都想试」的家庭。\n\n比型号更重要的是：每次测3次取中间值，记录在 app 里看趋势，而不是只看绝对值。一次 38.2°C 可能是误差，连续3次都在 38°C 以上，才需要认真处理。\n\n冷静地量、冷静地记录，比一惊一乍地往医院跑更有用。",
        "tags": ["#温度计", "#发烧", "#新手家长"],
        "hook_line": "拍张读数发给我，AI 可以帮你判断？",
    },
}


# Pool of alternate cards used by "换一条" single-card refresh
ALT_FEED_CARDS: List[FeedCard] = [
    FeedCard(id="alt_tantrum", type="tip", type_label="科普",
             title="2岁宝宝当众尖叫怎么办？6步冷静法",
             summary="terrible twos 不是病——但你可以提前练好这套话术，关键时刻不慌。",
             image_url="https://images.unsplash.com/photo-1602030638412-bb8dcc0bc8b0?w=600"),
    FeedCard(id="alt_daycare", type="news", type_label="热点",
             title="纽约 daycare 学费再涨15%，华人妈妈群讨论留职还是辞职",
             summary="月费 $2800+ 已是常态。这一波算账，可能让你重新思考一年内的职业规划。",
             image_url="https://images.unsplash.com/photo-1587653263995-422546a7a569?w=600"),
    FeedCard(id="alt_carseat", type="product", type_label="推荐",
             title="0-4岁安全座椅，到底要不要买 Nuna？",
             summary="对比 Nuna / Britax / Graco 在北美的真实事故评分和长期使用反馈。",
             image_url="https://images.unsplash.com/photo-1581952976147-5a2d15560349?w=600"),
    FeedCard(id="alt_potty", type="tip", type_label="科普",
             title="如厕训练，到底什么时候开始最合适？",
             summary="北美儿科和国内传统经验有不少分歧，先看孩子准备好的5个信号。",
             image_url="https://images.unsplash.com/photo-1576091160550-2173dba999ef?w=600"),
    FeedCard(id="alt_winter", type="news", type_label="热点",
             title="加拿大冬天到底要不要带娃出门玩雪？",
             summary="-15°C 的多伦多家长群因为这个话题分裂了，背后其实是两种育儿文化。",
             image_url="https://images.unsplash.com/photo-1518091043644-c1d4457512c6?w=600"),
]


def _to_detail(card: FeedCard) -> FeedCardDetail:
    extra = CARD_DETAILS.get(card.id, {
        "body": card.summary + "\n\n(这是一篇示例正文，AI 助手将根据你的实际情况给出更具体的建议。)",
        "tags": ["#育儿"],
        "hook_line": "想结合你家情况聊聊吗？",
    })
    return FeedCardDetail(**card.dict(), **extra)


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


@api_router.get("/feed/{card_id}/detail", response_model=FeedCardDetail)
async def get_card_detail(card_id: str):
    for c in FEED_CARDS + ALT_FEED_CARDS:
        if c.id == card_id:
            return _to_detail(c)
    raise HTTPException(404, "card not found")


@api_router.get("/feed/alt", response_model=FeedCard)
async def get_alt_card(exclude: str = ""):
    import random
    pool = [c for c in (FEED_CARDS + ALT_FEED_CARDS) if c.id != exclude]
    return random.choice(pool)


# ---- Favorites (mock, single-user) ----
class FavToggle(BaseModel):
    card_id: str


@api_router.get("/favorites", response_model=List[FeedCard])
async def list_favorites():
    docs = await _docs(db.favorites, sort=("ts", -1))
    out: List[FeedCard] = []
    by_id = {c.id: c for c in (FEED_CARDS + ALT_FEED_CARDS)}
    for d in docs:
        cid = d.get("card_id")
        if cid and cid in by_id:
            out.append(by_id[cid])
    return out


@api_router.post("/favorites/toggle")
async def toggle_favorite(body: FavToggle):
    existing = await _doc(db.favorites, {"card_id": body.card_id})
    if existing:
        await db.favorites.delete_one({"card_id": body.card_id})
        return {"favorited": False, "card_id": body.card_id}
    await db.favorites.insert_one({"card_id": body.card_id, "ts": iso(utc_now())})
    return {"favorited": True, "card_id": body.card_id}


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
