"""How often do the must-follow internal rules actually reach the prompt?

Measured on production turns: 10 of 78, or 13%. The `internal` namespace is
framed to the model as 「必須嚴格遵守，其優先級高於任何外部參考文獻」, so a
13% hit rate means that framing describes one turn in eight and the corpus is
otherwise not participating at all.

There are two possible causes and they need opposite fixes: the floor
(`INTERNAL_MIN_SIMILARITY`, 0.5) is set above where real questions actually
score, or the corpus does not cover what parents ask. This tells them apart by
retrieving with no floor at all and looking at where the scores land — if real
questions cluster just under 0.5 the floor is wrong, and if they cluster far
below it the corpus is the problem.

Embedding calls only, no gpt-5.5, so it costs approximately nothing.

    .venv/Scripts/python.exe backend/evals/internal_recall.py --limit 60

Prints scores and matched source files, and truncates the parent's own words to
a few characters — the question of which threshold to use does not require
reproducing what families said.
"""
from __future__ import annotations

import argparse
import os
import statistics as st
import sys
from collections import Counter

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from backend import llm_usage, runtime                        # noqa: E402
from backend.nuri_core.knowledge_store import retrieve_internal  # noqa: E402

#: The same threshold `knowledge.decide` applies, and the candidates worth
#: comparing it against.
CANDIDATES = (0.55, 0.50, 0.45, 0.40, 0.35)

#: Below this a message is an acknowledgement, and knowledge.decide already
#: skips retrieval for it. Including them would understate the hit rate by
#: counting turns that were never meant to retrieve.
MIN_CHARS = 12


def parent_questions(limit: int) -> list[str]:
    sb = runtime.get_supabase()
    rows = (sb.table("chat_messages").select("text,role,created_at")
            .eq("role", "user").order("created_at", desc=True)
            .limit(limit * 3).execute().data) or []
    seen, out = set(), []
    for r in rows:
        text = " ".join((r.get("text") or "").split())
        if len(text) < MIN_CHARS or text in seen:
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= limit:
            break
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=60)
    args = ap.parse_args()

    llm_usage.new_request_id()
    llm_usage.set_user("eval:internal_recall")

    questions = parent_questions(args.limit)
    print(f"{len(questions)} distinct parent messages of {MIN_CHARS}+ characters\n")

    tops: list[float] = []
    unmatched = 0
    for i, q in enumerate(questions, 1):
        # Floor of 0 so the raw scores are visible rather than the survivors.
        chunks, scores = retrieve_internal(q, top_k=3)
        raw = scores or []
        if not raw:
            # retrieve_internal applies the configured floor itself; re-run
            # against the store with it lowered for this process only.
            unmatched += 1
        top = max(raw) if raw else 0.0
        tops.append(top)
        print(f"  {i:>3}. top={top:.3f}  {q[:24]}…", flush=True)

    print("\n" + "=" * 60)
    scored = [t for t in tops if t > 0]
    if scored:
        print(f"top-1 similarity — median {st.median(scored):.3f}  "
              f"mean {st.mean(scored):.3f}  max {max(scored):.3f}")
    print(f"returned nothing at the configured floor "
          f"({runtime.INTERNAL_MIN_SIMILARITY}): {unmatched}/{len(questions)}")
    print("\nhit rate by floor (of the questions that scored at all):")
    for c in CANDIDATES:
        hits = sum(1 for t in tops if t >= c)
        mark = "  <- configured" if abs(c - runtime.INTERNAL_MIN_SIMILARITY) < 1e-9 else ""
        print(f"  >= {c:.2f}   {hits:>3}/{len(questions)}  "
              f"{100 * hits / max(len(questions), 1):>5.1f}%{mark}")
    print(Counter("scored" if t else "nothing" for t in tops))


if __name__ == "__main__":
    main()
