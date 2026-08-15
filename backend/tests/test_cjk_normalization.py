"""The radical-codepoint fold that stands between the internal corpus and being
retrievable at all.

Some PDF producers emit Kangxi radical codepoints for common characters: ⼦ is
U+2F26, 子 is U+5B50, they render identically and an embedding model treats them
as different tokens. 93% of the chunks in the `internal` namespace were ingested
that way — 2,000 occurrences of ⼦ alone.

Worth about +0.013 top-1 similarity, measured rather than assumed, so this is
the cheap correct fix and not the reason the namespace only reaches 13% of
turns. Storing text that does not contain the characters the parent typed is
wrong on its own terms.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.nuri_core.knowledge_store import chunk_text, normalize_cjk  # noqa: E402


@pytest.mark.parametrize("broken,fixed", [
    ("孩⼦說「我不好」", "孩子說「我不好」"),
    ("⼀直哭", "一直哭"),
    ("⾃⼰⽤⼒", "自己用力"),
    ("⺟乳", "母乳"),
    ("兩歲幼兒", "兩歲幼兒"),          # already clean, must not change
])
def test_radicals_fold_to_the_ideographs_they_stand_for(broken, fixed):
    assert normalize_cjk(broken) == fixed


def test_chinese_punctuation_survives():
    """Full NFKC over the whole string would turn these into ASCII. The chunks
    are quoted into the prompt as 內部準則, where Chinese punctuation belongs."""
    text = "先問：「你覺得哪裡不好？」，再回應。"
    assert normalize_cjk(text) == text


def test_normalisation_is_idempotent():
    once = normalize_cjk("孩⼦⾃⼰⽤⼒")
    assert normalize_cjk(once) == once


def test_chunking_normalises_too():
    """read_pdf is not the only path into the vector store, and chunk_text is
    the last funnel before embedding."""
    chunks = chunk_text("孩⼦說話" * 40)
    assert chunks
    assert all("⼦" not in c for c in chunks)
    assert "子" in chunks[0]


def test_empty_and_none_are_safe():
    assert normalize_cjk("") == ""
    assert normalize_cjk(None) is None


def test_latin_and_digits_untouched():
    text = "NURI 訓練資料 v1.0 (2026)"
    assert normalize_cjk(text) == text
