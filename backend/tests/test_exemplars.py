"""Unit tests for the few-shot exemplar corpus and its selection.

No model and no database: selection is pure regex over the parent's message,
and assembly is a list of dicts, so the whole mechanism runs offline.
"""
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.nuri_core import exemplars  # noqa: E402
from backend.nuri_core.dialogue_reply import nuri_messages  # noqa: E402


def _ids(chosen):
    return [e.id for e in chosen]


# ── the domain gate ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("text", [
    "宝宝晚上一直哭，怎么哄都不睡",          # 哭 is a tag in L
    "他每次吃饭都说不要，一口都不吃",          # 不要 is a tag in H
    "四个月的宝宝要开始吃副食品了吗",
    "谢谢",
])
def test_off_topic_turns_get_no_exemplars(text):
    """The tags alone are ordinary words elsewhere. Without the domain gate a
    sleep question would be answered in the voice of a language answer."""
    assert exemplars.select(text) == []


@pytest.mark.parametrize("text", [
    "孩子很少主动跟我说话，怎么办？",
    "孩子講錯字，我要一直糾正他嗎？",
    "他到現在還不太會表達",
])
def test_language_turns_fire(text):
    assert exemplars.select(text)


# ── which one fires ──────────────────────────────────────────────────────────

def test_ranks_the_matching_scenario_first():
    assert exemplars.select("孩子講錯字，我要一直糾正他嗎？")[0].id == "G"
    assert exemplars.select("孩子看繪本一下就跑掉，還要繼續讀嗎？")[0].id == "J"
    assert exemplars.select("要買什麼玩具幫助語言發展？")[0].id == "B"


def test_simplified_and_traditional_both_match():
    """Parents arrive in either script; the corpus is written in one."""
    assert _ids(exemplars.select("孩子讲错字，我要一直纠正他吗？")) == \
           _ids(exemplars.select("孩子講錯字，我要一直糾正他嗎？"))


def test_in_domain_but_unmatched_falls_back_to_the_general_pair():
    """A language question no scenario covers still gets a register anchor."""
    chosen = exemplars.select("孩子的語言發展需要注意什麼？")
    assert _ids(chosen) == ["A", "E"]


def test_respects_the_count_ceiling():
    assert len(exemplars.select("孩子很少主動說話，也常常講錯字", limit=1)) == 1
    assert exemplars.select("孩子很少主動說話", limit=0) == []


def test_a_thin_match_is_topped_up_rather_than_sent_short():
    """One pair shifts the register less reliably than two, and the fillers are
    in-domain by construction."""
    chosen = exemplars.select("孩子看繪本一下就跑掉，還要繼續讀嗎？")
    assert len(chosen) == 2
    assert chosen[0].id == "J"
    assert chosen[1].id in exemplars._DEFAULT_IDS


def test_a_keyword_free_follow_up_keeps_the_gate_open():
    """Measured failure: judged one message at a time the gate shut mid-
    conversation and the same exchange went from 108 to 442 characters."""
    prior = ["孩子兩歲半，講話還是只有兩三個字"]
    assert exemplars.select("所以我到底該不該帶他去做評估？") == []
    assert exemplars.select("所以我到底該不該帶他去做評估？", recent=prior)


def test_stickiness_expires():
    """A conversation that has genuinely moved on stops pulling language
    examples, rather than carrying them for the rest of the session."""
    stale = ["閒聊一", "閒聊二", "閒聊三", "孩子講話還是只有兩三個字"]
    assert exemplars.select("他最近很喜歡玩車子", recent=stale) == []


def test_the_latest_message_still_leads_the_ranking():
    prior = ["孩子兩歲半，講話還是只有兩三個字"]
    chosen = exemplars.select("他看繪本一下就跑掉，還要繼續讀嗎？", recent=prior)
    assert chosen[0].id == "J"


def test_off_topic_stays_shut_even_with_off_topic_history():
    assert exemplars.select("寶寶晚上一直哭", recent=["白天小睡很短", "他最近會翻身"]) == []


def test_a_parent_who_switches_script_is_followed_immediately():
    """Pooling the recent messages instructed Traditional at exactly the turn a
    Traditional-then-Simplified parent switched — the persona promises to switch
    with them, and the clause was arguing with it."""
    switched = [
        "我该怎么在家帮他练习说话？",          # newest, Simplified
        "平常我跟他說話他聽得懂",
        "他會說的詞很少，大概十幾個",
        "我家孩子兩歲半，講話還是只有兩三個字",
    ]
    guard = exemplars.guard_for(switched)
    assert "简体中文" in guard
    assert "繁體中文" not in guard


def test_older_messages_stand_in_when_the_latest_is_too_short():
    guard = exemplars.guard_for(["嗯", "好", "我家孩子兩歲半，講話還是只有兩三個字"])
    assert "繁體中文" in guard


def test_the_guard_names_the_parents_script():
    """Measured: the generic 'follow the parent's language' clause held for five
    turns and then lost, and the sixth reply came back wholly Traditional to a
    parent writing Simplified."""
    zhs = exemplars.guard_for("我家孩子两岁三个月，会说的词还是很少")
    zht = exemplars.guard_for("我家孩子兩歲三個月，會說的詞還是很少")
    assert "简体中文" in zhs and "繁體中文" not in zhs
    assert "繁體中文" in zht
    # The base guard is always present, so the rest of the contract holds.
    assert exemplars.GUARD in zhs and exemplars.GUARD in zht


def test_the_guard_says_nothing_when_the_script_is_unreadable():
    """Guessing from 'ok' would be worse than staying quiet — the persona
    already covers the ordinary case."""
    assert exemplars.guard_for("好") == exemplars.GUARD
    assert exemplars.guard_for("") == exemplars.GUARD


@pytest.mark.parametrize("text,expected", [
    ("这个孩子还没开始说话，我们想问问", "zhs"),
    ("這個孩子還沒開始說話，我們想問問", "zht"),
    ("ok", ""),
])
def test_script_detection(text, expected):
    assert exemplars.script_of(text) == expected


def test_disabled_selects_nothing(monkeypatch):
    monkeypatch.setattr(exemplars, "ENABLED", False)
    assert exemplars.select("孩子講錯字要糾正嗎") == []


# ── what gets sent ───────────────────────────────────────────────────────────

def test_pairs_alternate_and_the_reply_matches_the_response_schema():
    msgs = exemplars.as_messages(exemplars.select("孩子講錯字要不要糾正"))
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]
    for reply in msgs[1::2]:
        # A few-shot whose shape differs from NURI_RESPONSE_FORMAT teaches the
        # model two conflicting things at once.
        payload = json.loads(reply["content"])
        assert set(payload) == {
            "text", "quick_replies", "suggest_tasks", "task_proposals", "cited",
        }
        assert payload["suggest_tasks"] is False
        assert payload["task_proposals"] == []


def test_replies_look_like_the_target_register():
    """The corpus is the specification of the register, so it is worth asserting
    that no entry has drifted into the report style it exists to replace."""
    for e in exemplars.CORPUS:
        assert "**" not in e.reply, e.id            # no bold
        assert "\n" not in e.reply, e.id            # one paragraph
        assert not re.search(r"[1-9][.、)]\s|[·•]", e.reply), e.id   # no list
        # The whole corpus currently runs 112–129 characters. The ceiling is a
        # drift alarm, not a target: an entry that needs 200 has become the
        # report these exist to replace.
        assert len(e.reply) <= 150, e.id


def test_every_exemplar_is_reachable():
    """A tag set that never matches its own question is a dead row."""
    for e in exemplars.CORPUS:
        assert e.score(e.question) > 0, e.id
        assert exemplars.in_domain(e.question), e.id


# ── injection into the prompt ────────────────────────────────────────────────

def test_injected_between_system_and_history():
    history = [
        {"role": "user", "text": "你好"},
        {"role": "ai", "text": "你好，我是 NURI"},
        {"role": "user", "text": "孩子講錯字，我要一直糾正他嗎？"},
    ]
    msgs, fewshot = nuri_messages(history)
    assert msgs[0]["role"] == "system"
    assert fewshot == 4
    assert exemplars.GUARD in msgs[0]["content"]
    # The real conversation follows the pairs, in order, unchanged.
    assert [m["content"] for m in msgs[1 + fewshot:]] == \
           ["你好", "你好，我是 NURI", "孩子講錯字，我要一直糾正他嗎？"]


def test_no_exemplars_leaves_the_prompt_untouched():
    history = [{"role": "user", "text": "宝宝晚上一直哭，怎么哄都不睡"}]
    msgs, fewshot = nuri_messages(history)
    assert fewshot == 0
    assert exemplars.GUARD not in msgs[0]["content"]
    assert len(msgs) == 2


def test_selection_keys_off_the_latest_parent_message():
    """Not the whole transcript: the exemplar answers the question being asked,
    not one the parent moved on from three turns ago."""
    history = [
        {"role": "user", "text": "孩子講錯字，我要一直糾正他嗎？"},
        {"role": "ai", "text": "……"},
        {"role": "user", "text": "他看繪本一下就跑掉，還要繼續讀嗎？"},
    ]
    msgs, fewshot = nuri_messages(history)
    assert msgs[1]["content"].startswith("孩子看繪本")


def test_four_model_system_prompt_gets_the_same_treatment():
    """The two pipelines must still differ only in the system message."""
    history = [{"role": "user", "text": "孩子很少主動跟我說話"}]
    msgs, fewshot = nuri_messages(history, system_prompt="RENDERED")
    assert msgs[0]["content"].startswith("RENDERED")
    assert fewshot == 4
