"""Replay a `snapshot_project.py` export into a Supabase project.

    # see what would happen
    .venv/Scripts/python.exe backend/scripts/restore_snapshot.py \
        --env .env --snapshot private/snapshots/<dir>

    # put the project back exactly as the snapshot found it
    .venv/Scripts/python.exe backend/scripts/restore_snapshot.py \
        --env .env --snapshot private/snapshots/<dir> --wipe --apply

The snapshot holds rows; `supabase/migrations/` holds the schema. Restoring into
an empty project means running the migrations first, then this. Restoring over a
project that has drifted means `--wipe`, which deletes each table's rows in
reverse dependency order before replaying them.

Dry run is the default and `--apply` is required, because the reset this exists
to perform is exactly the operation nobody wants to trigger by accident.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from dotenv import dotenv_values  # noqa: E402
from supabase import create_client  # noqa: E402

from snapshot_project import TABLES  # noqa: E402

CHUNK = 200

#: Tables whose primary key is not `id`.
PK = {"app_settings": "key", "fix_reviewers": "user_id"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True)
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--wipe", action="store_true",
                    help="delete existing rows before replaying (a true reset)")
    ap.add_argument("--apply", action="store_true", help="without this, nothing is written")
    args = ap.parse_args()

    env = dotenv_values(REPO_ROOT / args.env)
    url, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print(f"[fail] {args.env} has no Supabase credentials")
        return 2
    snap = Path(args.snapshot)
    if not snap.is_absolute():
        snap = REPO_ROOT / snap
    manifest = json.loads((snap / "MANIFEST.json").read_text(encoding="utf-8"))

    ref = url.split("//")[-1].split(".")[0]
    print(f"target project: {ref}")
    print(f"snapshot:       {manifest['project_ref']} taken {manifest['taken_at']}")
    if ref != manifest["project_ref"]:
        print(f"[warn] snapshot came from a DIFFERENT project ({manifest['project_ref']})")
    print(f"mode:           {'APPLY' if args.apply else 'DRY RUN'}"
          f"{' + WIPE' if args.wipe else ''}\n")

    client = create_client(url, key)
    present = [t for t in TABLES if (snap / f"{t}.json").exists()]

    if args.wipe:
        for table in reversed(present):
            pk = PK.get(table, "id")
            if not args.apply:
                print(f"  [dry] would wipe {table}")
                continue
            # PostgREST requires a filter on delete; `not.is.null` on the primary
            # key matches every row without naming any of them.
            client.table(table).delete().not_.is_(pk, "null").execute()
            print(f"  [wiped] {table}")
        print()

    total = 0
    for table in present:
        rows = json.loads((snap / f"{table}.json").read_text(encoding="utf-8"))
        if not rows:
            continue
        total += len(rows)
        if not args.apply:
            print(f"  [dry] would restore {table:24s} {len(rows):6d} rows")
            continue
        pk = PK.get(table, "id")
        for i in range(0, len(rows), CHUNK):
            client.table(table).upsert(rows[i:i + CHUNK], on_conflict=pk).execute()
        print(f"  [ok]  restored {table:24s} {len(rows):6d} rows")

    verb = "restored" if args.apply else "would restore"
    print(f"\n[{'ok' if args.apply else 'dry'}] {verb} {total} rows across {len(present)} tables")
    if not args.apply:
        print("Nothing was written. Re-run with --apply to perform the restore.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
