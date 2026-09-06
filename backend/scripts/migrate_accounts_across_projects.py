"""Copy chosen accounts from one Supabase project into another.

    # plan only
    .venv/Scripts/python.exe backend/scripts/migrate_accounts_across_projects.py
    # perform it
    .venv/Scripts/python.exe backend/scripts/migrate_accounts_across_projects.py --apply

`recover_account_history.py` merges two accounts inside one project and takes a
single `SUPABASE_URL`; this moves accounts *between* projects, which is what
promoting the test project to production needs. It borrows that script's rules:
the source is never written to, existing target rows are never overwritten, the
default is a dry run, and a JSON record of everything inserted is written so the
operation can be audited or reversed.

Two schema constraints shape the whole design:

* `chat_sessions` has a unique index on `user_id` - one session per account. A
  source session therefore cannot be inserted for an account that already has
  one; its messages are re-pointed into the target's session instead and sort
  into place by their original `created_at`.
* `user_memories` is unique on `(user_id, coalesce(child_id,''), category, key)`.
  Where both sides hold the same key the target's row wins, because the target's
  rows are the later ones and a stale fact should not overwrite a current one.

Telemetry (`chat_turn_logs`, `llm_call_logs`, `recommendation_events`,
`nuri_turn_*`) is deliberately not copied: it is analytics about a database that
is being retired, and it would sit in the middle of the client's fresh usage data.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from dotenv import dotenv_values  # noqa: E402
from supabase import create_client  # noqa: E402

#: The accounts to bring across. Everything else in the source project is a
#: throwaway (@x.com, @example.com, @1.com ...) or a bot account.
EMAILS = (
    "daniel@ordashlab.com",
    "diwang22@student.scad.edu",
    "lulala01017@gmail.com",
    "finnolcc@gmail.com",
    "wangding070@gmail.com",
)

_MISSING_COL = re.compile(r"Could not find the '([^']+)' column")


def insert_rows(client, table: str, rows: list[dict]) -> None:
    """Insert rows, dropping any column the target schema does not have.

    The source project's schema is older than the target's, so this should never
    fire - but drift from manual dashboard edits would otherwise abort a
    half-finished migration, and losing an unknown column beats losing the row.
    """
    if not rows:
        return
    payload = [dict(r) for r in rows]
    while True:
        try:
            client.table(table).insert(payload).execute()
            return
        except Exception as exc:
            m = _MISSING_COL.search(str(exc))
            if not m:
                raise
            col = m.group(1)
            print(f"      [warn] {table}: target has no {col!r} column, dropping it")
            for r in payload:
                r.pop(col, None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-env", default="private/.env.prod.backup")
    ap.add_argument("--target-env", default=".env")
    ap.add_argument("--apply", action="store_true", help="without this, nothing is written")
    args = ap.parse_args()

    senv = dotenv_values(REPO_ROOT / args.source_env)
    tenv = dotenv_values(REPO_ROOT / args.target_env)
    sc = create_client(senv["SUPABASE_URL"], senv["SUPABASE_SERVICE_ROLE_KEY"])
    tc = create_client(tenv["SUPABASE_URL"], tenv["SUPABASE_SERVICE_ROLE_KEY"])
    sref = senv["SUPABASE_URL"].split("//")[-1].split(".")[0]
    tref = tenv["SUPABASE_URL"].split("//")[-1].split(".")[0]

    print(f"source: {sref}  ->  target: {tref}")
    print(f"mode:   {'APPLY' if args.apply else 'DRY RUN'}\n")

    plan: dict[str, object] = {"source": sref, "target": tref, "accounts": []}
    child_map: dict[str, str] = {}
    session_map: dict[str, str] = {}
    warnings: list[str] = []

    for email in EMAILS:
        srow = sc.table("users").select("*").eq("email", email).execute().data
        if not srow:
            print(f"[skip] {email}: not in source")
            continue
        su = srow[0]
        trow = tc.table("users").select("*").eq("email", email).execute().data
        merge = bool(trow)
        tuid = trow[0]["id"] if merge else su["id"]
        acct: dict[str, object] = {"email": email, "mode": "merge" if merge else "copy",
                                   "source_id": su["id"], "target_id": tuid}
        label = "MERGE into existing" if merge else "COPY as new"
        print(f"-- {email}  [{label}]")

        # users ----------------------------------------------------------------
        if merge:
            print("   users            keep target row (id + password unchanged)")
        else:
            print("   users            insert 1 (bcrypt hash carried over, password still works)")
            if args.apply:
                insert_rows(tc, "users", [su])

        # children -------------------------------------------------------------
        skids = sc.table("children").select("*").eq("user_id", su["id"]).execute().data
        tkids = tc.table("children").select("*").eq("user_id", tuid).execute().data if merge else []
        new_kids = []
        for k in skids:
            twin = next((t for t in tkids if t["nickname"] == k["nickname"]), None)
            if twin:
                child_map[k["id"]] = twin["id"]
                print(f"   children         reuse target's {k['nickname']!r} (same child, not duplicated)")
                for f in ("birth_date", "gender"):
                    if k.get(f) != twin.get(f) and k.get(f) not in (None, "", "other"):
                        d = f"{f}: source={k[f]!r} target={twin[f]!r}"
                        print(f"      [conflict] {d}")
                        warnings.append(f"{email} child {k['nickname']!r}: {d}")
            else:
                child_map[k["id"]] = k["id"]
                new_kids.append({**k, "user_id": tuid})
        if new_kids:
            print(f"   children         insert {len(new_kids)}")
            if args.apply:
                insert_rows(tc, "children", new_kids)

        # chat_sessions --------------------------------------------------------
        ssess = sc.table("chat_sessions").select("*").eq("user_id", su["id"]).execute().data
        tsess = tc.table("chat_sessions").select("*").eq("user_id", tuid).execute().data if merge else []
        new_sess = []
        for s in ssess:
            if tsess:
                session_map[s["id"]] = tsess[0]["id"]
                print("   chat_sessions    reuse target's session (unique index: one per user)")
            else:
                session_map[s["id"]] = s["id"]
                new_sess.append({**s, "user_id": tuid})
        if new_sess:
            print(f"   chat_sessions    insert {len(new_sess)}")
            if args.apply:
                insert_rows(tc, "chat_sessions", new_sess)

        # chat_messages --------------------------------------------------------
        sids = [s["id"] for s in ssess]
        msgs = (sc.table("chat_messages").select("*").in_("session_id", sids)
                .order("created_at").execute().data) if sids else []
        msgs = [{**m, "session_id": session_map[m["session_id"]]} for m in msgs]
        if msgs:
            where = "merged into target's session by created_at" if tsess else "with their session"
            print(f"   chat_messages    insert {len(msgs)} ({where})")
            print(f"                    {msgs[0]['created_at'][:10]} -> {msgs[-1]['created_at'][:10]}")
            if args.apply:
                insert_rows(tc, "chat_messages", msgs)

        # user_memories --------------------------------------------------------
        smem = sc.table("user_memories").select("*").eq("user_id", su["id"]).execute().data
        tmem = tc.table("user_memories").select("*").eq("user_id", tuid).execute().data if merge else []
        taken = {(m["category"], m["key"]) for m in tmem}
        keep, drop = [], []
        for m in smem:
            (drop if (m["category"], m["key"]) in taken else keep).append(m)
        keep = [{**m, "user_id": tuid,
                 "child_id": child_map.get(m["child_id"], m["child_id"]) if m.get("child_id") else None}
                for m in keep]
        if smem:
            print(f"   user_memories    insert {len(keep)}, skip {len(drop)} (target's newer row wins)")
            for m in drop:
                print(f"      [kept target] {m['category']}/{m['key']}: source said {m['value'][:40]!r}")
            if args.apply:
                insert_rows(tc, "user_memories", keep)

        # remaining user-scoped tables -----------------------------------------
        for table in ("normalized_inputs", "tasks", "follow_ups", "collections", "favorites"):
            rows = sc.table(table).select("*").eq("user_id", su["id"]).execute().data
            if not rows:
                continue
            out = []
            for r in rows:
                r = {**r, "user_id": tuid}
                if r.get("child_id"):
                    r["child_id"] = child_map.get(r["child_id"], r["child_id"])
                if r.get("session_id"):
                    r["session_id"] = session_map.get(r["session_id"], r["session_id"])
                out.append(r)
            print(f"   {table:16s} insert {len(out)}")
            if args.apply:
                insert_rows(tc, table, out)

        acct["counts"] = {"children": len(new_kids), "sessions": len(new_sess),
                          "messages": len(msgs), "memories_kept": len(keep),
                          "memories_skipped": len(drop)}
        plan["accounts"].append(acct)
        print()

    if warnings:
        print("-- field conflicts needing a human decision --")
        for w in warnings:
            print(f"   {w}")
        print()
    plan["warnings"] = warnings

    if args.apply:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
        rec = REPO_ROOT / "private" / "snapshots" / f"{stamp}-migration-record.json"
        rec.write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"[ok] migration complete. Record: {rec}")
    else:
        print("Nothing was written. Re-run with --apply to perform the migration.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
