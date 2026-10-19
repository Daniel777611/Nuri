from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from types import SimpleNamespace

import pytest
import stripe
from fastapi import HTTPException
from starlette.requests import Request

from backend import billing, main


# ── Fakes ─────────────────────────────────────────────────────────────────────

class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.orders, self.limit_count = [], [], None
        self.operation, self.payload, self.conflict = "select", None, None

    def select(self, *_args): return self
    def eq(self, key, value): self.filters.append(lambda row: row.get(key) == value); return self
    def order(self, key, desc=False): self.orders.append((key, desc)); return self
    def limit(self, count): self.limit_count = count; return self
    def upsert(self, payload, on_conflict=None):
        self.operation, self.payload, self.conflict = "upsert", dict(payload), on_conflict
        return self
    def delete(self): self.operation = "delete"; return self

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        if self.operation == "delete":
            gone = [r for r in rows if all(f(r) for f in self.filters)]
            rows[:] = [r for r in rows if r not in gone]
            return SimpleNamespace(data=gone)
        if self.operation == "upsert":
            key = self.conflict or "id"
            existing = next((r for r in rows if r.get(key) == self.payload[key]), None)
            if existing:
                existing.update(self.payload)
            else:
                rows.append(dict(self.payload)); existing = rows[-1]
            return SimpleNamespace(data=[dict(existing)])
        hits = [r for r in rows if all(f(r) for f in self.filters)]
        for key, desc in reversed(self.orders):
            hits.sort(key=lambda r: str(r.get(key) or ""), reverse=desc)
        if self.limit_count is not None:
            hits = hits[: self.limit_count]
        return SimpleNamespace(data=[dict(r) for r in hits])


class Database:
    def __init__(self):
        self.tables = {
            "users": [{"id": "u1", "email": "parent@example.test"}],
            "billing_customers": [],
            "billing_subscriptions": [],
        }

    def table(self, name): return Query(self, name)


def _obj(data):
    return stripe.StripeObject.construct_from(data, "sk_test_fake")


class FakeStripe:
    """Just the corner of StripeClient that billing.py touches."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.subscriptions_by_id: dict[str, dict] = {}
        self.list_error: Exception | None = None
        self.prices_by_id = {
            "price_m": {"id": "price_m", "unit_amount": 999, "currency": "usd",
                        "recurring": {"interval": "month"}},
            "price_y": {"id": "price_y", "unit_amount": 9900, "currency": "usd",
                        "recurring": {"interval": "year"}},
        }
        fake = self

        class Customers:
            def create(self, params=None, options=None):
                fake.calls.append(("customers.create", {**params, **(options or {})}))
                return _obj({"id": "cus_1"})

        class CheckoutSessions:
            def create(self, params=None, options=None):
                fake.calls.append(("checkout.create", params))
                return _obj({"id": "cs_1", "url": "https://checkout.stripe.test/cs_1"})

        class PortalSessions:
            def create(self, params=None, options=None):
                fake.calls.append(("portal.create", params))
                return _obj({"id": "bps_1", "url": "https://billing.stripe.test/p"})

        class Subscriptions:
            def retrieve(self, sid, params=None, options=None):
                return _obj(fake.subscriptions_by_id[sid])

            def list(self, params=None, options=None):
                fake.calls.append(("subscriptions.list", params))
                if fake.list_error:
                    raise fake.list_error
                return _obj({"object": "list", "data": [
                    s for s in fake.subscriptions_by_id.values()
                    if s["customer"] == params["customer"]
                ]})

            def cancel(self, sid, params=None, options=None):
                fake.calls.append(("subscriptions.cancel", {"id": sid}))
                fake.subscriptions_by_id[sid]["status"] = "canceled"
                return _obj(fake.subscriptions_by_id[sid])

        class Prices:
            def retrieve(self, pid, params=None, options=None):
                return _obj(fake.prices_by_id[pid])

        self.v1 = SimpleNamespace(
            customers=Customers(),
            checkout=SimpleNamespace(sessions=CheckoutSessions()),
            billing_portal=SimpleNamespace(sessions=PortalSessions()),
            subscriptions=Subscriptions(),
            prices=Prices(),
        )


def _subscription(status="active", *, uid="u1", sid="sub_1", interval="month"):
    return {
        "id": sid, "object": "subscription", "customer": "cus_1", "status": status,
        "metadata": {"user_id": uid} if uid else {},
        "cancel_at_period_end": False, "canceled_at": None,
        "items": {"object": "list", "data": [{
            "current_period_end": 1_790_000_000,
            "price": {"id": "price_m", "recurring": {"interval": interval}},
        }]},
    }


WEBHOOK_SECRET = "whsec_test_secret"


@pytest.fixture
def env(monkeypatch):
    db = Database()
    fake = FakeStripe()
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_fake")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    monkeypatch.setenv("STRIPE_PRICE_MONTHLY", "price_m")
    monkeypatch.setenv("STRIPE_PRICE_YEARLY", "price_y")
    monkeypatch.delenv("BILLING_RETURN_URL", raising=False)
    monkeypatch.setattr(billing, "_client", lambda: fake)
    monkeypatch.setattr(main, "_get_supabase", lambda: db)
    billing._PLAN_CACHE.update(at=0.0, plans=None)
    return SimpleNamespace(db=db, stripe=fake)


def _request(body: bytes = b"", headers: dict | None = None) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {"type": "http", "method": "POST", "path": "/", "headers": raw, "query_string": b""}

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(scope, receive)


def _signed(event: dict) -> tuple[bytes, str]:
    payload = json.dumps(event).encode()
    ts = int(time.time())
    sig = hmac.new(WEBHOOK_SECRET.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return payload, f"t={ts},v1={sig}"


# ── Status / plans ────────────────────────────────────────────────────────────

def test_status_without_config_is_disabled(monkeypatch):
    db = Database()
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.setattr(main, "_get_supabase", lambda: db)
    result = asyncio.run(main.billing_status("u1"))
    assert result["enabled"] is False
    assert result["entitled"] is False
    assert result["plans"] == []


def test_plans_come_from_stripe(env):
    result = asyncio.run(main.billing_status("u1"))
    assert result["enabled"] is True
    assert {p["interval"]: p["unit_amount"] for p in result["plans"]} == {"month": 999, "year": 9900}


def test_mismatched_price_interval_is_hidden(env):
    env.stripe.prices_by_id["price_m"]["recurring"]["interval"] = "year"
    assert [p["interval"] for p in billing.plans()] == ["year"]


# ── Checkout / portal ─────────────────────────────────────────────────────────

def test_checkout_creates_customer_once_and_returns_to_origin(env):
    req = _request(headers={"origin": "https://nuri-xi.vercel.app"})
    first = asyncio.run(main.billing_checkout(main.CheckoutIn(interval="month"), req, "u1"))
    asyncio.run(main.billing_checkout(main.CheckoutIn(interval="year"), req, "u1"))
    assert first["url"].startswith("https://checkout.stripe.test/")
    assert [c for c, _ in env.stripe.calls].count("customers.create") == 1
    assert env.db.tables["billing_customers"] == [{"user_id": "u1", "stripe_customer_id": "cus_1"}]
    params = [p for c, p in env.stripe.calls if c == "checkout.create"][0]
    assert params["mode"] == "subscription"
    assert params["line_items"] == [{"price": "price_m", "quantity": 1}]
    assert params["subscription_data"]["metadata"] == {"user_id": "u1"}
    assert params["success_url"] == "https://nuri-xi.vercel.app/billing?checkout=success"


def test_checkout_ignores_non_https_origin(env, monkeypatch):
    monkeypatch.setattr(main, "APP_URL", "https://app.example.test")
    req = _request(headers={"origin": "http://evil.example"})
    asyncio.run(main.billing_checkout(main.CheckoutIn(interval="month"), req, "u1"))
    params = [p for c, p in env.stripe.calls if c == "checkout.create"][0]
    assert params["cancel_url"] == "https://app.example.test/billing?checkout=cancel"


def test_checkout_refuses_a_second_subscription(env):
    env.db.tables["billing_subscriptions"].append(
        {"id": "sub_1", "user_id": "u1", "status": "active", "updated_at": "2026-09-26T00:00:00Z"}
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.billing_checkout(main.CheckoutIn(interval="month"), _request(), "u1"))
    assert exc.value.status_code == 409


def test_portal_needs_a_customer(env):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.billing_portal(_request(), uid="u1"))
    assert exc.value.status_code == 404
    env.db.tables["billing_customers"].append({"user_id": "u1", "stripe_customer_id": "cus_1"})
    assert asyncio.run(main.billing_portal(_request(), uid="u1"))["url"].startswith("https://billing.")


def test_checkout_from_the_app_returns_to_a_back_to_app_page(env):
    req = _request(headers={"origin": "https://nurifam.app"})
    asyncio.run(main.billing_checkout(
        main.CheckoutIn(interval="month", return_to="app"), req, "u1"))
    params = [p for c, p in env.stripe.calls if c == "checkout.create"][0]
    assert params["success_url"] == "https://nurifam.app/billing?checkout=success&from=app"
    assert params["cancel_url"] == "https://nurifam.app/billing?checkout=cancel&from=app"


def test_portal_from_the_app_returns_to_a_back_to_app_page(env):
    env.db.tables["billing_customers"].append({"user_id": "u1", "stripe_customer_id": "cus_1"})
    req = _request(headers={"origin": "https://nurifam.app"})
    asyncio.run(main.billing_portal(req, main.PortalIn(return_to="app"), uid="u1"))
    params = [p for c, p in env.stripe.calls if c == "portal.create"][0]
    assert params["return_url"] == "https://nurifam.app/billing?from=app"


# ── Webhook ───────────────────────────────────────────────────────────────────

def test_webhook_rejects_bad_signature(env):
    payload, _ = _signed({"id": "evt_1", "type": "customer.subscription.updated"})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.billing_webhook(_request(payload), "t=1,v1=deadbeef"))
    assert exc.value.status_code == 400


def test_webhook_mirrors_subscription_from_stripe_not_payload(env):
    env.stripe.subscriptions_by_id["sub_1"] = _subscription("active")
    # The payload says past_due, but Stripe (re-read) says active: Stripe wins.
    event = {"id": "evt_1", "object": "event", "type": "customer.subscription.updated",
             "data": {"object": {**_subscription("past_due"), "status": "past_due"}}}
    payload, sig = _signed(event)
    result = asyncio.run(main.billing_webhook(_request(payload), sig))
    assert result["handled"] is True
    row = env.db.tables["billing_subscriptions"][0]
    assert row["status"] == "active"
    assert row["plan_interval"] == "month"
    assert row["current_period_end"].startswith("2026-09-21")
    status = billing.status_for(env.db, "u1")
    assert status["entitled"] is True


def test_checkout_completed_links_subscription(env):
    env.stripe.subscriptions_by_id["sub_1"] = _subscription("active")
    event = {"id": "evt_2", "object": "event", "type": "checkout.session.completed",
             "data": {"object": {"id": "cs_1", "mode": "subscription", "subscription": "sub_1"}}}
    payload, sig = _signed(event)
    asyncio.run(main.billing_webhook(_request(payload), sig))
    assert env.db.tables["billing_customers"] == [{"user_id": "u1", "stripe_customer_id": "cus_1"}]
    assert env.db.tables["billing_subscriptions"][0]["id"] == "sub_1"


def test_cancellation_ends_entitlement(env):
    env.stripe.subscriptions_by_id["sub_1"] = _subscription("canceled")
    billing.sync_subscription(env.db, "sub_1")
    status = billing.status_for(env.db, "u1")
    assert status["entitled"] is False
    assert status["subscription"]["status"] == "canceled"


def test_subscription_found_by_customer_when_metadata_missing(env):
    env.db.tables["billing_customers"].append({"user_id": "u1", "stripe_customer_id": "cus_1"})
    env.stripe.subscriptions_by_id["sub_1"] = _subscription("active", uid=None)
    assert billing.sync_subscription(env.db, "sub_1")["user_id"] == "u1"


def test_unrelated_events_are_acknowledged(env):
    payload, sig = _signed({"id": "evt_3", "object": "event", "type": "invoice.paid",
                            "data": {"object": {}}})
    result = asyncio.run(main.billing_webhook(_request(payload), sig))
    assert result == {"received": True, "handled": False, "type": "invoice.paid"}


# ── Account deletion ──────────────────────────────────────────────────────────

def _with_customer(env):
    env.db.tables["billing_customers"].append({"user_id": "u1", "stripe_customer_id": "cus_1"})


def test_deletion_cancels_every_live_subscription(env):
    _with_customer(env)
    env.stripe.subscriptions_by_id["sub_1"] = _subscription("active")
    env.stripe.subscriptions_by_id["sub_2"] = _subscription("past_due", sid="sub_2")
    env.stripe.subscriptions_by_id["sub_old"] = _subscription("canceled", sid="sub_old")
    assert billing.cancel_for_account(env.db, "u1") == ["sub_1", "sub_2"]
    # Stripe's list, not the (empty) local rows, decides what gets cancelled.
    assert env.db.tables["billing_subscriptions"] == []
    assert ("subscriptions.cancel", {"id": "sub_old"}) not in env.stripe.calls


def test_deletion_without_a_customer_never_calls_stripe(env):
    assert billing.cancel_for_account(env.db, "u1") == []
    assert env.stripe.calls == []


def test_deletion_tolerates_a_customer_from_the_other_stripe_mode(env):
    _with_customer(env)
    env.stripe.list_error = stripe.InvalidRequestError(
        "No such customer: 'cus_1'", "customer", code="resource_missing")
    assert billing.cancel_for_account(env.db, "u1") == []


def test_deletion_cancel_failure_is_raised(env):
    _with_customer(env)
    env.stripe.list_error = stripe.APIConnectionError("network down")
    with pytest.raises(billing.SubscriptionCancelFailed):
        billing.cancel_for_account(env.db, "u1")


def test_deletion_without_a_stripe_key_is_a_failure_not_a_skip(env, monkeypatch):
    _with_customer(env)
    monkeypatch.setattr(billing, "_client", lambda: (_ for _ in ()).throw(
        billing.BillingNotConfigured("no key")))
    with pytest.raises(billing.SubscriptionCancelFailed):
        billing.cancel_for_account(env.db, "u1")


def test_admin_delete_cancels_the_subscription_first(env):
    _with_customer(env)
    env.stripe.subscriptions_by_id["sub_1"] = _subscription("active")
    result = asyncio.run(main.admin_delete_account("u1", None))
    assert result["subscriptions_cancelled"] == ["sub_1"]
    assert env.stripe.subscriptions_by_id["sub_1"]["status"] == "canceled"
    assert env.db.tables["users"] == []


def test_admin_delete_keeps_the_account_when_cancel_fails(env):
    _with_customer(env)
    env.stripe.list_error = stripe.APIConnectionError("network down")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.admin_delete_account("u1", None))
    assert exc.value.status_code == 502
    assert [u["id"] for u in env.db.tables["users"]] == ["u1"]


def test_webhook_for_a_deleted_account_is_acknowledged_not_retried(env):
    env.db.tables["users"].clear()
    env.stripe.subscriptions_by_id["sub_1"] = _subscription("canceled")
    event = {"id": "evt_4", "object": "event", "type": "customer.subscription.deleted",
             "data": {"object": _subscription("canceled")}}
    payload, sig = _signed(event)
    result = asyncio.run(main.billing_webhook(_request(payload), sig))
    assert result["handled"] is False
    assert env.db.tables["billing_subscriptions"] == []
    assert env.db.tables["billing_customers"] == []
