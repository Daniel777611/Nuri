"""Send onboarding test accounts back to the start of onboarding.

    .venv/Scripts/python.exe backend/scripts/reset_onboarding_accounts.py
    .venv/Scripts/python.exe backend/scripts/reset_onboarding_accounts.py onboarding_test_02@example.com

The accounts themselves come from create_test_accounts.py:

    .venv/Scripts/python.exe backend/scripts/create_test_accounts.py \
        --prefix onboarding_test_ --count 3 --password <pw> --force

Where a signed-in account lands is decided by users.onboarding_completed alone
(native-ios/app/index.tsx and login.tsx), so flipping that flag would already
reopen onboarding. It is not enough for testing it, though: the screens would
come back pre-filled with the last run's answers and the last run's child, and
the home cards and memories would still describe that family. So everything
onboarding writes, and everything that grew out of it, is cleared too:

- the profile answers on the users row;
- every per-account table the privacy wipe clears (children, the conversation,
  memories, daily cards, ...), reusing that function so the list stays one list;
- the privacy row in app_settings, so the account is back on the defaults a new
  signup gets. The privacy wipe writes an opt-out tombstone instead, which is
  right for a parent but would hide the defaults a tester needs to see.

The login, password and verified mail stay. The AI-consent prompt is stored on
the device (native-ios/src/aiConsent.ts), not here: to see it again, sign out
and back in, or clear the app's storage.

Only addresses under --prefix are touched, so a mistyped address cannot reset a
real family.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend import main as backend_main  # noqa: E402
from backend import runtime, stores  # noqa: E402

DEFAULT_PREFIX = "onboarding_test_"

#: The profile as a fresh signup has it. Mirrors admin_create_test_account and
#: the fields onboarding sends through PATCH /api/auth/me.
BLANK_PROFILE = {
    "nickname": "",
    "city": "",
    "parent_role": None,
    "top_concerns": [],
    "concern_other": "",
    "hobbies": "",
    "help_preference": "",
    "info_source": "",
    "content_frequency": "",
    "onboarding_completed": False,
}


async def _reset(sb, row: dict) -> None:
    uid = row["id"]
    sb.table("users").update(BLANK_PROFILE).eq("id", uid).execute()
    await backend_main._delete_persistent_user_history(uid)
    sb.table("app_settings").delete().eq("key", stores.privacy_storage_key(uid)).execute()


def main() -> int:
    parser = argparse.ArgumentParser(description="Reset onboarding test accounts.")
    parser.add_argument("emails", nargs="*",
                        help="accounts to reset; default is every account under --prefix")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    args = parser.parse_args()

    sb = runtime.get_supabase()
    if not sb:
        sys.exit("[fail] Supabase is not configured — check .env")
    ref = (runtime.SUPABASE_URL or "").split("//")[-1].split(".")[0]

    outside = [e for e in args.emails if not e.lower().startswith(args.prefix)]
    if outside:
        sys.exit(f"[STOP] not a {args.prefix}* address: {', '.join(outside)}. Nothing was reset.")

    query = sb.table("users").select("id,email")
    if args.emails:
        query = query.in_("email", [e.lower() for e in args.emails])
    else:
        query = query.like("email", f"{args.prefix}%")
    rows = query.order("email").execute().data or []
    if not rows:
        print(f"project {ref}: no matching accounts")
        return 1

    print(f"project {ref}: resetting {len(rows)} account(s)")
    failed = 0
    for row in rows:
        try:
            asyncio.run(_reset(sb, row))
            print(f"  {row['email']:<40} reset")
        except Exception as exc:  # noqa: BLE001 - report each account, keep going
            failed += 1
            print(f"  {row['email']:<40} FAILED {type(exc).__name__}: {str(exc)[:120]}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
