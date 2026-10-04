"""NURI之家: once a conversation is over, what NURI asks about it.

The home card used to quote the parent's last message back ("你还记得我们上次
谈到“繁中”吗？"). The last message is often not the subject at all — a language
switch, a thank-you, a test — and a quote is not care. This module reads the
last stretch of the one conversation and, once it is over, writes:

* ``topic``   — a few words naming the last real parenting subject;
* ``summary`` — what was going on and what was left open, kept for NURI;
* ``line``    — what NURI says to pick it back up: one warm, concrete
  question, or a line of care when the parent sounded worn out.

**When is a conversation over?** When the parent has stopped for a while
(``IDLE_CLOSE_S``). A change of subject is the other end of a conversation:
the model is told to skip past subjects the parent dropped for another, and
past chatter that is not a subject, and to take the last real one.

One check-in per last parent message: it is written the first time Home asks
after the conversation went quiet, and reused until the parent says
something new. Tapping the card puts the line in the conversation as NURI's
own message (see ``main.open_main_checkin``), so NURI is the one asking.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from backend import llm_usage, runtime

TABLE = "conversation_checkins"

#: A parent who stopped this long ago is done with the conversation for now.
IDLE_CLOSE_S = int(os.getenv("HOME_CHECKIN_IDLE_S", str(10 * 60)))
#: How much of the conversation the check-in is written from.
WINDOW_MESSAGES = 30
CHARS_PER_MESSAGE = 400
#: Marked in the transcript so the model can see where one sitting ended.
SITTING_GAP_S = 3 * 3600

#: (asked of the model, hard cut) per field. A Chinese character carries about
#: what three English characters do, so English gets its own budget.
LIMITS = {
    "zh": {"topic": (8, 12), "summary": (80, 160), "line": (30, 40)},
    "en": {"topic": (24, 36), "summary": (240, 400), "line": (70, 120)},
}

MODEL = os.getenv("HOME_CHECKIN_MODEL", runtime.OPENAI_CONTENT_RESEARCH_MODEL)
MODEL_TIMEOUT_S = float(os.getenv("HOME_CHECKIN_MODEL_TIMEOUT_S", "20"))

_LOCALE_RULE = {
    "zh-CN": "用简体中文写。",
    "zh-TW": "用繁體中文（台灣用語）寫。",
    "en": "Write in English.",
}


def _parse(ts: Any) -> Optional[datetime]:
    if not ts:
        return None
    try:
        value = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def conversation_messages(rows: list[dict]) -> list[dict]:
    """The parent's own conversation, oldest first.

    Rows NURI posted on its own — a featured-post card, a tapped notification,
    an earlier check-in — have a transition or no parent message before them;
    card markers are dropped here, and the rest are harmless context.
    """
    kept = [
        r for r in rows
        if r.get("role") in ("user", "ai")
        and (r.get("text") or "").strip()
        and not ((r.get("transition") or {}).get("kind") == "card_opened")
    ]
    kept.sort(key=lambda r: (str(r.get("created_at") or ""), str(r.get("id") or "")))
    return kept[-WINDOW_MESSAGES:]


def last_user_message(messages: list[dict]) -> Optional[dict]:
    return next((m for m in reversed(messages) if m.get("role") == "user"), None)


def is_over(messages: list[dict], now: datetime) -> bool:
    """Whether the parent has stopped talking long enough to follow up."""
    last = last_user_message(messages)
    at = _parse((last or {}).get("created_at"))
    return bool(at) and (now - at).total_seconds() >= IDLE_CLOSE_S


def checkin_id(user_id: str, source_message_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"nuri:checkin:{user_id}:{source_message_id}"))


def _ago(delta_s: float, locale: str) -> str:
    hours = delta_s / 3600
    if locale == "en":
        if hours < 1:
            return "less than an hour ago"
        if hours < 24:
            return f"about {int(hours)} hours ago"
        return f"about {int(hours // 24)} days ago"
    if hours < 1:
        return "不到一小时前"
    if hours < 24:
        return f"大约 {int(hours)} 小时前"
    return f"大约 {int(hours // 24)} 天前"


def transcript(messages: list[dict]) -> str:
    lines: list[str] = []
    previous: Optional[datetime] = None
    for m in messages:
        at = _parse(m.get("created_at"))
        if previous and at and (at - previous).total_seconds() >= SITTING_GAP_S:
            lines.append("——（隔了一段时间）——")
        previous = at or previous
        who = "家长" if m.get("role") == "user" else "NURI"
        lines.append(f"{who}：{' '.join(str(m.get('text') or '').split())[:CHARS_PER_MESSAGE]}")
    return "\n".join(lines)


_SYSTEM = """你是 NURI，一位记得家长家里在发生什么的育儿伙伴。家长已经离开了你们的对话。
家长下次打开 App 时，首页会有一张卡片，上面是你主动对 TA 说的一句话；家长点"继续对话"后，
这句话会作为你的消息出现在对话里，家长接着回你。

先找出对话里"最后一个真正的话题"：
- 话题是关于孩子或家庭的一件具体的事（睡眠、发脾气、辅食、入托、夫妻分工、家长自己很累……）。
- 不算话题的：切换语言（例如"繁中"、"English"）、设置、测试、打招呼、道谢、"好的"、问 NURI 是谁。
- 家长中途换了话题，前一个就是聊完了；以最后一个真正的话题为准。最后几句如果都不算话题，就往前找。
- 整段对话里一个真正的话题都没有，has_topic 返回 false，其余字段返回空字符串。

然后写：
- topic：不超过 {topic_max} 个字，点出这件事（例如"午睡哭闹"、"爸爸带娃分工"）。
- summary：不超过 {summary_max} 个字，写家长遇到的情况、你给过什么建议、还有什么没解决。只写对话里有的，不要补充。
- feeling：家长在对话里流露的情绪，用两三个字写（例如"崩溃""生气""自责"）；没有流露就返回空字符串。
- line：不超过 {line_max} 个字，你主动对家长说的一句话。要求：
  1. 一眼就能看出你记得是哪件事：用平常说话的方式点出这件事和孩子的具体表现（例如"宝宝一不如意就躺地上哭"），
     不要把 topic 那种标签词直接塞进句子，不要引用家长的原话，不要写"我们上次谈到……"。
  2. 如果家长说过要试某个做法，或你给过一个具体建议，就点名问那个做法试了没有、效果怎么样
     （例如"提前预告的办法试了吗？"）；否则问这件事最近怎么样了。只问一个问题。
  3. feeling 不为空时，line 必须先用半句接住家长的情绪（例如"那几天你真的很累，""那件事让你挺委屈的，"），再问。
  4. 像记得你家事的朋友，口吻温和自然；不要客服腔，不要感叹号堆叠，不要承诺效果。
  5. 现在距离那次对话已经过去了{elapsed_plain}。家长当时说的"今晚""明天""这周末"都是那时的说法，
     现在要换成"那天晚上""后来""这几天"之类；不到一天才可以说"今天"。
- 语言要求：{locale_rule}"""

_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "home_checkin",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "has_topic": {"type": "boolean"},
                "topic": {"type": "string"},
                "summary": {"type": "string"},
                # Before `line` on purpose: naming the parent's mood first is
                # what gets the line to open with care instead of a quiz.
                "feeling": {"type": "string"},
                "line": {"type": "string"},
            },
            "required": ["has_topic", "topic", "summary", "feeling", "line"],
            "additionalProperties": False,
        },
    },
}


def _clip(text: Any, limit: int) -> str:
    """At most `limit` characters, cut at a word or punctuation boundary so
    English never ends mid-word."""
    text = " ".join(str(text or "").split()).strip("「」“”\"'")
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    boundary = max(cut.rfind(" "), *(cut.rfind(p) for p in "，。；、,.;"))
    return (cut[:boundary] if boundary > limit // 2 else cut).rstrip(" ,，;；、") + "…"


def _model_json(messages: list[dict]) -> dict:
    client = runtime.oai
    if client is None:
        raise RuntimeError("OpenAI is not configured")
    started = datetime.now(timezone.utc)
    try:
        resp = client.with_options(timeout=MODEL_TIMEOUT_S).chat.completions.create(
            model=MODEL, messages=messages, response_format=_FORMAT,
        )
    except Exception as exc:
        llm_usage.record(
            "home_checkin", MODEL, status="error", error=f"{type(exc).__name__}: {exc}",
            duration_ms=int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        )
        raise
    llm_usage.record(
        "home_checkin", MODEL, usage=getattr(resp, "usage", None),
        duration_ms=int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
    )
    return json.loads(resp.choices[0].message.content or "{}")


def write_checkin(messages: list[dict], *, now: datetime, locale: str = "zh-CN") -> Optional[dict]:
    """The model's check-in for a finished conversation, or None when the
    conversation held no real subject to follow up on."""
    last = last_user_message(messages)
    at = _parse((last or {}).get("created_at")) or now
    elapsed = _ago((now - at).total_seconds(), locale)
    elapsed_plain = elapsed.removesuffix("前").removesuffix(" ago")
    limits = LIMITS["en" if locale == "en" else "zh"]
    unit = "characters" if locale == "en" else "个字"
    system = (
        _SYSTEM.replace("{topic_max}", str(limits["topic"][0]))
        .replace("{summary_max}", str(limits["summary"][0]))
        .replace("{line_max}", str(limits["line"][0]))
        .replace("个字", unit if locale == "en" else "个字")
        .replace("{elapsed_plain}", elapsed_plain)
        .replace("{locale_rule}", _LOCALE_RULE.get(locale, _LOCALE_RULE["zh-CN"]))
    )
    data = _model_json([
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": f"【对话（旧→新），家长最后一句是{elapsed}说的】\n{transcript(messages)}",
        },
    ])
    line = _clip(data.get("line"), limits["line"][1])
    if not data.get("has_topic") or not line:
        return None
    return {
        "topic": _clip(data.get("topic"), limits["topic"][1]),
        "summary": _clip(data.get("summary"), limits["summary"][1]),
        "line": line,
    }


def public(row: dict) -> dict:
    return {
        "id": row["id"],
        "topic": row.get("topic") or "",
        "line": row.get("line") or "",
        "opened": bool(row.get("opened_at")),
    }


def table_missing(exc: Exception) -> bool:
    code = str(getattr(exc, "code", "") or "").upper()
    text = str(exc).lower()
    return code in {"42P01", "PGRST205"} or "pgrst205" in text or "42p01" in text or (
        TABLE in text and ("does not exist" in text or "could not find" in text)
    )
