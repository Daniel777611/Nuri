"""Isolated consumer account deletion / custom-JWT regressions.

No .env is read, no DNS/socket/SDK request is allowed, and every database
operation uses the fake below. Run this file, not the legacy live-API tests.
"""

from __future__ import annotations

import copy
import json
import os
import socket
from types import SimpleNamespace
from unittest.mock import patch

import dotenv
import pytest
from fastapi.testclient import TestClient

# Importing runtime normally invokes dotenv. Keep even collection isolated from
# local secrets; absent provider keys also mean SDK clients are not constructed.
with patch.object(dotenv, "load_dotenv", lambda *_a, **_k: False), patch.dict(os.environ, {}, clear=True):
    from backend import account_deletion, main, memstore, runtime


A = "10000000-0000-4000-8000-000000000001"
B = "10000000-0000-4000-8000-000000000002"
PASSWORD = "isolated-test-password"


def _test_hash(plain):
    # Fixture-only lower work factor: this tests bcrypt verification/contracts,
    # not its CPU cost. Production _hash_pw and its default work factor stay intact.
    return main.bcrypt.hashpw(plain.encode(), main.bcrypt.gensalt(rounds=4)).decode()


class MissingTable(Exception):
    code = "42P01"


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.operation = "select"
        self.filters = []
        self.maximum = None
        self.payload = None

    def select(self, *_args):
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def upsert(self, payload, **_kwargs):
        self.operation, self.payload = "upsert", copy.deepcopy(payload)
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def like(self, key, value):
        # Fixed names / hex hashes followed by %, not caller-supplied wildcards.
        assert value.endswith("%") and "%" not in value[:-1]
        self.filters.append(("like", key, value[:-1]))
        return self

    def limit(self, maximum):
        self.maximum = maximum
        return self

    def execute(self):
        self.db.calls.append((self.operation, self.table, list(self.filters)))
        if self.table in self.db.missing:
            raise MissingTable()
        if self.db.before:
            self.db.before(self)
        if (self.operation, self.table) in self.db.fail:
            raise RuntimeError("isolated dependency failure")
        rows = self.db.tables.setdefault(self.table, [])
        if self.operation == "upsert":
            existing = next((row for row in rows if row.get("key") == self.payload["key"]), None)
            if existing is None:
                rows.append(copy.deepcopy(self.payload))
            else:
                existing.update(self.payload)
            return SimpleNamespace(data=[copy.deepcopy(self.payload)])
        hits = [row for row in rows if all(
            row.get(key) == value if kind == "eq" else str(row.get(key, "")).startswith(value)
            for kind, key, value in self.filters
        )]
        if self.maximum is not None:
            hits = hits[:self.maximum]
        if self.operation == "delete":
            rows[:] = [row for row in rows if row not in hits]
            if self.table == "users":
                deleted_ids = {row["id"] for row in hits}
                deleted_sessions = {row["id"] for row in self.db.tables.get("chat_sessions", [])
                                    if row.get("user_id") in deleted_ids}
                for table in self.db.cascades:
                    self.db.tables[table][:] = [row for row in self.db.tables[table]
                                               if row.get("user_id") not in deleted_ids]
                self.db.tables["chat_messages"][:] = [row for row in self.db.tables["chat_messages"]
                                                       if row.get("session_id") not in deleted_sessions]
                if self.db.delete_timeout:
                    raise TimeoutError("isolated committed DELETE response lost")
        return SimpleNamespace(data=copy.deepcopy(hits))


class DB:
    def __init__(self):
        self.calls = []
        self.fail = set()
        self.missing = set()
        self.before = None
        self.delete_timeout = False
        hashed = _test_hash(PASSWORD)
        self.tables = {"users": [
            {"id": A, "email": "a@example.test", "hashed_password": hashed},
            {"id": B, "email": "b@example.test", "hashed_password": hashed},
        ]}
        self.cascades = {"children", "tasks", "chat_sessions", "normalized_inputs", "user_memories",
                         "follow_ups", "chat_turn_logs", "chat_message_feedback", "email_logs",
                         "user_visits", "daily_post_cards", "nuri_task_cards", "nuri_task_card_events",
                         "recommendation_events", "push_devices", "notification_preferences",
                         "notification_events", "billing_customers", "billing_subscriptions"}
        for table in self.cascades | {table for table, _optional in account_deletion._NON_CASCADE_TABLES}:
            self.tables[table] = [{"id": table + "-a", "user_id": A}, {"id": table + "-b", "user_id": B}]
        self.tables["chat_messages"] = [{"session_id": "chat_sessions-a"}, {"session_id": "chat_sessions-b"}]
        self.tables["email_codes"] = [{"email": "a@example.test"}, {"email": "b@example.test"}]
        self.tables["app_settings"] = [{"key": "feed_gen_mode", "value": "global"}]
        for uid in (A, B):
            for kind, key in account_deletion._setting_scopes(uid):
                self.tables["app_settings"].append({"key": key[:-1] + "test" if kind == "like" else key})
        self.tables["feed_cards"] = [{"id": "global-content"}]

    def table(self, table):
        return Query(self, table)

    @property
    def deletes(self):
        return [call for call in self.calls if call[0] == "delete"]


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("network/provider access forbidden in account-deletion mocks")
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(runtime, "create_client", forbidden)
    monkeypatch.setattr(runtime, "supabase_client", None)
    # Presence is simulated, never a real credential/client.
    monkeypatch.setattr(runtime, "SUPABASE_SERVICE_ROLE_KEY", "isolated-fake-server-role")
    for name in ("oai", "oai_async", "oai_fast"):
        if hasattr(runtime, name):
            monkeypatch.setattr(runtime, name, None)
        if hasattr(main, name):
            monkeypatch.setattr(main, name, None)
    memstore.clear_all()
    yield
    memstore.clear_all()


@pytest.fixture
def env(monkeypatch):
    db = DB()
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    return SimpleNamespace(db=db, client=TestClient(main.app),
                           headers={"Authorization": "Bearer " + main._make_token(A)})


def delete(env, **overrides):
    return env.client.request("DELETE", "/api/auth/account", headers=env.headers,
                              json={"confirmation": "DELETE", "password": PASSWORD, **overrides})


def code(response):
    return response.json()["detail"]["code"]


def test_success_only_deletes_caller_and_revokes_old_jwt(env):
    before_b = {table: [copy.deepcopy(row) for row in rows if row.get("user_id") == B]
                for table, rows in env.db.tables.items()}
    memstore.users_id.update({A: {"id": A}, B: {"id": B}})
    memstore.users_email.update({"a@example.test": {"id": A}, "b@example.test": {"id": B}})
    memstore.sessions.update({"a": {"user_id": A}, "b": {"user_id": B}})
    memstore.messages.update({"a": [{"text": "A"}], "b": [{"text": "B"}]})
    memstore.recommendation_snapshots[(A, "rec_a")] = {"user_id": A}
    memstore.recommendation_snapshots[(B, "rec_b")] = {"user_id": B}
    response = delete(env)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "account_deleted": True, "subscription_cancelled": False}
    assert env.db.deletes[-2][1] == "users"
    assert env.db.deletes[-1][1] == "app_settings"
    assert [row["id"] for row in env.db.tables["users"]] == [B]
    for table, rows in env.db.tables.items():
        assert not any(row.get("user_id") == A for row in rows)
        assert [row for row in rows if row.get("user_id") == B] == before_b[table]
    assert env.db.tables["email_codes"] == [{"email": "b@example.test"}]
    assert env.db.tables["chat_messages"] == [{"session_id": "chat_sessions-b"}]
    assert env.db.tables["feed_cards"] == [{"id": "global-content"}]
    assert len(env.db.tables["app_settings"]) == 5  # global + all B namespaces
    assert memstore.users_id == {B: {"id": B}}
    assert memstore.users_email == {"b@example.test": {"id": B}}
    assert memstore.messages == {"b": [{"text": "B"}]}
    assert (A, "rec_a") not in memstore.recommendation_snapshots
    assert (B, "rec_b") in memstore.recommendation_snapshots
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 401
    assert env.client.get("/api/auth/me", headers={"Authorization": "Bearer " + main._make_token(B)}).status_code == 200


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer invalid.signature.token"}])
def test_no_or_bad_token_cannot_delete(env, headers):
    response = env.client.request("DELETE", "/api/auth/account", headers=headers,
                                  json={"confirmation": "DELETE", "password": PASSWORD})
    assert response.status_code == 401
    assert env.db.deletes == []


def test_real_jwt_with_wrong_signature_is_rejected_before_storage(env):
    wrong_key_token = main.jwt.encode({"sub": A}, "isolated-wrong-test-signing-key", algorithm=main.JWT_ALG)
    response = env.client.request("DELETE", "/api/auth/account",
                                  headers={"Authorization": "Bearer " + wrong_key_token},
                                  json={"confirmation": "DELETE", "password": PASSWORD})
    assert response.status_code == 401
    assert env.db.calls == []


def test_valid_account_is_rechecked_on_each_protected_request(env):
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 200
    memstore.users_id[A] = {"id": A}
    env.db.tables["users"] = [row for row in env.db.tables["users"] if row["id"] != A]
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 401


@pytest.mark.parametrize("payload", [{"confirmation": "delete"}, {"confirmation": " DELETE"},
                                     {"password": ""}, {"password": "x" * 73},
                                     {"password": "界" * 25}, {"password": 123},
                                     {"user_id": B}, {"email": "b@example.test"}])
def test_strict_confirmation_password_and_no_target_fields(env, payload):
    response = delete(env, **payload)
    assert response.status_code == 422
    assert PASSWORD not in response.text
    if isinstance(payload.get("password"), str) and payload["password"]:
        assert payload["password"] not in response.text
    assert env.db.deletes == []


def test_wrong_password_403_retains_valid_session(env):
    response = delete(env, password="wrong-isolated-password")
    assert response.status_code == 403
    assert code(response) == "ACCOUNT_REAUTH_FAILED"
    assert env.db.deletes == []
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 200


@pytest.mark.parametrize("table", ["favorites", "collections", "llm_call_logs", "nuri_turn_outcomes",
                                  "nuri_turn_traces", "fix_reviewers", "app_settings", "email_codes"])
def test_dependency_preflight_failure_performs_zero_deletes(env, table):
    env.db.fail.add(("select", table))
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_UNAVAILABLE"
    assert response.json()["detail"]["deletion_state"] == "not_started"
    assert env.db.deletes == []
    assert len(env.db.tables["users"]) == 2


def test_optional_missing_rollout_tables_have_no_data_to_remove(env):
    env.db.missing.update({"llm_call_logs", "nuri_turn_outcomes", "nuri_turn_traces", "fix_reviewers"})
    assert delete(env).status_code == 200
    assert not any(call[1] in env.db.missing for call in env.db.deletes)


@pytest.mark.parametrize("table", ["favorites", "collections", "app_settings", "email_codes"])
def test_missing_required_table_does_not_begin_deletion(env, table):
    env.db.missing.add(table)
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_UNAVAILABLE"
    assert env.db.deletes == []


def test_anon_only_storage_cannot_claim_success(env, monkeypatch):
    monkeypatch.setattr(runtime, "SUPABASE_SERVICE_ROLE_KEY", None)
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_UNAVAILABLE"
    assert response.json()["detail"]["deletion_state"] == "not_started"
    assert env.db.deletes == []
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 200


def test_privacy_tombstone_write_failure_performs_zero_deletes(env):
    env.db.fail.add(("upsert", "app_settings"))
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_UNAVAILABLE"
    assert env.db.deletes == []
    assert len(env.db.tables["users"]) == 2
    assert A not in memstore.privacy


def test_privacy_tombstone_must_be_read_back_before_any_delete(env):
    def fail_tombstone_read(query):
        if query.table == "app_settings" and query.operation == "select":
            if any(call[:2] == ("upsert", "app_settings") for call in env.db.calls):
                raise RuntimeError("isolated privacy readback failure")
    env.db.before = fail_tombstone_read
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_UNAVAILABLE"
    assert env.db.deletes == []


def test_final_privacy_cleanup_failure_is_not_false_success(env):
    key = main.stores.privacy_storage_key(A)
    def fail_final_cleanup(query):
        if query.table == "app_settings" and query.operation == "delete" and query.filters == [("eq", "key", key)]:
            raise RuntimeError("isolated final privacy cleanup failure")
    env.db.before = fail_final_cleanup
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_UNCONFIRMED"
    assert not any(row["id"] == A for row in env.db.tables["users"])
    privacy = next(row for row in env.db.tables["app_settings"] if row["key"] == key)
    assert all(json.loads(privacy["value"])[flag] is False for flag in account_deletion._PRIVACY_FLAGS)
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 401
    assert A not in memstore.privacy


def test_final_privacy_cleanup_readback_failure_reports_unknown(env):
    key = main.stores.privacy_storage_key(A)
    def fail_final_read(query):
        if query.table == "app_settings" and query.operation == "select":
            if any(call[0] == "delete" and call[1] == "users" for call in env.db.calls):
                raise RuntimeError("isolated final privacy readback failure")
    env.db.before = fail_final_read
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_UNCONFIRMED"
    assert not any(row["key"] == key for row in env.db.tables["app_settings"])
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 401


@pytest.mark.parametrize("table", ["favorites", "collections", "app_settings", "email_codes", "users"])
def test_mid_delete_failure_is_partial_not_false_success(env, table):
    env.db.fail.add(("delete", table))
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_INCOMPLETE"
    assert response.json()["detail"]["deletion_state"] == "partial"
    assert len(env.db.tables["users"]) == 2
    privacy = next(row for row in env.db.tables["app_settings"]
                   if row["key"] == main.stores.privacy_storage_key(A))
    assert all(json.loads(privacy["value"])[key] is False for key in account_deletion._PRIVACY_FLAGS)
    assert all(memstore.privacy[A][key] is False for key in account_deletion._PRIVACY_FLAGS)
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 200
    env.db.fail.clear()
    assert delete(env).status_code == 200  # explicit user retry is idempotent cleanup


def test_user_delete_committed_but_response_timed_out_is_confirmed(env):
    env.db.delete_timeout = True
    assert delete(env).status_code == 200
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 401


def test_user_delete_result_unavailable_reports_unknown(env):
    env.db.delete_timeout = True
    def fail_readback(query):
        if query.table == "users" and query.operation == "select" and env.db.deletes:
            if env.db.deletes[-1][1] == "users":
                raise TimeoutError("isolated readback unavailable")
    env.db.before = fail_readback
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_UNCONFIRMED"
    assert response.json()["detail"]["deletion_state"] == "unknown"
    assert not any(row["id"] == A for row in env.db.tables["users"])
    env.db.before = None
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 401


@pytest.mark.parametrize("configured", [False, True])
def test_auth_storage_absent_or_failed_is_503_even_with_warm_cache(env, monkeypatch, configured):
    memstore.users_id[A] = {"id": A}
    if configured:
        env.db.fail.add(("select", "users"))
    else:
        monkeypatch.setattr(runtime, "get_supabase", lambda: None)
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 503
    assert delete(env).status_code == 503
    assert env.db.deletes == []


def test_optional_uid_deleted_token_rejected_before_cache_or_ai(env, monkeypatch):
    env.db.tables["users"] = [row for row in env.db.tables["users"] if row["id"] != A]
    memstore.recommendation_snapshots[(A, "rec_old")] = {"user_id": A}
    async def forbidden(*_args, **_kwargs):
        raise AssertionError("deleted optional-auth caller reached personalized cache")
    monkeypatch.setattr(main.stores, "get_snapshot", forbidden)
    response = env.client.get("/api/feed/old/detail?recommendation_id=rec_old", headers=env.headers)
    assert response.status_code == 401


def test_same_email_new_uid_cannot_revive_old_token(env):
    assert delete(env).status_code == 200
    env.db.tables["users"].append({"id": "10000000-0000-4000-8000-000000000003",
                                  "email": "a@example.test", "hashed_password": _test_hash(PASSWORD)})
    assert env.client.get("/api/auth/me", headers=env.headers).status_code == 401


def test_password_reset_during_preflight_performs_zero_delete(env):
    def reset_during_preflight(query):
        if query.table == "email_codes" and query.operation == "select":
            env.db.tables["users"][0]["hashed_password"] = _test_hash("new-isolated-password")
    env.db.before = reset_during_preflight
    response = delete(env)
    assert response.status_code == 403
    assert env.db.deletes == []


def test_password_reset_after_preflight_does_not_delete_identity(env):
    def reset_during_cleanup(query):
        if query.table == "email_codes" and query.operation == "delete":
            env.db.tables["users"][0]["hashed_password"] = _test_hash("new-isolated-password")
    env.db.before = reset_during_cleanup
    response = delete(env)
    assert response.status_code == 503
    assert code(response) == "ACCOUNT_DELETION_INCOMPLETE"
    assert len(env.db.tables["users"]) == 2
