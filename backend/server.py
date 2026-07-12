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

from fastapi import FastAPI, APIRouter, HTTPException, Depends
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

from auth import (
    AuthResponse,
    UserLogin,
    UserPublic,
    UserRegister,
    UserUpdate,
    create_access_token,
    get_optional_user_id,
    new_user_doc,
    require_user_id,
    scope_filter,
    to_public,
    verify_password,
)


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


class TaskCardPayload(BaseModel):
    prefix: str = "观察"  # 任务类型前缀（观察/亲子/照顾/自我）
    title: str
    intro: str = ""
    steps: List[str] = Field(default_factory=list)
    task_type: str = "observation"
    is_recurring: bool = False
    total_count: int = 1
    frequency_label: str = ""
    added: bool = False


class ConvoMessage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    role: Literal["ai", "user"]
    type: Literal["text", "status", "task_cards", "image"] = "text"
    content: str = ""
    images: List[str] = Field(default_factory=list)
    task_cards: List[TaskCardPayload] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: iso(utc_now()))


class OpenTopicIn(BaseModel):
    card_id: str


class ConvoMessageIn(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)


class AddTaskFromCardIn(BaseModel):
    message_id: str
    card_index: int = 0


class Task(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: Optional[str] = None
    title: str
    # interaction=亲子互动 observation=发展观察 care=照顾任务 selfcare=家长自我照顾
    task_type: str = "interaction"
    is_recurring: bool = False
    total_count: int = 1
    completed_count: int = 0
    frequency_label: str = ""  # e.g. "每天一次，共7天"
    due_date: Optional[str] = None  # "2026-07-10"
    completed_at: Optional[str] = None
    is_favorited: bool = False
    last_rating: Optional[str] = None  # "bad" | "ok" | "great"
    backfilled: bool = False  # 补全打卡（不计入正常打卡记录）
    description: str = ""
    steps: List[str] = Field(default_factory=list)
    source: str = ""  # e.g. "来自你和AI的对话 · 6月18日"
    created_at: str = Field(default_factory=lambda: iso(utc_now()))


class TaskRating(BaseModel):
    rating: Literal["bad", "ok", "great"]


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
# Nuri 预设对话脚本：每条用户消息触发下一组 AI 回复（text/status/task_cards）
# ---------------------------------------------------------------------------
def _tc(prefix, title, intro, steps, task_type="observation", recurring=False, total=1, freq=""):
    return {
        "prefix": prefix,
        "title": title,
        "intro": intro,
        "steps": steps,
        "task_type": task_type,
        "is_recurring": recurring,
        "total_count": total,
        "frequency_label": freq,
        "added": False,
    }


CONVO_SCRIPTS: dict = {
    "tip_food": {
        "opener": "你刚刚看到的这条「{title}」——我看到你点进来了。想具体聊聊你家宝宝的情况吗？",
        "replies": [
            [
                {
                    "type": "text",
                    "content": "嗯，这其实非常常见，专业上叫 Food Neophobia（食物新恐惧期）。先问你两件事：宝宝现在主要只喂哪3种？最近有没有体重下降？",
                }
            ],
            [
                {"type": "status", "content": "正在为您检索相关资料……"},
                {
                    "type": "text",
                    "content": "Nuri为你整理出了2条辅食打卡计划，是否加入到您的任务日志中？",
                },
                {
                    "type": "task_cards",
                    "task_cards": [
                        _tc(
                            "观察",
                            "尝试鲜虾粥并观察宝宝食欲",
                            "天气转凉，来一碗颜值高又美味的鲜虾粥吧！今天分享的这个做法，妈妈们一定要去试一试！让宝宝爱上吃饭从一碗粥开始",
                            [
                                "鲜虾处理干净，锅中倒入油热放入虾头、姜丝，炒出虾油后捞出",
                                "大米粥煮至软糯，放入虾仁碎和青菜末再煮5分钟",
                                "出锅前滴两滴香油，放温后给宝宝",
                            ],
                        ),
                        _tc(
                            "观察",
                            "记录宝宝今日接受的新食材",
                            "每天记录宝宝愿意尝试的食物，一周后你会发现规律",
                            [
                                "今日准备1种新食材放在餐盘角落",
                                "不强迫，只观察宝宝是否愿意碰一碰、舔一舔",
                                "把反应记录下来，连续7天",
                            ],
                            recurring=True,
                            total=7,
                            freq="每天一次，共7天",
                        ),
                    ],
                },
            ],
            [
                {
                    "type": "text",
                    "content": "虾肉这样可以哦，虾头可以和虾线一起去掉，或者在煮好后挑走。",
                }
            ],
        ],
    },
    "news_bilingual": {
        "opener": "你点的这条「{title}」最近确实很热。你是已经在做决定，还是想先听听双方观点？",
        "replies": [
            [
                {
                    "type": "text",
                    "content": "理解。北美华人圈里这个话题有3个真实的分歧点：\n\n1) 英文学术深度 vs 中文文化认同\n2) 同伴语言环境的影响\n3) 转学回主流学校的难度\n\n你最担心的是哪一个？",
                }
            ],
            [
                {"type": "status", "content": "正在为您检索相关资料……"},
                {
                    "type": "text",
                    "content": "Nuri为你整理出了2条择校行动计划，是否加入到您的任务日志中？",
                },
                {
                    "type": "task_cards",
                    "task_cards": [
                        _tc(
                            "亲子",
                            "和伴侣列出你们最在意的3件事",
                            "择校焦虑大多来自“没想清楚要什么”。今晚花10分钟把它写下来",
                            [
                                "晚饭后各自写下最在意的3件事",
                                "交换比较，找出重合项",
                                "把重合项作为看校时的核心问题",
                            ],
                            task_type="interaction",
                        ),
                        _tc(
                            "观察",
                            "收集3所候选学校的真实家长反馈",
                            "妈妈群的二手信息，不如一位真实在读家长的10分钟电话",
                            [
                                "列出3所候选学校",
                                "每所学校至少联系1位在读家长",
                                "记录他们后悔和庆幸的点",
                            ],
                            recurring=True,
                            total=3,
                            freq="每周三次，共3次",
                        ),
                    ],
                },
            ],
            [
                {
                    "type": "text",
                    "content": "收到。看校时记得把你们最在意的3件事直接问招生老师，比听宣讲会更有用。",
                }
            ],
        ],
    },
    "product_monitor": {
        "opener": "你点的「{title}」——华人家长在北美选这类产品，隐私政策其实比清晰度更重要。你家是新生儿还是已经会爬了？",
        "replies": [
            [
                {
                    "type": "text",
                    "content": "好的。基于这个阶段，我建议你重点对比3款：Nanit / Owlet / VTech。核心差异在“数据上不上云”和“订阅费”。",
                }
            ],
            [
                {"type": "status", "content": "正在为您检索相关资料……"},
                {
                    "type": "text",
                    "content": "Nuri为你整理出了2条选购行动计划，是否加入到您的任务日志中？",
                },
                {
                    "type": "task_cards",
                    "task_cards": [
                        _tc(
                            "照顾",
                            "对比 Nanit / Owlet / VTech 的隐私政策",
                            "10分钟读完三家隐私条款的重点，买前心里有底",
                            [
                                "打开每家官网的 Privacy Policy 页面",
                                "重点看视频数据是否上云、保留多久",
                                "把结果记在备忘录里",
                            ],
                            task_type="care",
                        ),
                        _tc(
                            "照顾",
                            "本周内完成购买决策",
                            "拖延一周，焦虑一周。给自己一个决定期限",
                            [
                                "结合隐私对比结果和预算圈定1款",
                                "查一遍近期折扣信息",
                                "下单并记录到货日期",
                            ],
                            task_type="care",
                        ),
                    ],
                },
            ],
            [
                {
                    "type": "text",
                    "content": "有了监视器也别忘了：任何设备都替代不了你半夜亲自看一眼的安心。",
                }
            ],
        ],
    },
    "free": {
        "opener": "Hi，我是 Nuri。你今天想聊点什么？可以是吃饭、睡觉、情绪，或者你刚刚看到的任何一条内容。",
        "replies": [
            [
                {
                    "type": "text",
                    "content": "好的，再多告诉我一点情况，比如孩子月龄、最近一周观察到的具体变化，我才能给你更具体的建议。",
                }
            ],
            [
                {"type": "status", "content": "正在为您检索相关资料……"},
                {
                    "type": "text",
                    "content": "Nuri为你整理出了2条小计划，是否加入到您的任务日志中？",
                },
                {
                    "type": "task_cards",
                    "task_cards": [
                        _tc(
                            "亲子",
                            "和孩子做一件“专注陪伴”的事",
                            "放下手机的15分钟，比心不在焉的一小时更有质量",
                            [
                                "选一个孩子主导的游戏",
                                "手机调静音放到另一个房间",
                                "跟随孩子的节奏，不指挥",
                            ],
                            task_type="interaction",
                        ),
                        _tc(
                            "自我",
                            "睡前花5分钟回顾今天3件好事",
                            "育儿的成就感藏在小事里，写下来才看得见",
                            [
                                "睡前拿出手机备忘录或小本子",
                                "写下今天3件顺利的小事",
                                "给自己说一句“今天辛苦了”",
                            ],
                            task_type="selfcare",
                        ),
                    ],
                },
            ],
        ],
    },
}

# 脚本走完后的兜底回复（轮换）
CONVO_FALLBACKS = [
    "嗯，我先记下了。你随时回来继续，我会保持上下文。",
    "我在呢。可以再多说一点，比如宝宝的月龄和最近一周的变化。",
    "收到。需要的话，我可以把这个整理成一个小任务加进你的计划里。",
]


CARD_TO_SCRIPT = {
    "card_food_picky": "tip_food",
    "card_bilingual_school": "news_bilingual",
    "card_baby_monitor": "product_monitor",
    "card_sleep_routine": "tip_food",
    "card_screen_time": "news_bilingual",
    "card_thermometer": "product_monitor",
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


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
@api_router.post("/auth/register", response_model=AuthResponse, status_code=201)
async def auth_register(body: UserRegister):
    existing = await db.users.find_one({"email": body.email.lower()})
    if existing:
        raise HTTPException(400, "该邮箱已注册")
    doc = new_user_doc(body)
    await db.users.insert_one(doc)
    token = create_access_token(doc["id"])
    return AuthResponse(access_token=token, user=to_public(doc))


@api_router.post("/auth/login", response_model=AuthResponse)
async def auth_login(body: UserLogin):
    doc = await db.users.find_one({"email": body.email.lower()}, {"_id": 0})
    if not doc or not verify_password(body.password, doc.get("hashed_password", "")):
        raise HTTPException(401, "邮箱或密码错误")
    token = create_access_token(doc["id"])
    return AuthResponse(access_token=token, user=to_public(doc))


@api_router.get("/auth/me", response_model=UserPublic)
async def auth_me(user_id: str = Depends(require_user_id)):
    doc = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "user not found")
    return to_public(doc)


@api_router.put("/auth/me", response_model=UserPublic)
async def auth_me_update(body: UserUpdate, user_id: str = Depends(require_user_id)):
    patch = {k: v for k, v in body.dict(exclude_unset=True).items() if v is not None}
    if patch:
        await db.users.update_one({"id": user_id}, {"$set": patch})
    doc = await db.users.find_one({"id": user_id}, {"_id": 0})
    return to_public(doc)


# ---- Children ----
@api_router.get("/children", response_model=List[Child])
async def list_children(user_id: Optional[str] = Depends(get_optional_user_id)):
    docs = await _docs(db.children, scope_filter(user_id), sort=("created_at", 1))
    return [Child(**d) for d in docs]


@api_router.post("/children", response_model=Child)
async def add_child(
    body: ChildCreate,
    user_id: Optional[str] = Depends(get_optional_user_id),
):
    child = Child(**body.dict())
    doc = child.dict()
    if user_id:
        doc["user_id"] = user_id
    await db.children.insert_one(doc)
    return child


@api_router.put("/children/{child_id}", response_model=Child)
async def update_child(
    child_id: str,
    body: ChildCreate,
    user_id: Optional[str] = Depends(get_optional_user_id),
):
    q = {"id": child_id, **scope_filter(user_id)}
    existing = await _doc(db.children, q)
    if not existing:
        raise HTTPException(404, "child not found")
    updated = {**existing, **body.dict()}
    await db.children.update_one({"id": child_id}, {"$set": body.dict()})
    return Child(**updated)


@api_router.delete("/children/{child_id}")
async def delete_child(
    child_id: str,
    user_id: Optional[str] = Depends(get_optional_user_id),
):
    q = {"id": child_id, **scope_filter(user_id)}
    await db.children.delete_one(q)
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
async def list_favorites(user_id: Optional[str] = Depends(get_optional_user_id)):
    docs = await _docs(db.favorites, scope_filter(user_id), sort=("ts", -1))
    out: List[FeedCard] = []
    by_id = {c.id: c for c in (FEED_CARDS + ALT_FEED_CARDS)}
    for d in docs:
        cid = d.get("card_id")
        if cid and cid in by_id:
            out.append(by_id[cid])
    return out


@api_router.post("/favorites/toggle")
async def toggle_favorite(
    body: FavToggle,
    user_id: Optional[str] = Depends(get_optional_user_id),
):
    q: dict = {"card_id": body.card_id}
    if user_id:
        q["user_id"] = user_id
    existing = await _doc(db.favorites, q)
    if existing:
        await db.favorites.delete_one(q)
        return {"favorited": False, "card_id": body.card_id}
    doc = {"card_id": body.card_id, "ts": iso(utc_now())}
    if user_id:
        doc["user_id"] = user_id
    await db.favorites.insert_one(doc)
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


# ---- Nuri 永续对话（单一会话，无新建/列表/历史管理）----
async def _get_or_create_convo(user_id: Optional[str]) -> dict:
    doc = await db.conversations.find_one({"user_id": user_id}, {"_id": 0})
    if not doc:
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "script_key": "free",
            "step": 0,
            "messages": [],
            "created_at": iso(utc_now()),
        }
        await db.conversations.insert_one(dict(doc))
    return doc


@api_router.get("/conversation")
async def get_conversation(user_id: Optional[str] = Depends(get_optional_user_id)):
    doc = await _get_or_create_convo(user_id)
    return {"id": doc["id"], "messages": doc.get("messages", [])}


@api_router.post("/conversation/open-topic")
async def open_topic(
    body: OpenTopicIn, user_id: Optional[str] = Depends(get_optional_user_id)
):
    """从首页内容卡进入对话：切换脚本话题并追加 AI 开场白。"""
    doc = await _get_or_create_convo(user_id)
    script_key = CARD_TO_SCRIPT.get(body.card_id, "free")
    title = next(
        (c.title for c in FEED_CARDS + ALT_FEED_CARDS if c.id == body.card_id),
        "这条内容",
    )
    opener_text = CONVO_SCRIPTS[script_key]["opener"].format(title=title)
    msgs = doc.get("messages", [])
    appended = []
    last = msgs[-1] if msgs else None
    if not (last and last.get("role") == "ai" and last.get("content") == opener_text):
        m = ConvoMessage(role="ai", type="text", content=opener_text).dict()
        msgs.append(m)
        appended.append(m)
    await db.conversations.update_one(
        {"id": doc["id"]},
        {"$set": {"messages": msgs, "script_key": script_key, "step": 0}},
    )
    return {"messages": appended}


@api_router.post("/conversation/messages")
async def send_convo_message(
    body: ConvoMessageIn, user_id: Optional[str] = Depends(get_optional_user_id)
):
    doc = await _get_or_create_convo(user_id)
    msgs = doc.get("messages", [])

    user_msg = ConvoMessage(role="user", type="text", content=body.content.strip()).dict()
    msgs.append(user_msg)

    script = CONVO_SCRIPTS.get(doc.get("script_key", "free"), CONVO_SCRIPTS["free"])
    step = doc.get("step", 0)
    ai_messages: List[dict] = []
    if step < len(script["replies"]):
        for spec in script["replies"][step]:
            m = ConvoMessage(
                role="ai",
                type=spec.get("type", "text"),
                content=spec.get("content", ""),
                task_cards=[TaskCardPayload(**tc) for tc in spec.get("task_cards", [])],
            ).dict()
            ai_messages.append(m)
    else:
        ai_messages.append(
            ConvoMessage(
                role="ai", content=CONVO_FALLBACKS[step % len(CONVO_FALLBACKS)]
            ).dict()
        )

    msgs.extend(ai_messages)
    await db.conversations.update_one(
        {"id": doc["id"]}, {"$set": {"messages": msgs, "step": step + 1}}
    )
    return {"user_message": user_msg, "ai_messages": ai_messages}


@api_router.post("/conversation/tasks")
async def add_task_from_card(
    body: AddTaskFromCardIn, user_id: Optional[str] = Depends(get_optional_user_id)
):
    """点击任务卡片「添加计划」：写入任务模块并标记卡片已添加。"""
    doc = await _get_or_create_convo(user_id)
    msgs = doc.get("messages", [])
    target = next((m for m in msgs if m.get("id") == body.message_id), None)
    if not target or body.card_index >= len(target.get("task_cards", [])):
        raise HTTPException(404, "task card not found")
    card = target["task_cards"][body.card_index]
    if card.get("added"):
        return {"ok": True, "already": True}

    src = f"来自你和Nuri的对话 · {datetime.now().strftime('%m月%d日').lstrip('0').replace('月0', '月')}"
    task = Task(
        user_id=user_id,
        title=card["title"],
        task_type=card.get("task_type", "observation"),
        is_recurring=card.get("is_recurring", False),
        total_count=card.get("total_count", 1),
        frequency_label=card.get("frequency_label", ""),
        due_date=(utc_now().date() + timedelta(days=7)).isoformat(),
        description=card.get("intro", ""),
        steps=card.get("steps", []),
        source=src,
    )
    await db.tasks.insert_one(task.dict())
    card["added"] = True
    await db.conversations.update_one({"id": doc["id"]}, {"$set": {"messages": msgs}})
    return {"ok": True, "task_id": task.id}


# ---- Tasks ----
def _demo_tasks(user_id: str) -> List[Task]:
    """预置的 6 张演示任务卡片。"""
    today = utc_now().date()

    def d(offset: int) -> str:
        return (today + timedelta(days=offset)).isoformat()

    return [
        Task(
            user_id=user_id,
            title="今晚读绘本建立入睡仪式",
            task_type="interaction",
            is_recurring=True,
            total_count=7,
            completed_count=3,
            frequency_label="每天一次，共7天",
            due_date=d(4),
            description="固定的睡前仪式能给宝宝强烈的安全感，绘本是最温柔的入睡信号。每天同一时间、同一流程，宝宝的身体会慢慢记住“该睡觉了”。",
            steps=[
                "提前15分钟调暗灯光，营造安静氛围",
                "让宝宝自己挑一本绘本",
                "用平缓的语气读完，中途不打断",
                "合上书说晚安，放进小床",
            ],
        ),
        Task(
            user_id=user_id,
            title="记录宝宝今天说的新词",
            task_type="observation",
            due_date=d(2),
            description="语言爆发期的每个新词都是里程碑。记录下来不仅是纪念，也能帮你发现宝宝的兴趣和发展节奏。",
            steps=[
                "随身准备手机备忘录或小本子",
                "听到新词立刻记下发音和场景",
                "晚上花1分钟整理到记录里",
            ],
        ),
        Task(
            user_id=user_id,
            title="准备明天的辅食食材",
            task_type="care",
            due_date=d(-1),
            description="提前备好食材，第二天的辅食制作会从容很多。多准备一种新食材，也是给宝宝多一次探索的机会。",
            steps=[
                "列出明天的辅食清单",
                "检查冰箱里现有的食材",
                "把需要解冻的食材放到冷藏室",
            ],
        ),
        Task(
            user_id=user_id,
            title="今天给自己留30分钟独处时间",
            task_type="selfcare",
            due_date=d(0),
            description="带娃是一场马拉松，你的能量同样重要。30分钟完全属于自己的时间，不是奢侈，而是必需。",
            steps=[
                "和家人约定一个“免打扰”时段",
                "暂时放下手机里的育儿群",
                "做一件纯粹让自己开心的事",
            ],
        ),
        Task(
            user_id=user_id,
            title="每日户外活动20分钟",
            task_type="interaction",
            is_recurring=True,
            total_count=7,
            completed_count=5,
            frequency_label="每天一次，共7天",
            due_date=d(2),
            is_favorited=True,
            description="户外光线和自然环境对宝宝的视力发育、睡眠节律都有帮助。哪怕只是在小区里走一圈，也算数。",
            steps=[
                "选择上午或傍晚阳光温和的时段",
                "让宝宝自由探索，不赶时间",
                "回家后记录宝宝的反应",
            ],
        ),
        Task(
            user_id=user_id,
            title="观察宝宝用手指指物的频率",
            task_type="observation",
            is_recurring=True,
            total_count=3,
            completed_count=1,
            frequency_label="每天一次，共3次",
            due_date=d(1),
            completed_at=iso(utc_now() - timedelta(hours=1)),
            description="“用手指指物”是重要的社交沟通里程碑，通常在9-14个月出现。频率的变化能反映宝宝沟通意愿的发展。",
            steps=[
                "在日常互动中留意宝宝的手势",
                "记录每次指物发生的场景",
                "三天后对比频率的变化",
            ],
        ),
    ]


@api_router.get("/tasks", response_model=List[Task])
async def list_tasks(user_id: Optional[str] = Depends(get_optional_user_id)):
    # Seed demo cards once per user (atomic flag claim, race-safe under concurrent GETs)
    if user_id:
        claimed = await db.users.find_one_and_update(
            {"id": user_id, "demo_tasks_seeded": {"$ne": True}},
            {"$set": {"demo_tasks_seeded": True}},
        )
        if claimed:
            for t in _demo_tasks(user_id):
                await db.tasks.insert_one(t.dict())
    docs = await _docs(db.tasks, scope_filter(user_id), sort=("created_at", -1))
    return [Task(**d) for d in docs]


@api_router.post("/tasks/clear-completed")
async def clear_completed_tasks(user_id: Optional[str] = Depends(get_optional_user_id)):
    """清空已完成任务。已收藏的任务不会被清除。"""
    q = {
        **scope_filter(user_id),
        "completed_at": {"$ne": None},
        "is_favorited": {"$ne": True},
    }
    res = await db.tasks.delete_many(q)
    return {"deleted": res.deleted_count}


async def _get_task_or_404(task_id: str, user_id: Optional[str]) -> dict:
    doc = await _doc(db.tasks, {"id": task_id, **scope_filter(user_id)})
    if not doc:
        raise HTTPException(404, "task not found")
    return doc


@api_router.get("/tasks/{task_id}", response_model=Task)
async def get_task(task_id: str, user_id: Optional[str] = Depends(get_optional_user_id)):
    return Task(**await _get_task_or_404(task_id, user_id))


@api_router.post("/tasks/{task_id}/checkin", response_model=Task)
async def checkin_task(task_id: str, user_id: Optional[str] = Depends(get_optional_user_id)):
    doc = await _get_task_or_404(task_id, user_id)
    if doc.get("completed_at"):
        return Task(**doc)
    total = doc.get("total_count", 1)
    completed_count = min(total, doc.get("completed_count", 0) + 1)
    patch: dict = {"completed_count": completed_count}
    if not doc.get("is_recurring") or completed_count >= total:
        patch["completed_at"] = iso(utc_now())
    await db.tasks.update_one({"id": task_id}, {"$set": patch})
    return Task(**{**doc, **patch})


@api_router.post("/tasks/{task_id}/backfill", response_model=Task)
async def backfill_task(task_id: str, user_id: Optional[str] = Depends(get_optional_user_id)):
    """补全打卡：标记为完成，但不计入正常打卡记录。"""
    doc = await _get_task_or_404(task_id, user_id)
    patch = {"completed_at": iso(utc_now()), "backfilled": True}
    await db.tasks.update_one({"id": task_id}, {"$set": patch})
    return Task(**{**doc, **patch})


@api_router.post("/tasks/{task_id}/favorite", response_model=Task)
async def toggle_task_favorite(task_id: str, user_id: Optional[str] = Depends(get_optional_user_id)):
    doc = await _get_task_or_404(task_id, user_id)
    patch = {"is_favorited": not doc.get("is_favorited", False)}
    await db.tasks.update_one({"id": task_id}, {"$set": patch})
    return Task(**{**doc, **patch})


@api_router.post("/tasks/{task_id}/rating", response_model=Task)
async def rate_task(
    task_id: str,
    body: TaskRating,
    user_id: Optional[str] = Depends(get_optional_user_id),
):
    doc = await _get_task_or_404(task_id, user_id)
    patch = {"last_rating": body.rating}
    await db.tasks.update_one({"id": task_id}, {"$set": patch})
    return Task(**{**doc, **patch})


@api_router.delete("/tasks/{task_id}")
async def delete_task(task_id: str, user_id: Optional[str] = Depends(get_optional_user_id)):
    await _get_task_or_404(task_id, user_id)
    await db.tasks.delete_one({"id": task_id})
    return {"ok": True}


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
        db.conversations.delete_many({}),
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
