"""Compose the proactive "checking in on you" notification and its card.

Two things the product wants from one notification: a short, warm line that
comes from what the parent has actually been dealing with, and a link to one
piece of NURI's own content that fits the same subject.

The shape is set by §4.1 of the iOS dynamic-notification handoff, and it is
tighter than it first looks: *"完整 AI 回答、聊天正文、图片、JWT、Supabase key、
儿童姓名、生日、诊断信息或家庭隐私不得放进通知"*. A lock screen is not a private
surface — it renders on a locked phone, in front of whoever is nearby. So the
warmth in ``title``/``body`` has to be carried without naming the child or
repeating anything the parent told us, and the specific version waits behind
``GET /api/notifications/{id}``, which runs after the app is open and the user
is authenticated. That split is why :func:`compose_care_message` returns both a
payload-safe pair and a ``full_content`` that never leaves an authorised
response.

Card selection is deliberately not an embedding lookup. ``match_terms`` already
exists on every card in ``content_library`` for exactly this purpose, a term hit
is explainable when a parent asks why they were shown something, and the whole
thing stays testable without a network call.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Sequence

from backend.content_library import LEARNING_CONTENT_CARDS

#: How far back a signal still says something about now. A concern from two
#: months ago is not what the parent is living through today, and opening with
#: it reads as not having listened since.
SIGNAL_WINDOW_DAYS = 21

#: Memory categories worth caring about, in preference order. `concern` and
#: `child_state` describe what the parent is dealing with; `fact` is mostly
#: static profile data (age, city) and makes for a hollow greeting.
CARE_CATEGORIES = ("concern", "child_state", "preference")

#: Minimum score before a card may ride along. One incidental term hit is not
#: relevance, and an unrelated card under a caring line reads as advertising.
MIN_CARD_SCORE = 2

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


def _cutoff_iso(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(timezone.utc)
    return (now - timedelta(days=SIGNAL_WINDOW_DAYS)).isoformat()


def gather_signals(sb: Any, uid: str, *, now: Optional[datetime] = None) -> CareSignals:
    """Read the account's recent history and reduce it to matching vocabulary.

    Reads two tables that already hold distilled subjects, rather than raw
    transcripts: ``user_memories`` (a category/key/value the reply path wrote
    on purpose) and ``chat_turn_logs.route_topic`` (the router's own one-line
    label for a turn, e.g. "日常照顾分工"). Both are short, both are already
    the product's own summary of a conversation, and neither requires reading
    a parent's sentences back out of the database to build a greeting.
    """
    signals = CareSignals()
    cutoff = _cutoff_iso(now)

    try:
        memories = (
            sb.table("user_memories")
            .select("category,key,value,updated_at,status")
            .eq("user_id", uid)
            .eq("status", "active")
            .gte("updated_at", cutoff)
            .order("updated_at", desc=True)
            .limit(40)
            .execute()
            .data
            or []
        )
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
        turns = (
            sb.table("chat_turn_logs")
            .select("route_topic,created_at")
            .eq("user_id", uid)
            .gte("created_at", cutoff)
            .order("created_at", desc=True)
            .limit(20)
            .execute()
            .data
            or []
        )
    except Exception:
        turns = []

    for row in turns:
        topic = (row.get("route_topic") or "").strip()
        if not topic:
            continue
        # Router topics arrive as "寒暄/继续追问" — each side is its own subject.
        signals.topics.extend(part for part in re.split(r"[/／、,，]", topic) if part.strip())

    return signals


def score_card(card: dict, signals: CareSignals) -> int:
    """How well one card answers what this account has been dealing with.

    A term counts once no matter how often it recurs, so a parent who said
    "睡" twenty times does not drown out every other subject they raised.
    """
    haystack = " ".join((
        *(card.get("match_terms") or []),
        *(card.get("tags") or []),
        card.get("topic") or "",
        card.get("topic_label") or "",
    )).lower()
    if not haystack:
        return 0

    score = 0
    matched: set[str] = set()
    # Topics are the router's judgement about a whole turn, so they weigh more
    # than a single word lifted out of a memory key.
    for topic in signals.topics:
        for term in (card.get("match_terms") or []):
            t = term.lower()
            if t and (t in topic.lower() or topic.lower() in t) and t not in matched:
                matched.add(t)
                score += 2
    for word in signals.terms:
        w = word.lower()
        if len(w) < 2 or w in matched:
            continue
        if w in haystack:
            matched.add(w)
            score += 1
    return score


def match_card(signals: CareSignals) -> Optional[dict]:
    """Pick the one card worth attaching, or nothing.

    Returning ``None`` is a real outcome: §12 caps how often we may interrupt a
    parent, and spending one of those on an unrelated card is worse than
    sending the caring line alone.
    """
    if signals.is_empty():
        return None
    ranked = sorted(
        ((score_card(card, signals), card) for card in LEARNING_CONTENT_CARDS),
        key=lambda pair: (-pair[0], pair[1]["id"]),
    )
    if not ranked:
        return None
    best_score, best_card = ranked[0]
    return best_card if best_score >= MIN_CARD_SCORE else None


def _scrub(text: str) -> str:
    """Last-pass redaction for anything that reaches a lock screen."""
    cleaned = _DATE_LIKE.sub("", text or "")
    cleaned = _DIGIT_RUN.sub("", cleaned)
    return " ".join(cleaned.split()).strip()


def _clip(text: str, limit: int) -> str:
    text = _scrub(text)
    return text if len(text) <= limit else text[: limit - 1].rstrip("，。、,. ") + "…"


@dataclass
class CareMessage:
    title: str
    body: str
    full_content: str
    card: Optional[dict]
    keywords: list[str]

    def payload_data(self) -> dict[str, Any]:
        """The `data` block. §4.1: small, non-sensitive identifiers only."""
        data: dict[str, Any] = {"kind": "care"}
        if self.card:
            data["card_id"] = self.card["id"]
        return data


def build_prompt(signals: CareSignals, card: Optional[dict], nickname: str = "") -> str:
    """The instruction that produces a lock-screen-safe caring line."""
    subjects = "、".join(signals.keywords()[:6]) or "最近的育儿日常"
    notes = "；".join(signals.private_notes[:3])
    card_line = (
        f"随后会附上一张 NURI 的内容卡片：《{card['title']}》（主题：{card.get('topic_label', '')}）。"
        if card else "这次不附内容卡片。"
    )
    return (
        "你要写一条推送通知，向一位家长表达简短的关心。\n"
        f"这位家长最近关注的主题：{subjects}。\n"
        + (f"补充背景（仅供你理解，禁止复述）：{notes}\n" if notes else "")
        + card_line
        + "\n\n严格要求：\n"
        "1. 输出两行。第一行是标题，第二行是正文。不要写任何其他内容，不要加引号或标签。\n"
        f"2. 标题不超过 {TITLE_MAX_CHARS} 个字，正文不超过 {BODY_MAX_CHARS} 个字。\n"
        "3. 这条通知会显示在锁屏上，旁边可能有别人。因此绝对不能出现：孩子的名字、"
        "年龄、生日、任何具体的家庭情况、诊断或健康细节、家长说过的原话。\n"
        "4. 用温暖、平稳的口吻，像一个记得你在忙什么的顾问，而不是客服或广告。\n"
        "5. 不要提问，不要用感叹号堆砌情绪，不要承诺疗效。\n"
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


def fallback_message(card: Optional[dict]) -> tuple[str, str]:
    """What to send when the model is unavailable.

    Deliberately generic. Without a model there is no safe way to allude to a
    parent's situation, and a wrong guess is worse than a plain hello.
    """
    if card:
        return "NURI 想和你说句话", "最近辛苦了。这里有一篇也许用得上的内容。"
    return "NURI 想和你说句话", "最近辛苦了，记得也照顾一下自己。"


def compose_full_content(body: str, card: Optional[dict]) -> str:
    """The text the app shows after the notification is opened.

    Read through an authorised endpoint, so this may be specific in ways the
    payload may not — but it still holds no child name or health detail,
    because nothing upstream put one here.
    """
    parts = [body]
    if card:
        parts.append("")
        parts.append(f"《{card['title']}》")
        summary = (card.get("summary") or "").strip()
        if summary:
            parts.append(summary)
    return "\n".join(parts).strip()


def dedupe_key(uid: str, day: str, card_id: str = "") -> str:
    """One care notification per account per day, card included in the identity.

    §12 asks for a stable key per business event. The day bucket is what makes
    a retried generation idempotent; hashing keeps an account id out of a
    column that shows up in logs and error messages.
    """
    digest = hashlib.sha256(f"care:{uid}:{day}:{card_id}".encode()).hexdigest()[:32]
    return f"care:{day}:{digest}"


def route_for(notification_id: str) -> str:
    """§4.1: a controlled in-app route, never an external URL."""
    return f"/notifications/{notification_id}"
