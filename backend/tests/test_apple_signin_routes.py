"""Exercise the real routes against isolated PostgREST/provider stand-ins."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from backend import account_deletion, apple_auth, main, runtime
from backend.tests.test_email_verification import _no_real_database, _Query, env  # noqa: F401

BASE = "/api/auth/apple"
ACCOUNT = "/api/auth/account"
APPLE_EMAIL = "fixture@privaterelay.appleid.com"
EVENT_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class Duplicate(Exception):
    code = "23505"


@pytest.fixture
def apple_routes(env, monkeypatch):
    class Provider:
        config = SimpleNamespace(client_id=apple_auth.ORIGINAL_CLIENT_ID, token_encryption_key=b"fake-unit-test-key")
        subject = "test-apple-parent"
        email = APPLE_EMAIL
        exchanges = 0
        authorized_at = 1000

        @staticmethod
        def signing_key(_token):
            return EVENT_KEY.public_key()

        def exchange(self, *, code, identity_token, nonce):
            assert identity_token == "synthetic-test-apple-identity-token"
            assert code == "synthetic-test-apple-code"
            assert len(nonce) == 64
            self.exchanges += 1
            return {"subject": self.subject, "verified_email": self.email,
                    "authorized_at": self.authorized_at,
                    "encrypted_refresh_token": "synthetic-encrypted-grant"}

    provider = Provider()
    base_execute = _Query.execute

    def execute(query):
        if query._table == "users" and query._op in {"insert", "update"}:
            with env.db.lock:
                payload = query._payload
                rows = env.db.tables.setdefault("users", [])
                candidates = [row for row in rows if all(f(row) for f in query._filters)]
                for row in rows:
                    if not any(row is candidate for candidate in candidates) or query._op == "insert":
                        if payload.get("apple_subject") and row.get("apple_subject") == payload["apple_subject"]:
                            raise Duplicate
                        if query._op == "insert" and row["email"] == payload["email"]:
                            raise Duplicate
                if query._op == "insert":
                    row = {"apple_session_generation": 0, "apple_authorized_at": 0,
                           "apple_revoked_at": 0, **payload}
                    rows.append(row)
                    return SimpleNamespace(data=[dict(row)])
                for row in candidates:
                    row.update(payload)
                return SimpleNamespace(data=[dict(row) for row in candidates])
        return base_execute(query)

    def greater(query, name, value):
        query._filters.append(lambda row: row[name] > value)
        return query

    def like(query, name, prefix):
        assert prefix.endswith("%")
        query._filters.append(lambda row: str(row.get(name, "")).startswith(prefix[:-1]))
        return query

    def upsert(query, row, *, on_conflict):
        with env.db.lock:
            rows = env.db.tables.setdefault(query._table, [])
            existing = next((item for item in rows if item[on_conflict] == row[on_conflict]), None)
            if existing is None:
                rows.append(dict(row))
            else:
                existing.update(row)
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[row]))

    async def load_account(sb, uid, *, fields):
        assert sb is env.db
        rows = sb.table("users").select(fields).eq("id", uid).limit(1).execute().data
        return rows[0] if rows else None

    def rpc(name, arguments):
        assert name == "issue_apple_signin_challenge"
        assert len(arguments["p_bucket"]) == 64
        return env.db.table("apple_signin_challenges").insert({
            "nonce_hash": arguments["p_nonce_hash"], "audience": arguments["p_audience"],
            "purpose": arguments["p_purpose"], "user_id": arguments["p_user_id"],
            "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat(),
        })

    def issue_rpc(name, arguments):
        if name == "record_apple_signin_event":
            def apply_event():
                with env.db.lock:
                    receipts = env.db.tables.setdefault("apple_event_receipts", [])
                    if arguments["p_receipt_hash"] in receipts:
                        return SimpleNamespace(data=None)
                    receipts.append(arguments["p_receipt_hash"])
                    for user in env.db.tables.get("users", []):
                        if (user.get("apple_subject"), user.get("apple_client_id")) == (
                                arguments["p_subject"], arguments["p_audience"]):
                            if arguments["p_event"] in {"consent-revoked", "account-deleted"}:
                                user["apple_revoked_at"] = arguments["p_event_time"]
                                user["apple_session_generation"] += 1
                                user["apple_refresh_ciphertext"] = ""
                            elif user["email"] == arguments["p_relay_email"]:
                                user["apple_relay_disabled"] = arguments["p_event"] == "email-disabled"
                return SimpleNamespace(data=None)
            return SimpleNamespace(execute=apply_event)
        query = rpc(name, arguments)
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=bool(query.execute().data)))

    monkeypatch.setattr(_Query, "execute", execute)
    monkeypatch.setattr(_Query, "gt", greater, raising=False)
    monkeypatch.setattr(_Query, "like", like, raising=False)
    monkeypatch.setattr(_Query, "upsert", upsert, raising=False)
    monkeypatch.setattr(account_deletion, "load_account", load_account)
    monkeypatch.setattr(env.db, "rpc", issue_rpc, raising=False)
    monkeypatch.setattr(apple_auth, "enabled", lambda: True)
    monkeypatch.setattr(apple_auth, "configured_provider", lambda: provider)
    monkeypatch.setattr(runtime, "SUPABASE_SERVICE_ROLE_KEY", "test-service-role")
    monkeypatch.setattr(main, "_hash_pw", lambda value: main.bcrypt.hashpw(value.encode(), main.bcrypt.gensalt(rounds=4)).decode())
    return provider


def auth(uid):
    return {"Authorization": f"Bearer {main._make_token(uid)}"}


def issue(env, purpose="signin", headers=None):
    response = env.client.post(f"{BASE}/challenge", json={"purpose": purpose}, headers=headers)
    assert response.status_code == 200, response.text
    return {"nonce": response.json()["nonce"], "identity_token": "synthetic-test-apple-identity-token",
            "authorization_code": "synthetic-test-apple-code"}


def existing(env, uid="existing", email=APPLE_EMAIL, apple_subject=None):
    row = {"id": uid, "email": email, "email_verified_at": "2026-11-01",
           "hashed_password": main._hash_pw("legacy-password"), "nickname": "Existing"}
    if apple_subject:
        row.update(apple_subject=apple_subject, apple_client_id=apple_auth.ORIGINAL_CLIENT_ID,
                   apple_refresh_ciphertext="stored-encrypted-grant", apple_session_generation=0,
                   apple_authorized_at=0, apple_revoked_at=0)
    env.db.tables.setdefault("users", []).append(row)
    return row


def test_status_requires_configuration_and_schema(env, apple_routes, monkeypatch):
    response = env.client.get(f"{BASE}/status")
    assert response.json() == {"enabled": True}
    assert response.headers["cache-control"] == "no-store"
    monkeypatch.setattr(runtime, "SUPABASE_SERVICE_ROLE_KEY", None)
    assert env.client.get(f"{BASE}/status").json() == {"enabled": False}
    assert env.client.post(f"{BASE}/challenge", json={}).status_code == 503


def test_rate_limited_issuance_is_explicit_and_returns_no_nonce(env, apple_routes, monkeypatch):
    monkeypatch.setattr(env.db, "rpc", lambda *_: SimpleNamespace(
        execute=lambda: SimpleNamespace(data=False)
    ))
    response = env.client.post(f"{BASE}/challenge", json={})
    assert response.status_code == 429 and response.headers["retry-after"] == "300"
    assert response.json()["detail"] == "APPLE_CHALLENGE_RATE_LIMITED"
    assert "nonce" not in response.json() and apple_routes.exchanges == 0


def test_signup_repeat_email_absence_and_legacy_profile_hide_secrets(env, apple_routes):
    body = issue(env)
    assert env.db.tables["apple_signin_challenges"][0]["nonce_hash"] == hashlib.sha256(body["nonce"].encode()).hexdigest()
    response = env.client.post(BASE, json={**body, "first_name": "New", "last_name": "Parent"})
    assert response.status_code == 200, response.text
    created = response.json()
    assert created["created"] and created["user"]["apple_sign_in_linked"] is True
    assert created["user"]["nickname"] == "New Parent"
    uid = created["user"]["id"]
    apple_routes.email = None
    repeated = env.client.post(BASE, json=issue(env)).json()
    assert not repeated["created"] and repeated["user"]["id"] == uid
    me = env.client.get("/api/auth/me", headers=auth(uid))
    edited = env.client.put("/api/auth/me", headers=auth(uid), json={"city": "London"})
    for result in (response, me, edited):
        assert apple_routes.subject not in result.text
        assert "synthetic-encrypted-grant" not in result.text


def test_email_collision_requires_explicit_link_and_keeps_owner_uid_and_password(env, apple_routes):
    row = existing(env)
    initial_password_hash = row["hashed_password"]
    duplicate = env.client.post(BASE, json=issue(env))
    assert duplicate.status_code == 409 and duplicate.json()["detail"] == "APPLE_ACCOUNT_LINK_REQUIRED"
    assert row.get("apple_subject") is None and len(env.db.tables["users"]) == 1
    signed_in = env.client.post("/api/auth/login", json={"email": APPLE_EMAIL, "password": "legacy-password"})
    assert signed_in.status_code == 200
    headers = {"Authorization": "Bearer " + signed_in.json()["access_token"]}
    linked = env.client.post(f"{BASE}/link", headers=headers, json=issue(env, "link", headers))
    assert linked.status_code == 200, linked.text
    assert linked.json()["user"]["id"] == row["id"] and linked.json()["user"]["apple_sign_in_linked"]
    assert "Bearer " + linked.json()["access_token"] == headers["Authorization"]
    assert row["hashed_password"] == initial_password_hash and row["email"] == APPLE_EMAIL
    other = existing(env, uid="another", email="other@example.com")
    other_headers = auth(other["id"])
    refused = env.client.post(f"{BASE}/link", headers=other_headers, json=issue(env, "link", other_headers))
    assert refused.status_code == 409
    assert len(env.db.tables["users"]) == 2 and other.get("apple_subject") is None


def test_challenge_consumption_is_single_use_across_concurrent_calls(env, apple_routes):
    body = issue(env)
    with ThreadPoolExecutor(max_workers=2) as threads:
        responses = list(threads.map(lambda _: env.client.post(BASE, json=body), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 401]
    assert apple_routes.exchanges == 1


def test_challenge_rejects_wrong_owner_wrong_action_and_expiry_before_exchange(env, apple_routes):
    existing(env)
    existing(env, uid="other", email="other@example.com")
    first = auth("existing")
    other = auth("other")
    body = issue(env, "link", first)
    assert env.client.post(BASE, json=body).status_code == 401
    assert env.client.post(f"{BASE}/link", headers=other, json=body).status_code == 401
    env.db.tables["apple_signin_challenges"][0]["expires_at"] = "2000-01-01T00:00:00+00:00"
    assert env.client.post(f"{BASE}/link", headers=first, json=body).status_code == 401
    assert apple_routes.exchanges == 0


def test_link_requires_recent_existing_nuri_authentication(env, apple_routes):
    existing(env)
    now = datetime.now(timezone.utc)
    old = jwt.encode({"sub": "existing", "iat": now - timedelta(hours=3), "exp": now + timedelta(hours=1)},
                     main.JWT_SECRET, algorithm=main.JWT_ALG)
    response = env.client.post(f"{BASE}/challenge", headers={"Authorization": f"Bearer {old}"}, json={"purpose": "link"})
    assert response.status_code == 403 and response.json()["detail"] == "APPLE_LINK_REAUTH_REQUIRED"


@pytest.mark.parametrize("method", ["password", "apple"])
def test_deletion_revokes_saved_or_fresh_grant_and_supports_manual_followup(env, apple_routes, monkeypatch, method):
    row = existing(env, apple_subject=apple_routes.subject)
    headers = auth(row["id"])
    revocations = []
    monkeypatch.setattr(main.billing, "cancel_for_account", lambda *_: [])
    def revoke(user):
        assert row in env.db.tables["users"]
        revocations.append(user["apple_refresh_ciphertext"])
        return method == "apple"
    monkeypatch.setattr(apple_auth, "revoke_account", revoke)
    if method == "password":
        monkeypatch.setattr(apple_auth, "enabled", lambda: False)
        proof = {"password": "legacy-password"}
    else:
        proof = {"apple": issue(env, "delete", headers)}
    response = env.client.request("DELETE", ACCOUNT, headers=headers, json={"confirmation": "DELETE", **proof})
    assert response.status_code == 200, response.text
    assert response.json()["account_deleted"] is True and not env.db.tables["users"]
    if method == "password":
        assert revocations == ["stored-encrypted-grant"] and "apple_revocation_pending" not in response.json()
    else:
        assert revocations == ["synthetic-encrypted-grant"] and response.json()["apple_revocation_pending"] is True


def test_delete_wrong_apple_account_and_invalid_input_never_leak_or_erase(env, apple_routes):
    row = existing(env, apple_subject="another-owner")
    headers = auth(row["id"])
    proof = issue(env, "delete", headers)
    rejected = env.client.request("DELETE", ACCOUNT, headers=headers, json={"confirmation": "DELETE", "apple": proof})
    assert rejected.status_code == 403 and rejected.json()["detail"]["code"] == "ACCOUNT_REAUTH_FAILED"
    assert env.db.tables["users"] == [row]
    malformed = env.client.post(BASE, json={**proof, "identity_token": "too-short-secret"})
    assert malformed.status_code == 422 and "too-short-secret" not in malformed.text


def make_event(kind, *, audience=apple_auth.ORIGINAL_CLIENT_ID, jti="event-id",
               email=None, signing_key=EVENT_KEY):
    now = int(datetime.now(timezone.utc).timestamp())
    details = {"type": kind, "sub": "test-apple-parent", "event_time": now}
    if email:
        details.update(email=email, is_private_email="true")
    return jwt.encode({"iss": apple_auth.ISSUER, "aud": audience, "iat": now, "jti": jti,
                       "events": details}, signing_key, algorithm="RS256", headers={"kid": "fake"})


@pytest.mark.parametrize("kind", ["consent-revoked", "account-delete", "account-deleted"])
def test_verified_event_invalidates_apple_sessions_only_and_keeps_account(env, apple_routes, monkeypatch, kind):
    monkeypatch.setenv("APPLE_SIGNIN_NOTIFICATIONS_ENABLED", "1")
    row = existing(env, apple_subject=apple_routes.subject)
    login = env.client.post(BASE, json=issue(env)).json()
    apple_headers = {"Authorization": f"Bearer {login['access_token']}"}
    password_headers = auth(row["id"])
    assert env.client.get("/api/auth/me", headers=apple_headers).status_code == 200
    event = {"payload": make_event(kind)}
    assert env.client.post(f"{BASE}/notifications", json=event).status_code == 200
    assert env.client.post(f"{BASE}/notifications", json=event).status_code == 200
    assert len(env.db.tables["users"]) == 1 and row["apple_session_generation"] == 1
    assert row["apple_refresh_ciphertext"] == ""
    assert env.client.get("/api/auth/me", headers=apple_headers).status_code == 401
    me = env.client.get("/api/auth/me", headers=password_headers)
    assert me.status_code == 200 and me.json()["apple_sign_in_linked"] is False
    assert env.client.post(BASE, json=issue(env)).status_code == 401
    apple_routes.authorized_at = row["apple_revoked_at"] + 1000
    resumed = env.client.post(BASE, json=issue(env))
    assert resumed.status_code == 200 and resumed.json()["user"]["id"] == row["id"]
    assert env.client.get("/api/auth/me", headers=apple_headers).status_code == 401


def test_wrong_audience_and_email_disabled_do_not_claim_mail_was_sent(env, apple_routes, monkeypatch):
    monkeypatch.setenv("APPLE_SIGNIN_NOTIFICATIONS_ENABLED", "1")
    row = existing(env, apple_subject=apple_routes.subject)
    route = f"{BASE}/notifications"
    wrong = env.client.post(route, json={"payload": make_event("email-disabled", audience="other.app", email=APPLE_EMAIL)})
    assert wrong.status_code == 401 and not env.db.tables.get("apple_event_receipts")
    disabled = make_event("email-disabled", jti="disabled", email=APPLE_EMAIL)
    assert env.client.post(route, json={"payload": disabled}).status_code == 200
    assert row["apple_relay_disabled"] is True
    requested = env.client.post("/api/auth/password/forgot", json={"email": APPLE_EMAIL})
    assert requested.status_code == 200 and not env.sent
    enabled = make_event("email-enabled", jti="enabled", email=APPLE_EMAIL)
    assert env.client.post(route, json={"payload": enabled}).status_code == 200
    assert row["apple_relay_disabled"] is False
    assert env.client.post("/api/auth/password/forgot", json={"email": APPLE_EMAIL}).status_code == 200
    assert len(env.sent) == 1
