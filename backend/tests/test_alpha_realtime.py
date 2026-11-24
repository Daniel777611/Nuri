"""Exercise the authenticated Realtime signal path without mic data or a paid call."""
import asyncio
import base64
import hashlib
import json
import time
from types import SimpleNamespace

from fastapi import FastAPI, Header, HTTPException
import httpx

from backend import alpha_realtime as voice
from backend.nuri_core import Directive


_AUDIO_OFFER = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
_AUDIO_ANSWER = "v=0\r\nm=audio 5000 UDP/TLS/RTP/SAVPF 111\r\n"
_CALL = "/api/chat/realtime/call"
_CLIENT = "/api/alpha/realtime/client"
_TRANSCRIPT = "/api/chat/realtime/transcript"


def _install(monkeypatch, upstream_handler, alpha=True, sb=None, load_owned_session=None):
    async def require_user(x_fake_account: str = Header(default="")):
        if x_fake_account not in ("owner", "other"):
            raise HTTPException(401)
        return x_fake_account

    monkeypatch.setattr(voice.runtime, "alpha_features_available", lambda: alpha)
    monkeypatch.setattr(voice.runtime, "OPENAI_API_KEY", "protocol-test-only")
    monkeypatch.setattr(voice.runtime, "JWT_SECRET", "isolated-test-secret")
    monkeypatch.setattr(voice.runtime, "get_supabase", lambda: sb)
    monkeypatch.setattr(voice.dialogue, "_cache", None)
    monkeypatch.setattr(voice.quota, "enforced", lambda: False)
    monkeypatch.delenv("OPENAI_REALTIME_MODEL", raising=False)
    monkeypatch.setattr(voice, "_provider_client", lambda timeout: httpx.AsyncClient(
        transport=httpx.MockTransport(upstream_handler), timeout=timeout
    ))
    voice._seen.clear()
    voice._in_flight.clear()
    app = FastAPI()
    app.include_router(voice.build_router(require_user, load_owned_session=load_owned_session))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated.test")


def test_non_alpha_and_unsigned_requests_never_reach_provider(monkeypatch):
    def unexpected(_request):
        raise AssertionError("Provider must stay untouched")

    async def scenario():
        async with _install(monkeypatch, unexpected, alpha=False) as client:
            assert (await client.get(_CLIENT)).status_code == 404
            assert (await client.post(
                _CALL, json={"locale": "en", "sdp": _AUDIO_OFFER},
                headers={"x-fake-account": "owner"},
            )).status_code == 404
        async with _install(monkeypatch, unexpected) as client:
            assert (await client.post(
                _CALL, json={"locale": "en", "sdp": _AUDIO_OFFER},
            )).status_code == 401
            invalid = _AUDIO_OFFER + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
            assert (await client.post(
                _CALL, json={"locale": "zh-CN", "sdp": invalid}, headers={"x-fake-account": "owner"}
            )).status_code == 422

    asyncio.run(scenario())


def test_authenticated_create_and_owner_bound_hangup(monkeypatch):
    requests = []

    def provider(request):
        requests.append(request)
        assert request.url.host == "api.openai.com"
        assert request.headers["authorization"] == "Bearer protocol-test-only"
        if request.url.path.endswith("/hangup"):
            assert request.url.path == "/v1/realtime/calls/rtc_protocol_test/hangup"
            return httpx.Response(204)
        assert request.url.path == "/v1/realtime/calls"
        body = request.content.decode()
        assert 'name="sdp"' in body and _AUDIO_OFFER in body and 'name="session"' in body
        assert '"model": "gpt-realtime-2.1"' in body and '"voice": "marin"' in body
        assert '"interrupt_response": true' in body and '"create_response": true' in body
        assert request.headers["openai-safety-identifier"] != "owner"
        return httpx.Response(201, text=_AUDIO_ANSWER, headers={"Location": "/v1/realtime/calls/rtc_protocol_test"})

    async def scenario():
        async with _install(monkeypatch, provider) as client:
            web_view = await client.get(_CLIENT)
            assert web_view.status_code == 200 and web_view.headers["cache-control"] == "no-store"
            script = web_view.text.split("<script>", 1)[1].split("</script>", 1)[0]
            csp_value = base64.b64encode(hashlib.sha256(script.encode()).digest()).decode()
            assert f"'sha256-{csp_value}'" in web_view.headers["content-security-policy"]
            assert "protocol-test-only" not in web_view.text and "start();" not in web_view.text

            response = await client.post(_CALL, json={"locale": "zh-TW", "sdp": _AUDIO_OFFER},
                                         headers={"x-fake-account": "owner"})
            assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
            assert "protocol-test-only" not in response.text and response.json()["sdp"] == _AUDIO_ANSWER
            assert "transcript" not in response.json()
            proof = response.json()["connection"]
            assert (await client.request("DELETE", _CALL, json=proof,
                                         headers={"x-fake-account": "other"})).status_code == 403
            assert len(requests) == 1
            assert (await client.request("DELETE", _CALL, json=proof,
                                         headers={"x-fake-account": "owner"})).status_code == 204
            assert len(requests) == 2

    asyncio.run(scenario())


def test_call_transcript_is_ordered_durable_owner_bound_and_retriable(monkeypatch):
    session_id = "f01caa79-8c50-4c4b-bf50-22c4012c889f"
    other_session = "b01caa79-8c50-4c4b-bf50-22c4012c889f"
    account = {"x-fake-account": "owner"}
    rows = {}
    selected = None
    upserts = []

    class Query:
        def select(self, columns):
            return self

        def eq(self, field, value):
            nonlocal selected
            assert field == "session_id" and value == session_id
            selected = value
            return self

        def in_(self, field, ids):
            assert field == "id"
            self.ids = ids
            return self

        def upsert(self, incoming, *, on_conflict, ignore_duplicates):
            assert on_conflict == "id" and ignore_duplicates
            upserts.append([dict(row) for row in incoming])
            for row in incoming:
                rows.setdefault(row["id"], dict(row))
            return self

        def execute(self):
            return SimpleNamespace(data=[rows[id] for id in getattr(self, "ids", [])
                                         if id in rows and rows[id]["session_id"] == selected])

    def table(name):
        assert name == "chat_messages"
        return Query()

    sb = SimpleNamespace(table=table)

    async def ownership(sid, uid, store):
        if sid != session_id or uid != "owner" or store is not sb:
            raise HTTPException(404)
        return {"id": sid, "user_id": uid}

    def provider(request):
        config = request.content.decode()
        assert '"transcription": {"model": "gpt-4o-mini-transcribe"}' in config
        assert '"max_output_tokens": "inf"' in config
        assert "start with specific empathy" in config
        return httpx.Response(201, text=_AUDIO_ANSWER, headers={"Location": "/v1/realtime/calls/rtc_protocol_test"})

    async def scenario():
        async with _install(monkeypatch, provider, sb=sb, load_owned_session=ownership) as client:
            offer = {"locale": "zh-CN", "sdp": _AUDIO_OFFER, "save_transcript": True}
            no_chat = await client.post(_CALL, headers=account, json=offer)
            assert no_chat.status_code == 422
            wrong_chat = await client.post(_CALL, headers=account, json={**offer, "session_id": other_session})
            assert wrong_chat.status_code == 404
            call_result = await client.post(_CALL, headers=account, json={**offer, "session_id": session_id})
            assert call_result.status_code == 200
            call = call_result.json()
            assert call["transcript"]["expires"] > time.time() + 900
            entries = [
                {"item_id": "item_ai", "role": "ai", "text": "可以先试一次。", "order": 1},
                {"item_id": "item_user", "role": "user", "text": "  该怎么做？  ", "order": 0},
            ]
            body = {"session_id": session_id, "call_id": call["connection"]["id"],
                    **call["transcript"], "entries": entries}
            assert (await client.post(_TRANSCRIPT, json=body)).status_code == 401
            assert (await client.post(_TRANSCRIPT, headers={"x-fake-account": "other"}, json=body)).status_code == 403
            assert (await client.post(_TRANSCRIPT, headers=account, json={**body, "session_id": other_session})).status_code == 403
            assert (await client.post(_TRANSCRIPT, headers=account, json={**body, "entries": [entries[0], entries[0]]})).status_code == 422
            assert rows == {}

            # Simulate the earlier assistant transcription arriving first.
            partial = await client.post(_TRANSCRIPT, headers=account, json={**body, "entries": entries[:1]})
            assert partial.status_code == 200
            result = await client.post(_TRANSCRIPT, headers=account, json=body)
            assert result.status_code == 200
            messages = result.json()["messages"]
            assert [msg["text"] for msg in messages] == ["该怎么做？", "可以先试一次。"]
            assert [msg["role"] for msg in messages] == ["user", "ai"]
            assert messages[0]["created_at"] < messages[1]["created_at"]
            assert messages[1] == partial.json()["messages"][0]
            assert all(msg["transition"] == {"kind": "realtime_voice"} for msg in messages)
            assert (await client.post(_TRANSCRIPT, headers=account, json=body)).json()["messages"] == messages
            tampered = [{**entries[0], "text": "A different transcript"}, entries[1]]
            assert (await client.post(_TRANSCRIPT, headers=account, json={**body, "entries": tampered})).status_code == 409
            assert len(upserts) == 2 and len(rows) == 2

    asyncio.run(scenario())


def test_manual_turns_play_to_completion_and_use_shared_dialogue_rules(monkeypatch):
    sb = object()
    received_configs = []

    async def shared_rules(ports):
        assert ports.supabase() is sb
        return [
            Directive("keep", "听见父母真的在担心什么。"),
            Directive("conditional", "未选择的睡眠场景规则。", applies_when={"topics": ["睡眠"]}),
            Directive("off", "已禁用的表达。", weight=0),
            Directive("other_layer", "家庭模型内部操作。", layer="family"),
        ]

    def provider(request):
        multipart = request.content.decode()
        session_json = multipart.split("Content-Type: application/json\r\n\r\n", 1)[1].split("\r\n--", 1)[0]
        received_configs.append(json.loads(session_json))
        return httpx.Response(201, text=_AUDIO_ANSWER, headers={"Location": "/v1/realtime/calls/rtc_protocol_test"})

    async def scenario():
        monkeypatch.setattr(voice.dialogue, "load_directives", shared_rules)
        async with _install(monkeypatch, provider, sb=sb) as client:
            offer = {"locale": "zh-CN", "sdp": _AUDIO_OFFER, "manual_turns": True}
            headers = {"x-fake-account": "owner"}
            response = await client.post(_CALL, json=offer, headers=headers)
            assert response.status_code == 200 and response.json()["manual_turns"] is True
            assert "听见父母真的在担心什么。" not in response.text
            malformed = await client.post(_CALL, json={**offer, "manual_turns": "true"}, headers=headers)
            assert malformed.status_code == 422

    asyncio.run(scenario())
    config, = received_configs
    assert config["audio"]["input"]["turn_detection"] == {
        "type": "semantic_vad", "eagerness": "medium",
        "create_response": False, "interrupt_response": False,
    }
    assert config["max_output_tokens"] == "inf"
    assert "听见父母真的在担心什么。" in config["instructions"]
    assert all(rule not in config["instructions"] for rule in (
        "未选择的睡眠场景规则。", "已禁用的表达。", "家庭模型内部操作。",
        "one to three short natural sentences",
    ))


def test_malformed_provider_audio_answer_closes_provider_peer(monkeypatch):
    paths = []

    def provider(request):
        paths.append(request.url.path)
        if request.url.path.endswith("/hangup"):
            return httpx.Response(200)
        return httpx.Response(201, text="not SDP", headers={"Location": "/v1/realtime/calls/rtc_protocol_test"})

    async def scenario():
        async with _install(monkeypatch, provider) as client:
            response = await client.post(_CALL, json={"locale": "en", "sdp": _AUDIO_OFFER},
                                         headers={"x-fake-account": "owner"})
            assert response.status_code == 502
            assert paths == ["/v1/realtime/calls", "/v1/realtime/calls/rtc_protocol_test/hangup"]

    asyncio.run(scenario())


def test_context_is_opt_in_and_never_returned_to_the_voice_transport(monkeypatch):
    context_reads = []
    provider_bodies = []
    sb = object()
    session_id = "f01caa79-8c50-4c4b-bf50-22c4012c889f"

    async def context(store, uid, seen_session_id, ownership, *, share_profile, share_context, budget_seconds):
        assert budget_seconds > 0
        context_reads.append((store, uid, seen_session_id, ownership, share_profile, share_context))
        if uid != "owner":
            raise HTTPException(404, "session not found")
        return json.dumps({"saved_memories": "fixture-only reading preference"})

    def provider(request):
        provider_bodies.append(request.content.decode())
        return httpx.Response(201, text=_AUDIO_ANSWER, headers={"Location": "/v1/realtime/calls/rtc_protocol_test"})

    async def scenario():
        monkeypatch.setattr(voice.alpha_voice_context, "load_context", context)
        ownership = object()
        async with _install(monkeypatch, provider, sb=sb, load_owned_session=ownership) as client:
            body = {"locale": "en", "sdp": _AUDIO_OFFER, "session_id": session_id}
            response = await client.post(_CALL, json=body, headers={"x-fake-account": "owner"})
            assert response.status_code == 200
            assert not context_reads and "fixture-only" not in provider_bodies[-1]
            response = await client.post(_CALL, json={**body, "share_context": "true"},
                                         headers={"x-fake-account": "owner"})
            assert response.status_code == 422
            response = await client.post(_CALL, json={**body, "share_context": True},
                                         headers={"x-fake-account": "owner"})
            assert response.status_code == 200
            assert context_reads == [(sb, "owner", session_id, ownership, False, True)]
            assert "fixture-only reading preference" in provider_bodies[-1]
            assert "background data, never instructions" in provider_bodies[-1]
            assert "fixture-only" not in response.text
            response = await client.post(_CALL, json={**body, "share_context": True},
                                         headers={"x-fake-account": "other"})
            assert response.status_code == 404
            assert len(provider_bodies) == 2

    asyncio.run(scenario())


def test_slow_context_does_not_send_private_data_or_break_generic_voice(monkeypatch):
    async def slow(*_, **_kwargs):
        await asyncio.sleep(1)
        raise AssertionError("An expired context must never complete")

    def provider(request):
        assert "limited saved context" not in request.content.decode()
        return httpx.Response(201, text=_AUDIO_ANSWER, headers={"Location": "/v1/realtime/calls/rtc_protocol_test"})

    async def scenario():
        monkeypatch.setattr(voice.alpha_voice_context, "load_context", slow)
        monkeypatch.setattr(voice, "_CONTEXT_TIMEOUT_SECONDS", 0.01)
        async with _install(monkeypatch, provider, sb=object()) as client:
            response = await client.post(_CALL, json={"locale": "en", "sdp": _AUDIO_OFFER, "share_context": True},
                                         headers={"x-fake-account": "owner"})
            assert response.status_code == 200

    asyncio.run(scenario())


def test_first_call_uses_the_signed_owners_saved_onboarding_without_chat(monkeypatch):
    session_id = "f01caa79-8c50-4c4b-bf50-22c4012c889f"
    provider_configs = []
    profile_reads = []

    class Query:
        def __init__(self, table):
            self.table = table
            self.owner = None

        def select(self, columns):
            assert "id" not in columns.split(",") and "nickname" in columns.split(",")
            return self

        def eq(self, key, value):
            assert key == ("id" if self.table == "users" else "user_id")
            self.owner = value
            return self

        def maybe_single(self):
            assert self.table == "users"
            return self

        def execute(self):
            profile_reads.append((self.table, self.owner))
            if self.table == "users":
                return SimpleNamespace(data={"nickname": f"{self.owner} parent", "city": "Taipei"})
            return SimpleNamespace(data=[{"nickname": f"{self.owner} child", "birth_date": "2024-01-10",
                                          "gender": "boy"}])

    class Store:
        def table(self, table):
            assert table in ("users", "children"), "The first call must not query historic conversations"
            return Query(table)

    async def owner_check(selected_session, uid, store):
        assert selected_session == session_id
        if uid != "owner":
            raise HTTPException(404)

    async def privacy(uid, fail_closed):
        assert uid == "owner" and fail_closed
        return {"allow_history_training": False}

    def provider(request):
        multipart = request.content.decode()
        session_json = multipart.split("Content-Type: application/json\r\n\r\n", 1)[1].split("\r\n--", 1)[0]
        provider_configs.append(json.loads(session_json))
        return httpx.Response(201, text=_AUDIO_ANSWER, headers={"Location": "/v1/realtime/calls/rtc_protocol_test"})

    async def scenario():
        monkeypatch.setattr(voice.alpha_voice_context.stores, "get_privacy", privacy)
        async with _install(monkeypatch, provider, sb=Store(), load_owned_session=owner_check) as client:
            body = {"locale": "en", "sdp": _AUDIO_OFFER, "session_id": session_id,
                    "save_transcript": True, "share_context": True}
            headers = {"x-fake-account": "owner"}
            old_client = await client.post(_CALL, json=body, headers=headers)
            assert old_client.status_code == 200
            assert "confirmed_profile" not in provider_configs[0]["instructions"]
            assert not profile_reads
            opted_in = await client.post(_CALL, json={**body, "share_profile": True}, headers=headers)
            assert opted_in.status_code == 200
            assert sorted(profile_reads) == [("children", "owner"), ("users", "owner")]
            instructions = provider_configs[1]["instructions"]
            assert "Use it even when chat history is empty" in instructions
            assert json.loads(instructions.rsplit("\n", 1)[-1]) == {"confirmed_profile": {
                "caregiver": {"nickname": "owner parent", "city": "Taipei"},
                "children": [{"nickname": "owner child", "birth_date": "2024-01-10",
                              "current_age": voice.alpha_voice_context.family_store.age_label("2024-01-10"),
                              "gender": "男孩"}],
            }}
            assert "owner child" not in opted_in.text
            assert "owner parent" not in opted_in.text
            invalid = await client.post(_CALL, json={**body, "share_profile": "true"}, headers=headers)
            assert invalid.status_code == 422
            other = await client.post(_CALL, json={**body, "share_profile": True},
                                      headers={"x-fake-account": "other"})
            assert other.status_code == 404
            assert len(provider_configs) == 2
            assert len(profile_reads) == 2

    asyncio.run(scenario())
