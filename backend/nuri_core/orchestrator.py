"""The bus: runs the four subsystems in the order their dependencies allow.

The linear pipeline was one `asyncio.gather` over six context loaders followed
by one prompt concatenation. That is fast enough when every block is needed and
wasteful when they are not, and it offers nowhere to stand if you want to
change what NURI says without editing the prompt.

This runs in three waves, and the wave boundaries are exactly the arrows in the
architecture diagram:

    wave 0  家庭模型 core + Safety Layer          synchronous, no I/O
            The profile row is already in hand, so the family's stage and hard
            constraints — and therefore an emergency — are known before any
            round trip. 家庭状态 is what the knowledge model routes against.

    wave 1  家庭模型 enrich · 知识与决策 · 结果学习 · directive load
            Fully parallel. The expensive family half no longer blocks the
            search, which is the single biggest latency change here.

    wave 2  对话与主动模型                        pure, no I/O
            Everything it needs is resolved, so assembly is deterministic and
            testable.

Never raises. A subsystem that fails contributes nothing and says so in the
trace; the turn still gets a reply, which is the only invariant that matters on
this path.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional, Sequence

from backend.nuri_core import (
    context_budget,
    dialogue,
    family,
    family_store,
    knowledge,
    outcome,
    safety,
)
from backend.nuri_core.contracts import (
    DialoguePlan,
    EvidenceDecision,
    FamilyState,
    LearnedPolicy,
    TurnBundle,
)
from backend.nuri_core.ports import CorePorts
from backend.nuri_core.provenance import TurnTrace

#: Bumped whenever a change would move replies. Stored on every trace so a
#: regression can be attributed to a version rather than to a date range.
PIPELINE_VERSION = "four-model-v1"


async def run_turn_context(
    *,
    history: Sequence[dict],
    user_text: str,
    uid: Optional[str],
    context_hints: dict,
    ports: CorePorts,
    route_turn,
    source_card_id: str = "",
    session_id: str = "",
    history_window: int = context_budget.RECENT_MESSAGES,
    on_route_done=None,
    trace: Optional[TurnTrace] = None,
) -> TurnBundle:
    """Assemble one turn's context through the four subsystems."""
    trace = trace or TurnTrace(version=PIPELINE_VERSION)
    started = time.perf_counter()

    # ── wave 0 ────────────────────────────────────────────────────────────
    with trace.stage("family_core"):
        core = family.core(context_hints, ports, uid)
    with trace.stage("safety"):
        verdict = safety.assess(
            user_text, family=core, is_urgent=ports.is_urgent,
            is_crisis=ports.is_crisis,
            is_caregiver_harm=ports.is_caregiver_harm,
            is_referral=ports.is_referral, is_medical=False,
        )
    trace.note(
        risk_tier=verdict.tier,
        age_months=core.age_months,
        constraints=len(core.constraints),
    )

    # ── wave 1 ────────────────────────────────────────────────────────────
    results = await asyncio.gather(
        _stage(trace, "family_enrich", family.enrich(core, ports), core),
        _stage(trace, "outcome", outcome.policy(uid, ports), LearnedPolicy()),
        _stage(trace, "directives", dialogue.load_directives(ports), []),
        _stage(trace, "card", _card(source_card_id, ports), ""),
        # In wave 1 with the rest: a single indexed read, and the reply must
        # never wait on it serially.
        _stage(trace, "state", _state(session_id, ports), ""),
        _stage(
            trace, "knowledge",
            knowledge.decide(
                history, user_text, core, verdict, ports,
                route_turn=route_turn, on_route_done=on_route_done,
            ),
            (EvidenceDecision(risk_tier=verdict.tier), verdict),
        ),
    )
    enriched, policy, directives, card_block, state_block, (evidence, verdict) = results
    state_block = family_store.reconcile_context_with_child_profile(
        state_block, list(core.child_profiles),
    )

    # Attributed here rather than inside knowledge, so the numbers line up with
    # what the linear pipeline reported under the same names.
    for key, value in (evidence.timings or {}).items():
        trace.timings[key.removesuffix("_ms")] = value
    trace.note(
        family_cache_hit=enriched.cache_hit,
        directives_loaded=len(directives),
        outcome_samples=policy.samples,
        negative_topics=len(policy.negative_topics),
        retrieved=",".join(evidence.retrieved),
        skipped=",".join(f"{k}:{v}" for k, v in (evidence.skipped or {}).items()),
        risk_tier=verdict.tier,
        topic=evidence.topic,
    )

    # ── wave 2 ────────────────────────────────────────────────────────────
    with trace.stage("dialogue"):
        plan = dialogue.plan(
            family=enriched,
            evidence=evidence,
            policy=policy,
            verdict=verdict,
            directives=directives,
            card_block=card_block,
            state_block=state_block,
            history_window=history_window,
            turn_count=sum(
                1 for m in history if (m or {}).get("role") == "user"
            ),
        )
    trace.directive_ids = [d.id for d in plan.directives]
    # Attributed by owning subsystem rather than by prompt section: "the family
    # model contributed 900 characters" is the number that decides whether a
    # layer is earning its place, and two sections share the empty heading.
    trace.contributed("family", enriched.profile_block + enriched.memory_block)
    trace.contributed("knowledge", evidence.internal_block + evidence.sources_block)
    trace.contributed("dialogue", _rendered_directives(plan))
    trace.contributed("card", card_block)
    trace.note(directives_applied=len(plan.directives), proactive=bool(plan.proactive))
    trace.mark("context", started)

    return TurnBundle(
        # The legacy-shaped fields, so both pipelines can feed the same reply
        # call and be compared on output rather than on plumbing.
        card=card_block,
        memory=_body(plan, dialogue.HEADINGS["memory"]),
        profile=enriched.profile_block,
        state=state_block,
        # Both style blocks, joined. The legacy field is what the linear
        # pipeline called `style_ctx` and what `_prompt_version` hashes, so it
        # has to mean "the operator rules this turn used" — which is now two
        # sections rather than one.
        style=_style_block(plan),
        internal=evidence.internal_block,
        sources=evidence.sources_block,
        route=evidence.route,
        search_results=evidence.search_results,
        family=enriched,
        evidence=evidence,
        plan=plan,
        policy=policy,
        trace=trace,
    )


async def _stage(trace: TurnTrace, name: str, coro, fallback):
    """Run one subsystem, timed, and never let it take the turn down.

    The fallback is that subsystem's "contributed nothing" value, which is why
    each one is chosen at the call site: an empty `LearnedPolicy` still weighs
    directives correctly, and an empty `EvidenceDecision` still renders a
    prompt. Degradation is per-layer by construction.
    """
    started = time.perf_counter()
    try:
        return await coro
    except Exception as e:
        print(f"[warn] nuri_core: {name} failed: {type(e).__name__}: {e}")
        trace.note(**{f"{name}_error": f"{type(e).__name__}"})
        return fallback
    finally:
        trace.mark(name, started)


async def _state(session_id: str, ports: CorePorts) -> str:
    """The conversation summary carrying everything the recent window drops."""
    if not session_id:
        return ""
    summary, _covered = await ports.conversation_state(session_id)
    return summary or ""


async def _card(source_card_id: str, ports: CorePorts) -> str:
    """The article the parent tapped in from, if any. Skipped entirely for an
    ordinary chat turn — the linear pipeline fetched the generated-card table
    on every turn to render nothing."""
    if not source_card_id:
        return ""
    gen_cards = await ports.gen_cards()
    return ports.card_ctx(source_card_id, gen_cards)


def _body(plan: DialoguePlan, heading: str) -> str:
    return next((b for h, b in plan.sections if h == heading), "")


def _style_block(plan: DialoguePlan) -> str:
    parts = [
        _body(plan, dialogue.HEADINGS["always"]),
        _body(plan, dialogue.HEADINGS["advisory"]),
    ]
    return "\n".join(p for p in parts if p)


def _rendered_directives(plan: DialoguePlan) -> str:
    return "\n".join(d.text for d in plan.directives)
