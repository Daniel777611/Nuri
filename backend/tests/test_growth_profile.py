"""Memory subcategories, behavior tags, critical periods and the growth calendar.

Pure rules: no network, no database (runtime.get_supabase is patched anyway).
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from backend import runtime
from backend.feed import daily_post as dp
from backend.feed import family_queries as fq
from backend.nuri_core import critical_periods as cp
from backend.nuri_core import family_store
from backend.nuri_core import memory_taxonomy as tx

TODAY = date(2026, 11, 21)


@pytest.fixture(autouse=True)
def _no_database(monkeypatch):
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)


def born_weeks_ago(weeks: int) -> date:
    return TODAY - timedelta(weeks=weeks)


def row(value, *, category="child_state", key="", days_ago=3, child_id=None):
    when = (TODAY - timedelta(days=days_ago)).isoformat() + "T08:00:00+00:00"
    return {"category": category, "key": key, "value": value, "child_id": child_id, "updated_at": when}


# ── Taxonomy ─────────────────────────────────────────────────────────────────

def test_five_categories_three_subcategories_each():
    for category in tx.CATEGORY_LABELS:
        assert len(tx.subcategory_ids(category)) == 3
    for tag in tx.BEHAVIOR_TAGS:
        assert tag.subcategory in tx.SUBCATEGORIES_BY_ID
    for period in cp.PERIODS:
        assert period.need in fq.NEEDS_BY_ID
        assert all(t in tx.BEHAVIOR_TAGS_BY_ID for t in period.tags)


def test_a_tagged_memory_is_keyed_by_its_tag_and_an_untagged_one_by_subcategory():
    assert tx.make_key("motor", "扶走", "cruises") == "motor/tag:cruises"
    assert tx.make_key("", "", "cruises") == "motor/tag:cruises"
    assert tx.make_key("routine", "作息") == "routine/作息"
    assert tx.make_key("routine", "routine/作息") == "routine/作息"  # copied back as stored
    assert tx.make_key("nonsense", "作息") == "作息"


def test_rows_from_before_subcategories_are_sorted_by_their_words():
    c = tx.classify({"category": "child_state", "key": "走路", "value": "小满最近扶着沙发能走几步了"})
    assert c.subcategory == "motor" and "cruises" in c.tags and c.inferred
    c = tx.classify({"category": "fact", "key": "职业", "value": "爸爸是做AI开发的工程师"})
    assert c.subcategory == "parent_world"
    c = tx.classify({"category": "child_state", "key": "motor/tag:walks", "value": "会自己走了"})
    assert c.tags == ("walks",) and not c.inferred


def test_a_negated_behavior_is_not_a_tag():
    assert "walks" not in tx.tags_in("15个月了还不会走")
    assert "walks" in tx.tags_in("这周突然会走了")


def test_the_extractor_output_is_folded_into_the_key():
    m = family_store.labelled_memory(
        {"category": "child_state", "subcategory": "motor", "tag": "cruises", "key": "走路",
         "value": "扶着沙发走", "confidence": 0.9},
    )
    assert m["key"] == "motor/tag:cruises" and m["replaces"] == "走路"
    assert "subcategory" not in m and "tag" not in m
    m = family_store.labelled_memory(
        {"category": "fact", "subcategory": "schedule_place", "tag": "", "key": "schedule_place/上班",
         "value": "妈妈9点上班", "confidence": 0.8},
    )
    assert m["key"] == "schedule_place/上班" and "replaces" not in m


def test_the_extraction_prompt_lists_every_subcategory_and_tag():
    guide = tx.extraction_guide()
    assert all(s in guide for s in tx.subcategory_ids())
    assert all(t in guide for t in tx.BEHAVIOR_TAGS_BY_ID)


# ── Critical periods ─────────────────────────────────────────────────────────

def test_age_makes_a_period_possible_and_a_tag_makes_it_active():
    birth = born_weeks_ago(48)                      # about 11 months
    states = {s.period.id: s for s in cp.states_on(birth, TODAY, {})}
    assert states["cruising_walking"].status == "possible"
    live = cp.live_tags(cp.observations([row("扶着沙发能走几步了")]), birth=birth, on=TODAY)
    states = {s.period.id: s for s in cp.states_on(birth, TODAY, live)}
    assert states["cruising_walking"].status == "active"
    assert states["cruising_walking"].confirmed_by == ("cruises",)


def test_a_tag_is_released_by_time():
    birth = born_weeks_ago(60)
    old = cp.observations([row("扶着走", days_ago=7 * 13)])     # past the 12-week ttl
    assert cp.live_tags(old, birth=birth, on=TODAY) == {}
    # Recent, but every period it confirms closed long ago (+ grace).
    birth = born_weeks_ago(30 + cp.GRACE_WEEKS + 1)
    assert not cp.tag_is_live("rolls", TODAY - timedelta(days=2), birth=birth, on=TODAY)


def test_with_two_children_a_row_naming_the_other_one_does_not_count():
    rows = [row("哥哥小乐会走了，跑来跑去")]
    obs = cp.observations(rows, nickname="小满", other_nicknames=["小乐"])
    assert obs == []
    obs = cp.observations(rows, nickname="小乐", other_nicknames=["小满"])
    assert [o.tag for o in obs] == ["walks"]


def test_the_calendar_is_weekly_and_marks_the_current_week():
    birth = born_weeks_ago(32)
    cal = cp.calendar(birth, TODAY, [row("这几天特别认生，见到生人就哭")], weeks=6, past=1)
    assert len(cal["weeks"]) == 7
    current = [w for w in cal["weeks"] if w["is_current"]]
    assert len(current) == 1
    sep = next(p for p in current[0]["periods"] if p["id"] == "separation")
    assert sep["status"] == "active" and sep["confirmed_by"][0]["tag"] == "stranger_anxiety"
    assert all("about" in p and p["about"] for w in cal["weeks"] for p in w["periods"])


def test_the_calendar_shows_a_period_coming_up():
    birth = born_weeks_ago(16)                      # solids open at 17 weeks
    cal = cp.calendar(birth, TODAY, [], weeks=1, past=0)
    ids = {p["id"]: p["status"] for p in cal["weeks"][0]["periods"]}
    assert ids.get("solids_ready") == "upcoming"


# ── Push ranking ─────────────────────────────────────────────────────────────

def test_a_confirmed_period_leads_the_push():
    birth = born_weeks_ago(48)
    children = [{"id": "c1", "nickname": "小满", "birth_date": birth.isoformat()}]
    rows = [row("扶着沙发能走几步了")]
    possible, confirmed = dp.period_signals(children, rows, TODAY)
    assert "walking" in confirmed
    ranked = fq.rank_needs(months=11, profile={"top_concerns": []}, memories=rows,
                           period_needs=possible, confirmed_needs=confirmed)
    assert ranked[0].need.id == "walking" and "behavior" in ranked[0].sources


def test_chat_alone_ranks_behind_any_important_tag():
    # 40 months: travel still fits the age but is past its stage, so only
    # the chat points to it.
    ranked = fq.rank_needs(months=40, profile={"top_concerns": []},
                           user_texts=["下个月要带他坐飞机出去旅行，旅行要准备什么"], period_needs=["potty"])
    important = [c.important for c in ranked]
    assert important == sorted(important, reverse=True)
    travel = next(c for c in ranked if c.need.id == "travel")
    assert not travel.important and travel.sources == {"chat": 1}
    assert ranked.index(travel) == important.index(False)


def test_an_open_period_alone_adds_no_weight():
    plain = fq.rank_needs(months=12, profile={"top_concerns": []})
    with_periods = fq.rank_needs(months=12, profile={"top_concerns": []},
                                 period_needs=["walking", "separation", "teething"])
    assert [c.need.id for c in plain] == [c.need.id for c in with_periods if c.score > 0][:len(plain)]
