"""Iteration 5: Tasks module backend tests.

Covers:
- Demo task seeding for a NEWLY registered user (6 specific cards, once)
- Checkin behavior: recurring vs one-time, no-op on completed
- Backfill (marks completed, sets backfilled, doesn't increment count)
- Favorite toggle
- Rating persistence + invalid rating rejection
- Delete task
- Clear-completed (deletes completed non-favorited only)
"""

import os
import time
import pytest
import requests
from datetime import date, timedelta

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/") or \
           os.environ.get("EXPO_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback for pytest environment
    BASE_URL = "https://chinese-parent-app.preview.emergentagent.com"

API = BASE_URL + "/api"


# ---------- Fixtures ----------
@pytest.fixture(scope="module")
def fresh_user():
    """Register a fresh user; return {token, user, headers}."""
    email = f"e2e_iter5_{int(time.time() * 1000)}@x.com"
    r = requests.post(f"{API}/auth/register",
                      json={"email": email, "password": "test1234"})
    assert r.status_code == 201, f"register failed: {r.status_code} {r.text}"
    data = r.json()
    token = data["access_token"]
    return {
        "email": email,
        "token": token,
        "user": data["user"],
        "headers": {"Authorization": f"Bearer {token}",
                    "Content-Type": "application/json"},
    }


@pytest.fixture(scope="module")
def second_user():
    """Second fresh user for isolation checks."""
    email = f"e2e_iter5b_{int(time.time() * 1000)}@x.com"
    r = requests.post(f"{API}/auth/register",
                      json={"email": email, "password": "test1234"})
    assert r.status_code == 201
    data = r.json()
    return {
        "email": email,
        "token": data["access_token"],
        "headers": {"Authorization": f"Bearer {data['access_token']}",
                    "Content-Type": "application/json"},
    }


# ---------- Seeding ----------
class TestDemoSeeding:
    """Verify 6 demo tasks are seeded exactly once for a new user."""

    def test_first_get_seeds_6_tasks(self, fresh_user):
        r = requests.get(f"{API}/tasks", headers=fresh_user["headers"])
        assert r.status_code == 200
        tasks = r.json()
        # 6 demo cards must be present (may be extra from chat regression but not here)
        assert len(tasks) >= 6, f"expected >=6 seeded tasks, got {len(tasks)}"
        titles = [t["title"] for t in tasks]

        expected_titles = [
            "今晚读绘本建立入睡仪式",
            "记录宝宝今天说的新词",
            "准备明天的辅食食材",
            "今天给自己留30分钟独处时间",
            "每日户外活动20分钟",
            "观察宝宝用手指指物的频率",
        ]
        for et in expected_titles:
            assert et in titles, f"missing seeded task: {et}"

    def test_seeded_task_shapes(self, fresh_user):
        r = requests.get(f"{API}/tasks", headers=fresh_user["headers"])
        tasks = {t["title"]: t for t in r.json()}

        # 绘本 3/7 recurring, not favorited, not completed
        t = tasks["今晚读绘本建立入睡仪式"]
        assert t["is_recurring"] is True
        assert t["total_count"] == 7 and t["completed_count"] == 3
        assert t["completed_at"] is None
        assert t["task_type"] == "interaction"

        # 新词 one-time, not completed
        t = tasks["记录宝宝今天说的新词"]
        assert t["is_recurring"] is False and t["total_count"] == 1
        assert t["completed_at"] is None
        assert t["task_type"] == "observation"

        # 辅食 overdue (due yesterday), not completed
        t = tasks["准备明天的辅食食材"]
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        assert t["due_date"] == yesterday
        assert t["completed_at"] is None
        assert t["task_type"] == "care"

        # 独处 due today
        t = tasks["今天给自己留30分钟独处时间"]
        assert t["due_date"] == date.today().isoformat()
        assert t["task_type"] == "selfcare"

        # 户外 5/7 favorited recurring
        t = tasks["每日户外活动20分钟"]
        assert t["is_recurring"] is True
        assert t["total_count"] == 7 and t["completed_count"] == 5
        assert t["is_favorited"] is True

        # 指物 1/3 completed
        t = tasks["观察宝宝用手指指物的频率"]
        assert t["is_recurring"] is True
        assert t["total_count"] == 3 and t["completed_count"] == 1
        assert t["completed_at"] is not None

    def test_second_get_does_not_duplicate(self, fresh_user):
        r1 = requests.get(f"{API}/tasks", headers=fresh_user["headers"])
        c1 = len(r1.json())
        r2 = requests.get(f"{API}/tasks", headers=fresh_user["headers"])
        c2 = len(r2.json())
        assert c1 == c2, f"tasks duplicated on second GET: {c1} -> {c2}"


# ---------- Checkin ----------
class TestCheckin:
    def test_checkin_recurring_increments_only(self, fresh_user):
        # 绘本 3/7 recurring -> after 1 checkin, count=4, not completed
        tasks = requests.get(f"{API}/tasks", headers=fresh_user["headers"]).json()
        t = next(x for x in tasks if x["title"] == "今晚读绘本建立入睡仪式")
        r = requests.post(f"{API}/tasks/{t['id']}/checkin",
                          headers=fresh_user["headers"])
        assert r.status_code == 200
        updated = r.json()
        assert updated["completed_count"] == 4
        assert updated["completed_at"] is None

    def test_checkin_recurring_final_completes(self, fresh_user):
        # 指物 already completed_at set (1/3 but completed_at present) --
        # so use 户外 5/7 -> checkin twice to reach 7 and complete
        tasks = requests.get(f"{API}/tasks", headers=fresh_user["headers"]).json()
        t = next(x for x in tasks if x["title"] == "每日户外活动20分钟")
        tid = t["id"]
        # checkin -> 6
        r1 = requests.post(f"{API}/tasks/{tid}/checkin",
                           headers=fresh_user["headers"]).json()
        assert r1["completed_count"] == 6 and r1["completed_at"] is None
        # checkin -> 7 completes
        r2 = requests.post(f"{API}/tasks/{tid}/checkin",
                           headers=fresh_user["headers"]).json()
        assert r2["completed_count"] == 7
        assert r2["completed_at"] is not None

    def test_checkin_one_time_completes_immediately(self, fresh_user):
        # 新词 one-time
        tasks = requests.get(f"{API}/tasks", headers=fresh_user["headers"]).json()
        t = next(x for x in tasks if x["title"] == "记录宝宝今天说的新词")
        r = requests.post(f"{API}/tasks/{t['id']}/checkin",
                          headers=fresh_user["headers"]).json()
        assert r["completed_count"] == 1
        assert r["completed_at"] is not None

    def test_checkin_on_completed_is_noop(self, fresh_user):
        # 新词 now completed - re-checkin should not change
        tasks = requests.get(f"{API}/tasks", headers=fresh_user["headers"]).json()
        t = next(x for x in tasks if x["title"] == "记录宝宝今天说的新词")
        before_ts = t["completed_at"]
        before_count = t["completed_count"]
        r = requests.post(f"{API}/tasks/{t['id']}/checkin",
                          headers=fresh_user["headers"]).json()
        assert r["completed_at"] == before_ts
        assert r["completed_count"] == before_count


# ---------- Backfill / Favorite / Rating / Delete ----------
class TestOtherActions:
    def test_backfill_marks_completed_without_increment(self, second_user):
        tasks = requests.get(f"{API}/tasks",
                             headers=second_user["headers"]).json()
        # Use overdue 辅食 (one-time, uncompleted)
        t = next(x for x in tasks if x["title"] == "准备明天的辅食食材")
        r = requests.post(f"{API}/tasks/{t['id']}/backfill",
                          headers=second_user["headers"])
        assert r.status_code == 200
        u = r.json()
        assert u["completed_at"] is not None
        assert u["backfilled"] is True
        # Count should NOT change (still 0 for one-time uncompleted task)
        assert u["completed_count"] == t["completed_count"]

    def test_favorite_toggle(self, second_user):
        tasks = requests.get(f"{API}/tasks",
                             headers=second_user["headers"]).json()
        t = next(x for x in tasks if x["title"] == "记录宝宝今天说的新词")
        assert t["is_favorited"] is False
        r1 = requests.post(f"{API}/tasks/{t['id']}/favorite",
                           headers=second_user["headers"]).json()
        assert r1["is_favorited"] is True
        r2 = requests.post(f"{API}/tasks/{t['id']}/favorite",
                           headers=second_user["headers"]).json()
        assert r2["is_favorited"] is False

    def test_rating_valid_persists(self, second_user):
        tasks = requests.get(f"{API}/tasks",
                             headers=second_user["headers"]).json()
        t = next(x for x in tasks if x["title"] == "今天给自己留30分钟独处时间")
        for rating in ["bad", "ok", "great"]:
            r = requests.post(f"{API}/tasks/{t['id']}/rating",
                              headers=second_user["headers"],
                              json={"rating": rating})
            assert r.status_code == 200
            assert r.json()["last_rating"] == rating
        # GET verifies persistence
        got = requests.get(f"{API}/tasks/{t['id']}",
                           headers=second_user["headers"]).json()
        assert got["last_rating"] == "great"

    def test_rating_invalid_rejected(self, second_user):
        tasks = requests.get(f"{API}/tasks",
                             headers=second_user["headers"]).json()
        t = tasks[0]
        r = requests.post(f"{API}/tasks/{t['id']}/rating",
                          headers=second_user["headers"],
                          json={"rating": "amazing"})
        assert r.status_code == 422

    def test_delete_task(self, second_user):
        tasks = requests.get(f"{API}/tasks",
                             headers=second_user["headers"]).json()
        # Delete 指物
        t = next(x for x in tasks if x["title"] == "观察宝宝用手指指物的频率")
        r = requests.delete(f"{API}/tasks/{t['id']}",
                            headers=second_user["headers"])
        assert r.status_code == 200
        # Verify gone
        r2 = requests.get(f"{API}/tasks/{t['id']}",
                          headers=second_user["headers"])
        assert r2.status_code == 404


# ---------- Clear-completed ----------
class TestClearCompleted:
    def test_clear_completed_preserves_favorited(self):
        """Fresh user: complete 户外 (favorited) and 新词 (not favorited),
        clear-completed should delete only 新词; 户外 stays."""
        email = f"e2e_iter5c_{int(time.time() * 1000)}@x.com"
        r = requests.post(f"{API}/auth/register",
                          json={"email": email, "password": "test1234"})
        assert r.status_code == 201
        headers = {"Authorization": f"Bearer {r.json()['access_token']}",
                   "Content-Type": "application/json"}

        # trigger seeding
        tasks = requests.get(f"{API}/tasks", headers=headers).json()

        # Complete 新词 (one-time, not favorited)
        xinci = next(x for x in tasks if x["title"] == "记录宝宝今天说的新词")
        requests.post(f"{API}/tasks/{xinci['id']}/checkin", headers=headers)

        # Complete 户外 (recurring 5/7, favorited) via 2 checkins
        huwai = next(x for x in tasks if x["title"] == "每日户外活动20分钟")
        assert huwai["is_favorited"] is True
        requests.post(f"{API}/tasks/{huwai['id']}/checkin", headers=headers)
        requests.post(f"{API}/tasks/{huwai['id']}/checkin", headers=headers)

        # Verify both completed now
        cur = requests.get(f"{API}/tasks/{huwai['id']}", headers=headers).json()
        assert cur["completed_at"] is not None

        # Clear
        clr = requests.post(f"{API}/tasks/clear-completed", headers=headers)
        assert clr.status_code == 200
        assert clr.json()["deleted"] >= 1

        # 户外 (favorited completed) must survive
        r_huwai = requests.get(f"{API}/tasks/{huwai['id']}", headers=headers)
        assert r_huwai.status_code == 200
        # 新词 (non-favorited completed) must be gone
        r_xinci = requests.get(f"{API}/tasks/{xinci['id']}", headers=headers)
        assert r_xinci.status_code == 404


# ---------- Chat regression (task generation) ----------
class TestChatTaskGeneration:
    """Chat flow still generates tasks scoped to user."""

    def test_chat_generates_tasks(self):
        email = f"e2e_iter5chat_{int(time.time() * 1000)}@x.com"
        r = requests.post(f"{API}/auth/register",
                          json={"email": email, "password": "test1234"})
        headers = {"Authorization": f"Bearer {r.json()['access_token']}",
                   "Content-Type": "application/json"}

        # Get initial task count (includes 6 demo)
        initial = requests.get(f"{API}/tasks", headers=headers).json()
        initial_count = len(initial)

        # Start chat from a card
        sess = requests.post(f"{API}/chat/sessions",
                             headers=headers,
                             json={"card_id": "card_food_picky"}).json()
        sid = sess["id"]

        # Walk the tip_food script (4 AI steps -> need 3 user replies to reach transition)
        for _ in range(4):
            requests.post(f"{API}/chat/sessions/{sid}/messages",
                          headers=headers,
                          json={"text": "好"})

        # Now tasks should be generated (tip_food = 3 tasks)
        final = requests.get(f"{API}/tasks", headers=headers).json()
        assert len(final) >= initial_count + 3, \
            f"expected >= {initial_count + 3} tasks, got {len(final)}"
