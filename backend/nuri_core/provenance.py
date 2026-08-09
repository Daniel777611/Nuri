"""横切 Evaluation 与 Provenance — 推断与向量化，版本与回归.

Cross-cutting because it has to answer questions about the pipeline that no
single subsystem can: which layer spent the time, which one supplied the
sentence the parent objected to, and — the reason this branch exists — whether
four subsystems actually beat the linear path they replace.

A trace is per-turn and cheap: counters and string lengths, no prompt text. It
lands in two places. The flat half merges into the existing `chat_turn_logs`
row, so the columns already being watched keep working. The structured half
goes to `nuri_turn_traces` when that table exists, which is what makes a
directive answerable for its own outcomes.

Nothing in this module may raise or add latency. It runs on the reply path.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

TRACE_TABLE = "nuri_turn_traces"


@dataclass
class TurnTrace:
    """One turn's record of who did what, accumulated as the turn runs."""

    turn_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    pipeline: str = "four_model"
    version: str = ""
    #: subsystem -> elapsed ms
    timings: dict[str, int] = field(default_factory=dict)
    #: subsystem -> rendered characters it contributed to the prompt
    contributions: dict[str, int] = field(default_factory=dict)
    #: Free-form counters: cache hits, directive counts, skip reasons.
    facts: dict[str, Any] = field(default_factory=dict)
    #: Every directive in force this turn, in render order. The join key
    #: between a reply and the outcome that follows it.
    directive_ids: list[str] = field(default_factory=list)

    _t0: float = field(default_factory=time.perf_counter, repr=False)

    def stage(self, name: str) -> "_Stage":
        """Time a subsystem: `async with trace.stage("family"): ...`"""
        return _Stage(self, name)

    def mark(self, name: str, started: float) -> None:
        self.timings[name] = int((time.perf_counter() - started) * 1000)

    def contributed(self, name: str, text: str) -> None:
        if text:
            self.contributions[name] = len(text)

    def note(self, **facts: Any) -> None:
        self.facts.update(facts)

    @property
    def total_ms(self) -> int:
        return int((time.perf_counter() - self._t0) * 1000)

    # ── outputs ───────────────────────────────────────────────────────────

    #: Exactly the columns four_model_migration.sql adds to chat_turn_logs.
    #: Curated rather than generated: Supabase rejects an insert naming a
    #: column that does not exist, and this row is written by the same call
    #: that carries every existing turn metric — a new counter must never be
    #: able to take the whole row down with it.
    FLAT_COLUMNS = (
        "pipeline", "pipeline_version", "risk_tier", "family_cache_hit",
        "directives_loaded", "directives_applied", "retrieved_stores",
        "outcome_samples", "ms_family_enrich", "ms_knowledge", "ms_dialogue",
        "ms_outcome", "ms_directives",
    )

    def metrics_row(self) -> dict:
        """The flat half, merged into `chat_turn_logs` beside the existing
        per-turn metrics so both pipelines stay comparable row for row."""
        row = {
            "pipeline": self.pipeline,
            "pipeline_version": self.version,
            "risk_tier": self.facts.get("risk_tier", "none"),
            "family_cache_hit": bool(self.facts.get("family_cache_hit")),
            "directives_loaded": int(self.facts.get("directives_loaded") or 0),
            "directives_applied": int(self.facts.get("directives_applied") or 0),
            "retrieved_stores": str(self.facts.get("retrieved") or ""),
            "outcome_samples": int(self.facts.get("outcome_samples") or 0),
        }
        for stage in ("family_enrich", "knowledge", "dialogue", "outcome", "directives"):
            row[f"ms_{stage}"] = self.timings.get(stage, 0)
        return row

    def record(self) -> dict:
        """The structured half, for `nuri_turn_traces`. No prompt text — only
        what each layer contributed and how much of it."""
        return {
            "id": self.turn_id,
            "pipeline": self.pipeline,
            "pipeline_version": self.version,
            "total_ms": self.total_ms,
            "timings": dict(self.timings),
            "contributions": dict(self.contributions),
            "facts": dict(self.facts),
            "directive_ids": list(self.directive_ids),
        }


class _Stage:
    def __init__(self, trace: TurnTrace, name: str):
        self._trace, self._name = trace, name
        self._started = 0.0

    def __enter__(self) -> "_Stage":
        self._started = time.perf_counter()
        return self

    def __exit__(self, *_exc) -> bool:
        self._trace.mark(self._name, self._started)
        return False

    async def __aenter__(self) -> "_Stage":
        return self.__enter__()

    async def __aexit__(self, *exc) -> bool:
        return self.__exit__(*exc)


async def persist(trace: TurnTrace, *, session_id: str, user_id: Optional[str], ports) -> None:
    """Write the structured trace. Called after the reply has been delivered,
    and silent about a missing table — the trace is an instrument, and an
    instrument that can break the thing it measures is worse than none."""
    sb = ports.supabase()
    if not sb:
        return
    row = trace.record()
    row.update({"session_id": session_id, "user_id": user_id})
    try:
        await ports.to_thread(lambda: sb.table(TRACE_TABLE).insert(row).execute())
    except Exception as e:
        print(f"[warn] provenance: {TRACE_TABLE} insert: {type(e).__name__}: {e}")


def compare(a: Mapping[str, Any], b: Mapping[str, Any]) -> dict:
    """Diff two trace records — the linear pipeline's against this one's.

    Pure, so the comparison can be run over a table of stored traces offline
    rather than only live. Positive `delta_ms` means `b` was slower.
    """
    keys = sorted(set(a.get("timings", {})) | set(b.get("timings", {})))
    return {
        "delta_total_ms": int(b.get("total_ms", 0)) - int(a.get("total_ms", 0)),
        "by_stage": {
            k: int(b.get("timings", {}).get(k, 0)) - int(a.get("timings", {}).get(k, 0))
            for k in keys
        },
        "delta_prompt_chars": (
            sum(b.get("contributions", {}).values()) - sum(a.get("contributions", {}).values())
        ),
        "only_in_b": sorted(set(b.get("directive_ids", [])) - set(a.get("directive_ids", []))),
        "only_in_a": sorted(set(a.get("directive_ids", [])) - set(b.get("directive_ids", []))),
    }
