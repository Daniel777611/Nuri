"""Stripe subscriptions: hosted Checkout to start, Customer Portal to manage.

Stripe is the source of truth. The webhook never trusts the event payload's
copy of a subscription — it re-reads the subscription from Stripe and writes
that over the local row. Events arrive out of order and get retried, and
"whatever Stripe says now" is the one answer that is right regardless.

Card details never reach this server: Checkout and the Portal are Stripe-hosted
pages, so the app only ever hands the browser a URL.

Configuration (all optional; with any missing, /billing/status reports
`enabled: false` and the page hides the buy buttons):
    STRIPE_SECRET_KEY       sk_test_... / sk_live_...
    STRIPE_WEBHOOK_SECRET   whsec_...  (per webhook endpoint)
    STRIPE_PRICE_MONTHLY    price_...  recurring, interval=month
    STRIPE_PRICE_YEARLY     price_...  recurring, interval=year
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Optional

import stripe

log = logging.getLogger("nuri.billing")

INTERVALS = ("month", "year")

# Statuses that keep paid features on. past_due is included on purpose: Stripe
# is still retrying the card, and cutting a parent off mid-retry for a bank's
# hiccup is worse than a few days of grace. Stripe moves it to canceled or
# unpaid once retries run out, and the webhook follows.
ENTITLED_STATUSES = frozenset({"active", "trialing", "past_due"})

# Events that can change a subscription. Everything else is acknowledged and
# ignored, so adding an event in the Stripe dashboard can never make the
# endpoint start failing.
SUBSCRIPTION_EVENTS = frozenset({
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.resumed",
})


class BillingNotConfigured(RuntimeError):
    pass


def _price_ids() -> dict[str, str]:
    return {
        "month": os.getenv("STRIPE_PRICE_MONTHLY", "").strip(),
        "year": os.getenv("STRIPE_PRICE_YEARLY", "").strip(),
    }


def configured() -> bool:
    return bool(os.getenv("STRIPE_SECRET_KEY", "").strip()) and any(_price_ids().values())


def webhook_secret() -> str:
    return os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()


def _client() -> stripe.StripeClient:
    key = os.getenv("STRIPE_SECRET_KEY", "").strip()
    if not key:
        raise BillingNotConfigured("STRIPE_SECRET_KEY is not set")
    return stripe.StripeClient(api_key=key)


def _plain(obj: Any) -> dict:
    """Stripe objects stopped being dicts; everything below works on dicts."""
    if obj is None:
        return {}
    return obj.to_dict() if hasattr(obj, "to_dict") else dict(obj)


def _ts(value: Any) -> Optional[str]:
    if not value:
        return None
    return datetime.fromtimestamp(int(value), tz=timezone.utc).isoformat()


# ── Plans ─────────────────────────────────────────────────────────────────────
# Amounts come from Stripe rather than the frontend, so changing a price in the
# dashboard can't leave the page advertising the old one. Cached briefly: the
# status call runs every time the billing page opens.

_PLAN_CACHE: dict[str, Any] = {"at": 0.0, "plans": None}
_PLAN_TTL_S = 600


def plans() -> list[dict]:
    if not configured():
        return []
    if _PLAN_CACHE["plans"] is not None and time.monotonic() - _PLAN_CACHE["at"] < _PLAN_TTL_S:
        return _PLAN_CACHE["plans"]
    client = _client()
    out = []
    for interval, price_id in _price_ids().items():
        if not price_id:
            continue
        price = _plain(client.v1.prices.retrieve(price_id))
        recurring = price.get("recurring") or {}
        if recurring.get("interval") != interval:
            # A monthly env var pointing at a yearly price would bill a parent
            # twelve times what the button says. Refuse to show it at all.
            log.error("price %s is %s, expected %s", price_id, recurring.get("interval"), interval)
            continue
        out.append({
            "interval": interval,
            "price_id": price_id,
            "unit_amount": price.get("unit_amount"),
            "currency": price.get("currency"),
        })
    _PLAN_CACHE.update(at=time.monotonic(), plans=out)
    return out


# ── Local state ───────────────────────────────────────────────────────────────

def customer_id_for(sb, uid: str) -> Optional[str]:
    rows = sb.table("billing_customers").select("stripe_customer_id").eq(
        "user_id", uid
    ).limit(1).execute().data or []
    return rows[0]["stripe_customer_id"] if rows else None


def _uid_for_customer(sb, customer_id: str) -> Optional[str]:
    rows = sb.table("billing_customers").select("user_id").eq(
        "stripe_customer_id", customer_id
    ).limit(1).execute().data or []
    return rows[0]["user_id"] if rows else None


def current_subscription(sb, uid: str) -> Optional[dict]:
    """The subscription that decides access: the newest entitled one, else the
    newest of any status (so the page can say "canceled" rather than nothing)."""
    rows = sb.table("billing_subscriptions").select("*").eq("user_id", uid).order(
        "updated_at", desc=True
    ).limit(20).execute().data or []
    for row in rows:
        if row.get("status") in ENTITLED_STATUSES:
            return row
    return rows[0] if rows else None


def status_for(sb, uid: str) -> dict:
    sub = current_subscription(sb, uid)
    entitled = bool(sub and sub.get("status") in ENTITLED_STATUSES)
    return {
        "enabled": configured(),
        "entitled": entitled,
        "subscription": None if not sub else {
            "status": sub.get("status"),
            "interval": sub.get("plan_interval"),
            "current_period_end": sub.get("current_period_end"),
            "cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
        },
        "has_customer": customer_id_for(sb, uid) is not None,
    }


# ── Checkout / Portal ─────────────────────────────────────────────────────────

def ensure_customer(sb, uid: str, email: Optional[str]) -> str:
    existing = customer_id_for(sb, uid)
    if existing:
        return existing
    # The idempotency key makes a double-tap produce one customer, not two
    # (Stripe remembers keys for 24h, far longer than any race here).
    customer = _plain(_client().v1.customers.create(
        params={"email": email or None, "metadata": {"user_id": uid}},
        options={"idempotency_key": f"nuri-customer-{uid}"},
    ))
    sb.table("billing_customers").upsert(
        {"user_id": uid, "stripe_customer_id": customer["id"]},
        on_conflict="user_id",
    ).execute()
    # Re-read: if a concurrent request won the upsert, use its row.
    return customer_id_for(sb, uid) or customer["id"]


def create_checkout(sb, uid: str, email: Optional[str], interval: str, return_base: str) -> str:
    if interval not in INTERVALS:
        raise ValueError(f"unknown interval {interval!r}")
    price_id = _price_ids()[interval]
    if not configured() or not price_id:
        raise BillingNotConfigured(f"no price configured for {interval}")
    customer_id = ensure_customer(sb, uid, email)
    base = return_base.rstrip("/")
    session = _plain(_client().v1.checkout.sessions.create(params={
        "mode": "subscription",
        "customer": customer_id,
        "client_reference_id": uid,
        "line_items": [{"price": price_id, "quantity": 1}],
        # On the subscription too, so every later subscription event can be
        # tied back to the account even if the customer row were lost.
        "subscription_data": {"metadata": {"user_id": uid}},
        "metadata": {"user_id": uid},
        "allow_promotion_codes": True,
        "success_url": f"{base}/billing?checkout=success",
        "cancel_url": f"{base}/billing?checkout=cancel",
    }))
    return session["url"]


def create_portal(sb, uid: str, return_base: str) -> Optional[str]:
    customer_id = customer_id_for(sb, uid)
    if not customer_id:
        return None
    session = _plain(_client().v1.billing_portal.sessions.create(params={
        "customer": customer_id,
        "return_url": f"{return_base.rstrip('/')}/billing",
    }))
    return session["url"]


# ── Webhook ───────────────────────────────────────────────────────────────────

def construct_event(payload: bytes, signature: Optional[str]) -> dict:
    """Verify the signature and parse. Raises ValueError /
    stripe.SignatureVerificationError on anything that isn't Stripe."""
    secret = webhook_secret()
    if not secret:
        raise BillingNotConfigured("STRIPE_WEBHOOK_SECRET is not set")
    return _plain(stripe.Webhook.construct_event(payload, signature, secret))


def _subscription_row(sub: dict, uid: str) -> dict:
    items = ((sub.get("items") or {}).get("data")) or []
    first = items[0] if items else {}
    price = first.get("price") or {}
    interval = (price.get("recurring") or {}).get("interval")
    # Since API version 2025-03-31 the period lives on the item, not the
    # subscription; read both so an older pinned account version still works.
    period_end = first.get("current_period_end") or sub.get("current_period_end")
    return {
        "id": sub["id"],
        "user_id": uid,
        "stripe_customer_id": sub.get("customer"),
        "status": sub.get("status"),
        "price_id": price.get("id"),
        "plan_interval": interval if interval in INTERVALS else None,
        "current_period_end": _ts(period_end),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end") or sub.get("cancel_at")),
        "canceled_at": _ts(sub.get("canceled_at")),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def sync_subscription(sb, subscription_id: str) -> Optional[dict]:
    """Fetch one subscription from Stripe and mirror it. Returns the row, or
    None when it can't be tied to an account (logged, not raised: retrying a
    webhook won't make an unknown customer known)."""
    sub = _plain(_client().v1.subscriptions.retrieve(subscription_id))
    uid = (sub.get("metadata") or {}).get("user_id")
    customer_id = sub.get("customer")
    if not uid and customer_id:
        uid = _uid_for_customer(sb, customer_id)
    if not uid:
        log.warning("subscription %s has no known account", subscription_id)
        return None
    if customer_id and not customer_id_for(sb, uid):
        sb.table("billing_customers").upsert(
            {"user_id": uid, "stripe_customer_id": customer_id}, on_conflict="user_id",
        ).execute()
    row = _subscription_row(sub, uid)
    sb.table("billing_subscriptions").upsert(row, on_conflict="id").execute()
    return row


def handle_event(sb, event: dict) -> dict:
    kind = event.get("type", "")
    if kind not in SUBSCRIPTION_EVENTS:
        return {"handled": False, "type": kind}
    obj = (event.get("data") or {}).get("object") or {}
    if kind == "checkout.session.completed":
        if obj.get("mode") != "subscription" or not obj.get("subscription"):
            return {"handled": False, "type": kind}
        subscription_id = obj["subscription"]
    else:
        subscription_id = obj.get("id")
    if not subscription_id:
        return {"handled": False, "type": kind}
    row = sync_subscription(sb, subscription_id)
    return {"handled": row is not None, "type": kind, "status": row and row["status"]}
