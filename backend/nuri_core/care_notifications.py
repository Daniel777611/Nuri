"""Compose the two daily notifications: a line of care, and the featured post.

They used to be one notification — the post's headline as the title and a
line of care as the body — and it read as neither. Each is now its own
notification with its own job, and each opens into the NURI conversation:

* **care** — a short, warm line from what the parent has been talking about.
  Tapped, it appears in the conversation as NURI's own message, word for word,
  so it reads as NURI checking in rather than as a notification being shown.
* **daily post** — the parent's featured post (``backend/feed/daily_post.py``).
  Tapped, NURI brings the post into the conversation as a card the parent can
  open, and the replies that follow are about it.

The shape of the care line is set by §4.1 of the iOS dynamic-notification
handoff, and it is tighter than it first looks: *"完整 AI 回答、聊天正文、图片、
JWT、Supabase key、儿童姓名、生日、诊断信息或家庭隐私不得放进通知"*. A lock
screen is not a private surface — it renders on a locked phone, in front of
whoever is nearby. So the warmth has to be carried without naming the child or
repeating anything the parent told us. The post needs no such care: it is a
stranger's public post, with nothing of this family in it.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

#: How far back a signal counts as "lately". A concern from two months ago is
#: not what the parent is living through today, so the recent window is read
#: first; only a parent with nothing in it is cared for from their last
#: conversation instead (see :func:`latest_signals`).
SIGNAL_WINDOW_DAYS = 21

#: Memory categories worth caring about, in preference order. `concern` and
#: `child_state` describe what the parent is dealing with; `fact` is mostly
#: static profile data (age, city) and makes for a hollow greeting.
CARE_CATEGORIES = ("concern", "child_state", "preference")

TITLE_MAX_CHARS = 35
BODY_MAX_CHARS = 90

#: Patterns that must never reach a lock screen even if the model emits them.
#: A belt-and-braces pass over the generated text, because the prompt asking for
#: no names is a request and this is a guarantee.
_DIGIT_RUN = re.compile(r"\d{3,}")
_DATE_LIKE = re.compile(r"\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}")


@dataclass
class CareSignals:
    """What the account has been dealing with lately, in NURI's own records."""

    terms: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    #: Free-text values, used only for prompting — never for the payload.
    private_notes: list[str] = field(default_factory=list)
    #: The last conversation itself, oldest first: ``{"role", "text"}``. What
    #: the follow-up is written from; keywords alone produced lines like "最近
    #: 的探索欲" when the parent had actually talked about a missing stair gate.
    exchange: list[dict] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not (self.terms or self.topics or self.exchange)

    def keywords(self) -> list[str]:
        """Deduplicated matching vocabulary, most recent first."""
        seen: set[str] = set()
        out: list[str] = []
        for word in (*self.topics, *self.terms):
            key = word.strip()
            if key and key not in seen:
                seen.add(key)
                out.append(key)
        return out


def _cutoff_iso(now: Optional[datetime], days: int) -> str:
    now = now or datetime.now(timezone.utc)
    return (now - timedelta(days=days)).isoformat()


def gather_signals(
    sb: Any, uid: str, *, now: Optional[datetime] = None,
    window_days: Optional[int] = SIGNAL_WINDOW_DAYS,
) -> CareSignals:
    """Read the account's recent history and reduce it to matching vocabulary.

    Reads two tables that already hold distilled subjects, rather than raw
    transcripts: ``user_memories`` (a category/key/value the reply path wrote
    on purpose) and ``chat_turn_logs.route_topic`` (the router's own one-line
    label for a turn, e.g. "日常照顾分工"). Both are short, both are already
    the product's own summary of a conversation, and neither requires reading
    a parent's sentences back out of the database to build a greeting.

    ``window_days=None`` reads the most recent records however old they are.
    """
    signals = CareSignals()
    cutoff = _cutoff_iso(now, window_days) if window_days is not None else None

    try:
        query = (
            sb.table("user_memories")
            .select("category,key,value,updated_at,status")
            .eq("user_id", uid)
            .eq("status", "active")
        )
        if cutoff:
            query = query.gte("updated_at", cutoff)
        memories = query.order("updated_at", desc=True).limit(40).execute().data or []
    except Exception:
        memories = []

    for row in memories:
        if row.get("category") not in CARE_CATEGORIES:
            continue
        key = (row.get("key") or "").strip()
        value = (row.get("value") or "").strip()
        if key:
            # Keys are snake_case subject labels (`sleep_latency_increasing`),
            # so the parts are the searchable terms.
            signals.terms.extend(part for part in key.split("_") if len(part) > 1)
            signals.terms.append(key)
        if value:
            signals.private_notes.append(value)

    try:
        query = sb.table("chat_turn_logs").select("route_topic,created_at").eq("user_id", uid)
        if cutoff:
            query = query.gte("created_at", cutoff)
        turns = query.order("created_at", desc=True).limit(20).execute().data or []
    except Exception:
        turns = []

    for row in turns:
        topic = (row.get("route_topic") or "").strip()
        if not topic:
            continue
        # Router topics arrive as "寒暄/继续追问" — each side is its own subject.
        signals.topics.extend(part for part in re.split(r"[/／、,，]", topic) if part.strip())

    return signals


def latest_signals(sb: Any, uid: str, *, now: Optional[datetime] = None) -> CareSignals:
    """What to care about: the recent window, else the last conversation.

    A parent who has not talked to NURI lately is still asked after what they
    last brought up, rather than sent a greeting that could go to anyone.
    Empty only for an account that has never talked to NURI at all.
    """
    signals = gather_signals(sb, uid, now=now)
    if signals.is_empty():
        signals = gather_signals(sb, uid, now=now, window_days=None)
    signals.exchange = recent_exchange(sb, uid)
    return signals


#: How much of the last conversation the follow-up is written from.
EXCHANGE_MESSAGES = 8
EXCHANGE_CHARS_PER_MESSAGE = 300


def recent_exchange(sb: Any, uid: str) -> list[dict]:
    """The last stretch of the parent's own conversation with NURI, oldest first.

    Ends at NURI's answer to the parent's most recent message. Messages NURI
    posted on its own — a tapped notification, a featured-post card — are left
    out: following up on NURI's own words is not following up on the parent.
    """
    try:
        sessions = [
            r["id"] for r in (
                sb.table("chat_sessions").select("id").eq("user_id", uid)
                .execute().data or []
            )
        ]
        if not sessions:
            return []
        rows = (
            sb.table("chat_messages").select("role,text,transition,created_at")
            .in_("session_id", sessions).order("created_at", desc=True)
            .limit(40).execute().data or []
        )
    except Exception:
        return []

    newest_first = [
        r for r in rows
        if r.get("role") in ("user", "ai") and (r.get("text") or "").strip()
        and not ((r.get("transition") or {}).get("kind") == "card_opened")
    ]
    last_user = next((i for i, r in enumerate(newest_first) if r["role"] == "user"), None)
    if last_user is None:
        return []
    # Keep NURI's reply to that last message (the one just newer than it), but
    # nothing NURI said afterwards unprompted.
    start = last_user - 1 if last_user > 0 and newest_first[last_user - 1]["role"] == "ai" else last_user
    window = newest_first[start:start + EXCHANGE_MESSAGES]
    return [
        {"role": r["role"], "text": r["text"].strip()[:EXCHANGE_CHARS_PER_MESSAGE]}
        for r in reversed(window)
    ]


def _scrub(text: str) -> str:
    """Last-pass redaction for anything that reaches a lock screen."""
    cleaned = _DATE_LIKE.sub("", text or "")
    cleaned = _DIGIT_RUN.sub("", cleaned)
    return " ".join(cleaned.split()).strip()


def _clip(text: str, limit: int) -> str:
    text = _scrub(text)
    return text if len(text) <= limit else text[: limit - 1].rstrip("，。、,. ") + "…"


#: `data.kind` of each notification. The dispatcher does not read it; opening
#: a notification does, to decide what NURI says in the conversation.
KIND_CARE = "care"
KIND_DAILY_POST = "daily_post"
KIND_DAILY_VIDEO = "daily_video"


def build_prompt(signals: CareSignals, nickname: str = "") -> str:
    """The instruction for a follow-up on what the parent last talked about.

    The line does two jobs with the same words: it is the notification, and,
    once tapped, it is what NURI says in the conversation. So it is written as
    something NURI would say, not as a headline about NURI.

    It used to allude only ("最近的作息"), per §4.1 of the handoff. The team
    found that read as a greeting that could go to anyone, and asked for a
    real follow-up on the last conversation instead. What still stays off the
    lock screen: the child's name, age, birthday, diagnoses, and the parent's
    words quoted back. The name is also removed in code (``scrub_names``).
    """
    lines = []
    for m in signals.exchange:
        who = "家长" if m.get("role") == "user" else "NURI"
        lines.append(f"{who}：{m.get('text', '')}")
    convo = "\n".join(lines)
    subjects = "、".join(signals.keywords()[:6])
    notes = "；".join(signals.private_notes[:4])
    return (
        "你是 NURI，一位记得家长家里在发生什么的育儿顾问。现在要主动给这位家长发一条推送，"
        "接着你们上次的聊天追问一句。\n\n"
        + (f"【你们最近一次的对话（旧→新）】\n{convo}\n\n" if convo else "")
        + (f"【你记下的近况】{notes}\n" if notes else "")
        + (f"【最近聊过的主题】{subjects}\n" if subjects else "")
        + "\n家长点开通知后，正文会原样出现在你们的对话里，作为你主动说的一句话，"
        "所以正文要像你当面对家长说的话。\n\n"
        "严格要求：\n"
        "1. 输出两行。第一行是标题，第二行是正文。不要写任何其他内容，不要加引号或标签。\n"
        f"2. 标题不超过 {TITLE_MAX_CHARS} 个字，正文不超过 {BODY_MAX_CHARS} 个字。\n"
        "3. 必须追问上次聊天里最具体、最值得跟进的那件事：你给过的建议做了没有、"
        "情况有没有变化、结果怎么样。要让家长一眼看出你记得上次聊的是什么"
        "（例如上次聊到家里楼梯没装安全门，就问装上了没有、宝宝这几天还爬不爬）。"
        "标题直接点出这件事，不要写成\"最近还好吗\"这类泛泛的问候。\n"
        "4. 正文先用半句话接上上次的事，再问一个具体的问题。只问一个问题。\n"
        "5. 这条通知会显示在锁屏上：不要写孩子的名字（用\"宝宝\"或\"孩子\"代替）、年龄、生日、"
        "诊断或健康细节，也不要大段引用家长说过的原话。\n"
        "6. 口吻温和自然，像记得你家事的朋友，不像客服或广告；不要堆感叹号，不要承诺效果。\n"
        "7. 如果最近的对话只是在聊你推荐的外部帖子，优先追问家长自己家里的事。\n"
    )


def scrub_names(text: str, names: list[str]) -> str:
    """Replace the children's names with 宝宝 — the prompt asks, this ensures."""
    for name in sorted({n.strip() for n in names if n and len(n.strip()) > 1}, key=len, reverse=True):
        text = text.replace(name, "宝宝")
    return text


def parse_completion(text: str) -> tuple[str, str]:
    """Split the model's two lines, tolerating the ways it drifts."""
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    lines = [re.sub(r"^(标题|正文|title|body)\s*[:：]\s*", "", ln, flags=re.I) for ln in lines]
    lines = [ln.strip("「」“”\"'") for ln in lines if ln.strip("「」“”\"'")]
    if not lines:
        return "", ""
    if len(lines) == 1:
        # One long line: use the head as the title and keep the whole as body.
        return _clip(lines[0], TITLE_MAX_CHARS), _clip(lines[0], BODY_MAX_CHARS)
    return _clip(lines[0], TITLE_MAX_CHARS), _clip(" ".join(lines[1:]), BODY_MAX_CHARS)


def fallback_message() -> tuple[str, str]:
    """What to send when the model is unavailable.

    Deliberately generic. Without a model there is no safe way to allude to a
    parent's situation, and a wrong guess is worse than a plain hello.
    """
    return "NURI 想和你说句话", "最近辛苦了，记得也照顾一下自己。想聊聊的时候，我一直在。"


def post_message(post: dict) -> tuple[str, str]:
    """The featured post's notification: its headline, and one of its takeaways.

    No model: the post already says what it is about, and it is a stranger's
    public post, so nothing in it needs keeping off a lock screen.
    """
    title = _clip(str(post.get("headline") or ""), TITLE_MAX_CHARS) or "今天的精选"
    takeaways = [str(t).strip() for t in (post.get("takeaways") or []) if str(t).strip()]
    body = (
        _clip(f"其他家长的做法：{takeaways[0]}。点开和 NURI 一起聊聊。", BODY_MAX_CHARS)
        if takeaways else "今天为你找到一位家长的经验分享，点开和 NURI 一起聊聊。"
    )
    return title, body


def post_intro(post: dict) -> str:
    """What NURI says above the post's card when the parent opens it in chat."""
    return (
        f"今天给你挑了一篇其他家长的经验分享：《{post.get('headline') or ''}》，"
        "点下面的卡片可以看全文。\n"
        "看完想聊聊其中哪一点，或者说说你家的情况，我们一起看看怎么用得上。"
    )


def video_message(video: dict) -> tuple[str, str]:
    """The daily video's notification. The video's own title is public; the
    parent's keyword is not, so it waits for the chat, where the intro names
    it (backend/feed/daily_video.intro)."""
    title = "今天的精选视频"
    shown = str(video.get("display_title") or video.get("title") or "").strip()
    # The key points say what the video teaches — about the subject, never
    # about this family — so they may stand on the lock screen.
    points = str(video.get("key_points") or "").strip()
    if shown and points:
        body = _clip(f"{shown}：{points}", BODY_MAX_CHARS)
    elif shown:
        body = _clip(f"{shown}。点开就能看，看完可以和 NURI 聊聊。", BODY_MAX_CHARS)
    else:
        body = "为你找到一个育儿视频，点开就能看。"
    return title, body


def dedupe_key(uid: str, day: str, kind: str = KIND_CARE) -> str:
    """One notification of each kind per account per day.

    §12 asks for a stable key per business event. The day bucket is what makes
    a retried generation idempotent; hashing keeps an account id out of a
    column that shows up in logs and error messages. The care key keeps the
    shape it had when care was the only kind, so a day already sent under the
    old format is not sent again.
    """
    seed = f"care:{uid}:{day}:" if kind == KIND_CARE else f"{kind}:{uid}:{day}"
    digest = hashlib.sha256(seed.encode()).hexdigest()[:32]
    return f"{kind}:{day}:{digest}"


def route_for(notification_id: str) -> str:
    """§4.1: a controlled in-app route, never an external URL.

    Both native shells accept only this prefix, so where a tap finally lands
    (the conversation) is decided by the page behind it, not by the payload.
    """
    return f"/notifications/{notification_id}"
