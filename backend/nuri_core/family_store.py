"""1 家庭模型 — persistence.

The tables this subsystem owns, and the rendering that turns them into the
blocks a prompt can use: `users` and `children` (identity and stage),
`user_memories` (what has been confirmed about this family), `follow_ups`
(what is worth coming back to) and `normalized_inputs` (the canonical log of
what the parent actually said).

Split from `family.py`, which assembles and caches the state: this module talks
to the database and knows nothing about a turn, that one knows about turns and
never touches the database. The split is what lets the state cache live in one
place with nothing underneath it to invalidate.

Every read degrades to an empty block and every write to a warning. A family
model that can fail a turn is worse than one that occasionally forgets
something.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import uuid
from datetime import date, datetime, time as dt_time, timedelta, timezone
from typing import Optional

import anyio

from backend.nuri_core import context_budget, temporal
from backend import llm_usage, runtime
from backend.runtime import (
    OPENAI_FAST_TIMEOUT_S,
    now,
    oai,
)

MEMORY_CATEGORY_LABELS = {
    "preference": "家庭偏好",
    "constraint": "约束条件",
    "concern": "家长关注点",
    "child_state": "孩子当前状态",
    "fact": "其他信息",
}

PARENT_ROLE_LABELS = {
    "mom": "妈妈", "dad": "爸爸", "grandparent": "祖父母/外祖父母", "other": "其他家庭照顾者",
}
CONCERN_LABELS = {
    "sleep": "睡眠", "food": "饮食", "emotion": "情绪", "development": "发展",
    "parenting": "教养方式", "health": "健康", "childcare": "托育",
    "family": "家庭关系", "unknown": "还不确定", "other": "其他",
}
# Onboarding asks the parent how they want to be answered, so these map to
# instructions rather than to descriptions.
HELP_PREF_LABELS = {
    "research": "希望看到专业研究和知识依据，可以适度引用理论",
    "experience": "希望听到真实家长的经验分享，多用具体情境而不是理论",
    "analysis": "希望一步一步分析原因，先讲清楚为什么再给做法",
    "actionable": "希望直接拿到可执行的方法，少铺垫",
}
INFO_SOURCE_LABELS = {
    "research": "专业研究／论文", "expert": "医师或专家",
    "parents": "其他家长经验", "all": "都会参考",
}
GENDER_LABELS = {"boy": "男孩", "girl": "女孩"}


_ENGLISH_MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


def redact_child_profile_text(value: object, children: Optional[list] = None) -> str:
    """Remove saved child identifiers from text crossing a retrieval boundary.

    The dialogue model is allowed to use the account's confirmed child profile,
    but the router and search providers only need developmental stage.  Redact
    against the actual saved values instead of trying to guess whether arbitrary
    words are names.  A known birthday is replaced by the derived age so a
    useful search query keeps its most important relevance signal.
    """

    text = str(value or "")
    child_rows = list(children or [])

    # Dates must be handled before nicknames. A valid nickname can also be an
    # English month name (for example, "May"); replacing the name first would
    # otherwise break the birthday pattern and leave its day/year exposed.
    for child in child_rows:
        raw_birth_date = str(child.get("birth_date") or "")[:10]
        try:
            born = date.fromisoformat(raw_birth_date)
        except (TypeError, ValueError):
            continue
        replacement = age_label(raw_birth_date) or "孩子当前年龄"
        year, month, day = born.year, born.month, born.day
        month_name = _ENGLISH_MONTHS[month - 1]
        month_short = month_name[:3]
        date_patterns = (
            # ISO, slash, dotted and Chinese year-month-day forms, allowing
            # optional zero padding and spaces around separators.
            rf"(?<!\d){year}\s*[-/.年]\s*0?{month}\s*[-/.月]\s*0?{day}\s*日?(?!\d)",
            rf"(?<!\d)0?{month}\s*[-/.]\s*0?{day}\s*[-/.]\s*{year}(?!\d)",
            # Parents and the model often say only the birthday's month/day.
            rf"(?<!\d)0?{month}\s*月\s*0?{day}\s*日(?!\d)",
            # ``\w`` also treats adjacent Chinese characters as word
            # characters, so use ASCII-letter guards here. A model commonly
            # emits forms such as ``生日是October 10, 2025`` without a space.
            rf"(?<![A-Za-z])(?:{month_name}|{month_short})\s+0?{day}(?:st|nd|rd|th)?\s*,?\s*{year}(?![A-Za-z])",
        )
        for pattern in date_patterns:
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    # Longest first prevents a shorter nickname from partially consuming a
    # longer one in a multi-child household.
    nicknames = sorted(
        {
            str(child.get("nickname") or "").strip()
            for child in child_rows
            if str(child.get("nickname") or "").strip()
        },
        key=len,
        reverse=True,
    )
    for nickname in nicknames:
        escaped = re.escape(nickname)
        # Any Latin nickname needs ASCII word guards: a child named "May"
        # must not turn "maybe" into "孩子be". Chinese names are exact account
        # values and can be replaced wherever they appear.
        pattern = (
            rf"(?<![A-Za-z0-9]){escaped}(?![A-Za-z0-9])"
            if nickname.isascii()
            else escaped
        )
        text = re.sub(pattern, "孩子", text, flags=re.IGNORECASE)
    return text


def redact_child_profile_history(
    history: list[dict], children: Optional[list] = None,
) -> list[dict]:
    """Return a copy of chat history safe for routing and retrieval models."""

    sanitized: list[dict] = []
    for message in history or []:
        item = dict(message)
        if "text" in item:
            item["text"] = redact_child_profile_text(item.get("text"), children)
        sanitized.append(item)
    return sanitized


def age_in_months(birth_date: str) -> Optional[int]:
    """Completed months since a birth date, or None if it can't be read.

    Split out from age_label because the four-model pipeline needs the number,
    not the label: directive conditions are written as month ranges, and
    parsing "2岁3个月" back into one would be absurd.
    """
    try:
        born = date.fromisoformat(str(birth_date)[:10])
    except (ValueError, TypeError):
        return None
    today = date.today()
    months = (today.year - born.year) * 12 + (today.month - born.month)
    # Treat the last day of a shorter month as the completed monthly
    # anniversary for birthdays on the 29th-31st. This keeps Jan 31 -> Feb 28
    # and leap-day birthdays aligned with ordinary calendar-age expectations.
    next_month = today.replace(day=28) + timedelta(days=4)
    current_month_last_day = (next_month - timedelta(days=next_month.day)).day
    anniversary_day = min(born.day, current_month_last_day)
    if today.day < anniversary_day:
        months -= 1
    return months if months >= 0 else None


def age_label(birth_date: str) -> str:
    """Render a birth date as an age NURI can reason about. Advice for a
    6-month-old and a 6-year-old share almost nothing, so this is the single
    most load-bearing fact in the profile."""
    months = age_in_months(birth_date)
    if months is None:
        return ""
    if months < 24:
        return f"{months}个月" if months else "未满1个月"
    years, rest = divmod(months, 12)
    return f"{years}岁{rest}个月" if rest else f"{years}岁"


def safe_child_recommendation_context(children: list[dict]) -> dict[str, str]:
    """Return age-only family context plus an opaque profile version.

    Exact birthdays and child names stay inside NURI.  External content
    research only needs the completed age label, while the fingerprint makes a
    saved recommendation stale as soon as the underlying child profile (or a
    monthly age boundary) changes.
    """

    ages: list[str] = []
    fingerprint_rows: list[str] = []
    for child in children:
        birth_date = str(child.get("birth_date") or "")[:10]
        age = age_label(birth_date)
        if age:
            ages.append(age)
        if birth_date:
            fingerprint_rows.append(
                "|".join(
                    (
                        birth_date,
                        str(child.get("gender") or ""),
                        age,
                    )
                )
            )
    fingerprint_material = "\n".join(sorted(fingerprint_rows)) or "no-children"
    return {
        "child_age_context": (
            f"孩子当前年龄：{'、'.join(ages[:3])}" if ages else ""
        ),
        "child_profile_fingerprint": hashlib.sha256(
            fingerprint_material.encode("utf-8")
        ).hexdigest()[:24],
    }


def safe_normalized_input_context(profile: dict, children: list[dict]) -> dict:
    """Minimal structured context retained with canonical input logs.

    Normalized input rows are for auditing the user turn, not a second copy of
    the family profile.  Keep only opaque/derived child stage and fixed
    questionnaire codes; names, birthdays, city and free-form notes remain in
    their authoritative account tables.
    """

    context: dict = safe_child_recommendation_context(children)
    for key in ("help_preference", "info_source"):
        value = str(profile.get(key) or "").strip()
        if value:
            context[key] = value
    return context


async def attach_child_recommendation_context(uid: str, context: dict) -> dict:
    """Attach safe child-stage and questionnaire recommendation context.

    Exact birthdays, names and free-form profile fields never enter this
    structure.  The two questionnaire values are fixed enum-like codes used
    only to calculate an explainable content-category prior.
    """

    profile, children = await load_profile(uid)
    # Feed ranking and web research work on this copy, never on the durable
    # chat transcript.  Remove exact child identifiers before any topic/title/
    # recommendation-focus text can be derived from the conversation.
    if context.get("messages"):
        context["messages"] = redact_child_profile_history(
            list(context.get("messages") or []), children,
        )
    context.update(safe_child_recommendation_context(children))
    context["help_preference"] = str(profile.get("help_preference") or "")
    context["info_source"] = str(profile.get("info_source") or "")
    return context


def profile_ctx(row: dict, children: Optional[list] = None) -> str:
    """Turn the onboarding answers into a prompt block, so NURI knows who it's
    talking to from the first reply instead of only picking this up once enough
    chat history has accumulated.

    Everything the questionnaire collects belongs here — anything omitted is a
    question the parent answered for nothing.
    """
    parts = []
    nickname = (row.get("nickname") or "").strip()
    if nickname:
        parts.append(f"称呼：{nickname}")
    role = PARENT_ROLE_LABELS.get(row.get("parent_role"))
    if role:
        parts.append(f"身份：{role}")
    city = (row.get("city") or "").strip()
    if city:
        parts.append(f"所在城市：{city}")

    concerns = [CONCERN_LABELS.get(c, c) for c in (row.get("top_concerns") or [])]
    other = (row.get("concern_other") or "").strip()
    if other:
        concerns = [c for c in concerns if c != "其他"] + [other]
    if concerns:
        parts.append(f"主要关心：{'、'.join(concerns)}")

    hobbies = (row.get("hobbies") or "").strip()
    if hobbies:
        parts.append(f"没带孩子时喜欢：{hobbies}")
    info_source = INFO_SOURCE_LABELS.get(row.get("info_source"))
    if info_source:
        parts.append(f"比较信任的信息来源：{info_source}")

    child_parts: list[str] = []
    has_confirmed_child_fact = False
    for child in children or []:
        desc = []
        name = (child.get("nickname") or "").strip()
        # A child's birthday is an account-level fact the parent explicitly
        # saved.  The chat model needs the exact date to answer direct profile
        # questions and to reason about time without asking for the same fact
        # again.  Only render dates that also pass the age validator: malformed
        # or future legacy rows must not become authoritative prompt facts.
        birth_date = str(child.get("birth_date") or "")[:10]
        age = age_label(birth_date)
        if age:
            has_confirmed_child_fact = True
            desc.append(f"已确认出生日期：{birth_date}")
            desc.append(f"当前年龄：{age}")
        gender = GENDER_LABELS.get(child.get("gender"))
        if gender:
            desc.append(gender)
        allergies = [a for a in (child.get("allergies") or []) if a]
        if allergies:
            desc.append(f"过敏：{'、'.join(allergies)}")
        notes = (child.get("notes") or "").strip()
        if notes:
            desc.append(notes)
        if desc:
            child_parts.append(
                f"孩子{('（' + name + '）') if name else ''}：{'，'.join(desc)}"
            )

    if has_confirmed_child_fact:
        parts.append(
            "资料使用规则：以下结构化孩子资料是账号中当前已确认的信息；"
            "若与旧对话摘要或长期记忆冲突，以这里为准。已有的姓名、出生日期、"
            "年龄等信息请直接使用，不要说未确认，也不要再次询问"
        )
    parts.extend(child_parts)

    block = "；".join(parts)
    help_pref = HELP_PREF_LABELS.get(row.get("help_preference"))
    if help_pref:
        block += f"\n这位家长{help_pref}。在不违反上述规则的前提下，按这个偏好来组织回答。"
    return block

PROFILE_FIELDS = (
    "nickname,city,parent_role,top_concerns,concern_other,hobbies,"
    "help_preference,info_source"
)


class ProfileStorageUnavailable(RuntimeError):
    """The account profile could not be read from its durable source."""


async def load_profile(user_id: Optional[str]) -> tuple[dict, list]:
    """Fetch the profile answers and children behind the prompt block.

    One loader for every caller: the chat path used to select a narrower column
    set than profile_ctx reads, so answers the parent had given were silently
    dropped in chat while showing up in the intro message.
    """
    if not user_id:
        return {}, []
    sb = runtime.get_supabase()
    if not sb:
        # Unit/preview builds intentionally run without a durable profile
        # store.  Production chat already requires Supabase before reaching
        # this loader; only an actual configured-store query failure must stop
        # the turn rather than masquerade as an empty profile.
        return {}, []

    async def _user():
        try:
            r = await anyio.to_thread.run_sync(
                lambda: sb.table("users").select(PROFILE_FIELDS)
                .eq("id", user_id).maybe_single().execute()
            )
            return (r.data if r else None) or {}
        except Exception as exc:
            print(f"[warn] load_profile user: {type(exc).__name__}")
            raise ProfileStorageUnavailable("User profile query failed") from exc

    async def _children():
        try:
            r = await anyio.to_thread.run_sync(
                lambda: sb.table("children").select("nickname,birth_date,gender,allergies,notes")
                .eq("user_id", user_id).execute()
            )
            return r.data or []
        except Exception as exc:
            print(f"[warn] load_profile children: {type(exc).__name__}")
            raise ProfileStorageUnavailable("Child profile query failed") from exc

    profile, children = await asyncio.gather(_user(), _children())
    return profile, children


async def save_normalized_input(
    *, user_id: Optional[str], session_id: Optional[str], source: str,
    raw_text: str = "", raw_image_base64: Optional[str] = None,
    card_ref: Optional[dict] = None, context_hints: Optional[dict] = None,
    child_id: Optional[str] = None,
) -> None:
    """Log every user turn through one canonical shape before it reaches the router/LLM."""
    sb = runtime.get_supabase()
    if not sb:
        return
    row = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "child_id": child_id,
        "session_id": session_id,
        "source": source,
        "raw_text": raw_text,
        "normalized_text": raw_text.strip(),
        "normalization_version": "v1",
        "raw_image_base64": raw_image_base64,
        "card_ref": card_ref,
        "context_hints": context_hints or {},
        "created_at": now(),
    }
    try:
        await anyio.to_thread.run_sync(lambda: sb.table("normalized_inputs").insert(row).execute())
    except Exception as e:
        print(f"[warn] save_normalized_input: {e}")

def extract_memories_sync(
    history: list[dict],
    temporal_context: Optional[temporal.TemporalContext] = None,
) -> dict:
    """Ask a small model whether this conversation contains stable, reusable facts."""
    if not oai:
        return {"memories": [], "follow_ups": []}
    recent = history[-8:]
    if temporal_context is not None:
        recent = temporal.annotate_history(recent, temporal_context)
    convo = "\n".join(
        f"{'用户' if m['role'] == 'user' else 'NURI'}: {m.get('text', '')}"
        for m in recent if m.get("text")
    )
    if not convo.strip():
        return {"memories": [], "follow_ups": []}
    system = (
        "从下面这段育儿助手对话里提取两种东西。两者都没有就都返回空数组，不要勉强凑数。\n\n"
        "memories：值得长期记住的、稳定的事实——长期偏好、过敏史、育儿理念上的坚持、"
        "孩子的持续性状态。不要提取一次性的、当下情绪化的、或还不确定的内容。"
        "如果 value 中必须保留时间，把相对时间改成绝对日期或明确持续时长；无法确定就写具体日期未确认。\n\n"
        "follow_ups：过一段时间值得回头关心一次的事。包括家长提到的有日期的安排"
        "（几号开始托婴、哪天回诊、下周满两岁），也包括正在进行、需要一段时间才看得出结果的事"
        "（在戒尿布、刚换睡眠作息、在试新食材），以及 NURI 自己刚承诺过要之后再看的事。\n"
        "- topic：4-8 字的短标题，同一件事每次都要用同样的写法，这是去重的依据"
        "（例如固定写「托婴适应」，不要一次写「托婴」一次写「上托婴中心的适应」）\n"
        "- note：一句话说清楚要问什么，要带上具体背景，让之后问起来不像罐头问候\n"
        "- due_date：家长明确讲了日期就填 YYYY-MM-DD，没讲就填空字符串。"
        "一段话里出现好几个日期时，填最值得回头关心的那个未来日期"
        "（例如同时提到「7/30 签约」和「9/1 开始托婴」，要问的是入托适应，就填 9/1）\n"
        "- 纯粹的情绪倾诉、已经解决完的事、不需要再追问的闲聊，不要放进来"
    )
    if temporal_context is not None:
        system += (
            "\n\n" + temporal.prompt_block(temporal_context) +
            "\n- 提取 memories.value、follow_up.note 和 due_date 时，将相对日期规范化为用户当地的绝对日期。"
            "无法从时间标注确定的日期不要猜，due_date 留空。"
        )
    try:
        resp = oai.chat.completions.create(
            model="gpt-5.4-mini",
            messages=[{"role": "system", "content": system}, {"role": "user", "content": convo}],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "memory_extraction",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "memories": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "category": {
                                            "type": "string",
                                            "enum": ["preference", "concern", "child_state", "fact", "constraint"],
                                        },
                                        "key": {"type": "string"},
                                        "value": {"type": "string"},
                                        "confidence": {"type": "number"},
                                    },
                                    "required": ["category", "key", "value", "confidence"],
                                    "additionalProperties": False,
                                },
                            },
                            "follow_ups": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        # Short handle, reused as the dedupe key.
                                        "topic": {"type": "string"},
                                        "note": {"type": "string"},
                                        # "" when the parent named no date; the
                                        # topic then decides the interval.
                                        "due_date": {"type": "string"},
                                    },
                                    "required": ["topic", "note", "due_date"],
                                    "additionalProperties": False,
                                },
                            },
                        },
                        "required": ["memories", "follow_ups"],
                        "additionalProperties": False,
                    },
                },
            },
        )
        llm_usage.record(
            "chat.memory_extract", "gpt-5.4-mini", usage=getattr(resp, "usage", None),
        )
        data = json.loads(resp.choices[0].message.content)
        return {
            "memories": data.get("memories", [])[:5],
            "follow_ups": data.get("follow_ups", [])[:3],
        }
    except Exception as e:
        print(f"[error] extract_memories_sync failed: {type(e).__name__}: {e}")
        return {"memories": [], "follow_ups": []}

async def upsert_memories(
    memories: list[dict], *, user_id: str, child_id: Optional[str],
    source_type: str, source_id: Optional[str],
) -> None:
    """Write by (user_id, child_id, category, key); only replace value/confidence
    when the new read is at least as confident, so a low-confidence guess can't
    clobber an already-confirmed fact."""
    sb = runtime.get_supabase()
    if not sb or not memories:
        return
    now_iso = now()
    for m in memories:
        key = (m.get("key") or "").strip()
        value = (m.get("value") or "").strip()
        category = m.get("category") or "fact"
        confidence = float(m.get("confidence") or 0.7)
        if not key or not value:
            continue
        try:
            q = sb.table("user_memories").select("id,confidence").eq("user_id", user_id).eq("category", category).eq("key", key)
            q = q.is_("child_id", "null") if child_id is None else q.eq("child_id", child_id)
            existing = await anyio.to_thread.run_sync(lambda: q.execute())
            if existing.data:
                row_id = existing.data[0]["id"]
                old_confidence = existing.data[0].get("confidence") or 0
                updates = {
                    "source_id": source_id,
                    "last_confirmed_at": now_iso,
                    "updated_at": now_iso,
                }
                if confidence >= old_confidence:
                    updates["value"] = value
                    updates["confidence"] = confidence
                await anyio.to_thread.run_sync(lambda: sb.table("user_memories").update(updates).eq("id", row_id).execute())
            else:
                row = {
                    "id": str(uuid.uuid4()), "user_id": user_id, "child_id": child_id,
                    "category": category, "key": key, "value": value, "confidence": confidence,
                    "source_type": source_type, "source_id": source_id, "status": "active",
                    "created_at": now_iso, "updated_at": now_iso,
                    "last_confirmed_at": now_iso,
                }
                await anyio.to_thread.run_sync(lambda: sb.table("user_memories").insert(row).execute())
        except Exception as e:
            print(f"[warn] upsert_memories key={key}: {e}")

#: A parent message shorter than this rarely carries a durable fact. "嗯"、
#: "好的"、"谢谢" are the common case, and running an extraction over them is a
#: model call spent to be told there is nothing to remember.
MEMORY_MIN_USER_CHARS = int(os.getenv("MEMORY_MIN_USER_CHARS", "12"))


def worth_extracting(history: list[dict]) -> bool:
    """Whether this turn plausibly contains something to remember.

    Extraction used to run on every single turn. It is a background task so it
    never cost latency, but it did cost a model call each time — including for
    acknowledgements and thanks, which by definition state nothing new.
    """
    latest = next(
        (m for m in reversed(history) if m.get("role") == "user" and (m.get("text") or "").strip()),
        None,
    )
    if not latest:
        return False
    text = (latest.get("text") or "").strip()
    if text == "[图片]":
        return False
    return len(text) >= MEMORY_MIN_USER_CHARS


# Default gap before checking back, when the parent didn't give a date. Without
# these most follow-ups would never come due: "最近在戒尿布" is worth revisiting
# but carries no deadline of its own. Keyed by the topic words the extractor is
# told to use; anything unmatched falls back to the default.
FOLLOW_UP_INTERVALS = {
    "睡眠": 4, "喂养": 5, "餵養": 5, "副食品": 5, "辅食": 5,
    "就医": 3, "就醫": 3, "生病": 3, "发烧": 2, "發燒": 2, "疫苗": 3,
    "情绪": 7, "情緒": 7, "行为": 7, "行為": 7,
    "发展": 21, "發展": 21, "里程碑": 21,
    "托婴": 14, "托嬰": 14, "入园": 14, "幼儿园": 14, "幼兒園": 14,
    "戒奶": 14, "戒尿布": 14, "断奶": 14, "斷奶": 14,
}
FOLLOW_UP_DEFAULT_DAYS = int(os.getenv("FOLLOW_UP_DEFAULT_DAYS", "7"))
#: Anything not asked within this window of falling due is stale — a parenting
#: situation a month old has usually resolved itself, and asking about it reads
#: as not having been paying attention.
FOLLOW_UP_EXPIRE_DAYS = int(os.getenv("FOLLOW_UP_EXPIRE_DAYS", "30"))


def follow_up_due_at(
    item: dict,
    temporal_context: Optional[temporal.TemporalContext] = None,
) -> tuple[str, str]:
    """Resolve when to come back to something, and record where the date came
    from. A parent-stated date is used as given; otherwise the topic decides."""
    stated = (item.get("due_date") or "").strip()
    local_today = (
        temporal_context.user_local.date()
        if temporal_context is not None else date.today()
    )
    if stated:
        try:
            d = date.fromisoformat(stated[:10])
            # A date already in the past was probably mentioned as history
            # rather than as a plan; check in tomorrow instead of never.
            if d < local_today:
                d = local_today + timedelta(days=1)
            target_zone = (
                temporal_context.user_local.tzinfo
                if temporal_context is not None else timezone.utc
            )
            local_due = datetime.combine(d, dt_time(9, 0), tzinfo=target_zone)
            return local_due.astimezone(timezone.utc).isoformat(), "stated"
        except (ValueError, TypeError):
            pass
    topic = (item.get("topic") or "") + (item.get("note") or "")
    days = next((v for k, v in FOLLOW_UP_INTERVALS.items() if k in topic), FOLLOW_UP_DEFAULT_DAYS)
    if temporal_context is not None:
        # Follow-ups are a user-facing local-day concept, not a fixed number of
        # elapsed UTC hours. Scheduling at 09:00 on the target local date keeps
        # them natural across DST transitions (where +N*24h would drift by an
        # hour) and consistent with explicitly stated dates above.
        target_date = local_today + timedelta(days=days)
        local_due = datetime.combine(
            target_date, dt_time(9, 0), tzinfo=temporal_context.user_local.tzinfo,
        )
        return local_due.astimezone(timezone.utc).isoformat(), "inferred"
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(), "inferred"


async def upsert_follow_ups(
    items: list[dict], *, user_id: str, source_id: Optional[str],
    temporal_context: Optional[temporal.TemporalContext] = None,
) -> None:
    """One open follow-up per topic. A parent who mentions 托嬰 across four turns
    should be asked once, not four times — the partial unique index enforces it,
    and this refreshes the existing row rather than failing on the conflict."""
    sb = runtime.get_supabase()
    if not sb or not items:
        return
    now_iso = now()
    for item in items[:3]:
        topic = (item.get("topic") or "").strip()
        if not topic:
            continue
        due_at, due_source = follow_up_due_at(item, temporal_context)
        try:
            existing = await anyio.to_thread.run_sync(
                lambda: sb.table("follow_ups").select("id,due_source")
                .eq("user_id", user_id).eq("topic", topic).eq("status", "pending").execute()
            )
            if existing.data:
                row_id = existing.data[0]["id"]
                # Never let an inferred date overwrite one the parent gave.
                patch = {
                    "note": (item.get("note") or "").strip(),
                    "updated_at": now_iso,
                }
                if not (existing.data[0].get("due_source") == "stated" and due_source == "inferred"):
                    patch.update({"due_at": due_at, "due_source": due_source})
                await anyio.to_thread.run_sync(
                    lambda: sb.table("follow_ups").update(patch).eq("id", row_id).execute()
                )
            else:
                row = {
                    "id": str(uuid.uuid4()), "user_id": user_id, "child_id": None,
                    "topic": topic, "note": (item.get("note") or "").strip(),
                    "due_at": due_at, "due_source": due_source,
                    "source_message_id": source_id, "status": "pending",
                    "created_at": now_iso, "updated_at": now_iso,
                }
                await anyio.to_thread.run_sync(
                    lambda: sb.table("follow_ups").insert(row).execute()
                )
        except Exception as e:
            print(f"[warn] upsert_follow_ups topic={topic}: {e}")


async def get_follow_up_context(user_id: Optional[str], limit: int = 3) -> str:
    """Open follow-ups that have come due, for the reply prompt.

    This is the quieter of the two channels. The scheduled check-in is what
    makes a parent feel remembered; this one just stops NURI from asking about
    副食品 while the parent is already talking about it, and lets it close the
    loop naturally when they happen to be here anyway.
    """
    if not user_id:
        return ""
    sb = runtime.get_supabase()
    if not sb:
        return ""
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("follow_ups").select("topic,note,due_at")
            .eq("user_id", user_id).eq("status", "pending")
            .lte("due_at", now()).order("due_at").limit(limit).execute()
        )
        rows = res.data or []
    except Exception as e:
        print(f"[warn] get_follow_up_context: {e}")
        return ""
    if not rows:
        return ""
    lines = "\n".join(f"- {r['topic']}：{r.get('note') or ''}" for r in rows)
    return (
        "之前聊过、现在到了可以回头关心一下的事：\n" + lines +
        "\n如果和家长这一轮说的自然接得上，就顺势关心一句；接不上就不要硬提，"
        "更不要一次问完好几件。"
    )


async def take_due_follow_up(user_id: str) -> Optional[dict]:
    """The single oldest due item for this family, expiring anything stale.

    One at a time, deliberately. A family can easily have five things due at
    once — sleep, solids, daycare, a check-up — and a digest of all five is a
    to-do list rather than someone remembering to ask after you.
    """
    sb = runtime.get_supabase()
    if not sb:
        return None
    cutoff = (datetime.now(timezone.utc) - timedelta(days=FOLLOW_UP_EXPIRE_DAYS)).isoformat()
    try:
        # Aged-out items are retired first, so a long-abandoned topic can't sit
        # at the head of the queue blocking everything behind it.
        await anyio.to_thread.run_sync(
            lambda: sb.table("follow_ups").update({"status": "expired", "updated_at": now()})
            .eq("user_id", user_id).eq("status", "pending").lt("due_at", cutoff).execute()
        )
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("follow_ups").select("id,topic,note,due_at")
            .eq("user_id", user_id).eq("status", "pending")
            .lte("due_at", now()).order("due_at").limit(1).execute()
        )
        rows = res.data or []
        return rows[0] if rows else None
    except Exception as e:
        print(f"[warn] take_due_follow_up {user_id}: {e}")
        return None


async def mark_follow_up_asked(follow_up_id: str) -> None:
    sb = runtime.get_supabase()
    if not sb:
        return
    try:
        now_iso = now()
        await anyio.to_thread.run_sync(
            lambda: sb.table("follow_ups")
            .update({
                "status": "asked", "asked_at": now_iso,
                "updated_at": now_iso,
            })
            .eq("id", follow_up_id).execute()
        )
    except Exception as e:
        print(f"[warn] mark_follow_up_asked {follow_up_id}: {e}")


#: How many rows to fetch before ranking. Wider than what ships in the prompt
#: because the top three are picked by relevance to *this* question, and a
#: recency-ordered fetch of exactly three would pre-empt that choice.
MEMORY_FETCH_LIMIT = 40


async def get_memory_context(
    user_id: Optional[str], query: str = "", limit: int = MEMORY_FETCH_LIMIT,
) -> str:
    """The few long-term memories that bear on this question.

    Was: the twelve most recently updated, always, grouped by category. Two
    problems with that. Recency makes it a second short history rather than a
    profile, duplicating what the recent-message window already carries; and
    twelve unbounded values is a block with no ceiling sitting in front of every
    single turn.

    Now: fetch a wider set, rank against the parent's current message, keep the
    top three, cap each. Grouping by category is kept — it reads as a profile
    rather than a list of overheard remarks — but only over what survives.
    """
    if not user_id:
        return ""
    sb = runtime.get_supabase()
    if not sb:
        return ""
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("user_memories").select("category,key,value,updated_at")
            .eq("user_id", user_id).eq("status", "active")
            .order("updated_at", desc=True).limit(limit).execute()
        )
        rows = res.data or []
    except Exception as e:
        print(f"[warn] get_memory_context: {e}")
        return ""
    if not rows:
        return ""
    picked = context_budget.select_memories(
        [
            {"text": r["value"], "category": r["category"],
             "updated_at": r.get("updated_at") or ""}
            for r in rows
            if (r.get("value") or "").strip()
        ],
        query,
    )
    grouped: dict[str, list[str]] = {}
    for m in picked:
        label = MEMORY_CATEGORY_LABELS.get(m["category"], "其他信息")
        grouped.setdefault(label, []).append(m["text"])
    return "\n".join(f"{label}：{'；'.join(values)}" for label, values in grouped.items())
