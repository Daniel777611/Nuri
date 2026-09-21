"""Validation and transcription for the chat composer's voice input.

The browser records a short clip with ``MediaRecorder`` and posts it as a
base64 data URI. The transcript goes back into the composer, not straight into
the conversation: the parent reads and edits it before sending, so a mishearing
never becomes a message they did not mean.

The clip is treated as untrusted in the same way ``image_input`` treats a
photo: the declared type must be one the provider accepts, and the bytes must
start like that container, so a client cannot hand the provider an arbitrary
file under an audio label.
"""

from __future__ import annotations

import base64
import binascii
import re
from typing import Optional

# One minute of browser Opus/AAC is well under 1 MB. The ceiling leaves room
# for higher-bitrate encoders while keeping the base64 body under Vercel's
# 4.5 MB request limit.
MAX_AUDIO_BYTES = 3_000_000
MAX_AUDIO_BASE64_CHARS = ((MAX_AUDIO_BYTES + 2) // 3) * 4

# MediaRecorder MIME (codec parameters stripped) -> the file extension the
# transcription endpoint uses to pick a decoder. Chrome/Firefox/Android record
# WebM or Ogg; Safari and the iOS WKWebView shell record MP4/AAC.
_EXTENSIONS = {
    "webm": "webm",
    "ogg": "ogg",
    "mp4": "mp4",
    "m4a": "m4a",
    "x-m4a": "m4a",
    "aac": "m4a",
    "mpeg": "mp3",
    "mp3": "mp3",
    "wav": "wav",
    "x-wav": "wav",
}

_DATA_URI_RE = re.compile(
    r"^data:audio/(?P<mime>[a-z0-9.+-]+)(?:;[a-z0-9=._+\"-]+)*;base64,"
    r"(?P<data>[A-Za-z0-9+/]*={0,2})$",
    flags=re.IGNORECASE,
)

TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe"

# A short context line improves names and parenting vocabulary. It is written
# in the parent's script so a zh-TW speaker is not transcribed into Simplified.
_PROMPTS = {
    "zh-TW": "這是一位家長在育兒 App 裡對 NURI 說的話，內容關於孩子的日常、發展和照顧。",
    "en": "A parent is talking to NURI, a parenting app, about their child's day, development and care.",
}
_DEFAULT_PROMPT = "这是一位家长在育儿 App 里对 NURI 说的话，内容关于孩子的日常、发展和照顾。"


class InvalidChatAudio(ValueError):
    """The uploaded value is not a supported, bounded audio clip."""


def _container_matches(ext: str, raw: bytes) -> bool:
    if ext == "webm":
        return raw.startswith(b"\x1a\x45\xdf\xa3")
    if ext == "ogg":
        return raw.startswith(b"OggS")
    if ext in {"mp4", "m4a"}:
        return len(raw) >= 12 and raw[4:8] == b"ftyp"
    if ext == "wav":
        return len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"
    if ext == "mp3":
        return raw.startswith(b"ID3") or (len(raw) >= 2 and raw[0] == 0xFF and raw[1] & 0xE0 == 0xE0)
    return False


def decode_audio_data_uri(value: object) -> tuple[bytes, str]:
    """Return ``(bytes, extension)`` or raise ``InvalidChatAudio``."""

    if not isinstance(value, str) or not value:
        raise InvalidChatAudio("Audio must be a base64 data URI")
    if len(value) > MAX_AUDIO_BASE64_CHARS + 128:
        raise InvalidChatAudio("Audio exceeds the 3 MB limit")
    match = _DATA_URI_RE.fullmatch(value)
    if not match or not match.group("data"):
        raise InvalidChatAudio("Unsupported audio encoding")
    ext = _EXTENSIONS.get(match.group("mime").lower())
    if not ext:
        raise InvalidChatAudio("Unsupported audio format")
    try:
        raw = base64.b64decode(match.group("data"), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidChatAudio("Malformed base64 audio") from exc
    if not raw or len(raw) > MAX_AUDIO_BYTES:
        raise InvalidChatAudio("Audio exceeds the 3 MB limit")
    if not _container_matches(ext, raw):
        raise InvalidChatAudio("Audio bytes do not match the declared format")
    return raw, ext


def transcription_prompt(locale: Optional[str]) -> str:
    locale = (locale or "").strip()
    if locale.lower().startswith("en"):
        return _PROMPTS["en"]
    if locale in {"zh-TW", "zh-HK", "zh-Hant"}:
        return _PROMPTS["zh-TW"]
    return _DEFAULT_PROMPT
