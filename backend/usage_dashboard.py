"""The /admin usage dashboard: testers, presence, conversation, and topics.

Four sources, joined in Python rather than in SQL views so there is nothing
extra to keep migrated:

* `users` — who exists, when they joined, and whether they count as a tester
  (`is_internal` false, email verified).
* `chat_messages` (role = user) through `chat_sessions` — whether and how much
  a parent talked each day. Only timestamps are read, never text.
* `user_visits` — presence: one row per visit, extended by the app's heartbeat.
  Only exists from the day it shipped.
* `chat_turn_logs.route_topic` — the router's short topic label per turn,
  bucketed here into a handful of categories.

`build_overview` is pure and does all the arithmetic; `fetch_sources` is the
only part that talks to Supabase.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

#: Beats arrive every 60s; a visit survives one lost beat plus some slack.
VISIT_GAP_S = 180
MAX_DAYS = 90
PAGE_SIZE = 1000
#: Upper bound on rows read per source, so a window can't turn one admin page
#: load into an unbounded scan. Hitting it is reported as `truncated`.
ROW_CAP = 50_000

# ── Accounts ─────────────────────────────────────────────────────────────────

_PLACEHOLDER = re.compile(
    r"(@example\.(com|org|net)$|@x\.com$|^automated_test_|^test_)", re.IGNORECASE,
)


def looks_internal(email: str) -> bool:
    """The same rule the migration backfilled with, for a database that
    hasn't run it yet."""
    return bool(_PLACEHOLDER.search(email or ""))


def is_internal(user: dict) -> bool:
    if "is_internal" in user and user["is_internal"] is not None:
        return bool(user["is_internal"])
    return looks_internal(str(user.get("email") or ""))


def is_verified(user: dict) -> bool:
    # A database without the verification column predates the requirement:
    # everyone there was able to use the app.
    return "email_verified_at" not in user or bool(user.get("email_verified_at"))


# ── Topics ───────────────────────────────────────────────────────────────────
# First match wins, so the more specific buckets come first: "夜奶" is a sleep
# question before it is a feeding one, "发烧不吃" is health before food. This is
# a keyword heuristic over a 40-character label — good for proportions, not
# for auditing a single turn.

TOPIC_CATEGORIES: list[tuple[str, str, tuple[str, ...]]] = [
    ("health", "健康就医", (
        "发烧", "发热", "咳", "感冒", "生病", "疫苗", "湿疹", "过敏", "便秘", "腹泻",
        "拉肚子", "呕吐", "吐奶", "用药", "药", "医院", "医生", "疹", "黄疸", "牙",
        "受伤", "摔", "体温", "长牙", "鼻塞", "流鼻涕", "中耳炎", "结膜炎",
    )),
    # Before the child-facing buckets: "产后情绪" is about the parent, not a
    # tantrum. Only phrases that can't describe the child.
    ("parent", "家长自身", (
        "产后", "妈妈自己", "爸爸自己", "家长自己", "我自己", "育儿压力", "疲惫",
        "崩溃", "内疚", "返岗", "自我照顾",
    )),
    ("sleep", "睡眠作息", (
        "睡", "夜醒", "夜奶", "哄睡", "入睡", "午觉", "作息", "早醒", "安抚奶嘴",
    )),
    ("food", "喂养饮食", (
        "吃", "奶", "辅食", "喂", "饮食", "挑食", "进食", "营养", "断奶", "母乳",
        "零食", "餐", "饭", "喝水", "食",
    )),
    ("emotion", "情绪行为", (
        "情绪", "哭", "脾气", "发火", "行为", "打人", "咬人", "焦虑", "害怕", "安抚",
        "管教", "规则", "屏幕", "手机", "电视", "黏人", "分离", "闹", "叛逆", "说谎",
    )),
    ("development", "成长发育", (
        "发育", "语言", "说话", "开口", "运动", "爬", "走路", "学步", "站", "精细", "认知",
        "身高", "体重", "里程碑", "如厕", "尿布", "自理", "专注",
    )),
    ("learning", "早教学习", (
        "学", "阅读", "绘本", "双语", "英语", "中文", "学校", "幼儿园", "早教",
        "游戏", "玩具", "玩", "兴趣", "数学", "托育", "daycare",
    )),
    ("family", "家庭关系", (
        "家庭", "伴侣", "老公", "丈夫", "爸爸", "老人", "婆婆", "奶奶", "外婆",
        "夫妻", "二胎", "兄弟", "姐妹", "同伴", "社交", "朋友",
    )),
]
OTHER_KEY, OTHER_LABEL = "other", "其他"
CATEGORY_LABELS = {key: label for key, label, _ in TOPIC_CATEGORIES} | {OTHER_KEY: OTHER_LABEL}


def categorize_topic(topic: str) -> str:
    text = (topic or "").lower()
    for key, _label, words in TOPIC_CATEGORIES:
        if any(word in text for word in words):
            return key
    return OTHER_KEY


# ── Time ─────────────────────────────────────────────────────────────────────

def parse_ts(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def window_days(days: int, tz: ZoneInfo, now: datetime) -> list[date]:
    """The last `days` calendar days in `tz`, oldest first, today included."""
    today = now.astimezone(tz).date()
    return [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]


def window_start_utc(first_day: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(first_day, datetime.min.time(), tzinfo=tz).astimezone(timezone.utc)


# ── Aggregation ──────────────────────────────────────────────────────────────

@dataclass
class _Cell:
    turns: int = 0
    online_seconds: int = 0
    visits: int = 0
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None

    def touch(self, moment: datetime) -> None:
        if self.first_seen is None or moment < self.first_seen:
            self.first_seen = moment
        if self.last_seen is None or moment > self.last_seen:
            self.last_seen = moment

    def as_dict(self, tz: ZoneInfo) -> dict:
        def clock(moment: Optional[datetime]) -> Optional[str]:
            return moment.astimezone(tz).strftime("%H:%M") if moment else None

        return {
            "turns": self.turns,
            "online_seconds": self.online_seconds,
            "visits": self.visits,
            "first_seen": clock(self.first_seen),
            "last_seen": clock(self.last_seen),
        }


@dataclass
class Sources:
    users: list[dict]
    sessions: list[dict]
    user_messages: list[dict]
    visits: list[dict]
    turn_topics: list[dict]
    visits_available: bool = True
    #: started_at of the earliest visit ever recorded, window or not.
    tracking_since: Optional[str] = None
    truncated: list[str] = field(default_factory=list)


def build_overview(
    src: Sources, *, days: int, tz: ZoneInfo, now: datetime, include_internal: bool = False,
) -> dict:
    day_list = window_days(days, tz, now)
    day_keys = [d.isoformat() for d in day_list]
    in_window = set(day_keys)
    today_key = day_keys[-1]
    since = window_start_utc(day_list[0], tz)

    def day_of(moment: datetime) -> str:
        return moment.astimezone(tz).date().isoformat()

    counted = {
        u["id"]: u for u in src.users
        if (include_internal or not is_internal(u)) and is_verified(u)
    }
    owner_of_session = {s["id"]: s.get("user_id") for s in src.sessions}

    cells: dict[str, dict[str, _Cell]] = defaultdict(lambda: defaultdict(_Cell))
    hours_turns = [0] * 24
    hours_visits = [0] * 24

    for message in src.user_messages:
        uid = owner_of_session.get(message.get("session_id"))
        moment = parse_ts(message.get("created_at"))
        if uid not in counted or not moment or moment < since:
            continue
        key = day_of(moment)
        if key not in in_window:
            continue
        cell = cells[uid][key]
        cell.turns += 1
        cell.touch(moment)
        hours_turns[moment.astimezone(tz).hour] += 1

    tracking_since = parse_ts(src.tracking_since)
    for visit in src.visits:
        uid = visit.get("user_id")
        started = parse_ts(visit.get("started_at"))
        last = parse_ts(visit.get("last_seen_at")) or started
        if not started:
            continue
        if tracking_since is None or started < tracking_since:
            tracking_since = started
        if uid not in counted or last < since:
            continue
        # A visit belongs to the day it began; one that runs past midnight is
        # rare enough that splitting it would add more confusion than accuracy.
        key = day_of(started)
        if key not in in_window:
            continue
        cell = cells[uid][key]
        cell.visits += 1
        cell.online_seconds += max(0, int((last - started).total_seconds()))
        cell.touch(started)
        cell.touch(last)
        hours_visits[started.astimezone(tz).hour] += 1

    daily = []
    for key in day_keys:
        day_cells = [(uid, by_day[key]) for uid, by_day in cells.items() if key in by_day]
        daily.append({
            "day": key,
            "active_users": sum(1 for _uid, c in day_cells if c.turns or c.visits),
            "chatting_users": sum(1 for _uid, c in day_cells if c.turns),
            "turns": sum(c.turns for _uid, c in day_cells),
            "online_seconds": sum(c.online_seconds for _uid, c in day_cells),
            "visits": sum(c.visits for _uid, c in day_cells),
            "new_users": sum(
                1 for u in counted.values()
                if (joined := parse_ts(u.get("created_at"))) and day_of(joined) == key
            ),
        })

    users_out = []
    for uid, user in counted.items():
        by_day = cells.get(uid, {})
        active_days = [k for k, c in by_day.items() if c.turns or c.visits]
        last_seen = max((c.last_seen for c in by_day.values() if c.last_seen), default=None)
        users_out.append({
            "id": uid,
            "email": user.get("email"),
            "nickname": user.get("nickname") or "",
            "created_at": user.get("created_at"),
            "is_internal": is_internal(user),
            "days_active": len(active_days),
            "days_chatted": sum(1 for c in by_day.values() if c.turns),
            "turns": sum(c.turns for c in by_day.values()),
            "online_seconds": sum(c.online_seconds for c in by_day.values()),
            "visits": sum(c.visits for c in by_day.values()),
            "last_seen_at": last_seen.isoformat() if last_seen else None,
            "by_day": {k: c.as_dict(tz) for k, c in sorted(by_day.items())},
        })
    users_out.sort(key=lambda u: (-u["days_active"], -u["turns"], -u["online_seconds"], u["email"] or ""))

    topic_counts: Counter = Counter()
    category_counts: Counter = Counter()
    unlabelled = 0
    for row in src.turn_topics:
        moment = parse_ts(row.get("created_at"))
        if row.get("user_id") not in counted or not moment or moment < since:
            continue
        if day_of(moment) not in in_window:
            continue
        topic = (row.get("route_topic") or "").strip()
        if not topic:
            unlabelled += 1
            continue
        topic_counts[topic] += 1
        category_counts[categorize_topic(topic)] += 1
    labelled = sum(category_counts.values())
    categories = [
        {
            "key": key,
            "label": CATEGORY_LABELS[key],
            "turns": count,
            "share": round(count / labelled, 4) if labelled else 0.0,
        }
        for key, count in category_counts.most_common()
    ]

    all_testers = [
        u for u in src.users if (include_internal or not is_internal(u))
    ]
    today = daily[-1]
    return {
        "tz": str(tz.key),
        "days": day_keys,
        "generated_at": now.isoformat(),
        "tracking_since": tracking_since.isoformat() if tracking_since else None,
        "visits_available": src.visits_available,
        "truncated": src.truncated,
        "testers": {
            "total": len(counted),
            "unverified": sum(1 for u in all_testers if not is_verified(u)),
            "internal": sum(1 for u in src.users if is_internal(u)),
            "active_today": today["active_users"],
            "chatted_today": today["chatting_users"],
            "active_in_window": sum(1 for u in users_out if u["days_active"]),
            "new_in_window": sum(d["new_users"] for d in daily),
        },
        "daily": daily,
        "hours": {"turns": hours_turns, "visits": hours_visits},
        "users": users_out,
        "topics": {
            "categories": categories,
            "top": [{"topic": t, "turns": n} for t, n in topic_counts.most_common(15)],
            "labelled_turns": labelled,
            "unlabelled_turns": unlabelled,
        },
    }


# ── Reading ──────────────────────────────────────────────────────────────────

def _page_through(build, label: str, truncated: list[str]) -> list[dict]:
    """Every row a query matches, a page at a time. PostgREST caps a single
    response (1000 rows on Supabase) without saying so, which is how a
    `.limit(5000)` quietly becomes 1000."""
    rows: list[dict] = []
    start = 0
    while True:
        chunk = build().range(start, start + PAGE_SIZE - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < PAGE_SIZE:
            return rows
        if len(rows) >= ROW_CAP:
            truncated.append(label)
            return rows
        start += PAGE_SIZE


def _table_missing(exc: Exception) -> bool:
    code = str(getattr(exc, "code", "") or "").upper()
    text = str(exc).lower()
    return (
        code in {"42P01", "PGRST205"}
        or "pgrst205" in text or "42p01" in text
        or "could not find the table" in text
        or ("relation" in text and "does not exist" in text)
    )


def fetch_sources(sb, since: datetime) -> Sources:
    """Read everything the overview needs for activity at or after `since`.

    Synchronous; call it through anyio.to_thread.
    """
    truncated: list[str] = []
    since_iso = since.isoformat()

    try:
        users = _page_through(
            lambda: sb.table("users")
            .select("id,email,nickname,created_at,email_verified_at,is_internal")
            .order("created_at"),
            "users", truncated,
        )
    except Exception:
        # Before the dashboard migration: no is_internal, and possibly no
        # email_verified_at either. The Python fallbacks cover both.
        try:
            users = _page_through(
                lambda: sb.table("users")
                .select("id,email,nickname,created_at,email_verified_at")
                .order("created_at"),
                "users", truncated,
            )
        except Exception:
            users = _page_through(
                lambda: sb.table("users").select("id,email,nickname,created_at").order("created_at"),
                "users", truncated,
            )

    sessions = _page_through(
        lambda: sb.table("chat_sessions").select("id,user_id").order("created_at"),
        "chat_sessions", truncated,
    )
    user_messages = _page_through(
        lambda: sb.table("chat_messages").select("session_id,created_at")
        .eq("role", "user").gte("created_at", since_iso).order("created_at"),
        "chat_messages", truncated,
    )

    visits_available = True
    try:
        visits = _page_through(
            lambda: sb.table("user_visits").select("user_id,started_at,last_seen_at")
            .gte("last_seen_at", since_iso).order("last_seen_at"),
            "user_visits", truncated,
        )
        # The earliest visit ever, so the page can say when presence began.
        first = sb.table("user_visits").select("started_at") \
            .order("started_at").limit(1).execute().data or []
        tracking_since = first[0]["started_at"] if first else None
    except Exception as exc:
        if not _table_missing(exc):
            raise
        visits, visits_available, tracking_since = [], False, None

    try:
        turn_topics = _page_through(
            lambda: sb.table("chat_turn_logs").select("user_id,route_topic,created_at")
            .gte("created_at", since_iso).order("created_at"),
            "chat_turn_logs", truncated,
        )
    except Exception as exc:
        if not _table_missing(exc) and "route_topic" not in str(exc):
            raise
        turn_topics = []

    return Sources(
        users=users, sessions=sessions, user_messages=user_messages,
        visits=visits, turn_topics=turn_topics,
        visits_available=visits_available, tracking_since=tracking_since,
        truncated=truncated,
    )


# ── OpenAI quota incidents ───────────────────────────────────────────────────
# "How many turns does one top-up buy, and who spends it" — reconstructed from
# the logs that already exist. A failed reply is logged with OpenAI's own error
# text in both chat_turn_logs.error and llm_call_logs.error; an exhausted
# account says `insufficient_quota` / "exceeded your current quota". A plain
# 429 rate limit (`rate_limit_exceeded`) is a per-minute ceiling, not an empty
# account, and is deliberately not matched.

_QUOTA_ERROR = re.compile(
    r"insufficient_quota|exceeded your current quota|billing_hard_limit|billing hard limit",
    re.IGNORECASE,
)

#: Who spent the tokens. Conversation is everything a chat turn fans out into
#: (reply, router, memory, summary, title, #fix, task cards); knowledge cards
#: are the feed and its research passes.
SPEND_GROUPS = (
    ("chat", "对话", ("chat.", "task_card.")),
    ("cards", "知识卡片", ("content_research.", "feed.")),
)
OTHER_SPEND = ("other", "其他")


def is_quota_error(text) -> bool:
    return bool(text) and bool(_QUOTA_ERROR.search(str(text)))


def spend_group(call_site: str) -> str:
    site = call_site or ""
    for key, _label, prefixes in SPEND_GROUPS:
        if site.startswith(prefixes):
            return key
    return OTHER_SPEND[0]


def _row_tokens(row: dict) -> int:
    total = row.get("total_tokens")
    if isinstance(total, (int, float)) and total:
        return int(total)
    return int(row.get("prompt_tokens") or 0) + int(row.get("completion_tokens") or 0)


def build_quota_incidents(
    turn_logs: list[dict], call_logs: list[dict], *, since: datetime, now: datetime,
    truncated: Optional[list[str]] = None,
) -> dict:
    """Split the timeline into periods that each end in an exhaustion.

    Walking turns and failures in time order: the first quota failure after a
    working turn opens an incident; later quota failures belong to it; the next
    turn that worked closes it (someone topped up). Each incident is credited
    with the turns and tokens spent between the previous recovery — or the
    start of the data — and its own first failure. Whatever has been spent
    since the last recovery is reported as the open, current period.
    """
    # Kinds: a turn that worked ("ok"), a turn that failed for another reason
    # ("other" — still a turn the parent had, but proof of nothing), a turn
    # killed by the quota ("quota_turn"), and any other call killed by it
    # ("quota_call" — card research can hit the wall before chat does). One
    # failed reply is logged in both tables, so only turns are counted as
    # failed attempts; calls only ever open an incident.
    events: list[tuple[datetime, str]] = []
    for row in turn_logs:
        moment = parse_ts(row.get("created_at"))
        if not moment:
            continue
        if is_quota_error(row.get("error")):
            events.append((moment, "quota_turn"))
        elif (row.get("status") or "ok") == "ok":
            events.append((moment, "ok"))
        else:
            events.append((moment, "other"))
    for row in call_logs:
        moment = parse_ts(row.get("created_at"))
        if moment and row.get("status") == "error" and is_quota_error(row.get("error")):
            events.append((moment, "quota_call"))
    # At one instant, failures sort before the turn that worked, so a top-up
    # between them reads as recovery rather than a zero-length period.
    events.sort(key=lambda e: (e[0], not e[1].startswith("quota")))

    spend = sorted(
        (
            (moment, spend_group(str(row.get("call_site") or "")), _row_tokens(row))
            for row in call_logs
            if (moment := parse_ts(row.get("created_at")))
        ),
        key=lambda s: s[0],
    )

    def period_summary(start: datetime, end: datetime, turns: int) -> dict:
        totals = {key: 0 for key, _l, _p in SPEND_GROUPS}
        totals[OTHER_SPEND[0]] = 0
        for moment, group, tokens in spend:
            if start <= moment < end:
                totals[group] += tokens
        grand = sum(totals.values())
        labels = {key: label for key, label, _p in SPEND_GROUPS} | {OTHER_SPEND[0]: OTHER_SPEND[1]}
        return {
            "period_start": start.isoformat(),
            "turns": turns,
            "tokens": grand,
            "split": [
                {
                    "key": key,
                    "label": labels[key],
                    "tokens": totals[key],
                    "share": round(totals[key] / grand, 4) if grand else 0.0,
                }
                for key in [k for k, _l, _p in SPEND_GROUPS] + [OTHER_SPEND[0]]
            ],
        }

    incidents: list[dict] = []
    period_start = since
    turns_in_period = 0
    open_incident: Optional[dict] = None
    for moment, kind in events:
        if kind.startswith("quota"):
            if open_incident is None:
                open_incident = {
                    **period_summary(period_start, moment, turns_in_period),
                    "exhausted_at": moment.isoformat(),
                    "last_failure_at": moment.isoformat(),
                    "failed_turns": 0,
                    "recovered_at": None,
                }
                incidents.append(open_incident)
            open_incident["last_failure_at"] = moment.isoformat()
            if kind == "quota_turn":
                open_incident["failed_turns"] += 1
        elif kind == "ok":
            if open_incident is not None:
                open_incident["recovered_at"] = moment.isoformat()
                open_incident = None
                period_start = moment
                turns_in_period = 0
            turns_in_period += 1
        elif open_incident is None:
            turns_in_period += 1

    current = None if open_incident is not None else period_summary(period_start, now, turns_in_period)
    return {
        "since": since.isoformat(),
        "incidents": list(reversed(incidents)),  # newest first
        "current": current,
        "truncated": truncated or [],
    }


def fetch_quota_sources(sb, since: datetime) -> tuple[list[dict], list[dict], list[str]]:
    truncated: list[str] = []
    since_iso = since.isoformat()
    turn_logs = _page_through(
        lambda: sb.table("chat_turn_logs").select("created_at,status,error")
        .gte("created_at", since_iso).order("created_at"),
        "chat_turn_logs", truncated,
    )
    try:
        call_logs = _page_through(
            lambda: sb.table("llm_call_logs")
            .select("created_at,call_site,status,error,total_tokens,prompt_tokens,completion_tokens")
            .gte("created_at", since_iso).order("created_at"),
            "llm_call_logs", truncated,
        )
    except Exception as exc:
        if not _table_missing(exc):
            raise
        call_logs = []
        truncated.append("llm_call_logs 表不存在")
    return turn_logs, call_logs, truncated


# ── Heartbeat ────────────────────────────────────────────────────────────────

def record_heartbeat(
    sb, *, user_id: str, visit_id: Optional[str], platform: Optional[str], now: datetime,
    new_id: str,
) -> str:
    """Extend the caller's visit, or start one. Returns the visit id to send
    with the next beat.

    The server decides what counts as the same visit: an id that belongs to
    someone else, or whose last beat is older than VISIT_GAP_S, starts a new
    row rather than stretching the old one over time nobody was present.
    """
    now_iso = now.isoformat()
    if visit_id:
        rows = sb.table("user_visits").select("id,user_id,last_seen_at") \
            .eq("id", visit_id).limit(1).execute().data or []
        if rows and rows[0].get("user_id") == user_id:
            last = parse_ts(rows[0].get("last_seen_at"))
            if last and 0 <= (now - last).total_seconds() <= VISIT_GAP_S:
                sb.table("user_visits").update({"last_seen_at": now_iso}) \
                    .eq("id", visit_id).eq("user_id", user_id).execute()
                return visit_id
    sb.table("user_visits").insert({
        "id": new_id,
        "user_id": user_id,
        "started_at": now_iso,
        "last_seen_at": now_iso,
        "platform": platform,
    }).execute()
    return new_id
