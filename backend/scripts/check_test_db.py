"""Verify a freshly migrated Supabase project before anything is run against it.

    .venv/Scripts/python.exe backend/scripts/check_test_db.py

Reads credentials from the environment only, and never prints them. "The
migrations ran" and "the app will work" are different claims: a table can exist
while the seed rows behind NURI's voice are missing, and a reply assembled
without `nuri_style_rules` or the internal knowledge namespace is not the
product anyone means to grade. This checks both.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO_ROOT / ".env")

from supabase import create_client  # noqa: E402

#: Every table the request path touches. Missing entries degrade in different
#: ways — some silently — so they are reported individually rather than as one
#: pass/fail.
REQUIRED = (
    "users", "children",
    "user_memories", "follow_ups", "normalized_inputs",
    "chat_sessions", "chat_messages",
    "nuri_style_rules", "nuri_directives",
    "rag_chunks",
    "tasks", "favorites", "collections",
    "app_settings",
)

#: Absent ones degrade gracefully by design (see the architecture map §7.2),
#: so they are listed apart from a real failure.
OPTIONAL = (
    "books", "source_domains",
    "nuri_turn_outcomes", "recommendation_events",
    "chat_turn_logs", "llm_call_logs", "nuri_turn_traces",
    "feed_cards", "fix_reviewers", "email_logs",
)


def main() -> int:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        print("[fail] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env")
        return 2

    # Host only. The key never reaches stdout, and neither does the full URL.
    print(f"project host: {url.split('//')[-1].split('.')[0]}")
    client = create_client(url, key)

    def count(table: str):
        """Row count, or the reason the table could not be read."""
        try:
            res = client.table(table).select("*", count="exact").limit(1).execute()
            return res.count if res.count is not None else len(res.data or [])
        except Exception as exc:                      # noqa: BLE001 - reported
            return f"ERR {type(exc).__name__}"

    missing: list[str] = []
    print("\nrequired tables")
    for table in REQUIRED:
        rows = count(table)
        if isinstance(rows, str):
            missing.append(table)
            print(f"  [MISSING] {table:<22} {rows}")
        else:
            print(f"  [ok]      {table:<22} {rows} rows")

    print("\noptional tables (absent = graceful degradation, not a failure)")
    for table in OPTIONAL:
        rows = count(table)
        label = "--" if isinstance(rows, str) else f"{rows} rows"
        print(f"  {'[ok]     ' if not isinstance(rows, str) else '[absent] '}{table:<22} {label}")

    # Two content checks. Empty tables pass every schema check and still leave
    # the reply model without the voice and the rules that define it.
    print("\nseed content")
    style_rows = count("nuri_style_rules")
    if isinstance(style_rows, int) and style_rows > 0:
        print(f"  [ok]      nuri_style_rules       {style_rows} rows")
    else:
        print("  [EMPTY]   nuri_style_rules       run supabase/nuri_style_rules_seed.sql")

    namespace = os.getenv("INTERNAL_VECTOR_NAMESPACE", "internal")
    try:
        res = (
            client.table(os.getenv("SUPABASE_VECTOR_TABLE", "rag_chunks"))
            .select("*", count="exact").eq("namespace", namespace).limit(1).execute()
        )
        chunks = res.count or 0
        if chunks:
            print(f"  [ok]      rag_chunks/{namespace:<12} {chunks} chunks")
        else:
            print(
                f"  [EMPTY]   rag_chunks/{namespace:<12} "
                "run backend/scripts/ingest_internal_docs.py"
            )
    except Exception as exc:                          # noqa: BLE001 - reported
        print(f"  [ERR]     rag_chunks             {type(exc).__name__}")

    if missing:
        print(f"\n[fail] {len(missing)} required table(s) missing: {', '.join(missing)}")
        return 1
    print("\n[ok] every required table is present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
