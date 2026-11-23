import asyncio
import base64
import io
import json
import wave

import pytest

from backend import reply_speech


class RealtimeConnection:
    def __init__(self, transcript):
        self.sent = []
        self.events = iter([
            {"type": "session.created"},
            {"type": "session.updated"},
            {"type": "response.output_audio.delta", "delta": base64.b64encode(b"\x03\x01" * 20).decode()},
            {"type": "response.output_audio_transcript.done", "transcript": transcript},
            {"type": "response.done", "response": {"status": "completed"}},
        ])

    async def send(self, event):
        self.sent.append(json.loads(event))

    async def recv(self):
        return json.dumps(next(self.events))


def test_natural_voice_reads_unchanged_content_as_playable_wave():
    socket = RealtimeConnection("圖書館活動在上午 10:30。")
    wav_bytes = asyncio.run(reply_speech._read_events(socket, "圖書館活動在上午 10:30!"))
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()) == (1, 2, 24000, 20)
    assert socket.sent[0]["session"]["audio"]["output"]["voice"] == "marin"
    assert socket.sent[1]["response"]["conversation"] == "none"
    assert socket.sent[1]["response"]["input"][0]["content"][0]["text"] == "圖書館活動在上午 10:30!"


def test_narration_that_alters_a_numeric_range_is_never_played():
    socket = RealtimeConnection("Choose 12 options.")
    with pytest.raises(reply_speech.SpeechUnavailable):
        asyncio.run(reply_speech._read_events(socket, "Choose 1–2 options."))
