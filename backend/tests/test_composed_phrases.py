"""Sentences the backend builds, in the language the family reads.

Everything the frontend renders as a fixed string it can translate, because a
key is a key. What it cannot reach is a sentence assembled with the family's own
words already inside it — 「相似家庭如何一步步面对“语言与沟通”」 — which arrives
finished and matches nothing.

The locale was never missing. The settings screen writes the UI language into
privacy.language, SUPPORTED_PREFERRED_LOCALES already includes "en", and the
backend loads it as preferred_locale. `_delivery_title` has branched on it all
along; the guide beside it never did, which is how a card ended up showing an
English title above a Simplified guide.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import locales  # noqa: E402
from backend.feed import delivery as feed_delivery  # noqa: E402

CJK = range(0x4E00, 0xA000)


def _has_chinese(text: str) -> bool:
    return any(ord(ch) in CJK for ch in text)


@pytest.mark.parametrize("locale", ["zh-CN", "zh-TW", "en"])
def test_every_phrase_exists_in_every_supported_locale(locale):
    """A missing variant falls back to Simplified silently, which reads as a
    translation gap rather than as an error. This is the check that finds it."""
    missing = [
        key for key in locales._PHRASES
        if locale not in locales._PHRASES[key]
    ]
    assert missing == [], missing


def test_english_phrases_carry_no_chinese():
    for key, variants in locales._PHRASES.items():
        assert not _has_chinese(variants["en"]), key


def test_placeholders_match_across_locales():
    """A variant that drops a variable renders a sentence with a hole in it."""
    import re

    for key, variants in locales._PHRASES.items():
        expected = set(re.findall(r"\{(\w+)\}", variants["zh-CN"]))
        for locale, template in variants.items():
            assert set(re.findall(r"\{(\w+)\}", template)) == expected, (key, locale)


def test_an_unknown_locale_degrades_to_simplified():
    assert locales.phrase("intro.case", "de") == locales._PHRASES["intro.case"]["zh-CN"]
    assert locales.phrase("intro.case", None) == locales._PHRASES["intro.case"]["zh-CN"]


def test_a_missing_variable_returns_the_template_rather_than_raising():
    """A card that reads oddly beats a feed that fails to build."""
    assert "{topic}" in locales.phrase("reason.topic", "en")


def test_an_unknown_key_is_empty_not_an_exception():
    assert locales.phrase("nope.nope", "en") == ""


@pytest.mark.parametrize("locale,expect_chinese", [("en", False), ("zh-TW", True)])
def test_the_guide_follows_the_locale(locale, expect_chinese):
    card = {
        "content_category": "case",
        "preferred_locale": locale,
        "recommendation_focus": "toys that help language",
        "child_age_context": "15 months",
        "topic_label": "语言与沟通",
    }
    feed_delivery.decorate_delivery_card(card, [])
    assert _has_chinese(card["guide"]) is expect_chinese, card["guide"]


def test_the_stage_fallback_follows_the_locale():
    english = {"content_category": "case", "preferred_locale": "en"}
    feed_delivery.decorate_delivery_card(english, [])
    assert "当前发展阶段" not in english["guide"]
