"""Daily search words built around the family (feed/family_queries.py).

Offline: no database, no model, no search. runtime.get_supabase is patched so
nothing here can reach the database in .env.
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone

import pytest

from backend import runtime
from backend.feed import daily_post as dp
from backend.feed import family_queries as fq
from backend.feed.query_fixtures import FAMILIES, Family
from backend.nuri_core import family_store

DAY = date(2026, 11, 19)
FAMILY = {f.name: f for f in FAMILIES}
OFF_DOMAIN_WORDS = ("基督", "教会", "AI", "ai ", "程序员", "创业", "开发", "Houston")


@pytest.fixture(autouse=True)
def _no_database(monkeypatch):
    def refuse():
        raise AssertionError("a family_queries test reached for the database")

    monkeypatch.setattr(runtime, "get_supabase", refuse)


def plans(f: Family, day: date = DAY, **overrides) -> list[dp.Plan]:
    kwargs = dict(memories=f.memories, topics=f.topics, user_texts=f.user_texts,
                  standing=f.standing, personal=f.personal)
    kwargs.update(overrides)
    return dp.family_plans(f.children, f.profile, day, f.locale, **kwargs)


def queries(ps: list[dp.Plan]) -> str:
    return " || ".join(f"{p.query_zh} | {p.query_en}" for p in ps)


# ── The two reports from testing ─────────────────────────────────────────────

def test_a_christian_ai_developers_faith_and_job_never_reach_a_search():
    f = FAMILY["christian_ai_dad"]
    before = dp.template_plan(f.topics, f.user_texts, f.children, f.locale)
    assert before and "基督徒怎么看AI" in before.query_zh  # what testing saw

    after = plans(f)
    text = queries(after)
    assert not any(word in text for word in OFF_DOMAIN_WORDS), text
    # What the family is going through leads: he said the baby just started
    # cruising, and ticked development at sign-up.
    assert "学步" in after[0].query_zh and after[0].basis == "conversation"
    assert "memory" in after[0].why
    assert any("陪玩" in p.query_zh for p in after)  # "worried I'm not around enough"


def test_a_one_year_olds_family_gets_what_a_one_year_old_needs_for_going_out():
    f = FAMILY["one_year_old_travel_mom"]
    after = plans(f)
    assert "推车" in after[0].query_zh and "安全座椅" in after[0].query_zh
    assert "stroller car seat" in after[0].query_en
    # The chat said nothing but hello: no "寒暄" search any more.
    assert "寒暄" not in queries(after)


def test_a_stage_only_family_sees_the_whole_stage_across_a_week():
    f = Family("stage_only_12m", 12, {"parent_role": "mom", "top_concerns": []})
    leads = {plans(f, DAY + timedelta(days=i))[0].query_zh for i in range(7)}
    assert any("推车" in q for q in leads) and any("学步" in q for q in leads)
    assert any("家居安全" in q for q in leads)
    assert len(leads) >= 4


# ── What may become a search ─────────────────────────────────────────────────

@pytest.mark.parametrize("topic", ["基督徒怎么看AI", "基督徒如何管教孩子", "AI会不会取代程序员", "创业妈妈如何哄睡"])
def test_a_topic_about_the_parents_world_is_never_searched_as_written(topic):
    assert fq.clean_topic(topic) == ""


def test_a_parenting_topic_is_kept_without_its_age():
    assert fq.clean_topic("入园分离焦虑") == "入园分离焦虑"
    assert fq.clean_topic("1岁零3个月零食选择") == "零食选择"
    assert fq.clean_topic("寒暄") == ""
    assert fq.clean_topic("康复训练") == ""  # parenting-adjacent, but no need it maps to


def test_english_words_match_whole():
    assert not fq.is_off_domain("potty training")
    assert not fq.is_off_domain("waiting for daycare")
    assert fq.is_off_domain("基督徒怎么看AI")
    assert fq.is_off_domain("what does the Bible say")


def test_off_domain_chat_still_cannot_choose_a_need():
    f = Family("only_off_topic", 30, {"parent_role": "mom", "top_concerns": []},
               topics=["AI时代孩子怎么教育"], user_texts=["AI时代孩子要学编程吗"])
    assert all(p.basis == "profile" for p in plans(f))


# ── Long-term memory ─────────────────────────────────────────────────────────

def test_memory_outweighs_the_stage_and_the_chat_only_adds():
    f = FAMILY["clingy_21m"]
    ranked = fq.rank_needs(months=21, profile=f.profile, memories=f.memories, topics=f.topics,
                           user_texts=f.user_texts, standing=f.standing)
    by_id = {c.need.id: c for c in ranked}
    assert by_id["separation"].score > by_id["first_words"].score  # remembered beats stage-only
    assert by_id["daycare"].sources.get("memory")
    assert by_id["tantrums"].sources.get("chat") and by_id["tantrums"].topic == "丢东西发脾气"


def test_a_constraint_never_proposes_the_need_it_names():
    f = FAMILY["solids_refusal_10m"]  # "目前不想立刻全戒夜奶"
    ranked = fq.rank_needs(months=10, profile={"top_concerns": []}, memories=[],
                           standing=f.standing)
    assert "weaning" not in [c.need.id for c in ranked if c.sources.get("memory")]


def test_a_standing_constraint_drops_the_need_that_clashes():
    f = FAMILY["wheelchair_14m"]
    text = queries(plans(f))
    assert "学步" not in text and "learning to walk" not in text
    assert "学步" in queries(plans(f, standing=[]))


def test_repeated_memory_rows_do_not_pile_up():
    rows = [{"category": "concern", "key": f"k{i}", "value": "夜醒好几次"} for i in range(6)]
    ranked = fq.rank_needs(months=30, profile={}, memories=rows)
    sleep = next(c for c in ranked if c.need.id == "sleep")
    assert sleep.score == fq.WEIGHTS["memory"] * fq.MEMORY_HITS_CAP


def test_the_research_switch_off_leaves_only_the_profile_and_age():
    f = FAMILY["no_research_switch_8m"]
    after = plans(f)
    assert all(p.basis == "profile" for p in after)
    assert len(after) <= dp.PROFILE_PLANS
    assert "sleep" in after[0].query_en


def test_a_hobby_can_choose_a_need_but_never_becomes_a_word():
    f = Family("hiking_dad", 18, {"parent_role": "dad", "top_concerns": [], "hobbies": ["露营", "写代码"]})
    after = plans(f)
    assert "推车" in after[0].query_zh
    assert "露营" not in queries(after) and "代码" not in queries(after)


# ── Budget ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("f", FAMILIES, ids=lambda f: f.name)
def test_never_more_searches_than_before(f):
    assert len(plans(f)) <= dp.PROFILE_PLANS + 1
    pooled = plans(f, pool_only=True)
    assert len(pooled) <= dp.PROFILE_PLANS
    # Without budget only shareable words: no one family's own chat topic.
    raw_topics = {fq.clean_topic(t) for t in f.topics} - {""}
    assert not any(t in p.query_zh for t in raw_topics for p in pooled
                   if not any(t in n.words_zh for n in fq.NEEDS))


def test_age_band_words_stay_shared_across_families():
    a = Family("a", 12, {"top_concerns": []})
    b = Family("b", 13, {"top_concerns": []})
    assert {p.query_zh for p in plans(a)} == {p.query_zh for p in plans(b)}


# ── Wiring ───────────────────────────────────────────────────────────────────

NOW = datetime(2026, 11, 19, 16, 0, tzinfo=timezone.utc)


def _run_plans_for_today(monkeypatch, f: Family, *, budget_left=True):
    async def memories(_uid):
        return f.memories

    async def topics(_uid, **_k):
        return f.topics

    monkeypatch.setattr(family_store, "load_known_memories", memories)
    monkeypatch.setattr(dp, "recent_route_topics", topics)
    context = {"external_research_allowed": f.personal, "preferred_locale": f.locale,
               "messages": [{"role": "user", "text": t} for t in f.user_texts]}
    return asyncio.run(dp.plans_for_today(
        "u-1", f.children, f.profile, DAY, NOW, context=context, locale=f.locale,
        standing=f.standing, budget_left=budget_left,
    ))


def test_plans_for_today_reads_memory_and_chat(monkeypatch):
    out = _run_plans_for_today(monkeypatch, FAMILY["christian_ai_dad"])
    assert "学步" in out[0].query_zh and "AI" not in queries(out)


def test_memory_is_not_read_when_the_research_switch_is_off(monkeypatch):
    f = FAMILY["no_research_switch_8m"]

    async def must_not(_uid, **_k):
        raise AssertionError("read personal signals with the switch off")

    monkeypatch.setattr(family_store, "load_known_memories", must_not)
    monkeypatch.setattr(dp, "recent_route_topics", must_not)
    context = {"external_research_allowed": False, "messages": []}
    out = asyncio.run(dp.plans_for_today("u-1", f.children, f.profile, DAY, NOW, context=context,
                                         locale="zh-CN", standing=[], budget_left=True))
    assert out and all(p.basis == "profile" for p in out)


def test_the_legacy_switch_restores_the_router_topic_template(monkeypatch):
    monkeypatch.setattr(fq, "PLANNER", "legacy")
    out = _run_plans_for_today(monkeypatch, FAMILY["christian_ai_dad"])
    assert "基督徒怎么看AI" in out[0].query_zh  # exactly what testing reported


def test_a_childs_name_in_a_chat_topic_never_reaches_a_search():
    f = Family("named", 18, {"top_concerns": []}, topics=["小测挑食"])
    assert "小测" not in queries(plans(f))
    assert "挑食" in plans(f)[0].query_zh
