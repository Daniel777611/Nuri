"""Per-call token accounting for every OpenAI request the backend makes.

`chat_turn_logs` measures one call — the reply model — and that call turns out
to be among the cheapest things the app does. The router, memory extraction,
task generation, the daily push and the feed's web-search research passes all
bill tokens that nothing has ever recorded, which is how a quota can empty out
while the turn-log page shows a few hundred thousand tokens for the week.

This module is the missing half. It is deliberately dumb: one row per provider
call, written inline, grouped by call site.

Three constraints shaped it:

* **It must be callable from a worker thread.** `content_research` — the
  suspected big spender — runs its provider calls through
  `anyio.to_thread.run_sync`, so an async-only recorder would miss exactly the
  rows worth having. Everything here is sync; `arecord` is the thin async
  wrapper for callers that are already on the event loop.
* **It must not be able to break a turn.** Every function swallows its own
  exceptions. A missing migration degrades this to a no-op with one warning per
  call, never a failed request.
* **It writes inline rather than buffering.** A buffer flushed at end of
  request is cheaper, but the process is a Vercel function that freezes the
  moment a response is returned, and streamed replies finish *after* the
  middleware has already run. Losing the expensive rows to a flush that never
  happened would defeat the point; one small insert beside a multi-second
  provider call is noise.
"""

from __future__ import annotations

import contextlib
import os
import sys
import uuid
from contextvars import ContextVar
from typing import Any, Iterable, Iterator, Optional

import anyio

from backend import runtime

#: Set per HTTP request so the several calls one user action fans out into can
#: be costed as a unit. A ContextVar rather than a parameter because the call
#: sites are eight layers below the route, and anyio copies the context into
#: worker threads, so `to_thread.run_sync` keeps seeing the right value.
_request_id: ContextVar[Optional[str]] = ContextVar("llm_request_id", default=None)

#: Set once per request by the auth dependency, which is the only choke point
#: every authenticated route already passes through. Without it the expensive
#: rows — research runs eight layers below the route — would all be anonymous,
#: and "which account is burning the quota" would stay unanswerable.
_user_id: ContextVar[Optional[str]] = ContextVar("llm_user_id", default=None)

_ENABLED = os.getenv("LLM_USAGE_LOGGING", "1").lower() not in {"0", "false", "no"}

#: Set by this module's own tests, which need `record` to reach their fake
#: client. Nothing else should touch it.
_ALLOW_IN_TESTS = False


def _suppressed() -> bool:
    """True when a write would be a test artefact rather than a measurement.

    There is no conftest and no test database: the suite runs against whatever
    `.env` provides, which on a developer machine is the real project Supabase.
    A test run therefore writes rows with fake models and fake accounts into the
    exact table the spend decisions are read from. That happened — 264 rows on
    the first run — and the table is only useful if everything in it is real.

    `"pytest" in sys.modules` rather than `PYTEST_CURRENT_TEST`, which pytest
    sets per test and so misses writes from module-level and fixture code.
    """
    if not _ENABLED:
        return True
    return "pytest" in sys.modules and not _ALLOW_IN_TESTS

#: One warning, not one per call: a missing migration would otherwise fill the
#: function logs with the same line for every request.
_warned = False

#: In-process sink, independent of the database write below. The eval harness
#: runs with LLM_USAGE_LOGGING=0 so a sweep is never billed to the spend table
#: as if it were parent traffic — but that also meant it could only see the one
#: call it made itself, `chat.reply`, and reported a per-turn cost missing the
#: router, the embedding, the task fallback and memory extraction. Those were
#: never uninstrumented; they were unreadable from outside the process.
_collector: ContextVar[Optional[list]] = ContextVar("llm_collector", default=None)


@contextlib.contextmanager
def collecting() -> Iterator[list[dict]]:
    """Capture every provider call made inside the block.

    Fills before the suppression check, so it works with logging off and under
    pytest — the two situations where measuring is most wanted and the database
    write is least wanted. anyio copies the context into worker threads, so the
    calls `to_thread.run_sync` makes land here too.
    """
    sink: list[dict] = []
    token = _collector.set(sink)
    try:
        yield sink
    finally:
        _collector.reset(token)


#: Summed by `totals`. `cached_prompt_tokens` is the one that answers "is the
#: prefix cache actually working" — it is a subset of prompt_tokens, billed at a
#: fraction, so a run where it stays at zero is a run paying full price for the
#: same persona every turn.
_SUMMED = ("prompt_tokens", "completion_tokens", "cached_prompt_tokens")


def totals(calls: Iterable[dict]) -> dict:
    """Roll a captured list up by call site, plus a grand total."""
    by_site: dict[str, dict] = {}
    grand = dict.fromkeys(_SUMMED, 0)
    grand["calls"] = 0
    for call in calls:
        row = by_site.setdefault(
            call["call_site"],
            {"calls": 0, "model": call.get("model") or "", **dict.fromkeys(_SUMMED, 0)},
        )
        row["calls"] += 1
        grand["calls"] += 1
        for key in _SUMMED:
            value = int(call.get(key) or 0)
            row[key] += value
            grand[key] += value
    cached = grand["cached_prompt_tokens"]
    prompt = grand["prompt_tokens"]
    grand["cache_hit_rate"] = round(100 * cached / prompt, 1) if prompt else 0.0
    return {"by_call_site": by_site, "total": grand}


def new_request_id() -> str:
    """Start a new correlation scope and return its id."""
    rid = uuid.uuid4().hex[:16]
    _request_id.set(rid)
    return rid


def current_request_id() -> Optional[str]:
    return _request_id.get()


def set_user(uid: Optional[str]) -> None:
    """Attribute every subsequent call in this request to `uid`."""
    _user_id.set(uid)


# ── Usage extraction ─────────────────────────────────────────────────────────
# The two SDK surfaces name every field differently — chat says
# prompt/completion_tokens, responses says input/output_tokens — and both nest
# the two numbers that matter most for diagnosis (reasoning, cached) one level
# down under names that also differ. Normalizing here rather than at each call
# site is what lets the summary endpoint group across both.

def _int(value: Any) -> Optional[int]:
    return value if isinstance(value, int) else None


def _get(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _first_int(obj: Any, *names: str) -> Optional[int]:
    for name in names:
        found = _int(_get(obj, name))
        if found is not None:
            return found
    return None


def _nested_int(obj: Any, containers: Iterable[str], name: str) -> Optional[int]:
    for container in containers:
        found = _int(_get(_get(obj, container), name))
        if found is not None:
            return found
    return None


def usage_fields(usage: Any) -> dict:
    """Normalize a chat, responses or embeddings usage object into columns."""
    if usage is None:
        return {}
    prompt = _first_int(usage, "prompt_tokens", "input_tokens")
    completion = _first_int(usage, "completion_tokens", "output_tokens")
    total = _first_int(usage, "total_tokens")
    if total is None and (prompt is not None or completion is not None):
        total = (prompt or 0) + (completion or 0)
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "reasoning_tokens": _nested_int(
            usage,
            ("completion_tokens_details", "output_tokens_details"),
            "reasoning_tokens",
        ),
        "cached_prompt_tokens": _nested_int(
            usage,
            ("prompt_tokens_details", "input_tokens_details"),
            "cached_tokens",
        ),
    }


def count_tool_calls(response: Any) -> Optional[int]:
    """Count the tool rounds in a Responses result.

    This is the number that explains a surprising bill. Each round re-sends the
    whole accumulated context, so `prompt_tokens` on a search-augmented call is
    roughly quadratic in this value rather than linear — which is invisible
    unless the count is recorded next to it.
    """
    output = _get(response, "output")
    if not isinstance(output, (list, tuple)):
        return None
    return sum(
        1
        for item in output
        if str(_get(item, "type") or "").endswith("_call")
    )


# ── Writing ──────────────────────────────────────────────────────────────────

def record(
    call_site: str,
    model: str,
    *,
    usage: Any = None,
    api: str = "chat",
    duration_ms: Optional[int] = None,
    tool_calls: Optional[int] = None,
    user_id: Optional[str] = None,
    status: str = "ok",
    error: Optional[str] = None,
) -> None:
    """Write one provider call. Safe to call from anywhere; never raises."""
    global _warned
    sink = _collector.get()
    if sink is not None:
        try:
            sink.append({
                "call_site": call_site, "model": model or "", "api": api,
                "status": status, "duration_ms": duration_ms,
                **usage_fields(usage),
            })
        except Exception:  # pragma: no cover - measuring must not raise either
            pass
    if _suppressed():
        return
    try:
        sb = runtime.get_supabase()
        if not sb:
            return
        row = {
            "id": uuid.uuid4().hex,
            "created_at": runtime.now(),
            "call_site": call_site,
            "model": model or "",
            "api": api,
            "user_id": user_id if user_id is not None else _user_id.get(),
            "request_id": _request_id.get(),
            "duration_ms": duration_ms,
            "tool_calls": tool_calls,
            "status": status,
            "error": (error or None) and str(error)[:500],
            **usage_fields(usage),
        }
        sb.table("llm_call_logs").insert(row).execute()
    except Exception as e:  # pragma: no cover - a metrics write must not matter
        if not _warned:
            _warned = True
            print(
                f"[warn] llm_call_logs insert failed ({type(e).__name__}: {e}); "
                "run supabase/llm_call_logs_migration.sql. Further failures are silent."
            )


async def arecord(call_site: str, model: str, **kwargs) -> None:
    """`record` for callers already on the event loop."""
    try:
        await anyio.to_thread.run_sync(
            lambda: record(call_site, model, **kwargs)
        )
    except Exception:  # pragma: no cover
        pass
