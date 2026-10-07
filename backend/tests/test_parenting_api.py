"""Backend tests for Parenting AI Agent."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8000").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


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
