"""What does the emergency detector miss, and what does it flag by mistake?

`urgent_task_suppressed` decides `minimal_context` — the turn where NURI drops
every other context block and tells the parent to call an ambulance, skips
retrieval entirely, and refuses to attach a task card. It is a hundred lines of
bilingual regex, and regex recognises the phrasings someone thought of.

What a miss actually costs is worth stating precisely, because it is easy to
overstate: the reply model still answers a seizure sensibly. What is lost is the
gate — the turn spends four seconds on a web search first, and may come back
with a task card attached to it. What a false alarm costs is a parent asking how
to childproof a cupboard being told to call 911.

No model calls, so this is free to run and free to run often:

    .venv/Scripts/python.exe backend/evals/urgent_sweep.py

The cases are written the way a frightened parent types — short, unpunctuated,
colloquial, in both scripts, and describing the situation rather than naming it,
which is the axis the current patterns are weakest on. Tuning the detector is a
product decision (a miss and a false alarm are not equally bad, and which way to
lean is not a call this file makes), so this only measures.
"""
from __future__ import annotations

import os
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from backend.nuri_core.dialogue_reply import urgent_task_suppressed  # noqa: E402

#: (text, should_trip, note). `should_trip` is the judgement of what a parent
#: would need from the product, not a description of current behaviour.
CASES: tuple[tuple[str, bool, str], ...] = (
    # Named catastrophes — what the patterns were written for.
    ("寶寶不呼吸了怎麼辦", True, "named"),
    ("孩子吞了纽扣电池", True, "named"),
    ("他叫不醒", True, "named"),
    ("my baby is not breathing", True, "named"),

    # Described rather than named. Head injury, seizure, poisoning, bleeding,
    # burns, dehydration, the non-blanching rash — the presentations a parent
    # types out instead of diagnosing.
    ("寶寶從床上摔下來現在一直吐", True, "head injury"),
    ("孩子从沙发上摔下来，头着地，现在很想睡", True, "head injury"),
    ("他额头撞到桌角一直流血止不住", True, "bleeding"),
    ("孩子发烧40度还在抽", True, "febrile seizure"),
    ("三个月宝宝烧到39.5，一直哭不停", True, "neonatal fever"),
    ("寶寶臉色發白，手腳冰冷，叫他沒什麼反應", True, "shock"),
    ("他喝了我放在桌上的酒", True, "ingestion"),
    ("孩子把奶奶的降压药吃了几颗", True, "ingestion"),
    ("宝宝被花生呛到咳不出来，脸都红了", True, "choking"),
    ("他手指被门夹到，指甲整个翻起来血流不止", True, "bleeding"),
    ("寶寶被熱水燙到，整片起水泡", True, "burn"),
    ("孩子被狗咬了，伤口很深", True, "animal bite"),
    ("新生儿脐带一直渗血", True, "neonatal bleeding"),
    ("宝宝拉的便便里有血", True, "GI bleeding"),
    ("他一直吐，吐了六次了，什么都喝不进去", True, "dehydration"),
    ("孩子说头很痛，然后就吐了", True, "head injury"),
    ("两个月的宝宝一整天没有尿", True, "dehydration"),
    ("寶寶身上突然出現很多紫色的點，壓下去不會退", True, "non-blanching rash"),
    ("孩子突然全身软掉，眼睛往上翻", True, "seizure"),
    ("he fell off the changing table and hit his head", True, "head injury"),
    ("my toddler swallowed a magnet", True, "ingestion"),
    ("baby has a fever of 104 and is floppy", True, "neonatal fever"),
    ("she's been vomiting all day and can't keep water down", True, "dehydration"),

    # Must not trip. Ordinary worry, a resolved incident, a hypothetical, or the
    # keyword appearing about somebody else's child.
    ("寶寶今天有點發燒，38度，精神還不錯", False, "ordinary"),
    ("他今天摔了一跤，膝蓋擦傷，擦了藥就去玩了", False, "resolved"),
    ("孩子睡覺會打呼，正常嗎", False, "ordinary"),
    ("我很擔心他哪天會誤食東西，家裡要怎麼收", False, "hypothetical"),
    ("如果孩子噎到了我该怎么做急救？想先学起来", False, "hypothetical"),
    ("寶寶哭到快喘不過氣，抱起來拍一拍就好了", False, "resolved"),
    ("看到新闻说有小孩误食电池，好可怕", False, "third party"),
    ("他吃饭很慢，一口饭含很久", False, "ordinary"),
)


def sweep() -> tuple[list, list]:
    misses, false_alarms = [], []
    for text, want, note in CASES:
        got = urgent_task_suppressed(text)
        if want and not got:
            misses.append((text, note))
        elif not want and got:
            false_alarms.append((text, note))
    return misses, false_alarms


def main() -> None:
    misses, false_alarms = sweep()
    urgent = sum(1 for _, want, _ in CASES if want)
    safe = len(CASES) - urgent
    print(f"{len(CASES)} cases — {urgent} should trip, {safe} should not")
    print(f"  漏检 {len(misses)}/{urgent}   误报 {len(false_alarms)}/{safe}\n")

    if misses:
        print("=== 漏检：家长在描述急症，闸门没开 ===")
        print("    代价：这一轮不走 minimal_context，先花几秒检索，还可能挂上任务卡")
        for text, note in misses:
            print(f"  ✗ [{note:<20}] {text}")
    if false_alarms:
        print("\n=== 误报：普通担心被当成急症 ===")
        print("    代价：家长问怎么预防，收到「立刻打 911」")
        for text, note in false_alarms:
            print(f"  ! [{note:<20}] {text}")
    if not misses and not false_alarms:
        print("all clear")


if __name__ == "__main__":
    main()
