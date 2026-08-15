"""A regression net under the emergency detector.

Deliberately not a demand that every case in the sweep pass — 23 of them do not,
and tuning the detector is a product decision about which way to lean. What this
pins is the part that must not get worse: the phrasings it catches today, and
the ordinary worries it correctly leaves alone. A change that trades one of
those away shows up here instead of in production.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.evals import urgent_sweep  # noqa: E402
from backend.nuri_core.dialogue_reply import urgent_task_suppressed  # noqa: E402

#: Everything the detector gets right today, in both directions. Generated once
#: from the sweep and written out, so the list is reviewable rather than a
#: snapshot that silently re-baselines itself.
CAUGHT = (
    "寶寶不呼吸了怎麼辦",
    "孩子吞了纽扣电池",
    "他叫不醒",
    "my baby is not breathing",
)

CORRECTLY_IGNORED = (
    "寶寶今天有點發燒，38度，精神還不錯",
    "他今天摔了一跤，膝蓋擦傷，擦了藥就去玩了",
    "孩子睡覺會打呼，正常嗎",
    "他吃饭很慢，一口饭含很久",
)


@pytest.mark.parametrize("text", CAUGHT)
def test_the_emergencies_it_catches_stay_caught(text):
    assert urgent_task_suppressed(text)


@pytest.mark.parametrize("text", CORRECTLY_IGNORED)
def test_ordinary_worry_does_not_trip_the_gate(text):
    assert not urgent_task_suppressed(text)


def test_the_sweep_still_describes_reality():
    """If someone tunes the detector, this is the test that tells them to re-run
    the sweep and update the numbers quoted in the docs and commit messages."""
    misses, false_alarms = urgent_sweep.sweep()
    assert len(misses) == 23, f"miss count moved to {len(misses)} — re-run the sweep"
    assert len(false_alarms) == 3, f"false alarms moved to {len(false_alarms)}"


def test_every_case_is_annotated():
    for text, want, note in urgent_sweep.CASES:
        assert note, text
        assert isinstance(want, bool)
