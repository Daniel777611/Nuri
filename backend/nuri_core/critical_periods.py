"""Critical periods: what a child of this age is likely going through, and
which of it the parent has confirmed.

A period has a window in **weeks of age** and the behavior tags
(memory_taxonomy.BEHAVIOR_TAGS) that confirm it. Age alone makes a period
*possible*; a live tag the parent told NURI about makes it *active*. Both are
rules, not model calls, so the calendar, the push ranking and the admin page
all give the same answer for the same family.

Time does the clean-up. A tag counts while the observation is recent
(BehaviorTag.ttl_weeks) and while at least one period it confirms is still
open (plus ``GRACE_WEEKS``). After that it is *released*: still in the
parent's memories, no longer steering pushes. "扶着沙发走" at 11 months stops
pushing walking posts at 20 months without anyone deleting it.

Windows follow the CDC milestone checklists (2022) and the WHO motor-milestone
windows, written wide on purpose. The wording on the calendar says "常见于",
never "关键期快过了": no period is a deadline, and the absence of a behavior
is not read as a delay here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Optional, Sequence

from backend.nuri_core import memory_taxonomy as tx
from backend.nuri_core.family_store import child_name_mentioned

#: A tag stays live this long after the last period it confirms has closed.
GRACE_WEEKS = 4
#: The calendar shows a period as "coming up" this many weeks before it opens.
UPCOMING_WEEKS = 2


@dataclass(frozen=True)
class Period:
    id: str
    label_zh: str
    label_en: str
    weeks: tuple[int, int]              # [start, end) weeks of age
    need: str                           # family_queries.NEEDS id the push searches for
    tags: tuple[str, ...] = ()          # behavior tags that confirm it
    about_zh: str = ""
    about_en: str = ""


PERIODS: tuple[Period, ...] = (
    Period("crying_peak", "哭闹高峰", "Crying peak", (2, 14), "newborn_soothing", (),
           "很多宝宝在 6 周前后哭得最多，3 个月左右慢慢缓下来。", "Many babies cry most around 6 weeks; it eases by about 3 months."),
    Period("head_control", "抬头与趴趴", "Head control", (4, 20), "tummy_time", ("holds_head",),
           "趴着时能把头抬起来，是之后翻身、坐和爬的基础。", "Lifting the head on the tummy is the start of rolling, sitting and crawling."),
    Period("sleep_shift_4m", "4 个月睡眠变化", "4-month sleep shift", (14, 24), "sleep", ("night_waking",),
           "睡眠结构变得更像大人，夜醒一时变多很常见。", "Sleep matures and night waking often rises for a while."),
    Period("rolling", "翻身", "Rolling", (14, 30), "tummy_time", ("rolls",),
           "从侧翻到会两个方向翻，床边和尿布台要多留心。", "From side to both ways; watch beds and changing tables."),
    Period("solids_ready", "准备添加辅食", "Ready for solids", (17, 30), "solids", ("food_interest", "on_solids", "sits"),
           "多数宝宝在 6 个月左右开始辅食，看的是能坐稳、对食物感兴趣。", "Most start solids around 6 months: sitting steady and interested in food."),
    Period("teething", "长牙", "Teething", (20, 60), "teething", ("teething",),
           "第一颗牙多在 6–10 个月出来，流口水、爱咬东西是常见信号。", "First teeth usually come at 6–10 months; drooling and chewing are common signs."),
    Period("sitting", "独坐", "Sitting up", (22, 40), "play", ("sits",),
           "能自己坐稳后，双手空出来，玩法会一下子变多。", "Once sitting steady, both hands are free and play opens up."),
    Period("babbling", "咿呀学语", "Babbling", (24, 52), "first_words", ("babbles",),
           "ba-ba、ma-ma 这样的重复音节，是说话前的练习。", "Repeated syllables like ba-ba are practice for talking."),
    Period("crawling", "爬行与探索", "Crawling & exploring", (26, 56), "babyproofing", ("crawls", "pulls_to_stand"),
           "会移动之后什么都想摸、想放进嘴里，家里的安全布置要跟上。", "Once moving, everything gets touched and mouthed; babyproofing has to keep up."),
    Period("separation", "认生与分离焦虑", "Stranger & separation anxiety", (30, 80), "separation", ("stranger_anxiety", "clingy"),
           "知道大人离开了却还不明白会回来，分开时哭是这个阶段的正常反应。", "Knowing you left but not yet that you return; crying at goodbyes is normal now."),
    Period("cruising_walking", "扶站到独立行走", "Standing to walking", (34, 78), "walking", ("pulls_to_stand", "cruises", "walks"),
           "从扶着站、扶着走到自己走，早晚相差好几个月都正常。", "From pulling up to cruising to walking; months apart either way is normal."),
    Period("first_words", "第一个词与手势", "First words & gestures", (40, 78), "first_words", ("first_words", "points"),
           "用手指东西、挥手，和第一个有意义的词，常在一岁前后出现。", "Pointing, waving and a first real word often come around the first birthday."),
    Period("night_weaning", "夜奶减少", "Fewer night feeds", (40, 78), "weaning", ("night_feeds",),
           "很多家庭在这时开始减少或停掉夜奶，节奏因家而异。", "Many families cut back night feeds now, each at its own pace."),
    Period("nap_change", "两觉并一觉", "Two naps to one", (56, 90), "sleep", ("nap_change",),
           "白天从两觉慢慢并成一觉，过渡期作息会乱一阵。", "Two naps merge into one; routines wobble during the switch."),
    Period("picky_eating", "挑食期", "Picky eating", (60, 200), "picky_eating", ("picky",),
           "长得没那么快了，胃口和偏好变化大，挑食很常见。", "Growth slows, appetite swings, and pickiness is common."),
    Period("language_burst", "语言爆发", "Word burst", (70, 130), "first_words", ("word_burst", "two_words", "late_talk"),
           "词汇量常在一岁半到两岁半之间快速增加，开始说两个词的短句。", "Vocabulary often takes off between 18 and 30 months, with two-word phrases."),
    Period("autonomy", "自我意识与发脾气", "Autonomy & tantrums", (70, 156), "tantrums", ("says_no", "tantrums", "hits_bites"),
           "想自己做主却还表达不清，说「不」和发脾气是这个阶段的常态。", "Wanting control without the words for it; 'no' and tantrums are typical."),
    Period("potty_ready", "如厕准备", "Potty readiness", (78, 156), "potty", ("potty_signs",),
           "能保持尿布干一段时间、会表示尿了，是可以开始的信号。", "Staying dry for a while and telling you when wet are signs it can start."),
    Period("pretend_play", "假装游戏", "Pretend play", (90, 156), "play", (),
           "喂娃娃吃饭、假装打电话，想象力和社交在这类游戏里长出来。", "Feeding a doll, pretend phone calls: imagination and social skills grow here."),
)
PERIODS_BY_ID = {p.id: p for p in PERIODS}


def age_weeks(birth: date, on: date) -> int:
    return (on - birth).days // 7


def parse_birth(value) -> Optional[date]:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value or "")[:10])
    except ValueError:
        return None


def _parse_ts(value) -> Optional[date]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return parse_birth(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.date()


def open_periods(weeks: int) -> list[Period]:
    return [p for p in PERIODS if p.weeks[0] <= weeks < p.weeks[1]]


@dataclass(frozen=True)
class Observation:
    tag: str
    observed: date
    text: str


def observations(
    rows: Sequence[dict], *, child_id: str = "", nickname: str = "", other_nicknames: Iterable[str] = (),
) -> list[Observation]:
    """Tagged behaviour from the family's memories, for one child.

    A stored child id takes precedence. In a multi-child family, a legacy row
    without an id needs an unambiguous name to confirm a child's behavior."""
    others = tuple(other_nicknames)
    out = []
    for row, c in tx.tagged_rows(rows):
        value = str(row.get("value") or "")
        bound_id = str(row.get("child_id") or "")
        if bound_id and bound_id != child_id:
            continue
        if not bound_id and others and (
            not child_name_mentioned(value, nickname) or any(child_name_mentioned(value, n) for n in others)
        ):
            continue
        observed = _parse_ts(row.get("last_confirmed_at") or row.get("updated_at") or row.get("created_at"))
        if observed is None:
            continue
        out.extend(Observation(tag, observed, value) for tag in c.tags)
    return out


def tag_is_live(tag: str, observed: date, *, birth: date, on: date) -> bool:
    """Recent enough, and some period it confirms is still open (+ grace)."""
    info = tx.BEHAVIOR_TAGS_BY_ID.get(tag)
    if info is None or observed > on:
        return False
    if (on - observed).days > info.ttl_weeks * 7:
        return False
    weeks = age_weeks(birth, on)
    ends = [p.weeks[1] for p in PERIODS if tag in p.tags]
    return not ends or weeks < max(ends) + GRACE_WEEKS


def live_tags(obs: Sequence[Observation], *, birth: date, on: date) -> dict[str, Observation]:
    """Newest live observation per tag."""
    out: dict[str, Observation] = {}
    for o in sorted(obs, key=lambda o: o.observed, reverse=True):
        if o.tag not in out and tag_is_live(o.tag, o.observed, birth=birth, on=on):
            out[o.tag] = o
    return out


@dataclass(frozen=True)
class PeriodState:
    period: Period
    status: str                 # "upcoming" | "possible" | "active" | "closing"
    confirmed_by: tuple[str, ...] = ()


def states_on(birth: date, on: date, live: dict[str, Observation]) -> list[PeriodState]:
    """Every period that is open (or about to open) on this date."""
    weeks = age_weeks(birth, on)
    out = []
    for p in PERIODS:
        start, end = p.weeks
        if start - UPCOMING_WEEKS <= weeks < start:
            out.append(PeriodState(p, "upcoming"))
        elif start <= weeks < end:
            confirmed = tuple(t for t in p.tags if t in live)
            status = "active" if confirmed else ("closing" if weeks >= end - 2 else "possible")
            out.append(PeriodState(p, status, confirmed))
    return out


def push_signals(birth: Optional[date], on: date, rows: Sequence[dict], **who) -> tuple[list[str], list[str]]:
    """(needs with an open period, needs with a confirmed period) for ranking."""
    if birth is None:
        return [], []
    live = live_tags(observations(rows, **who), birth=birth, on=on)
    possible, confirmed = [], []
    for s in states_on(birth, on, live):
        if s.status == "upcoming":
            continue
        (confirmed if s.status == "active" else possible).append(s.period.need)
    return list(dict.fromkeys(possible)), list(dict.fromkeys(confirmed))


def week_start(day: date) -> date:
    """Monday of the week."""
    return day - timedelta(days=day.weekday())


def calendar(
    birth: date, today: date, rows: Sequence[dict], *, weeks: int = 12, past: int = 2,
    locale: str = "zh-CN", **who,
) -> dict:
    """Week-by-week calendar from `past` weeks back to `weeks` ahead.

    A future week shows a period as active only while today's tag would
    still be live then, which is how a tag visibly runs out on the calendar."""
    en = locale == "en"
    obs = observations(rows, **who)
    first = week_start(today) - timedelta(weeks=past)
    out_weeks = []
    for i in range(past + weeks):
        start = first + timedelta(weeks=i)
        mid = start + timedelta(days=3)
        if mid < birth:
            continue
        # A past week shows what was known by then; a future one, today's
        # tags running on until they lapse.
        live = live_tags(obs, birth=birth, on=mid)
        items = []
        for s in states_on(birth, mid, live):
            p = s.period
            items.append({
                "id": p.id,
                "label": p.label_en if en else p.label_zh,
                "about": p.about_en if en else p.about_zh,
                "status": s.status,
                "starts_this_week": age_weeks(birth, mid) == p.weeks[0],
                "confirmed_by": [
                    {"tag": t, "label": tx.BEHAVIOR_TAGS_BY_ID[t].label_en if en else tx.BEHAVIOR_TAGS_BY_ID[t].label_zh,
                     "said": live[t].text[:60], "observed": live[t].observed.isoformat()}
                    for t in s.confirmed_by
                ],
                "need": p.need,
            })
        weeks_old = age_weeks(birth, mid)
        out_weeks.append({
            "start": start.isoformat(),
            "end": (start + timedelta(days=6)).isoformat(),
            "is_current": start == week_start(today),
            "age_weeks": weeks_old,
            "age_months": round(weeks_old * 7 / 30.44, 1),
            "periods": items,
        })
    released = sorted({o.tag for o in obs} - set(live_tags(obs, birth=birth, on=today)))
    return {
        "weeks": out_weeks,
        "released_tags": [
            {"tag": t, "label": tx.BEHAVIOR_TAGS_BY_ID[t].label_en if en else tx.BEHAVIOR_TAGS_BY_ID[t].label_zh}
            for t in released
        ],
    }
