"""Tiers, plan changes and the daily allowance (billing.py, quota.py)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
import stripe
from fastapi import HTTPException

from backend import billing, main, quota
from backend.tests.test_billing import Database, FakeStripe, Query, _obj, _request, _subscription


# ── Fakes: the corners test_billing.py's fakes don't cover ───────────────────

def _like(self, key, pattern):
    prefix = pattern.rstrip("%")
    self.filters.append(lambda row: str(row.get(key) or "").startswith(prefix))
    return self


def _gte(self, key, value):
    self.filters.append(lambda row: str(row.get(key) or "") >= value)
    return self


def _in(self, key, values):
    self.filters.append(lambda row: row.get(key) in values)
    return self


PRICES = {
    "price_plus_m": ("plus", "month", 900),
    "price_plus_y": ("plus", "year", 9000),
    "price_unl_m": ("unlimited", "month", 1999),
    "price_unl_y": ("unlimited", "year", 19900),
}


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(Query, "like", _like, raising=False)
    monkeypatch.setattr(Query, "gte", _gte, raising=False)
    monkeypatch.setattr(Query, "in_", _in, raising=False)
    db = Database()
    db.tables["llm_call_logs"] = []
    db.tables["app_settings"] = []
    db.tables[quota.OVERRIDE_TABLE] = []
    quota._config_cache.update(at=0.0, value=None)
    fake = FakeStripe()
    fake.prices_by_id = {
        pid: {"id": pid, "unit_amount": amount, "currency": "usd",
              "recurring": {"interval": interval}}
        for pid, (_tier, interval, amount) in PRICES.items()
    }
    updates: list[tuple[str, dict]] = []

    def update(sid, params=None, options=None):
        updates.append((sid, params))
        if getattr(fake, "decline", False):
            raise stripe.CardError("declined", None, "card_declined")
        sub = fake.subscriptions_by_id[sid]
        price_id = params["items"][0]["price"]
        sub["items"]["data"][0]["price"] = {
            "id": price_id, "recurring": {"interval": PRICES[price_id][1]},
        }
        return _obj(sub)

    fake.v1.subscriptions.update = update
    fake.updates = updates
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_fake")
    for name in ("STRIPE_PRICE_MONTHLY", "STRIPE_PRICE_YEARLY", "QUOTA_ENFORCED"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("STRIPE_PRICE_PLUS_MONTHLY", "price_plus_m")
    monkeypatch.setenv("STRIPE_PRICE_PLUS_YEARLY", "price_plus_y")
    monkeypatch.setenv("STRIPE_PRICE_UNLIMITED_MONTHLY", "price_unl_m")
    monkeypatch.setenv("STRIPE_PRICE_UNLIMITED_YEARLY", "price_unl_y")
    monkeypatch.setattr(billing, "_client", lambda: fake)
    monkeypatch.setattr(main, "_get_supabase", lambda: db)
    billing._PLAN_CACHE.update(at=0.0, plans=None)
    return SimpleNamespace(db=db, stripe=fake)


def _subscribe(env, price_id="price_plus_m", status="active"):
    sub = _subscription(status)
    sub["items"]["data"][0]["id"] = "si_1"
    sub["items"]["data"][0]["price"] = {
        "id": price_id, "recurring": {"interval": PRICES[price_id][1]},
    }
    env.stripe.subscriptions_by_id["sub_1"] = sub
    billing.sync_subscription(env.db, "sub_1")


def _spend(env, tokens, *, site="chat.reply_stream", uid="u1",
           at="2026-10-09T15:00:00+00:00"):
    env.db.tables["llm_call_logs"].append(
        {"user_id": uid, "call_site": site, "total_tokens": tokens, "created_at": at}
    )


# ── Tiers and prices ──────────────────────────────────────────────────────────

def test_every_paid_tier_and_interval_is_a_plan(env):
    plans = billing.plans()
    assert {(p["tier"], p["interval"]) for p in plans} == {
        ("plus", "month"), ("plus", "year"), ("unlimited", "month"), ("unlimited", "year"),
    }


def test_the_pre_tier_membership_price_is_unlimited(env, monkeypatch):
    monkeypatch.delenv("STRIPE_PRICE_UNLIMITED_MONTHLY")
    monkeypatch.setenv("STRIPE_PRICE_MONTHLY", "price_legacy")
    assert billing.tier_for_price("price_legacy") == "unlimited"


def test_no_subscription_is_basic(env):
    assert billing.status_for(env.db, "u1")["tier"] == "basic"


def test_the_tier_comes_from_the_price_and_is_stored(env):
    _subscribe(env, "price_unl_y")
    row = env.db.tables["billing_subscriptions"][0]
    assert row["tier"] == "unlimited"
    status = billing.status_for(env.db, "u1")
    assert status["tier"] == "unlimited"
    assert status["subscription"]["tier"] == "unlimited"


def test_a_rotated_price_keeps_the_tier_that_was_bought(env, monkeypatch):
    _subscribe(env, "price_plus_m")
    monkeypatch.setenv("STRIPE_PRICE_PLUS_MONTHLY", "price_plus_m_v2")
    assert billing.tier_for(env.db, "u1") == "plus"


def test_price_metadata_names_the_tier_of_an_unmapped_price(env):
    sub = _subscription("active")
    sub["items"]["data"][0]["price"] = {
        "id": "price_old", "recurring": {"interval": "month"},
        "metadata": {"nuri_tier": "plus"},
    }
    env.stripe.subscriptions_by_id["sub_1"] = sub
    assert billing.sync_subscription(env.db, "sub_1")["tier"] == "plus"


def test_a_canceled_subscription_is_basic_again(env):
    _subscribe(env, "price_unl_m", status="canceled")
    assert billing.tier_for(env.db, "u1") == "basic"


def test_checkout_buys_the_requested_tier(env):
    asyncio.run(main.billing_checkout(
        main.CheckoutIn(tier="plus", interval="year"), _request(), "u1"))
    params = [p for c, p in env.stripe.calls if c == "checkout.create"][0]
    assert params["line_items"] == [{"price": "price_plus_y", "quantity": 1}]


def test_checkout_without_a_tier_buys_unlimited(env):
    asyncio.run(main.billing_checkout(main.CheckoutIn(interval="month"), _request(), "u1"))
    params = [p for c, p in env.stripe.calls if c == "checkout.create"][0]
    assert params["line_items"] == [{"price": "price_unl_m", "quantity": 1}]


# ── Changing plan ─────────────────────────────────────────────────────────────

def test_upgrade_changes_the_existing_subscription_and_bills_now(env):
    _subscribe(env, "price_plus_m")
    result = asyncio.run(main.billing_change(
        main.PlanChangeIn(tier="unlimited", interval="month"), "u1"))
    sid, params = env.stripe.updates[0]
    assert sid == "sub_1"
    assert params["items"] == [{"id": "si_1", "price": "price_unl_m"}]
    assert params["proration_behavior"] == "always_invoice"
    assert params["payment_behavior"] == "error_if_incomplete"
    assert result["tier"] == "unlimited"
    assert not [c for c, _ in env.stripe.calls if c == "checkout.create"]


def test_downgrade_credits_the_next_invoice(env):
    _subscribe(env, "price_unl_m")
    asyncio.run(main.billing_change(main.PlanChangeIn(tier="plus", interval="month"), "u1"))
    _, params = env.stripe.updates[0]
    assert params["proration_behavior"] == "create_prorations"
    assert "payment_behavior" not in params


def test_monthly_to_yearly_on_the_same_tier_is_compared_per_month(env):
    _subscribe(env, "price_plus_m")
    asyncio.run(main.billing_change(main.PlanChangeIn(tier="plus", interval="year"), "u1"))
    # $90/yr is $7.50/mo, below $9/mo: not an upgrade.
    assert env.stripe.updates[0][1]["proration_behavior"] == "create_prorations"


def test_a_declined_upgrade_leaves_the_plan_alone(env):
    _subscribe(env, "price_plus_m")
    env.stripe.decline = True
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.billing_change(
            main.PlanChangeIn(tier="unlimited", interval="month"), "u1"))
    assert exc.value.status_code == 402
    assert exc.value.detail == "PAYMENT_FAILED"
    assert billing.tier_for(env.db, "u1") == "plus"


def test_changing_plan_needs_a_subscription(env):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.billing_change(main.PlanChangeIn(tier="plus", interval="month"), "u1"))
    assert exc.value.status_code == 409


def test_choosing_the_current_plan_changes_nothing(env):
    _subscribe(env, "price_plus_m")
    asyncio.run(main.billing_change(main.PlanChangeIn(tier="plus", interval="month"), "u1"))
    assert env.stripe.updates == []


# ── Daily allowance ───────────────────────────────────────────────────────────

NOON_UTC = datetime(2026, 10, 9, 17, 0, tzinfo=timezone.utc)


def test_default_allowances_are_ten_and_twenty_five_turns(env):
    config = quota.load_config(env.db)
    assert quota.tier_turns(config, "basic") == 10
    assert quota.tier_turns(config, "plus") == 25
    assert quota.tier_turns(config, "unlimited") is None
    assert config["tokens_per_turn"] == 13_000


def test_allowances_are_changed_from_the_admin_page(env):
    asyncio.run(main.admin_set_quota_config(
        main.QuotaConfigUpdate(basic_turns=8, plus_turns=30, tokens_per_turn=12_000)))
    quota._config_cache.update(at=0.0, value=None)   # another instance reads the row
    config = quota.load_config(env.db)
    assert config["turns"] == {"basic": 8, "plus": 30, "unlimited": None}
    snap = quota.snapshot(env.db, "u1", "UTC", now=NOON_UTC)
    assert snap["limit"] == 8 * 12_000
    assert snap["limit_turns"] == 8


def test_a_garbled_config_row_falls_back_to_defaults(env):
    env.db.tables["app_settings"].append({"key": quota.CONFIG_KEY, "value": '{"turns": {"basic": -3}}'})
    assert quota.tier_turns(quota.load_config(env.db, fresh=True), "basic") == 10


def test_only_the_parents_own_chat_spending_counts(env):
    _spend(env, 40_000)
    _spend(env, 9_000, site="chat.router")
    _spend(env, 90_000, site="feed.daily_post_pick")   # the product's work, not theirs
    _spend(env, 70_000, uid="someone-else")
    _spend(env, 80_000, at="2026-10-08T15:00:00+00:00")  # yesterday
    snap = quota.snapshot(env.db, "u1", "UTC", now=NOON_UTC)
    assert snap["used"] == 49_000
    assert snap["remaining"] == 130_000 - 49_000
    assert snap["exhausted"] is False


def test_the_day_is_the_parents_own(env):
    # 03:00 UTC on the 9th is still the 8th in Chicago.
    _spend(env, 100_000, at="2026-10-09T03:00:00+00:00")
    assert quota.snapshot(env.db, "u1", "UTC", now=NOON_UTC)["used"] == 100_000
    chicago = quota.snapshot(env.db, "u1", "America/Chicago", now=NOON_UTC)
    assert chicago["used"] == 0
    assert chicago["resets_at"] == "2026-10-10T05:00:00+00:00"


def test_unlimited_never_runs_out(env):
    _subscribe(env, "price_unl_m")
    _spend(env, 5_000_000)
    snap = quota.snapshot(env.db, "u1", "UTC", now=NOON_UTC)
    assert snap["limit"] is None and snap["exhausted"] is False


def test_nothing_is_blocked_unless_enforced(env):
    _spend(env, 500_000, at=datetime.now(timezone.utc).isoformat())
    assert quota.blocks(env.db, "u1") is None


def _turn_body(client_message_id=None):
    return main.UserMessageIn(text="hi", client_message_id=client_message_id)


def test_an_enforced_quota_refuses_the_next_turn(env, monkeypatch):
    monkeypatch.setenv("QUOTA_ENFORCED", "1")
    _spend(env, 130_000, at=datetime.now(timezone.utc).isoformat())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main._require_chat_allowance("s1", _turn_body(), "u1"))
    assert exc.value.status_code == 402
    assert exc.value.detail == "DAILY_QUOTA_REACHED"


def test_an_upgrade_lifts_the_block(env, monkeypatch):
    monkeypatch.setenv("QUOTA_ENFORCED", "1")
    _spend(env, 130_000, at=datetime.now(timezone.utc).isoformat())
    _subscribe(env, "price_plus_m")
    asyncio.run(main._require_chat_allowance("s1", _turn_body(), "u1"))


def test_a_retry_of_an_accepted_turn_is_not_refused(env, monkeypatch):
    monkeypatch.setenv("QUOTA_ENFORCED", "1")
    _spend(env, 130_000, at=datetime.now(timezone.utc).isoformat())
    env.db.tables["chat_messages"] = [{"id": main._user_message_id("s1", "client-1")}]
    asyncio.run(main._require_chat_allowance("s1", _turn_body("client-1"), "u1"))


def test_status_reports_tier_usage_and_allowances(env):
    _spend(env, 1_000, at=datetime.now(timezone.utc).isoformat())
    result = asyncio.run(main.billing_status("u1", tz="UTC"))
    assert result["tier"] == "basic"
    assert result["usage"]["used"] == 1_000
    assert result["usage"]["limit"] == 130_000
    assert result["allowances"] == {"basic": 10, "plus": 25, "unlimited": None}


# ── Per-account overrides ─────────────────────────────────────────────────────

def _override(env, **body):
    return asyncio.run(main.admin_set_quota_override(main.QuotaOverrideUpdate(**body)))


def test_a_sponsored_account_gets_its_own_allowance(env):
    _override(env, email="Parent@Example.test", daily_turns=100, note="赞助")
    snap = quota.snapshot(env.db, "u1", "UTC", now=NOON_UTC)
    assert snap["limit_turns"] == 100
    assert snap["limit"] == 100 * 13_000
    assert snap["override"] is True


def test_an_override_can_be_unlimited(env):
    _override(env, user_id="u1", daily_turns=None)
    snap = quota.snapshot(env.db, "u1", "UTC", now=NOON_UTC)
    assert snap["limit"] is None and snap["exhausted"] is False


def test_an_override_never_lowers_a_paid_tier(env):
    _subscribe(env, "price_plus_m")
    _override(env, user_id="u1", daily_turns=12)
    assert quota.snapshot(env.db, "u1", "UTC", now=NOON_UTC)["limit_turns"] == 25


def test_an_expired_override_stops_applying(env):
    _override(env, user_id="u1", daily_turns=100,
              expires_at=datetime(2026, 10, 1, tzinfo=timezone.utc))
    snap = quota.snapshot(env.db, "u1", "UTC", now=NOON_UTC)
    assert snap["limit_turns"] == 10 and snap["override"] is False


def test_an_override_for_an_unknown_email_is_refused(env):
    with pytest.raises(HTTPException) as exc:
        _override(env, email="nobody@example.test", daily_turns=50)
    assert exc.value.status_code == 404


def test_the_admin_list_names_each_overridden_account(env):
    _override(env, user_id="u1", daily_turns=40, note="赞助")
    result = asyncio.run(main.admin_get_quota())
    assert result["config"]["turns"]["plus"] == 25
    assert result["overrides"][0]["email"] == "parent@example.test"
    assert result["overrides"][0]["daily_turns"] == 40


def test_overrides_fail_open_without_the_table(env):
    del env.db.tables[quota.OVERRIDE_TABLE]

    def broken(name):
        if name == quota.OVERRIDE_TABLE:
            raise RuntimeError("relation user_quota_overrides does not exist")
        return Query(env.db, name)

    env.db.table = broken
    assert quota.snapshot(env.db, "u1", "UTC", now=NOON_UTC)["limit_turns"] == 10
