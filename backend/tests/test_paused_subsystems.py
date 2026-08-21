"""The two deploy-level pauses that exist purely to stop provider spend.

Both default to off, so the thing worth pinning is that "off" costs nothing —
no provider call is reached on the way to the paused answer — and that the
paused answer is still usable rather than an empty screen or a silent success.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import main, runtime


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def admin_headers(monkeypatch):
    monkeypatch.setattr(runtime, "ADMIN_KEY", "test-admin-key")
    monkeypatch.setattr(main, "ADMIN_KEY", "test-admin-key")
    return {"X-Admin-Key": "test-admin-key"}


# ── Knowledge cards ──────────────────────────────────────────────────────────

def test_paused_by_default():
    """The flags ship off, so a deploy is enough to stop the spend."""
    assert runtime.KNOWLEDGE_CARDS_ENABLED is False
    assert runtime.DAILY_PUSH_ENABLED is False


def test_paused_cards_leave_the_research_client_unbuilt():
    """The delivery layer already reads a None client as "serve the reviewed
    library", which is what makes pausing safe rather than a broken feed."""
    assert runtime.content_research_oai is None


def test_paused_generator_makes_no_provider_call(monkeypatch):
    def explode(*_args, **_kwargs):  # pragma: no cover - the point is it isn't called
        raise AssertionError("paused card generation reached the provider")

    monkeypatch.setattr(runtime, "KNOWLEDGE_CARDS_ENABLED", False)
    monkeypatch.setattr(main, "oai", explode)
    assert main._gen_feed_cards_sync(["婴儿睡眠"], 1) == []


def test_paused_feed_generate_serves_the_curated_pool(client, monkeypatch):
    """An empty list would blank the home screen; the curated cards do not."""
    monkeypatch.setattr(runtime, "KNOWLEDGE_CARDS_ENABLED", False)
    monkeypatch.setattr(
        main, "_gen_feed_cards_sync",
        lambda *a, **k: pytest.fail("paused generator was called"),
    )
    res = client.post("/api/feed/generate", json={"count": 3})
    assert res.status_code == 200
    cards = res.json()
    assert len(cards) == 3
    known = {c["id"] for c in main.FEED_CARDS + main.ALT_FEED_CARDS}
    assert {c["id"] for c in cards} <= known


# ── Daily push ───────────────────────────────────────────────────────────────

def test_paused_push_refuses_instead_of_sending(client, admin_headers, monkeypatch):
    monkeypatch.setattr(runtime, "DAILY_PUSH_ENABLED", False)
    monkeypatch.setattr(
        main, "_send_email_smtp",
        lambda *a, **k: pytest.fail("paused push sent mail"),
    )
    res = client.post("/admin/daily-push/trigger", headers=admin_headers)
    # 503, not 200-with-zero-sent: an admin pressing the button deserves to be
    # told why nothing happened.
    assert res.status_code == 503
    assert "DAILY_PUSH_ENABLED" in res.json()["detail"]


def test_push_status_reports_the_pause_separately(client, admin_headers, monkeypatch):
    """`stored_enabled` is the admin's own switch. Collapsing the two would make
    turning it back on look like it worked."""
    monkeypatch.setattr(runtime, "DAILY_PUSH_ENABLED", False)
    body = client.get("/admin/daily-push", headers=admin_headers).json()
    assert body["paused"] is True
    assert body["enabled"] is False
