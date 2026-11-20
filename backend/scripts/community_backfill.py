"""Hand recent open questions to community profiles that already exist.

New profiles (and parents who turn "hide my profile" off) are backfilled by the
API itself; this covers the profiles created before that shipped, who would
otherwise never see a question posted before they joined.

    python -m backend.scripts.community_backfill            # dry run: who would get what
    python -m backend.scripts.community_backfill --apply    # create the deliveries + push

Writes to whatever Supabase project .env points at — check SUPABASE_URL first.
The dry run does not see the deliveries earlier parents in the same run would
add, so an applied run can hand out slightly fewer than it lists.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, OSError):  # pragma: no cover
    pass

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

from backend import community  # noqa: E402


async def run(apply: bool) -> None:
    profiles = await community._select("community_profiles", lambda q: q.order("created_at"))
    print(f"Supabase: {os.getenv('SUPABASE_URL', '?')}  profiles: {len(profiles)}  "
          f"{'APPLY' if apply else 'dry run'}")
    total = 0
    for p in profiles:
        uid, name = p["user_id"], p.get("display_name") or "?"
        picks = await community.backfill_picks(uid)
        if not picks:
            print(f"  {name} ({uid[:8]}): nothing")
            continue
        for q in picks:
            print(f"  {name} ({uid[:8]}) <- {str(q['id'])[:8]} {q['body'][:30]!r}")
        if apply:
            total += await community.backfill_deliveries(uid)
    print(f"Created {total} deliveries." if apply else "Dry run only; pass --apply to write.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="create the deliveries (default: dry run)")
    asyncio.run(run(parser.parse_args().apply))
