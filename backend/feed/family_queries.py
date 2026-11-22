"""What the daily post and the daily video search for, built around the family.

Before this, the search words came from two places only (see daily_post):

* the chat router's topic of the parent's last turns, pasted into a template
  ("12个月 宝宝 {route_topic} 宝妈") — whatever the parent last talked about,
  parenting or not. A Christian parent who builds AI products asked NURI what
  Christians make of AI, and that topic became the next day's search;
* the onboarding concerns plus three fixed stage topics (睡眠 / 辅食 / 发脾气),
  so a one-year-old's family never saw the things a one-year-old's family
  actually shops and plans for: walking, babyproofing, a stroller, a car seat.

Here the plan starts from the family instead:

1. **Needs, not loose keywords.** A fixed table of parenting needs
   (``NEEDS``), each with its own search words, the ages it belongs to and the
   words that point to it. Memory, hobbies and chat *choose* a need; the
   need's own words make the search, so a one-year-old's family gets a
   stroller and car-seat search without ever having typed "stroller".
2. **The parent's own world, as an extension.** A recent chat topic that is
   about the parent rather than a parenting need ("基督徒怎么看AI" from a
   Christian who builds AI) is not dropped: testing found that exactly this
   kind of card was one the parent liked. It leads every other day.
3. **Signals, weighted.** A critical period the parent has confirmed (the
   child's age is in its window *and* a live behavior tag says it is
   happening, see nuri_core/critical_periods) counts most, then long-term
   memory (``concern`` / ``child_state`` rows), the onboarding concerns, and
   the open periods and stage by age; the recent chat only adds weight to a
   need — it is the supplement, not the source.
3b. **At least one important tag.** A need backed by none of age (period /
   stage), behaviour, memory or the onboarding concerns — chat alone — ranks
   behind every need that has one. The parent's own interest extension is
   the exception, placed by rotate_lead as before.
4. **Standing constraints** drop needs that would clash outright (a child who
   can't walk gets no "learning to walk" search). The post-pick check still
   runs on the finished card.
5. **Same search budget.** At most as many plans as before (three, plus one
   when personal signals were usable), two searches each; the strongest needs
   rotate by day so the card isn't the same subject every morning.

Pure rules: no model call, same answer every time, explainable. Set
``DAILY_QUERY_PLANNER=legacy`` to go back to the router-topic template.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Optional, Sequence

from backend import topic_keywords
from backend.feed import standing as standing_guard

#: "family" (this module) or "legacy" (router topic + profile_plans, the
#: behaviour from 2026-11-18 to this change).
PLANNER = os.getenv("DAILY_QUERY_PLANNER", "family")


@dataclass(frozen=True)
class Need:
    id: str
    label_zh: str
    label_en: str
    words_zh: str               # the search words; the age band and "宝妈"/"moms" are added around them
    words_en: str
    ages: tuple[int, int]       # months [from, to) in which this need can come up at all
    stage: Optional[tuple[int, int]] = None   # months in which age alone proposes it
    triggers: tuple[str, ...] = ()            # words in memory / chat / hobbies that point to it
    parent_role: Optional[str] = None         # only for this parent role


_ANY_AGE = (0, 12 * 8)

#: Every subject a daily search may be about. Order is the tie-break.
NEEDS: tuple[Need, ...] = (
    Need("newborn_soothing", "新生儿安抚", "newborn crying", "新生儿 哭闹 安抚", "newborn fussy crying",
         (0, 4), stage=(0, 3), triggers=("新生儿", "肠绞痛", "腸絞痛", "胀气", "脹氣", "colic", "newborn")),
    Need("sleep", "睡眠", "sleep", "睡眠 夜醒", "sleep", (0, 72), stage=(0, 7),
         triggers=("睡", "夜醒", "小睡", "作息", "nap", "sleep", "bedtime")),
    Need("tummy_time", "趴趴与翻身", "tummy time", "趴趴练习 翻身", "tummy time rolling", (1, 8),
         stage=(2, 6), triggers=("趴", "翻身", "抬头", "tummy", "rolling")),
    Need("solids", "辅食", "starting solids", "辅食 添加", "starting solids", (4, 15), stage=(5, 12),
         triggers=("辅食", "輔食", "副食品", "米粉", "泥", "咀嚼", "手指食物", "solids", "puree", "blw")),
    Need("teething", "长牙", "teething", "长牙", "teething", (3, 30),
         triggers=("长牙", "長牙", "出牙", "牙龈", "牙齦", "teeth", "teething")),
    Need("babyproofing", "居家安全", "babyproofing", "家居安全 防护", "babyproofing", (5, 36), stage=(7, 20),
         triggers=("居家安全", "安全防护", "安全隐患", "撞", "摔", "误食", "誤食", "入口", "小物", "楼梯", "樓梯", "插座", "尖角", "防护",
                   "childproof", "babyproof")),
    Need("walking", "学步", "learning to walk", "学步 走路", "learning to walk", (7, 20), stage=(9, 16),
         triggers=("走路", "学步", "學步", "扶站", "爬", "迈步", "邁步", "walk", "crawl", "cruising")),
    Need("travel", "带娃出行", "travel with baby", "带娃出行 推车 安全座椅", "stroller car seat travel",
         (4, 60), stage=(10, 30),
         triggers=("出行", "旅行", "旅游", "旅遊", "推车", "推車", "安全座椅", "坐车", "坐車", "飞机", "飛機",
                   "自驾", "自駕", "出门", "出門", "露营", "露營", "travel", "stroller", "car seat", "flight",
                   "road trip", "camping")),
    Need("play", "在家玩什么", "play ideas", "在家 玩什么 早教游戏", "play ideas at home", (4, 48),
         stage=(8, 36), triggers=("玩具", "玩什么", "玩什麼", "游戏", "遊戲", "早教", "陪玩", "精力", "耗电",
                                  "toys", "play idea", "activities")),
    Need("separation", "分离焦虑", "separation anxiety", "分离焦虑", "separation anxiety", (6, 36),
         triggers=("分离焦虑", "分離焦慮", "黏妈妈", "黏媽媽", "粘人", "黏人", "一走开就哭", "clingy",
                   "separation")),
    Need("weaning", "断奶与夜奶", "weaning", "断奶 夜奶", "weaning night feeds", (9, 30), stage=(11, 15),
         triggers=("断奶", "斷奶", "夜奶", "戒奶", "wean")),
    Need("first_words", "说话与语言", "first words", "说话 语言启蒙", "first words speech", (8, 48),
         stage=(12, 30), triggers=("说话", "說話", "语言", "語言", "开口", "開口", "词汇", "詞彙", "发音",
                                   "speech", "talking", "first words")),
    Need("picky_eating", "挑食", "picky eating", "挑食 吃饭", "picky eating", (12, 96), stage=(15, 60),
         triggers=("挑食", "不吃", "拒食", "吐食", "吃饭", "吃飯", "正餐", "零食", "吃得少", "picky")),
    Need("tantrums", "发脾气", "tantrums", "发脾气", "tantrums", (12, 96), stage=(16, 60),
         triggers=("发脾气", "發脾氣", "躺地", "扔东西", "扔東西", "打人", "尖叫", "崩溃大哭", "tantrum")),
    Need("daycare", "入托适应", "daycare", "入托 分离焦虑", "daycare drop off crying", (6, 72),
         triggers=("托育", "托儿所", "托兒所", "托婴", "托嬰", "托班", "幼儿园", "幼兒園", "入园", "入園", "入托",
                   "保姆", "daycare", "nursery", "preschool")),
    Need("potty", "如厕训练", "potty training", "如厕训练 戒尿布", "potty training", (16, 60), stage=(22, 40),
         triggers=("如厕", "如廁", "戒尿布", "上厕所", "上廁所", "potty")),
    Need("screen_time", "屏幕时间", "screen time", "屏幕时间", "screen time", (18, 96),
         triggers=("屏幕", "螢幕", "手机", "手機", "平板", "电视", "電視", "动画片", "screen")),
    Need("sick", "生病护理", "sick toddler", "生病 发烧", "sick toddler", (0, 96),
         triggers=("发烧", "發燒", "生病", "感冒", "咳", "皮疹", "红点", "紅點", "湿疹", "濕疹", "呕吐",
                   "fever", "sick", "rash", "cough")),
    Need("sibling", "迎接二宝", "new sibling", "二胎 准备 老大", "toddler new baby sibling", (12, 96),
         triggers=("怀孕", "懷孕", "二胎", "二宝", "二寶", "pregnan", "new baby", "sibling")),
    Need("discipline", "立规矩", "discipline", "管教 规矩", "discipline", (12, 96),
         triggers=("管教", "规矩", "規矩", "界线", "界線", "边界", "邊界", "负责", "負責", "收玩具",
                   "discipline", "boundaries")),
    Need("family_roles", "家人教养分歧", "grandparents", "老人带娃 观念不同", "grandparents parenting differently",
         _ANY_AGE, triggers=("老人", "婆婆", "外婆", "奶奶带", "配偶", "老公", "分工", "宠坏", "寵壞",
                             "grandparent", "in-law")),
    Need("dad_bonding", "爸爸陪玩", "dad bonding", "爸爸 带娃 陪玩", "dad bonding with baby", _ANY_AGE,
         triggers=("陪伴时间", "陪伴時間", "陪孩子的时间", "陪的时间", "高质量陪伴", "下班"), parent_role="dad"),
    Need("parent_mood", "带娃情绪", "parent burnout", "带娃 崩溃 情绪", "parenting burnout", _ANY_AGE,
         # Only a parent at the end of their rope: "烦躁" and "愧疚" come with
         # half of all feeding and daycare worries, and the need is the worry.
         triggers=("带娃崩溃", "帶娃崩潰", "气到", "氣到", "想推", "想打", "撑不住", "撐不住", "累垮",
                   "burnout", "mom rage")),
)
NEEDS_BY_ID = {need.id: need for need in NEEDS}


def concern_need(concern: str, months: Optional[int]) -> Optional[str]:
    """The need an onboarding concern means at this age. Mirrors the age
    adjustments daily_post._concern_topic already made (food under one is
    starting solids; health past two is the next cold)."""
    young = months is not None and months < 12
    if concern == "sleep":
        return "sleep"
    if concern == "food":
        return "solids" if young else "picky_eating"
    if concern == "emotion":
        return "separation" if months is not None and months < 15 else "tantrums"
    if concern == "development":
        if months is not None and months < 7:
            return "tummy_time"
        if months is not None and months < 16:
            return "walking"
        return "first_words"
    if concern == "parenting":
        return "play" if young else "discipline"
    if concern == "health":
        return "teething" if months is None or months < 24 else "sick"
    if concern == "childcare":
        return "daycare"
    if concern == "family":
        return "family_roles"
    return None


# ── Signals ──────────────────────────────────────────────────────────────────

#: How much each source counts. Memory is what the parent has told NURI is
#: going on, kept until it is overturned; chat is only the last few turns.
WEIGHTS = {"behavior": 4, "memory": 3, "memory_soft": 1, "concern": 2, "period": 0, "stage": 1,
           "chat": 1, "hobby": 1, "interest": 2}
#: An open period nothing confirms is age again, which the stage table
#: already counts: it marks the need as resting on an important tag but adds
#: no weight, so the stroller and car-seat searches a one-year-old's family
#: also needs keep their turn. Confirmed, it brings "behavior" (4) with it.
#: The tags a push has to rest on: the child's age and behaviour, what the
#: parent told NURI, what they picked at onboarding.
IMPORTANT = frozenset({"behavior", "period", "stage", "memory", "concern"})
#: One need can't win on a pile of near-duplicate rows: the memory extractor
#: often writes the same fact under three keys.
MEMORY_HITS_CAP = 2
CHAT_HITS_CAP = 2
#: Memory rows that describe what is happening; the rest (preference, fact)
#: count softly. Constraints never propose a need: "not weaning yet" names
#: weaning and means the opposite.
_STRONG_MEMORY = {"concern", "child_state"}
_SOFT_MEMORY = {"preference", "fact"}

_AGE_IN_TEXT = re.compile(
    r"(\d+|[一二两兩三四五六七八九十半]+)\s*(个月|個月|岁|歲|周|週|天)(零?(\d+|[一二两兩三四五六七八九十]+)\s*(个月|個月))?"
)


def needs_in(text: str) -> list[str]:
    """Needs the text points to, in table order."""
    lowered = (text or "").lower()
    return [n.id for n in NEEDS if any(t.lower() in lowered for t in n.triggers)]


def _strip_topic(topic: str) -> str:
    """Ages out (the plan adds the age band itself), spaces tidied."""
    return re.sub(r"\s+", " ", _AGE_IN_TEXT.sub("", topic or "")).strip(" /／、,，")[:20]


def is_parenting(topic: str) -> bool:
    return bool(needs_in(topic) or topic_keywords.main_topic(topic))


def clean_topic(topic: str) -> str:
    """A router topic that names a parenting need, ages stripped; else ""."""
    topic = _strip_topic(topic)
    return topic if topic and is_parenting(topic) else ""


def interest_topic(topic: str) -> str:
    """A router topic about the parent's own world (faith, work, a hobby),
    ages stripped; else "". Greetings and thanks are already gone by here
    (daily_post._GENERIC_TOPICS)."""
    topic = _strip_topic(topic)
    return topic if len(topic) >= 2 and not is_parenting(topic) else ""


def _pieces(text: str) -> set[str]:
    """Two-character pieces and lower-case words, to tell whether a memory
    row is about the same thing as a chat topic."""
    out = set()
    for run in re.findall(r"[\u4e00-\u9fff]+", text or ""):
        out.update(run[i:i + 2] for i in range(len(run) - 1))
    out.update(re.findall(r"[a-z]{2,}", (text or "").lower()))
    return out - set(standing_guard._COMMON_PIECES)


@dataclass
class Candidate:
    need: Need
    score: int = 0
    sources: dict = field(default_factory=dict)     # source → hits
    topic: str = ""                                 # newest clean chat topic for this need

    def add(self, source: str, cap: int = 1) -> None:
        if self.sources.get(source, 0) >= cap:
            return
        self.sources[source] = self.sources.get(source, 0) + 1
        self.score += WEIGHTS[source]

    @property
    def important(self) -> bool:
        return bool(IMPORTANT & set(self.sources))

    @property
    def personal(self) -> bool:
        """Whether the parent said something that points here."""
        return bool({"memory", "chat", "interest"} & set(self.sources))

    @property
    def is_interest(self) -> bool:
        return self.need.id == INTEREST_ID


def _fits_age(need: Need, months: Optional[int]) -> bool:
    return months is None or need.ages[0] <= months < need.ages[1]


def _in_stage(need: Need, months: Optional[int]) -> bool:
    return need.stage is not None and months is not None and need.stage[0] <= months < need.stage[1]


#: Standing-constraint groups whose clash is the need itself (a walking search
#: for a child who can't walk). Food allergies and diets aren't here: an
#: allergic child's family still needs solids posts, and the pick check on
#: the finished card is what keeps an allergen out.
_BLOCKING_GROUPS = {"sleep_training", "mobility", "screen", "feeding"}


def blocked_by_standing(need: Need, standing: Sequence[str]) -> bool:
    words = f"{need.words_zh} {need.words_en}".lower()
    for line in (s.lower() for s in standing if s):
        for group, constraint_words, card_words in standing_guard.CONCEPTS:
            if group not in _BLOCKING_GROUPS or not any(w in line for w in constraint_words):
                continue
            if any(w in words for w in card_words):
                return True
    return False


def _hobby_texts(profile: dict) -> list[str]:
    hobbies = profile.get("hobbies")
    if isinstance(hobbies, (list, tuple)):
        texts = [str(h) for h in hobbies]
    else:
        texts = [str(hobbies or "")]
    return [t for t in texts + [str(profile.get("concern_other") or "")] if t.strip()]


def rank_needs(
    *,
    months: Optional[int],
    profile: dict,
    memories: Sequence[dict] = (),
    topics: Sequence[str] = (),
    user_texts: Sequence[str] = (),
    standing: Sequence[str] = (),
    personal: bool = True,
    period_needs: Sequence[str] = (),
    confirmed_needs: Sequence[str] = (),
) -> list[Candidate]:
    """Every need this family has a reason for, best first (ties in table order).

    ``period_needs`` / ``confirmed_needs`` come from
    critical_periods.push_signals: needs of the periods open at the child's
    age, and of those a live behavior tag confirms.

    ``personal`` False (the 外部内容检索 switch is off) leaves only the
    onboarding answers and the child's age, as before."""
    role = str(profile.get("parent_role") or "")
    cands = {n.id: Candidate(n) for n in NEEDS if (n.parent_role in (None, role))}

    def hit(need_id: Optional[str], source: str, cap: int = 1, topic: str = "") -> None:
        cand = cands.get(need_id or "")
        if cand is None:
            return
        cand.add(source, cap)
        if topic and not cand.topic:
            cand.topic = topic

    for concern in dict.fromkeys(profile.get("top_concerns") or []):
        hit(concern_need(str(concern), months), "concern")
    for need in NEEDS:
        if _in_stage(need, months):
            hit(need.id, "stage")
    for need_id in dict.fromkeys([*period_needs, *confirmed_needs]):
        hit(need_id, "period")
    if personal:
        for need_id in dict.fromkeys(confirmed_needs):
            hit(need_id, "behavior")
        for text in _hobby_texts(profile):
            for need_id in needs_in(text):
                hit(need_id, "hobby")
        for row in memories:
            category = str(row.get("category") or "")
            if category not in _STRONG_MEMORY | _SOFT_MEMORY:
                continue
            source = "memory" if category in _STRONG_MEMORY else "memory_soft"
            text = f"{row.get('key') or ''} {row.get('value') or ''}"
            for need_id in needs_in(text):
                hit(need_id, source, MEMORY_HITS_CAP)
        # Newest first, as recent_route_topics returns them.
        for raw in topics:
            topic = clean_topic(raw)
            if not topic:
                continue
            ids = needs_in(topic)
            if not ids:
                concern = topic_keywords.main_topic(topic)
                ids = [concern_need(concern, months)] if concern else []
            for need_id in ids[:1]:
                hit(need_id, "chat", CHAT_HITS_CAP, topic=topic)
        for text in reversed([t for t in user_texts if t.strip()][-8:]):
            ids = needs_in(text)
            if not ids:
                concern = topic_keywords.main_topic(text)
                ids = [concern_need(concern, months)] if concern else []
            for need_id in ids[:1]:
                hit(need_id, "chat", CHAT_HITS_CAP)

    interest = _interest_candidate(topics, memories, profile) if personal else None

    ranked = [
        c for c in cands.values()
        if c.score > 0 and (_fits_age(c.need, months) or "concern" in c.sources)
        and not blocked_by_standing(c.need, standing)
    ]
    order = {n.id: i for i, n in enumerate(NEEDS)}
    ranked.sort(key=lambda c: (not c.important, -c.score, order[c.need.id]))
    if not ranked:
        # Nothing at all (no age, no concern, nothing said): the two
        # questions parents of any young child ask most, as before.
        ranked = [Candidate(NEEDS_BY_ID["sleep"], 0, {"fallback": 1}),
                  Candidate(NEEDS_BY_ID["tantrums"], 0, {"fallback": 1})]
    if interest:
        ranked.insert(1, interest)  # rotate_lead decides whether it leads today
    return ranked


INTEREST_ID = "interest"


def _interest_candidate(topics: Sequence[str], memories: Sequence[dict], profile: dict) -> Optional[Candidate]:
    """The newest chat topic about the parent's own world, as a candidate of
    its own, searched as written. Memory rows and hobbies about the same thing
    ("用户是基督徒", "做AI开发") add to it: an interest the parent keeps coming
    back to is worth more than one stray question."""
    topic = next((t for t in (interest_topic(raw) for raw in topics) if t), "")
    if not topic:
        return None
    cand = Candidate(Need(INTEREST_ID, topic, topic, topic, "", _ANY_AGE), topic=topic)
    cand.add("interest")
    pieces = _pieces(topic)
    texts = [f"{r.get('key') or ''} {r.get('value') or ''}" for r in memories
             if str(r.get("category") or "") in _SOFT_MEMORY | _STRONG_MEMORY] + _hobby_texts(profile)
    for text in texts:
        if pieces & _pieces(text):
            cand.add("memory_soft", MEMORY_HITS_CAP)
    return cand


def rotate_lead(ranked: list[Candidate], day: date) -> list[Candidate]:
    """The needs tied for the top take turns leading, one per day, so a
    stage-only family sees walking one morning and a stroller the next, and
    a family with two equal worries sees both. The parent's own interest, if
    there is one, leads every other day and is second otherwise. The rest
    keep their order."""
    interest = [c for c in ranked if c.is_interest]
    needs = [c for c in ranked if not c.is_interest]
    if needs:
        top = [c for c in needs if c.score == needs[0].score and c.important == needs[0].important]
        start = day.toordinal() % len(top)
        needs = top[start:] + top[:start] + needs[len(top):]
    if not interest:
        return needs
    at = 0 if day.toordinal() % 2 == 0 else 1
    return needs[:at] + interest + needs[at:]


def explain(cand: Candidate) -> str:
    """"memory×2+stage" — which signals chose a need, for the admin row."""
    return "+".join(f"{s}×{n}" if n > 1 else s for s, n in cand.sources.items())

