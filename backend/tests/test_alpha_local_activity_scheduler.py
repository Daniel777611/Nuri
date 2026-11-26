"""The Alpha preview's dedicated scheduler never needs a user session."""

from hashlib import sha256
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import alpha_local_activity_scheduler as scheduler, main, push_service
from backend.feed import local_activities


PATH = "/api/internal/alpha-local-activities/tick"
TOKEN = "a" * 64
AUTH = {"Authorization": f"Bearer {TOKEN}"}
OTHER_AUTH = {"Authorization": f"Bearer {'b' * 64}"}


class FixtureDb:
    enabled = False

    def __init__(self):
        self.reads = 0
        self.rpc_calls = []

    def table(self, name):
        assert name == scheduler.TABLE
        return self

    def select(self, fields):
        assert fields == "enabled,token_sha256"
        return self

    def eq(self, key, value):
        assert (key, value) == ("id", 1)
        return self

    def limit(self, count):
        assert count == 1
        return self

    def execute(self):
        self.reads += 1
        return SimpleNamespace(data=[{"enabled": self.enabled, "token_sha256": sha256(TOKEN.encode()).hexdigest()}])

    def rpc(self, name, payload):
        self.rpc_calls.append((name, payload))
        # Return one out-of-scope row to prove the app will not send it even if
        # a database RPC yields an unexpected result.
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[{"data": {"kind": "care"}}]))


@pytest.fixture
def rig(monkeypatch):
    db = FixtureDb()
    generated = []

    async def generate(actual_db):
        assert actual_db is db
        generated.append(True)
        return {"ok": True, "candidates": 1, "queued": 1}

    monkeypatch.setattr(scheduler.runtime, "alpha_features_available", lambda: True)
    monkeypatch.setattr(scheduler.runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(main.push_apns, "configured", lambda: True)
    monkeypatch.setattr(main.local_activities, "enabled", lambda: True)
    monkeypatch.setattr(main.local_activities, "supported_builds", lambda: frozenset({"com.example:12"}))
    monkeypatch.setattr(main, "_generate_local_activity_batch", generate)
    return db, generated, TestClient(main.app)


def test_invalid_credentials_and_non_alpha_do_not_run(rig, monkeypatch):
    db, generated, client = rig
    assert client.post(PATH, json={"action": "generate"}).status_code == 401
    assert db.reads == 0
    assert client.post(PATH, headers=OTHER_AUTH, json={"action": "dispatch"}).status_code == 401
    assert client.post(PATH, headers=OTHER_AUTH, json={"action": "dispatch_community"}).status_code == 401
    assert db.reads == 2
    monkeypatch.setattr(scheduler.runtime, "alpha_features_available", lambda: False)
    assert client.post(PATH, headers=AUTH, json={"action": "generate"}).status_code == 404
    assert client.post(PATH, headers=AUTH, json={"action": "dispatch_community"}).status_code == 404
    assert db.reads == 2 and not db.rpc_calls and not generated


def test_paused_status_has_no_queue_effect_and_active_actions_stay_separate(rig):
    db, generated, client = rig
    assert client.post(PATH, headers=AUTH, json={"action": "status"}).json() == {
        "ok": True, "scheduled": False, "feature": True, "compatible_build": True,
        "apns_configured": True,
    }
    for action in ("generate", "dispatch", "dispatch_community"):
        assert client.post(PATH, headers=AUTH, json={"action": action}).json() == {"ok": True, "state": "paused"}
    assert not db.rpc_calls and not generated
    db.enabled = True
    assert client.post(PATH, headers=AUTH, json={"action": "generate"}).json()["queued"] == 1
    assert generated == [True] and not db.rpc_calls
    assert client.post(PATH, headers=AUTH, json={"action": "dispatch"}).json()["claimed"] == 0
    assert db.rpc_calls == [("claim_due_local_activity_notifications", {"batch_size": 30})]
    assert generated == [True]


def test_community_dispatch_uses_its_rpc_independent_of_nearby_activities(rig, monkeypatch):
    db, generated, client = rig
    db.enabled = True
    monkeypatch.setattr(main.local_activities, "enabled", lambda: False)
    monkeypatch.setattr(main.local_activities, "supported_builds", frozenset)
    assert client.post(PATH, headers=AUTH, json={"action": "dispatch_community"}).json()["claimed"] == 0
    assert db.rpc_calls == [("claim_due_alpha_community_notifications", {"batch_size": 10})]
    assert not generated
    monkeypatch.setattr(main.push_apns, "configured", lambda: False)
    assert client.post(PATH, headers=AUTH, json={"action": "status"}).json()["apns_configured"] is False
    assert client.post(PATH, headers=AUTH, json={"action": "dispatch_community"}).json() == {
        "ok": True, "state": "apns_unconfigured",
    }
    assert len(db.rpc_calls) == 1


def test_fixed_city_probe_reads_no_family_or_queue(rig, monkeypatch):
    db, generated, client = rig
    seen = []

    async def discover(**kwargs):
        seen.append(kwargs)
        return [{
            "kind": "dated_event", "start_date": "2026-12-01",
            "source_url": "https://www.montereypark.ca.gov/m/calendar/event/detail/12345",
        }]

    monkeypatch.setattr(local_activities, "discover_local_activities", discover)
    result = client.post(PATH, headers=AUTH, json={"action": "probe"}).json()
    assert result == {
        "ok": True, "state": "ready", "dated_events": 1, "ongoing_resources": 0,
        "sources": [{
            "kind": "dated_event", "source_url": "https://www.montereypark.ca.gov/m/calendar/event/detail/12345",
            "start_date": "2026-12-01",
        }],
    }
    assert len(seen) == 1 and seen[0]["city"] == "Monterey Park"
    assert set(seen[0]) == {"city", "region", "country", "age_band", "locale", "today"}
    assert not db.rpc_calls and not generated
    # Callers cannot turn this verification route into an arbitrary search.
    assert client.post(PATH, headers=AUTH, json={"action": "probe", "city": "Other"}).status_code == 422
    assert len(seen) == 1


@pytest.mark.anyio
async def test_regular_dispatch_uses_its_original_rpc(monkeypatch):
    called = []

    def rpc(name, payload):
        called.append((name, payload))
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[]))

    db = SimpleNamespace(rpc=rpc)
    assert (await push_service.dispatch_due_notifications(db, batch_size=70))["claimed"] == 0
    assert called == [("claim_due_notifications", {"batch_size": 70})]
