"""Backend tests for Parenting AI Agent."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://chinese-parent-app.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


# ---------------- Feed ----------------
def test_feed_returns_six_cards(s):
    r = s.get(f"{API}/feed", timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 6
    types = {c["type"] for c in data}
    assert types == {"tip", "news", "product"}
    for c in data:
        assert c["title"] and c["summary"] and c["type_label"]
        assert "image_url" in c


# ---------------- Children CRUD ----------------
def test_child_crud(s):
    payload = {"nickname": "TEST_baby", "birth_date": "2023-06-01", "gender": "boy", "allergies": ["peanut"]}
    r = s.post(f"{API}/children", json=payload)
    assert r.status_code == 200
    child = r.json()
    cid = child["id"]
    assert child["nickname"] == "TEST_baby"

    r = s.get(f"{API}/children")
    assert r.status_code == 200
    assert any(c["id"] == cid for c in r.json())

    r = s.put(f"{API}/children/{cid}", json={**payload, "nickname": "TEST_baby2"})
    assert r.status_code == 200
    assert r.json()["nickname"] == "TEST_baby2"

    r = s.delete(f"{API}/children/{cid}")
    assert r.status_code == 200
    r = s.get(f"{API}/children")
    assert not any(c["id"] == cid for c in r.json())


# ---------------- Chat ----------------
def test_chat_session_card_seeds_message(s):
    r = s.post(f"{API}/chat/sessions", json={"card_id": "card_food_picky"})
    assert r.status_code == 200
    sess = r.json()
    assert sess["script_key"] == "tip_food"
    assert "18个月" in sess["title"]
    sid = sess["id"]

    r = s.get(f"{API}/chat/sessions/{sid}/messages")
    assert r.status_code == 200
    msgs = r.json()
    assert len(msgs) == 1
    assert msgs[0]["role"] == "ai"
    assert msgs[0]["quick_replies"]


def test_chat_advances_and_generates_tasks(s):
    r = s.post(f"{API}/chat/sessions", json={"card_id": "card_food_picky"})
    sid = r.json()["id"]
    # Advance 4 user messages to reach transition
    transition_seen = False
    for i in range(4):
        r = s.post(f"{API}/chat/sessions/{sid}/messages", json={"text": "继续"})
        assert r.status_code == 200
        data = r.json()
        assert "user_message" in data and "ai_messages" in data
        for m in data["ai_messages"]:
            if m.get("transition") and m["transition"].get("kind") == "tasks_generated":
                transition_seen = True
    assert transition_seen, "Expected tasks_generated transition in tip_food script"

    # Tasks created
    r = s.get(f"{API}/tasks")
    assert r.status_code == 200
    tasks = r.json()
    assert len(tasks) >= 3


def test_image_upload_switches_to_emergency(s):
    r = s.post(f"{API}/chat/sessions", json={"script_key": "free"})
    sid = r.json()["id"]
    # Send image base64
    r = s.post(
        f"{API}/chat/sessions/{sid}/messages",
        json={"image_base64": "data:image/png;base64,iVBORw0KGgo="},
    )
    assert r.status_code == 200
    ai_text = " ".join(m["text"] for m in r.json()["ai_messages"])
    assert "38.7" in ai_text or "体温" in ai_text


# ---------------- Tasks ----------------
def test_task_patch_done_and_reflection(s):
    # ensure at least one task exists
    r = s.get(f"{API}/tasks")
    if not r.json():
        # generate via free script
        rs = s.post(f"{API}/chat/sessions", json={"script_key": "free"}).json()
        for _ in range(4):
            s.post(f"{API}/chat/sessions/{rs['id']}/messages", json={"text": "ok"})
        r = s.get(f"{API}/tasks")
    tasks = r.json()
    assert tasks
    tid = tasks[0]["id"]

    r = s.patch(f"{API}/tasks/{tid}", json={"done": True, "mood": "😊", "note": "ok"})
    assert r.status_code == 200
    t = r.json()
    assert t["done"] is True
    assert t["completed_at"]
    assert t["reflection"]["mood"] == "😊"


def test_task_insights(s):
    r = s.get(f"{API}/tasks/insights")
    assert r.status_code == 200
    data = r.json()
    assert "total_completed" in data
    assert "streak_days" in data
    assert "weekly_progress" in data


# ---------------- Privacy ----------------
def test_privacy_get_put(s):
    r = s.get(f"{API}/privacy")
    assert r.status_code == 200
    cur = r.json()
    new_settings = {**cur, "daily_push": not cur["daily_push"]}
    r = s.put(f"{API}/privacy", json=new_settings)
    assert r.status_code == 200
    assert r.json()["daily_push"] == new_settings["daily_push"]
    # restore
    s.put(f"{API}/privacy", json=cur)


def test_privacy_wipe(s):
    # Create some data
    s.post(f"{API}/children", json={"nickname": "TEST_wipe", "birth_date": "2024-01-01"})
    r = s.post(f"{API}/privacy/wipe")
    assert r.status_code == 200
    # verify cleared
    r = s.get(f"{API}/children")
    assert r.json() == []
    r = s.get(f"{API}/tasks")
    assert r.json() == []
