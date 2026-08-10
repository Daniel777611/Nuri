"""Tests for the provider-spend instrumentation.

The point of `llm_usage` is to be trusted when it says where the money went, so
the two things worth pinning are that it reads both SDK usage shapes correctly
and that it can never take a request down with it.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from backend import llm_usage, main, runtime


@pytest.fixture
def writes_allowed(monkeypatch):
    """Let `record` reach the fake client in this module's tests.

    Writes are suppressed under pytest because the suite runs against the real
    project database, so the tests that exercise the write path have to opt in
    explicitly — and they only ever hand it a fake.
    """
    monkeypatch.setattr(llm_usage, "_ALLOW_IN_TESTS", True)


# ── Usage normalization ──────────────────────────────────────────────────────
# The chat and responses APIs disagree on every field name. A summary that
# groups across both is only meaningful if this mapping is right.

def test_chat_usage_shape_is_normalized():
    usage = SimpleNamespace(
        prompt_tokens=1200,
        completion_tokens=800,
        total_tokens=2000,
        completion_tokens_details=SimpleNamespace(reasoning_tokens=512),
        prompt_tokens_details=SimpleNamespace(cached_tokens=1024),
    )
    assert llm_usage.usage_fields(usage) == {
        "prompt_tokens": 1200,
        "completion_tokens": 800,
        "total_tokens": 2000,
        "reasoning_tokens": 512,
        "cached_prompt_tokens": 1024,
    }


def test_responses_usage_shape_lands_in_the_same_columns():
    usage = SimpleNamespace(
        input_tokens=90_000,
        output_tokens=4_000,
        total_tokens=94_000,
        output_tokens_details=SimpleNamespace(reasoning_tokens=2_500),
        input_tokens_details=SimpleNamespace(cached_tokens=0),
    )
    assert llm_usage.usage_fields(usage) == {
        "prompt_tokens": 90_000,
        "completion_tokens": 4_000,
        "total_tokens": 94_000,
        "reasoning_tokens": 2_500,
        "cached_prompt_tokens": 0,
    }


def test_total_is_derived_when_the_provider_omits_it():
    usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5)
    assert llm_usage.usage_fields(usage)["total_tokens"] == 15


def test_missing_usage_contributes_no_columns():
    assert llm_usage.usage_fields(None) == {}


def test_dict_usage_is_accepted():
    """Some SDK paths hand back plain dicts, and a row of nulls from a shape
    mismatch would read as a free call rather than an unmeasured one."""
    usage = {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}
    fields = llm_usage.usage_fields(usage)
    assert fields["prompt_tokens"] == 7
    assert fields["total_tokens"] == 10


# ── Tool rounds ──────────────────────────────────────────────────────────────

def test_tool_calls_are_counted_from_the_response_output():
    response = SimpleNamespace(output=[
        SimpleNamespace(type="web_search_call"),
        SimpleNamespace(type="message"),
        SimpleNamespace(type="web_search_call"),
        SimpleNamespace(type="web_search_call"),
    ])
    assert llm_usage.count_tool_calls(response) == 3


def test_tool_calls_are_absent_rather_than_zero_for_a_plain_completion():
    """Zero and "not a tool-using API" must not look alike: averaging a chat
    call's absent count in as 0 would dilute the number that explains the bill."""
    assert llm_usage.count_tool_calls(SimpleNamespace()) is None


# ── Failure containment ──────────────────────────────────────────────────────

def test_record_is_a_noop_without_supabase(monkeypatch):
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)
    llm_usage.record("chat.reply", "gpt-5.5", usage=SimpleNamespace(prompt_tokens=1))


def test_record_swallows_a_broken_table(monkeypatch, writes_allowed):
    """The realistic failure is the migration not having been run. That must
    cost a warning, not the turn the parent is waiting on."""

    class Broken:
        def table(self, _name):
            raise RuntimeError("relation \"llm_call_logs\" does not exist")

    monkeypatch.setattr(runtime, "get_supabase", lambda: Broken())
    monkeypatch.setattr(llm_usage, "_warned", False)
    llm_usage.record("content_research.prepare", "gpt-5.4-mini")


def test_record_writes_the_correlation_and_account_fields(monkeypatch, writes_allowed):
    written: list[dict] = []

    class Recorder:
        def table(self, name):
            assert name == "llm_call_logs"
            return self

        def insert(self, row):
            written.append(row)
            return self

        def execute(self):
            return SimpleNamespace(data=[])

    monkeypatch.setattr(runtime, "get_supabase", lambda: Recorder())
    rid = llm_usage.new_request_id()
    llm_usage.set_user("user-1")
    llm_usage.record(
        "content_research.reserve", "gpt-5.4-mini", api="responses",
        usage=SimpleNamespace(input_tokens=120_000, output_tokens=3_000),
        tool_calls=18, duration_ms=27_000,
    )
    assert len(written) == 1
    row = written[0]
    assert row["call_site"] == "content_research.reserve"
    assert row["request_id"] == rid
    assert row["user_id"] == "user-1"
    assert row["tool_calls"] == 18
    assert row["prompt_tokens"] == 120_000
    assert row["api"] == "responses"


def test_explicit_user_id_beats_the_context(monkeypatch, writes_allowed):
    """The daily push loops over accounts inside one request, so the loop's own
    uid has to win over whatever the request context holds."""
    written: list[dict] = []

    class Recorder:
        def table(self, _name):
            return self

        def insert(self, row):
            written.append(row)
            return self

        def execute(self):
            return SimpleNamespace(data=[])

    monkeypatch.setattr(runtime, "get_supabase", lambda: Recorder())
    llm_usage.set_user("request-owner")
    llm_usage.record("push.keywords", "gpt-4.1-mini", user_id="loop-target")
    assert written[0]["user_id"] == "loop-target"


# ── The summary the decision gets made from ──────────────────────────────────

class _SpendSupabase:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return self

    def select(self, *_a, **_k):
        return self

    def gte(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows, count=len(self._rows))


def _row(**kw):
    base = {
        "call_site": "chat.reply", "model": "gpt-5.5", "api": "chat",
        "request_id": "r1", "duration_ms": 1000, "prompt_tokens": 0,
        "completion_tokens": 0, "total_tokens": 0, "reasoning_tokens": 0,
        "cached_prompt_tokens": 0, "tool_calls": 0, "status": "ok",
        "created_at": "2026-08-06T00:00:00+00:00",
    }
    base.update(kw)
    return base


def _summary(monkeypatch, rows, price_table=None):
    monkeypatch.setattr(main, "_get_supabase", lambda: _SpendSupabase(rows))
    monkeypatch.setattr(main, "_require_admin", lambda: None)
    if price_table is None:
        monkeypatch.delenv("LLM_PRICE_TABLE", raising=False)
    else:
        monkeypatch.setenv("LLM_PRICE_TABLE", json.dumps(price_table))
    return asyncio.run(main.admin_llm_usage_summary(days=7))


def test_summary_ranks_call_sites_by_tokens(monkeypatch):
    rows = [
        _row(call_site="chat.reply", prompt_tokens=6_000,
             completion_tokens=800, total_tokens=6_800),
        _row(call_site="content_research.prepare", model="gpt-5.4-mini",
             prompt_tokens=300_000, completion_tokens=5_000,
             total_tokens=305_000, tool_calls=18, request_id="r2"),
    ]
    out = _summary(monkeypatch, rows)
    assert [s["call_site"] for s in out["by_call_site"]] == [
        "content_research.prepare", "chat.reply",
    ]
    assert out["total"]["total_tokens"] == 311_800
    # Without a price table the ranking still has to work, on tokens.
    assert out["pricing_configured"] is False
    assert out["by_call_site"][0]["cost_usd"] is None
    assert out["by_call_site"][0]["share"] > 0.9


def test_summary_groups_one_action_into_one_request(monkeypatch):
    """The finding this table exists to surface: a single HTTP request making
    many provider calls."""
    rows = [
        _row(call_site="content_research.prepare", request_id="feed-1",
             prompt_tokens=200_000, total_tokens=200_000, tool_calls=18),
        _row(call_site="content_research.prepare_repair", request_id="feed-1",
             prompt_tokens=90_000, total_tokens=90_000, tool_calls=12),
        _row(call_site="content_research.reserve", request_id="feed-1",
             prompt_tokens=180_000, total_tokens=180_000, tool_calls=18),
        _row(call_site="chat.reply", request_id="chat-1",
             prompt_tokens=6_000, total_tokens=6_000),
    ]
    out = _summary(monkeypatch, rows)
    worst = out["worst_requests"][0]
    assert worst["request_id"] == "feed-1"
    assert worst["calls"] == 3
    assert worst["total_tokens"] == 470_000
    assert worst["avg_tool_calls"] == 16.0


def test_summary_prices_cached_prompt_tokens_at_a_discount(monkeypatch):
    """A working cache has to be visible as a saving, otherwise there is no way
    to tell whether fixing the cache key was worth anything."""
    rows = [
        _row(model="m", prompt_tokens=1_000_000, cached_prompt_tokens=1_000_000,
             completion_tokens=0, total_tokens=1_000_000),
    ]
    out = _summary(monkeypatch, rows, price_table={"m": [10.0, 30.0]})
    assert out["pricing_configured"] is True
    # All input cached: a tenth of the $10 an uncached million would cost.
    assert out["total"]["cost_usd"] == pytest.approx(1.0)


def test_summary_ignores_an_unparseable_price_table(monkeypatch):
    monkeypatch.setattr(main, "_get_supabase", lambda: _SpendSupabase([_row()]))
    monkeypatch.setattr(main, "_require_admin", lambda: None)
    monkeypatch.setenv("LLM_PRICE_TABLE", "not json")
    out = asyncio.run(main.admin_llm_usage_summary(days=7))
    assert out["pricing_configured"] is False


def test_a_test_run_never_writes_to_the_real_table(monkeypatch):
    """The regression that put 264 fake rows in the production metrics table.

    There is no conftest and no test database, so `runtime.get_supabase()`
    inside a test returns the real project client. Nothing in the suite may
    reach it through this module without opting in.
    """
    written: list[dict] = []

    class Recorder:
        def table(self, _name):
            return self

        def insert(self, row):
            written.append(row)
            return self

        def execute(self):
            return SimpleNamespace(data=[])

    monkeypatch.setattr(runtime, "get_supabase", lambda: Recorder())
    # No `writes_allowed` fixture: this is what an ordinary test looks like.
    llm_usage.record("content_research.prepare", "gpt-5.4-mini")
    assert written == []
