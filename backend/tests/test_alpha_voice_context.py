import asyncio
import json

from fastapi import HTTPException
import pytest

from backend import alpha_voice_context as voice


def test_personal_context_uses_own_recent_chat_and_saved_memories_with_private_fields_removed(monkeypatch):
    calls = []
    messages = [
        {"role": "user", "text": "Poppy born 2023-05-14 sleeps at 8. Email aid@example.test"},
        {"role": "ai", "text": "Draft", "transition_kind": "_nuri_generation_claim"},
        {"role": "ai", "text": "Summary", "transition_kind": "memory_context"},
        {"role": "ai", "text": "Try a routine. https://example.test/secret-link"},
        {"role": "user", "text": "Poppy likes books before bedtime. " + "a" * 500},
    ]
    sb = object()

    async def ownership(session_id, uid, store):
        calls.append(("ownership", session_id, uid, store))

    async def privacy(uid, fail_closed=False):
        calls.append(("privacy", uid, fail_closed))
        return {"allow_history_training": True}

    async def recent(store, session_id):
        calls.append(("recent", store, session_id))
        return messages

    async def standing(uid):
        calls.append(("standing", uid))
        return "- Allergic to kiwi"

    async def recalled(uid, query=""):
        calls.append(("recalled", uid, query))
        if not query:
            return "家庭偏好：Poppy likes dinosaur stories.；Weekend swimming is a favorite activity."
        return "家庭偏好：Poppy likes dinosaur stories."

    async def profile(uid):
        calls.append(("profile", uid))
        return {"nickname": "Hidden caregiver", "city": "Hidden city"}, [
            {"nickname": "Poppy", "birth_date": "2023-05-14"},
        ]

    monkeypatch.setattr(voice.stores, "get_privacy", privacy)
    monkeypatch.setattr(voice, "_recent_text", recent)
    monkeypatch.setattr(voice.family_store, "get_standing_context", standing)
    monkeypatch.setattr(voice.family_store, "get_recalled_memory_context", recalled)
    monkeypatch.setattr(voice.family_store, "load_profile", profile)
    output = asyncio.run(voice.load_context(sb, "owner", "selected-session", ownership))
    payload = json.loads(output)
    assert calls[:3] == [("ownership", "selected-session", "owner", sb), ("privacy", "owner", True),
                         ("recent", sb, "selected-session")]
    assert ("recalled", "owner", messages[-1]["text"]) in calls
    assert ("recalled", "owner", "") in calls
    assert [record["speaker"] for record in payload["recent_chat"]] == ["Caregiver", "Nuri", "Caregiver"]
    assert len(payload["recent_chat"][-1]["text"]) <= 220
    assert "dinosaur stories" in payload["saved_memories"]
    assert payload["saved_memories"].count("dinosaur stories") == 1
    assert "Weekend swimming" in payload["saved_memories"]
    assert "kiwi" in payload["standing_considerations"]
    assert payload["child_stage"]
    for hidden in ["Poppy", "2023-05-14", "aid@example.test", "https://", "Draft", "Summary", "Hidden"]:
        assert hidden not in output

    calls.clear()
    voice_only = json.loads(asyncio.run(voice.load_context(sb, "owner", None, None)))
    assert voice_only["recent_chat"] == []
    assert "Weekend swimming" in voice_only["saved_memories"]
    assert [(name, *args) for name, *args in calls if name == "recalled"] == [("recalled", "owner", "")]


@pytest.mark.parametrize("toggle", [False, None])
def test_no_account_context_if_history_is_disabled_or_privacy_read_is_unavailable(monkeypatch, toggle):
    async def privacy(uid, fail_closed):
        assert uid == "owner" and fail_closed is True
        if toggle is None:
            return {voice.stores.PRIVACY_STORAGE_UNAVAILABLE: True, "allow_history_training": True}
        return {"allow_history_training": toggle}

    async def unexpected(*_):
        pytest.fail("Do not load any saved context if history is unavailable")

    monkeypatch.setattr(voice.stores, "get_privacy", privacy)
    monkeypatch.setattr(voice, "_recent_text", unexpected)
    monkeypatch.setattr(voice.family_store, "get_standing_context", unexpected)
    assert asyncio.run(voice.load_context(object(), "owner", None, None)) == ""


def test_denied_session_is_rejected_before_privacy_or_messages(monkeypatch):
    async def denied(session_id, uid, _):
        assert session_id == "other-session" and uid == "owner"
        raise HTTPException(404, "session not found")

    async def unexpected(*_):
        pytest.fail("Do not read any context for an unowned conversation")

    monkeypatch.setattr(voice.stores, "get_privacy", unexpected)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(voice.load_context(object(), "owner", "other-session", denied))
    assert caught.value.status_code == 404
