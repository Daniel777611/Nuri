"""Alpha-only, authenticated SDP signaling for Nuri's embedded WebRTC call.

The app holds the account credential. Audio streams directly between WebKit
and the provider over WebRTC; Alpha's server only negotiates and ends a call.
"""

import base64
from collections import defaultdict, deque
import hashlib
import hmac
import json
import os
import re
import time
from typing import Literal
from urllib.parse import urlsplit

import anyio
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, Response
import httpx
from pydantic import BaseModel, Field, field_validator

from backend import quota, runtime

_MAX_SDP = 65_536
_MODEL_NAME = re.compile(r"gpt-realtime(?:[-.a-zA-Z0-9]+)?\Z")
_CALL_ID = re.compile(r"rtc_[A-Za-z0-9_-]{1,128}\Z")
_CALLS_URL = "https://api.openai.com/v1/realtime/calls"
_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
_MAX_CALLS_PER_MINUTE = 6
_seen: dict[str, deque[float]] = defaultdict(deque)
_in_flight: set[str] = set()

_WEBRTC_SCRIPT = r"""
(() => {
  const audio = document.querySelector("audio");
  let peer, remoteEvents, microphone, maxTimer, disconnectedTimer;
  let state = "idle";

  function emit(type, payload = {}) {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type, ...payload }));
  }

  function close() {
    state = "closed";
    clearTimeout(maxTimer);
    clearTimeout(disconnectedTimer);
    microphone?.getTracks().forEach(track => track.stop());
    if (remoteEvents) remoteEvents.close();
    if (peer) peer.close();
    audio.pause();
    audio.srcObject = null;
  }

  function fail(code) {
    if (state === "closed") return;
    close();
    emit("error", { code });
  }

  function modelEvent(event) {
    if (state !== "connected" || typeof event.data !== "string" || event.data.length > 65536) return;
    let detail;
    try { detail = JSON.parse(event.data); } catch { return; }
    if (!detail || typeof detail !== "object") return;
    if (detail.type === "input_audio_buffer.speech_started" || detail.type === "output_audio_buffer.stopped" ||
        detail.type === "output_audio_buffer.cleared") emit("listening");
    if (detail.type === "output_audio_buffer.started") emit("speaking");
    if (detail.type === "error" && ["session_expired", "session_limit_exceeded"].includes(detail.error?.code)) fail("ended");
  }

  async function gatherCandidates(connection) {
    if (connection.iceGatheringState === "complete") return;
    await new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        connection.removeEventListener("icegatheringstatechange", changed);
        resolve();
      };
      const changed = () => { if (connection.iceGatheringState === "complete") done(); };
      const timer = setTimeout(done, 1800);
      connection.addEventListener("icegatheringstatechange", changed);
      changed();
    });
  }

  async function start() {
    if (state !== "idle") return;
    state = "starting";
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return fail("unsupported");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (error) {
      return fail(error?.name === "NotAllowedError" ? "permission" : "microphone");
    }
    if (state === "closed") {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    try {
      microphone = stream;
      peer = new RTCPeerConnection();
      const input = stream.getAudioTracks()[0];
      if (!input) return fail("microphone");
      input.enabled = false;
      input.addEventListener("ended", () => fail("microphone"), { once: true });
      peer.addTrack(input, stream);
      peer.ontrack = ({ track, streams }) => {
        if (state === "closed") return;
        audio.srcObject = streams[0] ?? new MediaStream([track]);
        void audio.play().catch(() => fail("playback"));
      };
      remoteEvents = peer.createDataChannel("oai-events");
      remoteEvents.onmessage = modelEvent;
      remoteEvents.onerror = () => fail("connection");
      peer.onconnectionstatechange = () => {
        clearTimeout(disconnectedTimer);
        if (state === "closed") return;
        switch (peer.connectionState) {
          case "connected":
            state = "connected";
            input.enabled = true;
            emit("listening");
            break;
          case "disconnected":
            input.enabled = false;
            disconnectedTimer = setTimeout(() => fail("connection"), 4000);
            break;
          case "failed":
          case "closed":
            fail("connection");
            break;
        }
      };
      await peer.setLocalDescription(await peer.createOffer());
      await gatherCandidates(peer);
      if (state === "closed") return;
      state = "awaiting-answer";
      emit("offer", { sdp: peer.localDescription?.sdp });
      maxTimer = setTimeout(() => fail("ended"), 300000);
    } catch { fail("connection"); }
  }

  async function answer(sdp) {
    if (state !== "awaiting-answer" || typeof sdp !== "string") return;
    state = "connecting";
    try {
      await peer.setRemoteDescription({ type: "answer", sdp });
    } catch { fail("connection"); }
  }

  window.nuriRealtime = Object.freeze({ start, answer, close });
  window.addEventListener("pagehide", close);
  document.addEventListener("visibilitychange", () => { if (document.hidden) fail("ended"); });
})();
""".strip()
_SCRIPT_HASH = base64.b64encode(hashlib.sha256(_WEBRTC_SCRIPT.encode()).digest()).decode()
_HTML = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Nuri live audio</title>' + \
    '<audio autoplay playsinline></audio><script>' + _WEBRTC_SCRIPT + '</script></html>'
_HTML_HEADERS = {
    **_HEADERS,
    "Content-Security-Policy": (
        f"default-src 'none'; script-src 'sha256-{_SCRIPT_HASH}'; "
        "media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    ),
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
}


class _Offer(BaseModel):
    sdp: str = Field(min_length=20, max_length=_MAX_SDP)
    locale: Literal["en", "zh-CN", "zh-TW"]


class _EndCall(BaseModel):
    id: str = Field(max_length=132)
    expires: int
    proof: str = Field(pattern=r"^[a-f0-9]{64}$")

    @field_validator("id")
    @classmethod
    def _validate_call_id(cls, value: str) -> str:
        if not _CALL_ID.fullmatch(value):
            raise ValueError("Invalid voice connection ID")
        return value


def _ensure_alpha() -> None:
    if not runtime.is_alpha_backend():
        raise HTTPException(404)


def _sign(*fields: str) -> str:
    message = json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()
    return hmac.new(runtime.JWT_SECRET.encode(), message, hashlib.sha256).hexdigest()


def _validate_sdp(sdp: str) -> str:
    try:
        size = len(sdp.encode("utf-8"))
    except UnicodeEncodeError:
        raise HTTPException(422, "Invalid voice connection data") from None
    if size > _MAX_SDP or not sdp.startswith(("v=0\r\n", "v=0\n")):
        raise HTTPException(422, "Invalid voice connection data")
    media = [line.split(" ", 1)[0] for line in sdp.splitlines() if line.startswith("m=")]
    if media.count("m=audio") != 1 or any(line not in {"m=audio", "m=application"} for line in media):
        raise HTTPException(422, "Voice connections support audio only")
    return sdp


def _call_id(location: str | None) -> str | None:
    try:
        parsed = urlsplit(location or "")
    except ValueError:
        return None
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        return None
    if parsed.netloc and (parsed.scheme, parsed.netloc) != ("https", "api.openai.com"):
        return None
    prefix, sep, last = parsed.path.rpartition("/")
    return last if sep and prefix in {"/v1/realtime/calls", "/realtime/calls"} and _CALL_ID.fullmatch(last) else None


def _session(locale: str) -> dict:
    language = {"zh-CN": "简体中文", "zh-TW": "繁體中文", "en": "English"}[locale]
    model = os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-2.1").strip()
    if not _MODEL_NAME.fullmatch(model):
        raise HTTPException(503, "Live voice is unavailable")
    return {
        "type": "realtime",
        "model": model,
        "output_modalities": ["audio"],
        "instructions": (
            "You are Nuri, a warm parenting assistant talking with an adult caregiver. "
            f"Start in {language}; follow a clear user request to switch languages. "
            "Speak like a thoughtful, warm adult, with a natural conversational pace, "
            "relaxed pronunciation, short pauses between ideas and restrained emphasis. "
            "In Chinese use idiomatic, naturally paced Mandarin suited to the speaker. "
            "Do not overact or read punctuation aloud. Identify yourself as an AI assistant "
            "if asked or if that is unclear. Use brief spoken replies and ask no more than one follow-up "
            "question at a time. You have no access to this caregiver's stored profile, "
            "chat history, live web, location, prices or purchases in this call. "
            "Do not claim that you searched the web, diagnosed a child, or took an action. "
            "When the user asks about medicine or symptoms, provide general information, "
            "never invent a dosage or diagnosis, and recommend a licensed pediatrician or "
            "pharmacist for individual advice. For immediate danger, advise the caregiver "
            "to contact their local emergency services promptly. "
            "Avoid soliciting a child's name, address, identity or other unnecessary details."
        ),
        "audio": {
            "input": {
                "noise_reduction": {"type": "near_field"},
                "turn_detection": {
                    "type": "server_vad", "threshold": 0.5,
                    "prefix_padding_ms": 300, "silence_duration_ms": 650,
                    "create_response": True, "interrupt_response": True,
                },
            },
            "output": {"voice": "marin"},
        },
    }


def _reserve_attempt(uid: str) -> None:
    now = time.monotonic()
    # Best-effort smoothing within a worker. The existing account quota and
    # provider limits remain the deployment-wide bounds.
    for key, attempts in list(_seen.items()):
        while attempts and now - attempts[0] >= 60:
            attempts.popleft()
        if not attempts:
            _seen.pop(key, None)
    if uid in _in_flight or len(_seen[uid]) >= _MAX_CALLS_PER_MINUTE:
        raise HTTPException(429, "Please wait before starting another voice call")
    _seen[uid].append(now)
    _in_flight.add(uid)


def _provider_client(timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=4), follow_redirects=False)


async def _hang_up(call: str, key: str) -> None:
    try:
        async with _provider_client(4) as client:
            response = await client.post(
                f"{_CALLS_URL}/{call}/hangup", headers={"Authorization": "Bearer " + key},
            )
    except httpx.HTTPError:
        raise HTTPException(502, "Could not end live voice") from None
    if not response.is_success and response.status_code not in (404, 410):
        raise HTTPException(502, "Could not end live voice")


async def _exchange(uid: str, offer: _Offer) -> dict:
    sdp = _validate_sdp(offer.sdp)
    config = _session(offer.locale)
    key = runtime.OPENAI_API_KEY
    if not key:
        raise HTTPException(503, "Live voice is unavailable")
    client_headers = {
        "Authorization": "Bearer " + key,
        "OpenAI-Safety-Identifier": _sign("nuri-realtime-user", uid),
    }
    _reserve_attempt(uid)
    try:
        async with _provider_client(12) as client:
            response = await client.post(
                _CALLS_URL, headers=client_headers,
                files={"sdp": (None, sdp, "application/sdp"), "session": (None, json.dumps(config), "application/json")},
            )
    except httpx.HTTPError:
        raise HTTPException(502, "Could not connect live voice") from None
    finally:
        _in_flight.discard(uid)
    call = _call_id(response.headers.get("Location"))
    if not response.is_success or call is None:
        raise HTTPException(502, "Could not connect live voice")
    try:
        if len(response.content) > _MAX_SDP:
            raise HTTPException(502)
        answer = _validate_sdp(response.text)
    except HTTPException:
        # The provider allocated a call but did not give us a usable answer.
        # Close it instead of leaving a remote peer waiting for a client.
        try:
            await _hang_up(call, key)
        except HTTPException:
            pass
        raise HTTPException(502, "Could not connect live voice") from None
    expiration = int(time.time()) + 390
    return {
        "sdp": answer,
        "connection": {
            "id": call, "expires": expiration,
            "proof": _sign("nuri-realtime-end", uid, call, str(expiration)),
        },
    }


def build_router(require_user) -> APIRouter:
    router = APIRouter(prefix="/api", dependencies=[Depends(_ensure_alpha)])

    @router.get("/alpha/realtime/client", include_in_schema=False)
    async def voice_client():
        return HTMLResponse(_HTML, headers=_HTML_HEADERS)

    @router.post("/chat/realtime/call")
    async def start_call(offer: _Offer, uid: str = Depends(require_user)):
        sb = runtime.get_supabase()
        if sb and quota.enforced() and await anyio.to_thread.run_sync(lambda: quota.blocks(sb, uid, None)):
            raise HTTPException(402, "DAILY_QUOTA_REACHED")
        return JSONResponse(await _exchange(uid, offer), headers=_HEADERS)

    @router.delete("/chat/realtime/call")
    async def end_call(connection: _EndCall, uid: str = Depends(require_user)):
        expected = _sign("nuri-realtime-end", uid, connection.id, str(connection.expires))
        if connection.expires < time.time() or not hmac.compare_digest(connection.proof, expected):
            raise HTTPException(403, "Voice connection does not belong to this account")
        key = runtime.OPENAI_API_KEY
        if not key:
            raise HTTPException(503, "Live voice is unavailable")
        await _hang_up(connection.id, key)
        return Response(status_code=204, headers=_HEADERS)

    return router
