"""Unit tests for the per-topic, per-day task-card budget.

The rule these pin down: one set of cards per new topic, on a budget that
tapers across the day (3 → 2 → 1), and once that is spent a further topic
offers to swap out an open task rather than piling another one on.

This replaced a one-set-per-conversation gate which, because the home tab
reuses a single NURI session forever, meant one set *ever* — a parent who came
back a week later with a new worry could never get cards again. That regression
was invisible without a test, so the day-boundary and repeat-topic cases below
are the ones that matter most.

No server and no model: every decision is a pure function of the conversation
plus the parent's open tasks, so `_get_supabase` is the only seam to stub.
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.main import (  # noqa: E402
    TASK_CARDS_BY_TOPIC,
    _pick_replaceable_task,
    _plan_task_cards,
    _same_topic,
    _topics_generated_today,
)
from backend.router import TurnRoute  # noqa: E402


@pytest.fixture(autouse=True)
def no_supabase(monkeypatch):
    """Keep every test on the in-memory path — a populated .env would otherwise
    send these at the real project."""
    monkeypatch.setattr("backend.main._get_supabase", lambda: None)


def _ts(days_ago: int = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


def _card(topic: str, *, days_ago: int = 0) -> dict:
    return {
        "role": "ai", "text": "给你几个任务", "created_at": _ts(days_ago),
        "transition": {"kind": "task_suggestion", "tasks": [{}], "topic": topic},
    }


def _route(**kw) -> TurnRoute:
    return TurnRoute(**{"suggest_tasks": True, "topic": "夜醒", **kw})


def _plan(route, topics=(), uid="u1"):
    return asyncio.run(_plan_task_cards(route, topics, uid))


# ── Topic matching ───────────────────────────────────────────────────────────

def test_identical_topics_match():
    assert _same_topic("睡眠倒退", "睡眠倒退")


def test_a_qualifier_does_not_make_it_a_new_topic():
    """The router is asked for stable labels but drifts by a modifier far more
    often than it changes subject; charging a fresh day's budget for that is
    the failure this guards."""
    assert _same_topic("睡眠", "夜醒睡眠")
    assert _same_topic("辅食添加", "宝宝的辅食添加")


def test_different_concerns_do_not_match():
    assert not _same_topic("睡眠倒退", "辅食添加")


def test_empty_topics_never_match():
    """Two cards that predate topics are two topics, not one — spending budget
    is the safe direction to err in."""
    assert not _same_topic("", "")
    assert not _same_topic("", "睡眠")


def test_a_one_character_topic_cannot_swallow_everything():
    assert not _same_topic("哭", "哭闹不睡")


# ── Reading the day's history ────────────────────────────────────────────────

def test_todays_cards_are_counted():
    assert _topics_generated_today([_card("睡眠"), _card("辅食")]) == ("睡眠", "辅食")


def test_yesterdays_cards_do_not_spend_todays_budget():
    assert _topics_generated_today([_card("睡眠", days_ago=1)]) == ()


def test_the_same_topic_twice_counts_once():
    assert _topics_generated_today([_card("睡眠"), _card("夜醒睡眠")]) == ("睡眠",)


def test_ordinary_messages_are_ignored():
    msgs = [
        {"role": "user", "text": "宝宝不睡", "created_at": _ts()},
        {"role": "ai", "text": "他几点上床？", "created_at": _ts()},
    ]
    assert _topics_generated_today(msgs) == ()


def test_a_legacy_card_without_a_topic_still_spends_budget():
    assert len(_topics_generated_today([_card("")])) == 1


# ── The budget ───────────────────────────────────────────────────────────────

def test_a_router_no_draws_nothing():
    assert not _plan(_route(suggest_tasks=False)).generate


def test_the_first_topic_of_the_day_gets_a_full_set():
    plan = _plan(_route())
    assert plan.generate and plan.max_cards == TASK_CARDS_BY_TOPIC[0]
    assert plan.replaces is None


def test_later_topics_get_progressively_fewer():
    assert _plan(_route(topic="辅食"), ("睡眠",)).max_cards == TASK_CARDS_BY_TOPIC[1]
    assert _plan(_route(topic="分离焦虑"), ("睡眠", "辅食")).max_cards == TASK_CARDS_BY_TOPIC[2]


def test_a_topic_already_covered_today_draws_nothing():
    """The headline rule: one set per topic. A parent circling back to the same
    worry an hour later should not collect a second pile of tasks for it."""
    plan = _plan(_route(topic="夜醒睡眠"), ("睡眠",))
    assert not plan.generate
    assert "already covered" in plan.reason


def test_a_new_topic_tomorrow_gets_a_full_set_again():
    """The budget is per day, not per conversation — this is the regression the
    old gate caused, since the home tab never starts a second session."""
    msgs = [_card("睡眠", days_ago=1), _card("辅食", days_ago=1), _card("哭闹", days_ago=1)]
    plan = _plan(_route(topic="入园"), _topics_generated_today(msgs))
    assert plan.generate and plan.max_cards == TASK_CARDS_BY_TOPIC[0]


# ── Past the budget: swap instead of pile on ─────────────────────────────────

def test_over_budget_offers_to_swap_the_oldest_unstarted_task(monkeypatch):
    monkeypatch.setattr("backend.main._tasks", [
        {"id": "t-old", "title": "旧任务", "user_id": "u1",
         "progress_done": 0, "completed_at": None, "created_at": _ts(3)},
        {"id": "t-new", "title": "新任务", "user_id": "u1",
         "progress_done": 0, "completed_at": None, "created_at": _ts(1)},
    ])
    plan = _plan(_route(topic="入园"), ("睡眠", "辅食", "哭闹"))
    assert plan.generate and plan.max_cards == 1
    assert plan.replaces == {"id": "t-old", "title": "旧任务"}


def test_a_started_task_is_not_offered_up(monkeypatch):
    """Progress recorded against a task is effort already spent; the untouched
    one is the better proxy for 'this was never going to happen'."""
    monkeypatch.setattr("backend.main._tasks", [
        {"id": "t-started", "title": "已开始", "user_id": "u1",
         "progress_done": 2, "completed_at": None, "created_at": _ts(5)},
        {"id": "t-idle", "title": "没动过", "user_id": "u1",
         "progress_done": 0, "completed_at": None, "created_at": _ts(1)},
    ])
    assert _plan(_route(topic="入园"), ("a", "b", "c")).replaces["id"] == "t-idle"


def test_completed_tasks_are_not_swap_targets(monkeypatch):
    monkeypatch.setattr("backend.main._tasks", [
        {"id": "t-done", "title": "做完了", "user_id": "u1",
         "progress_done": 1, "completed_at": _ts(1), "created_at": _ts(4)},
    ])
    plan = _plan(_route(topic="入园"), ("a", "b", "c"))
    assert plan.generate and plan.replaces is None


def test_over_budget_with_an_empty_list_just_draws_one(monkeypatch):
    """The cap exists to stop the task list bloating, and an empty list cannot
    bloat — a parent who cleared everything should not be stonewalled."""
    monkeypatch.setattr("backend.main._tasks", [])
    plan = _plan(_route(topic="入园"), ("a", "b", "c"))
    assert plan.generate and plan.max_cards == 1 and plan.replaces is None


def test_another_parents_tasks_are_never_offered(monkeypatch):
    monkeypatch.setattr("backend.main._tasks", [
        {"id": "t-other", "title": "别人的", "user_id": "u2",
         "progress_done": 0, "completed_at": None, "created_at": _ts(9)},
    ])
    assert asyncio.run(_pick_replaceable_task("u1")) is None


def test_a_signed_out_turn_has_nothing_to_swap():
    assert asyncio.run(_pick_replaceable_task(None)) is None
