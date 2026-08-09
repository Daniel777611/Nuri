"""NURI 四大核心系统 — the four-subsystem turn pipeline.

The linear pipeline this replaces read every context block on every turn and
concatenated them into one prompt, so the only way to change what NURI says was
to edit the prompt. This package partitions the same data into four subsystems
that each own a slice, decide for themselves whether this turn needs them, and
emit *directives* — rows, not prose — that the dialogue layer renders.

    1 家庭模型        family.py     who this family is, and what is true of them
    2 知识与决策模型  knowledge.py  what evidence this turn needs, and the call
    3 对话与主动模型  dialogue.py   how to say it, and what to raise unprompted
    4 结果学习模型    outcome.py    what worked last time, fed back as weights

Two cross-cutting layers sit beside them rather than in the chain:

    横切 Safety Layer            safety.py
    横切 Evaluation 与 Provenance provenance.py

`orchestrator.run_turn_context` is the only entry point main.py needs. It never
raises: every subsystem degrades to "contributed nothing" so a turn always gets
a reply, and the trace records which ones did.

Nothing here imports main.py. Everything the subsystems need from the app
arrives through `ports.CorePorts`, which is what lets this run in tests, and
what will let the two pipelines be compared side by side.
"""

from backend.nuri_core.contracts import (
    Directive,
    DialoguePlan,
    EvidenceDecision,
    FamilyState,
    LearnedPolicy,
    TurnBundle,
)
from backend.nuri_core.orchestrator import PIPELINE_VERSION, run_turn_context
from backend.nuri_core.ports import CorePorts
from backend.nuri_core.provenance import TurnTrace

__all__ = [
    "CorePorts",
    "Directive",
    "DialoguePlan",
    "EvidenceDecision",
    "FamilyState",
    "LearnedPolicy",
    "PIPELINE_VERSION",
    "TurnBundle",
    "TurnTrace",
    "run_turn_context",
]
