"""Resource-language preference, shared by the feed and the privacy settings.

Three functions and a set, split out only because both the delivery layer and
the store layer need them and neither should import the other. `zh` is accepted
and normalised because older clients still send it.
"""

from __future__ import annotations

from typing import Optional

SUPPORTED_PREFERRED_LOCALES = frozenset({"zh-CN", "zh-TW", "en"})


def normalize_preferred_locale(value: object) -> str:
    if value == "zh":
        return "zh-CN"
    if isinstance(value, str) and value in SUPPORTED_PREFERRED_LOCALES:
        return value
    return "zh-CN"


def with_requested_preferred_locale(
    context: dict,
    requested_locale: Optional[str],
) -> dict:
    """Apply a one-request resource locale without mutating saved privacy."""

    effective_locale = (
        requested_locale
        if requested_locale in SUPPORTED_PREFERRED_LOCALES
        else normalize_preferred_locale(context.get("preferred_locale"))
    )
    return {**context, "preferred_locale": effective_locale}
