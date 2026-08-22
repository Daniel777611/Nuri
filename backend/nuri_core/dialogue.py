"""3 对话与主动模型 — 生成与规划，优化沟通策略.

The layer that decides how the reply is said, and what it raises that the
parent did not ask about. It is also where the point of the whole exercise
lands: the system prompt stops being a document somebody edits and becomes the
render of a directive set.

A directive is a row — a sentence, a condition, a weight, a source. This module
loads the ones on file, keeps the ones whose condition matches this turn,
multiplies them by what the outcome model learned, sorts, and renders. Changing
what NURI says is then an insert, scoped to the families and situations it
should apply to, and reversible by flipping `active`.

Section order is a latency decision as much as an editorial one. OpenAI caches
the longest identical prefix across calls, so blocks are emitted most-stable
first: a per-turn block placed early truncates the cache to whatever precedes
it. The always-on directives and the profile barely move between turns; the
conditional directives, retrieved rules and fetched sources go last.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from typing import Optional, Sequence

from backend.nuri_core.contracts import (
    DialoguePlan,
    Directive,
    EvidenceDecision,
    FamilyState,
    LearnedPolicy,
)
from backend.nuri_core import context_budget
from backend.nuri_core.ports import CorePorts
from backend.nuri_core.safety import SafetyVerdict

DIRECTIVES_TABLE = "nuri_directives"
STYLE_RULES_TABLE = "nuri_style_rules"

#: Directives are operator-authored and global, so one cache serves every
#: family. This is the block the linear pipeline re-fetched on every turn for
#: every user, and it changes a few times a week.
DIRECTIVES_TTL_S = 120.0
DIRECTIVES_LIMIT = 200

_cache: tuple[list[Directive], float] | None = None

HEADINGS = {
    "always": "运营团队根据实际反馈持续积累的回复规则，必须遵守：",
    "profile": "这位家长的基本情况（来自注册信息）：",
    "state": "这次对话到目前为止（摘要）：",
    "memory": "关于这位家长的长期信息（已确认，可直接使用，不用重新确认）：",
    "card": "本次对话相关内容：",
    "conditional": "这一轮额外适用的规则（根据家庭情况和话题命中，优先级高于上面的通则）：",
    "safety": "安全与责任约束，高于以上全部：",
}


def clear_cache() -> None:
    global _cache
    _cache = None


async def load_directives(ports: CorePorts) -> list[Directive]:
    """Fetch the operator-authored directive set.

    Reads two tables on purpose. `nuri_directives` is the new conditional
    store; `nuri_style_rules` is where every rule distilled from a `#fix`
    already lives, and those keep working unchanged — they load as
    unconditional directives, which is exactly how the old always-on block
    behaved. Nothing has to be migrated for this pipeline to match the current
    output, and a rule can be narrowed later by moving one row.
    """
    global _cache
    if _cache and _cache[1] > time.monotonic():
        return _cache[0]

    sb = ports.supabase()
    directives: list[Directive] = []

    if sb:
        # Two independent tables, so two concurrent reads. Serial here would
        # double the one stage that every turn pays for and that the cache
        # only spares 119 turns out of 120.
        conditional, style = await asyncio.gather(
            _load_conditional(sb, ports), _load_style_rules(sb, ports),
        )
        directives.extend(conditional)
        directives.extend(style)
    if not directives:
        # No Supabase, or neither table exists yet. Fall back to the port,
        # which returns the same joined block the linear pipeline used.
        directives.extend(_from_block(await ports.style_rules()))

    _cache = (directives, time.monotonic() + DIRECTIVES_TTL_S)
    return directives


async def _load_conditional(sb, ports: CorePorts) -> list[Directive]:
    try:
        res = await ports.to_thread(
            lambda: sb.table(DIRECTIVES_TABLE)
            .select("id,layer,kind,text,priority,weight,applies_when,source")
            .eq("active", True)
            .order("priority", desc=True)
            .limit(DIRECTIVES_LIMIT)
            .execute()
        )
        rows = getattr(res, "data", None) or []
    except Exception as e:
        # Expected until four_model_migration.sql has been run.
        print(f"[warn] dialogue: {DIRECTIVES_TABLE} unavailable: {type(e).__name__}: {e}")
        return []
    out = []
    for row in rows:
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        out.append(Directive(
            id=str(row.get("id")),
            text=text,
            layer=str(row.get("layer") or "dialogue"),
            kind=str(row.get("kind") or "style"),
            priority=int(row.get("priority") or 0),
            weight=float(row.get("weight") if row.get("weight") is not None else 1.0),
            applies_when=row.get("applies_when") or {},
            source=str(row.get("source") or "authored"),
        ))
    return out


async def _load_style_rules(sb, ports: CorePorts) -> list[Directive]:
    try:
        res = await ports.to_thread(
            lambda: sb.table(STYLE_RULES_TABLE)
            .select("id,rule,category")
            .eq("active", True)
            .order("created_at", desc=True)
            .limit(50)
            .execute()
        )
        rows = getattr(res, "data", None) or []
    except Exception as e:
        print(f"[warn] dialogue: {STYLE_RULES_TABLE} unavailable: {type(e).__name__}: {e}")
        return []
    return [
        Directive(
            id=f"style:{row.get('id')}",
            text=str(row.get("rule") or "").strip(),
            layer="dialogue",
            kind=str(row.get("category") or "style"),
            source="fix",
        )
        for row in rows if str(row.get("rule") or "").strip()
    ]


def _from_block(block: str) -> list[Directive]:
    """Recover directives from the legacy joined string.

    Ids are hashes of the text rather than row ids, so the outcome model can
    still address them — a weight learned this way survives as long as the
    wording does, which is the right lifetime for it.
    """
    out = []
    for line in (block or "").splitlines():
        text = line.lstrip("-• ").strip()
        if not text:
            continue
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
        out.append(Directive(id=f"style:{digest}", text=text, source="fix"))
    return out


def plan(
    *,
    family: FamilyState,
    evidence: EvidenceDecision,
    policy: LearnedPolicy,
    verdict: SafetyVerdict,
    directives: Sequence[Directive],
    card_block: str = "",
    state_block: str = "",
    history_window: int = context_budget.RECENT_MESSAGES,
) -> DialoguePlan:
    """Assemble the turn. Pure — every input is already resolved.

    Being pure is what makes the comparison the branch exists for possible: the
    same family, evidence and policy must produce the same prompt every time,
    or the two pipelines cannot be told apart from their outputs.
    """
    facts = {
        **family.facts(),
        "risk_tier": verdict.tier,
        "topic": evidence.topic,
    }

    applicable = policy.weigh([d for d in directives if d.matches(facts)])
    applicable.extend(policy.weigh([d for d in policy.directives if d.matches(facts)]))
    # Safety is not weighted and not learnable. A gate a bad month of signals
    # could switch off is not a gate.
    safety_directives = list(verdict.directives)

    always = [d for d in applicable if not d.applies_when]
    conditional = [d for d in applicable if d.applies_when]
    _sort(always)
    _sort(conditional)

    if verdict.minimal_context:
        # An emergency reply is one instruction long. Everything else in the
        # prompt is something for the model to weigh against "call 911".
        return DialoguePlan(
            sections=((HEADINGS["safety"], _render(safety_directives)),),
            directives=tuple(safety_directives),
            proactive="",
            allow_task_cards=False,
            history_window=min(history_window, 6),
        )

    # A due follow-up is a nicety. Raising 副食品 in the middle of a medical
    # question reads as not having listened, so the proactive channel closes
    # as soon as the turn carries any risk at all.
    proactive = family.follow_up_block if verdict.tier == "none" else ""

    memory = family.memory_block
    if proactive:
        # Appended to the memory block rather than given a heading of its own:
        # both answer "what does NURI already know about this family", and a
        # separate section invites the model to work through it as a checklist.
        memory = f"{memory}\n\n{proactive}" if memory else proactive

    # Ordered most stable first. The first three hold still while one family
    # talks — operator rules are global, the profile changes when a birthday
    # passes, the summary a few times per conversation — so `stable_sections`
    # below marks the seam the prefix cache can reach. Memory moved after them
    # because it is now re-ranked against each question rather than fetched by
    # recency, which makes it per-turn content.
    sections: list[tuple[str, str]] = [
        (HEADINGS["always"], _render(always)),
        (HEADINGS["profile"], family.profile_block),
        (HEADINGS["state"], state_block),
        (HEADINGS["memory"], memory),
        (HEADINGS["card"], card_block),
        (HEADINGS["conditional"], _render(conditional)),
        ("", evidence.internal_block),
        (HEADINGS["safety"], _render(safety_directives)),
        # Last, and after the internal rules on purpose: external pages are the
        # weakest tier of context NURI has, and the block itself says so.
        ("", evidence.sources_block),
    ]

    return DialoguePlan(
        sections=tuple((h, b) for h, b in sections if b),
        directives=tuple(always + conditional + safety_directives),
        proactive=proactive,
        allow_task_cards=verdict.allow_task_cards,
        history_window=history_window,
        # always + profile + state: everything above `memory` in the list.
        stable_sections=3,
    )


def _sort(directives: list[Directive]) -> None:
    """Highest priority first, then heaviest.

    Deliberately not tie-broken by id: Python's sort is stable, so directives
    of equal standing keep the order they were loaded in, which is the order
    the operator authored them in. Sorting equal rules by a hashed id would
    scramble a hand-ordered rule set for no gain — the load order is already
    deterministic, so the prompt prefix is still stable across turns.
    """
    directives.sort(key=lambda d: (-d.priority, -d.weight))


def _render(directives: Sequence[Directive]) -> str:
    return "\n".join(d.render() for d in directives)
