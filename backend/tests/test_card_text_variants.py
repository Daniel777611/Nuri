"""A card carries its own sentences in all three languages, from generation.

The frontend can translate a fixed phrase, because a key is a key. It cannot
touch a sentence the backend assembled with the family's own words inside it —
that arrives finished and matches nothing. So those are composed three times at
generation and shipped together.

Generated rather than translated on demand because a prepared card is frozen
into a snapshot: without every language present from the start, a family that
switches language keeps reading the old one until something re-prepares it.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import locales  # noqa: E402
from backend.feed import delivery as feed_delivery  # noqa: E402
from backend.feed import signals as feed_signals  # noqa: E402

LOCALES = sorted(locales.SUPPORTED_PREFERRED_LOCALES)


def _messages(text: str) -> list[dict]:
    return [{"role": "user", "text": text}, {"role": "ai", "text": "…"}]


def _card(text: str, locale: str = "zh-CN") -> dict:
    items, _ = feed_signals.rank_learning_content(
        _messages(text), count=1, session_id="s", preferred_locale=locale
    )
    return items[0]


def test_a_library_card_carries_the_reason_in_every_language():
    card = _card("寶寶晚上一直夜醒，哄睡很久")
    variants = card["personalization_reason_i18n"]
    assert sorted(variants) == LOCALES
    assert all(variants[locale] for locale in LOCALES)
    # Three distinct renderings, not one string copied three times.
    assert len(set(variants.values())) == len(LOCALES)


def test_the_english_reason_carries_no_chinese_sentence():
    """The topic and the family's own words may be Chinese — the sentence
    around them must not be."""
    card = _card("寶寶晚上一直夜醒，哄睡很久")
    english = card["personalization_reason_i18n"]["en"]
    assert "这篇内容" not in english
    assert "因为" not in english


def test_the_topic_label_travels_with_it():
    card = _card("寶寶晚上一直夜醒，哄睡很久")
    labels = card["topic_label_i18n"]
    assert labels["en"] == "sleep and routines"
    assert labels["zh-TW"] == "睡眠與作息"


def test_a_dynamic_card_carries_its_title_in_every_language():
    """Its topic is the parent's own words and stays as written; only the
    sentence around it changes."""
    card = _card("孩子兩歲半，講話還是只有兩三個字")
    assert card.get("is_dynamic_research_card")
    variants = card["text_i18n"]
    assert sorted(variants) == LOCALES
    for locale in LOCALES:
        assert "孩子兩歲半" in variants[locale]["title"]
    assert variants["en"]["title"].startswith("More on")


def test_the_delivery_card_carries_title_and_guide_in_every_language():
    card = {
        "content_category": "case",
        "preferred_locale": "zh-CN",
        "topic_label": "语言与沟通",
        "child_age_context": "15 months",
        "recommendation_focus": "toys that help language",
    }
    feed_delivery.decorate_delivery_card(card, [])
    variants = card["text_i18n"]
    assert sorted(variants) == LOCALES
    for locale in LOCALES:
        assert variants[locale]["delivery_title"]
        assert variants[locale]["guide"]
    assert len({variants[locale]["guide"] for locale in LOCALES}) == len(LOCALES)


def test_the_flat_fields_still_match_the_saved_locale():
    """Anything reading a card the old way must keep working — including a
    client that has not learned about the variants."""
    for locale in LOCALES:
        card = {
            "content_category": "authority",
            "preferred_locale": locale,
            "topic_label": "睡眠与作息",
            "child_age_context": "11 months",
            "recommendation_focus": "night waking",
        }
        feed_delivery.decorate_delivery_card(card, [])
        assert card["guide"] == card["text_i18n"][locale]["guide"]


@pytest.mark.parametrize("state", ["privacy_off", "unavailable"])
def test_the_non_conversation_reasons_are_translated_too(state):
    items, _ = feed_signals.rank_learning_content(
        _messages("寶寶晚上一直夜醒"), count=1, session_id="s",
        context_state=state, preferred_locale="en",
    )
    variants = items[0]["personalization_reason_i18n"]
    assert sorted(variants) == LOCALES
    assert "NURI" in variants["en"] or variants["en"]
    assert variants["en"] != variants["zh-CN"]
