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

    def is_empty(self) -> bool:
        return not (self.terms or self.topics)

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
    return signals


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


def build_prompt(signals: CareSignals, nickname: str = "") -> str:
    """The instruction that produces a lock-screen-safe caring line.

    The line does two jobs with the same words: it is the notification, and,
    once tapped, it is what NURI says in the conversation. So it is written as
    something NURI would say, not as a headline about NURI.
    """
    subjects = "、".join(signals.keywords()[:6])
    notes = "；".join(signals.private_notes[:3])
    return (
        "你是 NURI，要主动给一位家长发一条推送通知，表达简短的关心。\n"
        f"这位家长上次和你聊到的主题：{subjects}。\n"
        + (f"补充背景（仅供你理解，禁止复述）：{notes}\n" if notes else "")
        + "家长点开通知后，正文会原样出现在你们的对话里，作为你主动说的一句话，"
        "所以正文要像你当面对家长说的话。\n\n"
        "严格要求：\n"
        "1. 输出两行。第一行是标题，第二行是正文。不要写任何其他内容，不要加引号或标签。\n"
        f"2. 标题不超过 {TITLE_MAX_CHARS} 个字，正文不超过 {BODY_MAX_CHARS} 个字。\n"
        "3. 这条通知会显示在锁屏上，旁边可能有别人。因此绝对不能出现：孩子的名字、"
        "年龄、生日、任何具体的家庭情况、诊断或健康细节、家长说过的原话。\n"
        "4. 用温暖、平稳的口吻，像一个记得你在忙什么的顾问，而不是客服或广告。\n"
        "5. 不要连续提问，不要用感叹号堆砌情绪，不要承诺疗效。可以在结尾温和地表示随时可以聊聊。\n"
        "6. 只能含蓄地指向主题（例如\"最近的作息\"），不要复述细节。\n"
    )


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
