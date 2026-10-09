"""Create the Stripe products and prices for the membership tiers.

    python -m backend.scripts.create_tier_prices \
        --plus-monthly 6.99 --plus-yearly 69 \
        --unlimited-monthly 14.99 --unlimited-yearly 199 \
        [--currency usd] [--apply]

Without --apply it only prints what it would create. With --apply it creates
one product per tier ("NURI 进阶" / "NURI 无限") and a monthly and yearly
recurring price on each, every price tagged `metadata.nuri_tier`, and prints
the environment variables to set (in Vercel and .env).

Uses STRIPE_SECRET_KEY from the environment / .env. Refuses a live key unless
--live is passed too, so a sandbox run can't create live prices by accident.
An existing product with the same `metadata.nuri_tier` is reused rather than
duplicated; prices are always new (Stripe prices are immutable).
"""

from __future__ import annotations

import argparse
import os
import sys

import stripe
from dotenv import find_dotenv, load_dotenv

TIER_NAMES = {"plus": "NURI 进阶 / Plus", "unlimited": "NURI 无限 / Unlimited"}
ENV_NAMES = {
    ("plus", "month"): "STRIPE_PRICE_PLUS_MONTHLY",
    ("plus", "year"): "STRIPE_PRICE_PLUS_YEARLY",
    ("unlimited", "month"): "STRIPE_PRICE_UNLIMITED_MONTHLY",
    ("unlimited", "year"): "STRIPE_PRICE_UNLIMITED_YEARLY",
}


def _cents(value: str) -> int:
    amount = round(float(value) * 100)
    if amount <= 0:
        raise argparse.ArgumentTypeError("amount must be positive")
    return amount


def main() -> int:
    load_dotenv(find_dotenv(usecwd=True))
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--plus-monthly", type=_cents, required=True)
    parser.add_argument("--plus-yearly", type=_cents, required=True)
    parser.add_argument("--unlimited-monthly", type=_cents, required=True)
    parser.add_argument("--unlimited-yearly", type=_cents, required=True)
    parser.add_argument("--currency", default="usd")
    parser.add_argument("--apply", action="store_true", help="actually create them")
    parser.add_argument("--live", action="store_true", help="allow a live-mode key")
    args = parser.parse_args()

    key = os.getenv("STRIPE_SECRET_KEY", "").strip()
    if not key:
        print("STRIPE_SECRET_KEY is not set", file=sys.stderr)
        return 2
    if key.startswith(("sk_live_", "rk_live_")) and not args.live:
        print("refusing a live key without --live", file=sys.stderr)
        return 2

    amounts = {
        ("plus", "month"): args.plus_monthly,
        ("plus", "year"): args.plus_yearly,
        ("unlimited", "month"): args.unlimited_monthly,
        ("unlimited", "year"): args.unlimited_yearly,
    }
    mode = "LIVE" if key.startswith(("sk_live_", "rk_live_")) else "sandbox"
    print(f"Stripe {mode}; {'creating' if args.apply else 'dry run, nothing created'}:")
    for (tier, interval), cents in amounts.items():
        print(f"  {TIER_NAMES[tier]:24s} {interval:5s} {cents / 100:.2f} {args.currency.upper()}")
    if not args.apply:
        return 0

    client = stripe.StripeClient(api_key=key)
    env_lines = []
    for tier in ("plus", "unlimited"):
        found = client.v1.products.search(params={
            "query": f"metadata['nuri_tier']:'{tier}' AND active:'true'",
        })
        product = found.data[0] if found.data else client.v1.products.create(params={
            "name": TIER_NAMES[tier],
            "metadata": {"nuri_tier": tier},
        })
        for interval in ("month", "year"):
            price = client.v1.prices.create(params={
                "product": product.id,
                "currency": args.currency,
                "unit_amount": amounts[(tier, interval)],
                "recurring": {"interval": interval},
                "metadata": {"nuri_tier": tier},
            })
            env_lines.append(f"{ENV_NAMES[(tier, interval)]}={price.id}")
    print("\nSet these (Vercel Production + .env):")
    print("\n".join(env_lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
