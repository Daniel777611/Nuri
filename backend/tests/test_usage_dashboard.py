"""The /admin usage dashboard and the presence heartbeat behind it."""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from backend import main, runtime, usage_dashboard as ud

LA = ZoneInfo("America/Los_Angeles")
# 2026-09-10 12:00 in Los Angeles.
NOW = datetime(2026, 9, 10, 19, 0, tzinfo=timezone.utc)


def _la(day: int, hour: int, minute: int = 0) -> str:
    return datetime(2026, 9, day, hour, minute, tzinfo=LA).astimezone(timezone.utc).isoformat()


def _user(uid, email, **extra):
    return {
        "id": uid, "email": email, "nickname": uid, "created_at": _la(1, 9),
        "email_verified_at": _la(1, 9), "is_internal": False, **extra,
    }


def _sources(**overrides):
    base = dict(
        users=[
            _user("mom", "mom@realmail.com"),
            _user("dad", "dad@realmail.com", created_at=_la(9, 8)),
            _user("bot", "automated_test_01@example.com", is_internal=True),
            _user("pending", "new@realmail.com", email_verified_at=None),
        ],
        sessions=[
            {"id": "s-mom", "user_id": "mom"}, {"id": "s-dad", "user_id": "dad"},
            {"id": "s-bot", "user_id": "bot"},
        ],
        user_messages=[
            {"session_id": "s-mom", "created_at": _la(10, 8, 5)},
            {"session_id": "s-mom", "created_at": _la(10, 8, 9)},
            {"session_id": "s-mom", "created_at": _la(9, 21, 30)},
            {"session_id": "s-dad", "created_at": _la(9, 23, 50)},
            {"session_id": "s-bot", "created_at": _la(10, 9)},
            # Outside a 7-day window.
            {"session_id": "s-mom", "created_at": _la(1, 10)},
        ],
        visits=[
            {"user_id": "mom", "started_at": _la(10, 8), "last_seen_at": _la(10, 8, 20)},
            {"user_id": "mom", "started_at": _la(10, 20), "last_seen_at": _la(10, 20, 5)},
            {"user_id": "dad", "started_at": _la(8, 7), "last_seen_at": _la(8, 7, 10)},
            {"user_id": "bot", "started_at": _la(10, 9), "last_seen_at": _la(10, 11)},
        ],
        turn_topics=[
            {"user_id": "mom", "route_topic": "夜醒频繁", "created_at": _la(10, 8, 5)},
            {"user_id": "mom", "route_topic": "挑食不吃蔬菜", "created_at": _la(10, 8, 9)},
            {"user_id": "dad", "route_topic": "发烧38度要不要去医院", "created_at": _la(9, 23, 50)},
            {"user_id": "dad", "route_topic": "", "created_at": _la(9, 23, 55)},
            {"user_id": "bot", "route_topic": "夜醒", "created_at": _la(10, 9)},
        ],
        tracking_since=_la(8, 7),
    )
    base.update(overrides)
    return ud.Sources(**base)


def test_days_are_calendar_days_in_the_admins_timezone():
    out = ud.build_overview(_sources(), days=7, tz=LA, now=NOW)
    assert out["days"] == [f"2026-09-{d:02d}" for d in range(4, 11)]
    # 23:50 on the 9th in Los Angeles is the 10th in UTC; it stays the 9th here.
    dad = next(u for u in out["users"] if u["id"] == "dad")
    assert set(dad["by_day"]) == {"2026-09-08", "2026-09-09"}


def test_testers_exclude_internal_and_unverified_accounts():
    out = ud.build_overview(_sources(), days=7, tz=LA, now=NOW)
    assert {u["id"] for u in out["users"]} == {"mom", "dad"}
    assert out["testers"]["total"] == 2
    assert out["testers"]["internal"] == 1
    assert out["testers"]["unverified"] == 1
    assert out["testers"]["new_in_window"] == 1  # dad joined on the 9th


def test_include_internal_brings_the_bots_back():
    out = ud.build_overview(_sources(), days=7, tz=LA, now=NOW, include_internal=True)
    assert "bot" in {u["id"] for u in out["users"]}


def test_a_day_records_turns_presence_and_clock_times():
    out = ud.build_overview(_sources(), days=7, tz=LA, now=NOW)
    mom = next(u for u in out["users"] if u["id"] == "mom")
    today = mom["by_day"]["2026-09-10"]
    assert today == {
        "turns": 2, "online_seconds": 25 * 60, "visits": 2,
        "first_seen": "08:00", "last_seen": "20:05",
    }
    # A day with chat but no heartbeat (before presence shipped) still counts.
    assert mom["by_day"]["2026-09-09"]["turns"] == 1
    assert mom["by_day"]["2026-09-09"]["visits"] == 0
    assert mom["days_active"] == 2 and mom["days_chatted"] == 2
    assert mom["turns"] == 3  # the message on the 1st is outside the window


def test_daily_totals():
    out = ud.build_overview(_sources(), days=7, tz=LA, now=NOW)
    by_day = {d["day"]: d for d in out["daily"]}
    assert by_day["2026-09-10"]["active_users"] == 1
    assert by_day["2026-09-10"]["turns"] == 2
    assert by_day["2026-09-10"]["online_seconds"] == 25 * 60
    assert by_day["2026-09-09"]["chatting_users"] == 2
    assert by_day["2026-09-08"]["active_users"] == 1  # dad was online, didn't chat
    assert by_day["2026-09-08"]["chatting_users"] == 0
    assert out["testers"]["active_today"] == 1
    assert out["testers"]["active_in_window"] == 2
    assert out["tracking_since"] == _la(8, 7)


def test_hours_count_turns_and_visit_starts_by_local_hour():
    out = ud.build_overview(_sources(), days=7, tz=LA, now=NOW)
    assert out["hours"]["turns"][8] == 2
    assert out["hours"]["turns"][23] == 1
    assert out["hours"]["visits"][20] == 1


def test_topics_are_bucketed_and_unlabelled_turns_counted_separately():
    out = ud.build_overview(_sources(), days=7, tz=LA, now=NOW)
    cats = {c["key"]: c["turns"] for c in out["topics"]["categories"]}
    assert cats == {"sleep": 1, "food": 1, "health": 1}
    assert out["topics"]["unlabelled_turns"] == 1
    assert out["topics"]["labelled_turns"] == 3
    assert {t["topic"] for t in out["topics"]["top"]} == {"夜醒频繁", "挑食不吃蔬菜", "发烧38度要不要去医院"}


@pytest.mark.parametrize("topic,expected", [
    ("夜奶后难以入睡", "sleep"),
    ("发烧不吃饭", "health"),
    ("辅食添加顺序", "food"),
    ("两岁发脾气打人", "emotion"),
    ("18个月还不会说话", "development"),
    ("双语绘本推荐", "learning"),
    ("婆婆带娃观念冲突", "family"),
    ("产后情绪低落", "parent"),
    ("周末去哪", "other"),
])
def test_categorize_topic(topic, expected):
    assert ud.categorize_topic(topic) == expected


def test_a_database_without_the_new_columns_falls_back_to_the_email_rule():
    users = [{"id": "a", "email": "test_flow_1@x.com", "created_at": _la(1, 1)},
             {"id": "b", "email": "real@realmail.com", "created_at": _la(1, 1)}]
    out = ud.build_overview(
        _sources(users=users, sessions=[], user_messages=[], visits=[], turn_topics=[]),
        days=3, tz=LA, now=NOW,
    )
    assert [u["id"] for u in out["users"]] == ["b"]


# ── Quota incidents ──────────────────────────────────────────────────────────

QUOTA_ERR = (
    "RateLimitError: Error code: 429 - {'error': {'message': 'You exceeded your current "
    "quota, please check your plan and billing details.', 'type': 'insufficient_quota'}}"
)
RATE_ERR = "RateLimitError: Error code: 429 - {'error': {'code': 'rate_limit_exceeded'}}"


def _t(minutes: int) -> str:
    return (NOW - timedelta(days=3) + timedelta(minutes=minutes)).isoformat()


def _turn(minute, status="ok", error=None):
    return {"created_at": _t(minute), "status": status, "error": error}


def _call(minute, site, tokens, status="ok", error=None):
    return {"created_at": _t(minute), "call_site": site, "total_tokens": tokens,
            "status": status, "error": error}


def _quota(turns, calls):
    return ud.build_quota_incidents(turns, calls, since=NOW - timedelta(days=10), now=NOW)


def test_an_incident_counts_the_turns_and_tokens_before_it():
    turns = [_turn(0), _turn(5), _turn(10, "fallback", QUOTA_ERR), _turn(12, "fallback", QUOTA_ERR),
             _turn(60), _turn(70)]
    calls = [
        _call(0, "chat.reply", 1000), _call(0, "chat.router", 200),
        _call(3, "content_research.prepare", 3000), _call(5, "chat.reply", 800),
        _call(10, "chat.reply", 0, "error", QUOTA_ERR),
        _call(61, "chat.reply", 500), _call(62, "feed.gen_cards", 1500),
    ]
    out = _quota(turns, calls)
    assert len(out["incidents"]) == 1
    incident = out["incidents"][0]
    assert incident["turns"] == 2
    assert incident["failed_turns"] == 2  # not 3: the call row is the same failure
    assert incident["exhausted_at"] == _t(10)
    assert incident["recovered_at"] == _t(60)
    split = {s["key"]: s for s in incident["split"]}
    assert split["chat"]["tokens"] == 2000
    assert split["cards"]["tokens"] == 3000
    assert split["cards"]["share"] == 0.6
    # The period since recovery is still open.
    assert out["current"]["turns"] == 2
    assert {s["key"]: s["tokens"] for s in out["current"]["split"]} == {"chat": 500, "cards": 1500, "other": 0}


def test_a_rate_limit_is_not_an_empty_account():
    out = _quota([_turn(0), _turn(1, "fallback", RATE_ERR), _turn(2)], [])
    assert out["incidents"] == []
    assert out["current"]["turns"] == 3


def test_card_research_can_be_the_one_that_hits_the_wall():
    calls = [_call(0, "chat.reply", 100), _call(5, "content_research.prepare", 0, "error", QUOTA_ERR)]
    out = _quota([_turn(0), _turn(6, "fallback", QUOTA_ERR)], calls)
    assert out["incidents"][0]["exhausted_at"] == _t(5)
    assert out["incidents"][0]["turns"] == 1
    assert out["incidents"][0]["recovered_at"] is None
    assert out["current"] is None  # still dry


def test_two_incidents_are_separate_periods_newest_first():
    turns = [_turn(0), _turn(1, "fallback", QUOTA_ERR), _turn(2), _turn(3), _turn(4), _turn(5, "fallback", QUOTA_ERR)]
    out = _quota(turns, [])
    assert [i["turns"] for i in out["incidents"]] == [3, 1]


def test_quota_route(monkeypatch):
    db = _DB()
    db.tables = {
        "chat_turn_logs": [_turn(0), _turn(1, "fallback", QUOTA_ERR)],
        "llm_call_logs": [_call(0, "chat.reply", 400)],
    }
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(main, "ADMIN_KEY", "k")
    client = TestClient(main.app)
    assert client.get("/admin/usage/quota").status_code == 403
    res = client.get("/admin/usage/quota?days=30", headers={"x-admin-key": "k"})
    assert res.status_code == 200
    body = res.json()
    assert body["days"] == 30
    assert body["incidents"][0]["turns"] == 1


# ── Heartbeat ────────────────────────────────────────────────────────────────

class _Query:
    def __init__(self, db, table):
        self._db, self._table = db, table
        self._filters, self._order, self._range = [], [], None
        self._op, self._payload, self._limit = "select", None, None

    def select(self, *_a, **_k): return self
    def insert(self, row): self._op, self._payload = "insert", row; return self
    def update(self, patch): self._op, self._payload = "update", patch; return self
    def eq(self, c, v): self._filters.append(lambda r: r.get(c) == v); return self
    def gte(self, c, v): self._filters.append(lambda r: str(r.get(c)) >= v); return self
    def order(self, c, desc=False, **_k): self._order.append((c, desc)); return self
    def limit(self, n, **_k): self._limit = n; return self
    def range(self, a, b): self._range = (a, b); return self

    def execute(self):
        with self._db.lock:
            if self._table in self._db.missing:
                raise RuntimeError("{'code': 'PGRST205', 'message': 'Could not find the table'}")
            rows = self._db.tables.setdefault(self._table, [])
            if self._op == "insert":
                rows.append(dict(self._payload))
                return SimpleNamespace(data=[dict(self._payload)])
            hits = [r for r in rows if all(f(r) for f in self._filters)]
            if self._op == "update":
                for r in hits:
                    r.update(self._payload)
                return SimpleNamespace(data=[dict(r) for r in hits])
            for c, desc in reversed(self._order):
                hits.sort(key=lambda r: str(r.get(c) or ""), reverse=desc)
            if self._range:
                hits = hits[self._range[0]: self._range[1] + 1]
            if self._limit is not None:
                hits = hits[: self._limit]
            return SimpleNamespace(data=[dict(r) for r in hits])


class _DB:
    def __init__(self, missing=()):
        self.tables, self.lock, self.missing = {}, threading.Lock(), set(missing)

    def table(self, name):
        return _Query(self, name)


@pytest.fixture(autouse=True)
def _no_real_database(monkeypatch):
    attempts: list = []

    def refuse(*args, **_k):
        attempts.append(args)
        raise RuntimeError("real Supabase client requested in a unit test")

    monkeypatch.setattr(runtime, "supabase_client", None)
    monkeypatch.setattr(runtime, "create_client", refuse)
    yield
    assert not attempts, "a test tried to open a real Supabase client"


def test_heartbeats_extend_one_visit_until_a_gap():
    db = _DB()
    t0 = NOW
    vid = ud.record_heartbeat(db, user_id="mom", visit_id=None, platform="web", now=t0, new_id="v1")
    assert vid == "v1"
    vid = ud.record_heartbeat(db, user_id="mom", visit_id=vid, platform="web",
                              now=t0 + timedelta(seconds=60), new_id="unused")
    assert vid == "v1"
    assert db.tables["user_visits"][0]["last_seen_at"] == (t0 + timedelta(seconds=60)).isoformat()
    # Ten minutes of silence: the next beat is a new visit, not ten more minutes.
    vid = ud.record_heartbeat(db, user_id="mom", visit_id="v1", platform="web",
                              now=t0 + timedelta(minutes=11), new_id="v2")
    assert vid == "v2"
    assert db.tables["user_visits"][0]["last_seen_at"] == (t0 + timedelta(seconds=60)).isoformat()
    assert len(db.tables["user_visits"]) == 2


def test_a_visit_id_from_another_account_is_never_extended():
    db = _DB()
    ud.record_heartbeat(db, user_id="mom", visit_id=None, platform="web", now=NOW, new_id="v1")
    vid = ud.record_heartbeat(db, user_id="intruder", visit_id="v1", platform="web",
                              now=NOW + timedelta(seconds=30), new_id="v9")
    assert vid == "v9"
    assert db.tables["user_visits"][0]["last_seen_at"] == NOW.isoformat()
    assert db.tables["user_visits"][1]["user_id"] == "intruder"


def test_heartbeat_route_needs_a_token_and_returns_the_visit(monkeypatch):
    db = _DB()
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    client = TestClient(main.app)
    assert client.post("/api/activity/heartbeat", json={}).status_code == 401
    headers = {"Authorization": f"Bearer {main._make_token('mom')}"}
    first = client.post("/api/activity/heartbeat", json={"platform": "web"}, headers=headers).json()
    second = client.post("/api/activity/heartbeat", json={"visit_id": first["visit_id"]}, headers=headers).json()
    assert first["visit_id"] and second["visit_id"] == first["visit_id"]
    assert len(db.tables["user_visits"]) == 1


def test_heartbeat_before_the_migration_tells_the_client_to_stop(monkeypatch):
    monkeypatch.setattr(runtime, "get_supabase", lambda: _DB(missing={"user_visits"}))
    headers = {"Authorization": f"Bearer {main._make_token('mom')}"}
    res = TestClient(main.app).post("/api/activity/heartbeat", json={}, headers=headers)
    assert res.status_code == 200
    assert res.json() == {"visit_id": None, "disabled": True}


# ── Admin routes ─────────────────────────────────────────────────────────────

def _seeded_db(missing=()):
    db = _DB(missing=missing)
    db.tables = {
        "users": [_user("mom", "mom@realmail.com")],
        "chat_sessions": [{"id": "s-mom", "user_id": "mom", "created_at": _la(1, 9)}],
        "chat_messages": [
            {"session_id": "s-mom", "role": "user", "created_at": datetime.now(timezone.utc).isoformat()},
            {"session_id": "s-mom", "role": "ai", "created_at": datetime.now(timezone.utc).isoformat()},
        ],
        "chat_turn_logs": [],
    }
    return db


def test_overview_route_needs_the_admin_key_and_answers(monkeypatch):
    db = _seeded_db()
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(main, "ADMIN_KEY", "k")
    client = TestClient(main.app)
    assert client.get("/admin/usage/overview").status_code == 403
    res = client.get("/admin/usage/overview?days=3&tz=Asia/Shanghai", headers={"x-admin-key": "k"})
    assert res.status_code == 200
    body = res.json()
    assert body["tz"] == "Asia/Shanghai"
    assert len(body["days"]) == 3
    assert body["users"][0]["turns"] == 1  # the ai message is not a turn
    assert body["visits_available"] is True
    assert client.get("/admin/usage/overview?tz=Mars/Base", headers={"x-admin-key": "k"}).status_code == 400


def test_overview_works_before_the_presence_table_exists(monkeypatch):
    db = _seeded_db(missing={"user_visits"})
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(main, "ADMIN_KEY", "k")
    res = TestClient(main.app).get("/admin/usage/overview", headers={"x-admin-key": "k"})
    assert res.status_code == 200
    assert res.json()["visits_available"] is False


def test_paging_reads_past_the_postgrest_page_size(monkeypatch):
    monkeypatch.setattr(ud, "PAGE_SIZE", 2)
    db = _DB()
    db.tables["chat_messages"] = [
        {"session_id": "s", "role": "user", "created_at": _la(10, 1, m)} for m in range(5)
    ]
    rows = ud._page_through(
        lambda: db.table("chat_messages").select("*").order("created_at"), "chat_messages", [],
    )
    assert len(rows) == 5


def test_marking_an_account_internal(monkeypatch):
    db = _seeded_db()
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(main, "ADMIN_KEY", "k")
    client = TestClient(main.app)
    res = client.patch("/admin/accounts/mom", json={"is_internal": True}, headers={"x-admin-key": "k"})
    assert res.status_code == 200
    assert db.tables["users"][0]["is_internal"] is True
    assert client.patch("/admin/accounts/nobody", json={"is_internal": True},
                        headers={"x-admin-key": "k"}).status_code == 404
