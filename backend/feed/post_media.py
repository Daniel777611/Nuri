"""Bounded, read-only validation of provider-supplied social source images.

No page fetch, login, generic image search or model-generated URL is used.
Tavily source-linked images can include page furniture; reject known avatar,
profile, logo and icon metadata instead of presenting it as a post thumbnail.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlsplit

_CDNS = ("fbcdn.net", "cdninstagram.com")
_CREDENTIAL = re.compile(r"^(access_token|refresh_token|authorization|password|api_key|apikey|jwt)$", re.I)
_FURNITURE = re.compile(r"avatar|profile[\s_-]*(?:picture|photo|image)|favicon|\blogo\b|\bicon\b", re.I)
_PROFILE_PATH = re.compile(r"/t\d+(?:\.\d+)*-(?:1|19)/", re.I)


def social_image_url(value: object, description: str = "") -> str | None:
    if not isinstance(value, str) or len(value) > 4096 or re.search(r"[\x00-\x20\x7f\\]", value):
        return None
    try:
        description = description if isinstance(description, str) else ""
        url = urlsplit(value)
        host = (url.hostname or "").lower()
        if (url.scheme != "https" or url.username or url.password or url.port
                or not any(host == root or host.endswith("." + root) for root in _CDNS)
                or not re.search(r"\.(?:jpe?g|png|webp|avif|gif)$", url.path, re.I)
                or _FURNITURE.search(url.path) or _FURNITURE.search(description)
                or _PROFILE_PATH.search(url.path)
                or any(_CREDENTIAL.match(key) for key, _ in parse_qsl(url.query))):
            return None
        return value
    except (TypeError, ValueError):
        return None


def source_image_urls(images: object) -> tuple[str, ...]:
    """At most two validated images belonging to the chosen source result."""
    if not isinstance(images, (tuple, list)):
        return ()
    out: list[str] = []
    for image in images[:8]:
        safe = social_image_url(getattr(image, "url", None), getattr(image, "description", ""))
        if safe and safe not in out:
            out.append(safe)
        if len(out) == 2:
            break
    return tuple(out)
