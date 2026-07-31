"""Unit tests for the onboarding answers -> prompt block conversion.

The questionnaire asks the parent eight things; anything this builder drops is a
question they answered for nothing, so the coverage assertion below is the point
of the file rather than an extra.
"""
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.main import _age_label, _normalize_language, _profile_ctx  # noqa: E402


def _shift_months(delta: int) -> str:
    """A date exactly `delta` months from today. The day is clamped to 28 so
    differing month lengths can't shift the computed age by one."""
    today = date.today()
    total = today.year * 12 + (today.month - 1) + delta
    year, month = divmod(total, 12)
    return date(year, month + 1, min(today.day, 28)).isoformat()


def _born(years=0, months=0, days=0):
    if days:
        return (date.today() - timedelta(days=days)).isoformat()
    return _shift_months(-(years * 12 + months))


@pytest.mark.parametrize(
    "kwargs,expected",
    [
        (dict(months=6), "6个月"),
        (dict(months=23), "23个月"),
        (dict(years=2), "2岁"),
        (dict(years=2, months=6), "2岁6个月"),
        (dict(years=6), "6岁"),
        (dict(days=3), "未满1个月"),
    ],
)
def test_age_label(kwargs, expected):
    assert _age_label(_born(**kwargs)) == expected


@pytest.mark.parametrize("bad", ["", None, "not-a-date", "2024-13-45"])
def test_age_label_rejects_bad_input(bad):
    assert _age_label(bad) == ""


def test_future_birth_date_yields_no_age():
    assert _age_label(_shift_months(2)) == ""


FULL_PROFILE = {
    "nickname": "小满妈",
    "city": "Toronto",
    "parent_role": "mom",
    "top_concerns": ["sleep", "other"],
    "concern_other": "半夜频繁夜醒",
    "hobbies": "看剧、健身",
    "help_preference": "actionable",
    "info_source": "expert",
}
CHILDREN = [{
    "nickname": "小满",
    "birth_date": _born(years=2, months=3),
    "gender": "girl",
    "allergies": ["花生"],
    "notes": "最近在换牙",
}]


def test_every_answered_question_reaches_the_prompt():
    out = _profile_ctx(FULL_PROFILE, CHILDREN)
    for expected in [
        "小满妈",           # nickname
        "妈妈",             # parent_role
        "Toronto",          # city
        "睡眠",             # top_concerns
        "半夜频繁夜醒",      # concern_other
        "看剧、健身",        # hobbies
        "医师或专家",        # info_source
        "小满",             # child name
        "2岁3个月",         # child age
        "女孩",             # child gender
        "花生",             # allergies
        "最近在换牙",        # notes
        "直接拿到可执行的方法",  # help_preference, as an instruction
    ]:
        assert expected in out, f"{expected!r} missing from:\n{out}"


def test_concern_other_replaces_the_generic_other_label():
    out = _profile_ctx(FULL_PROFILE, [])
    assert "半夜频繁夜醒" in out
    assert "其他" not in out


def test_empty_profile_is_empty_not_noise():
    assert _profile_ctx({}, []) == ""
    assert _profile_ctx({"nickname": "", "top_concerns": []}, None) == ""


def test_partial_profile_only_includes_answered_fields():
    out = _profile_ctx({"nickname": "阿明", "top_concerns": ["food"]}, [])
    assert "阿明" in out and "饮食" in out
    assert "所在城市" not in out
    assert "没带孩子时喜欢" not in out


def test_child_without_birth_date_still_renders_other_details():
    out = _profile_ctx({}, [{"nickname": "小满", "allergies": ["牛奶"], "notes": ""}])
    assert "小满" in out and "牛奶" in out


def test_multiple_children_all_appear():
    kids = [
        {"nickname": "老大", "birth_date": _born(years=5)},
        {"nickname": "老二", "birth_date": _born(months=8)},
    ]
    out = _profile_ctx({}, kids)
    assert "老大" in out and "5岁" in out
    assert "老二" in out and "8个月" in out


# ── Language preference ──────────────────────────────────────────────────────
# The app sent "zh-CN"/"zh-TW" at a Literal["zh","en"], so every tap on the
# language switch 422'd. Nothing may reject a locale again — worst case it
# falls back to Simplified.
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("zh-CN", "zh-CN"), ("zh-TW", "zh-TW"), ("en", "en"),
        ("zh", "zh-CN"),                      # legacy two-letter code
        ("zh_TW", "zh-TW"), ("ZH-tw", "zh-TW"),
        ("zh-Hant", "zh-TW"), ("zh-Hans", "zh-CN"), ("zh-HK", "zh-TW"),
        ("en-US", "en"),
        ("", "zh-CN"), (None, "zh-CN"), ("klingon", "zh-CN"),
    ],
)
def test_normalize_language(raw, expected):
    assert _normalize_language(raw) == expected


def test_language_preference_reaches_the_prompt():
    out = _profile_ctx({**FULL_PROFILE, "language": "zh-TW"}, [])
    assert "繁體中文" in out


def test_language_preference_is_a_default_not_a_lock():
    """A parent who types English in a zh-TW UI still wants an English answer."""
    out = _profile_ctx({**FULL_PROFILE, "language": "zh-TW"}, [])
    assert "跟随他当下用的" in out


def test_unset_language_adds_nothing():
    assert "界面语言" not in _profile_ctx(FULL_PROFILE, [])
