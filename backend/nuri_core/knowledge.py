"""2 知识与决策模型 — 来源 claim 风险 适用性.

Owns the three evidence stores and, more importantly, the decision about which
of them this turn actually needs:

    internal   the operator-authored rules in the `internal` vector namespace,
               must-follow when they match
    web        allow-listed external pages, fetched live
    card       the article the parent tapped in to ask about

The linear pipeline queried the internal namespace on every turn — an embedding
call plus a vector scan — including on "谢谢" and "好的". It also could not
start the web search until the profile blocks it did not need had finished
loading. Both are fixed here by making the retrieval plan explicit: this module
returns not just what it found but what it chose not to look for and why, which
is what turns a slow turn into a diagnosable one.

`decide` never raises. Every store degrades to an empty block.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Optional, Sequence

from backend.nuri_core import safety
from backend.nuri_core.contracts import EvidenceDecision, FamilyState
from backend.nuri_core.ports import CorePorts
from backend.nuri_core.safety import SafetyVerdict

#: Below this many characters a parent message is an acknowledgement rather
#: than a question — "嗯"、"好的"、"谢谢" — and there is nothing for the internal
#: rules to match on. Same threshold the memory extractor already uses for the
#: same reason, so the two agree about what counts as a substantive turn.
MIN_RETRIEVAL_CHARS = 12


async def decide(
    history: Sequence[dict],
    user_text: str,
    family: FamilyState,
    verdict: SafetyVerdict,
    ports: CorePorts,
    *,
    route_turn,
    on_route_done=None,
) -> tuple[EvidenceDecision, SafetyVerdict]:
    """Route the turn, then fetch only the evidence the route calls for.

    `route_turn` is passed in rather than imported so a test can drive the
    branches without a model. `on_route_done` receives the raw route the moment
    it lands, which is how the turn metrics stay identical to the old pipeline's
    without this module knowing what a metrics row is.

    Returns the decision alongside a possibly-escalated safety verdict: the
    router is the only thing that recognises an implicit medical turn, so the
    gate has to be re-evaluated once it has answered.
    """
    # An emergency spends nothing on retrieval. Four seconds of search is four
    # seconds a parent whose child is not breathing does not have.
    if verdict.minimal_context:
        return (
            EvidenceDecision(
                risk_tier=verdict.tier,
                # Carried, not dropped. `_turn_events` reads the escalation
                # reason code off these, and leaving them behind is why
                # every emergency turn of every round so far reported
                # `escalation_reason_code: null` no matter what id the
                # safety layer put on the directive.
                directives=verdict.directives,
                skipped={"internal": "emergency", "web": "emergency"},
            ),
            verdict,
        )

    substantive = len((user_text or "").strip()) >= MIN_RETRIEVAL_CHARS

    # Internal retrieval and routing have no dependency on each other, so they
    # overlap. The search cannot start until the router has produced a query,
    # which is why that one is serial and why the router is kept small.
    started = time.perf_counter()
    internal_task = asyncio.ensure_future(
        _internal(user_text, ports) if substantive else _nothing()
    )
    route = await _route(history, family, ports, route_turn, on_route_done)
    route_ms = int((time.perf_counter() - started) * 1000)
    verdict = safety.reassess(verdict, is_medical=bool(getattr(route, "is_medical", False)))

    results: Sequence[Any] = ()
    search_ms = 0
    if getattr(route, "needs_search", False):
        started = time.perf_counter()
        results = await _search(route, ports)
        search_ms = int((time.perf_counter() - started) * 1000)

    started = time.perf_counter()
    internal_block = await internal_task
    internal_wait_ms = int((time.perf_counter() - started) * 1000)

    retrieved: list[str] = []
    skipped: dict[str, str] = {}
    if internal_block:
        retrieved.append("internal")
    elif not substantive:
        skipped["internal"] = "acknowledgement"
    else:
        skipped["internal"] = "no_match"
    if results:
        retrieved.append("web")
    elif getattr(route, "needs_search", False):
        skipped["web"] = "no_results"
    else:
        skipped["web"] = "route_said_no"

    decision = EvidenceDecision(
        route=route,
        risk_tier=verdict.tier,
        directives=verdict.directives,
        internal_block=internal_block,
        sources_block=ports.sources_prompt_block(results) if results else "",
        search_results=results,
        retrieved=tuple(retrieved),
        skipped=skipped,
        # `internal_wait` is what the overlap saved: the part of internal
        # retrieval that did not finish behind routing and search. When it is
        # near zero the concurrency is doing its job.
        timings={
            "route_ms": route_ms,
            "search_ms": search_ms,
            "internal_wait_ms": internal_wait_ms,
        },
    )
    return decision, verdict


async def _nothing() -> str:
    return ""


async def _route(history, family: FamilyState, ports: CorePorts, route_turn, on_route_done):
    try:
        route = await route_turn(
            history, client=ports.aoai, child_context=family.search_context(),
        )
    except Exception as e:  # route_turn already swallows its own failures
        print(f"[warn] knowledge: routing failed: {type(e).__name__}: {e}")
        route = None
    if on_route_done:
        try:
            on_route_done(route)
        except Exception as e:
            print(f"[warn] knowledge: route callback failed: {type(e).__name__}: {e}")
    return route


async def _internal(question: str, ports: CorePorts) -> str:
    try:
        return await ports.to_thread(ports.internal_rules, question or "") or ""
    except Exception as e:
        print(f"[warn] knowledge: internal retrieval failed: {type(e).__name__}: {e}")
        return ""


async def _search(route, ports: CorePorts) -> Sequence[Any]:
    if not ports.search_sources:
        return ()
    try:
        return await ports.search_sources(
            route.search_query,
            zh_query=route.search_query_zh,
            scope=route.search_scope,
            is_medical=route.is_medical,
            sb=ports.supabase(),
        ) or ()
    except Exception as e:
        print(f"[warn] knowledge: search failed: {type(e).__name__}: {e}")
        return ()
