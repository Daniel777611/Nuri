"""The Alpha policy rejects new long names while preserving older accounts."""

from backend import main
from backend.display_name import CHINESE_NAME_TOO_LONG, generated_display_name
from backend.tests.test_community import env, err, make_profile, ok

ALPHA_ENV = "VERCEL_GIT_COMMIT_REF"
EIGHT = "小小的阿谷和媽媽"
NINE = EIGHT + "𠮷"


def test_alpha_rejects_invalid_new_registration_before_storage(env, monkeypatch):
    monkeypatch.setenv(ALPHA_ENV, "Testing-Backend-Alpha")
    result = env.client.post("/api/auth/register", json={
        "email": "tester@example.com", "password": "example-password", "nickname": NINE,
    })
    assert result.status_code == 422
    assert result.json()["detail"] == CHINESE_NAME_TOO_LONG
    assert generated_display_name(NINE) == EIGHT
    assert generated_display_name("Long English nickname") == "Long English nickname"


def test_only_alpha_rejects_over_limit_renames_and_preserves_old_value(env, monkeypatch):
    monkeypatch.setenv(ALPHA_ENV, "Testing-Backend-Beta")
    make_profile(env, "u_ann", NINE)
    headers = {"Authorization": f"Bearer {main._make_token('u_ann')}"}
    monkeypatch.setenv(ALPHA_ENV, "Testing-Backend-Alpha")

    result = env.client.put("/api/auth/me", json={"nickname": NINE, "city": "Taipei"}, headers=headers)
    assert ok(result)["nickname"] == NINE
    assert ok(result)["city"] == "Taipei"
    result = env.client.put("/api/auth/me", json={"nickname": NINE + "人"}, headers=headers)
    assert result.status_code == 422
    assert result.json()["detail"] == CHINESE_NAME_TOO_LONG

    result = env.call("u_ann", "PATCH", "/profiles/me", json={"display_name": NINE, "about": "New bio"})
    assert ok(result)["profile"]["display_name"] == NINE
    assert ok(result)["profile"]["about"] == "New bio"
    err(env.call("u_ann", "PATCH", "/profiles/me", json={"display_name": NINE + "人"}), 422, CHINESE_NAME_TOO_LONG)

    result = env.call("u_ann", "PATCH", "/profiles/me", json={"display_name": EIGHT})
    assert ok(result)["profile"]["display_name"] == EIGHT
    assert ok(env.client.get("/api/auth/me", headers=headers))["nickname"] == EIGHT


def test_new_community_profile_does_not_copy_legacy_invalid_name(env, monkeypatch):
    user = next(u for u in env.db.rows("users") if u["id"] == "u_ann")
    user["nickname"] = NINE
    monkeypatch.setenv(ALPHA_ENV, "Testing-Backend-Alpha")

    err(env.call("u_ann", "PATCH", "/profiles/me", json={"about": "New bio"}), 422, CHINESE_NAME_TOO_LONG)
    assert ok(env.call("u_ann", "GET", "/profiles/me"))["exists"] is False
    assert user["nickname"] == NINE
