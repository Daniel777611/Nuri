"""Deterministic clock and timeline context for the chat reply prompt.

Timestamps remain UTC in storage.  This module only validates the client's
IANA timezone, freezes one server clock reading for a turn, and renders trusted
annotations for the model.  It does not infer a timezone from locale or city.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DEFAULT_TIMEZONE = "UTC"


@dataclass(frozen=True)
class TemporalContext:
    """The single clock snapshot shared by every prompt stage in one turn."""

    server_utc: datetime
    timezone_name: str
    user_local: datetime


def validate_timezone(value: Optional[str]) -> str:
    """Return a valid IANA timezone name, defaulting only when it is absent."""

    name = str(value or "").strip() or DEFAULT_TIMEZONE
    if len(name) > 128:
        raise ValueError("client_context.timezone must be a valid IANA timezone")
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(
            "client_context.timezone must be a valid IANA timezone"
        ) from exc
    return name


def build_context(
    timezone_name: Optional[str] = None,
    *,
    now_utc: Optional[datetime] = None,
) -> TemporalContext:
    """Freeze the server clock and derive the user's local wall-clock time."""

    name = validate_timezone(timezone_name)
    instant = now_utc or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    instant = instant.astimezone(timezone.utc)
    return TemporalContext(
        server_utc=instant,
        timezone_name=name,
        user_local=instant.astimezone(ZoneInfo(name)),
    )


def parse_created_at(value) -> Optional[datetime]:
    """Parse a stored ISO-8601 timestamp as an aware UTC datetime."""

    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value or "").strip()
        if not raw:
            return None
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _duration_label(delta: timedelta) -> str:
    future = delta.total_seconds() < 0
    seconds = abs(int(delta.total_seconds()))
    if seconds < 60:
        body = "不到1分钟"
    else:
        minutes = seconds // 60
        days, minutes = divmod(minutes, 24 * 60)
        hours, minutes = divmod(minutes, 60)
        parts = []
        if days:
            parts.append(f"{days}天")
        if hours:
            parts.append(f"{hours}小时")
        if minutes and len(parts) < 2:
            parts.append(f"{minutes}分钟")
        body = "".join(parts) or "不到1分钟"
    return f"比本轮晚{body}" if future else f"距本轮{body}"


def message_time_annotation(
    created_at,
    context: TemporalContext,
    *,
    current: bool = False,
) -> str:
    """Render a trusted absolute local timestamp and server-computed age."""

    parsed = parse_created_at(created_at)
    if parsed is None:
        return "本轮消息时间：服务器当前时间" if current else "历史消息时间：未知"
    local = parsed.astimezone(ZoneInfo(context.timezone_name))
    kind = "本轮消息时间" if current else "历史消息时间"
    local_today = local.date()
    local_yesterday = local_today - timedelta(days=1)
    return (
        f"{kind}：{local.strftime('%Y-%m-%d %H:%M:%S')} "
        f"{context.timezone_name}；该消息中的今天={local_today.isoformat()}，"
        f"昨天={local_yesterday.isoformat()}；"
        f"{_duration_label(context.server_utc - parsed)}"
    )


def annotate_message(
    text: str,
    created_at,
    context: TemporalContext,
    *,
    current: bool = False,
) -> str:
    """Prefix one conversation message with its non-user-editable time label."""

    if not (text or "").strip():
        return text or ""
    # Secondary models may share a prepared history. Keeping this helper
    # idempotent prevents an accidental second preparation pass from turning
    # one trusted label into two contradictory-looking labels.
    if text.lstrip().startswith(("[历史消息时间：", "[本轮消息时间：")):
        return text
    annotation = message_time_annotation(created_at, context, current=current)
    return f"[{annotation}]\n{text}"


def annotate_history(
    history: Iterable[dict],
    context: TemporalContext,
) -> list[dict]:
    """Copy a transcript with trusted clock labels for secondary models.

    The reply assembler annotates only the final recent-message window.  The
    router, rolling-summary model and memory extractor also read transcripts,
    though, and they must not silently recover the old timestamp-free view.
    Returning copies keeps database text and UI text untouched.
    """

    messages = list(history or [])
    last_user_index = next(
        (i for i in range(len(messages) - 1, -1, -1)
         if messages[i].get("role") == "user"
         and (messages[i].get("text") or "").strip()),
        -1,
    )
    out: list[dict] = []
    for index, message in enumerate(messages):
        copied = dict(message)
        text = message.get("text") or ""
        copied["text"] = annotate_message(
            text,
            message.get("created_at"),
            context,
            current=(index == last_user_index),
        )
        out.append(copied)
    return out


def prompt_block(context: TemporalContext) -> str:
    """Rules that make relative-time language deterministic for the model."""

    utc_text = context.server_utc.isoformat(timespec="seconds").replace("+00:00", "Z")
    local_text = context.user_local.strftime("%Y-%m-%d %H:%M:%S")
    yesterday = (context.user_local.date() - timedelta(days=1)).isoformat()
    return (
        "【本轮时间语义（服务器生成，必须遵守）】\n"
        f"- 服务器 UTC：{utc_text}\n"
        f"- 用户本地时间：{local_text} {context.timezone_name}\n"
        f"- 用户本地今天：{context.user_local.date().isoformat()}；昨天：{yesterday}\n"
        "- 当前用户消息中的“今天、昨天、刚才”等相对时间，以本轮用户本地时间为锚点。\n"
        "- 历史消息中的相对时间，以该条消息前标注的发送时间为锚点，不得改用本轮时间。\n"
        "- 每条消息标注已经给出该消息自己的“今天”和“昨天”绝对日期，直接使用，不自行做日期换算。\n"
        "- “昨天”表示用户本地日历的前一日，不等同于不足24小时。\n"
        "- 摘要或记忆里若仍有未附绝对日期的“昨天、刚才、前几天”，不得把它当成本轮时间；应结合有时间标注的原消息，无法确定就明确说明并询问。\n"
        "- 不要因为两条消息在提示词中相邻，就推断它们在现实中连续发生；时长以标注为准。"
    )
