"""Export every row of a Supabase project to JSON, one file per table.

    .venv/Scripts/python.exe backend/scripts/snapshot_project.py --env .env
    .venv/Scripts/python.exe backend/scripts/snapshot_project.py --env private/.env.prod.backup

This is not `pg_dump`. It captures rows, not schema — the schema already lives
in `supabase/migrations/`, and the two together are a complete restore path:
run the migrations into an empty project, then replay these files with
`restore_snapshot.py`. That split is deliberate. `supabase db dump` needs the
database password, which is not in any `.env` here; the service-role key is,
and PostgREST will hand over every row it is asked for.

Written before the account migration and again at client handoff, so "reset the
test environment" is a command rather than a reconstruction.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from dotenv import dotenv_values  # noqa: E402
from supabase import create_client  # noqa: E402

PAGE_SIZE = 500

#: Ordered so a restore can replay the files as listed: parents before the rows
#: that reference them. `chat_messages` follows `chat_sessions`, `favorites`
#: follows `collections`, and everything user-scoped follows `users`.
TABLES = (
    "users", "children", "chat_sessions", "chat_messages",
    "user_memories", "normalized_inputs", "follow_ups",
    "tasks", "collections", "favorites",
    "recommendation_events", "email_logs",
    "app_settings", "feed_cards", "nuri_style_rules", "nuri_directives",
    "source_domains", "books", "fix_reviewers",
    "chat_turn_logs", "llm_call_logs", "nuri_turn_outcomes", "nuri_turn_traces",
    "rag_chunks",
)


def fetch_all(client, table: str) -> list[dict] | None:
    """Page through one table. Returns None when the table does not exist."""
    rows: list[dict] = []
    start = 0
    while True:
        try:
            res = client.table(table).select("*").range(start, start + PAGE_SIZE - 1).execute()
        except Exception as exc:
            msg = str(exc)
            # PostgREST reports an unknown relation as PGRST205 ("not found in
            # the schema cache"), not as Postgres' own 42P01.
            if "PGRST205" in msg or "42P01" in msg or "does not exist" in msg:
                return None
            raise
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        start += PAGE_SIZE


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True, help="env file holding SUPABASE_URL / SERVICE_ROLE_KEY")
    ap.add_argument("--out", default=None, help="output directory (default: private/snapshots/<date>-<ref>)")
    args = ap.parse_args()

    env = dotenv_values(REPO_ROOT / args.env)
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print(f"[fail] {args.env} has no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
        return 2

    ref = url.split("//")[-1].split(".")[0]
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    out = Path(args.out) if args.out else REPO_ROOT / "private" / "snapshots" / f"{stamp}-{ref}"
    out.mkdir(parents=True, exist_ok=True)

    print(f"project: {ref}")
    print(f"output:  {out}")

    client = create_client(url, key)
    manifest: dict[str, object] = {
        "project_ref": ref, "taken_at": stamp, "tables": {}, "absent": [],
    }

    for table in TABLES:
        rows = fetch_all(client, table)
        if rows is None:
            print(f"  [absent] {table}")
            manifest["absent"].append(table)
            continue
        path = out / f"{table}.json"
        path.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        size = path.stat().st_size
        manifest["tables"][table] = {"rows": len(rows), "bytes": size}
        print(f"  [ok]     {table:24s} {len(rows):6d} rows  {size/1024:9.1f} KB")

    (out / "MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    total = sum(t["rows"] for t in manifest["tables"].values())
    print(f"\n[ok] {total} rows across {len(manifest['tables'])} tables -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
