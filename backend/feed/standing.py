"""What the home cards must not contradict.

The daily post and the daily video used to know a family only through the
onboarding concerns and the last eight messages. A parent who said weeks ago
that they had stopped sleep training was still shown sleep-training posts: the
concern "睡眠" they ticked at sign-up never expired, and the sentence that
overturned it had long scrolled out of the window.

The standing memories (``family_store.load_standing_memories``) close that gap
in two places:

1. **Before the pick.** The plan and pick prompts are told what the family's
   situation rules out, so the model searches and chooses around it.
2. **After the pick.** A separate yes/no check on the finished card. Telling a
   picker "don't" is a preference it weighs against fit; a conflict such as
   瘫痪 versus 跑步 is semantic, with no shared words to catch, and is the one
   mistake a card cannot be allowed to make. One small call per generated card,
   and a card is generated once a day.

The check fails open: if the model cannot be reached the card is shown, because
the prompt already carried the constraints and an empty home screen is its own
failure. It is logged under its own call site so a rise is visible.

Before the model, a keyword prefilter (``needs_check``) skips the call only
when it can tell the card cannot touch any of the constraints. Shared words
are not enough for that — 瘫痪 and 跑步 share none — so each constraint is
put into a concept group with the card words that could clash with it, and a
constraint that fits no group always goes to the model.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Sequence

from backend import llm_usage, runtime

MODEL = os.getenv("STANDING_CHECK_MODEL", "gpt-5.4-mini")
TIMEOUT_S = float(os.getenv("STANDING_CHECK_TIMEOUT_S", "15"))
#: STANDING_PREFILTER=0 sends every card to the model again.
PREFILTER = os.getenv("STANDING_PREFILTER", "1") == "1"

_FOOD_WORDS = (
    "吃", "辅食", "輔食", "食谱", "食譜", "奶", "蛋", "坚果", "堅果", "花生", "肉", "鱼", "魚", "虾", "蝦",
    "麦", "麥", "豆", "果", "菜", "饭", "飯", "餐", "零食", "recipe", "food", "eat", "milk", "egg", "nut",
    "peanut", "meat", "fish", "snack", "meal", "formula", "feed", "wheat", "dairy",
)

#: (group, words in a constraint that put it in the group, words in a card
#: that could clash with it). Card words are deliberately broad: a word too
#: many only costs a model call; a word too few lets a clash through.
CONCEPTS: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("sleep_training",
     ("训睡", "訓睡", "睡眠训练", "睡眠訓練", "哭声免疫", "哭聲免疫", "sleep train", "cry it out", "ferber"),
     ("训睡", "訓睡", "睡眠训练", "睡眠訓練", "哭声免疫", "哭聲免疫", "法伯", "费伯", "自主入睡", "自己入睡",
      "哄睡", "sleep train", "cry it out", "ferber", "extinction", "self-soothe", "self soothe")),
    ("mobility",
     ("瘫痪", "癱瘓", "轮椅", "輪椅", "骨折", "石膏", "不能走", "不能跑", "行动不便", "行動不便", "脑瘫", "腦癱",
      "肌张力", "肌張力", "受伤", "受傷", "wheelchair", "paraly", "cast", "fracture", "cerebral palsy"),
     ("跑", "跳", "爬", "运动", "運動", "户外", "戶外", "体能", "體能", "球", "走路", "攀", "骑", "騎", "游泳",
      "滑梯", "公园", "公園", "run", "jump", "climb", "sport", "outdoor", "bike", "swim", "walk", "crawl",
      "playground", "active")),
    ("allergy",
     ("过敏", "過敏", "湿疹", "濕疹", "哮喘", "allerg", "eczema", "asthma"),
     _FOOD_WORDS + ("草", "花", "宠物", "寵物", "猫", "貓", "狗", "户外", "戶外", "尘", "塵", "毛绒", "毛絨",
                    "洗", "霜", "乳液", "药", "藥", "pollen", "dust", "pet", "outdoor", "cream", "lotion",
                    "medicine", "soap", "bath")),
    ("diet",
     ("素食", "不吃", "忌口", "清真", "乳糖不耐", "麸质", "麩質", "gluten", "vegan", "vegetarian", "halal",
      "kosher", "lactose"),
     _FOOD_WORDS),
    ("screen",
     ("屏幕", "螢幕", "手机", "手機", "平板", "电视", "電視", "看视频", "看影片", "screen"),
     ("屏幕", "螢幕", "手机", "手機", "平板", "ipad", "电视", "電視", "动画", "動畫", "视频", "影片", "app",
      "screen", "tv", "tablet", "phone", "video", "cartoon")),
    ("feeding",
     ("亲喂", "親餵", "母乳", "断奶", "斷奶", "奶粉", "瓶喂", "瓶餵", "breastfe", "formula", "bottle"),
     ("亲喂", "親餵", "母乳", "哺乳", "奶粉", "瓶喂", "瓶餵", "断奶", "斷奶", "喂奶", "餵奶", "夜奶", "奶睡",
      "breastfe", "nursing", "formula", "bottle", "wean")),
)

#: Two-character pieces too common in any parenting text to mean a shared subject.
_COMMON_PIECES = {
    "宝宝", "寶寶", "孩子", "我们", "我們", "家长", "家長", "不要", "已经", "已經", "现在", "現在", "时候",
    "時候", "一个", "一個", "可以", "没有", "沒有", "因为", "因為", "所以", "这个", "這個", "不能", "不想",
    "妈妈", "媽媽", "爸爸", "家里", "家裡", "每天", "晚上", "白天", "开始", "開始", "最近", "以后", "以後",
}
_STOP_WORDS = {"with", "that", "this", "from", "have", "your", "baby", "child", "kids", "about", "they", "their"}


def _shares_a_word(line: str, card: str) -> bool:
    for run in re.findall(r"[\u4e00-\u9fff]+", line):
        if any(run[i:i + 2] not in _COMMON_PIECES and run[i:i + 2] in card for i in range(len(run) - 1)):
            return True
    return any(w not in _STOP_WORDS and re.search(rf"\b{re.escape(w)}", card)
               for w in re.findall(r"[a-z]{4,}", line))


def needs_check(card_text: str, standing: Sequence[str]) -> bool:
    """Whether the model must look at this card. False only when every
    constraint falls in a known concept group and the card has none of that
    group's words, and shares no real word with the constraint either."""
    card = (card_text or "").lower()
    for line in (s.lower() for s in standing if s):
        groups = [g for g in CONCEPTS if any(w in line for w in g[1])]
        if not groups:
            return True  # nothing to reason with: the model decides
        if any(w in card for g in groups for w in g[2]) or _shares_a_word(line, card):
            return True
    return False


def prompt_block(standing: Sequence[str]) -> str:
    """The constraints, phrased for a plan or pick prompt. Empty when none."""
    lines = [s for s in standing if s]
    if not lines:
        return ""
    return (
        "这个家庭现在的状况和限制（家长之前说过，长期有效）：\n"
        + "\n".join(f"- {s}" for s in lines)
        + "\n与这些冲突的内容一律不要选，即使问题本身相关"
        "（例如家长已经不训睡了，就不要选讲训睡方法的；孩子行动受限，就不要选靠跑跳的活动）。"
    )


_CHECK_SYSTEM = """你是 NURI 的推荐审核。下面是一张准备推给某位家长的卡片，以及这个家庭长期有效的状况和限制。
判断这张卡片的主要内容或建议，是否与其中任何一条冲突——也就是家长看了会觉得"你根本没记住我说过的话"，或者照做对这个孩子不合适、不安全。
- 只是话题相近但不冲突的，不算（例如家长不训睡了，卡片讲的是睡前仪式、作息安排，不算冲突）。
- 卡片在讲被家长明确拒绝或已经停止的做法，算冲突。
- 卡片建议的活动或做法不适合孩子的身体状况、过敏或诊断，算冲突。"""

_CHECK_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "standing_conflict",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                # Before the verdict on purpose, so the verdict follows from it.
                "reason": {"type": "string"},
                "conflict": {"type": "boolean"},
            },
            "required": ["reason", "conflict"],
            "additionalProperties": False,
        },
    },
}


def conflicts(card_text: str, standing: Sequence[str], *, call_site: str) -> bool:
    """Whether the card contradicts any standing memory. Blocking; call off
    the event loop. False on any failure (see the module docstring)."""
    lines = [s for s in standing if s]
    if not lines or not (card_text or "").strip():
        return False
    if PREFILTER and not needs_check(card_text, lines):
        print(f"[info] standing prefilter: no overlap, skipped the check ({call_site})")
        return False
    client = runtime.oai
    if client is None:
        return False
    prompt = (
        "家庭的状况和限制：\n" + "\n".join(f"- {s}" for s in lines)
        + "\n\n卡片内容：\n" + card_text.strip()[:1500]
    )
    started = datetime.now(timezone.utc)
    try:
        resp = client.with_options(timeout=TIMEOUT_S).chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": _CHECK_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            response_format=_CHECK_FORMAT,
        )
    except Exception as exc:
        llm_usage.record(
            call_site, MODEL, status="error", error=f"{type(exc).__name__}: {exc}",
            duration_ms=int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        )
        print(f"[warn] standing check failed open: {type(exc).__name__}")
        return False
    llm_usage.record(
        call_site, MODEL, usage=getattr(resp, "usage", None),
        duration_ms=int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
    )
    try:
        data = json.loads(resp.choices[0].message.content or "{}")
    except (TypeError, ValueError):
        return False
    if data.get("conflict") is True:
        print(f"[info] standing check rejected a card: {str(data.get('reason') or '')[:120]}")
        return True
    return False
