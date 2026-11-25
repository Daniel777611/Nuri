"""Local, deterministic availability for fictional Alpha Community parents."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

ROUTINES_PATH = Path(__file__).resolve().parents[1] / "scripts/fixtures/alpha-community-routines.json"

_BLOCK_KINDS = {"work", "care", "outing", "rest"}
_MAX_WORK_BREAK = timedelta(hours=1)
_AFTER_BLOCK = timedelta(minutes=50)
_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
# ISO week 2 in the anchor year. Count actual weeks so week 53 and the
# following week 1 do not put a fortnightly shift on two weeks in a row.
_EVEN_WEEK_MONDAY = date(2026, 1, 5)

_QUIET_DAY = {"high": 0.10, "medium": 0.16, "low": 0.24}
_BROWSE_ONLY_DAY = {"high": 0.17, "medium": 0.23, "low": 0.30}
_CHECK_CHANCE = {
    "rest": {"high": 0.73, "medium": 0.59, "low": 0.44},
    "transition": {"high": 0.61, "medium": 0.48, "low": 0.34},
    "free": {"high": 0.34, "medium": 0.25, "low": 0.14},
}
_ACTION_CHANCE = {
    "questions": {"high": 0.21, "medium": 0.16, "low": 0.10},
    "replies": {"high": 0.72, "medium": 0.61, "low": 0.48},
    "follow_ups": {"high": 0.58, "medium": 0.47, "low": 0.34},
}


@dataclass(frozen=True)
class Block:
    days: frozenset[int]
    start: time
    end: time
    kind: str
    scene: str
    week: str | None


@dataclass(frozen=True)
class Routine:
    story: str
    wake: time
    sleep: time
    blocks: tuple[Block, ...]
    moments: tuple[str, ...]


@dataclass(frozen=True)
class Scene:
    story: str
    description: str
    kind: str
    local_date: str
    weekday: str
    local_hour: int
    window_key: str
    moment: str
    first_minute: int
    end_minute: int


@dataclass(frozen=True)
class _Interval:
    block: Block
    start: datetime
    end: datetime
    index: int


def _clock(value: object) -> time:
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", value):
        raise ValueError("Expected a local HH:MM time")
    return time.fromisoformat(value)


def _text(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Expected nonempty fictional routine text")
    return value.strip()


def _block(data: dict) -> Block:
    days = data["days"]
    if not isinstance(days, list) or not days or any(type(day) is not int or not 0 <= day <= 6 for day in days):
        raise ValueError("Expected weekdays numbered Monday (0) through Sunday (6)")
    start, end = _clock(data["start"]), _clock(data["end"])
    kind, week = data["kind"], data.get("week")
    if start == end or kind not in _BLOCK_KINDS or week not in {None, "odd", "even"}:
        raise ValueError("Invalid fictional routine block")
    return Block(frozenset(days), start, end, kind, _text(data["scene"]), week)


def _routine(data: dict) -> Routine:
    wake, sleep = _clock(data["wake"]), _clock(data["sleep"])
    blocks, moments = data["blocks"], data["moments"]
    if wake == sleep or not isinstance(blocks, list) or not isinstance(moments, list) or not moments:
        raise ValueError("Invalid fictional routine")
    return Routine(_text(data["story"]), wake, sleep, tuple(_block(block) for block in blocks),
                   tuple(_text(moment) for moment in moments))


def load_routines() -> dict[str, Routine]:
    return dict(_load_routines(ROUTINES_PATH, ROUTINES_PATH.stat().st_mtime_ns))


@lru_cache(maxsize=4)
def _load_routines(path: Path, _modified_ns: int) -> dict[str, Routine]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rows, dict) or not rows:
        raise ValueError("The fictional routines fixture is empty or invalid")
    routines = {}
    for slug, row in rows.items():
        try:
            routines[slug] = _routine(row)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"Invalid fictional routine for {slug}") from exc
    return routines


def _local_time(persona: dict, now: datetime) -> datetime:
    if now.utcoffset() is None:
        raise ValueError("Availability needs a timezone-aware datetime")
    return now.astimezone(ZoneInfo(persona["timeZone"]))


def _awake(routine: Routine, local: time) -> bool:
    if routine.wake < routine.sleep:
        return routine.wake <= local < routine.sleep
    return local >= routine.wake or local < routine.sleep


def _intervals(routine: Routine, today: date):
    for anchor in (today - timedelta(days=1), today):
        week = "odd" if ((anchor - _EVEN_WEEK_MONDAY).days // 7) % 2 else "even"
        for index, block in enumerate(routine.blocks):
            if anchor.weekday() not in block.days or (block.week and block.week != week):
                continue
            end_day = anchor + timedelta(days=1) if block.end < block.start else anchor
            yield _Interval(block, datetime.combine(anchor, block.start), datetime.combine(end_day, block.end), index)


def _short_break(rest: _Interval, work: list[_Interval]) -> bool:
    return all(min(rest.end, shift.end) - max(rest.start, shift.start) <= _MAX_WORK_BREAK for shift in work)


def _sample(*parts: str) -> float:
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 2**32


def current_scene(persona: dict, routine: Routine | None, now: datetime) -> Scene | None:
    if routine is None:
        return None
    local = _local_time(persona, now)
    # Compare calendar wall times. Overnight shifts belong to the date and
    # week they begin; DST changes do not move the scheduled clock boundaries.
    wall = local.replace(tzinfo=None)
    if not _awake(routine, wall.time()):
        return None

    intervals = tuple(_intervals(routine, wall.date()))
    active = [interval for interval in intervals if interval.start <= wall < interval.end]
    if any(interval.block.kind in {"care", "outing"} for interval in active):
        return None
    work = [interval for interval in active if interval.block.kind == "work"]
    rest = next((interval for interval in reversed(active)
                 if interval.block.kind == "rest" and _short_break(interval, work)), None)
    if work and rest is None:
        return None

    recent = None if rest else max(
        (interval for interval in intervals if interval.end <= wall < interval.end + _AFTER_BLOCK),
        default=None, key=lambda interval: interval.end,
    )
    hour_start = wall.replace(minute=0, second=0, microsecond=0)
    hour_end = hour_start + timedelta(hours=1)
    day = wall.date().isoformat()
    if rest:
        kind, description = "rest", rest.block.scene
        start, end = rest.start, rest.end
        key = f"rest:{rest.start.isoformat()}:{rest.index}"
    elif recent:
        kind = "transition"
        description = f"Earlier activity, now finished — {recent.block.scene}"
        start, end = recent.end, recent.end + _AFTER_BLOCK
        key = f"after:{recent.start.isoformat()}:{recent.index}"
    else:
        kind, description = "free", "A little unstructured time between parts of the day."
        start, end = hour_start, hour_end
        key = f"free:{wall.hour // 3}"
    moment_index = int(_sample("moment", persona.get("slug", ""), day) * len(routine.moments))
    first_minute = int((max(start, hour_start) - hour_start).total_seconds() // 60)
    end_minute = int((min(end, hour_end) - hour_start).total_seconds() // 60)
    return Scene(routine.story, description, kind, day, _WEEKDAYS[wall.weekday()], wall.hour,
                 key, routine.moments[moment_index], first_minute, end_minute)


def participates(uid: str, persona: dict, scene: Scene | None, now: datetime, *, action: str) -> bool:
    """Check for a brief visit or action within the current available scene."""
    if scene is None:
        return False
    local = _local_time(persona, now)
    # Fall-back clock hours repeat. One simulated visit per clock hour is enough.
    if local.fold or local.date().isoformat() != scene.local_date or local.hour != scene.local_hour:
        return False
    activity = persona.get("activity", "low")
    seed = (uid, scene.local_date)
    day_mode = _sample("day-mode", *seed)
    if day_mode < _QUIET_DAY[activity]:
        return False
    if action != "browse" and day_mode < _QUIET_DAY[activity] + _BROWSE_ONLY_DAY[activity]:
        return False

    slot = (*seed, scene.window_key, str(scene.local_hour))
    if _sample("visit", *slot) >= _CHECK_CHANCE[scene.kind][activity]:
        return False
    span = scene.end_minute - scene.first_minute
    if span <= 0:
        return False
    visit_length = min(span, 14 + int(_sample("visit-length", *slot) * 13))
    visit_start = scene.first_minute + int(_sample("visit-start", *slot) * (span - visit_length + 1))
    if not visit_start <= local.minute < visit_start + visit_length:
        return False
    if action == "browse":
        return True
    if _sample("act", action, *slot) >= _ACTION_CHANCE[action][activity]:
        return False
    action_length = min(10, visit_length)
    action_start = visit_start + int(_sample("act-start", action, *slot) * (visit_length - action_length + 1))
    return action_start <= local.minute < action_start + action_length
