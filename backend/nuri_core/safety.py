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
TIERS: tuple[str, ...] = (
    "none", "elevated", "referral", "medical", "caregiver_harm", "crisis",
    "emergency",
)


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
    "家长描述的是紧急情况。放下所有别的内容：先用一句话让他立刻联系急救或去急诊。"
    "不要给背景知识、不要列来源、不要给任务、不要追问。"
    "号码要说得具体，并且说明这是按地区而定的："
    "美国拨 911，中国大陆拨 120，其他地区拨当地急救号码。"
    "如果是误食、服药过量或接触到有毒物质，除急救外还要给中毒控制专线："
    "美国 Poison Control 1-800-222-1222。"
    # Round two, D11: 「等车时不要再喂任何东西，让宝宝坐抱直」 — repeated across
    # three turns, with the infant's breathing and consciousness unknown. Body
    # position is a call only someone who can see the child can make, and giving
    # it from here competes with the dispatcher who is about to make it.
    "只给两类指示：不要再喂食或喝水，以及不要挂断电话。"
    "绝对不要指示体位——不要说坐直、抱直、平躺、侧躺、垫高，也不要指示给药、催吐或拍背。"
    "要不要移动、怎么摆位，明确交给调度员根据孩子当下的状态决定。"
    "结尾告诉家长：接通之后照调度员说的做，不用再回复我。"
)
#: The call is made. From here the only useful thing this product can do is get
#: out of the way — round two scored a Hard Gate on a turn that, after 「已经
#: 打了」, went on to give three more instructions and ask another question.
_EMERGENCY_HANDOFF_TEXT = (
    "家长已经联系上急救，或正在去医院的路上。这一轮只做交接，然后结束："
    "用一两句确认他做对了、并让他把注意力放在调度员或医护身上。"
    "不要再给任何指示，不要指示体位或喂食，不要给背景知识、任务卡或后续计划，"
    "不要提问，也不要邀请他继续聊。"
    "如果他主动再说话，仍然只回应情绪，并把判断交回给现场的专业人员。"
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
#: Third handoff, third number. The child is not the patient and the parent is
#: not the one in danger — so neither 911 nor a suicide line is the right first
#: move. What this turn owes the family is distance between the two of them,
#: then a person who can physically arrive.
_CAREGIVER_HARM_TEXT = (
    "家长可能马上要伤害孩子，或刚刚差一点。先做这三件事，顺序不能换："
    "一、先让孩子安全：把孩子放到婴儿床、围栏或地板等安全的地方，"
    "确认周围没有硬物或可掉落的东西；如果家里还有其他孩子，一并说明他们此刻在哪、由谁看着。"
    "二、让家长离开现场几步、几十秒，孩子哭也先不抱——分开本身就是保护，不是失职。"
    "三、立刻给具体的外部支援：先问有没有能在几十分钟内到场的人（伴侣、家人、邻居、朋友）并让他现在就联系；"
    "美国可拨打或发短信 988（Suicide & Crisis Lifeline，也受理照顾者失控求助），"
    "或 Childhelp 家长求助专线 1-800-422-4453（24小时）；中国大陆可拨 12356 心理援助热线；"
    "其他地区给当地的家庭支持或危机热线。"
    "如果孩子已经被打到、摇晃过或有任何受伤迹象，直接让他联系急救（美国 911，中国大陆 120）——"
    "摇晃婴儿的伤害可能看不出来。"
    "不要说教、不要评判、不要长清单、不要给任务卡，也不要在这一轮追问育儿细节。"
    "先用一两句让家长知道他愿意说出来、并且已经在踩刹车，这件事本身是保护孩子的。"
)
_MEDICAL_TEXT = (
    "这一轮涉及医疗判断。只依据下面列出的权威来源作答，没有依据的部分要明说不确定，"
    "并给出该在什么情况下联系医生。"
    "身体准备度这类隔着文字看不到的事——吞咽、坐姿、口腔动作、发育里程碑——"
    "不要给家长一套让他自己判断的标准，直接说这个只有当面看得到的人能确认，"
    "并说清楚下次健儿检查或就诊时具体问哪一句。"
    # Round two, D07: 「1000 ml 已经不少」. A day's volume and a single weight
    # are not what sufficiency is read from, and saying it is tells a parent
    # they can stop asking.
    "也不要用单日奶量、单次体重或「看起来不少」来暗示摄入够或不够——"
    "那要对着生长曲线看，是儿科的判断，不是这里的。"
)
#: Not a safety gate — nobody is in danger — but the same shape: there is a part
#: of this turn that is not ours to settle. Additive, unlike the gates above: the
#: rest of the reply is still useful and still gets written. Five of the eight
#: dialogues that scored under 80 in round one lost points here, and the two
#: Low-risk ones lost the most: 常见卡点与异常分支 came in at 1.5/4 against 2.44
#: everywhere else, because a benefits application's failure modes are the whole
#: of its difficulty and none of them were named.
_REFERRAL_TEXT = (
    "这一轮里有一部分不是你能替家长定的：资格认定、身份/移民影响、法定假别、"
    "特教权利、保险涵盖范围，这些由主管机关、保险条款或合格专业人士决定，"
    "而且各州、各学区、各计划都不一样。"
    "照常把你知道的说清楚，但要做到三件事："
    "一、明确指出哪一部分只有对方能定，不要用笼统的口气把它盖过去；"
    "二、把「去确认」变成一个具体动作：打给谁、开口第一句问什么、要拿到哪份书面材料；"
    "三、说清楚这条路最常见的卡点，以及卡住时下一步走哪里——"
    "打不通、被拒、名额没了、费用超出、材料不齐、语言不通（可要求免费口译）。"
    "不要保证结果，也不要说「你应该符合资格」。"
)
_CONSTRAINT_TEXT = "这个家庭有以下硬性限制，任何建议都不得与之冲突：{constraints}"


def assess(
    user_text: str,
    *,
    family: FamilyState,
    is_urgent,
    is_crisis=None,
    is_caregiver_harm=None,
    is_referral=None,
    urgent_category=None,
    is_handoff=None,
    prior_emergency: bool = False,
    is_medical: bool = False,
) -> SafetyVerdict:
    """Classify the turn before anything expensive happens.

    Runs on the raw user text alone so it can gate retrieval: by the time a
    search has come back, the four seconds it took are already spent on a
    parent whose child is not breathing.

    Crisis is checked before urgency, not after. The two overlap in wording —
    "伤害自己" trips both — and of the two readings, the parent in danger is the
    one whose directive names a crisis line instead of an ambulance.

    Caregiver harm is checked *after* urgency, and that order is the whole
    point: "我摇晃了他，现在叫不醒" is both, and a child who is already hurt
    needs the ambulance before the family needs a support line.
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

    # The handoff is checked before the emergency itself. 「已经打了，救护车在
    # 路上」 still trips the urgent patterns through the words that opened the
    # emergency, and answering it with another round of instructions is the
    # failure round two gated on.
    if prior_emergency and is_handoff is not None and is_handoff(user_text):
        return SafetyVerdict(
            tier="emergency",
            reason="emergency_handoff",
            minimal_context=True,
            allow_task_cards=False,
            require_sources=False,
            directives=(
                Directive(
                    id="safety.emergency.handoff",
                    text=_EMERGENCY_HANDOFF_TEXT,
                    layer="safety",
                    kind="gate",
                    priority=1000,
                ),
            ),
        )

    if is_urgent(user_text, ""):
        # The category only labels what already tripped, so a classifier that
        # cannot place it costs the audit trail a name, never the gate.
        category = (urgent_category(user_text) if urgent_category else "") or "other"
        return SafetyVerdict(
            tier="emergency",
            reason=f"urgent_pattern:{category}",
            minimal_context=True,
            allow_task_cards=False,
            require_sources=False,
            directives=(
                Directive(
                    id=f"safety.emergency.{category}",
                    text=_EMERGENCY_TEXT,
                    layer="safety",
                    kind="gate",
                    priority=1000,
                ),
            ),
        )

    # An emergency does not end because the parent's next message is calm. Until
    # they say the call is made, a follow-up inside an open emergency stays in
    # it rather than sliding back to an ordinary parenting turn.
    if prior_emergency:
        return SafetyVerdict(
            tier="emergency",
            reason="emergency_open",
            minimal_context=True,
            allow_task_cards=False,
            require_sources=False,
            directives=(
                Directive(
                    id="safety.emergency.open",
                    text=_EMERGENCY_TEXT,
                    layer="safety",
                    kind="gate",
                    priority=1000,
                ),
            ),
        )

    if is_caregiver_harm is not None and is_caregiver_harm(user_text):
        return SafetyVerdict(
            tier="caregiver_harm",
            reason="caregiver_harm_pattern",
            minimal_context=True,
            allow_task_cards=False,
            require_sources=False,
            directives=(
                Directive(
                    id="safety.caregiver_harm",
                    text=_CAREGIVER_HARM_TEXT,
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

    if is_referral is not None and is_referral(user_text):
        tier = escalate(tier, "referral")
        directives.append(
            Directive(
                id="safety.referral",
                text=_REFERRAL_TEXT,
                layer="safety",
                kind="gate",
                priority=940,
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
        reason=(
            "medical_route" if is_medical
            else "referral_scope" if tier == "referral"
            else "constraints" if directives else ""
        ),
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
    if verdict.tier in {"emergency", "crisis", "caregiver_harm"} or not is_medical:
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
