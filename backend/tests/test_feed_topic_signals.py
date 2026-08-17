"""Why the homepage cards stopped following the conversation.

Two independent faults, both of which made the feed look like a fixed list.

The library's match terms are all Simplified and a large share of these families
write Traditional, so 「孩子兩歲半，講話還是只有兩三個字」 matched nothing — not
even learn_language_milestones. Sleep and picky-eating appeared to work because
夜醒, 哄睡, 挑食 and 蔬菜 are written the same either way, and 大情绪 turned up in
every conversation because its terms include the single shared character 哭.

And the dynamic research card — the one that researches whatever the parent is
actually talking about — took its topic from the latest message alone, which in
a real conversation is a follow-up with no keyword in it.

No model calls: all of this is text analysis.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.content_library import LEARNING_CONTENT_CARDS  # noqa: E402
from backend.feed import signals  # noqa: E402


def _terms(card):
    return [*card.get("match_terms", []),
            *signals.TOPIC_SIGNAL_ALIASES.get(str(card.get("id") or ""), ())]


def _cards_matching(text):
    return sorted(
        str(c.get("id"))
        for c in LEARNING_CONTENT_CARDS
        if signals._matched_terms(text.casefold(), _terms(c))
    )


# ── the script fold ──────────────────────────────────────────────────────────

def test_the_fold_covers_every_term_in_the_library():
    """The guarantee that matters: a term cannot be added in a vocabulary the
    matcher cannot reach. Renders each term in Traditional and folds it back."""
    simplified_to_traditional = {}
    for traditional, simplified in signals._SIMPLIFIED_BY_TRADITIONAL.items():
        simplified_to_traditional.setdefault(simplified, traditional)

    unreachable = []
    for card in LEARNING_CONTENT_CARDS:
        for term in _terms(card):
            if not isinstance(term, str):
                continue
            as_traditional = "".join(
                simplified_to_traditional.get(ch, ch) for ch in term
            )
            if signals.fold_to_simplified(as_traditional) != term:
                unreachable.append(term)
    assert unreachable == []


def test_the_fold_preserves_length():
    """Occurrence offsets index the folded string and are used for scoring, so
    the mapping has to be 1:1."""
    for text in ("孩子講話還是只有兩三個字", "寶寶夜醒", "screen time 手機"):
        assert len(signals.fold_to_simplified(text)) == len(text)


def test_the_fold_leaves_simplified_and_latin_alone():
    for text in ("孩子说话还是只有两三个字", "screen time", "1080p"):
        assert signals.fold_to_simplified(text) == text


@pytest.mark.parametrize("traditional,simplified", [
    ("孩子兩歲半，講話還是只有兩三個字，要不要做語言評估",
     "孩子两岁半，讲话还是只有两三个字，要不要做语言评估"),
    ("孩子有很大的情緒，一直發脾氣", "孩子有很大的情绪，一直发脾气"),
    ("寶寶的發展里程碑，什麼時候會爬", "宝宝的发展里程碑，什么时候会爬"),
])
def test_both_scripts_reach_the_same_cards(traditional, simplified):
    assert _cards_matching(traditional) == _cards_matching(simplified)


def test_a_traditional_language_question_reaches_the_language_card():
    """The case the report came in about."""
    assert "learn_language_milestones" in _cards_matching(
        "孩子兩歲半，講話還是只有兩三個字，要不要做語言評估"
    )


# ── the dynamic card's topic ─────────────────────────────────────────────────

def _conversation(*texts):
    out = []
    for t in texts:
        out.append({"role": "user", "text": t})
        out.append({"role": "ai", "text": "（回覆）"})
    return out


def test_a_keyword_free_follow_up_still_names_its_subject():
    """The latest message is what the parent just said; it is not always what
    they are talking about."""
    messages = _conversation(
        "寶寶剛滿四個月，想開始吃副食品，他會把米糊吐出來",
        "一天試一次，大概吃十口",
        "明天想給他吃地瓜泥看看",
    )
    assert signals._conversation_topic_excerpt(messages) == "明天想給他吃地瓜泥看看"
    assert "副食品" in signals._dynamic_topic(messages)


def test_the_latest_message_wins_when_it_names_its_own_subject():
    messages = _conversation(
        "寶寶剛滿四個月，想開始吃副食品",
        "他晚上一直夜醒，怎麼哄都不睡",
    )
    assert "夜醒" in signals._dynamic_topic(messages)


def test_a_conversation_with_no_subject_at_all_produces_no_card():
    messages = _conversation("嗯", "好的", "謝謝")
    assert signals._build_dynamic_research_card(
        messages, session_id="s", context_created_at=None, include_detail=False
    ) is None


def test_the_card_is_built_for_a_topic_the_library_does_not_cover():
    messages = _conversation(
        "寶寶剛滿四個月，想開始吃副食品，他會把米糊吐出來",
        "明天想給他吃地瓜泥看看",
    )
    card = signals._build_dynamic_research_card(
        messages, session_id="s", context_created_at=None, include_detail=False
    )
    assert card and card["is_dynamic_research_card"]
    assert "副食品" in card["topic"]


def test_only_the_parents_own_messages_supply_the_subject():
    """NURI restates the subject every turn; counting her replies would let her
    keep a topic alive on the strength of her own wording rather than the
    family's."""
    messages = [
        {"role": "user", "text": "嗯"},
        {"role": "ai", "text": "我們剛才在談副食品和米糊的問題"},
        {"role": "user", "text": "好"},
    ]
    assert not any("副食品" in t for t in signals._recent_user_texts(messages))
    assert signals._build_dynamic_research_card(
        messages, session_id="s", context_created_at=None, include_detail=False
    ) is None


# ── the whole ranking ────────────────────────────────────────────────────────

def test_different_conversations_produce_different_cards():
    """The report in one assertion: four topics, four different homepages."""
    topics = {
        "sleep": ("寶寶四個月，晚上會醒兩三次，怎麼哄都不睡", "白天小睡都很短"),
        "solids": ("寶寶剛滿四個月，想開始吃副食品", "明天想給他吃地瓜泥看看"),
        "language": ("孩子兩歲半，講話還是只有兩三個字", "要不要現在就去做語言評估？"),
        "tantrum": ("兩歲的孩子一不順他的意就倒地大哭", "在賣場尖叫，要不要處罰他？"),
    }
    seen = {}
    for name, texts in topics.items():
        items, used = signals.rank_learning_content(
            _conversation(*texts), count=4, session_id="probe",
        )
        assert used, name
        seen[name] = [str(i.get("id")) for i in items]
    assert len({tuple(v) for v in seen.values()}) == len(seen), seen
