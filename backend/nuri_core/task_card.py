"""4 行动与结果 — Task/Card 编排：一个计划什么时候才配成为一张卡.

Implements `NURI_Task_Card_Orchestration_Spec_v1` (test-calibration baseline)
as data and pure functions. Nothing here does I/O, calls a model, or knows what
Supabase is: the whole point of the spec is that the decision to create a card
must be *auditable*, and a decision you can only reproduce by re-running a
model is not.

What the spec is reacting to is the mechanism this repo actually shipped: a
`suggest_tasks` boolean the reply model set while writing, plus a regex that
recognised 「帮我生成任务」. Both read one turn. So a parent who answered one
clarifying question — 「一天挤三次」 — got a card for pumping three times a day
while nothing about their goal, their night shift, or whether they wanted a
plan at all had been established (spec §20.1). Reading one turn is the bug; a
better regex would not have fixed it.

So the unit of decision here is the conversation, held in `OrchestrationState`,
and creation is gated on five facts that can each be pointed at afterwards:

    task_card_ready = core_goal_confirmed
                      AND decision_facts_sufficient
                      AND plan_proposed
                      AND user_acceptance_detected
                      AND no_blocking_safety_issue

with three more for the complex scenarios (§5.1), because 「我快被挤奶、夜班和
托婴弄炸了」 has no single goal to confirm until someone picks one.

`decide()` never raises and always returns a reason — including for "none",
which is the case the graders could not diagnose before, since a suppressed
card and a card nobody thought of look identical in a log that only records
`task_created=false` (§16).
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass, field, replace
from typing import Mapping, Optional, Sequence

# ── vocabulary ───────────────────────────────────────────────────────────────
# The spec's enums, spelled exactly as it spells them: these strings reach the
# event payload and a test runner compares them literally.

STAGES = (
    "DISCOVERY", "CLARIFICATION", "PRIORITIZATION", "PLAN_PROPOSAL",
    "PLAN_CONFIRMATION", "TASK_CARD_READY", "FOLLOW_UP",
)

CARD_STATES = (
    "NO_CANDIDATE", "PLAN_CANDIDATE", "AWAITING_INFORMATION",
    "AWAITING_CONFIRMATION", "READY_TO_CREATE", "ACTIVE", "UPDATED",
    "COMPLETED", "PAUSED", "CANCELLED", "ERROR",
)

#: Which existing cards a duplicate check has to look at. A cancelled card is
#: deliberately not here — §8.2 says a finished or abandoned plan is exactly
#: when a new one is allowed.
OPEN_STATES = ("ACTIVE", "UPDATED", "PAUSED", "READY_TO_CREATE")

ACCEPTANCE = ("none", "weak", "explicit", "user_requested")

ACTIONS = (
    "none", "propose", "create", "update", "merge", "pause", "complete",
    "cancel",
)

SUPPRESS_REASONS = (
    "goal_not_confirmed", "insufficient_information", "plan_not_confirmed",
    "weak_acceptance_only", "duplicate_existing_card", "user_declined",
    "safety_flow_active", "not_useful_for_this_scenario",
)

COMPLEXITIES = (
    "simple_knowledge", "personalized_decision", "emotional_relational",
    "multi_topic_complex", "safety_sensitive",
)

#: Complexity classes that need the three extra facts before a card is allowed
#: (§5.1). Both are cases where "the goal" is genuinely ambiguous until the
#: parent chooses, not cases where more background would merely be nice.
NEEDS_CONSTRAINTS = ("emotional_relational", "multi_topic_complex")

#: Safety states that stop the card flow outright. `monitor` does not: watching
#: a situation is not the same as being in one, and suppressing every card for
#: a turn that merely mentioned a fever would be its own failure (§12, §15).
BLOCKING_SAFETY = ("urgent", "crisis", "emergency", "caregiver_harm")


# ── acceptance ───────────────────────────────────────────────────────────────
# §5.5. Four levels, because the two failures are opposite: creating on 「嗯」,
# and refusing to create after 「就按这个做，帮我存下来」.

_REQUEST = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"(?:请|請|帮我|幫我|麻烦|麻煩|可以|能不能|给我|給我|替我|为我|為我).{0,12}"
    r"(?:生成|创建|創建|制定|安排|布置|列出|列成|列为|列為|整理成|转成|轉成|转为|轉為|变成|變成|做成|加入|添加|存|保存|记下|記下).{0,10}"
    r"(?:任[务務](?:卡)?|计[划劃](?:卡)?|行[动動]清[单單]|待[办辦])",
    r"(?:生成|创建|創建|制定|安排|布置|列出|列成|列为|列為|整理成|转成|轉成|转为|轉為|变成|變成|做成|加入|添加).{0,8}"
    r"(?:任[务務](?:卡)?|计[划劃](?:卡)?|行[动動]清[单單]|待[办辦])",
    r"(?:给|給).{0,6}(?:我|我们|我們)?.{0,6}(?:任[务務](?:卡)?|计[划劃](?:卡)?|待[办辦])",
    r"(?:我想要|我要|我需要|来个|來個)\s*"
    r"(?:一|一个|一個|两|兩|二|三|四|[1-4])?\s*"
    r"(?:个|個|条|條|项|項)?\s*(?:任[务務](?:卡)?|计[划劃](?:卡)?|待[办辦])",
    # 「帮我把这部分存下来」/「先存起来」 — the spec's own strong signal, and the
    # one the old recogniser missed because it only looked for the word 任务.
    r"(?:帮我|幫我|替我|先)?\s*(?:把.{0,12})?(?:存|保存|记|記)\s*(?:下来|下來|起来|起來|住)",
    r"提醒我",
    r"\b(?:make|create|generate|give|build|add|turn|organize|schedule|save)\b.{0,32}"
    r"\b(?:tasks?|task cards?|plans?|checklists?|to-?dos?|action items?)\b",
    r"\b(?:tasks?|task cards?|plans?|checklists?|to-?dos?|action items?)\b.{0,24}"
    r"\b(?:for me|from this|from that|out of this|please)\b",
    r"\bremind me\b",
))

_DECLINE = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"(?:不要|不用|无需|無需|先别|先別|别|別)\s*(?:再\s*)?(?:"
    r"(?:(?:给|給)\s*)?(?:我|我们|我們)?\s*(?:任[务務](?:卡)?|计[划劃]|待[办辦]|卡片?)"
    r"|(?:生成|创建|創建|添加|安排|布置|整理成|转成|轉成|转为|轉為|变成|變成|做成|做|存|保存)"
    r".{0,5}(?:任[务務](?:卡)?|计[划劃]|待[办辦]|卡片?)"
    r"|把.{0,8}(?:整理成|转成|轉成|转为|轉為|变成|變成|做成)"
    r".{0,4}(?:任[务務](?:卡)?|计[划劃]|待[办辦]))",
    r"(?:我)?(?:就|只)是想(?:聊聊|说说|說說|倾诉|傾訴)",
    r"(?:我)?(?:还没|還沒)(?:决定|決定|想好)",
    r"(?:这个|這個|那个|那個)?(?:方法|办法|辦法)?我(?:做不到|做不了|没办法|沒辦法)",
    r"\b(?:do not|don't|dont|no need to|without)\b.{0,32}"
    r"\b(?:tasks?|task cards?|plans?|checklists?|to-?dos?)\b",
    r"\bi(?:'m| am)? ?just (?:want(?:ing)? to )?(?:talk|vent)\b",
    r"\bi haven'?t decided\b",
))

#: Asking *about* a plan is not asking *for* one. 「给我讲讲这个计划的优缺点」
#: created a card, twice, in round one.
_META = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"(?:列出|分析|评价|評價|比较|比較|讲讲|講講|解释|解釋|介绍|介紹)"
    r"[^，。！？,;!?\n]{0,12}(?:任[务務](?:卡)?|计[划劃])",
    r"(?:任[务務]卡|计[划劃])\s*(?:是什么|是什麼|有什么用|有什麼用)",
    r"\b(?:tell me about|explain|describe|summarize|what (?:is|are))\b"
    r"[^,.;!?\n]{0,32}\b(?:plans?|task cards?)\b",
))

#: An explicit yes to the plan that was just put in front of them (§5.5).
#: Deliberately requires more than agreement particles — 「可以」 alone is weak,
#: 「可以，就按这个来」 is not.
_EXPLICIT = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"就(?:按|照)(?:这个|這個|你说的|你說的|上面)",
    r"(?:那)?就(?:这样|這樣|这么|這麼)(?:做|办|辦|来|來|试|試)",
    r"(?:我|我们|我們)(?:今晚|明天|今天|这周|這週|先)?\s*(?:就)?\s*(?:先)?(?:试试看|試試看|来试|試|做|开始|開始|执行|執行)"
    r"(?:这个|這個|第一步)",
    r"(?:选|選|要)\s*(?:第一个|第一個|第二个|第二個|A|B|1|2)\s*(?:个|個|方案|种|種)?",
    r"(?:可以|好|行|ok)[，,、]\s*(?:那)?\s*(?:就|我|先)",
    r"\b(?:let'?s do (?:that|this|it)|i'?ll do that|sounds good,? i'?ll|"
    r"i'?ll start with)\b",
))

#: Politeness and comprehension. Never enough on its own (§5.5, §12.2).
_WEAK = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"^(?:嗯+|哦+|噢+|好+的?|行|懂了|知道了|明白了|收到|谢谢|謝謝|感谢|感謝|ok|okay|"
    r"got it|thanks|thank you|i see)[。.!！~\s]*$",
))


def acceptance_of(text: str) -> str:
    """Classify one parent message into the four acceptance levels.

    Order matters and is not arbitrary. A decline anywhere in the message wins,
    because 「给我三个任务，不过现在先不要生成」 is a decline with a request
    inside it. A request beats an explicit acceptance because it is the stronger
    of the two, and a message that is *only* an agreement particle is weak no
    matter how enthusiastic the particle.
    """
    normalized = " ".join((text or "").strip().split())
    if not normalized:
        return "none"
    if any(p.search(normalized) for p in _DECLINE):
        return "decline"
    meta = [m for p in _META for m in p.finditer(normalized)]
    requests = [
        m for p in _REQUEST for m in p.finditer(normalized)
        # Overlap, not containment: 「给我讲讲这个计划」 matches a request from
        # 给 and a meta question from 讲讲, and the request starts first.
        if not any(q.start() < m.end() and m.start() < q.end() for q in meta)
    ]
    if requests:
        return "user_requested"
    if any(p.search(normalized) for p in _EXPLICIT):
        return "explicit"
    if any(p.match(normalized) for p in _WEAK):
        return "weak"
    return "none"


# ── the plan ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PlanTask:
    """One action inside a plan (§10). `owner` is here because half of the
    fragmentation in round one was the same action being re-created for a
    different person — 「你打电话」 and 「让伴侣打电话」 are one plan."""

    action: str = ""
    owner: str = "user"          # user | partner | caregiver | other
    timing: str = ""
    trigger: str = ""
    completion_criterion: str = ""
    fallback: str = ""


@dataclass(frozen=True)
class PlanCandidate:
    """A proposed plan, before anyone has agreed to it (§2.3).

    Held separately from a card on purpose: the failure the spec opens with is
    a candidate being persisted, and a type that cannot be persisted is a
    cheaper guarantee than a rule saying not to.
    """

    core_goal: str = ""
    title: str = ""
    tasks: Sequence[PlanTask] = ()
    completion_criteria: Sequence[str] = ()
    fallback: Sequence[str] = ()
    review_at: str = ""
    #: Bumped whenever the plan text changes. Half of the idempotency key, so a
    #: retry of the same confirmed plan cannot become a second card.
    version: int = 1

    def first_step(self) -> Optional[PlanTask]:
        return self.tasks[0] if self.tasks else None


#: A direction is not a plan. 「建立规律」「多沟通」「寻求支持」 are the three the
#: graders quoted; none of them tells a parent what to do at 8pm tonight.
_DIRECTIONAL = re.compile(
    r"^(?:建立规律|建立規律|多沟通|多溝通|寻求支持|尋求支持|保持耐心|注意观察|"
    r"注意觀察|多陪伴|规律作息|規律作息)[。.!！]?$"
)


def plan_gaps(plan: Optional[PlanCandidate]) -> tuple[str, ...]:
    """What is still missing before this counts as `plan_proposed` (§5.4).

    Returned as names rather than a bool so the reply can ask for the one thing
    it lacks, and so `missing_decision_facts` in a log says something.
    """
    if plan is None:
        return ("plan",)
    gaps = []
    if not (plan.core_goal or "").strip():
        gaps.append("core_goal")
    step = plan.first_step()
    if step is None or not (step.action or "").strip():
        gaps.append("first_step")
    elif _DIRECTIONAL.match(step.action.strip()):
        gaps.append("first_step_is_directional")
    if step is not None and not (step.owner or "").strip():
        gaps.append("owner")
    if step is not None and not ((step.timing or "").strip() or (step.trigger or "").strip()):
        gaps.append("timing_or_trigger")
    if not (
        [c for c in plan.completion_criteria if (c or "").strip()]
        or (step is not None and (step.completion_criterion or "").strip())
    ):
        gaps.append("completion_criterion")
    return tuple(gaps)


# ── conversation state ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class OrchestrationState:
    """§13, as a value. One per conversation, carried across turns.

    Every field here is something a person can be shown afterwards when they
    ask why a card did or did not appear. That is the difference between this
    and `suggest_tasks`: the old boolean was the model's mood, and there was
    nothing to look at when it was wrong.
    """

    conversation_stage: str = "DISCOVERY"
    scenario_complexity: str = "personalized_decision"
    active_topic: Optional[str] = None
    remaining_topics: Sequence[str] = ()
    topic_priority_confirmed: bool = False
    core_goal: Optional[str] = None
    core_goal_confirmed: bool = False
    decision_facts: Mapping[str, str] = field(default_factory=dict)
    missing_decision_facts: Sequence[str] = ()
    decision_facts_sufficient: bool = False
    major_constraint_known: bool = False
    user_support_preference_known: bool = False
    emotional_depth: str = "not_applicable"
    plan_candidate: Optional[PlanCandidate] = None
    plan_proposed: bool = False
    plan_confirmed: bool = False
    acceptance_strength: str = "none"
    #: Index of the message the acceptance was read from, so a reviewer can go
    #: and read it (§16). -1 when nothing has been accepted.
    acceptance_message_index: int = -1
    safety_state: str = "none"
    existing_card_id: Optional[str] = None

    @property
    def user_acceptance_detected(self) -> bool:
        return self.acceptance_strength in ("explicit", "user_requested")

    @property
    def no_blocking_safety_issue(self) -> bool:
        return self.safety_state not in BLOCKING_SAFETY

    def with_turn(self, user_text: str, message_index: int) -> "OrchestrationState":
        """Fold one parent message into the state.

        Only the acceptance signal is read here; everything else is the
        dialogue model's job, because 「够不够做决定」 is a judgement about
        content and this module has none. A decline resets acceptance rather
        than merely lowering it — the spec requires returning to
        AWAITING_CONFIRMATION, not staying one signal away from creating.
        """
        signal = acceptance_of(user_text)
        if signal == "decline":
            return replace(
                self, acceptance_strength="none", plan_confirmed=False,
                conversation_stage="PLAN_CONFIRMATION",
                acceptance_message_index=-1,
            )
        if signal == "none":
            return self
        return replace(
            self, acceptance_strength=signal,
            acceptance_message_index=message_index,
            plan_confirmed=signal in ("explicit", "user_requested"),
        )


@dataclass(frozen=True)
class Readiness:
    """The five (or eight) gates, kept apart so a log can name the one that
    failed. `missing` is ordered by what the reply should do about it."""

    ready: bool
    missing: tuple[str, ...] = ()

    def as_event(self) -> dict:
        """The `readiness` block of a task_card.* event (§14)."""
        return {
            "core_goal_confirmed": "core_goal_confirmed" not in self.missing,
            "decision_facts_sufficient": "decision_facts_sufficient" not in self.missing,
            "plan_proposed": "plan_proposed" not in self.missing,
            "user_acceptance_detected": "user_acceptance_detected" not in self.missing,
            "no_blocking_safety_issue": "no_blocking_safety_issue" not in self.missing,
        }


def readiness(state: OrchestrationState) -> Readiness:
    """`task_card_ready`, computed from auditable fields only (§5.1)."""
    missing = []
    if not state.no_blocking_safety_issue:
        missing.append("no_blocking_safety_issue")
    if not state.core_goal_confirmed:
        missing.append("core_goal_confirmed")
    if not state.decision_facts_sufficient:
        missing.append("decision_facts_sufficient")
    if not state.plan_proposed or plan_gaps(state.plan_candidate):
        missing.append("plan_proposed")
    if not state.user_acceptance_detected:
        missing.append("user_acceptance_detected")
    if state.scenario_complexity in NEEDS_CONSTRAINTS:
        if not state.major_constraint_known:
            missing.append("major_constraint_known")
        if not state.user_support_preference_known:
            missing.append("user_support_preference_known")
        if not (state.active_topic and state.topic_priority_confirmed):
            missing.append("active_topic_confirmed")
    return Readiness(not missing, tuple(missing))


# ── goals and duplicates ─────────────────────────────────────────────────────

_PUNCT = re.compile(r"[\s，。、！？；：（）()\[\]{}<>「」『』\"'’“”,.!?;:/\\-]+")
#: Words that carry no goal. Stripped before comparison so 「帮宝宝把早上那一觉
#: 睡长一点」 and 「让小啊谷早上那觉睡久一些」 land on each other.
_STOP = (
    "帮", "幫", "让", "讓", "把", "给", "給", "我", "我们", "我們", "你", "他",
    "她", "的", "了", "着", "著", "一点", "一點", "一些", "一下", "有点", "有點",
    "想", "要", "能", "会", "會", "和", "跟", "与", "與", "在", "去", "做",
    "the", "a", "an", "to", "for", "my", "our", "his", "her", "with", "and",
    "of", "on", "in", "how", "get", "make",
)

_CJK = re.compile(r"[一-鿿]")


def normalize_goal(text: str) -> str:
    """Fold a goal statement to its comparable form.

    Crude on purpose, and documented as crude: no embeddings, no model call, so
    it is reproducible in a test and in a post-mortem. The spec only forbids
    one thing outright — deduping on the title string being identical (§9) —
    and this at least reads the words.
    """
    lowered = _PUNCT.sub("", (text or "").lower())
    for word in _STOP:
        lowered = lowered.replace(word, "")
    return lowered


def _grams(text: str) -> frozenset:
    """Character bigrams for CJK, whitespace words for the rest. Chinese has no
    spaces, so a word-level comparison of two Chinese goals compares nothing."""
    normalized = normalize_goal(text)
    if not normalized:
        return frozenset()
    if _CJK.search(normalized):
        if len(normalized) == 1:
            return frozenset([normalized])
        return frozenset(normalized[i:i + 2] for i in range(len(normalized) - 1))
    return frozenset(normalized.split()) or frozenset([normalized])


def similarity(left: str, right: str) -> float:
    """Jaccard over `_grams`. 0.0 when either side is empty."""
    a, b = _grams(left), _grams(right)
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


EXACT_AT = 0.75
PARTIAL_AT = 0.35


@dataclass(frozen=True)
class ExistingCard:
    """The parts of a stored card a duplicate check needs. A projection rather
    than the row itself, so this module stays free of the store."""

    card_id: str
    goal_id: str = ""
    core_goal: str = ""
    status: str = "ACTIVE"
    owners: Sequence[str] = ()
    #: Free-form window label ("本周", "夜班第一周"). Compared for overlap only
    #: in the crude sense of "the same label or one of them is open-ended".
    time_window: str = ""
    task_actions: Sequence[str] = ()


@dataclass(frozen=True)
class DedupeVerdict:
    result: str                      # NO_MATCH | EXACT_MATCH | PARTIAL_MATCH | POSSIBLE_CONFLICT
    card_id: Optional[str] = None
    reason: str = ""
    score: float = 0.0


def goal_id_for(conversation_id: str, core_goal: str) -> str:
    """A stable id for one goal inside one conversation.

    uuid5 of the *normalized* goal, so the same goal restated in different words
    keeps its id across turns — which is what the event contract needs in order
    to tell "the parent adjusted the plan" from "NURI made a second card"
    (handoff: 同一用户目标必须复用同一个ID).
    """
    key = f"{conversation_id}:{normalize_goal(core_goal)}"
    return "goal_" + uuid.uuid5(uuid.NAMESPACE_URL, key).hex[:16]


def _windows_overlap(left: str, right: str) -> bool:
    left, right = (left or "").strip(), (right or "").strip()
    if not left or not right:
        return True          # an open-ended plan overlaps everything
    return normalize_goal(left) == normalize_goal(right)


def dedupe(
    plan: PlanCandidate,
    existing: Sequence[ExistingCard],
    *,
    goal_id: str = "",
) -> DedupeVerdict:
    """Which of the four §9 verdicts this plan gets against what is stored.

    Ordered so the strongest evidence wins: the goal id, then whether the new
    "plan" is one step of an existing card, then similarity. The middle one is
    the fragmentation case — 「明天上午打电话给 WIC」 as its own card when the
    existing card's second task already says exactly that.
    """
    best = DedupeVerdict("NO_MATCH")
    for card in existing:
        if card.status not in OPEN_STATES:
            continue
        same_id = bool(goal_id and card.goal_id and goal_id == card.goal_id)
        score = similarity(plan.core_goal, card.core_goal)
        overlap = _windows_overlap(plan.time_window if hasattr(plan, "time_window") else "",
                                   card.time_window)
        owners = {t.owner for t in plan.tasks} or {"user"}
        same_owner = not card.owners or bool(owners & set(card.owners))

        if same_id or score >= EXACT_AT:
            if overlap and same_owner:
                return DedupeVerdict(
                    "EXACT_MATCH", card.card_id,
                    "same_goal_id" if same_id else "goal_similarity", score,
                )
            return DedupeVerdict(
                "POSSIBLE_CONFLICT", card.card_id,
                "same_goal_different_owner" if not same_owner
                else "same_goal_different_window", score,
            )
        if _is_one_step_of(plan, card):
            best = DedupeVerdict(
                "PARTIAL_MATCH", card.card_id, "plan_repeats_existing_step", score,
            )
            continue
        if score >= PARTIAL_AT and best.result == "NO_MATCH":
            best = DedupeVerdict("PARTIAL_MATCH", card.card_id, "goal_overlap", score)
    return best


def _is_one_step_of(plan: PlanCandidate, card: ExistingCard) -> bool:
    """True when the whole new plan is something the existing card already
    contains — the shape of 「问一个、生成一个」 once the first card exists."""
    if len(plan.tasks) != 1 or not card.task_actions:
        return False
    action = plan.tasks[0].action
    return any(similarity(action, existing) >= EXACT_AT for existing in card.task_actions)


# ── the decision ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Decision:
    """What to do about cards this turn, and why — always both (§16)."""

    action: str                       # one of ACTIONS
    reason: str = ""
    card_id: Optional[str] = None
    goal_id: str = ""
    readiness: Readiness = Readiness(False)
    dedupe_result: str = "NO_MATCH"

    @property
    def writes(self) -> bool:
        return self.action in ("create", "update", "merge", "pause", "complete", "cancel")


def decide(
    state: OrchestrationState,
    existing: Sequence[ExistingCard] = (),
    *,
    conversation_id: str = "",
) -> Decision:
    """The whole gate, in the spec's priority order (§3).

    Returns `propose` — not `create` — for every case where the plan is worth
    putting in front of the parent but nobody has agreed to it yet. That branch
    is the one this module exists for: proposing is what the reply should do on
    most turns, and the old pipeline had no way to say it.
    """
    ready = readiness(state)
    goal_id = goal_id_for(conversation_id, state.core_goal or "") if state.core_goal else ""

    if not state.no_blocking_safety_issue:
        return Decision("none", "safety_flow_active", None, goal_id, ready)
    if state.acceptance_strength == "decline":
        return Decision("none", "user_declined", state.existing_card_id, goal_id, ready)
    if state.scenario_complexity == "simple_knowledge":
        return Decision("none", "not_useful_for_this_scenario", None, goal_id, ready)

    if not state.core_goal_confirmed:
        return Decision("none", "goal_not_confirmed", None, goal_id, ready)
    if not state.decision_facts_sufficient or "active_topic_confirmed" in ready.missing:
        return Decision("none", "insufficient_information", None, goal_id, ready)
    if state.scenario_complexity in NEEDS_CONSTRAINTS and (
        "major_constraint_known" in ready.missing
        or "user_support_preference_known" in ready.missing
    ):
        return Decision("none", "insufficient_information", None, goal_id, ready)

    gaps = plan_gaps(state.plan_candidate)
    if not state.plan_proposed or gaps:
        # Enough is known to say something concrete, so the reply proposes
        # rather than asks again. This is the branch that keeps §5.4's
        # requirements from turning into another round of interrogation.
        return Decision("propose", "plan_" + (gaps[0] if gaps else "not_yet_proposed"),
                        None, goal_id, ready)

    plan = state.plan_candidate
    verdict = dedupe(plan, existing, goal_id=goal_id)

    if state.acceptance_strength == "weak":
        return Decision("none", "weak_acceptance_only", verdict.card_id, goal_id,
                        ready, verdict.result)
    if not state.user_acceptance_detected:
        return Decision("none", "plan_not_confirmed", verdict.card_id, goal_id,
                        ready, verdict.result)

    if verdict.result == "EXACT_MATCH":
        # §8.1: the same goal, agreed to again after new information, is an
        # update of one card — never a second one that says the same thing.
        return Decision("update", verdict.reason, verdict.card_id, goal_id,
                        ready, verdict.result)
    if verdict.result == "PARTIAL_MATCH":
        return Decision("merge", verdict.reason, verdict.card_id, goal_id,
                        ready, verdict.result)
    if verdict.result == "POSSIBLE_CONFLICT":
        return Decision("propose", "conflicts_with_existing_card", verdict.card_id,
                        goal_id, ready, verdict.result)
    return Decision("create", "user_confirmed_plan", None, goal_id, ready,
                    verdict.result)


def idempotency_key(conversation_id: str, plan: PlanCandidate, action: str) -> str:
    """`conversation_id + confirmed_plan_version + action` (§15).

    A network retry of one confirmed plan must land on one card. The plan's
    *version* rather than its text: an edit the parent agreed to separately is
    a different write, and identical prose written twice is not.
    """
    raw = f"{conversation_id}:{plan.version}:{action}:{normalize_goal(plan.core_goal)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
