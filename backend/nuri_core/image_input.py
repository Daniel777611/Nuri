"""Validation and model formatting for user-supplied chat images.

The mobile client converts camera/gallery assets to a bounded JPEG before it
reaches this module. The server still treats the data URI as untrusted: a
client can bypass the app, lie about the MIME type, or send a request large
enough to exhaust a serverless function before the model ever sees it.
"""

from __future__ import annotations

import base64
import binascii
from io import BytesIO
import json
import re
import warnings
from typing import Optional

from PIL import Image, UnidentifiedImageError

# The request body also carries JSON/base64 overhead. This ceiling stays below
# common serverless body limits while retaining enough detail for screenshots
# and ordinary phone photos.
MAX_IMAGE_BYTES = 2_500_000
MAX_IMAGE_BASE64_CHARS = ((MAX_IMAGE_BYTES + 2) // 3) * 4
MAX_IMAGE_PIXELS = 16_000_000
MAX_IMAGE_DIMENSION = 4_096
MAX_BATCH_IMAGES = 10
MAX_BATCH_IMAGE_CHARS = 295_000
# Compact JSON for up to ten quoted, comma-separated data URIs.
MAX_BATCH_CHARS = MAX_BATCH_IMAGES * (MAX_BATCH_IMAGE_CHARS + 3) + 2

_DATA_URI_RE = re.compile(
    r"^data:image/(?P<mime>jpeg|jpg|png|webp);base64,(?P<data>[A-Za-z0-9+/]*={0,2})$",
    flags=re.IGNORECASE,
)


class InvalidChatImage(ValueError):
    """The uploaded value is not a supported, bounded raster image."""


def _detected_mime(raw: bytes) -> Optional[str]:
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


def validate_image_data_uri(value: object) -> Optional[str]:
    """Return a normalized data URI or raise ``InvalidChatImage``."""

    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise InvalidChatImage("Image must be a base64 data URI")
    if len(value) > MAX_IMAGE_BASE64_CHARS + 64:
        raise InvalidChatImage("Image exceeds the 2.5 MB limit")

    match = _DATA_URI_RE.fullmatch(value)
    if not match or not match.group("data"):
        raise InvalidChatImage("Unsupported image encoding")
    payload = match.group("data")
    if len(payload) > MAX_IMAGE_BASE64_CHARS:
        raise InvalidChatImage("Image exceeds the 2.5 MB limit")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidChatImage("Malformed base64 image") from exc
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise InvalidChatImage("Image exceeds the 2.5 MB limit")

    declared = match.group("mime").lower().replace("jpg", "jpeg")
    detected = _detected_mime(raw)
    if detected is None or detected != declared:
        raise InvalidChatImage("Image bytes do not match the declared format")

    # Magic bytes alone accept a truncated header and decompression bombs.
    # Pillow verifies the complete raster without retaining decoded pixels;
    # the explicit dimensions keep even valid-but-hostile images bounded.
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw)) as opened:
                actual_format = (opened.format or "").lower().replace("jpg", "jpeg")
                width, height = opened.size
                if actual_format != declared:
                    raise InvalidChatImage(
                        "Image bytes do not match the declared format"
                    )
                if (
                    width < 1
                    or height < 1
                    or width > MAX_IMAGE_DIMENSION
                    or height > MAX_IMAGE_DIMENSION
                    or width * height > MAX_IMAGE_PIXELS
                ):
                    raise InvalidChatImage("Image dimensions are too large")
                opened.verify()
    except InvalidChatImage:
        raise
    except (
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        UnidentifiedImageError,
        OSError,
        SyntaxError,
        ValueError,
    ) as exc:
        raise InvalidChatImage("Image file is damaged or unsafe") from exc
    return f"data:image/{declared};base64,{payload}"


def read_image_batch(value: object) -> Optional[list[str]]:
    """Read a replay-safe, ordered batch stored in the legacy text column."""
    if not isinstance(value, str) or not value.startswith("["):
        return None
    if len(value) > MAX_BATCH_CHARS:
        raise InvalidChatImage("Chat photo batch exceeds the size limit")
    try:
        items = json.loads(value)
    except (ValueError, RecursionError) as exc:
        raise InvalidChatImage("Invalid chat photo batch") from exc
    if not isinstance(items, list) or not 2 <= len(items) <= MAX_BATCH_IMAGES:
        raise InvalidChatImage("A chat photo batch must contain 2 to 10 photos")
    images = []
    for item in items:
        if not isinstance(item, str) or len(item) > MAX_BATCH_IMAGE_CHARS:
            raise InvalidChatImage("A photo in the chat batch exceeds the size limit")
        image = validate_image_data_uri(item)
        if image is None:
            raise InvalidChatImage("The chat photo batch includes an empty photo")
        images.append(image)
    return images


def validate_chat_image_input(value: object) -> Optional[str]:
    batch = read_image_batch(value)
    if batch is not None:
        # Comparing the canonical value keeps retries idempotent even when a
        # client used a different amount of JSON whitespace or MIME casing.
        return json.dumps(batch, separators=(",", ":"))
    return validate_image_data_uri(value)


def openai_user_content(text: object, image_data_uri: object) -> object:
    """Build Chat Completions content for the newest photo-bearing turn."""

    images = read_image_batch(image_data_uri)
    if images is None:
        image = validate_image_data_uri(image_data_uri)
        images = [image] if image else []
    if not images:
        return str(text or "").strip() or "请结合这张图片回答。"
    instruction = "请按顺序结合这些图片回答。" if len(images) > 1 else "请结合这张图片回答。"
    return [
        {"type": "text", "text": str(text or "").strip() or instruction},
        *({"type": "image_url", "image_url": {"url": image, "detail": "auto"}} for image in images),
    ]
