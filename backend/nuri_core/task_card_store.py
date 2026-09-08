"""Persistence for the Task/Card orchestration: state, cards, events.

`task_card.py` decides; this writes. Split because the decision is the part
worth testing and reviewing, and a decision that can only be exercised through
Supabase is a decision nobody re-reads.

Three things live here:

    state    one JSON blob per conversation on `chat_sessions`. A card is
             created when a *plan* has been agreed to, and a plan is agreed to
             across turns — the goal in one message, the constraint in another,
             the yes two turns later. Reading one turn is what produced a card
             for pumping three times a day out of 「你一天挤几次？」「三次。」
    cards    `nuri_task_cards`, keyed for idempotency on
             conversation + plan version + action, so a retry after a timeout
             cannot become a second card (spec §15)
    events   `nuri_task_card_events`, one row per decision *including the ones
             that wrote nothing* — the log the evaluation runner reads

Everything degrades. A missing migration, a dropped connection or a malformed
row costs the turn its card, never its reply: `load_state` returns the default
state, `open_cards` returns nothing, and `record` returns the event payload it
would have written so the response envelope stays the same shape. That is the
same contract `state_store` and `outcome_store` already keep.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict
from typing import Any, Optional, Sequence

import anyio

from backend import runtime
from backend.nuri_core import task_card as tc

STATE_COLUMN = "orchestration_state"
CARD_TABLE = "nuri_task_cards"
EVENT_TABLE = "nuri_task_card_events"

#: Warn once per process rather than per turn: a missing migration would
#: otherwise print the same line for every message in every session.
_warned: set[str] = set()


def _warn(scope: str, detail: str) -> None:
    if scope in _warned:
        return
    _warned.add(scope)
    print(
        f"[warn] task_card {scope}: {detail}; run "
        "supabase/migrations/20260907010000_task_card_orchestration.sql. "
        "Further failures in this scope are silent."
    )


# ── state ────────────────────────────────────────────────────────────────────

def state_to_json(state: tc.OrchestrationState) -> dict:
    """Flatten for storage. Dataclasses all the way down, so `asdict` is the
    whole serializer — but tuples become lists, which is what jsonb wants."""
    raw = asdict(state)
    raw["remaining_topics"] = list(state.remaining_topics)
    raw["missing_decision_facts"] = list(state.missing_decision_facts)
    raw["decision_facts"] = dict(state.decision_facts)
    if state.plan_candidate is not None:
        plan = asdict(state.plan_candidate)
        plan["tasks"] = [asdict(t) for t in state.plan_candidate.tasks]
        plan["completion_criteria"] = list(state.plan_candidate.completion_criteria)
        plan["fallback"] = list(state.plan_candidate.fallback)
        raw["plan_candidate"] = plan
    return raw


def state_from_json(raw: Any) -> tc.OrchestrationState:
    """Rebuild, tolerating anything. A conversation whose stored state cannot
    be read starts again from DISCOVERY, which costs a confirmation round —
    the alternative is a failed turn, and a card is never worth that."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return tc.OrchestrationState()
    if not isinstance(raw, dict):
        return tc.OrchestrationState()
    plan = None
    plan_raw = raw.get("plan_candidate")
    if isinstance(plan_raw, dict):
        try:
            plan = tc.PlanCandidate(
                core_goal=str(plan_raw.get("core_goal") or ""),
                title=str(plan_raw.get("title") or ""),
                tasks=tuple(
                    tc.PlanTask(**{
                        k: str(t.get(k) or ("user" if k == "owner" else ""))
                        for k in (
                            "action", "owner", "timing", "trigger",
                            "completion_criterion", "fallback",
                        )
                    })
                    for t in (plan_raw.get("tasks") or []) if isinstance(t, dict)
                ),
                completion_criteria=tuple(plan_raw.get("completion_criteria") or ()),
                fallback=tuple(plan_raw.get("fallback") or ()),
                review_at=str(plan_raw.get("review_at") or ""),
                version=int(plan_raw.get("version") or 1),
            )
        except Exception:
            plan = None
    fields = {
        "conversation_stage": str(raw.get("conversation_stage") or "DISCOVERY"),
        "scenario_complexity": str(
            raw.get("scenario_complexity") or "personalized_decision"
        ),
        "active_topic": raw.get("active_topic") or None,
        "remaining_topics": tuple(raw.get("remaining_topics") or ()),
        "topic_priority_confirmed": bool(raw.get("topic_priority_confirmed")),
        "core_goal": raw.get("core_goal") or None,
        "core_goal_confirmed": bool(raw.get("core_goal_confirmed")),
        "decision_facts": dict(raw.get("decision_facts") or {}),
        "missing_decision_facts": tuple(raw.get("missing_decision_facts") or ()),
        "decision_facts_sufficient": bool(raw.get("decision_facts_sufficient")),
        "major_constraint_known": bool(raw.get("major_constraint_known")),
        "user_support_preference_known": bool(raw.get("user_support_preference_known")),
        "emotional_depth": str(raw.get("emotional_depth") or "not_applicable"),
        "plan_candidate": plan,
        "plan_proposed": bool(raw.get("plan_proposed")),
        "plan_confirmed": bool(raw.get("plan_confirmed")),
        "acceptance_strength": str(raw.get("acceptance_strength") or "none"),
        "acceptance_message_index": int(raw.get("acceptance_message_index") or -1),
        "safety_state": str(raw.get("safety_state") or "none"),
        "existing_card_id": raw.get("existing_card_id") or None,
    }
    if fields["scenario_complexity"] not in tc.COMPLEXITIES:
        fields["scenario_complexity"] = "personalized_decision"
    if fields["acceptance_strength"] not in tc.ACCEPTANCE:
        fields["acceptance_strength"] = "none"
    return tc.OrchestrationState(**fields)


async def load_state(session_id: str) -> tc.OrchestrationState:
    sb = runtime.get_supabase()
    if not sb or not session_id:
        return tc.OrchestrationState()
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("chat_sessions").select(STATE_COLUMN)
            .eq("id", session_id).maybe_single().execute()
        )
        row = (res.data if res else None) or {}
    except Exception as e:
        _warn("load_state", f"{type(e).__name__}: {e}")
        return tc.OrchestrationState()
    return state_from_json(row.get(STATE_COLUMN))


async def save_state(session_id: str, state: tc.OrchestrationState) -> None:
    sb = runtime.get_supabase()
    if not sb or not session_id:
        return
    payload = state_to_json(state)
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("chat_sessions")
            .update({STATE_COLUMN: payload}).eq("id", session_id).execute()
        )
    except Exception as e:
        _warn("save_state", f"{type(e).__name__}: {e}")


# ── cards ────────────────────────────────────────────────────────────────────

def _card_from_row(row: dict) -> tc.ExistingCard:
    tasks = row.get("tasks") or []
    return tc.ExistingCard(
        card_id=str(row.get("id") or ""),
        goal_id=str(row.get("goal_id") or ""),
        core_goal=str(row.get("core_goal") or ""),
        status=str(row.get("status") or "ACTIVE"),
        owners=tuple(
            str(t.get("owner") or "user") for t in tasks if isinstance(t, dict)
        ),
        time_window=str(row.get("review_at") or ""),
        task_actions=tuple(
            str(t.get("action") or "") for t in tasks if isinstance(t, dict)
        ),
    )


async def open_cards(user_id: str, session_id: str) -> list[tc.ExistingCard]:
    """Everything a duplicate check has to look at (§9).

    Scoped to the conversation rather than the account: `goal_id` is only
    stable inside one conversation, and a parent's card from a different
    conversation three weeks ago is not what "duplicate" means here.
    """
    sb = runtime.get_supabase()
    if not sb or not (user_id and session_id):
        return []
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table(CARD_TABLE)
            .select("id,goal_id,core_goal,status,tasks,review_at")
            .eq("user_id", user_id).eq("session_id", session_id)
            .in_("status", list(tc.OPEN_STATES))
            .order("updated_at", desc=True).limit(20).execute()
        )
        rows = (res.data if res else None) or []
    except Exception as e:
        _warn("open_cards", f"{type(e).__name__}: {e}")
        return []
    return [_card_from_row(row) for row in rows if isinstance(row, dict)]


def card_payload(
    decision: tc.Decision,
    plan: tc.PlanCandidate,
    *,
    user_id: str,
    session_id: str,
    message_id: str,
    message_index: int,
) -> dict:
    """The row a confirmed plan becomes (§10).

    `assumptions` and `safety_notes` are written empty rather than omitted: the
    spec requires a card to keep inference and instruction apart, and a column
    that is sometimes absent is one the client has to guess about.
    """
    return {
        "user_id": user_id,
        "session_id": session_id,
        "goal_id": decision.goal_id,
        "core_goal": plan.core_goal,
        "title": plan.title or plan.core_goal,
        "status": "ACTIVE",
        "tasks": [asdict(t) | {"status": "pending"} for t in plan.tasks],
        "completion_criteria": list(plan.completion_criteria),
        "fallback": list(plan.fallback),
        "review_at": plan.review_at or None,
        "safety_notes": [],
        "assumptions": [],
        "source_message_id": message_id or None,
        "confirmation_message_index": message_index,
        "plan_version": plan.version,
        "idempotency_key": tc.idempotency_key(session_id, plan, decision.action),
        "updated_at": runtime.now(),
    }


async def write_card(
    decision: tc.Decision,
    plan: tc.PlanCandidate,
    *,
    user_id: str,
    session_id: str,
    message_id: str = "",
    message_index: int = 0,
) -> Optional[str]:
    """Create or update, and return the card id.

    An insert that collides on the idempotency key is a retry of a write that
    already happened, so it reads the existing row back rather than raising or
    writing a second card. That is the case the spec calls out by name: create
    succeeded, the response timed out, the client tried again (§15).
    """
    sb = runtime.get_supabase()
    if not sb or not user_id:
        return decision.card_id
    row = card_payload(
        decision, plan, user_id=user_id, session_id=session_id,
        message_id=message_id, message_index=message_index,
    )
    try:
        if decision.action in ("update", "merge") and decision.card_id:
            row.pop("idempotency_key", None)
            row["status"] = "UPDATED"
            await anyio.to_thread.run_sync(
                lambda: sb.table(CARD_TABLE).update(row)
                .eq("id", decision.card_id).eq("user_id", user_id).execute()
            )
            return decision.card_id
        res = await anyio.to_thread.run_sync(
            lambda: sb.table(CARD_TABLE).upsert(
                row, on_conflict="idempotency_key", ignore_duplicates=True,
            ).execute()
        )
        data = (res.data if res else None) or []
        if data and isinstance(data[0], dict) and data[0].get("id"):
            return str(data[0]["id"])
        # Ignored as a duplicate: the row is already there, and its id is what
        # the event has to name.
        existing = await anyio.to_thread.run_sync(
            lambda: sb.table(CARD_TABLE).select("id")
            .eq("idempotency_key", row["idempotency_key"]).maybe_single().execute()
        )
        found = (existing.data if existing else None) or {}
        return str(found.get("id") or "") or None
    except Exception as e:
        _warn("write_card", f"{type(e).__name__}: {e}")
        return None


# ── events ───────────────────────────────────────────────────────────────────

#: Maps an action to the event type the spec names for it (§14). `none` is not
#: absent from this table — a suppression is an event, and the one the graders
#: most often need.
EVENT_TYPE = {
    "create": "task_card.create",
    "update": "task_card.update",
    "merge": "task_card.merge",
    "propose": "task_card.proposed",
    "pause": "task_card.pause",
    "complete": "task_card.complete",
    "cancel": "task_card.cancel",
    "none": "task_card.suppressed",
}

#: The handoff document's `event_type` vocabulary, which is not the spec's.
#: The runner reads `events.task_card_events`, so that field carries its
#: spelling and the stored row carries the spec's; they are the same decision
#: named twice rather than two decisions.
HANDOFF_TYPE = {
    "create": "card_created",
    "update": "card_updated",
    "merge": "card_updated",
}


def event_payload(
    decision: tc.Decision,
    plan: Optional[tc.PlanCandidate],
    *,
    card_id: Optional[str],
    message_index: int,
    replaces_event_id: Optional[str] = None,
    prompt_version: str = "",
    pipeline_version: str = "",
    status: str = "succeeded",
) -> dict:
    """One decision, in the shape both readers expect.

    The handoff asks for `event_type`, `event_id`, `goal_id`, `message_index`,
    `title`, `content_summary` and `replaces_event_id`; the spec asks for
    `trigger_reason`, `readiness` and `dedupe_result`. Both are here, because
    the second set is what makes a wrong decision diagnosable and the first is
    what the runner already parses.
    """
    summary = ""
    if plan is not None:
        parts = [t.action for t in plan.tasks if t.action]
        summary = "；".join(parts[:3])
    return {
        "event_id": "evt_" + uuid.uuid4().hex[:12],
        "event_type": HANDOFF_TYPE.get(decision.action, EVENT_TYPE[decision.action]),
        "spec_event_type": EVENT_TYPE[decision.action],
        "goal_id": decision.goal_id,
        "card_id": card_id,
        "message_index": message_index,
        "title": (plan.title or plan.core_goal) if plan is not None else "",
        "content_summary": summary,
        "replaces_event_id": replaces_event_id,
        "trigger_reason": decision.reason,
        "readiness": decision.readiness.as_event(),
        "dedupe_result": decision.dedupe_result,
        "prompt_version": prompt_version,
        "pipeline_version": pipeline_version,
        "status": status,
    }


async def record(
    event: dict, *, user_id: str, session_id: str,
) -> dict:
    """Persist one event and return it unchanged.

    Returns the payload even when the write fails, so the response envelope
    carries the same decision the turn actually made. A missing event row costs
    an audit trail; a missing envelope field breaks the runner.
    """
    sb = runtime.get_supabase()
    if not sb or not user_id:
        return event
    row = {
        "event_id": None,          # let the database mint the uuid
        "user_id": user_id,
        "conversation_id": session_id,
        "event_type": event.get("spec_event_type") or event.get("event_type"),
        "card_id": event.get("card_id"),
        "goal_id": event.get("goal_id") or None,
        "message_index": event.get("message_index"),
        "title": event.get("title") or None,
        "content_summary": event.get("content_summary") or None,
        "replaces_event_id": event.get("replaces_event_id"),
        "trigger_reason": event.get("trigger_reason") or None,
        "readiness": event.get("readiness") or {},
        "dedupe_result": event.get("dedupe_result") or None,
        "prompt_version": event.get("prompt_version") or None,
        "pipeline_version": event.get("pipeline_version") or None,
        "status": event.get("status") or "succeeded",
    }
    row.pop("event_id")
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table(EVENT_TABLE).insert(row).execute()
        )
        data = (res.data if res else None) or []
        if data and isinstance(data[0], dict) and data[0].get("event_id"):
            # The stored id wins, so `replaces_event_id` on the next turn points
            # at a row that exists.
            event = dict(event, event_id=str(data[0]["event_id"]))
    except Exception as e:
        _warn("record", f"{type(e).__name__}: {e}")
    return event


async def last_event_for_goal(session_id: str, goal_id: str) -> Optional[str]:
    """The event an update supersedes (`replaces_event_id`)."""
    sb = runtime.get_supabase()
    if not sb or not (session_id and goal_id):
        return None
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table(EVENT_TABLE).select("event_id")
            .eq("conversation_id", session_id).eq("goal_id", goal_id)
            .in_("event_type", ["task_card.create", "task_card.update", "task_card.merge"])
            .order("created_at", desc=True).limit(1).execute()
        )
        rows = (res.data if res else None) or []
    except Exception as e:
        _warn("last_event", f"{type(e).__name__}: {e}")
        return None
    return str(rows[0]["event_id"]) if rows and rows[0].get("event_id") else None


def tasks_for_card(
    plan: tc.PlanCandidate, card_id: str, message_id: str,
) -> list[dict]:
    """The plan's tasks in the shape `POST /api/tasks` already accepts.

    A card is the plan; the tasks tab is where a parent actually ticks things
    off, and a card that does not appear there is a plan the product forgot to
    give them. Ids are derived from the card so the same plan saved twice is
    the same rows.
    """
    out = []
    for index, task in enumerate(plan.tasks):
        out.append({
            "title": task.action[:60] or plan.title,
            "description": task.completion_criterion or "",
            "steps": [s for s in (task.trigger, task.fallback) if s],
            "task_type": "care",
            "scope": "week" if "周" in (task.timing or "") else "today",
            "source_message_id": message_id,
            "suggestion_index": index,
            "card_id": card_id,
        })
    return out
