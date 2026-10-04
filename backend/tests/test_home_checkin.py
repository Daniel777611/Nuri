"""NURI之家 check-in: when a conversation is over, and what reaches the card."""

from datetime import datetime, timedelta, timezone

from backend.feed import checkin as c

NOW = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)


def _msg(i, role, text, minutes_ago, **extra):
    return {"id": str(i), "role": role, "text": text,
            "created_at": (NOW - timedelta(minutes=minutes_ago)).isoformat(), **extra}


def test_card_markers_and_empty_rows_are_not_the_conversation():
    rows = [
        _msg(3, "ai", "", 1),
        _msg(2, "ai", "看看这篇", 2, transition={"kind": "card_opened"}),
        _msg(1, "user", "宝宝不睡午觉", 3),
    ]
    assert [m["id"] for m in c.conversation_messages(rows)] == ["1"]


def test_a_conversation_is_over_once_the_parent_has_stopped_for_a_while():
    talking = [_msg(1, "user", "午睡哭", c.IDLE_CLOSE_S / 60 - 1)]
    stopped = [_msg(1, "user", "午睡哭", c.IDLE_CLOSE_S / 60 + 1), _msg(2, "ai", "试试…", 0)]
    assert not c.is_over(talking, NOW)
    # NURI speaking afterwards (a notification, a check-in) does not reopen it.
    assert c.is_over(stopped, NOW)


def test_the_transcript_marks_where_one_sitting_ended():
    text = c.transcript([_msg(1, "user", "a", 600), _msg(2, "user", "b", 1)])
    assert "隔了一段时间" in text


def test_english_is_cut_at_a_word():
    cut = c._clip("Has the tiny veggie portion beside the pasta changed anything lately", 40)
    assert cut.endswith("…") and not cut[:-1].endswith(("portio", "besid"))


def test_no_real_subject_means_no_line(monkeypatch):
    monkeypatch.setattr(c, "_model_json", lambda _m: {"has_topic": False, "topic": "", "summary": "",
                                                      "feeling": "", "line": ""})
    assert c.write_checkin([_msg(1, "user", "繁中", 30)], now=NOW) is None


def test_a_line_is_kept_with_its_topic(monkeypatch):
    seen = {}

    def fake(messages):
        seen["system"] = messages[0]["content"]
        return {"has_topic": True, "topic": "躺地哭闹", "summary": "s", "feeling": "崩溃",
                "line": "你那几天真的很累，提前预告后来试了吗？"}

    monkeypatch.setattr(c, "_model_json", fake)
    out = c.write_checkin([_msg(1, "user", "宝宝躺地上哭", 20 * 60)], now=NOW)
    assert out == {"topic": "躺地哭闹", "summary": "s", "line": "你那几天真的很累，提前预告后来试了吗？"}
    # Twenty hours on, "今晚" from back then must not read as tonight.
    assert "20 小时" in seen["system"]


def test_the_check_in_id_follows_the_last_parent_message():
    assert c.checkin_id("u", "m1") == c.checkin_id("u", "m1") != c.checkin_id("u", "m2")
