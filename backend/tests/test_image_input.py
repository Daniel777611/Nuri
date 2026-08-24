"""Chat image validation and model prompt wiring."""

from __future__ import annotations

import asyncio
import base64
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from backend import main
from backend.nuri_core import image_input
from backend.nuri_core.dialogue_reply import nuri_messages


def _data_uri(mime: str, raw: bytes) -> str:
    return f"data:image/{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _raster_data_uri(
    image_format: str,
    mime: str,
    *,
    size: tuple[int, int] = (2, 2),
    color: tuple[int, int, int] = (112, 76, 190),
) -> str:
    output = BytesIO()
    Image.new("RGB", size, color).save(output, format=image_format)
    return _data_uri(mime, output.getvalue())


JPEG = _raster_data_uri("JPEG", "jpeg")
PNG = _raster_data_uri("PNG", "png")
WEBP = _raster_data_uri("WEBP", "webp")


@pytest.mark.parametrize("value", [JPEG, PNG, WEBP])
def test_supported_raster_data_uris_are_accepted(value: str):
    assert image_input.validate_image_data_uri(value) == value


def test_jpg_alias_is_normalized_to_jpeg():
    value = JPEG.replace("image/jpeg", "image/jpg")
    assert image_input.validate_image_data_uri(value) == JPEG


@pytest.mark.parametrize(
    "value",
    [
        "data:image/svg+xml;base64,PHN2Zz4=",
        _data_uri("png", b"\xff\xd8\xffnot-a-png"),
        "data:image/jpeg;base64,not*base64",
        "https://example.com/family-photo.jpg",
    ],
)
def test_untrusted_or_spoofed_images_are_rejected(value: str):
    with pytest.raises(image_input.InvalidChatImage):
        image_input.validate_image_data_uri(value)


def test_request_model_applies_the_same_image_validation():
    body = main.UserMessageIn(text="请看看", image_base64=JPEG)
    assert body.image_base64 == JPEG
    with pytest.raises(ValidationError):
        main.UserMessageIn(
            text="请看看",
            image_base64=_data_uri("png", b"\xff\xd8\xffnot-a-png"),
        )


def test_valid_but_excessive_dimensions_are_rejected():
    too_wide = _raster_data_uri("PNG", "png", size=(4097, 1))
    with pytest.raises(image_input.InvalidChatImage, match="dimensions"):
        image_input.validate_image_data_uri(too_wide)


def test_latest_image_in_active_history_is_sent_to_the_model():
    history = [
        {"role": "user", "text": "第一张", "image_base64": PNG},
        {"role": "assistant", "text": "我看到了。"},
        {"role": "user", "text": "第二张", "image_base64": JPEG},
        {"role": "user", "text": "这张图说明了什么？"},
    ]

    messages, _ = nuri_messages(history, system_prompt="TEST")
    image_messages = [
        message for message in messages if isinstance(message.get("content"), list)
    ]

    assert len(image_messages) == 1
    parts = image_messages[0]["content"]
    assert parts[0] == {"type": "text", "text": "第二张"}
    assert parts[1]["image_url"]["url"] == JPEG
    assert messages[-1]["content"] == "这张图说明了什么？"


def test_text_only_history_keeps_plain_string_content():
    messages, _ = nuri_messages(
        [{"role": "user", "text": "你好"}],
        system_prompt="TEST",
    )
    assert messages[-1] == {"role": "user", "content": "你好"}


def test_chat_request_rejects_oversized_content_length_before_parsing():
    with TestClient(main.app) as client:
        response = client.post(
            "/api/chat/sessions/session-a/messages",
            headers={"Content-Length": "3700001"},
            content=b"{}",
        )
    assert response.status_code == 413


def test_private_chat_responses_are_never_cacheable():
    with TestClient(main.app) as client:
        response = client.get("/api/chat/sessions/session-a/messages")
    assert response.status_code == 401
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["vary"] == "Authorization"


def test_history_keeps_newest_images_without_unbounded_response_payloads():
    half_budget = main.MAX_CHAT_HISTORY_IMAGE_CHARS // 2 + 1
    original = [
        {"id": "old", "image_base64": "a" * half_budget},
        {"id": "new", "image_base64": "b" * half_budget},
    ]

    bounded = main._bound_chat_history_images(original)

    assert bounded[0]["image_base64"] is None
    assert bounded[1]["image_base64"].startswith("b")
    assert original[0]["image_base64"].startswith("a")


class _WipeTable:
    def __init__(self, database, name: str):
        self.database = database
        self.name = name
        self.user_id = None

    def delete(self):
        return self

    def eq(self, field: str, value: str):
        assert field == "user_id"
        self.user_id = value
        return self

    def execute(self):
        self.database.deleted.append((self.name, self.user_id))
        return type("Result", (), {"data": []})()


class _WipeDatabase:
    def __init__(self):
        self.deleted: list[tuple[str, str]] = []

    def table(self, name: str):
        return _WipeTable(self, name)


def test_privacy_wipe_includes_the_table_that_durably_holds_images(monkeypatch):
    database = _WipeDatabase()
    monkeypatch.setattr(main, "_get_supabase", lambda: database)

    asyncio.run(main._delete_persistent_user_history("parent-1"))

    assert ("chat_sessions", "parent-1") in database.deleted
    assert ("normalized_inputs", "parent-1") in database.deleted
    assert {table for table, _ in database.deleted} == set(
        main._PRIVACY_WIPE_USER_TABLES
    )
