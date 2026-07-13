"""Compare the current NURI MVP's replies against the golden-agent's real
replies, feeding the MVP the same real conversation history so the comparison
is apples-to-apples (not just single isolated turns).

Input:  backend/golden_agent/processed/turns.jsonl
        backend/golden_agent/processed/pairs_tagged.jsonl
Output: backend/golden_agent/processed/eval_compare.jsonl
        backend/golden_agent/processed/eval_compare.html   (side-by-side view)

Usage:
    .venv/Scripts/python.exe backend/golden_agent/eval_compare.py
"""
from __future__ import annotations

import html
import json
import os
import sys
from collections import defaultdict

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from backend.main import _nuri_reply_sync  # noqa: E402

PROC_DIR = os.path.join(os.path.dirname(__file__), "processed")
TURNS_PATH = os.path.join(PROC_DIR, "turns.jsonl")
TAGGED_PATH = os.path.join(PROC_DIR, "pairs_tagged.jsonl")
OUT_JSONL = os.path.join(PROC_DIR, "eval_compare.jsonl")
OUT_HTML = os.path.join(PROC_DIR, "eval_compare.html")


def _load_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh]


def _role(speaker: str) -> str:
    return "user" if speaker == "customer" else "ai"


def build_eval_rows():
    turns = _load_jsonl(TURNS_PATH)
    tagged = _load_jsonl(TAGGED_PATH)

    by_file = defaultdict(list)
    for t in turns:
        by_file[t["source_file"]].append(t)

    # Reconstruct (history, customer_msg, golden_reply) using the exact same
    # customer->agent pairing rule as build_pairs() in parse_transcripts.py,
    # so this lines up index-for-index with pairs_tagged.jsonl.
    reconstructed = []
    for source_file in sorted(by_file):
        file_turns = by_file[source_file]
        history: list[dict] = []
        for i in range(len(file_turns) - 1):
            history.append({"role": _role(file_turns[i]["speaker"]), "text": file_turns[i]["text"]})
            if file_turns[i]["speaker"] == "customer" and file_turns[i + 1]["speaker"] == "agent":
                reconstructed.append(
                    {
                        "source_file": source_file,
                        "history": list(history),  # ends with this customer turn
                        "customer_msg": file_turns[i]["text"],
                        "golden_reply": file_turns[i + 1]["text"],
                    }
                )

    if len(reconstructed) != len(tagged):
        raise SystemExit(
            f"row count mismatch: reconstructed={len(reconstructed)} tagged={len(tagged)} -- "
            "turns.jsonl/pairs_tagged.jsonl are out of sync, re-run parse_transcripts.py + tag_scenarios.py"
        )

    rows = []
    for recon, tag in zip(reconstructed, tagged):
        if recon["customer_msg"] != tag["customer_msg"]:
            raise SystemExit(
                f"mismatch in {recon['source_file']}: {recon['customer_msg']!r} != {tag['customer_msg']!r}"
            )
        extra = {k: v for k, v in tag.items() if k not in ("source_file", "customer_msg", "agent_reply")}
        rows.append({**recon, **extra})
    return rows


def main():
    rows = build_eval_rows()
    print(f"{len(rows)} rows to evaluate")

    results = []
    for i, row in enumerate(rows, 1):
        print(f"generating MVP reply {i}/{len(rows)} ({row['source_file']}) ...")
        mvp = _nuri_reply_sync(row["history"])
        results.append({**row, "mvp_reply": mvp["text"]})

    with open(OUT_JSONL, "w", encoding="utf-8") as fh:
        for r in results:
            out = {k: v for k, v in r.items() if k != "history"}
            fh.write(json.dumps(out, ensure_ascii=False) + "\n")
    print(f"\nwrote {len(results)} rows -> {OUT_JSONL}")

    _write_html(results)
    print(f"wrote side-by-side view -> {OUT_HTML}")


def _write_html(results):
    rows_html = []
    for r in results:
        rows_html.append(
            f"""
        <tr>
          <td>{html.escape(r['source_file'])}</td>
          <td>{html.escape(r['scenario_category'])}<br><small>{html.escape(r['agent_move'])}</small></td>
          <td>{html.escape(r['customer_msg'])}</td>
          <td>{html.escape(r['golden_reply'])}</td>
          <td>{html.escape(r['mvp_reply'])}</td>
        </tr>"""
        )
    doc = f"""<!doctype html><html><head><meta charset="utf-8">
<title>NURI golden vs MVP</title>
<style>
body{{font-family:sans-serif;font-size:14px}}
table{{border-collapse:collapse;width:100%}}
td,th{{border:1px solid #ccc;padding:6px;vertical-align:top;white-space:pre-wrap}}
th{{background:#eee;position:sticky;top:0}}
</style></head><body>
<h2>NURI: 金牌员工回复 vs 当前MVP回复</h2>
<table>
<tr><th>文件</th><th>场景/动作</th><th>客户消息</th><th>金牌回复(真人)</th><th>MVP回复(当前prompt)</th></tr>
{''.join(rows_html)}
</table>
</body></html>"""
    with open(OUT_HTML, "w", encoding="utf-8") as fh:
        fh.write(doc)


if __name__ == "__main__":
    main()
