"""Provision the throwaway accounts an external multi-turn test run drives.

    .venv/Scripts/python.exe backend/scripts/create_test_accounts.py
    .venv/Scripts/python.exe backend/scripts/create_test_accounts.py --count 20

One account per dialogue blueprint, because NURI gives an account exactly one
conversation for life and the database enforces it. That constraint is usually
described as an obstacle to testing twenty parallel dialogues; it is actually
the cleanest way to get them, since separate accounts cannot leak facts or
product events into each other the way twenty sessions under one account could.

Accounts are created through the real /api/auth/register route rather than by
inserting rows, so the password hashing, validation and column defaults are the
ones production uses. Re-running is safe: an address that already exists is
reported and kept.

Credentials are written to a git-ignored Markdown file. They are worthless
outside the test project, but a credential in a repository is a habit worth not
forming, and this repo has a public mirror.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from backend import main as backend_main  # noqa: E402
from backend import runtime  # noqa: E402

DEFAULT_COUNT = 20
DEFAULT_PREFIX = "automated_test_"
DEFAULT_DOMAIN = "example.com"
#: Written into the git-ignored private/ folder. Everything with a
#: credential in it lives there, so there is one rule keeping it out of
#: the repository rather than a per-file list.
DEFAULT_OUT = REPO_ROOT / "private" / "TEST_ACCOUNTS.md"


def _project_ref() -> str:
    return (runtime.SUPABASE_URL or "").split("//")[-1].split(".")[0]


def _guard_not_a_real_database(prefix: str, force: bool) -> None:
    """Refuse to write accounts into a database that holds real families.

    The check is the account list itself rather than a hardcoded project id: a
    test project contains only addresses this script made, so anything else is
    either the production database or a mistake worth stopping for.
    """
    sb = runtime.get_supabase()
    if not sb:
        sys.exit("[fail] Supabase is not configured — check .env")
    rows = sb.table("users").select("email").limit(200).execute().data or []
    strangers = [
        r["email"] for r in rows
        if not str(r.get("email") or "").startswith(prefix)
    ]
    if strangers and not force:
        print(f"[STOP] {_project_ref()} already holds {len(strangers)} account(s) "
              f"that are not {prefix}* — for example {strangers[0]!r}.")
        print("       This looks like a real database. Nothing was written.")
        print("       Point .env at the test project, or pass --force if you are certain.")
        sys.exit(2)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create test accounts.")
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--domain", default=DEFAULT_DOMAIN)
    # No default. A default password is a credential in the repository,
    # and this one has a public mirror. Pass --password, or set
    # NURI_TEST_PASSWORD in the environment.
    parser.add_argument("--password", default=os.getenv("NURI_TEST_PASSWORD", ""))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--force", action="store_true",
                        help="write even if the database holds unrecognised accounts")
    args = parser.parse_args()
    if not args.password:
        sys.exit("[fail] no password: pass --password or set NURI_TEST_PASSWORD")

    _guard_not_a_real_database(args.prefix, args.force)
    print(f"project: {_project_ref()}   creating {args.count} account(s)")

    client = TestClient(backend_main.app)
    rows: list[tuple[str, str, str]] = []
    for index in range(1, args.count + 1):
        email = f"{args.prefix}{index:02d}@{args.domain}"
        response = client.post("/api/auth/register", json={
            "email": email,
            "password": args.password,
            # The blueprint supplies the family details in conversation. A
            # seeded nickname would put a fact in the prompt that the dialogue
            # never established.
            "nickname": "",
            "city": "",
        })
        if response.status_code == 201:
            status = "created"
        elif response.status_code == 400:
            status = "already existed"
        else:
            status = f"FAILED {response.status_code} {response.text[:80]}"
        rows.append((email, args.password, status))
        print(f"  [{index:>2}/{args.count}] {email:<40} {status}")

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# NURI test accounts",
        "",
        f"Project `{_project_ref()}` · {len(rows)} accounts · generated {stamp}",
        "",
        "One account per dialogue blueprint. Each holds exactly one conversation,",
        "which is what keeps twenty parallel dialogues from leaking into each other.",
        "",
        "**These are throwaway accounts on the test database. Never reuse these",
        "addresses or this password anywhere else.** This file is git-ignored.",
        "",
        "## Getting a token",
        "",
        "Tokens are not listed here because they expire (7 days by default).",
        "Log in for a fresh one:",
        "",
        "```bash",
        "curl -X POST https://<preview-host>/api/auth/login \\",
        '  -H "Content-Type: application/json" \\',
        f'  -d \'{{"email":"{rows[0][0] if rows else ""}","password":"{args.password}"}}\'',
        "```",
        "",
        "The `access_token` in the response goes in `Authorization: Bearer <token>`.",
        "",
        "## Resetting a conversation",
        "",
        "`POST /api/privacy/wipe` clears the account's conversation, memories and",
        "children. `DELETE /api/chat/sessions/{id}` deliberately returns 409 — the",
        "conversation is permanent by design.",
        "",
        "## Accounts",
        "",
        "| # | Email | Password | Status |",
        "|---|---|---|---|",
    ]
    for index, (email, password, status) in enumerate(rows, start=1):
        lines.append(f"| {index} | `{email}` | `{password}` | {status} |")
    lines.append("")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nwrote {out_path}")

    failed = [r for r in rows if r[2].startswith("FAILED")]
    if failed:
        print(f"[warn] {len(failed)} account(s) failed — see the table")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
