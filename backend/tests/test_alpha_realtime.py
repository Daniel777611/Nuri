"""Exercise the authenticated Realtime signal path without mic data or a paid call."""
import asyncio
import base64
import hashlib

from fastapi import FastAPI, Header, HTTPException
import httpx

from backend import alpha_realtime as voice


_AUDIO_OFFER = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
_AUDIO_ANSWER = "v=0\r\nm=audio 5000 UDP/TLS/RTP/SAVPF 111\r\n"
_CALL = "/api/chat/realtime/call"
_CLIENT = "/api/alpha/realtime/client"


def _install(monkeypatch, upstream_handler, alpha=True):
    async def require_user(x_fake_account: str = Header(default="")):
        if x_fake_account not in ("owner", "other"):
            raise HTTPException(401)
        return x_fake_account

    monkeypatch.setattr(voice.runtime, "alpha_features_available", lambda: alpha)
    monkeypatch.setattr(voice.runtime, "OPENAI_API_KEY", "protocol-test-only")
    monkeypatch.setattr(voice.runtime, "JWT_SECRET", "isolated-test-secret")
    monkeypatch.setattr(voice.runtime, "get_supabase", lambda: None)
    monkeypatch.delenv("OPENAI_REALTIME_MODEL", raising=False)
    monkeypatch.setattr(voice, "_provider_client", lambda timeout: httpx.AsyncClient(
        transport=httpx.MockTransport(upstream_handler), timeout=timeout
    ))
    voice._seen.clear()
    voice._in_flight.clear()
    app = FastAPI()
    app.include_router(voice.build_router(require_user))
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
            proof = response.json()["connection"]
            assert (await client.request("DELETE", _CALL, json=proof,
                                         headers={"x-fake-account": "other"})).status_code == 403
            assert len(requests) == 1
            assert (await client.request("DELETE", _CALL, json=proof,
                                         headers={"x-fake-account": "owner"})).status_code == 204
            assert len(requests) == 2

    asyncio.run(scenario())


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
