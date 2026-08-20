"""Does the reply keep its shape when you ask the same thing twice?

The reason this exists rather than a spot check: the model is sampled, and the
spread is wide enough to fake any conclusion you like from one run. Measured
here, on a prompt that was byte-identical between the two calls, the same
question produced 93 characters once and 212 the next — and one task card
against none. A single before/after comparison cannot tell that apart from a
change that worked.

So every question runs `--reps` times per arm and the report is percentiles.
The number that matters is the worst case, not the mean: a register that holds
nine times in ten is a register the parent does not experience as consistent.

    .venv/Scripts/python.exe backend/evals/variance.py --reps 3
    .venv/Scripts/python.exe backend/evals/variance.py --reps 5 --arms on

Writes JSON and a side-by-side HTML into backend/evals/out/, which is
gitignored — the replies are model output, not fixtures, and committing them
would invite reading one sample as the truth.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import statistics as st
import sys
import time
from datetime import datetime, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from backend import llm_usage, runtime                         # noqa: E402
from backend.nuri_core import exemplars                        # noqa: E402
from backend.nuri_core.dialogue_reply import NURI_FALLBACK, nuri_reply_sync  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")

#: Held out from `exemplars.CORPUS` on purpose, and `test_variance_eval.py`
#: fails if that ever stops being true. An eval whose questions are also the
#: few-shot examples measures copying, not transfer, and would report a perfect
#: score for a mechanism that had learned nothing.
QUESTIONS: tuple[dict, ...] = (
    {
        "id": "assess",
        "text": "我家兩歲十個月，講話還是只有兩三個字，需要去做語言評估嗎？",
    },
    {
        "id": "unclear",
        "text": "小孩會說話，但常常講不清楚，別人都聽不懂，怎麼辦？",
    },
    {
        "id": "school-mute",
        "text": "在家很會說話，去幼兒園都不開口，正常嗎？",
    },
    {
        # Simplified on purpose: the corpus is Traditional, and the reply must
        # follow the parent rather than the examples.
        "id": "bilingual-zhs",
        "text": "双语家庭是不是会让孩子说话比较慢？",
    },
    {
        "id": "rote",
        "text": "他會背整首兒歌，但不會用來跟我要東西，這樣算會表達嗎？",
    },
    {
        # Carries history, and the prior replies are real output from before the
        # exemplars existed. The obvious way for a few-shot to fail is to be
        # outvoted by twenty of the model's own long replies sitting nearer the
        # end of the prompt, so one question has to test that.
        "id": "unclear-in-context",
        "text": "小孩會說話，但常常講不清楚，別人都聽不懂，怎麼辦？",
        "history": "long_prior",
    },
    {
        # Off-domain: the gate must stay shut, and this arm doubles as the noise
        # floor — its two arms send an identical prompt, so any difference
        # between them is sampling, not the change.
        #
        # Screen time rather than sleep. Sleep was the control until it got its
        # own exemplars; a control that stopped being a control was measuring
        # the change against itself.
        "id": "screen-control",
        "text": "一天可以讓他看多久平板？我怕看太多對眼睛不好",
    },
)

#: Real replies from before the register work, kept verbatim. A strawman written
#: to lose would make the multi-turn question meaningless.
HISTORIES: dict[str, tuple[tuple[str, str], ...]] = {
    "long_prior": (
        ("我家寶寶兩歲十個月，最近不太愛講話",
         "你這個擔心是有道理的。兩歲十個月，如果大多數表達還停在「兩三個字」，我會建議不要再單純等，"
         "先安排一次語言／兒童發展評估。\n\n"
         "原因不是說孩子一定有問題，而是這個年紀通常已經會開始用比較多短句表達需求、描述事情，"
         "例如「媽媽抱我」「我要喝水」「車車不見了」。\n\n"
         "我會建議你做兩件事：\n"
         "1. 先預約語言治療師或兒童發展聯合評估。\n"
         "2. 同時確認聽力，因為有些孩子看起來「聽得到」，但中耳積水會讓語音變模糊。"),
        ("他都用「那個那個」代替所有東西",
         "先不用急著「糾正」成考試那種感覺。孩子用「那個那個」代替很多名稱，常見原因是："
         "他知道自己想要什麼，但當下詞彙提取還不夠快。\n\n"
         "比較好的做法是：不要說「不對，這叫水杯」，而是幫他把話補完整。\n\n"
         "比如他指著說：「那個那個。」\n你可以說：\n「你想要水杯，對嗎？這是水杯。」"),
    ),
}

_LIST = re.compile(r"^\s*(?:[0-9０-９]+[.、)）]|[一二三四五六七八九十]+[.、)）]|[-*·•])", re.M)
_EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿\U0001F900-\U0001F9FF]")

#: Does the reply open by answering the parent rather than by stating a fact?
#:
#: The signal is structural, not a word list: the first line is *about them*
#: — it says 你, or it is one of the acknowledgements the transcript opens on.
#: A keyword list was tried first and called eight warm openers cold, because
#: 「你還願意繼續讀，這件事本身就很好」 is warmth without any of its words in it.
#: Structural also means it cannot be gamed by dropping in 「辛苦了」 and
#: carrying on coldly, which a sentiment score would have rewarded.
_WARM_OPENER = re.compile(
    "[你妳您]|^(?:哈哈|哇|原來|原来|謝謝|谢谢|聽起來|听起来|我懂|我能理解|看得出|辛苦)"
)


#: Reported in this order, and the first is the one the ceiling is set on.
METRICS = (
    "chars", "paragraphs", "list_items", "numbered_q", "bold", "questions", "emoji",
    "task_cards", "ends_q", "warm_open",
)


#: A call the API refused comes back as this exact string, so a dead run is
#: identifiable rather than inferred from suspiciously tidy numbers.
_FALLBACK_TEXT = (NURI_FALLBACK.get("text") or "").strip()


def is_fallback(reply: dict) -> bool:
    return bool(_FALLBACK_TEXT) and (reply.get("text") or "").strip() == _FALLBACK_TEXT


def score(reply: dict) -> dict:
    text = reply.get("text") or ""
    lines = [p for p in text.split("\n") if p.strip()]
    closing = lines[-1] if lines else ""
    opening = lines[0] if lines else ""
    return {
        # Newlines excluded, the way the ceiling is applied — the register uses
        # several short lines, so counting them would penalise its own shape.
        "chars": len(text.replace("\n", "")),
        #: Excluded from every statistic below. Scoring the apology string as a
        #: reply is how a fully-failed run once reported a perfect register.
        "failed": is_fallback(reply),
        "paragraphs": len(lines),
        "list_items": len(_LIST.findall(text)),
        # A numbered *step* is wanted; a numbered *question* is the five-question
        # report this work exists to remove. Only the second is a defect, so the
        # two cannot share a counter.
        "numbered_q": sum(
            1 for line in text.splitlines()
            if _LIST.match(line) and "\uff1f" in line
        ),
        "bold": text.count("**") // 2,
        "questions": text.count("？") + text.count("?"),
        "emoji": len(_EMOJI.findall(text)),
        "task_cards": len(reply.get("task_proposals") or []),
        "ends_q": 1 if closing.rstrip().rstrip("😊💛😄🤍 ").endswith(("？", "?")) else 0,
        "warm_open": 1 if _WARM_OPENER.search(opening) else 0,
    }


def history_for(question: dict) -> list[dict]:
    turns: list[dict] = []
    for user, ai in HISTORIES.get(question.get("history") or "", ()):
        turns.append({"role": "user", "text": user})
        turns.append({"role": "ai", "text": ai})
    turns.append({"role": "user", "text": question["text"]})
    return turns


def pctile(values: list[float], q: float) -> float:
    v = sorted(values)
    return v[min(int(len(v) * q), len(v) - 1)] if v else 0


def style_rules_ctx() -> str:
    """The operator rules that go into every production turn.

    Left out of the first version of this eval, which made every number it
    produced optimistic: production ships 1,600 characters of always-on rules
    that include 「先用编号列出 3-5 个具体问题」 and 「用条列，每条一件事」, and
    measuring the register without them measures a prompt the app never sends.
    """
    sb = runtime.get_supabase()
    if not sb:
        return ""
    rows = (sb.table("nuri_style_rules").select("rule")
            .eq("active", True).order("created_at", desc=True)
            .limit(50).execute().data) or []
    return "\n".join(f"- {r['rule']}" for r in rows)


def run(reps: int, arms: tuple[str, ...], style: str = "") -> list[dict]:
    results = []
    for i, q in enumerate(QUESTIONS, 1):
        history = history_for(q)
        chosen = exemplars.select(q["text"])
        row = {
            "id": q["id"],
            "question": q["text"],
            "history_turns": len(history) - 1,
            "exemplars": [e.id for e in chosen],
            "arms": {},
        }
        for arm in arms:
            # `ceiling` is the arm that separates the sentence from the
            # examples. The guard the exemplars carry has always stated the
            # length, so "on" against "off" was never able to say which of the
            # two was doing the work.
            exemplars.ENABLED = arm == "on"
            exemplars.GLOBAL_CEILING = arm == "ceiling"
            samples = []
            for rep in range(reps):
                print(f"  {q['id']:<20} {arm:>3}  {rep + 1}/{reps}", flush=True)
                started = time.perf_counter()
                reply = nuri_reply_sync(history, "", "", "", style)
                samples.append({
                    "text": reply.get("text") or "",
                    "ms": int((time.perf_counter() - started) * 1000),
                    **score(reply),
                })
            row["arms"][arm] = samples
        results.append(row)
    exemplars.ENABLED = True
    exemplars.GLOBAL_CEILING = False
    return results


def report(results: list[dict], arms: tuple[str, ...], ceiling: int) -> None:
    print("\n" + "=" * 96)
    print(f"{'question':<24}{'arm':<6}" + "".join(f"{m[:9]:>10}" for m in METRICS)
          + f"{'p90 ch':>9}{'max ch':>9}")
    print("=" * 96)
    for r in results:
        gate = "" if r["exemplars"] else "  (gate shut)"
        for arm in arms:
            s = r["arms"][arm]
            chars = [x["chars"] for x in s]
            head = r["id"] if arm == arms[0] else ""
            print(f"{head:<24}{arm:<6}"
                  + "".join(f"{st.median(x[m] for x in s):>10.0f}" for m in METRICS)
                  + f"{pctile(chars, .9):>9.0f}{max(chars):>9.0f}"
                  + (gate if arm == arms[-1] else ""))
    print("=" * 96)

    # The headline. Questions whose gate stayed shut are excluded from the
    # register numbers — nothing was injected, so they measure only sampling.
    fired = [r for r in results if r["exemplars"]]
    for arm in arms:
        flat = [x for r in fired for x in r["arms"][arm] if not x.get("failed")]
        if not flat:
            print(f"  [{arm}] no reply survived — every call failed")
            continue
        chars = [x["chars"] for x in flat]
        struct = sum(1 for x in flat if x["bold"] or x["numbered_q"])
        over = sum(1 for x in flat if x["chars"] > ceiling)
        steps = sum(1 for x in flat if x["list_items"])
        print(f"  [{arm}] n={len(flat):<4} median {st.median(chars):>5.0f}  "
              f"p90 {pctile(chars, .9):>5.0f}  max {max(chars):>5.0f}   "
              f"over {ceiling}: {over}/{len(flat)}   "
              f"bold-or-numbered-q: {struct}/{len(flat)}   steps: {steps}/{len(flat)}")

    # Said before the table rather than after it, because the table is what gets
    # screenshotted.
    every = [x for r in results for arm in r["arms"] for x in r["arms"][arm]]
    dead = sum(1 for x in every if x.get("failed"))
    if dead:
        share = dead / max(len(every), 1)
        print(f"\n  !! {dead}/{len(every)} calls returned the fallback string "
              f"({share:.0%}). Those rows are excluded from every number above.")
        if share > 0.2:
            print("  !! Too many to call this a measurement. Nothing here is a "
                  "result — fix the API access and run it again.")

    for r in results:
        if r["exemplars"]:
            continue
        spread = {arm: (min(x["chars"] for x in r["arms"][arm]),
                        max(x["chars"] for x in r["arms"][arm])) for arm in arms}
        print(f"\n  noise floor ({r['id']}, identical prompt in every arm): {spread}")
        print("  Any before/after difference smaller than this spread is not a result.")


def write_html(results: list[dict], arms: tuple[str, ...], path: str) -> None:
    blocks = []
    for r in results:
        cells = []
        for arm in arms:
            samples = "".join(
                f"<div class=s><b>{x['chars']}字</b> · {x['paragraphs']}段 · "
                f"{x['list_items']}列 · {x['task_cards']}卡 · {x['ms']}ms"
                f"<p>{html.escape(x['text'])}</p></div>"
                for x in r["arms"][arm]
            )
            cells.append(f"<td><h4>{arm}</h4>{samples}</td>")
        blocks.append(
            f"<tr><td class=q><b>{html.escape(r['id'])}</b><p>{html.escape(r['question'])}</p>"
            f"<small>history: {r['history_turns']} · exemplars: "
            f"{', '.join(r['exemplars']) or '—'}</small></td>{''.join(cells)}</tr>"
        )
    doc = f"""<meta charset="utf-8"><title>NURI reply variance</title>
<style>
body{{font-family:system-ui,sans-serif;font-size:13px;margin:16px}}
table{{border-collapse:collapse;width:100%}}
td{{border:1px solid #ccc;padding:8px;vertical-align:top;width:{100 // (len(arms) + 1)}%}}
td.q{{background:#f6f6f6}}
.s{{border-top:1px dashed #ddd;padding:6px 0;color:#666}}
.s p{{white-space:pre-wrap;color:#111;margin:4px 0 0}}
h4{{margin:0 0 6px}}
</style>
<h2>NURI reply variance — {len(results)} questions x {len(results[0]['arms'][arms[0]])} runs</h2>
<p>Each cell is every sample, not a summary. Read down a column: that is what one
parent could have got instead of what they did.</p>
<table>{''.join(blocks)}</table>"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(doc)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--reps", type=int, default=3, help="runs per question per arm")
    ap.add_argument("--arms", default="off,ceiling,on",
                    help="comma-separated: off (nothing), ceiling (the rule "
                         "alone), on (the exemplars, whose guard states it too)")
    ap.add_argument("--yes", action="store_true", help="skip the cost confirmation")
    ap.add_argument("--no-style-rules", action="store_true",
                    help="omit the always-on operator rules; the prompt then "
                         "differs from production, so say so when quoting results")
    args = ap.parse_args()

    arms = tuple(a.strip() for a in args.arms.split(",") if a.strip())
    for a in arms:
        if a not in ("off", "ceiling", "on"):
            raise SystemExit(f"unknown arm {a!r}; use off, ceiling and/or on")

    calls = len(QUESTIONS) * len(arms) * args.reps
    print(f"{len(QUESTIONS)} questions x {len(arms)} arms x {args.reps} reps = "
          f"{calls} gpt-5.5 calls")
    if not args.yes and input("run? [y/N] ").strip().lower() not in ("y", "yes"):
        raise SystemExit("aborted")

    # Tag the run so eval traffic is filterable out of the spend tables. Without
    # it these land beside real turns, and "which account is burning the quota"
    # gets an eval-shaped answer.
    llm_usage.new_request_id()
    llm_usage.set_user("eval:variance")

    style = "" if args.no_style_rules else style_rules_ctx()
    print(f"style rules in prompt: {len(style)} chars"
          f"{' (OMITTED — not production-shaped)' if not style else ''}")

    os.makedirs(OUT_DIR, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    results = run(args.reps, arms, style)
    report(results, arms, exemplars.MAX_CHARS)

    base = os.path.join(OUT_DIR, f"variance_{stamp}")
    with open(base + ".json", "w", encoding="utf-8") as fh:
        json.dump({
            "stamp": stamp, "reps": args.reps, "arms": list(arms),
            "ceiling": exemplars.MAX_CHARS, "results": results,
        }, fh, ensure_ascii=False, indent=2)
    write_html(results, arms, base + ".html")
    print(f"\nwrote {base}.json\n      {base}.html")


if __name__ == "__main__":
    main()
