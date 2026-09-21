"""Chat voice-input validation and the /chat/transcribe endpoint."""

from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.nuri_core import audio_input


def _data_uri(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 64
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
OGG = b"OggS" + b"\x00" * 64
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 64


@pytest.mark.parametrize(
    "value, ext",
    [
        # What Chrome's FileReader produces, codec parameter included.
        (_data_uri("audio/webm;codecs=opus", WEBM), "webm"),
        (_data_uri("audio/webm", WEBM), "webm"),
        # Safari and the iOS WKWebView shell.
        (_data_uri("audio/mp4", MP4), "mp4"),
        (_data_uri("audio/x-m4a", MP4), "m4a"),
        (_data_uri("audio/ogg;codecs=opus", OGG), "ogg"),
        (_data_uri("audio/wav", WAV), "wav"),
    ],
)
def test_browser_recordings_are_accepted(value: str, ext: str):
    raw, got = audio_input.decode_audio_data_uri(value)
    assert got == ext
    assert raw


@pytest.mark.parametrize(
    "value",
    [
        "",
        None,
        _data_uri("audio/webm", MP4),            # label does not match bytes
        _data_uri("audio/flac", b"fLaC" + b"\x00" * 8),  # not on the list
        _data_uri("image/png", WEBM),
        "data:audio/webm;base64,not*base64",
        "https://example.com/voice.webm",
    ],
)
def test_spoofed_or_unsupported_audio_is_rejected(value):
    with pytest.raises(audio_input.InvalidChatAudio):
        audio_input.decode_audio_data_uri(value)


def test_oversized_audio_is_rejected_before_decoding():
    huge = "data:audio/webm;base64," + "A" * (audio_input.MAX_AUDIO_BASE64_CHARS + 200)
    with pytest.raises(audio_input.InvalidChatAudio):
        audio_input.decode_audio_data_uri(huge)


def test_prompt_follows_the_parents_script():
    assert "育兒" in audio_input.transcription_prompt("zh-TW")
    assert "育儿" in audio_input.transcription_prompt("zh-CN")
    assert audio_input.transcription_prompt("en").startswith("A parent")
    assert "育儿" in audio_input.transcription_prompt(None)


class _FakeTranscriptions:
    def __init__(self):
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(text="  宝宝晚上总醒  ", usage=None)


@pytest.fixture
def client(monkeypatch):
    fake = _FakeTranscriptions()
    monkeypatch.setattr(main, "aoai", SimpleNamespace(audio=SimpleNamespace(transcriptions=fake)))
    monkeypatch.setattr(main.llm_usage, "record", lambda *a, **k: None)
    main.app.dependency_overrides[main._req_uid] = lambda: "user-1"
    try:
        yield TestClient(main.app), fake
    finally:
        main.app.dependency_overrides.pop(main._req_uid, None)


def test_transcribe_returns_trimmed_text_and_names_the_container(client):
    http, fake = client
    res = http.post("/api/chat/transcribe", json={
        "audio_base64": _data_uri("audio/mp4", MP4), "locale": "zh-TW",
    })
    assert res.status_code == 200, res.text
    assert res.json() == {"text": "宝宝晚上总醒"}
    call = fake.calls[0]
    assert call["model"] == audio_input.TRANSCRIBE_MODEL
    assert call["file"][0] == "voice.mp4"
    assert "育兒" in call["prompt"]


def test_transcribe_rejects_a_bad_clip_without_calling_the_model(client):
    http, fake = client
    res = http.post("/api/chat/transcribe", json={
        "audio_base64": _data_uri("audio/webm", b"not audio at all"),
    })
    assert res.status_code == 422
    assert fake.calls == []


def test_transcribe_requires_sign_in():
    res = TestClient(main.app).post("/api/chat/transcribe", json={
        "audio_base64": _data_uri("audio/webm", WEBM),
    })
    assert res.status_code == 401
