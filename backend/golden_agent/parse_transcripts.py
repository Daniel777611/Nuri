"""Parse raw NURI golden-agent transcripts (.docx) into redacted, structured jsonl.

Input:  backend/golden_agent/raw/*.docx        (real customer chat exports, gitignored)
Output: backend/golden_agent/processed/turns.jsonl   one row per message turn
        backend/golden_agent/processed/pairs.jsonl   one row per (customer_msg -> agent_reply)

Usage:
    .venv/Scripts/python.exe backend/golden_agent/parse_transcripts.py
"""
from __future__ import annotations

import glob
import json
import os
import re

import docx

RAW_DIR = os.path.join(os.path.dirname(__file__), "raw")
OUT_DIR = os.path.join(os.path.dirname(__file__), "processed")

# a label line is either "NURI" (with optional emoji/colon) or "<name>:" / "<name>："
_AGENT_LABEL_RE = re.compile(r"^[^\w]{0,4}NURI[:：]?\s*$", re.IGNORECASE)
_NAMED_LABEL_RE = re.compile(r"^[^\s:：]{1,14}[:：]\s*$")

_PHONE_RE = re.compile(r"(\+?\d[\d\- ]{6,}\d)")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def _extract_paragraphs(path: str) -> list[str]:
    d = docx.Document(path)
    return [p.text.strip() for p in d.paragraphs if p.text.strip()]


def _find_labels(paragraphs: list[str]) -> set[str]:
    """Agent labels ("NURI", with or without emoji/colon) are matched directly --
    the regex is tight enough that false positives are effectively impossible.

    Customer name labels ("小雪:", "Abi:", ...) require repeating >=2 times, to
    filter out one-off narrative lines that happen to look like a label, e.g.
    "我先想問一個小問題：" appearing once inside NURI's own message.
    """
    counts: dict[str, int] = {}
    for p in paragraphs:
        if _NAMED_LABEL_RE.match(p) and not _AGENT_LABEL_RE.match(p):
            counts[p] = counts.get(p, 0) + 1
    labels = {label for label, n in counts.items() if n >= 2}
    labels |= {p for p in paragraphs if _AGENT_LABEL_RE.match(p)}
    return labels


def _redact(text: str, customer_name: str) -> str:
    text = text.replace(customer_name, "客户")
    text = _PHONE_RE.sub("[电话]", text)
    text = _EMAIL_RE.sub("[邮箱]", text)
    return text


def parse_file(path: str) -> list[dict]:
    paragraphs = _extract_paragraphs(path)
    labels = _find_labels(paragraphs)
    if not labels:
        print(f"  [warn] no speaker labels detected in {os.path.basename(path)}, skipping")
        return []

    customer_name = None
    for label in labels:
        if not _AGENT_LABEL_RE.match(label):
            customer_name = re.sub(r"[:：]\s*$", "", label).strip()
            break
    if customer_name is None:
        print(f"  [warn] could not determine customer name in {os.path.basename(path)}, skipping")
        return []

    turns: list[dict] = []
    speaker = None
    buffer: list[str] = []

    def flush():
        if speaker and buffer:
            text = "\n".join(buffer).strip()
            if text:
                turns.append({"speaker": speaker, "text": _redact(text, customer_name)})

    for p in paragraphs:
        if p in labels:
            flush()
            buffer = []
            speaker = "agent" if _AGENT_LABEL_RE.match(p) else "customer"
        else:
            buffer.append(p)
    flush()

    # merge consecutive turns from the same speaker (defensive, in case of
    # repeated re-labeling mid-message)
    merged: list[dict] = []
    for t in turns:
        if merged and merged[-1]["speaker"] == t["speaker"]:
            merged[-1]["text"] += "\n" + t["text"]
        else:
            merged.append(t)

    source = os.path.basename(path)
    for t in merged:
        t["source_file"] = source
        t["customer_id"] = _redact(customer_name, customer_name)  # anonymized tag, e.g. "客户"
    return merged


def build_pairs(turns: list[dict]) -> list[dict]:
    """Turn an alternating turn sequence into customer_msg -> agent_reply pairs."""
    pairs = []
    for i in range(len(turns) - 1):
        if turns[i]["speaker"] == "customer" and turns[i + 1]["speaker"] == "agent":
            pairs.append(
                {
                    "source_file": turns[i]["source_file"],
                    "customer_msg": turns[i]["text"],
                    "agent_reply": turns[i + 1]["text"],
                }
            )
    return pairs


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    files = sorted(glob.glob(os.path.join(RAW_DIR, "*.docx")))
    if not files:
        print(f"No .docx files found in {RAW_DIR}")
        return

    all_turns: list[dict] = []
    all_pairs: list[dict] = []
    for f in files:
        print(f"parsing {os.path.basename(f)} ...")
        turns = parse_file(f)
        pairs = build_pairs(turns)
        print(f"  -> {len(turns)} turns, {len(pairs)} customer->agent pairs")
        all_turns.extend(turns)
        all_pairs.extend(pairs)

    turns_path = os.path.join(OUT_DIR, "turns.jsonl")
    pairs_path = os.path.join(OUT_DIR, "pairs.jsonl")
    with open(turns_path, "w", encoding="utf-8") as fh:
        for t in all_turns:
            fh.write(json.dumps(t, ensure_ascii=False) + "\n")
    with open(pairs_path, "w", encoding="utf-8") as fh:
        for p in all_pairs:
            fh.write(json.dumps(p, ensure_ascii=False) + "\n")

    print(f"\nwrote {len(all_turns)} turns -> {turns_path}")
    print(f"wrote {len(all_pairs)} pairs -> {pairs_path}")
    print("\nNOTE: redaction only strips the per-file customer name, phone numbers, and emails.")
    print("Skim processed/turns.jsonl by hand before using it anywhere further -- free-text PII")
    print("(addresses, other names mentioned in passing, etc.) is not caught automatically.")


if __name__ == "__main__":
    main()
