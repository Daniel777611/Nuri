"""
backend/scripts/backfill_style_rules.py

Recovers `#fix` reviewer corrections that were never stored.

`nuri_style_rules` was referenced by the backend but never created — no
migration for it existed in the repo — so every `#fix` in chat distilled a rule,
failed to insert it, and answered "调整没能存上". The *raw* feedback survived:
`_prepare_turn` writes the user's message to `chat_messages` (and
`normalized_inputs`) before the `#fix` branch runs. Only the distillation was
lost, and distillation is reproducible.

This script finds those messages, re-runs the same distiller the live `#fix`
path uses, and writes the rules.

Usage:
    python backend/scripts/backfill_style_rules.py            # dry run
    python backend/scripts/backfill_style_rules.py --apply    # write them

Run supabase/nuri_style_rules_migration.sql first, or the insert has nothing to
write to. Re-running is safe: a rule whose source_note already exists is
skipped, so --apply twice does not duplicate.
"""
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import uuid  # noqa: E402

from backend.main import (  # noqa: E402
    FIX_KEYWORD,
    _distill_style_rule_sync,
    _get_supabase,
)


def main(apply: bool) -> int:
    sb = _get_supabase()
    if not sb:
        print("Supabase not configured (check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).")
        return 1

    try:
        res = (
            sb.table("chat_messages")
            .select("id,session_id,text,created_at")
            .like("text", f"{FIX_KEYWORD}%")
            .order("created_at", desc=False)
            .execute()
        )
    except Exception as e:
        print(f"Could not read chat_messages: {e}")
        return 1
    msgs = res.data or []
    if not msgs:
        print(f"No messages starting with {FIX_KEYWORD} found — nothing to recover.")
        return 0

    try:
        existing = sb.table("nuri_style_rules").select("source_note").execute()
        already = {(r.get("source_note") or "").strip() for r in (existing.data or [])}
    except Exception as e:
        print(f"Could not read nuri_style_rules — run the migration first.\n  {e}")
        return 1

    print(f"Found {len(msgs)} {FIX_KEYWORD} message(s); {len(already)} rule(s) already stored.\n")
    written = skipped = failed = 0

    for msg in msgs:
        feedback = (msg.get("text") or "").strip()[len(FIX_KEYWORD):].strip()
        when = (msg.get("created_at") or "")[:16]
        if not feedback:
            continue
        if feedback in already:
            print(f"[skip]  {when}  already stored: {feedback[:60]}")
            skipped += 1
            continue

        # The AI reply this corrected, for context — same lookup the live path
        # does, just resolved after the fact.
        prior = ""
        try:
            hist = (
                sb.table("chat_messages")
                .select("role,text,created_at")
                .eq("session_id", msg.get("session_id"))
                .lt("created_at", msg.get("created_at"))
                .order("created_at", desc=True)
                .limit(10)
                .execute()
            )
            prior = next((r.get("text", "") for r in (hist.data or []) if r.get("role") == "ai"), "")
        except Exception:
            pass

        rule = _distill_style_rule_sync(prior, feedback)
        if not rule.get("rule"):
            print(f"[fail]  {when}  could not distil: {feedback[:60]}")
            failed += 1
            continue

        print(f"[{'write' if apply else 'dry'}]   {when}  {rule['rule']}")
        print(f"          from: {feedback[:80]}")
        if not apply:
            continue
        try:
            sb.table("nuri_style_rules").insert({
                "id": str(uuid.uuid4()),
                "rule": rule["rule"],
                "category": rule.get("category"),
                "source_note": feedback,
                "active": True,
                "created_by": "backfill:#fix",
            }).execute()
            already.add(feedback)
            written += 1
        except Exception as e:
            print(f"          insert failed: {e}")
            failed += 1

    print()
    if apply:
        print(f"Done: {written} written, {skipped} skipped, {failed} failed.")
    else:
        print(f"Dry run: {len(msgs) - skipped - failed} would be written, "
              f"{skipped} skipped. Re-run with --apply to write them.")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main(apply="--apply" in sys.argv[1:]))
