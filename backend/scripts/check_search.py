"""Smoke-test the configured search provider against real queries.

The point is to look at what actually comes back before any of it reaches a
parent: whether the key works, whether the English pass reaches the authorities
it is supposed to, and whether the block-list is doing anything.

    # from the repo root, with TAVILY_API_KEY set in .env
    python -m backend.scripts.check_search --provider tavily
    python -m backend.scripts.check_search --provider tavily -q "4个月宝宝不肯吃副食品"

Reads source_domains from Supabase when it's reachable; without it there are no
domain rules, so medical queries plan nothing and everything ranks as neutral.
That is itself worth seeing — it's the production behaviour when the table is
missing.
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Windows consoles default to cp1252, which can't encode the Chinese queries and
# result titles this script exists to show.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, OSError):  # pragma: no cover - non-standard stdout
    pass

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

from backend import websearch as w  # noqa: E402

#: One benign, one medical. The pair exercises both planning branches.
DEFAULT_CASES = [
    ("4 month old refusing solid foods", "4个月 宝宝 抗拒 副食品", False),
    ("infant 4 months fever 39C when to see a doctor", "4个月 婴儿 发烧 39度 就医", True),
]


def _supabase():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not (url and key):
        return None
    try:
        from supabase import create_client

        return create_client(url, key)
    except Exception as e:
        print(f"[warn] Supabase unavailable ({e}); running without domain rules\n")
        return None


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default=None, help="overrides WEB_SEARCH_PROVIDER")
    ap.add_argument("-q", "--query", default=None, help="one ad-hoc query (Chinese or English)")
    ap.add_argument("--medical", action="store_true", help="treat -q as a medical question")
    ap.add_argument("--scope", default="both", choices=["en", "zh", "both"])
    args = ap.parse_args()

    if args.provider:
        os.environ["WEB_SEARCH_PROVIDER"] = args.provider

    provider = w.get_provider()
    print(f"provider : {provider.name}")
    if provider.name == "null":
        print("\n`null` searches nothing. Pass --provider tavily, or set "
              "WEB_SEARCH_PROVIDER in .env.")
        return 1
    if provider.name == "tavily" and not os.getenv("TAVILY_API_KEY"):
        print("\nTAVILY_API_KEY is not set. Add it to .env (never to .env.example).")
        return 1

    sb = _supabase()
    rules = await w.load_domain_rules(sb)
    print(f"domains  : {len(rules.tiers)} rules "
          f"({len(rules.domains('authority'))} authority, "
          f"{len(rules.domains('blocked'))} blocked)")
    if not rules.tiers:
        print("           ⚠ no rules — medical queries will plan nothing, and "
              "nothing ranks above neutral")

    cases = ([(args.query, args.query, args.medical)] if args.query else DEFAULT_CASES)

    for en_q, zh_q, medical in cases:
        print(f"\n{'─' * 72}\n{'MEDICAL' if medical else 'GENERAL'}  en={en_q!r}  zh={zh_q!r}")
        results = await w.search_sources(
            en_q, zh_query=zh_q, scope=args.scope, is_medical=medical, sb=sb,
        )
        if not results:
            print("  (no sources)")
            continue
        for r in results:
            print(f"  [{r.tier:9}] {r.lang}  {r.site_name}")
            print(f"      {r.title[:88]}")
            print(f"      {r.url}")
        if medical and any(r.tier != "authority" for r in results):
            print("\n  ⚠ a medical result came back non-authority — check that "
                  "include_domains is being honoured")

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
