"""Does the same turn come back equally warm in all three languages?

The complaint this measures: NURI reads noticeably livelier in 繁體中文 than in
简体中文 or English, and the English replies read like a leaflet. That was never
a persona problem. The register is carried by `exemplars`, and before the
English corpus existed `topic_of()` returned "" for every English sentence — so
an English parent got zero few-shot pairs, and the persona was the only thing
left holding the voice. Measured on nine sample turns: Chinese fired 6/6,
English 0/3.

This runs one scenario in three languages and reports what actually came back.
The counts are proxies, deliberately crude ones, and the replies are printed in
full underneath because that is the part worth reading:

    ack         structural, and the one worth trusting: does the reply open by
                addressing the parent rather than by advising them — a second
                person in the first line, and no advice verb in it
    warm_words  lexical, and weak: empathy phrasings in either language. A low
                count is not evidence of a cold reply, only that this list did
                not happen to contain the phrasing used
    clinical    the leaflet register — "ensure", "it is recommended",
                "consult", 「建议您」「应当」「须」
    lists       bulleted or numbered lines
    questions   question marks in the whole reply
    emoji

The claim being tested is that the three rows now look like each other. If
`en` alone loses `ack` or gains `clinical`, the English exemplars are the thing
to change — not the persona, and not the style rules.

Measured 2026-08-31, one rep, on the 八個月喝不飽 turn:

    lang     chars  ack  warm_words  clinical  lists  questions  emoji
    zh-TW       89    1           2         0      0          1      0
    zh-CN      100    1           1         0      0          1      0
    en         473    1           2         0      0          1      0

All three opened on the parent, none listed, none reached for the clinical
register, and each asked exactly one question. That is the result this was
built to check.

Two things the table does not say, and one rep cannot settle:

`chars` is not comparable here. The two Chinese replies withheld advice and
asked for the missing fact; the English one gave a thing to try and then asked.
Those are different reply types with different budgets, so 473 against 89 is
mostly that, not a language difference. Re-read it with --reps 3 before drawing
any conclusion about English running long.

`emoji` is 0 everywhere because style-warmth-01 sits below the advisory cap
after nuri_style_rules_selection.sql. The exemplars each carry one and the model
did not copy it. Expected, not a regression — but if the team wants the 💜 back,
that row's priority is the lever, not this file.

    .venv/Scripts/python.exe backend/evals/language_register.py
    .venv/Scripts/python.exe backend/evals/language_register.py --reps 3
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

from backend import llm_usage                                   # noqa: E402
from backend.nuri_core import exemplars                         # noqa: E402
from backend.nuri_core.dialogue_reply import (                  # noqa: E402
    get_style_rules_ctx,
    nuri_reply_sync,
)

#: One scenario, three languages, same facts. Same scenario on purpose: a
#: warmer reply to an easier question would prove nothing.
TURNS = (
    ("zh-TW", "寶寶八個月，最近怎麼喝都喝不飽，我真的快撐不住了"),
    ("zh-CN", "宝宝八个月，最近怎么喝都喝不饱，我真的快撑不住了"),
    ("en", "My eight-month-old never seems full no matter how much she drinks. "
           "I'm honestly at my limit."),
)

#: Widened after the first run scored 0 on all three languages while every
#: reply plainly did open with an acknowledgement — 「真的很煎熬」, 「很耗人」,
#: "sounds really scary and draining". A marker list calibrated on the corpus
#: and not on live output measures the corpus. It is kept because it is cheap
#: and occasionally catches a drift `ack` would miss, and reported as weak.
_WARMTH = re.compile(
    r"不容易|辛苦|煎熬|耗人|難受|难受|不好受|心疼|焦慮|焦虑"
    r"|很能理解|我懂|我明白|聽到你|听到你|不是你(?:的錯|的错|不夠|不够)"
    r"|很多(?:爸爸|媽媽|妈妈|父母|家長|家长)|已經在|已经在|你有在|願意|愿意"
    r"|a lot of parents|plenty of parents|that'?s (?:not easy|hard|a lot)"
    r"|isn'?t a sign|you'?re already|genuinely hard|real tired|that counts"
    r"|sounds (?:really |genuinely )?(?:hard|scary|draining|exhausting|rough|like a lot)"
    r"|hearing (?:you|that|“)|at your limit|no wonder",
    re.IGNORECASE,
)

#: Verbs that make a line advice rather than acknowledgement. Used only on the
#: first line — the rest of the reply is supposed to be full of them.
_ADVICE = re.compile(
    r"可以試|可以试|建議|建议|試試|试试|不妨|應該|应该|請|请"
    r"|\byou (?:can|could|should|might)\b|\btry\b|\bi'?d\b|\blet'?s\b",
    re.IGNORECASE,
)
_SECOND_PERSON = re.compile(r"你|您|\byou\b|\byour\b", re.IGNORECASE)
_CLINICAL = re.compile(
    r"建議您|建议您|應當|应当|須|请务必|应该要"
    r"|\bensure\b|\bit is recommended\b|\bconsult\b|\bshould be\b"
    r"|\bstudies (?:suggest|show)\b|\bit is (?:important|advisable)\b",
    re.IGNORECASE,
)
_LIST = re.compile(r"^\s*(?:[-*•]|\d+[.、)])", re.MULTILINE)
_EMOJI = re.compile(r"[\U0001F300-\U0001FAFF☀-➿]")


def measure(text: str) -> dict:
    first = next((l for l in text.splitlines() if l.strip()), "")
    return {
        "chars": len(text),
        # The register move the whole exercise is about: start from the parent,
        # not from the answer. Structural, so it survives any phrasing.
        "ack": int(bool(_SECOND_PERSON.search(first)) and not _ADVICE.search(first)),
        "warm_words": len(_WARMTH.findall(text)),
        "clinical": len(_CLINICAL.findall(text)),
        "lists": len(_LIST.findall(text)),
        "questions": text.count("？") + text.count("?"),
        "emoji": len(_EMOJI.findall(text)),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    style = anyio.run(get_style_rules_ctx)
    print(f"style block: {len(style)} chars")
    for label, text in TURNS:
        chosen = exemplars.select(text)
        print(f"  {label:<6} exemplars={len(chosen)} "
              f"({', '.join(e.id for e in chosen) or 'none'})")
    print(f"\n{len(TURNS) * args.reps} gpt-5.5 calls")
    if not args.yes and input("run? [y/N] ").strip().lower() not in ("y", "yes"):
        raise SystemExit("aborted")

    llm_usage.new_request_id()
    llm_usage.set_user("eval:language_register")

    replies: dict[str, list[str]] = {}
    print(f"\n{'lang':<8}{'chars':>7}{'ack':>5}{'warm_words':>12}{'clinical':>10}"
          f"{'lists':>7}{'questions':>11}{'emoji':>7}")
    for label, text in TURNS:
        history = [{"role": "user", "text": text}]
        outs = [nuri_reply_sync(history, "", "", "", style)["text"]
                for _ in range(args.reps)]
        replies[label] = outs
        rows = [measure(o) for o in outs]
        print(f"{label:<8}" + "".join(
            f"{st.median(r[k] for r in rows):>{w}.0f}"
            for k, w in (("chars", 7), ("ack", 5), ("warm_words", 12),
                         ("clinical", 10), ("lists", 7), ("questions", 11),
                         ("emoji", 7))
        ))

    # The numbers are proxies; this is the evidence.
    for label, outs in replies.items():
        print(f"\n──── {label} " + "─" * 40)
        print(outs[0])


if __name__ == "__main__":
    main()
