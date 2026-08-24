"""Unit tests for the onboarding answers -> prompt block conversion.

The questionnaire asks the parent eight things; anything this builder drops is a
question they answered for nothing, so the coverage assertion below is the point
of the file rather than an extra.
"""
import asyncio
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
    reconcile_context_with_child_profile as _reconcile_context,
    redact_child_profile_history as _redact_child_profile_history,
    redact_child_profile_text as _redact_child_profile_text,
    safe_child_recommendation_context as _safe_child_recommendation_context,
    safe_normalized_input_context as _safe_normalized_input_context,
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
        CHILDREN[0]["birth_date"],  # exact confirmed birth date
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


def test_confirmed_birth_date_and_dynamic_age_reach_chat_profile(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    out = _profile_ctx({}, [{
        "nickname": "小啊谷",
        "birth_date": "2025-10-10",
        "gender": "boy",
    }])

    assert (
        "孩子（小啊谷）：已确认出生日期：2025-10-10，"
        "当前年龄：10个月，男孩"
    ) in out
    assert "若与旧对话摘要或长期记忆冲突，以这里为准" in out
    assert "不要再次询问" in out


@pytest.mark.parametrize("bad_date", ["not-a-date", "2027-01-01"])
def test_invalid_or_future_birth_date_is_not_marked_confirmed(monkeypatch, bad_date):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    out = _profile_ctx({}, [{
        "nickname": "小啊谷",
        "birth_date": bad_date,
        "gender": "boy",
    }])

    assert "小啊谷" in out and "男孩" in out
    assert bad_date not in out
    assert "已确认出生日期" not in out


def test_multiple_children_keep_each_identity_bound_to_its_own_facts(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    out = _profile_ctx({}, [
        {
            "nickname": "小啊谷",
            "birth_date": "2025-10-10",
            "gender": "boy",
        },
        {
            "nickname": "姐姐",
            "birth_date": "2022-08-24",
            "gender": "girl",
        },
    ])

    assert (
        "孩子（小啊谷）：已确认出生日期：2025-10-10，"
        "当前年龄：10个月，男孩"
    ) in out
    assert (
        "孩子（姐姐）：已确认出生日期：2022-08-24，"
        "当前年龄：4岁，女孩"
    ) in out


@pytest.mark.parametrize(
    "displayed_date",
    [
        "2025-10-10",
        "2025/10/10",
        "2025年10月10日",
        "2025年10月10号",
        "2025 年 10 月 10 日",
        "10/10/2025",
        "10/10/25",
        "October 10, 2025",
        "Oct. 10, 2025",
        "10月10日",
        "10月10号",
    ],
)
def test_router_boundary_redacts_saved_child_name_and_birthday_variants(
    monkeypatch, displayed_date,
):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    children = [{"nickname": "小啊谷", "birth_date": "2025-10-10"}]
    redacted = _redact_child_profile_text(
        f"小啊谷的生日是{displayed_date}，最近在练习挥手。",
        children,
    )

    assert "小啊谷" not in redacted
    assert displayed_date not in redacted
    assert "10个月" in redacted
    assert "练习挥手" in redacted


def test_router_history_redaction_returns_copy_and_preserves_stored_messages(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    original = [{"role": "ai", "text": "小啊谷生于2025年10月10日。"}]
    redacted = _redact_child_profile_history(
        original,
        [{"nickname": "小啊谷", "birth_date": "2025-10-10"}],
    )

    assert redacted is not original and redacted[0] is not original[0]
    assert "小啊谷" not in redacted[0]["text"]
    assert "2025年10月10日" not in redacted[0]["text"]
    assert original[0]["text"] == "小啊谷生于2025年10月10日。"


def test_birthday_is_redacted_before_month_name_nickname(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    redacted = _redact_child_profile_text(
        "May was born May 10, 2025.",
        [{"nickname": "May", "birth_date": "2025-05-10"}],
    )

    assert "May" not in redacted
    assert "10, 2025" not in redacted
    assert "15个月" in redacted


def test_latin_nickname_does_not_corrupt_larger_english_words():
    redacted = _redact_child_profile_text(
        "Maybe May is ready to practice gestures.",
        [{"nickname": "May"}],
    )

    assert redacted == "Maybe 孩子 is ready to practice gestures."


def test_normalized_input_context_does_not_duplicate_profile_pii(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    context = _safe_normalized_input_context(
        {
            "nickname": "Daniel",
            "city": "Houston",
            "help_preference": "actionable",
            "info_source": "professional",
        },
        [{
            "nickname": "小啊谷",
            "birth_date": "2025-10-10",
            "notes": "家庭私密备注",
        }],
    )
    serialized = str(context)

    assert context["child_age_context"] == "孩子当前年龄：10个月"
    assert context["help_preference"] == "actionable"
    assert context["info_source"] == "professional"
    assert "Daniel" not in serialized
    assert "Houston" not in serialized
    assert "小啊谷" not in serialized
    assert "2025-10-10" not in serialized
    assert "家庭私密备注" not in serialized


def test_feed_context_is_redacted_before_recommendation_topics_are_derived(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    async def load_profile(_uid):
        return {}, [{"nickname": "小啊谷", "birth_date": "2025-10-10"}]

    monkeypatch.setattr(family_store, "date", FixedDate)
    monkeypatch.setattr(family_store, "load_profile", load_profile)
    context = {
        "messages": [{
            "role": "user",
            "text": "小啊谷是2025年10月10日出生，想了解语言发展。",
        }],
    }

    asyncio.run(family_store.attach_child_recommendation_context("parent-1", context))
    outbound = context["messages"][0]["text"]

    assert "小啊谷" not in outbound
    assert "2025年10月10日" not in outbound
    assert "10个月" in outbound
    assert "语言发展" in outbound


def test_confirmed_birthday_removes_only_stale_profile_claims_from_memory(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 8, 24)

    monkeypatch.setattr(family_store, "date", FixedDate)
    memory = (
        "基本资料：小啊谷的生日尚未确认；爸爸在 Houston 创业\n"
        "日常节奏：宝宝大约9个月；晚上睡前喜欢听歌"
    )
    reconciled = _reconcile_context(
        memory,
        [{"nickname": "小啊谷", "birth_date": "2025-10-10"}],
    )

    assert "生日尚未确认" not in reconciled
    assert "大约9个月" not in reconciled
    assert "爸爸在 Houston 创业" in reconciled
    assert "晚上睡前喜欢听歌" in reconciled


def test_memory_is_unchanged_without_a_valid_confirmed_birthday():
    memory = "基本资料：生日尚未确认；晚上睡前喜欢听歌"
    assert _reconcile_context(memory, [{"birth_date": "invalid"}]) == memory
