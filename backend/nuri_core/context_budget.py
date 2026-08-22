"""What goes in the prompt, in what order, and how much of it.

Replaces "resend the last twenty turns verbatim". Measured over 1,194 eval
turns, the reply model averaged 2,687 input tokens against 235 output — twelve
to one — and 56% of the input was a system block that is byte-identical every
turn. Both halves of that are addressed here: a budget that caps each
contributor, and an order that lets the provider's prefix cache reach as far
into the prompt as it can.

**The order is the caching mechanism.** OpenAI caches the longest identical
prefix of a request automatically, in 128-token blocks, for prompts over ~1024
tokens. There is no flag; the only lever is what comes first. So the blocks are
laid out strictly most-stable to most-volatile:

    system persona + JSON contract + style rules   identical for every user
    child profile                                  stable for one family
    conversation state                             changes every few thousand tokens
    long-term memory                               changes as the parent tells us things
    recent messages                                changes every turn
    current user message                           always new

Everything above the first line that moves gets cached. Putting retrieved
sources or the current question anywhere but last would truncate the cache to
whatever precedes them, which is what the old single concatenated string did.

Nothing here does I/O or calls a model, so the whole budget is testable without
spending anything.
"""
from __future__ import annotations

import os
from typing import Iterable, Optional

#: Characters per token. CJK runs richer than English — a Chinese character is
#: usually its own token while English averages ~4 chars — and these prompts are
#: mixed. 2.6 was measured against the eval sweep: 3,758 mean system chars
#: against ~1,440 tokens of system block.
#:
#: Deliberately an estimate rather than tiktoken. The budget only has to be
#: approximately right to stop a prompt running away, and a hard dependency that
#: downloads an encoding at import time is a worse trade in a serverless
#: function than being 10% out.
CHARS_PER_TOKEN = float(os.getenv("CONTEXT_CHARS_PER_TOKEN", "2.6"))

#: Recent conversation, in turns and in tokens. The turn count is the intent;
#: the token ceiling is the guard, because eight turns of a parent pasting a
#: pediatrician's report is not eight turns of "好的".
RECENT_MESSAGES = int(os.getenv("CONTEXT_RECENT_MESSAGES", "8"))
RECENT_TOKEN_LIMIT = int(os.getenv("CONTEXT_RECENT_TOKEN_LIMIT", "3000"))

#: The rolling summary that carries everything older than the recent window.
STATE_TOKEN_LIMIT = int(os.getenv("CONTEXT_STATE_TOKEN_LIMIT", "600"))

#: Long-term memory: the three most relevant facts, not the twelve most recent.
#: `_get_memory_context` used to pass limit=12, which is how a block meant to
#: replace history became its own history.
MEMORY_TOP_K = int(os.getenv("CONTEXT_MEMORY_TOP_K", "3"))
MEMORY_TOKEN_LIMIT = int(os.getenv("CONTEXT_MEMORY_TOKEN_LIMIT", "150"))

#: Re-summarise once the conversation carries more than this. Below it the
#: recent window still holds the whole conversation and a summary would only
#: restate what the model can already read.
STATE_REFRESH_TOKENS = int(os.getenv("CONTEXT_STATE_REFRESH_TOKENS", "3500"))


def estimate_tokens(text: str) -> int:
    return int(len(text or "") / CHARS_PER_TOKEN) if text else 0


def clip(text: str, token_limit: int) -> str:
    """Trim to a token budget on a sentence boundary where one is close.

    Cutting mid-sentence leaves the model reading a fact that stops halfway,
    which is worse than one sentence less: it invites completion of the thought
    from nothing.
    """
    text = (text or "").strip()
    if not text or estimate_tokens(text) <= token_limit:
        return text
    limit = int(token_limit * CHARS_PER_TOKEN)
    head = text[:limit]
    for terminator in ("。", "！", "？", ".", "!", "?", "\n"):
        cut = head.rfind(terminator)
        if cut >= limit * 0.6:
            return head[: cut + 1].strip()
    return head.rstrip() + "…"


def _bigrams(text: str) -> set[str]:
    """Character bigrams, lowercased.

    Character-level rather than word-level because half this traffic is Chinese,
    which has no spaces — a whitespace tokenizer scores every Chinese memory as
    one enormous token and matches nothing.
    """
    squeezed = "".join((text or "").lower().split())
    return {squeezed[i : i + 2] for i in range(len(squeezed) - 1)}


def relevance(text: str, query: str) -> float:
    """Overlap of `text` with `query`, 0..1.

    Deliberately not embeddings. This picks three items out of a few dozen, and
    an embedding call per turn to rank a handful of short strings would spend
    more than the block it is trimming.
    """
    a, b = _bigrams(text), _bigrams(query)
    if not a or not b:
        return 0.0
    return len(a & b) / len(b)


def select_memories(
    memories: Iterable[dict], query: str = "", top_k: int = MEMORY_TOP_K,
) -> list[dict]:
    """The `top_k` most relevant, each clipped to its own ceiling.

    Relevance before recency: ordering by recency alone reduces to "the last few
    things said", which the recent window already carries. With no query to rank
    against, recency is the honest fallback.
    """
    scored = [
        (relevance(m.get("text") or "", query), str(m.get("updated_at") or ""), m)
        for m in memories
        if (m.get("text") or "").strip()
    ]
    scored.sort(key=lambda row: (row[0], row[1]), reverse=True)
    return [
        {**m, "text": clip(m["text"], MEMORY_TOKEN_LIMIT), "score": round(score, 3)}
        for score, _, m in scored[:top_k]
    ]


def memory_block(memories: Iterable[dict], query: str = "") -> str:
    return "\n".join(f"- {m['text']}" for m in select_memories(memories, query))


def recent_messages(
    history: list[dict],
    count: int = RECENT_MESSAGES,
    token_limit: int = RECENT_TOKEN_LIMIT,
) -> list[dict]:
    """The tail of the conversation, under both ceilings.

    Walks backwards so the newest survive, and keeps the current user message
    even when it alone exceeds the budget — a turn that drops the question it is
    answering is not a cheaper turn, it is a broken one.
    """
    tail = [m for m in (history or []) if (m.get("text") or "").strip()][-count:]
    if not tail:
        return []
    kept: list[dict] = []
    spent = 0
    for message in reversed(tail):
        cost = estimate_tokens(message.get("text") or "")
        if kept and spent + cost > token_limit:
            break
        kept.append(message)
        spent += cost
    kept.reverse()
    return kept


def needs_state_refresh(
    history: list[dict],
    kept: Optional[list[dict]] = None,
    threshold: int = STATE_REFRESH_TOKENS,
) -> bool:
    """Is there enough conversation outside the recent window to summarise?

    Measured on what the window drops, not on the whole conversation: a long
    chat that still fits in eight messages has nothing for a summary to add.
    """
    if not history:
        return False
    kept_ids = {id(m) for m in (kept if kept is not None else recent_messages(history))}
    dropped = sum(
        estimate_tokens(m.get("text") or "")
        for m in history
        if id(m) not in kept_ids
    )
    return dropped >= threshold


#: (heading, body) in prompt order. The two `cacheable` groups are split into
#: separate system messages by the assembler so the boundary between "same for
#: everyone" and "same for this family" is a real one the cache can land on.
def build_sections(
    *,
    child_profile: str = "",
    conversation_state: str = "",
    memory: str = "",
    card: str = "",
    internal: str = "",
    sources: str = "",
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Return (per-family blocks, per-turn blocks).

    Per-family is everything that holds still while one parent talks to NURI.
    Per-turn is what this question pulled in — retrieval, sources, the card.
    Keeping them apart is what makes the cache boundary predictable.
    """
    per_family = [
        ("这位家长的基本情况（来自注册信息）：", child_profile.strip()),
        ("这次对话到目前为止（摘要）：", clip(conversation_state, STATE_TOKEN_LIMIT)),
    ]
    per_turn = [
        ("关于这位家长的长期信息（已确认，可直接使用，不用重新确认）：", memory.strip()),
        ("本次对话相关内容：", card.strip()),
        ("", internal.strip()),
        # Last, and after the internal rules on purpose: external pages are the
        # weakest tier of context NURI has, and the block itself says so.
        ("", sources.strip()),
    ]
    return (
        [(h, b) for h, b in per_family if b],
        [(h, b) for h, b in per_turn if b],
    )


def render(sections: Iterable[tuple[str, str]]) -> str:
    return "\n\n".join(
        f"{heading}\n{body}" if heading else body for heading, body in sections
    )
