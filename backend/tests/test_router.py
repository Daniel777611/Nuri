"""Unit tests for the per-turn router.

No server and no model: the network call is one small seam (`client`), so
everything that matters — the sanitising in parse_route and the guarantee that a
broken router can never break a turn — is testable directly.
"""
import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.router import (  # noqa: E402
    NO_ROUTE,
    ROUTER_HISTORY_WINDOW,
    TurnRoute,
    _condense,
    parse_route,
    route_metrics,
    route_turn,
)

FULL = {
    "needs_search": True,
    "search_query": "4 month old refusing solids",
    "search_query_zh": "4个月 宝宝 抗拒 副食品",
    "search_scope": "both",
    "is_medical": False,
    "suggest_tasks": True,
    "topic": "辅食添加",
    "reason": "具体喂养困扰，背景够清楚",
}


def _raw(**overrides):
    return json.dumps({**FULL, **overrides}, ensure_ascii=False)


# ── Fake clients ─────────────────────────────────────────────────────────────

class _Client:
    """Minimal stand-in for the async OpenAI client."""

    def __init__(self, raw="", exc=None, delay=0.0):
        self._raw, self._exc, self._delay = raw, exc, delay
        self.calls = []
        self.chat = self

    @property
    def completions(self):
        return self

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._exc:
            raise self._exc
        message = type("M", (), {"content": self._raw})
        return type("R", (), {"choices": [type("C", (), {"message": message})]})


HISTORY = [{"role": "user", "text": "宝宝4个月，最近不肯吃副食品"}]


def _route(client, **kwargs):
    return asyncio.run(route_turn(HISTORY, client=client, **kwargs))


# ── Parsing & sanitising ─────────────────────────────────────────────────────

def test_parses_a_well_formed_route():
    r = parse_route(_raw())
    assert r.needs_search and r.suggest_tasks and not r.is_medical
    assert r.search_query == "4 month old refusing solids"
    assert r.search_query_zh == "4个月 宝宝 抗拒 副食品"
    assert r.search_scope == "both"
    assert r.ok


def test_search_without_a_query_is_downgraded_to_no_search():
    """A search step with nothing to search for is a wasted round trip."""
    r = parse_route(_raw(search_query="", search_query_zh=""))
    assert not r.needs_search


def test_one_language_query_is_enough():
    r = parse_route(_raw(search_query=""))
    assert r.needs_search and r.search_query_zh


def test_queries_are_cleared_when_not_searching():
    r = parse_route(_raw(needs_search=False))
    assert (r.search_query, r.search_query_zh) == ("", "")


@pytest.mark.parametrize("bad", ["EN", "english", "", None, "zh-CN"])
def test_unknown_scope_falls_back_to_both(bad):
    assert parse_route(_raw(search_scope=bad)).search_scope == "both"


def test_suggest_tasks_is_passed_through_untouched():
    """The router only judges whether the *moment* is right. Whether cards are
    actually drawn is a budget decision main.py's _plan_task_cards makes, and
    the router must not pre-empt it — that split is what let a new topic get
    cards again after the old one-set-per-conversation gate."""
    assert parse_route(_raw(suggest_tasks=True)).suggest_tasks
    assert not parse_route(_raw(suggest_tasks=False)).suggest_tasks


def test_topic_is_captured():
    assert parse_route(_raw(topic=" 睡眠倒退 ")).topic == "睡眠倒退"


def test_topic_survives_a_turn_that_suggests_nothing():
    """Budget is spent per topic per day, so a turn that draws no cards still
    has to say what it was about — otherwise the next turn on the same concern
    reads as a new topic."""
    assert parse_route(_raw(suggest_tasks=False, needs_search=False)).topic == "辅食添加"


def test_topic_is_length_capped():
    assert len(parse_route(_raw(topic="睡眠" * 60)).topic) <= 40


def test_missing_topic_is_empty_not_none():
    r = parse_route(json.dumps({**FULL, "topic": None}, ensure_ascii=False))
    assert r.topic == ""


def test_reason_is_length_capped():
    assert len(parse_route(_raw(reason="很长" * 200)).reason) <= 120


def test_whitespace_only_queries_count_as_absent():
    assert not parse_route(_raw(search_query="   ", search_query_zh=" ")).needs_search


# ── History condensing ───────────────────────────────────────────────────────

def test_condense_labels_speakers():
    out = _condense([
        {"role": "user", "text": "宝宝不睡"},
        {"role": "ai", "text": "他晚上几点上床？"},
    ])
    assert out == "家长: 宝宝不睡\nNURI: 他晚上几点上床？"


def test_condense_skips_transition_payloads_and_blanks():
    out = _condense([
        {"role": "user", "text": "宝宝不睡"},
        {"role": "ai", "text": "给你几个任务", "transition": {"kind": "task_suggestion"}},
        {"role": "ai", "text": "   "},
    ])
    assert out == "家长: 宝宝不睡"


def test_condense_keeps_only_the_recent_window():
    msgs = [{"role": "user", "text": f"m{i}"} for i in range(20)]
    lines = _condense(msgs).splitlines()
    assert len(lines) == ROUTER_HISTORY_WINDOW
    assert lines[-1] == "家长: m19"


# ── Failure is never allowed to break a turn ─────────────────────────────────

def test_a_dead_model_returns_a_safe_route_not_an_exception():
    r = _route(_Client(exc=RuntimeError("503")))
    assert not r.ok and not r.needs_search and not r.suggest_tasks
    assert "RuntimeError" in r.error


def test_a_hanging_model_is_cut_off():
    r = _route(_Client(raw=_raw(), delay=5), timeout_s=0.05)
    assert not r.ok and r.error == "timeout"
    assert not r.needs_search and not r.suggest_tasks


def test_unparsable_json_returns_a_safe_route():
    r = _route(_Client(raw="not json at all"))
    assert not r.ok and r.error.startswith("parse:")


def test_missing_client_returns_a_safe_route():
    assert not asyncio.run(route_turn(HISTORY, client=None)).ok


def test_empty_history_skips_the_call_entirely():
    client = _Client(raw=_raw())
    assert asyncio.run(route_turn([], client=client)) == NO_ROUTE
    assert client.calls == [], "should not spend a model call on an empty turn"


def test_a_failed_route_is_flagged_not_silently_default():
    """The failure mode that has bitten this project before is a feature that
    looks wired up and does nothing. ok=False is what makes it visible."""
    good = _route(_Client(raw=_raw(needs_search=False, suggest_tasks=False)))
    bad = _route(_Client(exc=RuntimeError("boom")))
    assert good.needs_search == bad.needs_search == False  # noqa: E712
    assert good.ok and not bad.ok, "the two must be distinguishable"


# ── Prompt assembly ──────────────────────────────────────────────────────────

def test_child_context_reaches_the_prompt():
    client = _Client(raw=_raw())
    _route(client, child_context="孩子：4个月，女孩")
    user_msg = client.calls[0]["messages"][1]["content"]
    assert "4个月" in user_msg and "对话：" in user_msg


def test_model_is_overridable():
    client = _Client(raw=_raw())
    _route(client, model="some-mini-model")
    assert client.calls[0]["model"] == "some-mini-model"


def test_strict_json_schema_is_requested():
    client = _Client(raw=_raw())
    _route(client)
    fmt = client.calls[0]["response_format"]
    assert fmt["json_schema"]["strict"] is True
    assert fmt["json_schema"]["schema"]["additionalProperties"] is False


# ── Metrics ──────────────────────────────────────────────────────────────────

def test_route_metrics_carry_the_reason():
    row = route_metrics(parse_route(_raw()))
    assert row["route_ok"] is True
    assert row["suggested_tasks"] is True
    assert row["route_reason"] == "具体喂养困扰，背景够清楚"
    assert row["route_topic"] == "辅食添加"
    assert row["search_scope"] == "both"


def test_route_metrics_of_a_failure_are_loggable():
    row = route_metrics(TurnRoute(ok=False, error="timeout"))
    assert row["route_ok"] is False and row["route_error"] == "timeout"
