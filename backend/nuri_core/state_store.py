"""The rolling summary of one chat session.

This is what makes a short recent-message window safe. The window carries the
last eight messages; everything before them used to be carried by replaying up
to twenty messages verbatim on every single call, and now it is carried by one
capped paragraph refreshed a few times per conversation.

The economics are the whole point. Replaying is paid **per turn** and grows with
the conversation. Summarising is paid **once per few thousand tokens** and does
not grow — the summary is capped at CONTEXT_STATE_TOKEN_LIMIT, because a summary
allowed to grow is just the transcript again.

Every read degrades to "" and every write to a warning, matching the rest of the
family model: a session whose summary is missing gets a slightly thinner prompt,
never a failed turn. That also covers the deploy window before
`supabase/conversation_state_migration.sql` has been run.
"""
from __future__ import annotations

from typing import Optional

import anyio

from backend.nuri_core import context_budget
from backend import llm_usage, runtime
from backend.runtime import OPENAI_FAST_TIMEOUT_S, oai

#: Small and fast on purpose. This reads a transcript and writes a paragraph;
#: it is not the call the parent is waiting on, and paying reply-model rates for
#: it would undo what the summary is for.
STATE_MODEL = "gpt-5.4-mini"

_PROMPT = """把下面这段育儿对话压缩成一份「对话状态」，供 AI 顾问在后续回合中参考。

只保留后面几轮还需要用到的内容：
- 家长在处理的核心问题，以及已经确认的关键事实（孩子月龄、症状持续多久、试过什么、结果如何）
- 已经给过的建议方向，以及家长的反应（接受、拒绝、还没试）
- 还没解决、家长仍然在意的事

不要写寒暄，不要复述原话，不要加入对话里没有的推测。
用第三人称陈述，{limit} 字以内，直接输出正文。

对话：
{transcript}"""

#: Warn once rather than per turn — a missing migration would otherwise print
#: the same line for every message in every session.
_warned = False


async def load(session_id: str) -> tuple[str, int]:
    """(summary, tokens the summary already covers)."""
    sb = runtime.get_supabase()
    if not sb or not session_id:
        return "", 0
    try:
        res = await anyio.to_thread.run_sync(
            lambda: sb.table("chat_sessions")
            .select("state_summary,state_covered_tokens")
            .eq("id", session_id).maybe_single().execute()
        )
        row = (res.data if res else None) or {}
    except Exception as e:
        _warn_once(f"load: {e}")
        return "", 0
    return (row.get("state_summary") or ""), int(row.get("state_covered_tokens") or 0)


async def save(session_id: str, summary: str, covered_tokens: int) -> None:
    sb = runtime.get_supabase()
    if not sb or not session_id:
        return
    try:
        await anyio.to_thread.run_sync(
            lambda: sb.table("chat_sessions").update({
                "state_summary": summary,
                "state_covered_tokens": covered_tokens,
                "state_updated_at": runtime.now(),
            }).eq("id", session_id).execute()
        )
    except Exception as e:
        _warn_once(f"save: {e}")


def _warn_once(detail: str) -> None:
    global _warned
    if not _warned:
        _warned = True
        print(
            f"[warn] conversation state {detail}; run "
            "supabase/conversation_state_migration.sql. Further failures are silent."
        )


def summarize_sync(transcript: str, previous: str = "") -> str:
    """One capped paragraph. Returns "" rather than raising."""
    if not oai or not transcript.strip():
        return previous
    body = transcript
    if previous:
        # Fold the old summary in rather than dropping it: the span it covered
        # is not in the transcript any more, and re-reading it from messages
        # that have already been trimmed is not possible.
        body = f"[已有摘要]\n{previous}\n\n[新增对话]\n{transcript}"
    try:
        resp = oai.chat.completions.create(
            model=STATE_MODEL,
            messages=[{
                "role": "user",
                "content": _PROMPT.format(
                    limit=int(context_budget.STATE_TOKEN_LIMIT * 1.4), transcript=body,
                ),
            }],
            timeout=OPENAI_FAST_TIMEOUT_S,
        )
        llm_usage.record(
            "chat.state_summary", STATE_MODEL, usage=getattr(resp, "usage", None),
        )
        text = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        print(f"[warn] state summary failed: {type(e).__name__}: {e}")
        return previous
    # Clip regardless of what the model returned. The word limit in the prompt
    # is a request; the ceiling is the guarantee.
    return context_budget.clip(text, context_budget.STATE_TOKEN_LIMIT) or previous


async def refresh_if_needed(
    session_id: str, history: list[dict], kept: Optional[list[dict]] = None,
) -> None:
    """Re-summarise when enough conversation has fallen out of the window.

    Called after the reply has already been delivered — the parent never waits
    on this, and a failure costs a slightly thinner prompt next turn.
    """
    if not session_id or not history:
        return
    kept_ids = {id(m) for m in (kept if kept is not None else context_budget.recent_messages(history))}
    dropped = [m for m in history if id(m) not in kept_ids]
    dropped_tokens = sum(context_budget.estimate_tokens(m.get("text") or "") for m in dropped)
    previous, covered = await load(session_id)
    # Against what the last summary already covered, not against zero: otherwise
    # every turn past the threshold re-summarises the same span.
    if dropped_tokens - covered < context_budget.STATE_REFRESH_TOKENS:
        return
    transcript = "\n".join(
        f"{'家长' if m.get('role') == 'user' else 'NURI'}：{m.get('text') or ''}"
        for m in dropped
        if (m.get("text") or "").strip()
    )
    summary = await anyio.to_thread.run_sync(
        lambda: summarize_sync(transcript, previous)
    )
    if summary and summary != previous:
        await save(session_id, summary, dropped_tokens)
