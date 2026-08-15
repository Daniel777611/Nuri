"""Guards on the variance eval. No model calls — everything here is about
keeping the eval honest, which is a property of its inputs, not its output.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.evals import variance  # noqa: E402
from backend.nuri_core import exemplars  # noqa: E402


def test_questions_are_held_out_from_the_corpus():
    """An eval whose questions are also the few-shot examples measures copying
    rather than transfer, and reports a perfect score for a mechanism that has
    learned nothing. This is the assertion that keeps that from creeping in."""
    corpus = {e.question for e in exemplars.CORPUS}
    for q in variance.QUESTIONS:
        assert q["text"] not in corpus, q["id"]


def test_question_ids_are_unique():
    ids = [q["id"] for q in variance.QUESTIONS]
    assert len(ids) == len(set(ids))


def test_every_named_history_exists():
    for q in variance.QUESTIONS:
        if q.get("history"):
            assert q["history"] in variance.HISTORIES, q["id"]


def test_history_is_built_oldest_first_and_ends_on_the_question():
    q = next(q for q in variance.QUESTIONS if q.get("history"))
    history = variance.history_for(q)
    assert history[-1] == {"role": "user", "text": q["text"]}
    assert [m["role"] for m in history[:-1]] == ["user", "ai"] * (len(history) // 2)


def test_there_is_a_noise_floor_question():
    """One question must leave the gate shut. Its two arms then send an
    identical prompt, which is the only way to know how much of a before/after
    difference was ever the change."""
    shut = [q for q in variance.QUESTIONS if not exemplars.select(q["text"])]
    assert shut, "no off-domain question left to measure sampling spread with"


def test_the_gate_opens_for_the_rest():
    """The mirror of the above: if nothing fired, the eval would report a clean
    pass for a feature that never ran."""
    fired = [q for q in variance.QUESTIONS if exemplars.select(q["text"])]
    assert len(fired) >= len(variance.QUESTIONS) - 1


def test_scorer_reads_the_shape_that_matters():
    reply = {
        "text": "第一段。\n1. **粗体项**\n2. 第二项\n真的吗？",
        "task_proposals": [{"title": "x"}],
    }
    s = variance.score(reply)
    assert s["list_items"] == 2
    assert s["bold"] == 1
    assert s["questions"] == 1
    assert s["paragraphs"] == 4
    assert s["task_cards"] == 1


def test_scorer_survives_a_fallback_reply():
    assert variance.score({})["chars"] == 0
