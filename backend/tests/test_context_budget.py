"""The prompt budget, and the ordering that makes the prefix cache reachable.

Every number here comes from the measurement in `context_budget`'s docstring:
2,687 prompt tokens against 235 completion, 56% of the input a block that never
changes. The tests pin the two things that fix it — a ceiling on each
contributor, and a stable-to-volatile order — because both are the kind of
property a well-meaning edit silently undoes.
"""

from __future__ import annotations

from datetime import date

import pytest

from backend.nuri_core import context_budget as cb, family_store
from backend.nuri_core.contracts import DialoguePlan
from backend.nuri_core.dialogue_reply import CACHE_SEAM, nuri_messages


def msgs(*pairs) -> list[dict]:
    return [{"role": role, "text": text} for role, text in pairs]


# ── The recent window ────────────────────────────────────────────────────────

def test_only_the_last_few_messages_survive():
    history = msgs(*[("user", f"m{i}") for i in range(30)])
    kept = cb.recent_messages(history)
    assert cb.RECENT_MESSAGES <= len(kept) < cb.RECENT_MESSAGES + cb.WINDOW_STEP
    assert kept[-1]["text"] == "m29"


def test_the_window_start_holds_still_for_several_turns():
    """A window that slides one message a turn changes its first message every
    turn, and the provider's prefix cache then covers none of the history."""
    starts = []
    for n in range(20, 32):
        history = msgs(*[("user", f"m{i}") for i in range(n)])
        starts.append(cb.recent_messages(history)[0]["text"])
    # 12 consecutive turns, but the first replayed message changed only twice.
    assert len(set(starts)) <= 3
    assert cb.recent_messages(msgs(*[("user", f"m{i}") for i in range(30)]), step=1)[0]["text"] == "m22"


def test_the_token_ceiling_overrides_the_message_count():
    """Eight turns of a pasted clinic report is not eight turns of 好的 — which
    is exactly why a turn count alone never fixed the input:output ratio."""
    history = msgs(*[("user", "字" * 4000) for _ in range(8)])
    kept = cb.recent_messages(history)
    assert len(kept) < cb.RECENT_MESSAGES
    spent = sum(cb.estimate_tokens(m["text"]) for m in kept)
    assert spent <= cb.RECENT_TOKEN_LIMIT * 1.5


def test_the_current_question_is_never_dropped():
    """A turn that trims away the message it is answering is not a cheaper
    turn."""
    history = msgs(("user", "字" * 40000))
    assert cb.recent_messages(history) == history


def test_empty_messages_do_not_consume_the_window():
    history = msgs(("user", "a"), ("ai", ""), ("user", "  "), ("user", "b"))
    assert [m["text"] for m in cb.recent_messages(history)] == ["a", "b"]


# ── Long-term memory ─────────────────────────────────────────────────────────

def test_memory_is_ranked_against_the_question_not_by_recency():
    """limit=12 ordered by updated_at made this a second short history,
    duplicating what the recent window already carries."""
    memories = [
        {"text": "孩子对花生过敏", "updated_at": "2026-01-01"},
        {"text": "家长喜欢周末爬山", "updated_at": "2026-05-01"},
        {"text": "孩子晚上八点睡觉，最近睡不好", "updated_at": "2026-02-01"},
    ]
    picked = cb.select_memories(memories, "孩子晚上睡不好怎么办")
    assert "睡" in picked[0]["text"]


def test_memory_falls_back_to_recency_without_a_question():
    memories = [
        {"text": "旧的事", "updated_at": "2026-01-01"},
        {"text": "新的事", "updated_at": "2026-09-01"},
    ]
    assert cb.select_memories(memories, "")[0]["text"] == "新的事"


def test_memory_is_capped_per_item_and_in_count():
    memories = [{"text": "字" * 5000, "updated_at": f"2026-0{i}-01"} for i in range(1, 6)]
    picked = cb.select_memories(memories, "字")
    assert len(picked) == cb.MEMORY_TOP_K
    for m in picked:
        assert cb.estimate_tokens(m["text"]) <= cb.MEMORY_TOKEN_LIMIT + 1


def test_relevance_works_on_chinese():
    """A whitespace tokenizer scores every Chinese memory as one huge token and
    matches nothing, which would silently reduce ranking to recency."""
    assert cb.relevance("孩子晚上睡不好", "宝宝睡不好怎么办") > 0
    assert cb.relevance("家长喜欢爬山", "宝宝睡不好怎么办") == 0


# ── Clipping ─────────────────────────────────────────────────────────────────

def test_clip_prefers_a_sentence_boundary():
    text = "第一句话在这里。" + "第二句话也在这里。" * 200
    clipped = cb.clip(text, 40)
    assert clipped.endswith("。")
    assert cb.estimate_tokens(clipped) <= 41


def test_clip_leaves_short_text_alone():
    assert cb.clip("短", 600) == "短"


# ── State refresh ────────────────────────────────────────────────────────────

def test_no_summary_while_the_window_still_holds_everything():
    """A short conversation must never pay for a summary of itself."""
    assert cb.needs_state_refresh(msgs(("user", "你好"), ("ai", "你好"))) is False


def test_summary_triggers_on_what_the_window_drops():
    history = msgs(*[("user", "字" * 3000) for _ in range(20)])
    assert cb.needs_state_refresh(history) is True


# ── The cache boundary ───────────────────────────────────────────────────────

def test_prompt_is_split_stable_first():
    """The order is the entire caching mechanism: the provider matches the
    longest identical prefix, so one block that changes per turn placed early
    truncates the cache to whatever precedes it."""
    built, _ = nuri_messages(
        msgs(("user", "宝宝睡不好")),
        style_ctx="全局规则", profile_ctx="孩子18个月",
        state_ctx="之前聊过入睡时间", memory_ctx="对花生过敏",
        sources_ctx="[1] 某篇文章",
    )
    systems = [m["content"] for m in built if m["role"] == "system"]
    assert len(systems) == 3
    assert "全局规则" in systems[0] and "孩子18个月" not in systems[0]
    assert "孩子18个月" in systems[1] and "之前聊过入睡时间" in systems[1]
    assert "对花生过敏" in systems[2] and "某篇文章" in systems[2]


def test_confirmed_child_profile_overrides_stale_memory_in_final_prompt(monkeypatch):
    """The reply model must see the saved birthday, not infer it from an old
    conversational age or ask the parent to provide it again."""

    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    profile = family_store.profile_ctx({}, [{
        "nickname": "小啊谷",
        "birth_date": "2025-10-10",
        "gender": "boy",
    }])
    built, _ = nuri_messages(
        msgs(("user", "你知道小啊谷的生日吗？")),
        profile_ctx=profile,
        memory_ctx="旧对话只记得孩子大约9个月，生日还没有确认。",
    )
    systems = [m["content"] for m in built if m["role"] == "system"]

    assert "已确认出生日期：2025-10-10" in systems[1]
    assert "当前年龄：10个月" in systems[1]
    assert "若与旧对话摘要或长期记忆冲突，以这里为准" in systems[1]
    assert "不要再次询问" in systems[1]
    # The stale memory may still be relevant to this turn, but the preceding
    # family block gives the model an explicit, deterministic precedence rule.
    assert "生日还没有确认" in systems[2]


def test_the_global_message_is_identical_across_parents():
    """One cache entry has to serve all traffic, or the largest block in the
    prompt is paid for per user."""
    first, _ = nuri_messages(msgs(("user", "hi")), style_ctx="R", profile_ctx="家庭A")
    second, _ = nuri_messages(msgs(("user", "hi")), style_ctx="R", profile_ctx="家庭B")
    assert first[0]["content"] == second[0]["content"]


def test_the_seam_never_reaches_the_model():
    plan = DialoguePlan(
        sections=(("A:", "aa"), ("B:", "bb"), ("C:", "cc")), stable_sections=2,
    )
    built, _ = nuri_messages(
        msgs(("user", "hi")),
        system_prompt=CACHE_SEAM.join(plan.system_parts("PERSONA")),
    )
    for message in built:
        assert CACHE_SEAM not in message["content"]
    systems = [m["content"] for m in built if m["role"] == "system"]
    assert systems[0].startswith("PERSONA")
    assert "aa" in systems[1] and "cc" in systems[2]


def test_a_plain_system_prompt_still_works():
    """An older caller passing one string has no seams and should land in one
    leading message, as before."""
    built, _ = nuri_messages(msgs(("user", "hi")), system_prompt="just one block")
    assert built[0] == {"role": "system", "content": "just one block"}
    # Anything else is the per-turn block (here, the register rule), which now
    # travels just before the question rather than inside the leading message.
    assert all(m["content"] != "just one block" for m in built[1:])
    assert built[-1] == {"role": "user", "content": "hi"}


def _turn(history, **kwargs):
    return nuri_messages(
        history,
        system_prompt=CACHE_SEAM.join(("PERSONA", "FAMILY", "RULES FOR THIS TURN")),
        **kwargs,
    )[0]


def test_the_next_turn_repeats_this_turns_prompt_up_to_the_new_exchange():
    """The point of the order: everything but the per-turn block and the new
    exchange is byte-identical to the previous turn, so it bills as cached."""
    history = msgs(*[(("user" if i % 2 == 0 else "ai"), f"第{i}句话") for i in range(9)])
    first = _turn(history)
    second = _turn(history + msgs(("ai", "第9句话"), ("user", "第10句话")))
    # The previous turn's prompt minus its per-turn block and current message
    # is a prefix of this turn's prompt.
    shared = first[:-2]
    assert second[: len(shared)] == shared
    # The per-turn block sits directly before the question, not before history.
    assert second[-2]["role"] == "system"
    assert second[-2]["content"].startswith("RULES FOR THIS TURN")
    assert second[-1]["content"] == "第10句话"
    assert [m["content"] for m in second[:2]] == ["PERSONA", "FAMILY"]


def test_empty_sections_do_not_shift_the_boundary():
    """`stable_sections` counts what the dialogue model emitted; empty bodies
    drop out, and an off-by-one here would leak per-turn content into the
    cached half."""
    plan = DialoguePlan(
        sections=(("A:", "aa"), ("B:", ""), ("C:", "cc")), stable_sections=2,
    )
    _, family, per_turn = plan.system_parts("P")
    assert "aa" in family and "cc" not in family
    assert "cc" in per_turn
