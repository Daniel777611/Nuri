"""Guards on the coherence eval. No model calls: what needs checking is that
the fixtures can actually catch what they claim to, which is a property of the
fixtures.
"""
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.evals import coherence  # noqa: E402


def _probes(kind):
    return [(c, t) for c in coherence.CONVERSATIONS
            for t in c["turns"] if t.get("probe") == kind]


def test_all_failure_modes_are_covered():
    kinds = {t.get("probe") for c in coherence.CONVERSATIONS for t in c["turns"]}
    assert {"改口", "遗忘", "自相矛盾", "语言"} <= kinds
    # 人格漂移 has no probe — it is computed over every turn.
    assert coherence.drift([{"chars": 1, "list_items": 0, "bold": 0}] * 4)


def test_both_the_guarded_and_unguarded_paths_are_covered():
    """Exemplars cover six topics, not everything. A suite that only tested
    covered subjects would report a register that holds wherever it is being
    held up, and say nothing about the subjects running on the prose ceiling
    alone — which is where it is most likely to slip."""
    from backend.nuri_core import exemplars
    opens = {c["id"] for c in coherence.CONVERSATIONS
             if exemplars.select(c["turns"][0]["say"])}
    assert opens, "no conversation exercises the guarded path"
    assert set(c["id"] for c in coherence.CONVERSATIONS) - opens, \
        "no conversation exercises the unguarded path"


@pytest.mark.parametrize("text,zht,zhs", [
    ("這個孩子還沒開始說話", True, False),
    ("这个孩子还没开始说话", False, True),
])
def test_script_detection_separates_the_two(text, zht, zhs):
    t, s = coherence.script_of(text)
    assert (t > s) is zht
    assert (s > t) is zhs


def test_script_probe_targets_a_conversation_where_exemplars_fire():
    """The script risk exists only when a Traditional example is in the prompt.
    A Simplified probe on a turn with no exemplars would test nothing."""
    from backend.nuri_core import exemplars
    for c in coherence.CONVERSATIONS:
        if any(t.get("script") for t in c["turns"]):
            assert exemplars.select(c["turns"][0]["say"]), c["id"]


def test_the_simplified_fixture_is_actually_simplified():
    convo = next(c for c in coherence.CONVERSATIONS
                 if any(t.get("script") == "zhs" for t in c["turns"]))
    zht, zhs = coherence.script_of(" ".join(t["say"] for t in convo["turns"]))
    assert zhs > zht, "a Simplified probe written in Traditional tests nothing"


def test_every_probe_explains_itself():
    for c in coherence.CONVERSATIONS:
        for t in c["turns"]:
            if t.get("probe"):
                assert t.get("why"), (c["id"], t["say"])


def test_probe_patterns_compile_and_are_not_vacuous():
    for c in coherence.CONVERSATIONS:
        for t in c["turns"]:
            for key in ("require", "forbid"):
                if t.get(key):
                    assert re.compile(t[key])
                    assert not re.search(t[key], ""), (c["id"], key)


def test_planted_facts_fall_outside_the_default_window():
    """The recall probe only tests anything if the fact it asks about has left
    the window by the time it is asked. Six turns of window is 12 messages."""
    default = 6
    for c in coherence.CONVERSATIONS:
        for i, t in enumerate(c["turns"]):
            if t.get("probe") == "遗忘":
                assert i >= default, (c["id"], i)


def test_contradiction_probes_come_in_pairs():
    pairs = {}
    for c in coherence.CONVERSATIONS:
        for t in c["turns"]:
            if t.get("pair"):
                pairs.setdefault((c["id"], t["pair"]), []).append(t)
    assert pairs
    for key, members in pairs.items():
        assert len(members) == 2, key


def test_memory_block_matches_the_shape_family_store_renders():
    """A block in any other shape tests a prompt the app never builds."""
    from backend.nuri_core.family_store import MEMORY_CATEGORY_LABELS
    labels = set(MEMORY_CATEGORY_LABELS.values())
    for c in CONVERSATIONS_WITH_MEMORY:
        for line in c["memory"].splitlines():
            assert "：" in line, c["id"]
            assert line.split("：", 1)[0] in labels, (c["id"], line)


CONVERSATIONS_WITH_MEMORY = [c for c in coherence.CONVERSATIONS if c.get("memory")]


def test_every_conversation_carries_a_memory_block():
    """Without one the `memory` arm is identical to `window`, and the eval would
    report that memory changes nothing — which would be an artefact."""
    assert len(CONVERSATIONS_WITH_MEMORY) == len(coherence.CONVERSATIONS)


@pytest.mark.parametrize("text,expected", [
    ("寶寶四個月大，可以先觀察", True),
    ("兩歲的孩子通常已經會說短句", False),
    ("等他上幼兒園就好了", False),
])
def test_the_age_drift_pattern_catches_what_it_should(text, expected):
    forbid = next(t["forbid"] for c in coherence.CONVERSATIONS
                  for t in c["turns"] if t.get("probe") == "改口")
    assert (re.search(forbid, text) is None) is expected


def test_drift_splits_front_from_back():
    turns = [{"chars": 100, "list_items": 0, "bold": 0}] * 2 + \
            [{"chars": 400, "list_items": 4, "bold": 2}] * 2
    d = coherence.drift(turns)
    assert d["chars"] == (100.0, 400.0)
    assert d["list_items"] == (0.0, 4.0)
