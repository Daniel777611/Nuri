"""The Task/Card orchestration gate, case by case from the spec.

`NURI_Task_Card_Orchestration_Spec_v1` §19 lists twenty cases the backend has
to cover. The ones that are a decision — should a card be created, updated, or
suppressed, and why — live here, because `task_card.decide` is a pure function
and every one of them can be asserted without a model, a database or a server.

The remaining cases (13, 14, 19: response timeout, event failure, wipe) are
about the pipeline rather than the decision and belong with the endpoint.
"""
from __future__ import annotations

import os
import sys

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from backend.nuri_core import task_card as tc  # noqa: E402


def _plan(**overrides) -> tc.PlanCandidate:
    """A plan that satisfies §5.4, so a test can break exactly one thing."""
    base = dict(
        core_goal="让小啊谷早上那一觉睡长一点",
        title="早上第一觉接觉",
        tasks=(tc.PlanTask(
            action="第15分钟进房间轻拍胸口",
            owner="user",
            timing="每天早上8点半",
            completion_criterion="他多睡10分钟或醒来不哭",
            fallback="越拍越清醒就退到只在旁边等",
        ),),
        completion_criteria=("连续三天有一次多睡10分钟",),
        fallback=("接不上就不追求睡久，先保住容易入睡",),
    )
    base.update(overrides)
    return tc.PlanCandidate(**base)


def _ready_state(**overrides) -> tc.OrchestrationState:
    base = dict(
        conversation_stage="PLAN_CONFIRMATION",
        scenario_complexity="personalized_decision",
        core_goal="让小啊谷早上那一觉睡长一点",
        core_goal_confirmed=True,
        decision_facts_sufficient=True,
        plan_candidate=_plan(),
        plan_proposed=True,
        acceptance_strength="explicit",
        acceptance_message_index=8,
    )
    base.update(overrides)
    return tc.OrchestrationState(**base)


# ── acceptance signals (§5.5, §12.2) ─────────────────────────────────────────

@pytest.mark.parametrize("text", [
    "帮我存下来",
    "帮我把这部分存下来",
    "可以，先帮我把这部分存下来",
    "帮我做成任务",
    "提醒我明天联系",
    "给我三个任务",
    "Please save this as a task for me",
    "remind me tomorrow",
])
def test_a_request_to_save_is_the_strongest_signal(text):
    assert tc.acceptance_of(text) == "user_requested"


@pytest.mark.parametrize("text", [
    "就按这个做",
    "那就这样做",
    "可以，那我今晚先试试看这个",
    "let's do that",
    "I'll do that tonight",
])
def test_an_explicit_yes_to_the_plan_counts(text):
    assert tc.acceptance_of(text) == "explicit"


@pytest.mark.parametrize("text", ["嗯", "哦", "好的", "知道了", "谢谢", "ok", "got it"])
def test_politeness_is_weak_and_never_more(text):
    """§20.2, verbatim: NURI had a workable plan, the parent said 「嗯，知道了」,
    and a card appeared. The content may have been fine; the signal was not."""
    assert tc.acceptance_of(text) == "weak"


@pytest.mark.parametrize("text", [
    "先不用做卡",
    "我只是想聊聊",
    "这个方法我做不到",
    "我还没决定",
    "给我三个任务，不过现在先不要生成任务卡",
    "don't create tasks yet",
])
def test_a_decline_anywhere_wins(text):
    assert tc.acceptance_of(text) == "decline"


@pytest.mark.parametrize("text", [
    "给我讲讲这个计划的优缺点",
    "任务卡是什么？",
    "explain the task cards to me",
])
def test_asking_about_a_plan_is_not_asking_for_one(text):
    assert tc.acceptance_of(text) != "user_requested"


# ── §19.1-3: nothing to create ───────────────────────────────────────────────

def test_a_simple_knowledge_answer_creates_nothing():
    """§19.1. The reason matters as much as the action: 'not useful here' and
    'we did not get far enough' are different bugs when one of them is wrong."""
    state = _ready_state(scenario_complexity="simple_knowledge")
    decision = tc.decide(state)
    assert decision.action == "none"
    assert decision.reason == "not_useful_for_this_scenario"


def test_one_answered_clarifying_question_creates_nothing():
    """§19.2, and §20.1: 「你一天挤几次？」「三次。」 was enough for the old
    pipeline to write a card about pumping three times a day."""
    state = tc.OrchestrationState(
        conversation_stage="CLARIFICATION",
        scenario_complexity="multi_topic_complex",
        core_goal="夜班以后挤奶和托婴怎么办",
        decision_facts={"pump_per_day": "3"},
    )
    decision = tc.decide(state)
    assert decision.action == "none"
    assert decision.reason == "goal_not_confirmed"
    assert decision.readiness.ready is False


def test_a_finished_plan_nobody_agreed_to_creates_nothing():
    """§19.3. Showing a plan is not the parent accepting it (§6, PLAN_PROPOSAL
    row: 把方案展示视为用户接受 is the forbidden behaviour)."""
    decision = tc.decide(_ready_state(acceptance_strength="none"))
    assert decision.action == "none"
    assert decision.reason == "plan_not_confirmed"


# ── §19.4-6: acceptance ──────────────────────────────────────────────────────

def test_an_explicit_request_with_everything_known_creates_one_card():
    decision = tc.decide(_ready_state(acceptance_strength="user_requested"))
    assert decision.action == "create"
    assert decision.reason == "user_confirmed_plan"
    assert decision.readiness.ready is True
    assert decision.readiness.as_event() == {
        "core_goal_confirmed": True,
        "decision_facts_sufficient": True,
        "plan_proposed": True,
        "user_acceptance_detected": True,
        "no_blocking_safety_issue": True,
    }


def test_weak_acceptance_alone_does_not_create():
    """§19.5. Suppressed with its own reason so a report can separate 'too
    early' from 'never got there'."""
    decision = tc.decide(_ready_state(acceptance_strength="weak"))
    assert decision.action == "none"
    assert decision.reason == "weak_acceptance_only"


def test_a_decline_stops_the_flow_and_says_so():
    """§19.6. And the state goes back to waiting rather than staying one
    particle away from a card."""
    state = _ready_state().with_turn("先不用做卡", 9)
    assert state.acceptance_strength == "none"
    assert state.plan_confirmed is False
    decision = tc.decide(state.with_turn("先不用做卡", 9))
    assert decision.action == "none"


def test_a_decline_read_from_the_turn_is_reported_as_declined():
    state = tc.OrchestrationState(
        **{**_ready_state().__dict__, "acceptance_strength": "decline"}
    )
    decision = tc.decide(state)
    assert decision.reason == "user_declined"


# ── §19.7-8: update, don't multiply ──────────────────────────────────────────

def test_a_new_constraint_updates_the_candidate_rather_than_creating():
    """§19.7. A constraint arriving mid-plan is the plan changing, not a second
    goal appearing."""
    state = _ready_state(plan_proposed=False)
    decision = tc.decide(state)
    assert decision.action == "propose"


def test_changing_the_time_of_an_existing_card_updates_that_card():
    """§19.8, §8.1. Same goal id, so the same card takes the change."""
    goal_id = tc.goal_id_for("conv-1", "让小啊谷早上那一觉睡长一点")
    existing = [tc.ExistingCard(
        card_id="card-1", goal_id=goal_id,
        core_goal="让小啊谷早上那一觉睡长一点", status="ACTIVE",
        owners=("user",), task_actions=("第15分钟进房间轻拍胸口",),
    )]
    decision = tc.decide(_ready_state(), existing, conversation_id="conv-1")
    assert decision.action == "update"
    assert decision.card_id == "card-1"
    assert decision.dedupe_result == "EXACT_MATCH"


def test_the_same_goal_in_different_words_keeps_one_goal_id():
    """The handoff's requirement: 同一用户目标必须复用同一个ID. Without this the
    fragmentation metric counts a rephrasing as a second goal."""
    first = tc.goal_id_for("conv-1", "让小啊谷早上那一觉睡长一点")
    second = tc.goal_id_for("conv-1", "帮小啊谷把早上那一觉睡长一点")
    assert first == second
    assert tc.goal_id_for("conv-2", "让小啊谷早上那一觉睡长一点") != first


# ── §19.9-12: duplicates, topics, integration ────────────────────────────────

def test_a_plan_that_is_one_step_of_an_existing_card_is_a_merge():
    """§9's fragmentation case: the new 'card' is a step the existing card
    already contains, which is how one goal becomes four cards."""
    existing = [tc.ExistingCard(
        card_id="card-1", goal_id="goal-other",
        core_goal="夜班第一周的挤奶安排", status="ACTIVE", owners=("user",),
        task_actions=("上班前挤一次奶", "休息时争取挤一次"),
    )]
    plan = _plan(
        core_goal="上班前挤一次奶",
        tasks=(tc.PlanTask(
            action="上班前挤一次奶", owner="user", timing="每天上班前",
            completion_criterion="出门前完成一次",
        ),),
    )
    decision = tc.decide(
        _ready_state(core_goal=plan.core_goal, plan_candidate=plan),
        existing, conversation_id="conv-1",
    )
    assert decision.action == "merge"
    assert decision.card_id == "card-1"


def test_an_untouched_topic_cannot_get_a_card_first():
    """§7. 托婴 has not been chosen as the active topic, so it does not get a
    card no matter how confident the plan looks."""
    state = _ready_state(
        scenario_complexity="multi_topic_complex",
        major_constraint_known=True,
        user_support_preference_known=True,
        active_topic=None,
        topic_priority_confirmed=False,
    )
    decision = tc.decide(state)
    assert decision.action == "none"
    assert decision.reason == "insufficient_information"
    assert "active_topic_confirmed" in decision.readiness.missing


def test_the_confirmed_active_topic_does_get_one():
    """§20.3, the Good example: one card for 夜班第一周挤奶安排, 托婴 left as a
    remaining topic."""
    state = _ready_state(
        scenario_complexity="multi_topic_complex",
        major_constraint_known=True,
        user_support_preference_known=True,
        active_topic="pumping",
        remaining_topics=("daycare",),
        topic_priority_confirmed=True,
        acceptance_strength="user_requested",
    )
    decision = tc.decide(state, conversation_id="conv-1")
    assert decision.action == "create"


def test_a_complex_scenario_needs_the_constraint_and_the_support_preference():
    """§5.1's extra three. 「我快被挤奶、夜班和托婴弄炸了」 has no single goal to
    confirm until someone picks one, and no realistic plan until the shift
    pattern is known."""
    state = _ready_state(
        scenario_complexity="emotional_relational",
        active_topic="pumping",
        topic_priority_confirmed=True,
    )
    decision = tc.decide(state)
    assert decision.action == "none"
    assert decision.reason == "insufficient_information"
    assert "major_constraint_known" in decision.readiness.missing
    assert "user_support_preference_known" in decision.readiness.missing


def test_a_truly_independent_goal_is_allowed_its_own_card():
    """§8.2, and the spec's own example: 申请WIC and 修复伴侣夜间分工 do not
    depend on each other."""
    existing = [tc.ExistingCard(
        card_id="card-1", goal_id=tc.goal_id_for("conv-1", "申请WIC"),
        core_goal="申请WIC", status="ACTIVE", owners=("user",),
        task_actions=("打电话给WIC办公室",),
    )]
    plan = _plan(
        core_goal="和伴侣重新分配夜间起夜",
        tasks=(tc.PlanTask(
            action="今晚和伴侣定下前半夜谁起", owner="partner",
            timing="今晚睡前", completion_criterion="两人说好了具体时段",
        ),),
    )
    decision = tc.decide(
        _ready_state(core_goal=plan.core_goal, plan_candidate=plan,
                     acceptance_strength="user_requested"),
        existing, conversation_id="conv-1",
    )
    assert decision.action == "create"
    assert decision.dedupe_result == "NO_MATCH"


def test_a_finished_card_does_not_block_the_next_plan():
    """§8.2: 原Card已经完成或取消，用户开启新计划."""
    existing = [tc.ExistingCard(
        card_id="card-1", goal_id=tc.goal_id_for("conv-1", "让小啊谷早上那一觉睡长一点"),
        core_goal="让小啊谷早上那一觉睡长一点", status="COMPLETED",
    )]
    decision = tc.decide(
        _ready_state(acceptance_strength="user_requested"), existing,
        conversation_id="conv-1",
    )
    assert decision.action == "create"


def test_the_same_goal_for_a_different_person_asks_instead_of_guessing():
    """POSSIBLE_CONFLICT (§9): same goal, different owner. Automatic action is
    suspended and the parent is asked, rather than one silently overwriting the
    other."""
    goal_id = tc.goal_id_for("conv-1", "让小啊谷早上那一觉睡长一点")
    existing = [tc.ExistingCard(
        card_id="card-1", goal_id=goal_id,
        core_goal="让小啊谷早上那一觉睡长一点", status="ACTIVE",
        owners=("partner",), task_actions=("第15分钟进房间轻拍胸口",),
    )]
    plan = _plan(tasks=(tc.PlanTask(
        action="第15分钟进房间轻拍胸口", owner="caregiver", timing="每天早上8点半",
        completion_criterion="他多睡10分钟",
    ),))
    decision = tc.decide(
        _ready_state(plan_candidate=plan), existing, conversation_id="conv-1",
    )
    assert decision.action == "propose"
    assert decision.dedupe_result == "POSSIBLE_CONFLICT"


# ── §19.15-16: safety outranks the flow ──────────────────────────────────────

@pytest.mark.parametrize("safety_state", ["urgent", "crisis", "emergency", "caregiver_harm"])
def test_a_safety_turn_never_runs_the_card_flow(safety_state):
    """§12: a card must never be a step on the way to calling for help, and an
    emergency turn must not carry a routine plan alongside the handoff."""
    decision = tc.decide(_ready_state(
        safety_state=safety_state, acceptance_strength="user_requested",
    ))
    assert decision.action == "none"
    assert decision.reason == "safety_flow_active"


def test_watching_a_situation_is_not_being_in_one():
    """`monitor` must not suppress: a turn that merely mentioned a fever is not
    a safety flow, and suppressing every such card is its own failure."""
    decision = tc.decide(_ready_state(
        safety_state="monitor", acceptance_strength="user_requested",
    ))
    assert decision.action == "create"


# ── §5.4: what counts as a plan ──────────────────────────────────────────────

@pytest.mark.parametrize("broken,missing", [
    ({"tasks": ()}, "first_step"),
    ({"tasks": (tc.PlanTask(action="建立规律", owner="user", timing="每天",
                            completion_criterion="睡得好"),)},
     "first_step_is_directional"),
    ({"tasks": (tc.PlanTask(action="第15分钟进房间轻拍", owner="user"),),
      "completion_criteria": ()}, "timing_or_trigger"),
    ({"tasks": (tc.PlanTask(action="第15分钟进房间轻拍", owner="user",
                            timing="每天早上"),),
      "completion_criteria": ()}, "completion_criterion"),
])
def test_a_direction_is_not_a_plan(broken, missing):
    """§5.4: 「建立规律」「多沟通」「寻求支持」 cannot be saved, because none of
    them tells a parent what to do tonight."""
    assert missing in tc.plan_gaps(_plan(**broken))


def test_an_incomplete_plan_is_proposed_rather_than_saved():
    """The gap does not become another round of questions: everything needed to
    say something concrete is known, so the reply puts the plan up and the
    missing part is what it asks about."""
    plan = _plan(tasks=(tc.PlanTask(action="第15分钟进房间轻拍", owner="user"),),
                 completion_criteria=())
    decision = tc.decide(_ready_state(plan_candidate=plan))
    assert decision.action == "propose"
    assert decision.reason.startswith("plan_")


# ── §15: idempotency ─────────────────────────────────────────────────────────

def test_one_confirmed_plan_retried_is_one_key():
    """§19.9. A retry after a timeout must resolve to the same write."""
    plan = _plan()
    first = tc.idempotency_key("conv-1", plan, "create")
    assert first == tc.idempotency_key("conv-1", plan, "create")
    # A plan the parent agreed to again after an edit is a different write.
    assert first != tc.idempotency_key("conv-1", _plan(version=2), "create")
    assert first != tc.idempotency_key("conv-2", plan, "create")
    assert first != tc.idempotency_key("conv-1", plan, "update")


# ── the state carries across turns ───────────────────────────────────────────

def test_acceptance_records_which_message_it_came_from():
    """§16: a reviewer disagreeing with 'the user accepted' has to be able to
    go and read the message it was read from."""
    state = tc.OrchestrationState().with_turn("帮我存下来", 7)
    assert state.acceptance_strength == "user_requested"
    assert state.acceptance_message_index == 7
    assert state.plan_confirmed is True


def test_a_neutral_turn_leaves_an_earlier_acceptance_alone():
    state = tc.OrchestrationState().with_turn("就按这个做", 5).with_turn(
        "他昨天午睡是一点半", 6,
    )
    assert state.acceptance_strength == "explicit"
    assert state.acceptance_message_index == 5
