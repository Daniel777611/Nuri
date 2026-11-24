import asyncio
from datetime import date, timedelta
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

    async def recalled(uid):
        calls.append(("recalled", uid))
        return [
            {"category": "preference", "value": "Weekend swimming is a favorite activity."},
            {"category": "preference", "value": "Poppy likes dinosaur stories."},
            {"category": "constraint", "value": "Allergic to kiwi"},
        ]

    async def summary(session_id):
        calls.append(("summary", session_id))
        return "Poppy started pointing to pictures before bedtime in the autumn.", 40

    async def profile(uid):
        calls.append(("profile", uid))
        return {"nickname": "Hidden caregiver", "city": "Hidden city", "parent_role": "mom"}, [
            {"nickname": "Poppy", "birth_date": "2023-05-14", "notes": "Points to the moon."},
        ]

    monkeypatch.setattr(voice.stores, "get_privacy", privacy)
    monkeypatch.setattr(voice, "_recent_text", recent)
    monkeypatch.setattr(voice.family_store, "get_standing_context", standing)
    monkeypatch.setattr(voice.family_store, "load_known_memories", recalled)
    monkeypatch.setattr(voice.family_store, "load_profile", profile)
    monkeypatch.setattr(voice.state_store, "load", summary)
    output = asyncio.run(voice.load_context(sb, "owner", "selected-session", ownership))
    payload = json.loads(output)
    assert calls[:2] == [("ownership", "selected-session", "owner", sb), ("privacy", "owner", True)]
    assert ("recent", sb, "selected-session") in calls
    assert ("recalled", "owner") in calls
    assert ("summary", "selected-session") in calls
    assert [record["speaker"] for record in payload["recent_chat"]] == ["Caregiver", "Nuri", "Caregiver"]
    assert len(payload["recent_chat"][-1]["text"]) <= 220
    assert "dinosaur stories" in payload["saved_memories"]
    assert payload["saved_memories"].count("dinosaur stories") == 1
    assert "Weekend swimming" in payload["saved_memories"]
    assert "kiwi" in payload["standing_considerations"]
    assert "kiwi" not in payload["saved_memories"]
    assert payload["child_stage"]
    assert "Points to the moon" in payload["confirmed_profile"]
    assert "started pointing to pictures" in payload["chat_summary"]
    for hidden in ["Poppy", "2023-05-14", "aid@example.test", "https://", "Draft", "Summary", "Hidden"]:
        assert hidden not in output

    calls.clear()
    voice_only = json.loads(asyncio.run(voice.load_context(sb, "owner", None, None)))
    assert voice_only["recent_chat"] == []
    assert "Weekend swimming" in voice_only["saved_memories"]
    assert [(name, *args) for name, *args in calls if name == "recalled"] == [("recalled", "owner")]


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
    monkeypatch.setattr(voice.family_store, "load_profile", unexpected)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(voice.load_context(object(), "owner", "other-session", denied, share_profile=True))
    assert caught.value.status_code == 404


@pytest.mark.parametrize("history", ["off", "unavailable", "no-call-consent"])
def test_consented_onboarding_fields_do_not_depend_on_chat_history(monkeypatch, history):
    due = (date.today() + timedelta(days=42)).isoformat()
    sb = object()
    profile_checked = []

    async def ownership(session_id, uid, store):
        assert (session_id, uid, store) == ("first-chat", "owner", sb)

    async def profile(uid):
        profile_checked.append(uid)
        return {"nickname": "Caregiver", "city": "Austin", "gender": "hidden", "id": "private-owner-id"}, [
            {"nickname": "First", "birth_date": "2024-01-10", "gender": "girl"},
            {"nickname": "Expecting", "birth_date": due, "gender": "other"},
            {"nickname": "Incomplete", "birth_date": "unknown", "gender": "other"},
        ]

    async def privacy(uid, fail_closed):
        assert history != "no-call-consent"
        assert uid == "owner" and fail_closed
        return {"allow_history_training": False} if history == "off" else {
            voice.stores.PRIVACY_STORAGE_UNAVAILABLE: True, "allow_history_training": True,
        }

    async def unexpected(*_):
        pytest.fail("A profile-only call must not read old chats or memories")

    monkeypatch.setattr(voice.stores, "get_privacy", privacy)
    monkeypatch.setattr(voice.family_store, "load_profile", profile)
    monkeypatch.setattr(voice, "_recent_text", unexpected)
    monkeypatch.setattr(voice.family_store, "get_standing_context", unexpected)

    output = asyncio.run(voice.load_context(
        sb, "owner", "first-chat", ownership, share_profile=True, share_context=history != "no-call-consent",
    ))
    assert profile_checked == ["owner"]
    assert "private-owner-id" not in output
    assert json.loads(output) == {"confirmed_profile": {
        "caregiver": {"nickname": "Caregiver", "city": "Austin"},
        "children": [
            {"nickname": "First", "birth_date": "2024-01-10",
             "current_age": voice.family_store.age_label("2024-01-10"), "gender": "女孩"},
            {"nickname": "Expecting", "due_date": due,
             "pregnancy_stage": voice.family_store.pregnancy_label(due)},
            {"nickname": "Incomplete"},
        ],
    }}


def test_confirmed_profile_survives_an_optional_history_timeout(monkeypatch):
    async def profile(uid):
        return {"nickname": "New parent"}, [{"nickname": "First", "birth_date": "2024-01-10"}]

    async def privacy(uid, fail_closed):
        return {"allow_history_training": True}

    async def stalled(*_):
        await asyncio.Event().wait()

    monkeypatch.setattr(voice.family_store, "load_profile", profile)
    monkeypatch.setattr(voice.stores, "get_privacy", privacy)
    monkeypatch.setattr(voice, "_history_context", stalled)
    result = asyncio.run(asyncio.wait_for(voice.load_context(
        object(), "owner", None, None, share_profile=True, budget_seconds=0.01,
    ), timeout=0.25))
    payload = json.loads(result)
    assert payload["confirmed_profile"]["children"][0]["birth_date"] == "2024-01-10"
    assert "recent_chat" not in payload
