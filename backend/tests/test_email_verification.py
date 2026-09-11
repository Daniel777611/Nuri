"""Email verification, password reset, and the routes that stopped sharing data.

Everything runs against an in-memory stand-in for PostgREST: no mail leaves,
no DNS is asked, and no database is touched.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import email_verification, main, memstore, runtime


# ── A small PostgREST ────────────────────────────────────────────────────────

class _Query:
    def __init__(self, db: "_DB", table: str):
        self._db, self._table = db, table
        self._filters: list = []
        self._order: list[tuple[str, bool]] = []
        self._limit = None
        self._op = "select"
        self._payload = None

    def select(self, *_a, **_k):
        return self

    def insert(self, row):
        self._op, self._payload = "insert", row
        return self

    def update(self, patch):
        self._op, self._payload = "update", patch
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, col, val):
        self._filters.append(lambda r, c=col, v=val: r.get(c) == v)
        return self

    def is_(self, col, val):
        assert val == "null"
        self._filters.append(lambda r, c=col: r.get(c) is None)
        return self

    def gte(self, col, val):
        self._filters.append(lambda r, c=col, v=val: str(r.get(c)) >= v)
        return self

    def lt(self, col, val):
        self._filters.append(lambda r, c=col, v=val: str(r.get(c)) < v)
        return self

    def order(self, col, desc=False, **_k):
        self._order.append((col, desc))
        return self

    def limit(self, n, **_k):
        self._limit = n
        return self

    def execute(self):
        with self._db.lock:
            rows = self._db.tables.setdefault(self._table, [])
            if self._op == "insert":
                if self._table == "users" and any(r["email"] == self._payload["email"] for r in rows):
                    raise RuntimeError("23505 duplicate key value violates users_email_key")
                rows.append(dict(self._payload))
                return SimpleNamespace(data=[dict(self._payload)])
            hits = [r for r in rows if all(f(r) for f in self._filters)]
            if self._op == "update":
                for r in hits:
                    r.update(self._payload)
                return SimpleNamespace(data=[dict(r) for r in hits])
            if self._op == "delete":
                rows[:] = [r for r in rows if r not in hits]
                return SimpleNamespace(data=[dict(r) for r in hits])
            for col, desc in reversed(self._order):
                hits.sort(key=lambda r, c=col: str(r.get(c) or ""), reverse=desc)
            if self._limit is not None:
                hits = hits[: self._limit]
            return SimpleNamespace(data=[dict(r) for r in hits])


class _DB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.lock = threading.Lock()

    def table(self, name):
        return _Query(self, name)


@pytest.fixture(autouse=True)
def _no_real_database(monkeypatch):
    """Fail any test that reaches for the database named in .env.

    runtime.get_supabase swallows a client-construction error and returns
    None, so raising alone would pass silently; the attempt is recorded and
    checked afterwards instead.
    """
    attempts: list = []

    def refuse(*args, **_k):
        attempts.append(args)
        raise RuntimeError("real Supabase client requested in a unit test")

    monkeypatch.setattr(runtime, "supabase_client", None)
    monkeypatch.setattr(runtime, "create_client", refuse)
    yield
    assert not attempts, "a test tried to open a real Supabase client"


@pytest.fixture
def env(monkeypatch):
    db = _DB()
    sent: list[dict] = []
    # The runtime seam, not main._get_supabase: stores.py reads it directly,
    # and patching only main's wrapper lets store calls reach the real
    # database named in .env.
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(email_verification, "mailbox_problem", lambda _e: None)

    def fake_send(to, code, purpose, language=None):
        sent.append({"to": to, "code": code, "purpose": purpose, "language": language})

    monkeypatch.setattr(email_verification, "send_code", fake_send)
    return SimpleNamespace(db=db, sent=sent, client=TestClient(main.app))


def _register(env, email="parent@realmail.com", password="secret12", **extra):
    return env.client.post("/api/auth/register", json={"email": email, "password": password, **extra})


def _last_code(env, purpose="verify"):
    return [m for m in env.sent if m["purpose"] == purpose][-1]["code"]


def _age_codes(env, seconds):
    """Pretend every code was sent `seconds` earlier than it was."""
    for row in env.db.tables.get("email_codes", []):
        created = datetime.fromisoformat(row["created_at"]) - timedelta(seconds=seconds)
        row["created_at"] = created.isoformat()


# ── Registration ─────────────────────────────────────────────────────────────

def test_register_sends_a_code_and_returns_no_token(env):
    res = _register(env, email="Parent@RealMail.com", language="en")
    assert res.status_code == 201
    body = res.json()
    assert body == {"verification_required": True, "email": "parent@realmail.com", "resend_after": 60}
    assert "access_token" not in body
    assert env.sent[-1]["to"] == "parent@realmail.com"
    assert env.sent[-1]["language"] == "en"
    user = env.db.tables["users"][0]
    assert user["email_verified_at"] is None
    # Only a keyed hash of the code is stored.
    assert env.sent[-1]["code"] not in str(env.db.tables["email_codes"])


def test_the_right_code_verifies_and_signs_in(env):
    _register(env)
    res = env.client.post("/api/auth/verify-email", json={
        "email": "parent@realmail.com", "code": _last_code(env),
    })
    assert res.status_code == 200
    body = res.json()
    assert body["access_token"]
    assert body["user"]["email_verified"] is True
    me = env.client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200


def test_a_code_works_once(env):
    _register(env)
    code = _last_code(env)
    assert env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": code}).status_code == 200
    again = env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": code})
    assert again.status_code == 400
    assert again.json()["detail"] == "EMAIL_ALREADY_VERIFIED"


def test_five_wrong_guesses_burn_the_code(env):
    _register(env)
    good = _last_code(env)
    wrong = "000000" if good != "000000" else "111111"
    details = [
        env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": wrong}).json()["detail"]
        for _ in range(5)
    ]
    assert details == ["CODE_WRONG"] * 4 + ["CODE_LOCKED"]
    # Even the right code is refused now; a new one has to be requested.
    res = env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": good})
    assert res.json()["detail"] == "CODE_LOCKED"


def test_an_expired_code_is_refused(env):
    _register(env)
    for row in env.db.tables["email_codes"]:
        row["expires_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    res = env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": _last_code(env)})
    assert res.json()["detail"] == "CODE_EXPIRED"


def test_verify_does_not_reveal_whether_an_account_exists(env):
    res = env.client.post("/api/auth/verify-email", json={"email": "nobody@realmail.com", "code": "123456"})
    assert res.status_code == 400
    assert res.json()["detail"] == "CODE_EXPIRED"


def test_resend_is_rate_limited_and_only_the_newest_code_works(env):
    _register(env)
    first = _last_code(env)
    too_soon = env.client.post("/api/auth/resend-verification", json={"email": "parent@realmail.com"})
    assert too_soon.status_code == 429
    assert too_soon.json()["detail"] == "CODE_RATE_LIMITED"
    assert int(too_soon.headers["Retry-After"]) > 0

    _age_codes(env, 61)
    ok = env.client.post("/api/auth/resend-verification", json={"email": "parent@realmail.com"})
    assert ok.status_code == 200
    second = _last_code(env)
    if first != second:
        stale = env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": first})
        assert stale.json()["detail"] in {"CODE_WRONG", "CODE_EXPIRED"}
    res = env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": second})
    assert res.status_code == 200


def test_an_address_gets_at_most_five_codes_an_hour(env):
    _register(env)
    for _ in range(4):
        _age_codes(env, 61)
        assert env.client.post("/api/auth/resend-verification", json={"email": "parent@realmail.com"}).status_code == 200
    _age_codes(env, 61)
    sixth = env.client.post("/api/auth/resend-verification", json={"email": "parent@realmail.com"})
    assert sixth.status_code == 429
    assert len(env.sent) == 5


def test_a_verified_address_cannot_register_again(env):
    _register(env)
    env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": _last_code(env)})
    res = _register(env)
    assert res.status_code == 400
    assert "已注册" in res.json()["detail"]


def test_an_unverified_address_can_be_claimed_by_whoever_holds_the_mailbox(env):
    _register(env, password="squatter1")
    _age_codes(env, 61)
    res = _register(env, password="realowner1")
    assert res.status_code == 201
    assert len(env.db.tables["users"]) == 1
    env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": _last_code(env)})
    assert env.client.post("/api/auth/login", json={"email": "parent@realmail.com", "password": "realowner1"}).status_code == 200
    assert env.client.post("/api/auth/login", json={"email": "parent@realmail.com", "password": "squatter1"}).status_code == 401


def test_register_inside_the_cooldown_still_succeeds(env):
    _register(env)
    res = _register(env)
    assert res.status_code == 201
    assert 0 < res.json()["resend_after"] <= 60
    assert len(env.sent) == 1


def test_an_undeliverable_address_is_refused_before_anything_is_written(env, monkeypatch):
    monkeypatch.setattr(email_verification, "mailbox_problem", lambda _e: "undeliverable")
    res = _register(env, email="someone@example.com")
    assert res.status_code == 400
    assert res.json()["detail"] == "MAILBOX_UNDELIVERABLE"
    assert not env.db.tables.get("users")
    assert not env.sent


def test_a_mail_failure_is_reported_and_does_not_start_the_cooldown(env, monkeypatch):
    def broken(*_a, **_k):
        raise OSError("smtp down")

    monkeypatch.setattr(email_verification, "send_code", broken)
    res = _register(env)
    assert res.status_code == 503
    assert res.json()["detail"] == "MAIL_SEND_FAILED"
    assert not env.db.tables.get("email_codes")


def test_a_password_past_bcrypts_limit_is_a_422_not_a_500(env):
    res = _register(env, password="密" * 30)
    assert res.status_code == 422


# ── Login ────────────────────────────────────────────────────────────────────

def test_an_unverified_account_cannot_log_in(env):
    _register(env)
    res = env.client.post("/api/auth/login", json={"email": "parent@realmail.com", "password": "secret12"})
    assert res.status_code == 403
    assert res.json()["detail"] == "EMAIL_NOT_VERIFIED"


def test_a_wrong_password_never_learns_about_verification(env):
    _register(env)
    res = env.client.post("/api/auth/login", json={"email": "parent@realmail.com", "password": "nope-nope"})
    assert res.status_code == 401


def test_grandfathered_accounts_log_in_unchanged(env):
    env.db.tables["users"] = [{
        "id": "old-1", "email": "early@tester.com", "hashed_password": main._hash_pw("secret12"),
        "created_at": "2026-08-01T00:00:00+00:00", "email_verified_at": "2026-08-01T00:00:00+00:00",
    }]
    res = env.client.post("/api/auth/login", json={"email": "early@tester.com", "password": "secret12"})
    assert res.status_code == 200
    assert res.json()["user"]["email_verified"] is True


# ── Password reset ───────────────────────────────────────────────────────────

def _verified_account(env):
    _register(env)
    env.client.post("/api/auth/verify-email", json={"email": "parent@realmail.com", "code": _last_code(env)})


def test_reset_replaces_the_password(env):
    _verified_account(env)
    res = env.client.post("/api/auth/password/forgot", json={"email": "parent@realmail.com"})
    assert res.status_code == 200
    reset = env.client.post("/api/auth/password/reset", json={
        "email": "parent@realmail.com", "code": _last_code(env, "reset"), "new_password": "brandnew1",
    })
    assert reset.status_code == 200
    assert reset.json()["access_token"]
    assert env.client.post("/api/auth/login", json={"email": "parent@realmail.com", "password": "brandnew1"}).status_code == 200
    assert env.client.post("/api/auth/login", json={"email": "parent@realmail.com", "password": "secret12"}).status_code == 401


def test_forgot_answers_the_same_for_unknown_addresses(env):
    _verified_account(env)
    known = env.client.post("/api/auth/password/forgot", json={"email": "parent@realmail.com"})
    unknown = env.client.post("/api/auth/password/forgot", json={"email": "stranger@realmail.com"})
    in_cooldown = env.client.post("/api/auth/password/forgot", json={"email": "parent@realmail.com"})
    assert known.status_code == unknown.status_code == in_cooldown.status_code == 200
    assert known.json() == unknown.json() == in_cooldown.json()
    assert [m["to"] for m in env.sent if m["purpose"] == "reset"] == ["parent@realmail.com"]


def test_a_verify_code_cannot_reset_a_password(env):
    _register(env)
    res = env.client.post("/api/auth/password/reset", json={
        "email": "parent@realmail.com", "code": _last_code(env), "new_password": "brandnew1",
    })
    assert res.status_code == 400


def test_reset_verifies_an_unverified_account(env):
    _register(env)
    _age_codes(env, 61)
    env.client.post("/api/auth/password/forgot", json={"email": "parent@realmail.com"})
    res = env.client.post("/api/auth/password/reset", json={
        "email": "parent@realmail.com", "code": _last_code(env, "reset"), "new_password": "brandnew1",
    })
    assert res.status_code == 200
    assert res.json()["user"]["email_verified"] is True


# ── Admin test accounts ──────────────────────────────────────────────────────

def test_admin_test_accounts_are_verified_and_need_the_key(env, monkeypatch):
    monkeypatch.setattr(main, "ADMIN_KEY", "k")
    payload = {"email": "automated_test_01@example.com", "password": "secret12"}
    assert env.client.post("/admin/test-accounts", json=payload).status_code == 403
    res = env.client.post("/admin/test-accounts", json=payload, headers={"x-admin-key": "k"})
    assert res.status_code == 201
    assert res.json()["user"]["email_verified"] is True
    assert not env.sent
    login = env.client.post("/api/auth/login", json={"email": payload["email"], "password": "secret12"})
    assert login.status_code == 200


# ── Routes that used to share one bucket across callers ─────────────────────

@pytest.mark.parametrize("method,path,body", [
    ("get", "/api/favorites", None),
    ("post", "/api/favorites/toggle", {"card_id": "card_food_picky"}),
    ("post", "/api/favorites/save", {"card_id": "card_food_picky", "collection_id": "c1"}),
    ("get", "/api/collections", None),
    ("post", "/api/collections", {"name": "睡眠"}),
    ("put", "/api/collections/c1", {"name": "x"}),
    ("delete", "/api/collections/c1", None),
    ("patch", "/api/tasks/t1", {"done": True}),
    ("delete", "/api/tasks/t1", None),
    ("post", "/api/tasks/clear-completed", None),
    ("get", "/api/tasks/insights", None),
    ("get", "/api/privacy", None),
    ("put", "/api/privacy", {}),
    ("post", "/api/privacy/wipe", None),
    ("post", "/api/feed/generate", {"count": 2}),
])
def test_account_data_routes_need_a_token(env, method, path, body):
    kwargs = {"json": body} if body is not None else {}
    res = getattr(env.client, method)(path, **kwargs)
    assert res.status_code == 401


def test_a_signed_out_wipe_no_longer_clears_everyone(env, monkeypatch):
    monkeypatch.setattr(memstore, "tasks", [{"id": "t", "user_id": "someone", "done": False}])
    env.client.post("/api/privacy/wipe")
    assert memstore.tasks == [{"id": "t", "user_id": "someone", "done": False}]


def test_one_account_cannot_touch_anothers_in_memory_task(env, monkeypatch):
    monkeypatch.setattr(runtime, "get_supabase", lambda: None)
    monkeypatch.setattr(memstore, "tasks", [{
        "id": "t1", "user_id": "owner", "done": False, "scope": "today",
        "progress_done": 0, "progress_total": 1,
    }])
    intruder = {"Authorization": f"Bearer {main._make_token('intruder')}"}
    assert env.client.patch("/api/tasks/t1", json={"done": True}, headers=intruder).status_code == 404
    env.client.delete("/api/tasks/t1", headers=intruder)
    assert memstore.tasks[0]["done"] is False
    insights = env.client.get("/api/tasks/insights", headers=intruder).json()
    assert insights["total_completed"] == 0


def test_a_favorite_cannot_be_filed_in_another_accounts_collection(env):
    env.db.tables["collections"] = [{"id": "theirs", "user_id": "owner", "name": "x", "created_at": "1"}]
    intruder = {"Authorization": f"Bearer {main._make_token('intruder')}"}
    res = env.client.post("/api/favorites/save", headers=intruder,
                          json={"card_id": "card_food_picky", "collection_id": "theirs"})
    assert res.status_code == 404
    assert not env.db.tables.get("favorites")


def test_knowledge_base_ingest_needs_the_admin_key(env, monkeypatch):
    monkeypatch.setattr(main, "ADMIN_KEY", "k")
    assert env.client.post("/api/index-from-url", json={"url": "https://x/y.pdf"}).status_code == 403
    assert env.client.post("/index", files={"file": ("a.pdf", b"%PDF")}).status_code == 403


# ── The mailbox pre-check itself ─────────────────────────────────────────────

def test_disposable_domains_are_refused_without_dns():
    assert email_verification.mailbox_problem("a@mailinator.com") == "disposable"


def test_dns_trouble_never_blocks_a_registration(monkeypatch):
    def boom(*_a, **_k):
        raise TimeoutError("resolver down")

    monkeypatch.setattr(email_verification, "validate_email", boom)
    assert email_verification.mailbox_problem("a@realmail.com") is None
