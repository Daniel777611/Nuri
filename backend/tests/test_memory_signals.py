"""Long-term memory on Home: the knowledge cards and NURI's check-in line.

No network, no database: runtime.get_supabase is patched, and the memory
loader is replaced where an endpoint helper is exercised.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from backend import main, runtime
from backend.feed import checkin as c
from backend.feed import signals as s
from backend.nuri_core import family_store

LANGUAGE_WORRY = {"category": "concern", "key": "language", "value": "担心自己在孩子语言开发方面做得不够"}


@pytest.fixture(autouse=True)
def _no_database(monkeypatch):
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)


# ── Knowledge cards ──────────────────────────────────────────────────────────

def test_only_what_is_going_on_counts_and_only_the_newest_ten():
    rows = [{"category": "fact", "value": "用户在 Houston"}, {"category": "preference", "value": "喜欢旅行"},
            *({"category": "child_state", "value": f"状态{i}"} for i in range(12)), LANGUAGE_WORRY]
    texts = s.memory_signal_texts(rows)
    assert len(texts) == s.MEMORY_SIGNAL_LIMIT and texts[0] == "状态0"
    assert "用户在 Houston" not in texts and "喜欢旅行" not in texts


def test_a_remembered_worry_picks_the_card_without_any_chat():
    before, used_before = s.rank_learning_content([], count=3, context_state="no_history")
    assert not used_before and not before[0]["is_conversation_match"]

    items, used = s.rank_learning_content(
        [], count=3, context_state="no_history", memory_texts=s.memory_signal_texts([LANGUAGE_WORRY]),
    )
    assert used and items[0]["id"] == "learn_language_milestones" and items[0]["is_conversation_match"]
    # Said as memory, not as "you have been talking about".
    assert "之前跟 NURI 说过" in items[0]["personalization_reason"]


def test_the_word_worry_in_a_concern_does_not_make_it_about_emotions():
    items, _ = s.rank_learning_content(
        [], count=2, context_state="no_history", memory_texts=["担心他总是挑食"],
    )
    assert items[0]["id"] == "learn_picky_eating"
    assert items[1]["id"] != "learn_big_feelings" or not items[1]["is_conversation_match"]


def test_what_the_parent_said_this_week_still_comes_first():
    messages = [{"role": "user", "text": "宝宝晚上总是夜醒好几次"}]
    items, _ = s.rank_learning_content(
        messages, count=3, context_state="ready", memory_texts=s.memory_signal_texts([LANGUAGE_WORRY]),
    )
    assert items[0]["id"] == "learn_sleep_routine"
    language = next(i for i in items if i["id"] == "learn_language_milestones")
    assert language["is_conversation_match"]  # still tied to the family, second


def test_the_feed_reads_no_memory_when_history_is_off(monkeypatch):
    async def must_not(_uid):
        raise AssertionError("memory read with history personalization off")

    monkeypatch.setattr(family_store, "load_known_memories", must_not)
    for state in ("privacy_off", "unavailable"):
        assert asyncio.run(main._memory_signal_texts("u-1", {"state": state})) == []


def test_the_feed_reads_memory_otherwise(monkeypatch):
    async def memories(_uid):
        return [LANGUAGE_WORRY, {"category": "fact", "value": "用户在 Houston"}]

    monkeypatch.setattr(family_store, "load_known_memories", memories)
    assert asyncio.run(main._memory_signal_texts("u-1", {"state": "ready"})) == [LANGUAGE_WORRY["value"]]


# ── Check-in ─────────────────────────────────────────────────────────────────

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)


def _msg(i, role, text, minutes_ago):
    return {"id": str(i), "role": role, "text": text, "created_at": (NOW - timedelta(minutes=minutes_ago)).isoformat()}


def test_the_check_in_sees_what_nuri_remembers(monkeypatch):
    seen = {}

    def fake(messages):
        seen["system"], seen["user"] = messages[0]["content"], messages[1]["content"]
        return {"has_topic": True, "topic": "学步", "summary": "s", "feeling": "", "line": "宝宝扶着沙发走得怎么样了？"}

    monkeypatch.setattr(c, "_model_json", fake)
    out = c.write_checkin([_msg(1, "user", "谢谢", 60)], now=NOW,
                          memories=["小测最近刚会扶站，开始扶着沙发迈步", "担心语言开发"])
    assert out["line"] == "宝宝扶着沙发走得怎么样了？"
    assert seen["user"].startswith("【你记得的这个家庭的事") and "扶着沙发迈步" in seen["user"]
    # With no real subject in the chat, the remembered ongoing thing carries it.
    assert "还在进行" in seen["system"]


def test_memory_lines_are_few_and_short():
    block = c.memory_block(["很长的一条记录" * 20] + [f"第{i}条" for i in range(10)])
    lines = [line for line in block.splitlines() if line.startswith("- ")]
    assert len(lines) == c.MEMORY_LINES
    assert all(len(line) <= c.MEMORY_CHARS + 2 for line in lines)
    assert c.memory_block([]) == ""


def test_without_memories_the_prompt_is_as_before(monkeypatch):
    seen = {}

    def fake(messages):
        seen["user"] = messages[1]["content"]
        return {"has_topic": False, "topic": "", "summary": "", "feeling": "", "line": ""}

    monkeypatch.setattr(c, "_model_json", fake)
    assert c.write_checkin([_msg(1, "user", "繁中", 30)], now=NOW) is None
    assert seen["user"].startswith("【对话（旧→新）")
