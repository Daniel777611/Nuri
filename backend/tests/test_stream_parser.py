"""Unit tests for the streaming chat reply's partial-JSON parser.

Unlike the other files in this directory these need no running server — the
parser is pure, and it's the piece most likely to break subtly (a half-arrived
escape sequence emits a broken character that never gets corrected).
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.main import _partial_json_string  # noqa: E402

VALUES = [
    "宝宝晚上不肯睡觉，可以试试固定的睡前流程。",
    'quotes " and back\\slash',
    "line\nbreak\ttab",
    "emoji 👶🏻 and 🌙",       # exercises surrogate pairs when escaped
    "a/b",
    "",
]


@pytest.mark.parametrize("value", VALUES)
@pytest.mark.parametrize("ensure_ascii", [False, True])
def test_prefix_at_every_boundary(value, ensure_ascii):
    """Fed one character at a time, the parser must only ever return a valid
    prefix of the final value, and must never go backwards."""
    doc = json.dumps(
        {"text": value, "quick_replies": ["x"], "suggest_tasks": False},
        ensure_ascii=ensure_ascii,
    )
    previous = ""
    for n in range(len(doc) + 1):
        got = _partial_json_string(doc[:n], "text")
        assert value.startswith(got), f"not a prefix at {n}: {got!r}"
        assert len(got) >= len(previous), f"regressed at {n}"
        previous = got
    assert _partial_json_string(doc, "text") == value


def test_returns_empty_until_value_starts():
    assert _partial_json_string('{"other": 1}', "text") == ""
    assert _partial_json_string('{"text"', "text") == ""
    assert _partial_json_string('{"text":', "text") == ""
    assert _partial_json_string('{"text": ', "text") == ""


def test_stops_at_closing_quote():
    doc = '{"text": "done", "suggest_tasks": true}'
    assert _partial_json_string(doc, "text") == "done"


def test_ignores_later_keys():
    doc = '{"text": "hi", "quick_replies": ["not text"]}'
    assert _partial_json_string(doc, "text") == "hi"
