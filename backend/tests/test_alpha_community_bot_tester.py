"""An Alpha tester can exercise the same translation flow used by the app."""

from fastapi.testclient import TestClient

from backend import community, main, runtime
from backend.alpha_community_seed import PASSWORD_DISABLED, bot_email, bot_user_id, load_personas
from backend.tests.community_fakes import FakeDB


def test_invite_synthetic_parent_and_translate_after_tester_consent(monkeypatch):
    db = FakeDB()
    monkeypatch.setattr(runtime, "get_supabase", lambda: db)
    monkeypatch.setattr(runtime, "alpha_features_available", lambda: True)
    tester = "alpha-translation-tester"
    parent = next(p for p in load_personas() if p["language"] == "he")
    bot = bot_user_id(parent["slug"])
    db.rows("users").extend([
        {"id": tester, "email": "tester@example.test"},
        {"id": bot, "email": bot_email(parent["slug"]), "is_internal": True,
         "hashed_password": PASSWORD_DISABLED},
    ])
    db.table("community_profiles").insert({"user_id": tester, "display_name": "Test parent"}).execute()
    profile = db.table("community_profiles").insert(
        {"user_id": bot, "display_name": parent["name"]}).execute().data[0]
    db.rows("alpha_community_bot_scheduler").append({"id": 1, "enabled": True})
    calls = []

    async def complete(call_site, uid, _system, text):
        calls.append((call_site, uid, text))
        return "这是希伯来语消息的测试译文。"

    monkeypatch.setattr(community, "_complete", complete)
    client = TestClient(main.app)
    headers = {"Authorization": f"Bearer {main._make_token(tester)}"}

    def post(path, body):
        return client.post(community.PREFIX + path, headers=headers, json=body)

    invited = post("/invitations", {"target_parent_id": profile["public_id"],
                                    "client_request_id": "invite-translation-test"})
    assert invited.status_code == 200, invited.text
    relationship = invited.json()["relationship"]
    assert relationship["state"] == "connected"
    chat_id = relationship["conversation_id"]
    original = db.rows("community_messages")[0]
    assert original["body"] == parent["question"]
    assert original["language"] == "he"
    replay = post("/invitations", {"target_parent_id": profile["public_id"],
                                   "client_request_id": "invite-translation-test"})
    assert replay.status_code == 200
    assert len(db.rows("community_messages")) == 1

    translate = f"/messages/{original['id']}/translations"
    body = {"target_language": "zh-CN", "ai_consent_version": community.NURI_AI_CONSENT_VERSION,
            "client_request_id": "translate-synthetic-he-test"}
    assert post(translate, body).status_code == 403
    assert calls == []

    consent = post(f"/conversations/{chat_id}/ai-consent-requests", {
        "purpose": "translation", "notice_version": community.AI_NOTICE_VERSION,
        "client_request_id": "allow-translation-test",
    })
    assert consent.status_code == 200, consent.text
    assert consent.json()["request"]["effective"] is True
    assert consent.json()["request"]["initiated_by"] == "me"

    translated = post(translate, body)
    assert translated.status_code == 200, translated.text
    data = translated.json()
    assert data["original"] == {"text": parent["question"], "language": "he"}
    assert data["translation"]["target_language"] == "zh-CN"
    assert len(calls) == 1

    revoked = client.delete(f"{community.PREFIX}/conversations/{chat_id}/ai-participation",
                            headers=headers, params={"purpose": "translation"})
    assert revoked.status_code == 200
    assert post(translate, body).status_code == 403
