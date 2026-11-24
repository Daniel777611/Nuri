"""The long-term memory profile, in labelled slots instead of loose sentences.

Free-text memories ("小满最近扶着沙发能走几步了") are hard for the push side
to use: every reader has to re-guess what a sentence is about. Here each
memory also carries

* a **subcategory**: each of the five categories is split into three, and
* for what the child is doing, a **behavior tag** from a closed vocabulary
  (``BEHAVIOR_TAGS``). A tag is what confirms a critical period
  (critical_periods): age says a child *may* be learning to walk, the
  ``cruises`` tag says they are.

Nothing here needs a schema change. The subcategory and the tag travel in
``user_memories.key`` (``"motor/tag:cruises"``, ``"routine/作息"``); the
value stays the parent's own words, which is what the chat and the profile
page show. Rows written before this have no prefix: ``classify`` infers their
subcategory and tags from the words, so old families get a calendar and
tagged pushes on day one without a model call.

The split is a first draft for the team to change (see the admin page
"长期记忆画像"). Keep ids stable once rows are written with them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Sequence


@dataclass(frozen=True)
class Subcategory:
    id: str
    category: str
    label_zh: str
    label_en: str
    hint: str                   # what goes here, for the extractor and the admin page


CATEGORY_LABELS = {
    "child_state": ("孩子当前状态", "What the child is doing"),
    "concern": ("家长关注点", "What the parent worries about"),
    "preference": ("家庭偏好", "Family preferences"),
    "constraint": ("约束条件", "Standing constraints"),
    "fact": ("其他信息", "Other facts"),
}

SUBCATEGORIES: tuple[Subcategory, ...] = (
    # 孩子当前状态 — the behaviour that confirms a critical period lives here.
    Subcategory("motor", "child_state", "大运动与精细动作", "Movement",
                "抬头、翻身、坐、爬、扶站、走、抓握"),
    Subcategory("language_social", "child_state", "语言与社交情绪", "Language & feelings",
                "发音、说词、指物、认生、黏人、发脾气、说不"),
    Subcategory("routine", "child_state", "睡眠饮食与作息", "Sleep, food & routine",
                "夜醒、小睡、夜奶、辅食、挑食、长牙、如厕"),
    # 家长关注点
    Subcategory("development_worry", "concern", "发育担忧", "Development worries",
                "担心说话晚、走路晚、长得慢、是否正常"),
    Subcategory("behavior_worry", "concern", "行为与情绪困扰", "Behaviour worries",
                "发脾气、打人、黏人、分离焦虑、管不住"),
    Subcategory("care_worry", "concern", "照护难题", "Care struggles",
                "哄睡、喂养、入托、生病护理、家人分工"),
    # 家庭偏好
    Subcategory("parenting_style", "preference", "育儿理念", "Parenting approach",
                "温和教养、顺其自然、科学喂养等坚持"),
    Subcategory("content_style", "preference", "内容与沟通偏好", "Content & tone",
                "想看研究还是经验、喜欢短还是详细"),
    Subcategory("family_activity", "preference", "家庭活动与兴趣", "Family activities",
                "出行、户外、阅读、音乐、运动"),
    # 约束条件
    Subcategory("health_limit", "constraint", "健康与身体限制", "Health limits",
                "过敏、诊断、身体或行动限制"),
    Subcategory("declined_method", "constraint", "不接受的做法", "Declined methods",
                "不训睡、不用配方奶、不看屏幕"),
    Subcategory("family_situation", "constraint", "特殊家庭处境", "Family situation",
                "单亲、异地、经济紧张、照护者有限"),
    # 其他信息
    Subcategory("household", "fact", "家庭成员与照护分工", "Household",
                "谁带娃、老人同住、二胎、宠物"),
    Subcategory("schedule_place", "fact", "生活作息与环境", "Schedule & place",
                "上班时间、入托时间、居住城市、搬家"),
    Subcategory("parent_world", "fact", "家长自己的世界", "The parent's own world",
                "职业、信仰、爱好（推送的「延伸兴趣」用它）"),
)
SUBCATEGORIES_BY_ID = {s.id: s for s in SUBCATEGORIES}
UNSORTED = "unsorted"


@dataclass(frozen=True)
class BehaviorTag:
    id: str
    subcategory: str
    label_zh: str
    label_en: str
    words: tuple[str, ...]      # how a parent says it, for rows written before tags
    #: How long one observation counts. Development moves on: "扶着走" from
    #: four months ago says nothing about today.
    ttl_weeks: int = 12


BEHAVIOR_TAGS: tuple[BehaviorTag, ...] = (
    # Movement
    BehaviorTag("holds_head", "motor", "抬头稳了", "Holds head up", ("抬头", "抬頭", "趴着抬", "holds head")),
    BehaviorTag("rolls", "motor", "会翻身", "Rolls over", ("翻身", "rolls over", "rolling")),
    BehaviorTag("sits", "motor", "能独坐", "Sits alone", ("独坐", "獨坐", "坐稳", "坐穩", "自己坐", "sits up", "sitting")),
    BehaviorTag("crawls", "motor", "会爬", "Crawls", ("会爬", "會爬", "在爬", "爬行", "到处爬", "crawl")),
    BehaviorTag("pulls_to_stand", "motor", "扶着站起来", "Pulls to stand", ("扶站", "扶着站", "扶著站", "pulls to stand")),
    BehaviorTag("cruises", "motor", "扶着走", "Cruises", ("扶走", "扶着走", "扶著走", "扶着沙发", "扶著沙發", "迈步", "邁步", "cruising")),
    BehaviorTag("walks", "motor", "能自己走", "Walks alone", ("会走", "會走", "自己走", "独立行走", "獨立行走", "走路了", "walking", "walks")),
    # Language and feelings
    BehaviorTag("babbles", "language_social", "咿呀发音", "Babbles", ("咿呀", "咿咿呀呀", "babbl")),
    BehaviorTag("first_words", "language_social", "说出第一个词", "First words", ("叫妈妈", "叫爸爸", "第一个词", "第一個詞", "会叫", "會叫", "first word")),
    BehaviorTag("points", "language_social", "会用手指东西", "Points", ("用手指", "指东西", "指東西", "point")),
    BehaviorTag("word_burst", "language_social", "词汇突然变多", "Many new words", ("词汇", "詞彙", "新词", "新詞", "会说很多", "會說很多", "word burst")),
    BehaviorTag("two_words", "language_social", "说两个词的短句", "Two-word phrases", ("两个词", "兩個詞", "短句", "two-word")),
    BehaviorTag("late_talk", "language_social", "说话还少", "Talks little yet", ("说话晚", "說話晚", "不太说话", "不太說話", "还不会说", "還不會說", "不开口", "不開口", "late talk")),
    BehaviorTag("stranger_anxiety", "language_social", "怕生", "Wary of strangers", ("怕生", "认生", "認生", "stranger")),
    BehaviorTag("clingy", "language_social", "黏人、分开就哭", "Clingy", ("黏人", "粘人", "黏妈妈", "黏媽媽", "一走开就哭", "一走開就哭", "分离焦虑", "分離焦慮", "clingy")),
    BehaviorTag("says_no", "language_social", "常说不、要自己来", "Says no", ("说不", "說不", "自己来", "自己來", "不要不要", "says no")),
    BehaviorTag("tantrums", "language_social", "发脾气", "Tantrums", ("发脾气", "發脾氣", "躺地", "哭闹打滚", "哭鬧打滾", "tantrum")),
    BehaviorTag("hits_bites", "language_social", "打人咬人", "Hits or bites", ("打人", "咬人", "hits", "bites")),
    # Sleep, food and routine
    BehaviorTag("night_waking", "routine", "夜醒变多", "Waking at night", ("夜醒", "醒好几次", "醒好幾次", "睡不整觉", "睡不整覺", "night waking")),
    BehaviorTag("nap_change", "routine", "小睡在变", "Naps changing", ("并觉", "併覺", "小睡变", "小睡變", "只睡一觉", "只睡一覺", "nap transition")),
    BehaviorTag("night_feeds", "routine", "还在夜奶", "Night feeds", ("夜奶", "night feed")),
    BehaviorTag("food_interest", "routine", "对大人的食物感兴趣", "Interested in food", ("盯着吃", "盯著吃", "抢食物", "搶食物", "对食物感兴趣", "對食物感興趣")),
    BehaviorTag("on_solids", "routine", "开始吃辅食", "Started solids", ("辅食", "輔食", "副食品", "solids")),
    BehaviorTag("picky", "routine", "挑食拒食", "Picky eating", ("挑食", "拒食", "不肯吃", "picky")),
    BehaviorTag("teething", "routine", "在长牙", "Teething", ("长牙", "長牙", "出牙", "teething")),
    BehaviorTag("potty_signs", "routine", "有如厕信号", "Potty signs", ("坐马桶", "坐馬桶", "尿了会说", "尿了會說", "尿布干", "尿布乾", "potty")),
)
BEHAVIOR_TAGS_BY_ID = {t.id: t for t in BEHAVIOR_TAGS}

_TAG_KEY = re.compile(r"^(?:(?P<sub>[a-z_]+)/)?tag:(?P<tag>[a-z_]+)$")
_SUB_KEY = re.compile(r"^(?P<sub>[a-z_]+)/(?P<rest>.+)$")
#: Reading a tag from the words has to fail towards "not said": a tag shows
#: the parent "已出现" on the growth calendar, quoting their own sentence, so
#: "快4个月了还不会翻身" read as 会翻身 tells a worried parent the opposite of
#: what they said. A sentence that is negated, doubtful or about stopping
#: something gives no tag.
_CLAUSE_END = re.compile(r"[，,。.;；！!？?、\n]")
#: How far before the word a 不/没 still negates it, inside one clause:
#: "还没开始吃辅食" has four characters between 没 and 辅食.
_ZH_REACH = 5
#: Not 别: it sits inside 特别, which is how parents say "very".
_ZH_NEG_BEFORE = re.compile(r"[不没沒未]")
#: Right in front of the word only: "断夜奶", "戒夜奶".
_ZH_STOP_BEFORE = re.compile(r"[断斷戒]$")
#: Right after the word: "翻身还不会", "抬头还不稳", "坐得不稳", "夜奶戒掉了".
_ZH_NEG_AFTER = re.compile(r"^(还|還|都|也|得|的|已经|已經)?([不没沒未]|戒|断|斷|停)")
#: Phrases with 不/没/断 in them that do not negate: "一直不停翻身",
#: "夜醒不少", "会走路没多久", "翻身没问题". Masked before looking.
_NOT_NEGATION = ("断断续续", "斷斷續續", "没多久", "沒多久", "没问题", "沒問題",
                 "不停", "不断", "不斷", "不少", "不止", "不久", "不错", "不錯")
_EN_NEG = re.compile(
    r"\b(not|never|no longer|no more|isn'?t|aren'?t|doesn'?t|don'?t|hasn'?t|haven'?t|"
    r"can'?t|cannot|won'?t|yet to|stopped)\b"
)


def make_key(subcategory: str, key: str, tag: str = "") -> str:
    """The user_memories.key for an extracted memory. A tagged observation
    is keyed by its tag, so the same behaviour said twice updates one row."""
    sub = subcategory if subcategory in SUBCATEGORIES_BY_ID else ""
    if tag in BEHAVIOR_TAGS_BY_ID:
        sub = sub or BEHAVIOR_TAGS_BY_ID[tag].subcategory
        return f"{sub}/tag:{tag}"
    key = bare_key(key)
    return f"{sub}/{key}" if sub and key else key


def bare_key(key: str) -> str:
    """The key without its subcategory prefix, as the extractor sees it."""
    key = (key or "").strip()
    m = _SUB_KEY.match(key)
    return m.group("rest") if m and m.group("sub") in SUBCATEGORIES_BY_ID else key


def _mask_non_negations(text: str) -> str:
    for phrase in _NOT_NEGATION:
        text = text.replace(phrase, "·" * len(phrase))
    return text


def _mentions(text: str, word: str) -> bool:
    """Whether the text says the word happens: one occurrence that is not
    negated within its clause. English words must start a word, so "sitting"
    is not found in "babysitting" nor "point" in "appointment"."""
    lowered = _mask_non_negations(text.lower())
    needle = word.lower()
    english = needle.isascii()
    start = lowered.find(needle)
    while start >= 0:
        end = start + len(needle)
        clause_start = max((m.end() for m in _CLAUSE_END.finditer(lowered, 0, start)), default=0)
        after_clause = _CLAUSE_END.search(lowered, end)
        before = lowered[clause_start:start]
        after = lowered[end:after_clause.start() if after_clause else len(lowered)]
        if english:
            ok = (start == 0 or not lowered[start - 1].isalpha()) and not _EN_NEG.search(before)
        else:
            ok = not (
                _ZH_NEG_BEFORE.search(before[-_ZH_REACH:])
                or _ZH_STOP_BEFORE.search(before)
                or _ZH_NEG_AFTER.search(after)
            )
        if ok:
            return True
        start = lowered.find(needle, start + 1)
    return False


def tags_in(text: str) -> list[str]:
    """Behavior tags a free-text memory describes, in vocabulary order."""
    return [t.id for t in BEHAVIOR_TAGS if any(_mentions(text or "", w) for w in t.words)]


@dataclass(frozen=True)
class Classified:
    category: str
    subcategory: str            # a SUBCATEGORIES id, or UNSORTED
    tags: tuple[str, ...]
    inferred: bool              # from the words, not written by the extractor


#: Words (Chinese, and the English snake_case stems the extractor used for
#: keys before subcategories) that place an untagged old row. Checked in
#: SUBCATEGORIES order within its category; the first hit wins.
_SUB_WORDS: dict[str, tuple[str, ...]] = {
    "motor": ("motor", "mobility", "stairs", "climb", "crawl", "walk", "spatial", "mouth_object",
              "vertical_hold", "爬", "走", "扑", "撲", "空间探索", "空間探索", "大运动", "大運動"),
    "language_social": ("language", "name_respon", "responds_to_name", "separation", "frustration", "crying",
                        "mood", "grumpi", "temperament", "energy", "emotion", "说话", "說話", "语言", "語言",
                        "情绪", "情緒", "脾气", "脾氣", "黏", "粘", "认生", "認生"),
    "routine": ("sleep", "nap", "feeding", "cup", "weight", "night", "bedtime", "spit", "eyes", "落地",
                "睡", "醒", "奶", "吃", "辅食", "輔食", "体重", "體重", "精神"),
    "development_worry": ("language", "development", "head_bump", "说话", "說話", "走路", "发育", "發育",
                          "身高", "体重", "體重", "正常"),
    "behavior_worry": ("anger", "separation", "conflict", "excited", "脾气", "脾氣", "打人", "黏", "粘",
                       "分离", "分離", "哭闹", "哭鬧", "管教"),
    "care_worry": ("feeding", "nutrition", "childcare", "rash", "work_busy", "night", "睡", "吃", "奶", "托",
                   "生病", "发烧", "發燒", "餵食", "喂食", "副食品", "夜间", "夜間"),
    "parenting_style": ("parenting", "care_", "father", "education", "philosophy", "obedience", "comfort",
                        "crying", "breastfeeding", "feeding_style", "feeding_response", "medication",
                        "sleep_routine", "snack", "water", "interaction", "理念", "温和", "溫和", "坚持",
                        "堅持", "方式"),
    "content_style": ("info_style", "task_format", "task_style", "support_type", "研究", "经验", "經驗",
                      "简短", "簡短", "详细", "詳細"),
    "family_activity": ("interest_topics", "activity", "outdoor", "travel", "出行", "旅行", "户外", "戶外",
                        "阅读", "閱讀", "音乐", "音樂", "运动", "運動"),
    "health_limit": ("medication", "allerg", "safety", "diagnos", "过敏", "過敏", "诊断", "診斷", "瘫", "癱",
                     "疾病", "安全"),
    "declined_method": ("feeding_rule", "feeding_response", "night_weaning", "respond_to_crying", "discipline",
                        "interaction_focus", "不训睡", "不訓睡", "不用", "不想", "不再", "拒绝", "拒絕",
                        "配方奶", "抱睡"),
    "family_situation": ("schedule", "time_constraint", "father_time", "spouse", "单亲", "單親", "异地",
                         "異地", "经济", "經濟"),
    "household": ("caregiv", "grandmother", "family_", "partner", "parent_role", "handoff", "pregnan",
                  "names_used", "老人", "奶奶", "外婆", "婆婆", "老公", "二胎", "保姆", "家庭角色"),
    "schedule_place": ("routine", "arrival", "shift", "location", "residence", "meal", "breakfast", "sleep",
                       "nap", "stair_gate", "illness", "feeding", "安抚", "安撫", "上班", "工作日", "入托", "城市", "搬家", "住在",
                       "所在地", "夜班", "楼梯", "樓梯", "辅食", "輔食", "奶仍"),
    "parent_world": ("parent_identity", "focus_topics", "职业", "職業", "信仰", "基督", "工程师", "工程師",
                     "开发", "開發", "爱好", "愛好"),
}


def classify(row: dict) -> Classified:
    """Subcategory and behavior tags of one user_memories row."""
    category = str(row.get("category") or "fact")
    key = str(row.get("key") or "")
    value = str(row.get("value") or "")
    m = _TAG_KEY.match(key)
    if m and m.group("tag") in BEHAVIOR_TAGS_BY_ID:
        tag = BEHAVIOR_TAGS_BY_ID[m.group("tag")]
        return Classified(category, m.group("sub") or tag.subcategory, (tag.id,), False)
    m = _SUB_KEY.match(key)
    if m and m.group("sub") in SUBCATEGORIES_BY_ID:
        # Written by the extractor, which read the whole conversation and
        # chose tag "" (a behavior would have made this a tag: key). Its
        # judgement stands; re-reading the words could only overturn it with
        # a worse one ("抬头还不太稳" → 抬头稳了).
        return Classified(category, m.group("sub"), (), False)
    text = f"{key} {value}".lower()
    tags = tuple(tags_in(text)) if category == "child_state" else ()
    if tags:
        return Classified(category, BEHAVIOR_TAGS_BY_ID[tags[0]].subcategory, tags, True)
    options = [s for s in SUBCATEGORIES if s.category == category]
    for sub in options:
        if any(w in text for w in _SUB_WORDS.get(sub.id, ())):
            return Classified(category, sub.id, (), True)
    return Classified(category, UNSORTED, (), True)


def subcategory_ids(category: Optional[str] = None) -> list[str]:
    return [s.id for s in SUBCATEGORIES if category in (None, s.category)]


def taxonomy(locale: str = "zh-CN") -> list[dict]:
    """Categories → subcategories → tags, for the admin page."""
    en = locale == "en"
    out = []
    for category, (zh, en_label) in CATEGORY_LABELS.items():
        out.append({
            "id": category,
            "label": en_label if en else zh,
            "subcategories": [
                {
                    "id": s.id,
                    "label": s.label_en if en else s.label_zh,
                    "hint": s.hint,
                    "tags": [
                        {"id": t.id, "label": t.label_en if en else t.label_zh, "ttl_weeks": t.ttl_weeks}
                        for t in BEHAVIOR_TAGS if t.subcategory == s.id
                    ],
                }
                for s in SUBCATEGORIES if s.category == category
            ],
        })
    return out


def extraction_guide() -> str:
    """The subcategory and tag lists, as the extractor's prompt shows them."""
    lines = [
        "孩子的名字、生日、月龄、性别已经在孩子档案里，不要再提取成 memory。",
        "subcategory（每条 memory 都要填，按 category 选）：",
    ]
    for category, (zh, _) in CATEGORY_LABELS.items():
        subs = "；".join(f"{s.id}={s.label_zh}（{s.hint}）" for s in SUBCATEGORIES if s.category == category)
        lines.append(f"- {category}：{subs}")
    lines.append(
        "tag：只有 category=child_state、家长描述的是孩子正在出现的行为时才填，从下面选一个最贴切的；"
        "不是这些行为、或只是担心还没出现，就填空字符串。"
    )
    lines.append("- " + "；".join(f"{t.id}={t.label_zh}" for t in BEHAVIOR_TAGS))
    return "\n".join(lines)


def known_label(row: dict) -> str:
    """"child_state/motor" for the extractor's list of what is remembered."""
    c = classify(row)
    return f"{c.category}/{c.subcategory}" if c.subcategory != UNSORTED else c.category


def tagged_rows(rows: Sequence[dict]) -> list[tuple[dict, Classified]]:
    return [(r, c) for r in rows for c in [classify(r)] if c.tags]
