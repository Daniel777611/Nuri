"""1 家庭模型 — 身份 阶段 偏好 约束.

Owns everything durable about a family: the onboarding answers, the children,
the long-term memories, and the open follow-ups. Every other subsystem reads
家庭状态 from here rather than going to the tables itself, which is what stops
the same profile row from being fetched three times a turn.

Two properties this layer exists to provide:

**A cheap half and an expensive half.** The profile row is already in hand when
a turn starts — main.py loads it to log the normalized input — so `core()` is
free and synchronous. The knowledge model only needs the free half to write a
search query, so retrieval starts immediately while memories are still loading.
In the linear pipeline the search waited behind them.

**A fingerprint.** A family's durable facts change on the order of days; the
old pipeline re-fetched and re-rendered them on every single turn. `core()`
produces a fingerprint over the facts that matter, so the enriched half can be
served from cache when nothing has moved, and is provably fresh when it has.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import replace
from typing import Optional

import anyio

from backend.nuri_core import family_store
from backend.nuri_core.contracts import FamilyState
from backend.nuri_core.ports import CorePorts

#: How long an enriched state may be served from cache. Short on purpose:
#: memory extraction runs as a background task right after a turn, so the
#: window is sized to "the parent is still typing the next message", not to
#: "nothing has changed today". `invalidate` handles the known writes; this
#: bounds the unknown ones.
DEFAULT_TTL_S = 60.0

#: (fingerprint, state, expires_at) keyed by uid. Per-process, which on
#: serverless means per warm instance — a cache miss costs exactly what the old
#: pipeline paid every time, so a cold start is never worse than the baseline.
_cache: dict[str, tuple[str, FamilyState, float]] = {}


def invalidate(uid: Optional[str]) -> None:
    """Drop a family's cached state. Called after anything writes to
    user_memories, follow_ups, children or the profile row."""
    if uid:
        _cache.pop(uid, None)


def clear_cache() -> None:
    _cache.clear()


def _fingerprint(profile: dict, children: list) -> str:
    """Hash the facts that would change the rendered blocks.

    Deliberately does not include memories: they are what the fingerprint is
    used to decide whether to *fetch*, so reading them to build it would defeat
    the purpose. The TTL covers that drift, and `invalidate` covers the writes
    this process knows about.
    """
    rows = [
        "|".join(
            str(profile.get(k) or "")
            for k in ("nickname", "city", "parent_role", "hobbies",
                      "help_preference", "info_source", "concern_other")
        ),
        ",".join(sorted(str(c) for c in (profile.get("top_concerns") or []))),
    ]
    for child in sorted(children, key=lambda c: str(c.get("birth_date") or "")):
        rows.append("|".join((
            str(child.get("nickname") or ""),
            str(child.get("birth_date") or "")[:10],
            str(child.get("gender") or ""),
            ",".join(sorted(str(a) for a in (child.get("allergies") or []))),
            str(child.get("notes") or ""),
        )))
    return hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()[:24]


def _constraints(children: list) -> tuple[str, ...]:
    """Promote hard limits out of free text so the safety layer can see them.

    An allergy buried in a paragraph of profile prose is a fact the reply model
    may or may not weigh. Listed here it becomes a condition other subsystems
    can branch on, and a directive that outranks every learned preference.
    """
    out: list[str] = []
    for child in children:
        name = str(child.get("nickname") or "孩子").strip() or "孩子"
        for allergy in child.get("allergies") or []:
            text = str(allergy).strip()
            if text:
                out.append(f"{name}对{text}过敏")
    return tuple(dict.fromkeys(out))


def core(context_hints: dict, ports: CorePorts, uid: Optional[str] = None) -> FamilyState:
    """The free half: everything derivable from the profile row already loaded.

    No I/O. Whatever this returns is enough for the knowledge model to route
    and search, which is the entire reason it is separated out.
    """
    hints = context_hints or {}
    children = list(hints.get("children") or [])
    profile = {k: v for k, v in hints.items() if k != "children"}

    # The youngest child sets the stage: advice for a household with a newborn
    # and a five-year-old is written for the newborn, and the search query has
    # to be too.
    aged = [(m, c) for m, c in
            ((ports.age_months(str(c.get("birth_date") or "")), c) for c in children)
            if isinstance(m, int)]
    youngest_months, youngest_child = min(aged, key=lambda pair: pair[0]) if aged else (None, None)

    return FamilyState(
        uid=uid,
        nickname=str(profile.get("nickname") or "").strip(),
        profile_block=ports.profile_ctx(profile, children),
        age_months=youngest_months,
        stage_label=ports.age_label(str(youngest_child.get("birth_date") or ""))
        if youngest_child else "",
        help_preference=str(profile.get("help_preference") or ""),
        info_source=str(profile.get("info_source") or ""),
        locale=str(profile.get("preferred_locale") or "zh-TW"),
        constraints=_constraints(children),
        fingerprint=_fingerprint(profile, children),
        enriched=False,
    )


async def enrich(
    state: FamilyState, ports: CorePorts, *, ttl_s: float = DEFAULT_TTL_S,
) -> FamilyState:
    """The expensive half: long-term memories and due follow-ups.

    Returns the core state unchanged for anonymous sessions — there is nothing
    to remember about a parent who is not signed in, and the two round trips
    would come back empty.
    """
    uid = state.uid
    if not uid:
        return state

    cached = _cache.get(uid)
    if cached and cached[0] == state.fingerprint and cached[2] > time.monotonic():
        hit = cached[1]
        # Re-keyed onto this turn's core rather than returned as-is: the cached
        # entry only supplies the two blocks it was cached for, so a locale
        # switch or any other per-turn field still takes effect.
        return replace(
            state,
            memory_block=hit.memory_block,
            follow_up_block=hit.follow_up_block,
            enriched=True,
            cache_hit=True,
        )

    memory_block, follow_up_block = await asyncio.gather(
        ports.memory_context(uid),
        ports.follow_up_context(uid),
    )
    enriched = replace(
        state,
        memory_block=memory_block or "",
        follow_up_block=follow_up_block or "",
        enriched=True,
        cache_hit=False,
    )
    _cache[uid] = (state.fingerprint, enriched, time.monotonic() + ttl_s)
    return enriched


async def extract_and_upsert_memories(
    history: list[dict], user_id: str, source_id: str, source_type: str = "chat",
) -> None:
    """Learn what this turn revealed about the family, and drop the cache.

    Runs as a fire-and-forget background task so extraction never adds latency
    to the chat reply (or task update) the user is waiting on.

    It lives here rather than in family_store because of the last line: the
    cache belongs to this module, and a write that leaves a stale entry behind
    is how a parent ends up telling NURI the same thing twice. Keeping the
    invalidation in the same function as the write is the only arrangement
    where that cannot be forgotten.
    """
    if not family_store.worth_extracting(history):
        return
    try:
        extracted = await anyio.to_thread.run_sync(
            lambda: family_store.extract_memories_sync(history)
        )
        memories = extracted if isinstance(extracted, list) else extracted.get("memories", [])
        await family_store.upsert_memories(
            memories, user_id=user_id, child_id=None,
            source_type=source_type, source_id=source_id,
        )
        if isinstance(extracted, dict):
            await family_store.upsert_follow_ups(
                extracted.get("follow_ups", []), user_id=user_id, source_id=source_id,
            )
        invalidate(user_id)
    except Exception as e:
        print(f"[warn] family: extract_and_upsert_memories: {e}")
