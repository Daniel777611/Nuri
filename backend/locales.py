"""Resource-language preference, shared by the feed and the privacy settings.

Three functions and a set, split out only because both the delivery layer and
the store layer need them and neither should import the other. `zh` is accepted
and normalised because older clients still send it.
"""

from __future__ import annotations

from typing import Optional

SUPPORTED_PREFERRED_LOCALES = frozenset({"zh-CN", "zh-TW", "en"})


def normalize_preferred_locale(value: object) -> str:
    if value == "zh":
        return "zh-CN"
    if isinstance(value, str) and value in SUPPORTED_PREFERRED_LOCALES:
        return value
    return "zh-CN"


def with_requested_preferred_locale(
    context: dict,
    requested_locale: Optional[str],
) -> dict:
    """Apply a one-request resource locale without mutating saved privacy."""

    effective_locale = (
        requested_locale
        if requested_locale in SUPPORTED_PREFERRED_LOCALES
        else normalize_preferred_locale(context.get("preferred_locale"))
    )
    return {**context, "preferred_locale": effective_locale}


# ── Composed phrases ─────────────────────────────────────────────────────────
# Sentences the backend builds with the family's own words inside them. The
# frontend cannot translate these — it receives them finished, so there is no
# key to look up — which is why they are the one thing that stayed Simplified
# after every screen was wired.
#
# Simplified is the fallback for the same reason it is the key space on the
# frontend: an unwritten phrase degrades to readable Chinese rather than to a
# placeholder.

_PHRASES: dict[str, dict[str, str]] = {
    # The library's eight topic names. They reach a card two ways — on their own,
    # where the frontend can translate them, and interpolated into a composed
    # title, where it cannot. Kept here so both paths give the same words.
    "topic.亲子互动": {
        "zh-CN": "亲子互动", "zh-TW": "親子互動", "en": "connection",
    },
    "topic.发展阶段与里程碑": {
        "zh-CN": "发展阶段与里程碑", "zh-TW": "發展階段與里程碑",
        "en": "stages and milestones",
    },
    "topic.居家安全": {
        "zh-CN": "居家安全", "zh-TW": "居家安全", "en": "home safety",
    },
    "topic.情绪调节": {
        "zh-CN": "情绪调节", "zh-TW": "情緒調節", "en": "big feelings",
    },
    "topic.挑食与营养": {
        "zh-CN": "挑食与营养", "zh-TW": "挑食與營養", "en": "picky eating",
    },
    "topic.睡眠与作息": {
        "zh-CN": "睡眠与作息", "zh-TW": "睡眠與作息", "en": "sleep and routines",
    },
    "topic.行为与边界": {
        "zh-CN": "行为与边界", "zh-TW": "行為與邊界", "en": "behaviour and boundaries",
    },
    "topic.语言与沟通": {
        "zh-CN": "语言与沟通", "zh-TW": "語言與溝通", "en": "language and communication",
    },
    "title.authority": {
        "zh-CN": "{stage}的“{topic}”：哪些进展值得观察",
        "zh-TW": "{stage}的「{topic}」：哪些進展值得觀察",
        "en": "What the evidence says about {topic} at {stage}",
    },
    "title.featured": {
        "zh-CN": "今天就能做：把“{topic}”变成一个日常小练习",
        "zh-TW": "今天就能做：把「{topic}」變成一個日常小練習",
        "en": "A practical method to try today: {topic}",
    },
    "title.case": {
        "zh-CN": "相似家庭如何一步步面对“{topic}”",
        "zh-TW": "相似家庭如何一步步面對「{topic}」",
        "en": "How a similar family approached it: {topic}",
    },
    "dynamic.title": {
        "zh-CN": "继续了解：{topic}",
        "zh-TW": "繼續了解：{topic}",
        "en": "More on: {topic}",
    },
    "dynamic.summary": {
        "zh-CN": "NURI 会依据这次对话，分别核验权威内容、精彩解读和真实家庭案例。",
        "zh-TW": "NURI 會依據這次對話，分別核驗權威內容、精彩解讀和真實家庭案例。",
        "en": "NURI will check an authoritative source, a well-explained take and a real family's story against this conversation.",
    },
    "dynamic.cta": {
        "zh-CN": "为这次对话检索内容",
        "zh-TW": "為這次對話檢索內容",
        "en": "Search for this conversation",
    },
    "guide": {
        "zh-CN": "这组内容围绕你最近提到的“{focus}”，并结合{stage}筛选。{intro}",
        "zh-TW": "這組內容圍繞你最近提到的「{focus}」，並結合{stage}篩選。{intro}",
        "en": "Chosen around what you recently raised — “{focus}” — and filtered for {stage}. {intro}",
    },
    "intro.authority": {
        "zh-CN": "先用权威依据判断当前阶段值得观察什么，再决定是否需要进一步咨询。",
        "zh-TW": "先用權威依據判斷目前階段值得觀察什麼，再決定是否需要進一步諮詢。",
        "en": "Use authoritative guidance to decide what is worth watching at this stage, then decide whether to seek further advice.",
    },
    "intro.featured": {
        "zh-CN": "这组内容把可靠结论转成今天就能尝试的做法，并优先照顾你的现实时间限制。",
        "zh-TW": "這組內容把可靠結論轉成今天就能嘗試的做法，並優先照顧你的現實時間限制。",
        "en": "This turns reliable conclusions into something you can try today, and respects the time you actually have.",
    },
    "intro.case": {
        "zh-CN": "这个真实家庭案例用于理解过程和调整方法，不代表普遍效果或医学建议。",
        "zh-TW": "這個真實家庭案例用於理解過程和調整方法，不代表普遍效果或醫學建議。",
        "en": "This real family's story is here to show process and adjustment. It is not a general result and not medical advice.",
    },
    "stage.unknown": {
        "zh-CN": "当前发展阶段",
        "zh-TW": "目前發展階段",
        "en": "your child's current stage",
    },
    "reason.focus": {
        "zh-CN": "因为你最近重点聊到“{term}”，这篇内容与“{topic}”直接相关",
        "zh-TW": "因為你最近重點聊到「{term}」，這篇內容與「{topic}」直接相關",
        "en": "Because you have been focusing on “{term}”, and this is directly about “{topic}”",
    },
    "reason.topic": {
        "zh-CN": "因为你最近和 NURI 聊到了“{topic}”",
        "zh-TW": "因為你最近和 NURI 聊到了「{topic}」",
        "en": "Because you and NURI have been talking about “{topic}”",
    },
    "reason.intent": {
        "zh-CN": "你现在想要{intent}，{continuity}“{focus}”；这篇内容与“{topic}”直接相关",
        "zh-TW": "你現在想要{intent}，{continuity}「{focus}」；這篇內容與「{topic}」直接相關",
        "en": "You are looking to {intent}, {continuity} “{focus}” — and this is directly about “{topic}”",
    },
    "reason.inherited": {
        "zh-CN": "{continuity}“{focus}”，这篇内容与“{topic}”直接相关",
        "zh-TW": "{continuity}「{focus}」，這篇內容與「{topic}」直接相關",
        "en": "{continuity} “{focus}” — and this is directly about “{topic}”",
    },
    "continuity.history": {
        "zh-CN": "结合你最近其他对话里提到的",
        "zh-TW": "結合你最近其他對話裡提到的",
        "en": "picking up what you mentioned in an earlier conversation:",
    },
    "continuity.current": {
        "zh-CN": "延续你之前提到的",
        "zh-TW": "延續你之前提到的",
        "en": "continuing from what you raised earlier:",
    },
    "continuity.current_short": {
        "zh-CN": "延续你提到的",
        "zh-TW": "延續你提到的",
        "en": "following on from",
    },
    "reason.no_history": {
        "zh-CN": "还没有足够的近期对话，这是 NURI 的可信来源精选",
        "zh-TW": "還沒有足夠的近期對話，這是 NURI 的可信來源精選",
        "en": "Not enough recent conversation yet, so these are NURI's trusted-source picks",
    },
    "reason.supplement": {
        "zh-CN": "NURI 从可信育儿来源中为你补充精选",
        "zh-TW": "NURI 從可信育兒來源中為你補充精選",
        "en": "A selection NURI added from trusted parenting sources",
    },
    "reason.privacy_off": {
        "zh-CN": "你已关闭对话个性化，这是 NURI 的可信来源精选",
        "zh-TW": "你已關閉對話個人化，這是 NURI 的可信來源精選",
        "en": "Conversation personalisation is off, so these are NURI's trusted-source picks",
    },
    "reason.unavailable": {
        "zh-CN": "近期对话暂时无法读取，这是 NURI 的可信来源精选",
        "zh-TW": "近期對話暫時無法讀取，這是 NURI 的可信來源精選",
        "en": "Your recent conversation could not be read, so these are NURI's trusted-source picks",
    },
}


def phrase(key: str, locale: object = None, /, **values: object) -> str:
    """One composed sentence in the parent's language.

    Falls back to Simplified for an unwritten locale rather than to a key name,
    matching how the frontend table behaves and for the same reason: a gap
    should read as Chinese, not as machinery.
    """

    variants = _PHRASES.get(key)
    if not variants:
        return ""
    template = variants.get(normalize_preferred_locale(locale)) or variants["zh-CN"]
    try:
        return template.format(**values)
    except KeyError:
        # A caller that forgot a variable gets the template, not an exception:
        # a card that reads oddly is better than a feed that fails to build.
        return template

def topic_label(label: object, locale: object = None) -> str:
    """A library topic name in the parent's language.

    Unknown labels pass through unchanged — a dynamic card's topic is the
    parent's own words and must never be rewritten.
    """

    raw = str(label or "").strip()
    if not raw:
        return raw
    return phrase(f"topic.{raw}", locale) or raw
