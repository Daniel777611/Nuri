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

from backend.feed.delivery import (  # noqa: E402
    resource_matches_preferred_locale as _resource_matches_preferred_locale,
)
from backend.nuri_core import family_store  # noqa: E402
from backend.main import ChildCreate, _child_payload  # noqa: E402
from backend.nuri_core.family_store import (  # noqa: E402
    age_label as _age_label,
    profile_ctx as _profile_ctx,
    safe_child_recommendation_context as _safe_child_recommendation_context,
)


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


@pytest.mark.parametrize(
    "today,birth_date,expected",
    [
        (date(2026, 2, 28), "2026-01-31", "1个月"),
        (date(2026, 4, 30), "2026-03-31", "1个月"),
        (date(2025, 2, 28), "2024-02-29", "12个月"),
    ],
)
def test_age_label_treats_short_month_end_as_anniversary(
    monkeypatch, today, birth_date, expected
):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(today.year, today.month, today.day)

    # Patched on the module that owns the arithmetic — the age helpers moved to
    # nuri_core.family_store, and backend.main only re-exports them.
    monkeypatch.setattr(family_store, "date", FixedDate)
    assert _age_label(birth_date) == expected


def test_child_model_preserves_date_only_value_and_rejects_future_date():
    child = ChildCreate(nickname="小满", birth_date="2025-10-01")
    assert _child_payload(child)["birth_date"] == "2025-10-01"

    with pytest.raises(ValueError):
        ChildCreate(nickname="小满", birth_date=_shift_months(2))


def test_recommendation_child_context_contains_age_but_not_identity_or_birthday():
    child = {
        "nickname": "不应外发的名字",
        "birth_date": "2025-10-01",
        "gender": "boy",
    }
    context = _safe_child_recommendation_context([child])

    assert _age_label("2025-10-01") in context["child_age_context"]
    assert "不应外发的名字" not in context["child_age_context"]
    assert "2025-10-01" not in context["child_age_context"]
    assert len(context["child_profile_fingerprint"]) == 24

    changed = _safe_child_recommendation_context(
        [{**child, "birth_date": "2025-09-01"}]
    )
    assert (
        changed["child_profile_fingerprint"]
        != context["child_profile_fingerprint"]
    )


def test_simplified_locale_does_not_accept_taiwan_fallback_label():
    assert not _resource_matches_preferred_locale(
        {
            "locales": ["zh-CN", "zh-TW"],
            "language": "普通话视频 · 台湾",
            "publisher": "台湾育儿频道",
        },
        "zh-CN",
    )
    assert _resource_matches_preferred_locale(
        {
            "locales": ["zh-CN"],
            "language": "简体中文",
            "publisher": "香港卫生署家庭健康服务",
        },
        "zh-CN",
    )


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
