"""The weighted register table.

What is being protected here is the property the table exists for: that
lowering one clause's weight lowers that clause and nothing else. The old
guard was one paragraph, so "make the three beats less rigid" and "let replies
run long" were the same edit — there was no way to ask for one without the
other. These tests fail if that coupling comes back.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.nuri_core import register  # noqa: E402
from backend.nuri_core.dialogue_reply import NURI_JSON_SUFFIX, NURI_PERSONA  # noqa: E402


def _rule(rule_id: str) -> register.RegisterRule:
    return next(r for r in register.REGISTER_RULES if r.id == rule_id)


# ── bands ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("weight,band", [
    (1.0, "hard"), (0.8, "hard"), (0.79, "default"),
    (0.35, "default"), (0.34, "optional"), (0.01, "optional"),
])
def test_the_band_boundaries_are_where_they_say_they_are(weight, band):
    assert register.band_of(weight) == band


def test_a_zero_weight_clause_is_absent_rather_than_softened():
    """Off has to mean off. A clause rendered under "use it if it helps" is
    still in the prompt and still shapes the reply."""
    rendered = register.render("guard")
    assert _rule("emoji").zh in rendered
    with_zero = _render_with({"emoji": 0})
    assert _rule("emoji").zh not in with_zero


def _render_with(overrides: dict, section: str = "guard", lang: str = "zh") -> str:
    saved = dict(register._OVERRIDES)
    register._OVERRIDES.update(overrides)
    try:
        return register.render(section, lang)
    finally:
        register._OVERRIDES.clear()
        register._OVERRIDES.update(saved)


# ── the property the table exists for ────────────────────────────────────────

def test_lowering_one_clause_leaves_the_others_where_they_were():
    """The whole point. In the old single-paragraph guard, softening the three
    beats meant rewriting the sentence that also carried the length ceiling."""
    before = register.render("guard")
    after = _render_with({"shape": 0.1})

    shape, length, fmt = _rule("shape"), _rule("length"), _rule("format")
    # The clause moved bands...
    assert shape.zh in before and shape.zh in after
    assert _band_containing(before, shape.zh) == "default"
    assert _band_containing(after, shape.zh) == "optional"
    # ...and nothing else did.
    for other in (length, fmt):
        assert _band_containing(before, other.zh) == _band_containing(after, other.zh)


def _band_containing(rendered: str, needle: str) -> str:
    band = None
    for line in rendered.splitlines():
        for name, (zh, en) in register._BAND_LEAD.items():
            if line.strip() in (zh, en) and line.strip():
                band = name
        if needle in line:
            return band
    raise AssertionError(f"not rendered: {needle[:30]}")


def test_the_band_lead_travels_with_the_clauses_it_governs():
    """A weight is only real if the prompt says so. "Usually, and not a
    template" sitting in the same paragraph as the length constraint does
    nothing — which is how the old guard read."""
    rendered = register.render("guard")
    assert register._BAND_LEAD["default"][0] in rendered
    assert register._BAND_LEAD["optional"][0] in rendered
    # Heaviest first, so the constraints are read before the softeners.
    assert rendered.index(register._BAND_LEAD["default"][0]) < rendered.index(
        register._BAND_LEAD["optional"][0]
    )


# ── the three beats, specifically ────────────────────────────────────────────

def test_the_three_beats_are_a_default_and_not_a_constraint():
    """They were a numbered recipe at full force, and the replies came back
    visibly built out of them — a parent who typed 你好呀 got an
    acknowledgement, a technique and a question about their feelings."""
    shape = _rule("shape")
    assert register.band_of(register.weight_of(shape)) == "default"
    assert _band_containing(register.render("guard"), shape.zh) == "default"


def test_asking_a_question_is_no_longer_mandatory_but_asking_two_still_is_banned():
    """These were one sentence — 「问一个就好，但一定要问」 — so the ceiling on
    questions and the floor under them could not move apart. They are two
    clauses now and they sit in different bands."""
    assert register.band_of(register.weight_of(_rule("one_question"))) == "hard"
    assert register.band_of(register.weight_of(_rule("ask"))) == "optional"


def test_the_follow_through_clauses_are_a_default_and_not_a_constraint():
    """完成标准 and 异常分支 were the two weakest metrics of the D01–D20 round,
    at 2.1 and 2.35 out of 4. They are still not constraints: reply length
    correlates negatively with score across that round, so a clause that fired
    on every turn would buy the metric back by spending the one — 口语自然 —
    that is currently working."""
    for rule_id in ("done_looks_like", "if_it_fails"):
        rule = _rule(rule_id)
        assert register.band_of(register.weight_of(rule)) == "default"
        assert _band_containing(register.render("output"), rule.zh) == "default"


def test_follow_through_is_asked_for_as_a_trade_not_an_addition():
    """The room for "here's how you'll know" has to come out of the sentence it
    replaces. A round where the four best dialogues averaged 130–150 characters
    and the worst averaged 350 does not have room to append anything."""
    for rule_id in ("done_looks_like", "if_it_fails"):
        rule = _rule(rule_id)
        assert "替换" in rule.zh
        assert "not" in rule.en and ("replaces" in rule.en or "on top of" in rule.en)


def test_an_emotional_pivot_outranks_the_plan_in_progress():
    """D01 is the only dialogue that has been run twice, and it came back lower
    the second time: 54.00, then 53.00, with 邀请式敞开心扉 and 决策信息充分度
    at 1/4 both times. Sequencing, not taste — so both clauses are constraints,
    not defaults."""
    for rule_id in ("follow_the_pivot", "hold_the_hedge"):
        assert register.band_of(register.weight_of(_rule(rule_id))) == "hard"
    pivot = _rule("follow_the_pivot")
    assert _band_containing(register.render("persona"), pivot.zh) == "hard"


def test_not_knowing_a_source_outranks_sounding_like_you_do():
    """Asked to verify a statistic, NURI named a survey it had inferred. That
    is a different failure from not knowing an answer, so it is a different
    clause — and it sits in the hard band, where `say_unsure` already is."""
    assert register.band_of(register.weight_of(_rule("source_honesty"))) == "hard"


# ── what must never become a weighted clause ─────────────────────────────────

def test_safety_and_language_are_not_in_the_table():
    """A gate a bad week of taste could switch off is not a gate. The hotline
    floor and "reply in the parent's language" stay hardcoded in the persona."""
    ids = {r.id for r in register.REGISTER_RULES}
    assert not ids & {"hotline", "language", "safety", "escalate"}
    assert "【不能顺从的请求】" in NURI_PERSONA
    assert "【语言】" in NURI_PERSONA
    # The output contract is a contract, not a preference.
    assert "suggest_tasks" in NURI_JSON_SUFFIX
    assert "task_proposals" in NURI_JSON_SUFFIX


def test_every_rule_says_something_in_at_least_one_language():
    for rule in register.REGISTER_RULES:
        assert rule.zh or rule.en, rule.id
        assert rule.section in register.SECTIONS, (rule.id, rule.section)


def test_rule_ids_are_unique():
    ids = [r.id for r in register.REGISTER_RULES]
    assert len(ids) == len(set(ids))


# ── placement ────────────────────────────────────────────────────────────────

def test_the_ceiling_never_mentions_examples_that_are_not_there():
    """It ships precisely when no exemplar fired, so a line about the samples
    is a rule the model reconciles against nothing."""
    ceiling = register.render("ceiling")
    assert _rule("samples").zh not in ceiling
    # But the register clauses it shares with the guard do carry over.
    assert _rule("format").zh in ceiling
    assert _rule("open").zh in ceiling


def test_persona_and_output_clauses_do_not_leak_into_the_guard():
    guard = register.render("guard")
    assert _rule("family_voice").zh not in guard
    assert _rule("gathering_short").zh not in guard


def test_english_render_never_falls_back_to_chinese():
    """A Chinese clause in an English prompt is worse than a missing one: it
    teaches the register in the script the reply must not use."""
    for section in register.SECTIONS:
        rendered = register.render(section, "en")
        assert not any("一" <= ch <= "鿿" for ch in rendered), section


# ── the environment override ─────────────────────────────────────────────────

def test_weights_are_tunable_without_a_deploy(monkeypatch):
    monkeypatch.setenv("NURI_REGISTER_WEIGHTS", "shape=0,emoji=0.9")
    reloaded = importlib.reload(register)
    try:
        assert reloaded.weight_of(_rule_in(reloaded, "shape")) == 0
        assert reloaded.band_of(reloaded.weight_of(_rule_in(reloaded, "emoji"))) == "hard"
        rendered = reloaded.render("guard")
        assert _rule_in(reloaded, "shape").zh not in rendered
    finally:
        monkeypatch.delenv("NURI_REGISTER_WEIGHTS", raising=False)
        importlib.reload(register)


def _rule_in(module, rule_id: str):
    return next(r for r in module.REGISTER_RULES if r.id == rule_id)


def test_a_typo_in_the_override_is_ignored_rather_than_fatal(monkeypatch):
    """An environment variable should not be able to take the service down,
    and a clause quietly keeping its default is the safe direction to fail."""
    monkeypatch.setenv("NURI_REGISTER_WEIGHTS", "shape=verylow,emoji=0.5,,junk")
    reloaded = importlib.reload(register)
    try:
        assert reloaded.weight_of(_rule_in(reloaded, "shape")) == 0.35
        assert reloaded.weight_of(_rule_in(reloaded, "emoji")) == 0.5
    finally:
        monkeypatch.delenv("NURI_REGISTER_WEIGHTS", raising=False)
        importlib.reload(register)
