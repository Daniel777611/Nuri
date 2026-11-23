"""Bounded, read-only context for a consented Alpha live voice call."""

import asyncio
import json
import re

import anyio
from fastapi import HTTPException

from backend import stores
from backend.nuri_core import family_store

_MESSAGE_LIMIT = 6
_MESSAGE_CHARS = 220
_RELEVANT_MEMORY_CHARS = 400
_GENERAL_MEMORY_CHARS = 320
_STANDING_CHARS = 480
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
    if not query.strip():
        return "", await family_store.get_recalled_memory_context(uid)
    related, general = await asyncio.gather(
        family_store.get_recalled_memory_context(uid, query[:600]),
        family_store.get_recalled_memory_context(uid),
    )
    return related, general


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
        standing, (related, general), (_, children) = await asyncio.gather(
            family_store.get_standing_context(uid),
            _recall(uid, query),
            family_store.load_profile(uid),
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
            "standing_considerations": _private_text(requirements, children, _STANDING_CHARS),
            "saved_memories": "\n".join(part for part in (ranked, recent) if part),
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
