"""Print the daily post search words for the fixture families, before and after.

    python -m backend.scripts.compare_daily_queries [YYYY-MM-DD]

"Before" is DAILY_QUERY_PLANNER=legacy with the template conversation plan
(the router topic pasted into "{age} 宝宝 {topic} 宝妈") followed by the
profile plans; "after" is feed/family_queries.py. Offline: no database, no
model, no search.
"""

from __future__ import annotations

import sys
from datetime import date

from backend.feed import daily_post as dp
from backend.feed.query_fixtures import FAMILIES


def legacy(f, day: date) -> list[dp.Plan]:
    plans = []
    if f.personal:
        plan = dp.template_plan(f.topics, f.user_texts, f.children, f.locale)
        if plan:
            plans.append(plan)
    return plans + dp.profile_plans(f.children, list(f.profile.get("top_concerns") or []), day, f.locale)


def family(f, day: date) -> list[dp.Plan]:
    return dp.family_plans(
        f.children, f.profile, day, f.locale, memories=f.memories, topics=f.topics,
        user_texts=f.user_texts, standing=f.standing, personal=f.personal,
    )


def main(day: date) -> None:
    for f in FAMILIES:
        print(f"\n## {f.name} ({f.months} 个月, {f.locale}{'' if f.personal else ', 外部检索关'})")
        for title, plans in (("before", legacy(f, day)), ("after", family(f, day))):
            print(f"  {title}:")
            for p in plans:
                why = f"  [{p.why}]" if p.why else ""
                print(f"    - {p.query_zh or '—'} | {p.query_en}  ({p.basis}){why}")


if __name__ == "__main__":
    main(date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else date.today())
