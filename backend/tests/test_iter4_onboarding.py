"""Iteration 4: Onboarding backend tests

Tests:
- POST /api/auth/register accepts ONLY {email,password} (no other required fields)
- Register response includes onboarding_completed=false
- PUT /api/auth/me persists all new onboarding fields
- GET /api/auth/me returns persisted onboarding fields
- Legacy test user (test@example.com) has onboarding_completed=False
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    BASE_URL = os.environ.get("EXPO_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL not set"

API = f"{BASE_URL}/api"


@pytest.fixture
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture
def new_user(client):
    """Register a fresh user (email+password only) and return (token, user)."""
    email = f"TEST_e2e_{int(time.time() * 1000)}@x.com"
    r = client.post(f"{API}/auth/register", json={"email": email, "password": "test1234"})
    assert r.status_code == 201, r.text
    body = r.json()
    return body["access_token"], body["user"], email


# ---------- Register minimal payload ----------
class TestRegisterMinimal:
    def test_register_only_email_password(self, client):
        email = f"TEST_min_{int(time.time() * 1000)}@x.com"
        r = client.post(
            f"{API}/auth/register",
            json={"email": email, "password": "test1234"},
        )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["token_type"] == "bearer"
        assert body["access_token"]
        u = body["user"]
        assert u["email"] == email.lower()
        assert u["onboarding_completed"] is False
        # New fields default empty
        assert u["nickname"] == ""
        assert u["city"] == ""
        assert u["top_concerns"] == []
        assert u["concern_other"] == ""
        assert u["hobbies"] == ""
        assert u["help_preference"] == ""
        assert u["info_source"] == ""
        assert u["content_frequency"] == ""

    def test_register_short_password_rejected(self, client):
        r = client.post(
            f"{API}/auth/register",
            json={"email": f"TEST_short_{int(time.time()*1000)}@x.com", "password": "123"},
        )
        assert r.status_code == 422

    def test_register_duplicate_400(self, client):
        email = f"TEST_dup_{int(time.time()*1000)}@x.com"
        r1 = client.post(f"{API}/auth/register", json={"email": email, "password": "test1234"})
        assert r1.status_code == 201
        r2 = client.post(f"{API}/auth/register", json={"email": email, "password": "test1234"})
        assert r2.status_code == 400


# ---------- PUT /api/auth/me — full onboarding payload ----------
class TestOnboardingPersistence:
    def test_put_me_persists_all_onboarding_fields(self, client, new_user):
        token, user, _email = new_user
        h = {"Authorization": f"Bearer {token}"}
        payload = {
            "nickname": "小满妈",
            "city": "San Francisco",
            "top_concerns": ["sleep", "food", "other"],
            "concern_other": "夜醒频繁怎么办",
            "hobbies": "看剧、健身",
            "help_preference": "actionable",
            "info_source": "expert",
            "content_frequency": "weekly_2_3",
            "onboarding_completed": True,
        }
        r = client.put(f"{API}/auth/me", headers=h, json=payload)
        assert r.status_code == 200, r.text
        u = r.json()
        assert u["nickname"] == "小满妈"
        assert u["city"] == "San Francisco"
        assert u["top_concerns"] == ["sleep", "food", "other"]
        assert u["concern_other"] == "夜醒频繁怎么办"
        assert u["hobbies"] == "看剧、健身"
        assert u["help_preference"] == "actionable"
        assert u["info_source"] == "expert"
        assert u["content_frequency"] == "weekly_2_3"
        assert u["onboarding_completed"] is True

        # GET verifies persistence
        g = client.get(f"{API}/auth/me", headers=h)
        assert g.status_code == 200
        gu = g.json()
        assert gu["nickname"] == "小满妈"
        assert gu["top_concerns"] == ["sleep", "food", "other"]
        assert gu["concern_other"] == "夜醒频繁怎么办"
        assert gu["hobbies"] == "看剧、健身"
        assert gu["help_preference"] == "actionable"
        assert gu["info_source"] == "expert"
        assert gu["content_frequency"] == "weekly_2_3"
        assert gu["onboarding_completed"] is True

    def test_put_me_accepts_arbitrary_concern_strings(self, client, new_user):
        """top_concerns is List[str] — any string should be accepted (per PRD)."""
        token, _u, _e = new_user
        h = {"Authorization": f"Bearer {token}"}
        r = client.put(
            f"{API}/auth/me",
            headers=h,
            json={"top_concerns": ["custom_x", "another_thing", "睡眠"]},
        )
        assert r.status_code == 200
        assert r.json()["top_concerns"] == ["custom_x", "another_thing", "睡眠"]

    def test_put_me_partial_update_preserves_other_fields(self, client, new_user):
        token, _u, _e = new_user
        h = {"Authorization": f"Bearer {token}"}
        # first: set some fields
        r1 = client.put(f"{API}/auth/me", headers=h, json={"nickname": "A", "city": "SF"})
        assert r1.status_code == 200
        # second: only update hobbies
        r2 = client.put(f"{API}/auth/me", headers=h, json={"hobbies": "跑步"})
        assert r2.status_code == 200
        gu = r2.json()
        assert gu["nickname"] == "A"
        assert gu["city"] == "SF"
        assert gu["hobbies"] == "跑步"

    def test_put_me_skip_step3_only_updates_onboarding_flag(self, client, new_user):
        """Simulates: user fills step1+2, skips step3+4 (only sets onboarding_completed)."""
        token, _u, _e = new_user
        h = {"Authorization": f"Bearer {token}"}
        # step1+2 not actually a PUT for child, but style-wise: only send flag
        r = client.put(f"{API}/auth/me", headers=h, json={
            "nickname": "小明爸",
            "city": "多伦多",
            "top_concerns": [],
            "onboarding_completed": True,
        })
        assert r.status_code == 200
        u = r.json()
        assert u["onboarding_completed"] is True
        assert u["hobbies"] == ""
        assert u["help_preference"] == ""

    def test_put_me_requires_auth(self, client):
        r = client.put(f"{API}/auth/me", json={"nickname": "x"})
        assert r.status_code == 401


# ---------- Legacy test user ----------
class TestLegacyUser:
    def test_legacy_user_login_and_onboarding_flag(self, client):
        r = client.post(f"{API}/auth/login", json={
            "email": "test@example.com", "password": "test1234"
        })
        if r.status_code != 200:
            pytest.skip(f"Legacy test user not seeded: {r.status_code} {r.text}")
        body = r.json()
        assert body["access_token"]
        # onboarding_completed should be False so login routes to /onboarding
        assert body["user"]["onboarding_completed"] is False, \
            "Legacy test user must have onboarding_completed=False to trigger prefill flow"


# ---------- Full end-to-end sim ----------
class TestOnboardingE2E:
    def test_new_user_full_flow(self, client):
        # 1. Register
        email = f"TEST_flow_{int(time.time()*1000)}@x.com"
        rr = client.post(f"{API}/auth/register",
                         json={"email": email, "password": "test1234"})
        assert rr.status_code == 201
        token = rr.json()["access_token"]
        h = {"Authorization": f"Bearer {token}"}

        # 2. Step1 - create child
        cr = client.post(f"{API}/children", headers=h, json={
            "nickname": "小满", "birth_date": "2023-06-01",
        })
        assert cr.status_code == 200
        child = cr.json()
        assert child["nickname"] == "小满"

        # 3. Step2+ → PUT /auth/me
        up = client.put(f"{API}/auth/me", headers=h, json={
            "nickname": "小满妈",
            "city": "SF",
            "top_concerns": ["sleep"],
            "concern_other": "",
            "hobbies": "",
            "help_preference": "",
            "info_source": "",
            "content_frequency": "",
            "onboarding_completed": True,
        })
        assert up.status_code == 200
        assert up.json()["onboarding_completed"] is True

        # 4. Verify children scoped to user
        gc = client.get(f"{API}/children", headers=h)
        assert gc.status_code == 200
        names = [c["nickname"] for c in gc.json()]
        assert "小满" in names
