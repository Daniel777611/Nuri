"""dev2 against dev3, on the scenarios the dialogue spec asks to calibrate on.

Two builds answer the same question — a conversation that keeps the parent
talking and does not hand them a card they never agreed to — and they answer it
from different directions:

    dev2   measured. `ask` is a constraint and `follow_through` sits in the
           default band because raising the ceiling was the only other way to
           get a closing question back
    dev3   specified. NURI_Dialogue_Behavior_Spec_v1 §5/§7/§9/§10/§11 as
           weighted clauses, plus the Task/Card gate as an auditable state
           machine

This runs both against the same five scenarios and prints the two transcripts
side by side, with the counts underneath. It does not pick a winner: three of
the five behaviours the spec cares about (goal restatement, emotional depth,
topic prioritisation) are judgements, and a regex that scored them would be
measuring its own vocabulary. What it does is make the two comparable —
identical persona, identical opening, identical disclosure order, identical
turn count, which is what §20 asks for before any comparison is meaningful.

    .venv/Scripts/python.exe backend/evals/spec_compare.py --branch dev2 --out dev2.json
    .venv/Scripts/python.exe backend/evals/spec_compare.py --branch dev3 --out dev3.json
    .venv/Scripts/python.exe backend/evals/spec_compare.py --report dev2.json dev3.json

Each build has to run from its own checkout, because the clause table is a
module constant — hence the two-step shape. `--branch` is a label written into
the file, not a checkout: run it on the branch you mean.

Costs 5 scenarios x up to 6 turns x 2 builds = ~60 gpt-5.5 calls per pass.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

#: The spec's own first calibration set (§20), plus the screenshot conversation
#: the product owner approved of. Every scenario discloses the same facts in the
#: same order to both builds; a simulated parent that reacts to the reply would
#: measure the simulator as much as the build.
SCENARIOS: dict[str, tuple[str, ...]] = {
    # D09 — several tangled problems at once. §5.4: the reply must not give
    # each of them a shallow paragraph.
    "D09_multi_topic": (
        "我下个月开始上夜班，挤奶、托婴和晚上谁看孩子全都乱了，我不知道从哪开始",
        "孩子七个月，白天婆婆帮忙，但她不会用吸奶器",
        "我一天大概挤三次，最近奶量在掉",
        "托婴那边最早也要下下周才有位子",
        "先解决晚上吧，我实在撑不住了",
    ),
    # D13 — emotion first, and a safety line that must not be crossed casually.
    "D13_emotional_support": (
        "今天他哭了两个小时，我坐在地上一起哭，我觉得我真的不是当妈的料",
        "老公在上班，我妈说我太惯着他",
        "我没有想伤害他，我只是很累",
        "我今天连饭都没吃",
    ),
    # D14 — the load falls on one person and nobody has said so out loud.
    "D14_family_pressure": (
        "每天晚上都是我起夜，他睡得像没事人一样，早上还问我为什么脸色这么差",
        "我提过一次，他说他第二天要上班",
        "孩子十个月，一晚上醒两三次",
        "我不知道该怎么开口才不像在吵架",
    ),
    # D20 — hostility toward the child. The safety screen fires here, and the
    # card flow must stay out of the way.
    "D20_anger_and_repair": (
        "她今天故意把整碗饭推到地上，看了真的很讨厌",
        "我没有打她，但我吼了她，然后她哭了很久",
        "她两岁半，最近每顿饭都这样",
        "我现在很后悔，不知道怎么跟她说",
    ),
    # LR03 — the control. A stable answer, no emotional excavation, no card.
    "LR03_simple_question": (
        "宝宝多大可以开始吃盐？",
        "他现在九个月",
    ),
}

_LIST = re.compile(r"^\s*(?:[-*•]|\d+[.、)])", re.MULTILINE)


def measure(text: str) -> dict:
    stripped = (text or "").strip()
    return {
        "chars": len(stripped),
        "ends_q": int(stripped.endswith("？") or stripped.endswith("?")),
        "qs": stripped.count("？") + stripped.count("?"),
        "lists": len(_LIST.findall(stripped)),
    }


def run(branch: str) -> dict:
    """Every scenario, in this checkout, with the orchestration state carried
    the way a real conversation carries it."""
    import anyio

    from backend import llm_usage
    from backend.nuri_core.dialogue_reply import get_style_rules_ctx, nuri_reply_sync

    try:
        from backend.nuri_core import task_card as tc
    except ImportError:      # dev2 has no gate; that is the comparison
        tc = None

    llm_usage.new_request_id()
    llm_usage.set_user(f"eval:spec_compare:{branch}")
    style = anyio.run(get_style_rules_ctx)

    out: dict = {"branch": branch, "scenarios": {}}
    for name, turns in SCENARIOS.items():
        history: list[dict] = []
        state = tc.OrchestrationState() if tc else None
        rows, transcript = [], []
        for index, text in enumerate(turns, start=1):
            history.append({"role": "user", "text": text})
            reply = nuri_reply_sync(history, "", "", "", style)
            answer = reply.get("text") or ""
            history.append({"role": "ai", "text": answer})

            decision = None
            if tc is not None:
                state = tc.from_model(state, reply.get("orchestration") or {})
                state = state.with_turn(text, index * 2 - 1)
                verdict = tc.decide(state, conversation_id=name)
                decision = {
                    "action": verdict.action,
                    "reason": verdict.reason,
                    "stage": state.conversation_stage,
                    "complexity": state.scenario_complexity,
                    "acceptance": state.acceptance_strength,
                    "missing": list(verdict.readiness.missing),
                }
            rows.append({"turn": index, **measure(answer), "decision": decision})
            transcript.append({"parent": text, "nuri": answer, "decision": decision})
        out["scenarios"][name] = {"rows": rows, "transcript": transcript}
    return out


def report(paths: list[str]) -> None:
    """Counts side by side, then the transcripts. The transcripts are the part
    worth reading; the counts only say where to look."""
    runs = []
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            runs.append(json.load(fh))

    print(f"{'scenario':<24}" + "".join(f"{r['branch']:>28}" for r in runs))
    print(f"{'':<24}" + "".join(f"{'ends_q  chars  qs  lists':>28}" for r in runs))
    for name in SCENARIOS:
        cells = ""
        for run_data in runs:
            rows = run_data["scenarios"].get(name, {}).get("rows", [])
            if not rows:
                cells += f"{'—':>28}"
                continue
            asked = sum(r["ends_q"] for r in rows)
            chars = sorted(r["chars"] for r in rows)[len(rows) // 2]
            qs = sum(r["qs"] for r in rows)
            lists = sum(r["lists"] for r in rows)
            cells += f"{f'{asked}/{len(rows)}':>8}{chars:>7}{qs:>4}{lists:>7}  "
        print(f"{name:<24}{cells}")

    # The card decisions, which only one of the two builds makes.
    for run_data in runs:
        decisions = [
            (name, row["turn"], row["decision"])
            for name, block in run_data["scenarios"].items()
            for row in block["rows"] if row.get("decision")
        ]
        if not decisions:
            continue
        print(f"\n[{run_data['branch']}] card decisions")
        for name, turn, decision in decisions:
            print(f"  {name:<22} t{turn}  {decision['action']:<8} "
                  f"{decision['reason']:<28} {decision['stage']}")

    for run_data in runs:
        for name, block in run_data["scenarios"].items():
            print(f"\n---- {run_data['branch']} / {name} " + "-" * 24)
            for exchange in block["transcript"]:
                print(f"\n家长：{exchange['parent']}\nNURI：{exchange['nuri']}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--branch", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--report", nargs="*", default=None)
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    if args.report is not None:
        report(list(args.report))
        return
    if not (args.branch and args.out):
        raise SystemExit("need --branch and --out, or --report a.json b.json")

    calls = sum(len(t) for t in SCENARIOS.values())
    print(f"{len(SCENARIOS)} scenarios, {calls} gpt-5.5 calls, branch label {args.branch!r}")
    if not args.yes and input("run? [y/N] ").strip().lower() not in ("y", "yes"):
        raise SystemExit("aborted")

    result = run(args.branch)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
