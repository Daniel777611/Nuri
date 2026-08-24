"""Unit tests for the four-subsystem turn pipeline.

No server, no database and no model. Everything nuri_core needs from the app
arrives through CorePorts, so the whole pipeline — including the orchestrator's
promise that a failing subsystem cannot take a turn down — runs against a
handful of fakes.
"""
import asyncio
import sys
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.nuri_core import (  # noqa: E402
    dialogue,
    family,
    family_store,
    knowledge,
    outcome,
    provenance,
    safety,
)
from backend.nuri_core.contracts import (  # noqa: E402
    Directive,
    EvidenceDecision,
    FamilyState,
    LearnedPolicy,
)
from backend.nuri_core.orchestrator import PIPELINE_VERSION, run_turn_context  # noqa: E402
from backend.nuri_core.ports import CorePorts  # noqa: E402


# ── fakes ────────────────────────────────────────────────────────────────────

class _Route:
    def __init__(self, needs_search=False, is_medical=False, topic="睡眠倒退"):
        self.needs_search = needs_search
        self.search_query = "4 month old sleep regression"
        self.search_query_zh = "4个月 睡眠倒退"
        self.search_scope = "both"
        self.is_medical = is_medical
        self.topic = topic
        self.suggest_tasks = False
        self.reason = ""
        self.ok = True
        self.error = ""


def _months_ago(months: int) -> str:
    return (date.today() - timedelta(days=31 * months)).isoformat()


async def _to_thread(fn, *args):
    return fn(*args)


def _ports(**overrides) -> CorePorts:
    base = dict(
        supabase=lambda: None,
        to_thread=_to_thread,
        profile_ctx=lambda profile, children: f"称呼：{profile.get('nickname', '')}",
        age_label=lambda bd: "4个月",
        age_months=lambda bd: 4 if bd else None,
        memory_context=_async("孩子最近在戒尿布"),
        follow_up_context=_async("- 副食品：上周开始"),
        internal_rules=lambda q: "内部规则：先共情" if q else "",
        sources_prompt_block=lambda results: f"来源{len(results)}条",
        style_rules=_async("- 少用列点\n- 结尾问一句"),
        card_ctx=lambda cid, cards: f"card:{cid}",
        gen_cards=_async([]),
        is_urgent=lambda user, ai="": "不呼吸" in (user or ""),
        persona="你叫 NURI。",
    )
    base.update(overrides)
    return CorePorts(**base)


def _async(value):
    async def _fn(*_a, **_k):
        return value
    return _fn


HINTS = {
    "nickname": "小雨妈妈",
    "help_preference": "actionable",
    "children": [
        {"nickname": "豆豆", "birth_date": _months_ago(4), "allergies": ["花生"], "gender": "f"},
    ],
}


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _clean_caches():
    family.clear_cache()
    outcome.clear_cache()
    dialogue.clear_cache()
    yield
    family.clear_cache()
    outcome.clear_cache()
    dialogue.clear_cache()


# ── Directive conditions ─────────────────────────────────────────────────────

def test_empty_condition_always_matches():
    assert Directive(id="d", text="x").matches({})


def test_age_range_condition():
    d = Directive(id="d", text="x", applies_when={"age_months": [0, 12]})
    assert d.matches({"age_months": 4})
    assert not d.matches({"age_months": 30})
    # A directive written against an age we could not compute must not fire —
    # "advice for infants" applied to an unknown child is the wrong default.
    assert not d.matches({"age_months": None})


def test_topic_condition_is_substring():
    d = Directive(id="d", text="x", applies_when={"topics": ["睡眠"]})
    assert d.matches({"topic": "睡眠倒退"})
    assert not d.matches({"topic": "辅食添加"})


def test_unknown_condition_key_is_inert():
    """A condition this build does not understand must not silently drop the
    directive's siblings, or one bad row costs a turn every other rule."""
    d = Directive(id="d", text="x", applies_when={"phase_of_moon": ["waxing"]})
    assert d.matches({})


# ── 1 家庭模型 ───────────────────────────────────────────────────────────────

def test_core_is_free_and_carries_what_routing_needs():
    state = family.core(HINTS, _ports(), uid="u1")
    assert state.age_months == 4
    assert state.constraints == ("豆豆对花生过敏",)
    assert state.search_context()
    assert not state.enriched


def test_search_context_is_age_only_and_contains_no_child_pii(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    hints = {
        "nickname": "Daniel",
        "children": [{
            "nickname": "小啊谷",
            "birth_date": "2025-10-10",
            "gender": "boy",
        }],
    }
    p = _ports(
        profile_ctx=family_store.profile_ctx,
        age_label=family_store.age_label,
        age_months=family_store.age_in_months,
    )
    state = family.core(hints, p, uid="u1")

    assert "小啊谷" in state.profile_block
    assert "2025-10-10" in state.profile_block
    assert state.search_context() == "孩子当前年龄：10个月"
    assert "小啊谷" not in state.search_context()
    assert "2025-10-10" not in state.search_context()


def test_fingerprint_is_stable_and_moves_with_the_child():
    p = _ports()
    a = family.core(HINTS, p, uid="u1")
    b = family.core(dict(HINTS), p, uid="u1")
    assert a.fingerprint == b.fingerprint

    changed = {**HINTS, "children": [{**HINTS["children"][0], "allergies": ["花生", "鸡蛋"]}]}
    assert family.core(changed, p, uid="u1").fingerprint != a.fingerprint


def test_enrich_caches_and_invalidate_clears():
    calls = []

    async def memory(uid):
        calls.append(uid)
        return "记忆"

    p = _ports(memory_context=memory)
    core = family.core(HINTS, p, uid="u1")

    first = _run(family.enrich(core, p))
    assert first.memory_block == "记忆" and not first.cache_hit
    second = _run(family.enrich(core, p))
    assert second.cache_hit and len(calls) == 1

    family.invalidate("u1")
    _run(family.enrich(core, p))
    assert len(calls) == 2


def test_enrich_skips_the_round_trip_for_anonymous_sessions():
    calls = []
    p = _ports(memory_context=lambda uid: calls.append(uid) or _async("")())
    core = family.core(HINTS, p, uid=None)
    assert _run(family.enrich(core, p)).memory_block == ""
    assert not calls


def test_a_changed_profile_defeats_the_cache():
    p = _ports()
    core = family.core(HINTS, p, uid="u1")
    _run(family.enrich(core, p))
    moved = family.core({**HINTS, "nickname": "别的称呼"}, p, uid="u1")
    assert not _run(family.enrich(moved, p)).cache_hit


# ── 横切 Safety Layer ────────────────────────────────────────────────────────

def test_emergency_strips_everything_and_blocks_task_cards():
    state = family.core(HINTS, _ports(), uid="u1")
    v = safety.assess("孩子不呼吸了", family=state, is_urgent=_ports().is_urgent)
    assert v.tier == "emergency"
    assert v.minimal_context and not v.allow_task_cards


def test_allergies_become_a_constraint_directive():
    state = family.core(HINTS, _ports(), uid="u1")
    v = safety.assess("辅食怎么加", family=state, is_urgent=lambda *_a: False)
    assert v.tier == "elevated"
    assert any("花生" in d.text for d in v.directives)


def test_reassess_adds_the_medical_gate_but_never_downgrades():
    state = FamilyState()
    v = safety.assess("要不要看医生", family=state, is_urgent=lambda *_a: False)
    assert v.tier == "none"
    escalated = safety.reassess(v, is_medical=True)
    assert escalated.tier == "medical" and escalated.require_sources

    emergency = safety.assess("孩子不呼吸了", family=state, is_urgent=lambda *_a: True)
    assert safety.reassess(emergency, is_medical=True).tier == "emergency"


# ── 2 知识与决策模型 ─────────────────────────────────────────────────────────

def _decide(user_text, route, ports=None, verdict=None):
    p = ports or _ports()
    state = family.core(HINTS, p, uid="u1")
    v = verdict or safety.assess(user_text, family=FamilyState(), is_urgent=lambda *_a: False)

    async def route_turn(history, **_kw):
        return route

    return _run(knowledge.decide(
        [{"role": "user", "text": user_text}], user_text, state, v, p,
        route_turn=route_turn,
    ))


def test_short_acknowledgements_skip_internal_retrieval():
    """The store the linear pipeline queried on every '谢谢'."""
    decision, _ = _decide("谢谢", _Route())
    assert decision.internal_block == ""
    assert decision.skipped["internal"] == "acknowledgement"


def test_a_substantive_turn_still_gets_the_internal_rules():
    decision, _ = _decide("宝宝四个月了最近半夜一直醒，怎么办", _Route())
    assert "内部规则" in decision.internal_block
    assert "internal" in decision.retrieved


def test_search_runs_only_when_the_route_asks_for_it():
    calls = []

    async def search(*_a, **kw):
        calls.append(kw)
        return ["r1", "r2"]

    p = _ports(search_sources=search)
    decision, _ = _decide("宝宝四个月了最近半夜一直醒", _Route(needs_search=True), p)
    assert decision.sources_block == "来源2条" and len(calls) == 1

    decision, _ = _decide("宝宝四个月了最近半夜一直醒", _Route(), p)
    assert decision.sources_block == "" and len(calls) == 1
    assert decision.skipped["web"] == "route_said_no"


def test_an_emergency_spends_nothing_on_retrieval():
    calls = []

    async def search(*_a, **_kw):
        calls.append(1)
        return ["r"]

    p = _ports(search_sources=search, internal_rules=lambda q: calls.append(1) or "x")
    v = safety.assess("孩子不呼吸了", family=FamilyState(), is_urgent=lambda *_a: True)
    decision, _ = _decide("孩子不呼吸了怎么办急死了", _Route(needs_search=True), p, v)
    assert not calls
    assert decision.skipped == {"internal": "emergency", "web": "emergency"}


def test_the_router_escalates_an_implicit_medical_turn():
    _, verdict = _decide("宝宝这两天有点不太对劲", _Route(is_medical=True))
    assert verdict.tier == "medical"


def test_a_failing_search_costs_the_sources_and_nothing_else():
    async def boom(*_a, **_kw):
        raise RuntimeError("provider down")

    decision, _ = _decide(
        "宝宝四个月了最近半夜一直醒", _Route(needs_search=True), _ports(search_sources=boom)
    )
    assert decision.sources_block == ""
    assert decision.skipped["web"] == "no_results"
    assert "internal" in decision.retrieved


# ── 4 结果学习模型 ───────────────────────────────────────────────────────────

def test_a_directive_below_the_sample_floor_keeps_its_authored_weight():
    rows = [{"topic": "睡眠", "directive_ids": ["d1"], "signal": "not_relevant"}] * 3
    assert outcome.summarize(rows).directive_weights == {}


def test_consistent_negatives_suppress_a_directive():
    rows = [{"topic": "睡眠", "directive_ids": ["d1"], "signal": "fix"}] * 4
    policy = outcome.summarize(rows)
    assert policy.directive_weights["d1"] == 0.0
    assert [d.id for d in policy.weigh([Directive(id="d1", text="x")])] == []


def test_consistent_positives_promote_within_the_ceiling():
    rows = [{"topic": "睡眠", "directive_ids": ["d1"], "signal": "helpful"}] * 4
    weight = outcome.summarize(rows).directive_weights["d1"]
    assert 1.0 < weight <= outcome.WEIGHT_CEILING


def test_the_negative_gate_closes_on_a_repeatedly_missed_topic():
    rows = [{"topic": "睡眠倒退", "directive_ids": [], "signal": "not_relevant"}] * 2
    policy = outcome.summarize(rows)
    assert policy.negative_topics == ("睡眠倒退",)
    gate = policy.directives[0]
    assert gate.matches({"topic": "睡眠倒退"}) and not gate.matches({"topic": "辅食"})


def test_unknown_signals_are_ignored_rather_than_counted():
    rows = [{"topic": "睡眠", "directive_ids": ["d1"], "signal": "shrug"}] * 8
    assert outcome.summarize(rows).directive_weights == {}


# ── 3 对话与主动模型 ─────────────────────────────────────────────────────────

def _plan(**overrides):
    base = dict(
        family=replace(
            family.core(HINTS, _ports(), uid="u1"),
            memory_block="记忆", follow_up_block="- 副食品：上周开始",
        ),
        evidence=EvidenceDecision(route=_Route(), internal_block="内部规则", sources_block="来源"),
        policy=LearnedPolicy(),
        verdict=safety.assess("辅食怎么加", family=FamilyState(), is_urgent=lambda *_a: False),
        directives=[Directive(id="s1", text="少用列点")],
    )
    base.update(overrides)
    return dialogue.plan(**base)


def test_sections_are_ordered_stable_first_for_the_prefix_cache():
    plan = _plan()
    headings = [h for h, _ in plan.sections]
    assert headings.index(dialogue.HEADINGS["always"]) < headings.index(dialogue.HEADINGS["profile"])
    # Fetched-fresh evidence goes last so it cannot truncate the cached prefix.
    assert plan.sections[-1][1] == "来源"


def test_a_conditional_directive_only_renders_when_it_matches():
    infant = Directive(id="c1", text="四个月以下先谈睡眠环境", applies_when={"age_months": [0, 12]})
    toddler = Directive(id="c2", text="三岁以上讲规则", applies_when={"age_months": [36, 240]})
    plan = _plan(directives=[infant, toddler])
    rendered = plan.system_prompt("persona")
    assert "四个月以下" in rendered and "三岁以上" not in rendered


def test_a_suppressed_directive_disappears_without_being_deleted():
    plan = _plan(
        directives=[Directive(id="s1", text="少用列点")],
        policy=LearnedPolicy(directive_weights={"s1": 0.0}),
    )
    assert "少用列点" not in plan.system_prompt("persona")


def test_the_proactive_channel_closes_as_soon_as_the_turn_carries_risk():
    calm = _plan(verdict=safety.SafetyVerdict(tier="none"))
    assert calm.proactive and "副食品" in calm.system_prompt("persona")

    medical = _plan(verdict=safety.SafetyVerdict(tier="medical"))
    assert medical.proactive == ""
    assert "副食品" not in medical.system_prompt("persona")


def test_an_emergency_plan_is_one_instruction_long():
    verdict = safety.assess("孩子不呼吸了", family=FamilyState(), is_urgent=lambda *_a: True)
    plan = _plan(verdict=verdict)
    assert not plan.allow_task_cards
    # One section, and it is the safety gate. Asserted structurally rather than
    # by substring: the emergency directive itself says "不要列来源", so a
    # naive `"来源" not in rendered` would pass for the wrong reason.
    assert [h for h, _ in plan.sections] == [dialogue.HEADINGS["safety"]]
    assert plan.history_window < 20


def test_style_rules_survive_without_the_directives_table():
    """The migration is optional: with no Supabase the legacy block still
    loads, and the pipeline renders exactly what the linear one did."""
    directives = _run(dialogue.load_directives(_ports()))
    assert [d.text for d in directives] == ["少用列点", "结尾问一句"]


# ── orchestrator ─────────────────────────────────────────────────────────────

async def _route_turn(history, **_kw):
    return _Route()


def _bundle(ports=None, **kw):
    return _run(run_turn_context(
        history=[{"role": "user", "text": "宝宝四个月了最近半夜一直醒，怎么办"}],
        user_text="宝宝四个月了最近半夜一直醒，怎么办",
        uid="u1",
        context_hints=HINTS,
        ports=ports or _ports(),
        route_turn=_route_turn,
        **kw,
    ))


def test_end_to_end_produces_a_prompt_and_a_trace():
    bundle = _bundle()
    prompt = bundle.plan.system_prompt("你叫 NURI。")
    assert "小雨妈妈" in prompt and "内部规则" in prompt
    assert bundle.trace.version == PIPELINE_VERSION
    assert bundle.trace.timings["context"] >= 0
    assert bundle.trace.directive_ids


def test_four_model_final_prompt_uses_confirmed_birthday_but_search_does_not(
    monkeypatch,
):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    hints = {
        "nickname": "Daniel",
        "children": [{
            "nickname": "小啊谷",
            "birth_date": "2025-10-10",
            "gender": "boy",
        }],
    }
    ports = _ports(
        profile_ctx=family_store.profile_ctx,
        age_label=family_store.age_label,
        age_months=family_store.age_in_months,
    )
    bundle = _run(run_turn_context(
        history=[{"role": "user", "text": "你知道孩子的生日吗？"}],
        user_text="你知道孩子的生日吗？",
        uid="u1",
        context_hints=hints,
        ports=ports,
        route_turn=_route_turn,
    ))
    prompt = bundle.plan.system_prompt("你叫 NURI。")

    assert "小啊谷" in prompt
    assert "已确认出生日期：2025-10-10" in prompt
    assert "不要再次询问" in prompt
    assert bundle.family.search_context() == "孩子当前年龄：10个月"
    assert "小啊谷" not in bundle.family.search_context()
    assert "2025-10-10" not in bundle.family.search_context()


def test_the_legacy_shaped_fields_stay_populated_for_the_comparison():
    bundle = _bundle()
    assert bundle.profile and bundle.memory and bundle.internal
    assert bundle.style == "- 少用列点\n- 结尾问一句"


def test_the_card_store_is_untouched_on_an_ordinary_turn():
    calls = []
    p = _ports(gen_cards=lambda: calls.append(1) or _async([])())
    assert _bundle(p).card == ""
    assert not calls
    assert _bundle(p, source_card_id="c9").card == "card:c9"


def test_one_failing_subsystem_does_not_take_the_turn_down():
    async def boom(_uid):
        raise RuntimeError("memories table is gone")

    bundle = _bundle(_ports(memory_context=boom))
    assert bundle.plan.system_prompt("persona")
    assert bundle.memory == ""
    assert bundle.trace.facts["family_enrich_error"] == "RuntimeError"


def test_a_broken_router_still_yields_a_reply():
    async def boom(history, **_kw):
        raise RuntimeError("router model not found")

    bundle = _run(run_turn_context(
        history=[{"role": "user", "text": "宝宝四个月了最近半夜一直醒"}],
        user_text="宝宝四个月了最近半夜一直醒",
        uid="u1", context_hints=HINTS, ports=_ports(), route_turn=boom,
    ))
    assert bundle.plan.system_prompt("persona")
    assert bundle.route is None


def test_the_route_callback_fires_for_the_metrics_row():
    seen = []
    _bundle(on_route_done=seen.append)
    assert len(seen) == 1 and seen[0].topic == "睡眠倒退"


# ── 横切 Provenance ──────────────────────────────────────────────────────────

def test_the_flat_row_only_names_migrated_columns():
    row = _bundle().trace.metrics_row()
    assert set(row) == set(provenance.TurnTrace.FLAT_COLUMNS)
    assert row["pipeline"] == "four_model"


def test_compare_reports_which_stage_moved():
    a = {"total_ms": 1000, "timings": {"knowledge": 800}, "contributions": {"x": 100},
         "directive_ids": ["d1"]}
    b = {"total_ms": 700, "timings": {"knowledge": 500}, "contributions": {"x": 120},
         "directive_ids": ["d1", "d2"]}
    diff = provenance.compare(a, b)
    assert diff["delta_total_ms"] == -300
    assert diff["by_stage"]["knowledge"] == -300
    assert diff["delta_prompt_chars"] == 20
    assert diff["only_in_b"] == ["d2"]
