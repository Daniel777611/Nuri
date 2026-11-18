"""Alpha account and Community display-name policy."""

import re
from backend.runtime import is_alpha_backend

CHINESE_NAME_LIMIT = 8
CHINESE_NAME_TOO_LONG = "CHINESE_DISPLAY_NAME_TOO_LONG"

# Han ranges include the ideographic iteration mark and compatibility forms.
# Keep these ranges in step with native-ios/src/profileDisplayName.ts.
_HAN = re.compile(
    r"[\u2e80-\u2e99\u2e9b-\u2ef3\u2f00-\u2fd5\u3005\u3007\u3021-\u3029"
    r"\u3038-\u303b\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufa6d\ufa70-\ufad9"
    r"\U00016fe2-\U00016fe3\U00016ff0-\U00016ff6\U00020000-\U0002a6df"
    r"\U0002a700-\U0002b81d\U0002b820-\U0002cead\U0002ceb0-\U0002ebe0"
    r"\U0002ebf0-\U0002ee5d\U0002f800-\U0002fa1d\U00030000-\U0003134a\U00031350-\U00033479]"
)


def exceeds_chinese_name_limit(value: str) -> bool:
    if not is_alpha_backend():
        return False
    name = value.strip()
    return len(name) > CHINESE_NAME_LIMIT and _HAN.search(name) is not None


def generated_display_name(value: str) -> str:
    """Identity providers supply a default for new accounts only."""
    return value.strip()[:CHINESE_NAME_LIMIT] if exceeds_chinese_name_limit(value) else value
