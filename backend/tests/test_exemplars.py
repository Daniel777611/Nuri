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
    "今天天氣真好",
    "你們公司在哪裡",
    "谢谢",
    "嗯嗯",
])
def test_messages_about_nothing_in_particular_get_no_exemplars(text):
    """The gate still shuts on a message that is not about parenting at all.
    What changed is that a sleep or feeding question is no longer one of those —
    it has its own examples now."""
    assert exemplars.select(text) == []


@pytest.mark.parametrize("text,topic", [
    ("寶寶晚上一直夜醒，怎麼哄都不睡", "sleep"),
    ("副食品他一直吐出來", "feeding"),
    ("一不順他的意就倒地大哭", "emotion"),
    ("五個月了還不會翻身", "development"),
    ("我真的好累，快撐不住了", "parent"),
    ("孩子講話還是只有兩三個字", "language"),
])
def test_every_topic_has_its_own_warm_examples(text, topic):
    """The requirement in one test: whatever the family is asking about, the
    reply is written from an example rather than from an instruction."""
    chosen = exemplars.select(text)
    assert chosen, text
    assert all(e.topic == topic for e in chosen), [e.id for e in chosen]


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


def test_in_domain_but_unmatched_falls_back_to_that_topic_s_general_pair():
    """A question the topic covers but no scenario names still gets an anchor,
    and it comes from the right topic."""
    chosen = exemplars.select("孩子的語言發展需要注意什麼？")
    assert _ids(chosen) == ["A", "E"]
    sleep = exemplars.select("他的睡眠作息要怎麼安排？")
    assert all(e.topic == "sleep" for e in sleep), _ids(sleep)


def test_respects_the_count_ceiling():
    assert len(exemplars.select("孩子很少主動說話，也常常講錯字", limit=1)) == 1
    assert exemplars.select("孩子很少主動說話", limit=0) == []


def test_a_thin_match_is_topped_up_from_its_own_topic():
    """One pair shifts the register less reliably than two, and the filler has
    to come from the same subject or it answers a different question."""
    chosen = exemplars.select("孩子看繪本一下就跑掉，還要繼續讀嗎？")
    assert len(chosen) == 2
    assert chosen[0].id == "J"
    assert chosen[1].id in exemplars._DEFAULT_IDS["language"]


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


def test_topics_never_cross():
    """The reason the gate exists. A sleep question answered out of a feeding
    example is the wrong advice in the right voice, which is worse than no
    example at all."""
    for text in ("寶寶晚上一直夜醒", "副食品他一直吐出來", "他一直打人"):
        topics = {e.topic for e in exemplars.select(text)}
        assert len(topics) == 1, (text, topics)


def test_a_stale_topic_does_not_follow_the_conversation():
    """Stickiness carries a subject across a keyword-free follow-up, not across
    a change of subject."""
    stale = ["閒聊一", "閒聊二", "閒聊三", "孩子講話還是只有兩三個字"]
    assert exemplars.select("今天天氣真好", recent=stale) == []


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


#: An emoji, in the ranges the transcript actually uses.
_EMOJI = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF]")


def test_replies_look_like_the_target_register():
    """The corpus is the specification of the register, so every property that
    was asked for is asserted here rather than hoped for.

    Three beats — acknowledge, advise, ask — which is why several short lines
    are required and a single block is not. That is the distinction the first
    version of this test got wrong: it banned newlines in order to ban bulleted
    reports, and banned the transcript's actual shape along with them.
    """
    for e in exemplars.CORPUS:
        lines = [line for line in e.reply.split("\n") if line.strip()]
        assert "**" not in e.reply, e.id
        # Numbered *steps* are allowed — a sequence with a real order is what
        # was asked for. A numbered *question* is not: that is the five-question
        # form this register work exists to remove, and the digit was never the
        # thing wrong with it.
        numbered = [l for l in lines if re.match(r"\s*[1-9][.\u3001)]", l)]
        assert not any("\uff1f" in l for l in numbered), e.id
        assert "\u2022" not in e.reply and "\u00b7 " not in e.reply, e.id
        # Not a fixed shape: only the first line and the last are required.
        # A reply that carries numbered steps needs more room than one that
        # does not, and forcing both into the same line count was how the
        # steps got banned in the first place.
        assert 2 <= len(lines) <= 7, (e.id, len(lines))
        # Ends on exactly one question, which is what keeps the conversation
        # going. A trailing emoji is not the end of the sentence.
        assert e.reply.rstrip().rstrip("\U0001F60A\U0001F49B\U0001F604\U0001F90D ").endswith(
            "\uff1f"
        ), e.id
        # Counted on the closing line only: the advice above may quote a
        # question NURI suggests the parent try, and that is not a second
        # question being asked of them.
        assert lines[-1].count("？") == 1, e.id
        # Warmth carried, not decorative: present, and not on every line.
        assert _EMOJI.search(e.reply), e.id
        assert len(_EMOJI.findall(e.reply)) <= 2, e.id
        # Measured without the newlines, the way the ceiling is applied.
        assert len(e.reply.replace("\n", "")) <= exemplars.MAX_CHARS, e.id


def test_every_exemplar_is_reachable_from_its_own_question():
    """A tag set that never matches its own question is a dead row, and a topic
    gate that does not recognise its own exemplars is a dead branch."""
    for e in exemplars.CORPUS:
        assert e.score(e.question) > 0, e.id
        assert exemplars.topic_of(e.question) == e.topic, (e.id, e.topic)


def test_every_topic_has_defaults_that_exist():
    for topic, ids in exemplars._DEFAULT_IDS.items():
        assert ids, topic
        for exemplar_id in ids:
            assert exemplars._BY_ID[exemplar_id].topic == topic, exemplar_id


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
    """The sleep question this used to use now has its own examples, which is
    the point of the change. Something genuinely outside parenting still gets
    nothing."""
    history = [{"role": "user", "text": "你們公司在哪裡？"}]
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
