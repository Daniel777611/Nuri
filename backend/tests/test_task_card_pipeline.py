"""The orchestration, wired: state that survives a turn, and the event envelope.

`test_task_card_orchestration.py` covers the decision. This covers everything
around it — the round trip through storage, the mapping from the safety layer's
verdict, the event payload both readers have to parse, and the three §19 cases
that are about the pipeline rather than the gate: a retried create, a failed
write that must not claim success, and a state that cannot be read.
"""
from __future__ import annotations

import os
import sys

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from backend import main  # noqa: E402
from backend.nuri_core import task_card as tc  # noqa: E402
from backend.nuri_core import task_card_store as store  # noqa: E402


def _plan() -> tc.PlanCandidate:
    return tc.PlanCandidate(
        core_goal="让小啊谷早上那一觉睡长一点",
        title="早上第一觉接觉",
        tasks=(tc.PlanTask(
            action="第15分钟进房间轻拍胸口", owner="user", timing="每天早上8点半",
            completion_criterion="他多睡10分钟或醒来不哭",
            fallback="越拍越清醒就退到旁边等",
        ),),
        completion_criteria=("连续三天有一次多睡10分钟",),
    )


def _state(**overrides) -> tc.OrchestrationState:
    base = dict(
        conversation_stage="PLAN_CONFIRMATION",
        core_goal="让小啊谷早上那一觉睡长一点",
        core_goal_confirmed=True,
        decision_facts_sufficient=True,
        plan_candidate=_plan(),
        plan_proposed=True,
        acceptance_strength="user_requested",
        acceptance_message_index=8,
    )
    base.update(overrides)
    return tc.OrchestrationState(**base)


# ── the model's half of the state ────────────────────────────────────────────

def test_the_model_supplies_the_reading_and_never_the_acceptance():
    """A model asked whether the parent agreed will find agreement. So the
    orchestration block carries what the turn was *about*, and 「嗯」 is
    classified from the parent's own words by `acceptance_of`."""
    state = tc.from_model(tc.OrchestrationState(), {
        "stage": "PLAN_PROPOSAL",
        "complexity": "multi_topic_complex",
        "core_goal": "夜班第一周的挤奶安排",
        "core_goal_confirmed": True,
        "decision_facts_sufficient": True,
        # Not a field. If it were, this is where a card would come from.
        "user_acceptance_detected": True,
        "acceptance_strength": "user_requested",
    })
    assert state.conversation_stage == "PLAN_PROPOSAL"
    assert state.core_goal_confirmed is True
    assert state.acceptance_strength == "none"
    assert state.user_acceptance_detected is False


def test_a_turn_that_says_nothing_does_not_unset_what_was_established():
    """Round one's re-litigation: a confirmed goal came back unconfirmed two
    turns later because the model was busy answering a side question."""
    established = _state(acceptance_strength="none")
    after = tc.from_model(established, {"stage": "CLARIFICATION"})
    assert after.core_goal_confirmed is True
    assert after.core_goal == established.core_goal
    assert after.plan_candidate == established.plan_candidate


def test_a_malformed_orchestration_block_costs_the_card_not_the_turn():
    for junk in ({}, {"stage": "NOPE", "complexity": "???"}, {"plan": "yes"}):
        state = tc.from_model(_state(), junk)
        assert state.conversation_stage in tc.STAGES
        assert state.scenario_complexity in tc.COMPLEXITIES


def test_the_plan_version_moves_only_when_the_plan_does():
    """Half the idempotency key. A plan restated in the same words must not
    become a second write; an edited plan must not collide with the original."""
    first = tc.from_model(tc.OrchestrationState(), {"plan": {
        "core_goal": "让小啊谷早上那一觉睡长一点", "title": "接觉",
        "tasks": [{"action": "第15分钟轻拍", "owner": "user", "timing": "早上",
                   "trigger": "", "completion_criterion": "多睡10分钟",
                   "fallback": ""}],
        "completion_criteria": [], "fallback": [], "review_at": "",
    }})
    same = tc.from_model(first, {"plan": {
        "core_goal": "让小啊谷早上那一觉睡长一点", "title": "接觉",
        "tasks": [{"action": "第15分钟轻拍", "owner": "user", "timing": "早上",
                   "trigger": "", "completion_criterion": "多睡10分钟",
                   "fallback": ""}],
        "completion_criteria": [], "fallback": [], "review_at": "",
    }})
    assert same.plan_candidate.version == first.plan_candidate.version
    changed = tc.from_model(same, {"plan": {
        "core_goal": "让小啊谷早上那一觉睡长一点", "title": "接觉",
        "tasks": [{"action": "第12分钟轻拍", "owner": "user", "timing": "早上",
                   "trigger": "", "completion_criterion": "多睡10分钟",
                   "fallback": ""}],
        "completion_criteria": [], "fallback": [], "review_at": "",
    }})
    assert changed.plan_candidate.version == first.plan_candidate.version + 1


# ── storage round trip ───────────────────────────────────────────────────────

def test_the_state_survives_serialisation():
    state = _state(remaining_topics=("daycare", "night_shift"))
    assert store.state_from_json(store.state_to_json(state)) == state


@pytest.mark.parametrize("junk", [None, "", "not json", 7, {"stage": 12}])
def test_an_unreadable_state_starts_again_rather_than_failing(junk):
    """§19.20's spirit: a build that cannot read its own state must degrade to
    'we have not got there yet', which costs a confirmation round. A card is
    never worth a failed turn."""
    state = store.state_from_json(junk)
    assert isinstance(state, tc.OrchestrationState)
    assert state.conversation_stage == "DISCOVERY"
    assert tc.decide(state).action == "none"


# ── the event both readers parse ─────────────────────────────────────────────

def test_a_create_event_carries_what_the_runner_asks_for():
    """The handoff's minimum: event_type, event_id, goal_id, message_index,
    title, content_summary, replaces_event_id."""
    decision = tc.decide(_state(), conversation_id="conv-1")
    assert decision.action == "create"
    event = store.event_payload(
        decision, _plan(), card_id="card-1", message_index=9,
    )
    assert event["event_type"] == "card_created"
    assert event["spec_event_type"] == "task_card.create"
    assert event["event_id"].startswith("evt_")
    assert event["goal_id"] == decision.goal_id
    assert event["message_index"] == 9
    assert event["title"] == "早上第一觉接觉"
    assert event["content_summary"]
    assert event["replaces_event_id"] is None
    # And the spec's half, which is what makes a wrong decision diagnosable.
    assert event["trigger_reason"] == "user_confirmed_plan"
    assert event["dedupe_result"] == "NO_MATCH"
    assert event["readiness"]["user_acceptance_detected"] is True


def test_an_update_event_points_at_what_it_replaces():
    goal_id = tc.goal_id_for("conv-1", "让小啊谷早上那一觉睡长一点")
    existing = [tc.ExistingCard(
        card_id="card-1", goal_id=goal_id,
        core_goal="让小啊谷早上那一觉睡长一点", status="ACTIVE",
        owners=("user",), task_actions=("第15分钟进房间轻拍胸口",),
    )]
    decision = tc.decide(_state(), existing, conversation_id="conv-1")
    event = store.event_payload(
        decision, _plan(), card_id="card-1", message_index=11,
        replaces_event_id="evt_first",
    )
    assert event["event_type"] == "card_updated"
    assert event["replaces_event_id"] == "evt_first"
    assert event["goal_id"] == goal_id


def test_a_suppression_is_an_event_too():
    """The row that could never be diagnosed: `task_created=false` with no
    reason attached."""
    decision = tc.decide(_state(acceptance_strength="weak"))
    event = store.event_payload(decision, _plan(), card_id=None, message_index=5)
    assert event["spec_event_type"] == "task_card.suppressed"
    assert event["trigger_reason"] == "weak_acceptance_only"
    assert event["card_id"] is None


def test_a_write_that_failed_does_not_report_success():
    """§11.3: NURI must never claim a card exists when the write failed."""
    decision = tc.decide(_state(), conversation_id="conv-1")
    event = store.event_payload(
        decision, _plan(), card_id=None, message_index=9, status="failed",
    )
    assert event["status"] == "failed"
    assert event["card_id"] is None


# ── the safety layer's verdict, translated ───────────────────────────────────

class _Evidence:
    def __init__(self, tier):
        self.risk_tier = tier


class _Plan:
    def __init__(self, allow):
        self.allow_task_cards = allow


class _RC:
    def __init__(self, tier="none", allow=True):
        self.evidence = _Evidence(tier)
        self.plan = _Plan(allow)


@pytest.mark.parametrize("tier,expected", [
    ("none", "none"),
    ("elevated", "monitor"),
    ("medical", "suggest_professional"),
    ("crisis", "crisis"),
    ("emergency", "emergency"),
    ("caregiver_harm", "caregiver_harm"),
])
def test_the_risk_tier_becomes_a_safety_state(tier, expected):
    assert main._safety_state(_RC(tier)) == expected


def test_the_safety_layers_own_veto_outranks_the_tier():
    """`allow_task_cards=False` is the safety layer's decision about this turn.
    The card flow does not get to negotiate with it (§12)."""
    assert main._safety_state(_RC("none", allow=False)) == "urgent"
    assert tc.decide(_state(safety_state="urgent")).reason == "safety_flow_active"


def test_no_reply_context_is_not_an_emergency():
    """A turn with no safety verdict at all — the scripted path, or a build
    without the four-model pipeline — must not be read as unsafe."""
    assert main._safety_state(None) == "none"


# ── the envelope ─────────────────────────────────────────────────────────────

def test_the_aggregate_keys_still_mean_what_they_meant():
    """Months of stored results and the external runner read these four. A card
    that now exists is `task_created`; a plan put in front of the parent without
    being saved is `task_proposed` and nothing more."""
    transition = {
        "kind": "task_card", "action": "create", "card_id": "card-1",
        "task_ids": ["task-1"], "tasks": [{"action": "第15分钟轻拍"}],
    }
    events = main._turn_events(None, transition, {}, {"spec_event_type": "task_card.create"})
    assert events["task_created"] is True
    assert events["task_proposed"] is True
    assert events["card_ids"] == ["card-1"]
    assert events["task_ids"] == ["task-1"]
    assert events["task_proposal_count"] == 1
    assert events["task_card_events"][0]["spec_event_type"] == "task_card.create"


def test_a_proposed_plan_is_proposed_and_not_created():
    events = main._turn_events(
        None, None, {}, {"spec_event_type": "task_card.proposed"},
    )
    assert events["task_created"] is False
    assert events["task_proposed"] is True
    assert events["card_ids"] == []


def test_a_turn_with_no_card_decision_still_reports_every_key():
    events = main._turn_events(None, None, {}, None)
    for key in ("task_created", "task_proposed", "task_ids", "task_proposal_count",
                "card_ids", "task_card_events"):
        assert key in events
    assert events["task_card_events"] == []


def test_a_feed_card_and_a_task_card_are_both_card_ids():
    """`card_ids` predates the task card and means "cards this turn touched".
    An opened feed card and a saved plan are both that."""
    events = main._turn_events(
        None, {"kind": "task_card", "card_id": "card-1"},
        {"source_card_id": "feed-9"}, None,
    )
    assert events["card_ids"] == ["feed-9", "card-1"]


# ── idempotency, at the layer that writes ────────────────────────────────────

def test_the_row_a_confirmed_plan_becomes_carries_its_key():
    decision = tc.decide(_state(), conversation_id="conv-1")
    row = store.card_payload(
        decision, _plan(), user_id="user-1", session_id="conv-1",
        message_id="msg-9", message_index=8,
    )
    assert row["idempotency_key"] == tc.idempotency_key("conv-1", _plan(), "create")
    assert row["goal_id"] == decision.goal_id
    assert row["confirmation_message_index"] == 8
    assert row["status"] == "ACTIVE"
    # Inference and instruction stay apart (§10).
    assert row["assumptions"] == [] and row["safety_notes"] == []


def test_the_cards_tasks_reach_the_tasks_tab():
    """A card the parent cannot tick off is a plan the product forgot to give
    them. Same id derivation as any other suggestion, so a client saving the
    same task is a no-op rather than a second row."""
    drafts = store.tasks_for_card(_plan(), "card-1", "msg-9")
    assert len(drafts) == 1
    assert drafts[0]["source_message_id"] == "msg-9"
    assert drafts[0]["suggestion_index"] == 0
    assert drafts[0]["title"] == "第15分钟进房间轻拍胸口"
    row, is_suggestion = main._task_row(
        main.TaskCreate(**{k: v for k, v in drafts[0].items() if k != "card_id"}),
        "user-1",
    )
    assert is_suggestion is True
    assert row["id"] == main._task_row(
        main.TaskCreate(**{k: v for k, v in drafts[0].items() if k != "card_id"}),
        "user-1",
    )[0]["id"]
