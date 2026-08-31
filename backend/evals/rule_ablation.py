"""Which of the always-on rules actually shape the reply?

`nuri_style_rules` goes into every prompt — 22 active rows, 1,600 characters,
framed as 必须遵守. They accumulated one `#fix` at a time, nobody has read them
as a set since, and several of them ask for the exact thing the register work
exists to remove:

    「资讯不足时，先用编号列出 3-5 个具体问题，一次问完」
    「不要只問一題，應一次提出 3–4 個彼此相關的問題」
    「用条列，每条一件事」
    「开头放一个 💜。整段结束时偶尔用 🤍 收尾」
    「在給出具體建議後，主動補上一個開放式追問」

They also contradict each other: one row says 「不要在句子里先给出多个选项让对方
选择」 and another says 「给选项让对方对号入座」.

So the model listing five numbered questions was never it ignoring the persona.
It was following instructions — a different set, that live in a table rather
than in the code, and that nothing in the repo points at.

This measures the split. Four conditions on an off-domain question, so no
exemplar is in play and the rules are the only thing acting: all rules, all but
the suspects, only the suspects, and none. If `minus` looks like `none` and
`only` looks like `all`, the suspects are the cause.

Measured 2026-08-15 on 寶寶晚上一直哭:

    all     266 chars   5.0 lists   6.0 questions   1.0 emoji
    minus   112         0.0         1.0             0.0
    only    300         5.0         8.0             1.0
    none     86         0.0         1.0             0.0

Five rows out of twenty-two produce essentially all of it, and deactivating them
would do for every topic what the exemplars do for one. Which is a content
decision for whoever wrote them — several encode a real intent, gathering a
parent's situation in one round trip instead of five — so this only measures.

That decision was made on 2026-08-31 (nuri_style_rules_selection.sql): the five
were rewritten rather than switched off, so the intent survives as the exception
instead of the instruction, and the rest of the table became advisory and capped.
So this script now runs five conditions, not four. `all` is the *old* behaviour
— every rule, under 必须遵守 — and stays here as the before picture. `shipped`
is what the prompt actually carries now. The claim being tested is that
`shipped` sits near `minus`, not near `all`.

`shipped` covers the unconditional rules only. The conditional half is selected
per turn by `dialogue.plan` against facts this script has none of, so a rule
gated on `has_sources` or `min_turns` cannot appear here and its absence is not
evidence about it either way.

    .venv/Scripts/python.exe backend/evals/rule_ablation.py
"""
from __future__ import annotations

import argparse
import os
import re
import statistics as st
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import anyio                                                    # noqa: E402

from backend import llm_usage, runtime                          # noqa: E402
from backend.evals.variance import score                        # noqa: E402
from backend.nuri_core import dialogue                          # noqa: E402
from backend.nuri_core.dialogue_reply import (                  # noqa: E402
    get_style_rules_ctx,
    nuri_reply_sync,
)

#: Off-domain on purpose: with an exemplar in the prompt the rules are no longer
#: the only thing acting, and the ablation would measure the wrong contest.
QUESTION = "寶寶晚上一直哭，怎麼哄都不睡，需要調整作息嗎？"

#: Matched on a distinctive fragment rather than by row id, so the grouping is
#: readable here and survives rows being reordered or re-created.
SUSPECT_MARKERS = ("编号列出", "3–4 個", "用条列", "💜", "主動補上一個")


def active_rules() -> list[str]:
    sb = runtime.get_supabase()
    if not sb:
        return []
    rows = (sb.table("nuri_style_rules").select("rule")
            .eq("active", True).order("created_at", desc=True)
            .limit(50).execute().data) or []
    return [r["rule"] for r in rows if (r.get("rule") or "").strip()]


def is_suspect(rule: str) -> bool:
    return any(m in rule for m in SUSPECT_MARKERS)


def _block(rules: list[str]) -> str:
    """Render an ablation condition the way the table used to be injected.

    The heading is part of the condition, not decoration. `nuri_messages` now
    appends style_ctx verbatim — the 必须遵守 wrapper it used to add moved into
    get_style_rules_ctx — so a bare bullet list here would quietly measure a
    prompt nobody ever shipped.
    """
    if not rules:
        return ""
    body = "\n".join(f"- {r}" for r in rules)
    return f"{dialogue.HEADINGS['always']}\n{body}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    rules = active_rules()
    if not rules:
        raise SystemExit("no active style rules — nothing to ablate")
    suspects = [r for r in rules if is_suspect(r)]
    rest = [r for r in rules if not is_suspect(r)]

    print(f"{len(rules)} active rules — {len(suspects)} suspected of shaping "
          f"the reply, {len(rest)} others")
    for s in suspects:
        print(f"   {s[:76]}")
    print(f"\n{5 * args.reps} gpt-5.5 calls")
    if not args.yes and input("run? [y/N] ").strip().lower() not in ("y", "yes"):
        raise SystemExit("aborted")

    llm_usage.new_request_id()
    llm_usage.set_user("eval:rule_ablation")

    history = [{"role": "user", "text": QUESTION}]
    conditions = (
        # The old behaviour, kept as the baseline this is measured against.
        ("all", _block(rules)),
        ("minus", _block(rest)),
        ("only", _block(suspects)),
        # What the prompt carries today: must rules under 必须遵守, the top
        # advisory ones under a heading that says to pick what fits.
        ("shipped", anyio.run(get_style_rules_ctx)),
        ("none", ""),
    )
    print(f"\n{'condition':<10}{'chars':>8}{'lists':>8}{'questions':>11}{'emoji':>8}")
    for name, ctx in conditions:
        samples = [score(nuri_reply_sync(history, "", "", "", ctx))
                   for _ in range(args.reps)]
        print(f"{name:<10}"
              + "".join(f"{st.median(s[k] for s in samples):>8.1f}"
                        if k != "questions" else
                        f"{st.median(s[k] for s in samples):>11.1f}"
                        for k in ("chars", "list_items", "questions", "emoji")))


if __name__ == "__main__":
    main()
