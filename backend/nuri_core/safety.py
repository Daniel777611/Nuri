"""横切 Safety Layer — the gate every other subsystem is measured against.

Cross-cutting rather than a stage in the chain, because it has to act at three
different points: before retrieval (an emergency must not wait on a web
search), during assembly (its directives outrank every learned preference), and
after (an emergency turn must never be turned into a routine task card).

The detectors themselves stay in main.py — they are a hundred lines of tuned
bilingual regex with their own tests, and forking them here to satisfy a
package boundary would be the worst possible trade. This module owns the
*policy*: given a detection, what the turn is then allowed to do.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

from backend.nuri_core.contracts import Directive, FamilyState, RiskTier

#: Ordered least to most severe. Comparisons use the index, so adding a tier
#: means adding it in the right position, not just appending.
TIERS: tuple[str, ...] = ("none", "elevated", "medical", "emergency")


def escalate(a: RiskTier, b: RiskTier) -> RiskTier:
    return a if TIERS.index(a) >= TIERS.index(b) else b


@dataclass(frozen=True)
class SafetyVerdict:
    tier: RiskTier = "none"
    #: What tripped it, recorded so a false positive is diagnosable from the
    #: trace instead of by re-running the turn.
    reason: str = ""
    #: An emergency reply must be short, single-purpose, and immediate. Every
    #: other context block is noise in front of "call 911", so the assembler
    #: drops them.
    minimal_context: bool = False
    allow_task_cards: bool = True
    #: Medical turns may not answer from the model's own impression.
    require_sources: bool = False
    directives: Sequence[Directive] = ()


_EMERGENCY_TEXT = (
    "家长描述的是紧急情况。放下所有别的内容：先用一句话让他立刻打 911 或去急诊，"
    "再给最多两条在路上能做的事。不要给背景知识、不要列来源、不要给任务、不要追问。"
)
_MEDICAL_TEXT = (
    "这一轮涉及医疗判断。只依据下面列出的权威来源作答，没有依据的部分要明说不确定，"
    "并给出该在什么情况下联系医生。"
)
_CONSTRAINT_TEXT = "这个家庭有以下硬性限制，任何建议都不得与之冲突：{constraints}"


def assess(
    user_text: str,
    *,
    family: FamilyState,
    is_urgent,
    is_medical: bool = False,
) -> SafetyVerdict:
    """Classify the turn before anything expensive happens.

    Runs on the raw user text alone so it can gate retrieval: by the time a
    search has come back, the four seconds it took are already spent on a
    parent whose child is not breathing.
    """
    if is_urgent(user_text, ""):
        return SafetyVerdict(
            tier="emergency",
            reason="urgent_pattern",
            minimal_context=True,
            allow_task_cards=False,
            require_sources=False,
            directives=(
                Directive(
                    id="safety.emergency",
                    text=_EMERGENCY_TEXT,
                    layer="safety",
                    kind="gate",
                    priority=1000,
                ),
            ),
        )

    directives: list[Directive] = []
    tier: RiskTier = "none"

    if family.constraints:
        tier = escalate(tier, "elevated")
        directives.append(
            Directive(
                id="safety.constraints",
                text=_CONSTRAINT_TEXT.format(constraints="、".join(family.constraints)),
                layer="safety",
                kind="constraint",
                priority=900,
            )
        )

    if is_medical:
        tier = escalate(tier, "medical")
        directives.append(
            Directive(
                id="safety.medical",
                text=_MEDICAL_TEXT,
                layer="safety",
                kind="gate",
                priority=950,
            )
        )

    return SafetyVerdict(
        tier=tier,
        reason="medical_route" if is_medical else ("constraints" if directives else ""),
        allow_task_cards=True,
        require_sources=is_medical,
        directives=tuple(directives),
    )


def reassess(verdict: SafetyVerdict, *, is_medical: bool) -> SafetyVerdict:
    """Fold in what the router found once it has returned.

    The router is the only thing that can recognise an implicit medical turn —
    a parent asking "要不要看医生" trips no keyword. So safety runs twice: once
    on text to catch emergencies before retrieval, once after routing to catch
    the rest. An emergency already decided is never downgraded here.
    """
    if verdict.tier == "emergency" or not is_medical:
        return verdict
    merged = list(verdict.directives)
    if not any(d.id == "safety.medical" for d in merged):
        merged.append(
            Directive(
                id="safety.medical",
                text=_MEDICAL_TEXT,
                layer="safety",
                kind="gate",
                priority=950,
            )
        )
    return SafetyVerdict(
        tier=escalate(verdict.tier, "medical"),
        reason=verdict.reason or "medical_route",
        minimal_context=verdict.minimal_context,
        allow_task_cards=verdict.allow_task_cards,
        require_sources=True,
        directives=tuple(merged),
    )
