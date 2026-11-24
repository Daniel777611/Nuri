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
    # Preserve the narrower disclosure used by older clients.
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


def _confirmed_profile(profile: dict, children: list[dict]) -> dict:
    """Render the owner's explicitly shared onboarding fields as facts."""
    caregiver = {}
    for key in ("nickname", "city", "concern_other", "hobbies"):
        if value := _private_text(profile.get(key), [], 100):
            caregiver[key] = value
    for key, labels in (
        ("parent_role", family_store.PARENT_ROLE_LABELS),
        ("help_preference", family_store.HELP_PREF_LABELS),
        ("info_source", family_store.INFO_SOURCE_LABELS),
    ):
        if label := labels.get(profile.get(key)):
            caregiver[key] = label
    concerns = profile.get("top_concerns")
    if isinstance(concerns, list):
        values = [
            family_store.CONCERN_LABELS[code] for code in concerns
            if isinstance(code, str) and code in family_store.CONCERN_LABELS
        ]
        if values:
            caregiver["top_concerns"] = list(dict.fromkeys(values))

    profiles = []
    for child in children[:12]:
        facts = {}
        if nickname := _private_text(child.get("nickname"), [], 80):
            facts["nickname"] = nickname
        saved_date = str(child.get("birth_date") or "")[:10]
        if age := family_store.age_label(saved_date):
            facts.update(birth_date=saved_date, current_age=age)
        elif stage := family_store.pregnancy_label(saved_date):
            facts.update(due_date=saved_date, pregnancy_stage=stage)
        if gender := family_store.GENDER_LABELS.get(child.get("gender")):
            facts["gender"] = gender
        allergies = child.get("allergies")
        if isinstance(allergies, list):
            values = [_private_text(value, children, 80) for value in allergies[:6]]
            if values := list(filter(None, values)):
                facts["allergies"] = values
        if notes := _private_text(child.get("notes"), children, 180):
            facts["notes"] = notes
        if facts:
            profiles.append(facts)

    return {key: value for key, value in (("caregiver", caregiver), ("children", profiles)) if value}


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


async def _history_context(sb, uid: str, session_id: str | None, children: list[dict]) -> dict:
    rows = await _recent_text(sb, session_id) if session_id else []
    query = next((row.get("text") or "" for row in reversed(rows) if row.get("role") == "user"), "")
    standing, (related, general), (summary, _) = await asyncio.gather(
        family_store.get_standing_context(uid),
        _recall(uid, query),
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
    return {
        "standing_considerations": _private_text(requirements, children, _STANDING_CHARS),
        "saved_memories": "\n".join(part for part in (ranked, recent) if part),
        "chat_summary": _private_text(family_store.reconcile_context_with_child_profile(summary, children),
                                      children, _SUMMARY_CHARS),
        "recent_chat": history,
    }


async def load_context(
    sb, uid: str, session_id: str | None, load_owned_session, *,
    share_profile: bool = False, share_context: bool = True, budget_seconds: float = 2.25,
) -> str:
    if sb is None or (session_id and load_owned_session is None):
        return ""
    context: dict = {}
    try:
        async with asyncio.timeout(budget_seconds):
            if session_id:
                await load_owned_session(session_id, uid, sb)
            # Save the confirmed profile before optional retrieval, so a
            # history setting, slow memory read or missing chat cannot erase it.
            if share_profile:
                profile, children = await family_store.load_profile(uid)
                context["confirmed_profile"] = _confirmed_profile(profile, children)
            if share_context:
                privacy = await stores.get_privacy(uid, fail_closed=True)
                allow_history = (
                    not privacy.get(stores.PRIVACY_STORAGE_UNAVAILABLE)
                    and privacy.get("allow_history_training") is True
                )
                if allow_history:
                    if not share_profile:
                        profile, children = await family_store.load_profile(uid)
                        context["confirmed_profile"] = _profile_text(profile, children)
                    context["child_stage"] = family_store.safe_child_recommendation_context(children)["child_age_context"]
                    context.update(await _history_context(sb, uid, session_id, children))
    except HTTPException as exc:
        if exc.status_code == 404:
            raise
    except Exception:
        # Continue with independently confirmed facts. Error details may
        # include private values and do not belong in provider or server logs.
        pass
    return json.dumps(context, ensure_ascii=False, separators=(",", ":")) if any(context.values()) else ""
