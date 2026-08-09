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
import uuid
from datetime import date, datetime, time as dt_time, timedelta, timezone
from typing import Optional

import anyio

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


async def attach_child_recommendation_context(uid: str, context: dict) -> dict:
    """Attach safe child-stage and questionnaire recommendation context.

    Exact birthdays, names and free-form profile fields never enter this
    structure.  The two questionnaire values are fixed enum-like codes used
    only to calculate an explainable content-category prior.
    """

    profile, children = await load_profile(uid)
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

    for child in children or []:
        desc = []
        name = (child.get("nickname") or "").strip()
        age = age_label(child.get("birth_date"))
        if age:
            desc.append(age)
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
            parts.append(f"孩子{('（' + name + '）') if name else ''}：{'，'.join(desc)}")

    block = "；".join(parts)
    help_pref = HELP_PREF_LABELS.get(row.get("help_preference"))
    if help_pref:
        block += f"\n这位家长{help_pref}。在不违反上述规则的前提下，按这个偏好来组织回答。"
    return block

PROFILE_FIELDS = (
    "nickname,city,parent_role,top_concerns,concern_other,hobbies,"
    "help_preference,info_source"
)

async def load_profile(user_id: Optional[str]) -> tuple[dict, list]:
    """Fetch the profile answers and children behind the prompt block.

    One loader for every caller: the chat path used to select a narrower column
    set than profile_ctx reads, so answers the parent had given were silently
    dropped in chat while showing up in the intro message.
    """
    sb = runtime.get_supabase()
    if not user_id or not sb:
        return {}, []
    async def _user():
        try:
            r = await anyio.to_thread.run_sync(
                lambda: sb.table("users").select(PROFILE_FIELDS)
                .eq("id", user_id).maybe_single().execute()
            )
            return (r.data if r else None) or {}
        except Exception as e:
            print(f"[warn] load_profile user: {e}")
            return {}
    async def _children():
        try:
            r = await anyio.to_thread.run_sync(
                lambda: sb.table("children").select("nickname,birth_date,gender,allergies,notes")
                .eq("user_id", user_id).execute()
            )
            return r.data or []
        except Exception as e:
            print(f"[warn] load_profile children: {e}")
            return []
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

def extract_memories_sync(history: list[dict]) -> dict:
    """Ask a small model whether this conversation contains stable, reusable facts."""
    if not oai:
        return {"memories": [], "follow_ups": []}
    convo = "\n".join(
        f"{'用户' if m['role'] == 'user' else 'NURI'}: {m.get('text', '')}"
        for m in history[-8:] if m.get("text")
    )
    if not convo.strip():
        return {"memories": [], "follow_ups": []}
    system = (
        "从下面这段育儿助手对话里提取两种东西。两者都没有就都返回空数组，不要勉强凑数。\n\n"
        "memories：值得长期记住的、稳定的事实——长期偏好、过敏史、育儿理念上的坚持、"
        "孩子的持续性状态。不要提取一次性的、当下情绪化的、或还不确定的内容。\n\n"
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
    now = now()
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
                updates = {"source_id": source_id, "last_confirmed_at": now, "updated_at": now}
                if confidence >= old_confidence:
                    updates["value"] = value
                    updates["confidence"] = confidence
                await anyio.to_thread.run_sync(lambda: sb.table("user_memories").update(updates).eq("id", row_id).execute())
            else:
                row = {
                    "id": str(uuid.uuid4()), "user_id": user_id, "child_id": child_id,
                    "category": category, "key": key, "value": value, "confidence": confidence,
                    "source_type": source_type, "source_id": source_id, "status": "active",
                    "created_at": now, "updated_at": now, "last_confirmed_at": now,
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


def follow_up_due_at(item: dict) -> tuple[str, str]:
    """Resolve when to come back to something, and record where the date came
    from. A parent-stated date is used as given; otherwise the topic decides."""
    stated = (item.get("due_date") or "").strip()
    if stated:
        try:
            d = date.fromisoformat(stated[:10])
            # A date already in the past was probably mentioned as history
            # rather than as a plan; check in tomorrow instead of never.
            if d < date.today():
                d = date.today() + timedelta(days=1)
            return datetime.combine(d, dt_time(9, 0), tzinfo=timezone.utc).isoformat(), "stated"
        except (ValueError, TypeError):
            pass
    topic = (item.get("topic") or "") + (item.get("note") or "")
    days = next((v for k, v in FOLLOW_UP_INTERVALS.items() if k in topic), FOLLOW_UP_DEFAULT_DAYS)
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(), "inferred"


async def upsert_follow_ups(
    items: list[dict], *, user_id: str, source_id: Optional[str],
) -> None:
    """One open follow-up per topic. A parent who mentions 托嬰 across four turns
    should be asked once, not four times — the partial unique index enforces it,
    and this refreshes the existing row rather than failing on the conflict."""
    sb = runtime.get_supabase()
    if not sb or not items:
        return
    now = now()
    for item in items[:3]:
        topic = (item.get("topic") or "").strip()
        if not topic:
            continue
        due_at, due_source = follow_up_due_at(item)
        try:
            existing = await anyio.to_thread.run_sync(
                lambda: sb.table("follow_ups").select("id,due_source")
                .eq("user_id", user_id).eq("topic", topic).eq("status", "pending").execute()
            )
            if existing.data:
                row_id = existing.data[0]["id"]
                # Never let an inferred date overwrite one the parent gave.
                patch = {"note": (item.get("note") or "").strip(), "updated_at": now}
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
                    "created_at": now, "updated_at": now,
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
        now = now()
        await anyio.to_thread.run_sync(
            lambda: sb.table("follow_ups")
            .update({"status": "asked", "asked_at": now, "updated_at": now})
            .eq("id", follow_up_id).execute()
        )
    except Exception as e:
        print(f"[warn] mark_follow_up_asked {follow_up_id}: {e}")


async def get_memory_context(user_id: Optional[str], limit: int = 12) -> str:
    """Fetch active long-term memories for the Context Builder, grouped by category
    so the prompt reads as a stable profile block rather than a flat dump."""
    if not user_id:
        return ""
    sb = runtime.get_supabase()
    if not sb:
        return ""
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("user_memories").select("category,key,value")
            .eq("user_id", user_id).eq("status", "active")
            .order("updated_at", desc=True).limit(limit).execute()
        )
        rows = res.data or []
    except Exception as e:
        print(f"[warn] get_memory_context: {e}")
        return ""
    if not rows:
        return ""
    grouped: dict[str, list[str]] = {}
    for r in rows:
        label = MEMORY_CATEGORY_LABELS.get(r["category"], "其他信息")
        grouped.setdefault(label, []).append(r["value"])
    return "\n".join(f"{label}：{'；'.join(values)}" for label, values in grouped.items())
