"""4 结果学习模型 — 结果与决策，负面结果门.

The loop the other three subsystems are missing on their own: they can all
decide something, and none of them can find out whether it worked. This one
records what a turn actually did — which directives were in force, what topic,
what risk tier — and later attaches whatever signal comes back: the parent
adopted a task, marked an answer unhelpful, or a reviewer typed `#fix`.

What it emits is deliberately small and countable:

  * `directive_weights`  a multiplier per directive, from its own hit rate
  * `negative_topics`    topics where the last few attempts visibly missed
  * a directive per negative topic, which is the 负面结果门 in the diagram —
    not "try harder" but "change the approach, and say less until you know more"

A weight this layer cannot trace back to a counted signal is a weight nobody
will be able to debug in three months, so there are no learned terms here that
are not a ratio of two integers.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Sequence

from backend.nuri_core.contracts import Directive, LearnedPolicy
from backend.nuri_core.ports import CorePorts

TABLE = "nuri_turn_outcomes"

#: Signals worth learning from, and what each is worth. Adoption of a task and
#: an explicit "helpful" are not the same strength of evidence, and a reviewer
#: `#fix` is worth more than a parent silently moving on.
SIGNAL_WEIGHTS = {
    "helpful": 1.0,
    "task_adopted": 0.7,
    "continued": 0.3,
    "not_relevant": -1.0,
    "fix": -1.5,
}

#: Below this many signals a directive keeps its authored weight. Two parents
#: disagreeing is not evidence, and letting it move the weight would make the
#: system loudest exactly where it knows least.
MIN_SAMPLES = 4

#: How far a weight may travel from its authored value. A learned term that can
#: silently triple a rule's influence is a learned term that will eventually
#: have to be explained to somebody.
WEIGHT_FLOOR, WEIGHT_CEILING = 0.0, 1.5

#: Scaled so the strongest negative signal, sustained, lands exactly on the
#: floor: a directive every one of whose replies drew a `#fix` stops rendering
#: on its own. Any smaller step and the worst rule in the system keeps a
#: fraction of its voice forever, which is the failure mode this loop exists
#: to prevent. Derived rather than typed so it tracks SIGNAL_WEIGHTS.
WEIGHT_STEP = 1.0 / abs(min(SIGNAL_WEIGHTS.values()))

#: Negative signals on one topic before the gate closes on it.
NEGATIVE_TOPIC_THRESHOLD = 2

LOOKBACK_DAYS = 30
POLICY_TTL_S = 300.0

_NEGATIVE_TEXT = (
    "关于「{topic}」，之前给这位家长的说法没有帮上忙。不要再用同样的角度重来一次："
    "先问清楚具体卡在哪一步，确认之后再给建议，这一轮宁可少说。"
)

_cache: dict[str, tuple[LearnedPolicy, float]] = {}


def invalidate(uid: Optional[str]) -> None:
    if uid:
        _cache.pop(uid, None)


def clear_cache() -> None:
    _cache.clear()


def _cutoff(days: int = LOOKBACK_DAYS) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


async def policy(
    uid: Optional[str], ports: CorePorts, *, lookback_days: int = LOOKBACK_DAYS,
) -> LearnedPolicy:
    """Aggregate this family's recent outcomes into weights.

    Per family, not global. Two households can want opposite things from the
    same rule — one wants the citation, one finds it cold — and a global
    average of the two serves neither.

    Returns an empty policy on any failure, which is exactly the old pipeline's
    behaviour: every directive keeps its authored weight.
    """
    sb = ports.supabase()
    if not uid or not sb:
        return LearnedPolicy()

    cached = _cache.get(uid)
    if cached and cached[1] > time.monotonic():
        return cached[0]

    try:
        rows = await ports.to_thread(
            lambda: sb.table(TABLE)
            .select("topic,directive_ids,signal")
            .eq("user_id", uid)
            .neq("signal", "pending")
            .gte("created_at", _cutoff(lookback_days))
            .limit(400)
            .execute()
        )
        rows = getattr(rows, "data", None) or []
    except Exception as e:
        # Most likely the migration has not been run. A missing learning table
        # must cost the turn nothing.
        print(f"[warn] outcome: policy read failed: {type(e).__name__}: {e}")
        return LearnedPolicy()

    learned = summarize(rows)
    _cache[uid] = (learned, time.monotonic() + POLICY_TTL_S)
    return learned


def summarize(rows: Sequence[dict]) -> LearnedPolicy:
    """The pure half, so the learning rule can be tested without a database.

    Separated on purpose: this is the only place in the pipeline where numbers
    decide what NURI says, and it needs to be readable by someone who does not
    know FastAPI.
    """
    scores: dict[str, float] = {}
    counts: dict[str, int] = {}
    topic_negatives: dict[str, int] = {}

    for row in rows:
        signal = str(row.get("signal") or "")
        value = SIGNAL_WEIGHTS.get(signal)
        if value is None:
            continue
        for directive_id in row.get("directive_ids") or []:
            key = str(directive_id)
            scores[key] = scores.get(key, 0.0) + value
            counts[key] = counts.get(key, 0) + 1
        if value < 0:
            topic = str(row.get("topic") or "").strip()
            if topic:
                topic_negatives[topic] = topic_negatives.get(topic, 0) + 1

    weights: dict[str, float] = {}
    for key, total in scores.items():
        n = counts[key]
        if n < MIN_SAMPLES:
            continue
        # Mean signal in [-1.5, 1.0], mapped onto a multiplier around 1.0. A
        # directive that is consistently followed by a `#fix` reaches zero and
        # stops rendering, without anyone having to delete the row.
        weights[key] = max(WEIGHT_FLOOR, min(WEIGHT_CEILING, 1.0 + (total / n) * WEIGHT_STEP))

    negative = tuple(
        topic for topic, n in sorted(topic_negatives.items(), key=lambda kv: -kv[1])
        if n >= NEGATIVE_TOPIC_THRESHOLD
    )[:3]

    return LearnedPolicy(
        directive_weights=weights,
        negative_topics=negative,
        directives=tuple(
            Directive(
                id=f"outcome.negative.{topic}",
                text=_NEGATIVE_TEXT.format(topic=topic),
                layer="outcome",
                kind="gate",
                priority=800,
                applies_when={"topics": [topic]},
                source="learned",
            )
            for topic in negative
        ),
        samples=len(rows),
    )


async def record(
    *,
    uid: Optional[str],
    session_id: str,
    turn_id: str,
    topic: str,
    risk_tier: str,
    directive_ids: Sequence[str],
    ports: CorePorts,
) -> None:
    """Open the loop: log what this turn decided, with no signal yet.

    Written after the reply has already reached the parent, so a failure here
    costs a learning sample and nothing else.
    """
    sb = ports.supabase()
    if not uid or not sb:
        return
    row = {
        "id": str(uuid.uuid4()),
        "user_id": uid,
        "session_id": session_id,
        "turn_id": turn_id,
        "topic": (topic or "")[:40],
        "risk_tier": risk_tier or "none",
        "directive_ids": list(directive_ids)[:40],
        "signal": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await ports.to_thread(lambda: sb.table(TABLE).insert(row).execute())
    except Exception as e:
        print(f"[warn] outcome: record failed: {type(e).__name__}: {e}")


async def observe(
    *, turn_id: str, signal: str, uid: Optional[str], ports: CorePorts,
) -> None:
    """Close the loop: attach the signal that arrived after the fact.

    Keyed by turn rather than by directive, because what a parent reacts to is
    a reply — attributing the reaction across the directives that shaped it is
    `summarize`'s job, and keeping that split means the attribution rule can be
    changed later without re-collecting the data.
    """
    sb = ports.supabase()
    if not sb or signal not in SIGNAL_WEIGHTS:
        return
    try:
        await ports.to_thread(
            lambda: sb.table(TABLE)
            .update({"signal": signal, "observed_at": datetime.now(timezone.utc).isoformat()})
            .eq("turn_id", turn_id)
            .eq("signal", "pending")
            .execute()
        )
    except Exception as e:
        print(f"[warn] outcome: observe failed: {type(e).__name__}: {e}")
        return
    invalidate(uid)


async def observe_latest(*, uid: Optional[str], signal: str, ports: CorePorts) -> None:
    """Attach a signal to this family's most recent open turn.

    For reactions that arrive without a turn id — a reviewer's `#fix` is typed
    into the chat, not clicked on a reply. The newest pending row is the turn
    they are objecting to, since the correction is the very next thing they
    send after reading it.
    """
    sb = ports.supabase()
    if not uid or not sb or signal not in SIGNAL_WEIGHTS:
        return
    try:
        res = await ports.to_thread(
            lambda: sb.table(TABLE).select("turn_id")
            .eq("user_id", uid).eq("signal", "pending")
            .order("created_at", desc=True).limit(1).execute()
        )
        rows = getattr(res, "data", None) or []
    except Exception as e:
        print(f"[warn] outcome: observe_latest lookup failed: {type(e).__name__}: {e}")
        return
    if rows:
        await observe(turn_id=rows[0]["turn_id"], signal=signal, uid=uid, ports=ports)
