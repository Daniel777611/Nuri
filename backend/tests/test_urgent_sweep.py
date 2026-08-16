"""A regression net under the emergency detector.

The detector is tuned toward catching: in these turns the product's job is to
get the family to a clinician, not to answer well, so a false alarm costs an
unnecessary 「先打 119」 and a miss costs the gate that exists to produce it.
Three of the sweep's eight negative cases still trip — a hypothetical, a
resolved incident, and a news story — and they stay that way on purpose. Every
rule that would suppress them is a rule that can be talked out of firing on a
real one.

Validated against traffic as well as fixtures: 0 of 256 real parent messages in
`chat_messages` trip it.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.evals import urgent_sweep  # noqa: E402
from backend.nuri_core.dialogue_reply import urgent_task_suppressed  # noqa: E402

#: One per presentation the sweep covers, so a regression names the thing it
#: broke rather than a row number. Described, not named — naming was never the
#: weak axis.
CAUGHT = (
    ("寶寶不呼吸了怎麼辦", "not breathing"),
    ("孩子吞了纽扣电池", "button battery"),
    ("他叫不醒", "unrousable"),
    ("寶寶從床上摔下來現在一直吐", "head injury, vomiting"),
    ("孩子从沙发上摔下来，头着地，现在很想睡", "head injury across a comma"),
    ("孩子发烧40度还在抽", "febrile seizure"),
    ("三个月宝宝烧到39.5，一直哭不停", "fever by age"),
    ("寶寶臉色發白，手腳冰冷，叫他沒什麼反應", "shock across two commas"),
    ("孩子把奶奶的降压药吃了几颗", "someone else's prescription"),
    ("宝宝被花生呛到咳不出来，脸都红了", "choking"),
    ("寶寶被熱水燙到，整片起水泡", "burn"),
    ("宝宝拉的便便里有血", "GI bleeding"),
    ("两个月的宝宝一整天没有尿", "dehydration"),
    ("寶寶身上突然出現很多紫色的點，壓下去不會退", "non-blanching rash"),
    ("孩子突然全身软掉，眼睛往上翻", "seizure"),
    ("he fell off the changing table and hit his head", "head injury, English"),
    ("my toddler swallowed a magnet", "ingestion, English"),
    ("baby has a fever of 104 and is floppy", "fever, English"),
)

#: Ordinary parenting, including the phrasings nearest the patterns. 「不肯吃藥」
#: is the one that would have made the detector unusable: it is among the most
#: common messages there is, which is why medicine needs a quantity or somebody
#: else's prescription before it counts.
CORRECTLY_IGNORED = (
    "寶寶今天有點發燒，38度，精神還不錯",
    "他今天摔了一跤，膝蓋擦傷，擦了藥就去玩了",
    "孩子睡覺會打呼，正常嗎",
    "他吃饭很慢，一口饭含很久",
    "宝宝不肯吃药，每次都吐出来怎么办",
    "他最近很爱吃饭，一餐可以吃两碗",
    "孩子摔倒的时候我该怎么处理擦伤",
    "寶寶頭很會流汗，需要注意嗎",
)


@pytest.mark.parametrize("text,presentation", CAUGHT)
def test_the_emergencies_it_catches_stay_caught(text, presentation):
    assert urgent_task_suppressed(text), presentation


@pytest.mark.parametrize("text", CORRECTLY_IGNORED)
def test_ordinary_worry_does_not_trip_the_gate(text):
    assert not urgent_task_suppressed(text)


def test_the_sweep_still_describes_reality():
    """If someone retunes the detector, this is what tells them to re-run the
    sweep and update the numbers quoted in the docs and commit messages."""
    misses, false_alarms = urgent_sweep.sweep()
    assert misses == [], f"a presentation regressed: {misses}"
    assert len(false_alarms) == 3, (
        f"false alarms moved to {len(false_alarms)} — if that is deliberate, "
        "update this and the module docstring together"
    )


def test_every_case_is_annotated():
    for text, want, note in urgent_sweep.CASES:
        assert note, text
        assert isinstance(want, bool)
