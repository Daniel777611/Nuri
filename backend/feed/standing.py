"""What the home cards must not contradict.

The daily post and the daily video used to know a family only through the
onboarding concerns and the last eight messages. A parent who said weeks ago
that they had stopped sleep training was still shown sleep-training posts: the
concern "睡眠" they ticked at sign-up never expired, and the sentence that
overturned it had long scrolled out of the window.

The standing memories (``family_store.load_standing_memories``) close that gap
in two places:

1. **Before the pick.** The plan and pick prompts are told what the family's
   situation rules out, so the model searches and chooses around it.
2. **After the pick.** A separate yes/no check on the finished card. Telling a
   picker "don't" is a preference it weighs against fit; a conflict such as
   瘫痪 versus 跑步 is semantic, with no shared words to catch, and is the one
   mistake a card cannot be allowed to make. One small call per generated card,
   and a card is generated once a day.

The check fails open: if the model cannot be reached the card is shown, because
the prompt already carried the constraints and an empty home screen is its own
failure. It is logged under its own call site so a rise is visible.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Sequence

from backend import llm_usage, runtime

MODEL = os.getenv("STANDING_CHECK_MODEL", "gpt-5.4-mini")
TIMEOUT_S = float(os.getenv("STANDING_CHECK_TIMEOUT_S", "15"))


def prompt_block(standing: Sequence[str]) -> str:
    """The constraints, phrased for a plan or pick prompt. Empty when none."""
    lines = [s for s in standing if s]
    if not lines:
        return ""
    return (
        "这个家庭现在的状况和限制（家长之前说过，长期有效）：\n"
        + "\n".join(f"- {s}" for s in lines)
        + "\n与这些冲突的内容一律不要选，即使问题本身相关"
        "（例如家长已经不训睡了，就不要选讲训睡方法的；孩子行动受限，就不要选靠跑跳的活动）。"
    )


_CHECK_SYSTEM = """你是 NURI 的推荐审核。下面是一张准备推给某位家长的卡片，以及这个家庭长期有效的状况和限制。
判断这张卡片的主要内容或建议，是否与其中任何一条冲突——也就是家长看了会觉得"你根本没记住我说过的话"，或者照做对这个孩子不合适、不安全。
- 只是话题相近但不冲突的，不算（例如家长不训睡了，卡片讲的是睡前仪式、作息安排，不算冲突）。
- 卡片在讲被家长明确拒绝或已经停止的做法，算冲突。
- 卡片建议的活动或做法不适合孩子的身体状况、过敏或诊断，算冲突。"""

_CHECK_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "standing_conflict",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                # Before the verdict on purpose, so the verdict follows from it.
                "reason": {"type": "string"},
                "conflict": {"type": "boolean"},
            },
            "required": ["reason", "conflict"],
            "additionalProperties": False,
        },
    },
}


def conflicts(card_text: str, standing: Sequence[str], *, call_site: str) -> bool:
    """Whether the card contradicts any standing memory. Blocking; call off
    the event loop. False on any failure (see the module docstring)."""
    lines = [s for s in standing if s]
    if not lines or not (card_text or "").strip():
        return False
    client = runtime.oai
    if client is None:
        return False
    prompt = (
        "家庭的状况和限制：\n" + "\n".join(f"- {s}" for s in lines)
        + "\n\n卡片内容：\n" + card_text.strip()[:1500]
    )
    started = datetime.now(timezone.utc)
    try:
        resp = client.with_options(timeout=TIMEOUT_S).chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": _CHECK_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            response_format=_CHECK_FORMAT,
        )
    except Exception as exc:
        llm_usage.record(
            call_site, MODEL, status="error", error=f"{type(exc).__name__}: {exc}",
            duration_ms=int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        )
        print(f"[warn] standing check failed open: {type(exc).__name__}")
        return False
    llm_usage.record(
        call_site, MODEL, usage=getattr(resp, "usage", None),
        duration_ms=int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
    )
    try:
        data = json.loads(resp.choices[0].message.content or "{}")
    except (TypeError, ValueError):
        return False
    if data.get("conflict") is True:
        print(f"[info] standing check rejected a card: {str(data.get('reason') or '')[:120]}")
        return True
    return False
