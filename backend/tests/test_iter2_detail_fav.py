"""Backend tests for Iteration 2: card detail, alt refresh, favorites."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://chinese-parent-app.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

CARD_IDS = [
    "card_food_picky",
    "card_bilingual_school",
    "card_baby_monitor",
    "card_sleep_routine",
    "card_screen_time",
    "card_thermometer",
]


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


# ----- Detail endpoint -----
@pytest.mark.parametrize("card_id", CARD_IDS)
def test_card_detail_has_body_tags_hook(s, card_id):
    r = s.get(f"{API}/feed/{card_id}/detail", timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["id"] == card_id
    assert d.get("body") and len(d["body"]) >= 200, f"body too short for {card_id}: {len(d.get('body',''))}"
    assert d.get("tags") and len(d["tags"]) >= 1
    assert d.get("hook_line")
    assert d.get("image_url")
    assert d.get("title") and d.get("type") and d.get("type_label")


def test_card_detail_food_picky_mentions_18_months(s):
    r = s.get(f"{API}/feed/card_food_picky/detail")
    assert r.status_code == 200
    d = r.json()
    assert "18" in d["title"] or "18" in d["body"]


def test_card_detail_404_for_unknown(s):
    r = s.get(f"{API}/feed/nonexistent_card/detail")
    assert r.status_code == 404


# ----- Alt card -----
def test_alt_card_excludes_id(s):
    excluded = "card_food_picky"
    # Run multiple times to ensure it never returns excluded
    seen = set()
    for _ in range(10):
        r = s.get(f"{API}/feed/alt?exclude={excluded}")
        assert r.status_code == 200
        c = r.json()
        assert c["id"] != excluded
        seen.add(c["id"])
    # Should have variation across calls (>=2 different ids)
    assert len(seen) >= 2


def test_alt_card_no_exclude(s):
    r = s.get(f"{API}/feed/alt")
    assert r.status_code == 200
    assert r.json()["id"]


# ----- Favorites -----
def _clear_favs(s):
    favs = s.get(f"{API}/favorites").json()
    for f in favs:
        s.post(f"{API}/favorites/toggle", json={"card_id": f["id"]})


def test_favorites_toggle_and_list(s):
    _clear_favs(s)
    # initial empty
    r = s.get(f"{API}/favorites")
    assert r.status_code == 200
    assert r.json() == []

    # toggle on
    r = s.post(f"{API}/favorites/toggle", json={"card_id": "card_food_picky"})
    assert r.status_code == 200
    body = r.json()
    assert body["favorited"] is True
    assert body["card_id"] == "card_food_picky"

    # list reflects favorite with full card payload
    r = s.get(f"{API}/favorites")
    favs = r.json()
    assert len(favs) == 1
    assert favs[0]["id"] == "card_food_picky"
    assert favs[0].get("title") and favs[0].get("type_label")

    # toggle off
    r = s.post(f"{API}/favorites/toggle", json={"card_id": "card_food_picky"})
    assert r.json()["favorited"] is False

    r = s.get(f"{API}/favorites")
    assert r.json() == []


def test_favorites_multiple(s):
    _clear_favs(s)
    for cid in ["card_food_picky", "card_baby_monitor", "card_thermometer"]:
        s.post(f"{API}/favorites/toggle", json={"card_id": cid})
    favs = s.get(f"{API}/favorites").json()
    fav_ids = {f["id"] for f in favs}
    assert fav_ids == {"card_food_picky", "card_baby_monitor", "card_thermometer"}
    _clear_favs(s)
