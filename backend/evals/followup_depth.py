"""Does the conversation still keep asking, one thing at a time?

The complaint this measures. Before the register table, the two few-shot guards
stated one shape at full force — 接住 → 一个做法 → 用一个开放式问句收尾 — and
said 「问一个就好，但一定要问，而且放在最后」. Every reply therefore ended on a
question, and a parent describing their morning could be walked through it turn
by turn. The table split that sentence into two weighted clauses:

    shape  0.35   the three beats, demoted because at full force every reply
                  arrived visibly assembled out of them
    ask    0.25   「有真的想知道…就问出来；没有就不用硬凑一个」

0.25 renders under 「用得上就用，用不上完全可以不用」. So the model is now told
that asking is optional, and the conversation stops walking forward: it answers
the turn and waits. That is the regression, and it is one number.

Both failures are real, which is why this runs two groups rather than one:

    depth   a six-turn conversation, the one from the reported screenshot — a
            father in Houston, a ten-month-old, the mother covering the whole
            morning. Every turn is a fragment of the situation, never a
            question. What should come back is a short reply ending on the
            single most useful question. This is what the weights broke.

    light   a greeting and a meta turn. What the weights *fixed*: at full force
            「你好呀」 came back with an acknowledgement, a technique and a
            question about the parent's mood. Raising `ask` without watching
            this row trades one regression for the other.

Reported per turn:

    chars    length. Reply length correlated negatively with grader score in
             round one (r = -0.28), so more is not better here
    ends_q   1 when the reply's last sentence is a question. The metric the
             screenshot is about
    qs       question marks in the whole reply. Should be 1 on a depth turn:
             `one_question` is a hard clause, and more than one is its own bug
    lists    bulleted or numbered lines — the assembled-report shape

Profiles are the ladder, run top down, exactly as asked: everything at 1.0
first, then successively less until the depth rows keep ends_q and the light
rows stay short.

    .venv/Scripts/python.exe backend/evals/followup_depth.py --yes
    .venv/Scripts/python.exe backend/evals/followup_depth.py --profiles max,ask_hard --yes

Each profile runs in its own process, because `register` reads
NURI_REGISTER_WEIGHTS once at import and the persona is rendered from it at
import too. An in-process sweep would measure the first profile five times.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

#: The reported conversation, condensed. Every turn hands over a piece of the
#: situation without asking anything, which is exactly the case where a reply
#: that does not ask ends the conversation.
TURNS = (
    "那你来一步步了解我的家吧，你现在想从哪个问题开始？",
    "我早上6点就出去上班了，在我下班回到家之前，都是妈妈在照顾。",
    "我最快是中午12:30到1:00到家，有时候晚点会2点过才到家。",
    "我一般到家后就带小啊谷玩，然后妈妈就可以做饭。早上妈妈都没有时间做饭，"
    "早餐只能吃一些很快做好的食物，比如蒸包子。",
    "他一般会在8到9点左右小睡一下，但是现在他的精力越来越充沛，睡的时间越来越短了。",
    "大概二十分钟就醒了，醒来有时候会哭。",
    # The turn that actually breaks. Asked for a method, the reply hands over
    # the method and stops — which is a complete answer and a dead conversation.
    "那我该怎么帮他把这一觉睡长一点？",
)

#: What the demotion was for. These must not come back assembled, and `ack` in
#: particular must not come back with a manufactured question: a parent saying
#: "ok, I'll try it" has not asked for another round.
LIGHT_TURNS = (
    ("greet", "你好呀nuri，现在感觉如何呀？"),
    ("meta", "我其实刚刚在后台修改完你的聊天温度，我来观察一下情况"),
    ("ack", "好的，我试试看。"),
)

#: The ladder. "__all__" is expanded against the live clause table, so a clause
#: added later cannot sit at its default while the row claims everything is up.
PROFILES: dict[str, dict[str, float]] = {
    # 1. everything at full force
    "max": {"__all__": 1.0},
    # 2. everything at full force except the three-beat recipe, which is what
    #    made replies read assembled in the first place
    "max_no_shape": {"__all__": 1.0, "shape": 0.5},
    # 3. asking as a constraint
    "ask_hard": {"ask": 1.0},
    # 4. asking as a constraint, the recipe still a default
    "ask_hard_shape_mid": {"ask": 0.9, "shape": 0.5},
    # 5. asking merely the usual thing rather than a constraint
    "ask_default": {"ask": 0.5},
    # 6. the table as it stands
    "shipped": {},
    # 7. the floor: no clause about asking at all. What the table looks like
    #    with `ask` switched off, which is the comparison that says whether the
    #    clause is carrying the closing question or the corpus is.
    "ask_off": {"ask": 0},
    # 8-10. The advice turn is the one that does not ask, and `ask` at any
    #    weight does not move it. These test the other explanation: the reply
    #    is already at the ceiling by the time the question would be written,
    #    and `follow_through` is a hard clause spending four parts to get there.
    "ft_mid": {"follow_through": 0.5},
    "len_200": {},
    "ft_mid_len_200": {"follow_through": 0.5},
    # 11. The winner with the `ask` clause switched off, which is what says
    #     whether the rewritten clause is doing anything or whether the room
    #     alone was the fix.
    "ft_mid_ask_off": {"follow_through": 0.5, "ask": 0},
}

#: Anything a profile needs that is not a clause weight. The ceilings are read
#: from the environment by `register` at import, same as the weights are.
PROFILE_ENV: dict[str, dict[str, str]] = {
    "len_200": {"FEWSHOT_MAX_CHARS": "200"},
    "ft_mid_len_200": {"FEWSHOT_MAX_CHARS": "200"},
}

_LIST = re.compile(r"^\s*(?:[-*•]|\d+[.、)])", re.MULTILINE)


def measure(text: str) -> dict:
    stripped = (text or "").strip()
    return {
        "chars": len(stripped),
        # The last sentence, not merely "contains a question mark": a reply that
        # asks in the middle and then explains for three more lines is not the
        # shape the screenshot has.
        "ends_q": int(stripped.endswith("？") or stripped.endswith("?")),
        "qs": stripped.count("？") + stripped.count("?"),
        "lists": len(_LIST.findall(stripped)),
    }


def weights_for(profile: str) -> str:
    """Render one profile into a NURI_REGISTER_WEIGHTS value."""
    from backend.nuri_core import register

    spec = dict(PROFILES[profile])
    base = spec.pop("__all__", None)
    out: dict[str, float] = {}
    if base is not None:
        out = {rule.id: base for rule in register.REGISTER_RULES}
    out.update(spec)
    return ",".join(f"{k}={v}" for k, v in out.items())


# ── worker ───────────────────────────────────────────────────────────────────

def run_one(profile: str, reps: int = 1) -> dict:
    """One profile's conversation, in a process whose weights are already set.

    `reps` runs the whole conversation again from an empty history. One rep of
    one dialogue is not enough to separate 5/6 from 6/6 — the same profile came
    back with both — so a claim about a weight needs the repeat behind it.
    """
    import anyio

    from backend import llm_usage
    from backend.nuri_core.dialogue_reply import (
        get_style_rules_ctx,
        nuri_reply_sync,
    )

    llm_usage.new_request_id()
    llm_usage.set_user(f"eval:followup_depth:{profile}")
    # Always passed. The style rules are part of what shapes a reply, and an
    # eval that omits them is measuring a prompt the product never sends.
    style = anyio.run(get_style_rules_ctx)

    rows: list[dict] = []
    replies: list[tuple[str, str, str]] = []
    for rep in range(reps):
        history: list[dict] = []
        for index, text in enumerate(TURNS, start=1):
            history.append({"role": "user", "text": text})
            reply = nuri_reply_sync(history, "", "", "", style)["text"]
            history.append({"role": "ai", "text": reply})
            rows.append({"turn": f"d{index}", "rep": rep, **measure(reply)})
            if rep == 0:
                replies.append((f"d{index}", text, reply))
        for label, text in LIGHT_TURNS:
            reply = nuri_reply_sync(
                [{"role": "user", "text": text}], "", "", "", style,
            )["text"]
            rows.append({"turn": label, "rep": rep, **measure(reply)})
            if rep == 0:
                replies.append((label, text, reply))
    return {
        "profile": profile,
        "reps": reps,
        "style_chars": len(style),
        "rows": rows,
        "replies": replies,
    }


# ── runner ───────────────────────────────────────────────────────────────────

_COLUMNS = (("chars", 7), ("ends_q", 8), ("qs", 5), ("lists", 7))


def _median(values) -> int:
    ordered = sorted(values)
    return ordered[len(ordered) // 2] if ordered else 0


def _print_profile(result: dict) -> None:
    labels = [f"d{i}" for i in range(1, len(TURNS) + 1)]
    labels += [label for label, _ in LIGHT_TURNS]
    depth = [r for r in result["rows"] if r["turn"].startswith("d")]
    light = [r for r in result["rows"] if not r["turn"].startswith("d")]
    print()
    print(f"== {result['profile']} ({result.get('reps', 1)} reps) " + "=" * 34)
    print(f"{'turn':<8}" + "".join(f"{k:>{w}}" for k, w in _COLUMNS))
    for label in labels:
        group = [r for r in result["rows"] if r["turn"] == label]
        if not group:
            continue
        cells = ""
        for key, width in _COLUMNS:
            if key == "ends_q":
                cell = f"{sum(r[key] for r in group)}/{len(group)}"
            else:
                cell = str(_median(r[key] for r in group))
            cells += cell.rjust(width)
        print(f"{label:<8}{cells}")
    asked = sum(r["ends_q"] for r in depth)
    print(f"{'':<8}depth ends_q {asked}/{len(depth)}   "
          f"median chars {_median(r['chars'] for r in depth)}   "
          f"light median chars {_median(r['chars'] for r in light)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--profiles", default=",".join(PROFILES))
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--worker", default="")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    if args.worker:
        result = run_one(args.worker, args.reps)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
        return

    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
    unknown = [p for p in profiles if p not in PROFILES]
    if unknown:
        raise SystemExit(f"unknown profile(s): {unknown}")
    per_profile = (len(TURNS) + len(LIGHT_TURNS)) * args.reps
    print(f"{len(profiles)} profiles x {per_profile} turns "
          f"= {len(profiles) * per_profile} gpt-5.5 calls")
    for profile in profiles:
        rendered = weights_for(profile) or "(shipped defaults)"
        print(f"  {profile:<20} {rendered[:120]}")
    if not args.yes and input("run? [y/N] ").strip().lower() not in ("y", "yes"):
        raise SystemExit("aborted")

    # Profiles run in parallel; the turns inside one profile run in order,
    # because the whole question is whether turn six still knows turn one.
    tmp = tempfile.mkdtemp(prefix="followup_depth_")
    procs, outs = [], {}
    for profile in profiles:
        env = dict(os.environ)
        rendered = weights_for(profile)
        if rendered:
            env["NURI_REGISTER_WEIGHTS"] = rendered
        else:
            env.pop("NURI_REGISTER_WEIGHTS", None)
        env.update(PROFILE_ENV.get(profile, {}))
        outs[profile] = os.path.join(tmp, f"{profile}.json")
        procs.append((profile, subprocess.Popen(
            [sys.executable, os.path.abspath(__file__),
             "--worker", profile, "--out", outs[profile],
             "--reps", str(args.reps)],
            env=env, cwd=REPO_ROOT,
        )))

    results = []
    for profile, proc in procs:
        if proc.wait() != 0:
            print(f"[warn] {profile} exited {proc.returncode}")
            continue
        with open(outs[profile], encoding="utf-8") as fh:
            results.append(json.load(fh))

    for result in results:
        _print_profile(result)
    # The numbers are proxies; the transcripts are the evidence.
    for result in results:
        print(f"\n---- transcript: {result['profile']} " + "-" * 30)
        for label, user, reply in result["replies"]:
            print(f"\n[{label}] 家长：{user}\nNURI：{reply}")


if __name__ == "__main__":
    main()
