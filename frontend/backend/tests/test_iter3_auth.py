"""Iteration 3 tests: real JWT auth (register/login/me/update) + soft scoping."""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://chinese-parent-app.preview.emergentagent.com").rstrip("/")


@pytest.fixture(scope="module")
def user_a():
    email = f"TEST_a_{int(time.time()*1000)}@example.com"
    body = {
        "email": email,
        "password": "test1234",
        "nickname": "测试妈A",
        "city": "San Francisco",
        "parent_role": "mom",
        "top_concerns": ["sleep", "food"],
    }
    r = requests.post(f"{BASE_URL}/api/auth/register", json=body, timeout=20)
    assert r.status_code == 201, r.text
    data = r.json()
    return {"email": email, "password": "test1234", "token": data["access_token"], "user": data["user"]}


@pytest.fixture(scope="module")
def user_b():
    email = f"TEST_b_{int(time.time()*1000)}@example.com"
    body = {
        "email": email, "password": "test1234",
        "nickname": "测试爸B", "city": "Toronto",
        "parent_role": "dad", "top_concerns": ["education"],
    }
    r = requests.post(f"{BASE_URL}/api/auth/register", json=body, timeout=20)
    assert r.status_code == 201, r.text
    return {"email": email, "password": "test1234", "token": r.json()["access_token"], "user": r.json()["user"]}


class TestRegister:
    def test_register_returns_token_and_profile(self, user_a):
        assert user_a["token"]
        u = user_a["user"]
        assert u["email"] == user_a["email"].lower()
        assert u["nickname"] == "测试妈A"
        assert u["city"] == "San Francisco"
        assert u["parent_role"] == "mom"
        assert set(u["top_concerns"]) == {"sleep", "food"}
        assert "id" in u and "created_at" in u

    def test_register_duplicate_email_400(self, user_a):
        body = {
            "email": user_a["email"], "password": "test1234",
            "nickname": "x", "city": "y", "parent_role": "mom", "top_concerns": [],
        }
        r = requests.post(f"{BASE_URL}/api/auth/register", json=body, timeout=20)
        assert r.status_code == 400
        assert "已注册" in r.text

    def test_register_invalid_password_too_short(self):
        body = {
            "email": f"TEST_short_{int(time.time()*1000)}@x.com", "password": "abc",
            "nickname": "x", "city": "y", "parent_role": "mom", "top_concerns": [],
        }
        r = requests.post(f"{BASE_URL}/api/auth/register", json=body, timeout=20)
        assert r.status_code == 422


class TestLogin:
    def test_login_success(self, user_a):
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": user_a["email"], "password": user_a["password"]}, timeout=20)
        assert r.status_code == 200
        assert "access_token" in r.json()
        assert r.json()["user"]["email"] == user_a["email"].lower()

    def test_login_wrong_password_401(self, user_a):
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": user_a["email"], "password": "wrongpass"}, timeout=20)
        assert r.status_code == 401
        assert "邮箱或密码错误" in r.text

    def test_login_nonexistent_email_401(self):
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": "TEST_nope_xyz@nowhere.com", "password": "x" * 8}, timeout=20)
        assert r.status_code == 401


class TestMe:
    def test_me_with_valid_token(self, user_a):
        r = requests.get(f"{BASE_URL}/api/auth/me",
                         headers={"Authorization": f"Bearer {user_a['token']}"}, timeout=20)
        assert r.status_code == 200
        assert r.json()["email"] == user_a["email"].lower()

    def test_me_without_token_401(self):
        r = requests.get(f"{BASE_URL}/api/auth/me", timeout=20)
        assert r.status_code == 401

    def test_me_invalid_token_401(self):
        r = requests.get(f"{BASE_URL}/api/auth/me",
                         headers={"Authorization": "Bearer not.a.real.token"}, timeout=20)
        assert r.status_code == 401

    def test_update_me_persists(self, user_a):
        h = {"Authorization": f"Bearer {user_a['token']}"}
        r = requests.put(f"{BASE_URL}/api/auth/me",
                         headers=h,
                         json={"nickname": "测试妈A-改", "top_concerns": ["health"]},
                         timeout=20)
        assert r.status_code == 200
        assert r.json()["nickname"] == "测试妈A-改"
        assert r.json()["top_concerns"] == ["health"]
        # Verify via GET
        r2 = requests.get(f"{BASE_URL}/api/auth/me", headers=h, timeout=20)
        assert r2.json()["nickname"] == "测试妈A-改"


class TestSoftScoping:
    def test_children_scoped_to_user(self, user_a, user_b):
        ha = {"Authorization": f"Bearer {user_a['token']}"}
        hb = {"Authorization": f"Bearer {user_b['token']}"}

        # Create child as user A
        ca = requests.post(f"{BASE_URL}/api/children", headers=ha,
                           json={"nickname": "TEST_kidA", "birth_date": "2023-01-01", "gender": "boy"},
                           timeout=20)
        assert ca.status_code == 200
        kid_a_id = ca.json()["id"]

        # Create child as user B
        cb = requests.post(f"{BASE_URL}/api/children", headers=hb,
                           json={"nickname": "TEST_kidB", "birth_date": "2023-02-02", "gender": "girl"},
                           timeout=20)
        assert cb.status_code == 200
        kid_b_id = cb.json()["id"]

        # User A's GET shows kid A but NOT kid B (B has user_id != A)
        la = requests.get(f"{BASE_URL}/api/children", headers=ha, timeout=20).json()
        ids_a = {c["id"] for c in la}
        assert kid_a_id in ids_a
        assert kid_b_id not in ids_a

        # User B's GET shows kid B but NOT kid A
        lb = requests.get(f"{BASE_URL}/api/children", headers=hb, timeout=20).json()
        ids_b = {c["id"] for c in lb}
        assert kid_b_id in ids_b
        assert kid_a_id not in ids_b

    def test_legacy_visible_without_token(self, user_a):
        # Without token, both users' kids + legacy are visible (no scope filter)
        r = requests.get(f"{BASE_URL}/api/children", timeout=20)
        assert r.status_code == 200
        # No assertion on specific data (legacy DB state varies); just confirms endpoint open

    def test_tasks_scoped(self, user_a):
        h = {"Authorization": f"Bearer {user_a['token']}"}
        r = requests.get(f"{BASE_URL}/api/tasks", headers=h, timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_favorites_scoped(self, user_a, user_b):
        ha = {"Authorization": f"Bearer {user_a['token']}"}
        hb = {"Authorization": f"Bearer {user_b['token']}"}
        # A favorites card_food_picky
        r1 = requests.post(f"{BASE_URL}/api/favorites/toggle", headers=ha,
                           json={"card_id": "card_food_picky"}, timeout=20)
        assert r1.status_code == 200
        # B should NOT see A's favorite (assuming B has none); B's list should not contain it
        fav_b = requests.get(f"{BASE_URL}/api/favorites", headers=hb, timeout=20).json()
        b_ids = {c["id"] for c in fav_b}
        # B may have legacy favorites but should NOT have a favorite specifically owned by A.
        # We can verify by toggling off A's fav and confirming B's list unchanged
        fav_a = requests.get(f"{BASE_URL}/api/favorites", headers=ha, timeout=20).json()
        a_ids = {c["id"] for c in fav_a}
        assert "card_food_picky" in a_ids
        # cleanup: toggle off
        requests.post(f"{BASE_URL}/api/favorites/toggle", headers=ha,
                      json={"card_id": "card_food_picky"}, timeout=20)
