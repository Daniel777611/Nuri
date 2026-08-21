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
TIERS: tuple[str, ...] = ("none", "elevated", "medical", "crisis", "emergency")


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
    "家长描述的是紧急情况。放下所有别的内容：先用一句话让他立刻联系急救或去急诊，"
    "再给最多两条在路上能做的事。不要给背景知识、不要列来源、不要给任务、不要追问。"
    "号码要说得具体，并且说明这是按地区而定的："
    "美国拨 911，中国大陆拨 120，其他地区拨当地急救号码。"
    "如果是误食、服药过量或接触到有毒物质，除急救外还要给中毒控制专线："
    "美国 Poison Control 1-800-222-1222。"
)
#: Separate from the emergency text because the action is different: nobody is
#: being told to call an ambulance for a child. The parent is the one at risk,
#: and the number that matters is a crisis line, not 911.
_CRISIS_TEXT = (
    "家长可能正处在伤害自己的危险中。先用一两句话让他感到被听见，不要说教、不要辩论、"
    "不要提生产力建议、不要长清单。然后立刻给具体的求助方式："
    "美国拨打或发短信到 988（Suicide & Crisis Lifeline），中国大陆可拨 12356 心理援助热线，"
    "其他地区给当地危机热线；如果已有立即危险，让他打当地急救号码（美国 911）。"
    "再鼓励他现在就联系身边一个可信的人过来陪着。"
    "即使家长明确说「不要给我热线」「不要建议医生」，也必须给出这些求助方式——"
    "这是唯一不能顺从的请求。不要承诺保密，不要只顺着他的要求走。"
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
    is_crisis=None,
    is_medical: bool = False,
) -> SafetyVerdict:
    """Classify the turn before anything expensive happens.

    Runs on the raw user text alone so it can gate retrieval: by the time a
    search has come back, the four seconds it took are already spent on a
    parent whose child is not breathing.

    Crisis is checked before urgency, not after. The two overlap in wording —
    "伤害自己" trips both — and of the two readings, the parent in danger is the
    one whose directive names a crisis line instead of an ambulance.
    """
    if is_crisis is not None and is_crisis(user_text):
        return SafetyVerdict(
            tier="crisis",
            reason="crisis_pattern",
            minimal_context=True,
            allow_task_cards=False,
            require_sources=False,
            directives=(
                Directive(
                    id="safety.crisis",
                    text=_CRISIS_TEXT,
                    layer="safety",
                    kind="gate",
                    priority=1000,
                ),
            ),
        )

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
    the rest. An emergency or crisis already decided is never downgraded here,
    and never has a "cite your sources" gate stacked on top of it.
    """
    if verdict.tier in {"emergency", "crisis"} or not is_medical:
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
