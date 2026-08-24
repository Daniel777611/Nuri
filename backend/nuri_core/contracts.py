"""The types the four subsystems hand each other.

These are the seams in the diagram: 家庭状态 flows from the family model into
knowledge, 证据与决策 flows from knowledge into dialogue, 行动与结果 flows back
into outcome learning. Making each edge a frozen dataclass rather than a string
is the whole point — a subsystem can be swapped, tested, or skipped as long as
it still produces its type, and nothing downstream has to re-parse prose.

`Directive` is the load-bearing one. It is how a reply gets changed without
touching a prompt: a row with a condition, a weight, and a sentence. The
dialogue model renders the ones that apply; the outcome model moves the weights.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from backend.nuri_core import context_budget
from typing import Any, Mapping, Optional, Sequence

#: Where a directive came from, which is also the order they render in. Earlier
#: layers are more stable, and OpenAI caches the longest identical prefix, so
#: this ordering is a latency decision as much as an editorial one.
LAYERS = ("safety", "outcome", "family", "knowledge", "dialogue")

RiskTier = str  # "none" | "elevated" | "medical" | "crisis" | "emergency"


@dataclass(frozen=True)
class Directive:
    """One rule that shapes a reply, stored as data rather than prompt text.

    `applies_when` is matched against the turn's facts by `matches()`. An empty
    condition means "always", which is what the migrated style rules become —
    they behave exactly as the old always-on block did until someone narrows
    them, so adopting this costs nothing on day one.
    """

    id: str
    text: str
    layer: str = "dialogue"
    kind: str = "style"
    #: Ordering within a layer. Higher renders first.
    priority: int = 0
    #: Multiplied by the outcome model's learned adjustment. At or below zero
    #: the directive is suppressed without being deleted, so a rule that stops
    #: working can come back if the evidence changes.
    weight: float = 1.0
    #: e.g. {"age_months": [0, 12], "risk_tier": ["medical"], "topics": ["睡眠"]}
    applies_when: Mapping[str, Any] = field(default_factory=dict)
    source: str = ""

    def matches(self, facts: Mapping[str, Any]) -> bool:
        """Whether this directive applies to the turn described by `facts`.

        Unknown condition keys match rather than fail. A directive written
        against a fact this build doesn't compute yet should be inert, not a
        reason for the turn to lose every other rule alongside it.
        """
        for key, expected in (self.applies_when or {}).items():
            if key == "age_months":
                lo, hi = _range(expected)
                age = facts.get("age_months")
                if age is None or not (lo <= age <= hi):
                    return False
            elif key in ("risk_tier", "locale", "intent", "help_preference"):
                actual = facts.get(key)
                if actual is None or actual not in _as_list(expected):
                    return False
            elif key == "topics":
                topic = str(facts.get("topic") or "")
                if not any(str(t) and str(t) in topic for t in _as_list(expected)):
                    return False
            elif key == "min_turns":
                if int(facts.get("turns") or 0) < int(expected):
                    return False
        return True

    def render(self) -> str:
        return f"- {self.text}"


def _as_list(value: Any) -> list:
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return [value]


def _range(value: Any) -> tuple[float, float]:
    if isinstance(value, (list, tuple)) and len(value) == 2:
        try:
            return float(value[0]), float(value[1])
        except (TypeError, ValueError):
            pass
    return (float("-inf"), float("inf"))


# ── 1 家庭模型 ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FamilyState:
    """身份 阶段 偏好 约束 — everything true of this family, in one object.

    Split into a `core` half that is free to compute (it comes from the profile
    row main.py already loaded for the turn) and an enriched half that costs a
    round trip. Knowledge routing only needs the core half, which is why the
    search can start before memories have finished loading.
    """

    uid: Optional[str] = None
    nickname: str = ""
    profile_block: str = ""            # 身份/阶段/偏好, rendered
    #: Age-only context for the routing/search model.  Kept separate from
    #: ``profile_block`` because the reply model may use confirmed names and
    #: birthdays, while retrieval never needs those identifiers.
    child_age_context: str = ""
    #: Internal rows used only to reconcile stale memory/state facts with the
    #: current account profile.  They are never returned by search_context().
    child_profiles: Sequence[dict] = ()
    #: The youngest child's completed age in months. The single most
    #: load-bearing fact for both retrieval and directive conditions.
    age_months: Optional[int] = None
    stage_label: str = ""
    help_preference: str = ""
    info_source: str = ""
    locale: str = "zh-TW"
    #: Hard limits the reply must respect — allergies, diagnoses, stated
    #: refusals. Promoted out of free-text memory so safety can see them.
    constraints: Sequence[str] = ()
    memory_block: str = ""             # 长期信息
    follow_up_block: str = ""          # 到期的主动关心
    #: Changes whenever anything above changes. The cache key, and what makes a
    #: stale entry detectable rather than merely old.
    fingerprint: str = ""
    enriched: bool = False
    cache_hit: bool = False

    def search_context(self) -> str:
        """What the knowledge model needs to write a usable query. Age only —
        a search for a 4-month-old and a 2-year-old share almost nothing, and
        everything else in the profile only makes the query worse."""
        return self.child_age_context

    def facts(self) -> dict:
        return {
            "age_months": self.age_months,
            "locale": self.locale,
            "help_preference": self.help_preference,
        }


# ── 2 知识与决策模型 ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EvidenceDecision:
    """证据与决策 — what this turn is allowed to assert, and on what basis.

    The decision half matters as much as the evidence half: `retrieved` records
    which of the three stores were actually queried, which is what turns "the
    reply was slow" into "the reply was slow because it did a web search it did
    not need".
    """

    route: Any = None                  # backend.router.TurnRoute
    risk_tier: RiskTier = "none"
    internal_block: str = ""           # must-follow internal rules (RAG)
    sources_block: str = ""            # external allow-listed pages
    search_results: Sequence[Any] = ()
    #: Names of the stores this turn actually hit: "internal", "web", "card".
    retrieved: Sequence[str] = ()
    #: Stores deliberately skipped, with the reason. Read by provenance.
    skipped: Mapping[str, str] = field(default_factory=dict)
    #: Milliseconds per store. Attributed here rather than by a timer wrapped
    #: around the whole call, because "which store was slow" is the only
    #: version of that number anyone can act on.
    timings: Mapping[str, int] = field(default_factory=dict)
    directives: Sequence[Directive] = ()

    @property
    def topic(self) -> str:
        return getattr(self.route, "topic", "") or ""

    @property
    def is_medical(self) -> bool:
        return bool(getattr(self.route, "is_medical", False))


# ── 3 对话与主动模型 ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DialoguePlan:
    """How the reply gets said, and what it raises unprompted.

    `sections` is an ordered list of (heading, body) pairs rather than a
    finished string so provenance can measure each contributor separately and
    the prefix-cache ordering stays an explicit property of this list.
    """

    sections: Sequence[tuple[str, str]] = ()
    directives: Sequence[Directive] = ()
    #: The one follow-up worth raising this turn, or "" for none. One at a time
    #: by design — a digest of five open topics is a to-do list, not someone
    #: remembering to ask after you.
    proactive: str = ""
    allow_task_cards: bool = True
    #: Recent messages this turn is allowed to replay. Defaults to the shared
    #: budget rather than a literal, so a plan and the assembler cannot disagree
    #: about what "the window" is.
    history_window: int = context_budget.RECENT_MESSAGES

    #: How many leading `sections` hold still while one family talks to NURI.
    #: The boundary is the only lever on the provider's prefix cache, which
    #: matches the longest identical prefix of a request: everything before the
    #: first block that moves is cached, everything after is paid in full. The
    #: dialogue model orders `sections` for that, and this records where it put
    #: the seam so the assembler does not have to guess.
    stable_sections: int = 0

    def system_prompt(self, persona: str) -> str:
        return "\n\n".join(p for p in self.system_parts(persona) if p)

    def system_parts(self, persona: str) -> tuple[str, str, str]:
        """(global, per-family, per-turn), as three separate system messages.

        Global is the persona and the operator rules — byte-identical for every
        parent, so one cache entry serves all traffic. Per-family is the child
        profile and the conversation summary, which hold still for many turns.
        Per-turn is what this question pulled in.
        """
        rendered = [
            f"{heading}\n{body}" if heading else body
            for heading, body in self.sections
            if body
        ]
        # Recomputed against the filtered list: `stable_sections` counts
        # sections the dialogue model emitted, and empty ones drop out above.
        kept_stable = sum(
            1 for i, (_, body) in enumerate(self.sections)
            if body and i < self.stable_sections
        )
        return (
            persona,
            "\n\n".join(rendered[:kept_stable]),
            "\n\n".join(rendered[kept_stable:]),
        )


# ── 4 结果学习模型 ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class LearnedPolicy:
    """What the last N turns taught us, as numbers the other three consume.

    Deliberately small and explainable. A weight this layer cannot justify from
    a counted signal is a weight nobody will be able to debug in three months.
    """

    #: directive_id -> multiplier. Below 1.0 demotes, 0 suppresses.
    directive_weights: Mapping[str, float] = field(default_factory=dict)
    #: Topics where the parent recently signalled the advice missed. The
    #: dialogue model is told to change approach rather than repeat it.
    negative_topics: Sequence[str] = ()
    #: authority / featured / case mix, from recommendation_feedback.
    content_mix: Mapping[str, float] = field(default_factory=dict)
    #: Directives synthesised from outcomes, e.g. "上次这样说没有帮上忙".
    directives: Sequence[Directive] = ()
    samples: int = 0

    def weigh(self, directives: Sequence[Directive]) -> list[Directive]:
        """Apply learned weights and drop what the evidence has suppressed."""
        out = []
        for d in directives:
            adjusted = d.weight * float(self.directive_weights.get(d.id, 1.0))
            if adjusted <= 0:
                continue
            out.append(replace(d, weight=adjusted))
        return out


# ── The assembled turn ────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TurnBundle:
    """Everything the reply model needs, plus the record of how it got here.

    The first six fields intentionally mirror the legacy `_ReplyContext` so both
    pipelines can feed the same `_nuri_messages` call. That is what makes the
    comparison the whole exercise exists for an A/B rather than a rewrite.
    """

    card: str = ""
    memory: str = ""
    profile: str = ""
    #: Rolling summary of everything older than the recent-message window.
    #: Sits with `profile` on the per-family side of the cache boundary: both
    #: hold still for many turns, unlike `memory`, which is re-ranked against
    #: each question.
    state: str = ""
    style: str = ""
    internal: str = ""
    sources: str = ""
    route: Any = None
    search_results: Sequence[Any] = ()

    family: FamilyState = field(default_factory=FamilyState)
    evidence: EvidenceDecision = field(default_factory=EvidenceDecision)
    plan: DialoguePlan = field(default_factory=DialoguePlan)
    policy: LearnedPolicy = field(default_factory=LearnedPolicy)
    trace: Any = None                  # provenance.TurnTrace
