"""Exercise the authenticated city-to-card-to-notification path with fake services."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import Header
from fastapi.testclient import TestClient

from backend import main, push_service
from backend.feed import local_activities, local_activity_service as activities

NOW = datetime(2026, 11, 24, 15, tzinfo=timezone.utc)
CITY = {"enabled": True, "city": "Austin", "region": "TX", "country": "us"}
BUILD = {"platform": "ios", "bundle_id": "com.example.alpha", "build_number": "1100"}
PREFS = {"time_zone": "America/Chicago", "enabled": True, "care_enabled": False, "max_per_day": 4}
PATH = "/api/notifications/local-activities/preferences"
FEED = "/api/feed/local-activities"
PARENT_A = {"X-Test-Parent": "family-a"}
PARENT_B = {"X-Test-Parent": "family-b"}


class FixtureQuery:
    def __init__(self, rows, table):
        self.rows = rows
        self.table = table
        self.predicates = []
        self.mutation = None
        self.limit_count = None
        self.ordering = []

    def select(self, *_columns, **_kwargs):
        return self

    def _filter(self, field, check):
        def predicate(row):
            parent, sep, key = field.partition("->>")
            value = (row.get(parent) or {}).get(key) if sep else row.get(parent)
            return check(value)

        self.predicates.append(predicate)
        return self

    def eq(self, field, value):
        return self._filter(field, lambda current: current == value)

    def in_(self, field, values):
        return self._filter(field, lambda current: current in values)

    def lte(self, field, value):
        return self._filter(field, lambda current: current is not None and current <= value)

    def gte(self, field, value):
        return self._filter(field, lambda current: current is not None and current >= value)

    def order(self, field, desc=False, nullsfirst=False):
        self.ordering.append((field, desc, nullsfirst))
        return self

    def limit(self, n):
        self.limit_count = n
        return self

    def update(self, patch):
        self.mutation = "update", patch, None, False
        return self

    def upsert(self, patch, on_conflict, ignore_duplicates=False):
        self.mutation = "upsert", patch, on_conflict, ignore_duplicates
        return self

    def execute(self):
        found = [row for row in self.rows if all(f(row) for f in self.predicates)]
        for field, desc, nullsfirst in reversed(self.ordering):
            found.sort(key=lambda row: ((row.get(field) is None) != nullsfirst, row.get(field)), reverse=desc)
        found = found[: self.limit_count]
        if self.mutation:
            operation, patch, key, ignore_duplicates = self.mutation
            if operation == "upsert":
                found = [row for row in self.rows if row.get(key) == patch[key]]
                if found and ignore_duplicates:
                    found = []
                elif not found:
                    defaults = {"next_search_at": "1970-01-01T00:00:00+00:00"} if self.table == activities.TABLE else {
                        "id": str(uuid4()),
                    }
                    found = [defaults]
                    self.rows.extend(found)
                    found[0].update(deepcopy(patch))
                else:
                    found[0].update(deepcopy(patch))
            else:
                for row in found:
                    row.update(deepcopy(patch))
        return SimpleNamespace(data=deepcopy(found), count=len(found))


class FixtureDb:
    def __init__(self):
        self.rows = {
            "notification_preferences": [{"user_id": "family-a", **PREFS}],
            "push_devices": [
                {"id": "current", "user_id": "family-a", "is_active": True, "permission_status": "authorized",
                 "apns_token": "fixture-current", "apns_environment": "sandbox", **BUILD},
                {"id": "old", "user_id": "family-a", "is_active": True, "permission_status": "authorized",
                 "apns_token": "fixture-old", "apns_environment": "sandbox", **BUILD, "build_number": "1096"},
            ],
        }
        self.now = NOW

    def table(self, name):
        return FixtureQuery(self.rows.setdefault(name, []), name)

    def rpc(self, name, _args):
        assert name == "claim_due_notifications"
        return self.table("notification_events").eq("status", "queued").lte(
            "scheduled_at", self.now.isoformat(),
        ).update({"status": "processing", "attempt_count": 1})


@pytest.fixture
def rig(monkeypatch):
    db = FixtureDb()
    requests = []

    async def profile(_uid):
        return {}, [
            {"id": "baby", "nickname": "Sibling A", "birth_date": "2026-06-01"},
            {"id": "older", "nickname": "Sibling B", "birth_date": "2018-01-15"},
            {"id": "due", "birth_date": "2027-03-03"},
        ]

    async def discover(**kwargs):
        requests.append(kwargs)
        band = kwargs["age_band"]
        scheduled = (kwargs["today"] + timedelta(days=2)).isoformat()
        return [{
            "id": band, "kind": "dated_event", "title": f"Library activity for {band}",
            "summary": "Storytime for families.", "description": "Stories, songs and activities for families.",
            "source_url": f"https://www.fortbendlibraries.gov/event/fixture-{band.replace('_', '-')}-12345",
            "event_source_verified": True, "source_label": "Public library",
            "location_label": kwargs["city"], "venue_name": "Library", "address": f"311 Main St, {kwargs['city']}",
            "start_date": scheduled, "end_date": scheduled, "time_zone": "America/Chicago",
            "starts_at": f"{scheduled}T10:00:00-06:00", "ends_at": f"{scheduled}T11:00:00-06:00",
            "age_label": "Infants" if band == "infant" else "School-age children",
            "_age_ranges": ((0, 11),) if band == "infant" else ((60, 155),),
        }]

    async def privacy(_uid, **_kwargs):
        return {"language": "en"}

    async def clock(_sb, _uid):
        return db.now, db.now.date()

    def identity(x_test_parent: str = Header()):
        return x_test_parent

    monkeypatch.setenv("NURI_LOCAL_ACTIVITIES_ENABLED", "1")
    monkeypatch.setenv("NURI_LOCAL_ACTIVITY_PUSH_BUILDS", "com.example.alpha:1100")
    monkeypatch.setattr(main, "_require_push_storage", lambda: db)
    monkeypatch.setattr(main, "_local_activity_clock", clock)
    monkeypatch.setattr(activities.family_store, "load_profile", profile)
    monkeypatch.setattr(main.stores, "get_privacy", privacy)
    monkeypatch.setattr(local_activities, "discover_local_activities", discover)
    monkeypatch.setitem(main.app.dependency_overrides, main._req_uid, identity)
    return db, requests, TestClient(main.app)


def test_deployed_opt_in_is_scoped_to_alpha_testing_database(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv("NURI_LOCAL_ACTIVITIES_ENABLED", "1")
    monkeypatch.setenv("NURI_ALPHA_FEATURES", "1")
    monkeypatch.setattr(activities.runtime, "SUPABASE_URL", "https://other.supabase.co")
    monkeypatch.setattr(activities.runtime, "SUPABASE_SERVICE_ROLE_KEY", "test-placeholder")
    assert not activities.enabled()
    assert not activities.supported_builds()

    monkeypatch.setattr(activities.runtime, "SUPABASE_URL", "https://kyxnnrmyzmdutqylsxpw.supabase.co")
    monkeypatch.delenv("NURI_LOCAL_ACTIVITIES_ENABLED", raising=False)
    monkeypatch.delenv("NURI_LOCAL_ACTIVITY_PUSH_BUILDS", raising=False)
    assert activities.enabled()
    assert activities.supported_builds() == {
        "com.ordashtech.nuri.beta:1097", "com.ordashtech.nuri.beta:1098",
        "com.ordashtech.nuri.beta:1099", "com.ordashtech.nuri.beta:1102",
    }

    monkeypatch.setenv("NURI_LOCAL_ACTIVITY_PUSH_BUILDS", "com.ordashtech.nuri.beta:1097,com.example.pro:1097")
    assert activities.supported_builds() == {"com.ordashtech.nuri.beta:1097"}
    monkeypatch.setenv("NURI_LOCAL_ACTIVITIES_ENABLED", "0")
    assert not activities.enabled()
    assert not activities.supported_builds()


def test_two_child_bands_and_account_scoped_revocation(rig):
    db, requests, client = rig
    assert client.get(FEED, headers=PARENT_A).json() == {"state": "disabled", "items": []}
    assert requests == []
    assert client.patch(PATH, headers=PARENT_A, json={**CITY, "latitude": 30}).status_code == 422
    assert client.patch(PATH, headers=PARENT_A, json={**CITY, "city": "123 Private St"}).status_code == 422
    assert client.patch(PATH, headers=PARENT_A, json=CITY).json() == {**CITY, "country": "US"}
    first = client.get(FEED, headers=PARENT_A).json()
    assert first["state"] == "ready"
    assert {q["age_band"] for q in requests} == {"infant", "school_age"}
    assert all(set(q) == {"city", "region", "country", "age_band", "locale", "today", "limit"} for q in requests)
    assert first == client.get(FEED, headers=PARENT_A).json()
    assert len(requests) == 2
    item = first["items"][0]
    assert "_valid_through" not in item
    assert "_age_ranges" not in item
    assert "matches your child" in item["match_reason"]
    url = f"{FEED}/{item['id']}"
    assert client.get(url, headers=PARENT_A).json() == item
    assert client.get(url, headers=PARENT_B).status_code == 404
    assert client.patch(PATH, headers=PARENT_A, json={"enabled": False}).json() == {
        "enabled": False, "city": None, "region": None, "country": None,
    }
    assert client.get(url, headers=PARENT_A).status_code == 404
    assert db.rows[activities.TABLE][0]["snapshot"] == {}


@pytest.mark.anyio
async def test_snapshot_without_organizer_date_verification_is_replaced(rig):
    db, requests, client = rig
    client.patch(PATH, headers=PARENT_A, json=CITY)
    first = client.get(FEED, headers=PARENT_A).json()
    assert first["state"] == "ready"
    cache = db.rows[activities.TABLE][0]
    cache["snapshot"].pop("format")
    old_item = first["items"][0]["id"]
    assert await activities.find_activity(db, "family-a", old_item, now=NOW, day=NOW.date()) is None
    cache["next_search_at"] = "-infinity"
    assert client.get(FEED, headers=PARENT_A).json() == first
    assert len(requests) == 4


@pytest.mark.anyio
async def test_revocation_during_search_does_not_persist_or_return_old_results(rig, monkeypatch):
    db, _, _client = rig
    original = local_activities.discover_local_activities
    await activities.configure(db, "family-a", activities.AreaPatch(**CITY))
    revoked = False

    async def revoke(**kwargs):
        nonlocal revoked
        if not revoked:
            revoked = True
            await activities.configure(db, "family-a", activities.AreaPatch(enabled=False))
        return await original(**kwargs)

    monkeypatch.setattr(local_activities, "discover_local_activities", revoke)
    result = await activities.recommendations(db, "family-a", now=NOW, day=NOW.date(), locale="en")
    assert result["state"] == "unavailable" and not result["items"]
    assert (await activities.load_area(db, "family-a"))["snapshot"] == {}


@pytest.mark.anyio
async def test_schedule_consent_and_installation_checked_again_at_delivery(rig, monkeypatch):
    db, _, client = rig
    received = []

    async def deliver(**kwargs):
        received.append(kwargs)
        return SimpleNamespace(accepted=True, apns_id="test-delivery", http_status=200,
                               reason="", latency_ms=1, deactivate_token=False, retryable=False)

    monkeypatch.setattr(push_service, "_SENDERS", {"ios": SimpleNamespace(configured=lambda: True, send_alert=deliver)})
    await activities.configure(db, "family-a", activities.AreaPatch(**CITY))
    assert await push_service.generate_local_activity_event(db, "family-a", now=NOW + timedelta(days=1)) is None
    queued = await push_service.generate_local_activity_event(db, "family-a", now=NOW)
    assert await push_service.generate_local_activity_event(db, "family-a", now=NOW) is None
    assert queued["scheduled_at"] == "2026-11-24T22:30:00+00:00"
    assert queued["expires_at"] == "2026-11-25T06:00:00+00:00"
    assert "Austin" not in queued["title"] + queued["body"]

    db.now = datetime.fromisoformat(queued["scheduled_at"])
    counters = await push_service.dispatch_due_notifications(db, now=db.now)
    assert counters["sent"] == 1
    assert [payload["device_token"] for payload in received] == ["fixture-current"]
    assert received[0]["data"] == {"kind": "local_activity"}
    row = client.get(f"/api/notifications/{queued['id']}", headers=PARENT_A).json()
    assert row["local_activity_id"] == queued["data"]["local_activity_id"]
    assert client.get(f"/api/notifications/{queued['id']}", headers=PARENT_B).status_code == 404
    assert client.post(f"/api/notifications/{queued['id']}/open", headers=PARENT_A).status_code == 409

    # Friday can choose a new result; consent revocation invalidates the queue.
    later = NOW + timedelta(days=3)
    discover = local_activities.discover_local_activities
    async def friday(**kwargs):
        return [{**item, "id": f"friday-{item['id']}"} for item in await discover(**kwargs)]
    monkeypatch.setattr(local_activities, "discover_local_activities", friday)
    event = await push_service.generate_local_activity_event(db, "family-a", now=later)
    assert event
    await activities.configure(db, "family-a", activities.AreaPatch(enabled=False))
    db.now = datetime.fromisoformat(event["scheduled_at"])
    counters = await push_service.dispatch_due_notifications(db, now=db.now)
    assert counters["skipped_prefs"] == 1
    assert len(received) == 1
    old = client.get(f"/api/notifications/{queued['id']}", headers=PARENT_A).json()
    assert old["local_activity_id"] is None


@pytest.mark.anyio
async def test_utc_job_prepares_the_next_afternoon_in_taipei(rig):
    db, _, _ = rig
    db.rows["notification_preferences"][0]["time_zone"] = "Asia/Taipei"
    monday_late_local = NOW - timedelta(days=1)
    await activities.configure(db, "family-a", activities.AreaPatch(
        enabled=True, city="臺北市", country="TW",
    ))
    event = await push_service.generate_local_activity_event(db, "family-a", now=monday_late_local)
    assert event["scheduled_at"] == "2026-11-24T08:30:00+00:00"
    assert event["expires_at"] == "2026-11-24T16:00:00+00:00"
    assert await push_service.generate_local_activity_event(db, "family-a", now=NOW) is None


def test_explicit_locale_reaches_public_search_and_city_change_starts_fresh(rig):
    _, requests, client = rig
    client.patch(PATH, headers=PARENT_A, json=CITY)
    old = client.get(FEED + "?locale=zh-TW", headers=PARENT_A).json()["items"][0]
    assert all(call["locale"] == "zh-TW" for call in requests)
    changed = {**CITY, "city": "Houston"}
    assert client.patch(PATH, headers=PARENT_A, json=changed).status_code == 200
    assert client.get(f"{FEED}/{old['id']}", headers=PARENT_A).status_code == 404
    new = client.get(FEED, headers=PARENT_A).json()
    assert new["state"] == "ready"
    assert all(card["location_label"] == "Houston" for card in new["items"])


def test_local_cron_only_scans_opted_in_accounts_and_requires_auth(rig, monkeypatch):
    from hashlib import sha256

    from backend import alpha_local_activity_scheduler as scheduler

    db, _, client = rig
    client.patch(PATH, headers=PARENT_A, json=CITY)
    client.patch(PATH, headers=PARENT_B, json=CITY)
    client.patch(PATH, headers=PARENT_A, json={"enabled": False})
    scanned = []

    async def generate(store, uid, *, now):
        assert store is db
        scanned.append(uid)
        return {"id": "queued"}

    token = "a" * 64
    db.rows[scheduler.TABLE] = [{
        "id": 1, "enabled": True, "token_sha256": sha256(token.encode()).hexdigest(),
    }]
    monkeypatch.setenv("NURI_LOCAL_ACTIVITY_PUSH_BUILDS", "com.ordashtech.nuri.beta:1097")
    monkeypatch.setattr(scheduler.runtime, "alpha_features_available", lambda: True)
    monkeypatch.setattr(scheduler.runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(push_service, "generate_local_activity_event", generate)
    endpoint = "/api/internal/alpha-local-activities/tick"
    body = {"action": "generate"}
    assert client.post(endpoint, json=body).status_code == 401
    assert client.post(endpoint, headers={"Authorization": f"Bearer {token}"}, json=body).json() == {
        "ok": True, "candidates": 1, "queued": 1,
    }
    assert scanned == ["family-b"]
