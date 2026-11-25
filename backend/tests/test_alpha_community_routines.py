import json
from datetime import datetime, timedelta, timezone

import pytest

from backend import alpha_community_routines as routines
from backend.alpha_community_seed import load_personas


PARENT = {"slug": "fictional-parent", "timeZone": "America/Chicago", "activity": "high"}


def block(days, start, end, kind, description, **extra):
    return {"days": days, "start": start, "end": end, "kind": kind, "scene": description, **extra}


def fixture(tmp_path, monkeypatch, *, wake="06:30", sleep="22:30", blocks=()):
    path = tmp_path / "routines.json"
    path.write_text(json.dumps({PARENT["slug"]: {
        "story": "A fictional caregiver sharing school pickups with a partner.",
        "wake": wake, "sleep": sleep, "blocks": list(blocks),
        "moments": ["packing two different lunches", "getting the rain boots back"],
    }}), encoding="utf-8")
    monkeypatch.setattr(routines, "ROUTINES_PATH", path)
    return routines.load_routines()[PARENT["slug"]]


def at(value):
    return datetime.fromisoformat(value)


def test_packaged_routines_cover_all_50_personas():
    packed = routines.load_routines()
    assert set(packed) == {persona["slug"] for persona in load_personas()}
    assert len({routine.story for routine in packed.values()}) == 50


def test_sleep_work_care_and_outing_block_actions_with_a_short_work_break(tmp_path, monkeypatch):
    routine = fixture(tmp_path, monkeypatch, blocks=[
        block([0], "08:00", "16:00", "work", "opening the library and shelving returns"),
        block([0], "12:10", "12:40", "rest", "finishing lunch in the staff room"),
        block([0], "16:30", "17:00", "outing", "walking to the after-school program"),
        block([0], "16:45", "19:00", "care", "getting homework and dinner started"),
        block([0], "17:00", "17:20", "rest", "a rest that conflicts with childcare"),
    ])

    for time in ("06:29", "08:00", "12:09", "12:40", "16:30", "17:10", "22:30"):
        now = at(f"2026-11-23T{time}:00-06:00")
        scene = routines.current_scene(PARENT, routine, now)
        assert scene is None
        assert all(not routines.participates("parent", PARENT, scene, now, action=action)
                   for action in ("browse", "questions", "replies", "follow_ups"))

    awake = routines.current_scene(PARENT, routine, at("2026-11-23T06:30:00-06:00"))
    assert awake.kind == "free"
    lunch = routines.current_scene(PARENT, routine, at("2026-11-23T12:10:00-06:00"))
    assert (lunch.kind, lunch.description, lunch.weekday, lunch.first_minute, lunch.end_minute) == (
        "rest", "finishing lunch in the staff room", "Monday", 10, 40,
    )
    after_work = routines.current_scene(PARENT, routine, at("2026-11-23T16:05:00-06:00"))
    assert (after_work.kind, after_work.description) == (
        "transition", "Earlier activity, now finished — opening the library and shelving returns",
    )
    assert awake.moment == lunch.moment == after_work.moment
    assert routines.current_scene(PARENT, routine, at("2026-11-24T08:00:00-06:00")).kind == "free"


def test_rest_never_overrides_sleep_or_a_large_work_overlap(tmp_path, monkeypatch):
    routine = fixture(tmp_path, monkeypatch, blocks=[
        block([0], "09:00", "17:00", "work", "working in the studio"),
        block([0], "13:00", "14:30", "rest", "afternoon break"),
        block([0], "22:00", "23:00", "rest", "reading on the sofa"),
    ])

    assert routines.current_scene(PARENT, routine, at("2026-11-23T13:40:00-06:00")) is None
    assert routines.current_scene(PARENT, routine, at("2026-11-23T22:35:00-06:00")) is None
    assert routines.current_scene(PARENT, routine, at("2026-11-23T22:10:00-06:00")).kind == "rest"


def test_overnight_shift_uses_starting_day_and_week_and_supports_daytime_sleep(tmp_path, monkeypatch):
    routine = fixture(tmp_path, monkeypatch, wake="17:00", sleep="08:00", blocks=[
        block([6], "22:00", "06:00", "work", "monitoring the overnight dispatch desk", week="even"),
        block([0], "01:20", "01:40", "rest", "the covered break at the overnight desk"),
    ])

    assert routines.current_scene(PARENT, routine, at("2026-11-29T21:59:00-06:00")).kind == "free"
    assert routines.current_scene(PARENT, routine, at("2026-11-29T22:00:00-06:00")) is None
    assert routines.current_scene(PARENT, routine, at("2026-11-30T01:00:00-06:00")) is None
    assert routines.current_scene(PARENT, routine, at("2026-11-30T01:25:00-06:00")).kind == "rest"
    scene = routines.current_scene(PARENT, routine, at("2026-11-30T06:00:00-06:00"))
    assert (scene.kind, scene.local_date, scene.weekday, scene.end_minute) == ("transition", "2026-11-30", "Monday", 50)
    assert routines.current_scene(PARENT, routine, at("2026-11-30T08:00:00-06:00")) is None
    assert routines.current_scene(PARENT, routine, at("2026-12-07T01:00:00-06:00")).kind == "free"


def test_fortnightly_shift_keeps_alternating_across_the_year_boundary(tmp_path, monkeypatch):
    routine = fixture(tmp_path, monkeypatch, blocks=[
        block([0], "08:00", "16:00", "work", "working the alternating Monday shift", week="odd"),
    ])

    assert routines.current_scene(PARENT, routine, at("2026-12-28T12:00:00-06:00")) is None
    assert routines.current_scene(PARENT, routine, at("2027-01-04T12:00:00-06:00")).kind == "free"
    assert routines.current_scene(PARENT, routine, at("2027-01-11T12:00:00-06:00")) is None


def test_clock_fold_has_only_one_visit_and_makes_local_calendar_explicit(tmp_path, monkeypatch):
    parent = {**PARENT, "timeZone": "America/New_York"}
    routine = fixture(tmp_path, monkeypatch, wake="18:00", sleep="08:00", blocks=[
        block([6], "01:00", "02:00", "rest", "late-night downtime"),
    ])
    first = at("2026-11-01T05:20:00+00:00")
    repeat = at("2026-11-01T06:20:00+00:00")
    scene = routines.current_scene(parent, routine, first)
    assert scene == routines.current_scene(parent, routine, repeat)
    assert (scene.kind, scene.weekday, scene.local_hour) == ("rest", "Sunday", 1)
    candidate_ids = [f"fictional-{index}" for index in range(100)]
    assert any(routines.participates(uid, parent, scene, first, action="browse") for uid in candidate_ids)
    assert not any(routines.participates(uid, parent, scene, repeat, action="browse") for uid in candidate_ids)


def test_spring_clock_change_keeps_the_local_shift_end(tmp_path, monkeypatch):
    parent = {**PARENT, "timeZone": "America/New_York"}
    routine = fixture(tmp_path, monkeypatch, wake="18:00", sleep="08:00", blocks=[
        block([5], "22:00", "03:20", "work", "covering the Saturday night rotation"),
    ])

    assert routines.current_scene(parent, routine, at("2026-03-08T06:59:00+00:00")) is None
    assert routines.current_scene(parent, routine, at("2026-03-08T07:00:00+00:00")) is None
    scene = routines.current_scene(parent, routine, at("2026-03-08T07:20:00+00:00"))
    assert (scene.kind, scene.local_hour, scene.first_minute) == ("transition", 3, 20)


def test_participation_is_stable_varied_and_sometimes_browsing_only(tmp_path, monkeypatch):
    routine = fixture(tmp_path, monkeypatch, blocks=[
        block(list(range(7)), "12:00", "13:00", "rest", "the ordinary lunch hour"),
    ])
    start = datetime(2026, 11, 23, tzinfo=timezone.utc)
    visits = {"first": set(), "second": set()}
    replies, questions, observed_days = set(), set(), set()
    for index in range(35 * 144):
        now = start + timedelta(minutes=10 * index)
        scene = routines.current_scene(PARENT, routine, now)
        if scene is None:
            continue
        observed_days.add(scene.local_date)
        for uid, times in visits.items():
            browse = routines.participates(uid, PARENT, scene, now, action="browse")
            assert routines.participates(uid, PARENT, scene, now, action="browse") == browse
            if browse:
                times.add((scene.local_date, scene.local_hour, now.minute))
        if routines.participates("first", PARENT, scene, now, action="replies"):
            replies.add(scene.local_date)
        if routines.participates("first", PARENT, scene, now, action="questions"):
            questions.add(scene.local_date)

    assert visits["first"] and visits["second"] and visits["first"] != visits["second"]
    assert len({hour for _, hour, _ in visits["first"]}) >= 5
    assert len({minute for _, _, minute in visits["first"]}) >= 3
    visited_days = {day for day, _, _ in visits["first"]}
    assert 0 < len(questions) < len(replies) < len(visited_days) < len(observed_days)
    assert visited_days - (replies | questions)


def test_rejects_bad_data_and_naive_clock(tmp_path, monkeypatch):
    routine = fixture(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match="timezone-aware"):
        routines.current_scene(PARENT, routine, datetime(2026, 11, 23, 12))
    with pytest.raises(ValueError, match=PARENT["slug"]):
        fixture(tmp_path, monkeypatch, blocks=[block([7], "12:00", "12:30", "rest", "impossible weekday")])
