"""Bounded, read-only context for a consented Alpha live voice call."""

import asyncio
import json
import re

import anyio
from fastapi import HTTPException

from backend import stores
from backend.nuri_core import context_budget, family_store, state_store

_MESSAGE_LIMIT = 16
_MESSAGE_CHARS = 220
_RELEVANT_MEMORY_CHARS = 900
_GENERAL_MEMORY_CHARS = 900
_STANDING_CHARS = 720
_SUMMARY_CHARS = 1600
_PROFILE_CHARS = 960
_LINK_OR_EMAIL = re.compile(
    r"https?://[^\s]+|www\.[^\s]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}", re.IGNORECASE,
)


def _private_text(value: object, children: list[dict], limit: int) -> str:
    if not isinstance(value, str):
        return ""
    # Bound processing before applying the shared profile redactor. Never send
    # pasted links, account emails, or the child's stored name/birth date.
    without_links = _LINK_OR_EMAIL.sub("[redacted]", value[:8192])
    plain = family_store.redact_child_profile_text(without_links, children)
    return " ".join(plain.split())[:limit].strip()


async def _recent_text(sb, session_id: str) -> list[dict]:
    result = await anyio.to_thread.run_sync(
        lambda: sb.table("chat_messages").select("role,text,transition_kind:transition->>kind")
        .eq("session_id", session_id).in_("role", ["user", "ai"])
        .order("created_at", desc=True).order("id", desc=True).limit(_MESSAGE_LIMIT).execute(),
        abandon_on_cancel=True,
    )
    return list(reversed(result.data or []))


async def _recall(uid: str, query: str) -> tuple[str, str]:
    rows = await family_store.load_known_memories(uid)
    facts = [
        {"text": str(row.get("value") or ""), "category": row.get("category", "fact")}
        for row in rows
        if row.get("category") != family_store.STANDING_CATEGORY and row.get("value")
    ]
    ranked = context_budget.select_memories(facts, query[:600], top_k=8)

    def render(items: list[dict]) -> str:
        return "\n".join(
            f"{family_store.MEMORY_CATEGORY_LABELS.get(item['category'], '其他信息')}：{item['text']}"
            for item in items
        )

    return render([item for item in ranked if item["score"] > 0]), render(facts[:12])


def _profile_text(profile: dict, children: list[dict]) -> str:
    # Apply the same onboarding labels as text chat. Realtime's disclosure
    # does not need names, addresses, or exact dates to explain a child's stage.
    safe_profile = {key: value for key, value in profile.items() if key in (
        "parent_role", "top_concerns", "concern_other", "help_preference", "info_source",
    )}
    child_facts = []
    for child in children:
        age = family_store.stage_label(str(child.get("birth_date") or ""))
        facts = family_store.profile_ctx({}, [{
            "gender": child.get("gender"), "allergies": child.get("allergies"),
            "notes": child.get("notes"),
        }])
        if age or facts:
            child_facts.append(f"孩子 {len(child_facts) + 1}：{'；'.join(filter(None, (age, facts)))}")
    return _private_text("；".join(filter(None, (family_store.profile_ctx(safe_profile), *child_facts))),
                         children, _PROFILE_CHARS)


def _memory_text(block: str, children: list[dict], seen: set[str], limit: int) -> str:
    # The existing retrieval helper groups facts by category. Deduplicate the
    # individual facts so the fallback can add other cross-conversation context.
    recalled = family_store.reconcile_context_with_child_profile(block, children)
    out = []
    remaining = limit
    for line in recalled.splitlines():
        _, separator, value = line.partition("：")
        for fact in (value if separator else line).split("；"):
            text = _private_text(fact, children, 180)
            key = text.casefold()
            if text and key not in seen and len(text) < remaining:
                out.append(text)
                seen.add(key)
                remaining -= len(text) + 1
    return "\n".join(out)


async def load_context(sb, uid: str, session_id: str | None, load_owned_session) -> str:
    if sb is None or (session_id and load_owned_session is None):
        return ""
    try:
        if session_id:
            await load_owned_session(session_id, uid, sb)
        privacy = await stores.get_privacy(uid, fail_closed=True)
        if privacy.get(stores.PRIVACY_STORAGE_UNAVAILABLE) or privacy.get("allow_history_training") is not True:
            return ""
        rows = await _recent_text(sb, session_id) if session_id else []
        query = next((row.get("text") or "" for row in reversed(rows) if row.get("role") == "user"), "")
        standing, (related, general), (profile, children), (summary, _) = await asyncio.gather(
            family_store.get_standing_context(uid),
            _recall(uid, query),
            family_store.load_profile(uid),
            state_store.load(session_id or ""),
        )
        history = []
        for row in rows:
            if row.get("transition_kind") in {"_nuri_generation_claim", "memory_context"}:
                continue
            role = row.get("role")
            text = _private_text(row.get("text"), children, _MESSAGE_CHARS)
            if role in {"user", "ai"} and text and text.casefold() not in {"[图片]", "[圖片]", "[image]"}:
                history.append({"speaker": "Caregiver" if role == "user" else "Nuri", "text": text})
        seen: set[str] = set()
        ranked = _memory_text(related, children, seen, _RELEVANT_MEMORY_CHARS)
        recent = _memory_text(general, children, seen, _GENERAL_MEMORY_CHARS if ranked else
                              _RELEVANT_MEMORY_CHARS + _GENERAL_MEMORY_CHARS)
        requirements = family_store.reconcile_context_with_child_profile(standing, children)
        context = {
            "child_stage": family_store.safe_child_recommendation_context(children)["child_age_context"],
            "confirmed_profile": _profile_text(profile, children),
            "standing_considerations": _private_text(requirements, children, _STANDING_CHARS),
            "saved_memories": "\n".join(part for part in (ranked, recent) if part),
            "chat_summary": _private_text(family_store.reconcile_context_with_child_profile(summary, children),
                                          children, _SUMMARY_CHARS),
            "recent_chat": history,
        }
        return json.dumps(context, ensure_ascii=False, separators=(",", ":")) if any(context.values()) else ""
    except HTTPException as exc:
        if exc.status_code == 404:
            raise
        return ""
    except Exception:
        # Call setup can continue without private context if any read fails.
        # Do not log exception strings, which may include user or row values.
        return ""
