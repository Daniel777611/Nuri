"""Made-up families shaped like real accounts, for comparing daily search words.

The memory rows copy the shapes the extractor writes in production (several
keys for one fact, facts about the parent next to facts about the child); no
row is a real family's. Used by tests/test_family_queries.py and by
scripts/compare_daily_queries.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


def born_months_ago(months: int, today: date | None = None) -> str:
    """A birthday that makes the child exactly ``months`` old today."""
    today = today or date.today()
    year, month = divmod(today.year * 12 + today.month - 1 - months, 12)
    return date(year, month + 1, min(today.day, 28)).isoformat()


@dataclass
class Family:
    name: str
    months: int
    profile: dict
    memories: list = field(default_factory=list)
    standing: list = field(default_factory=list)
    topics: list = field(default_factory=list)          # chat_turn_logs.route_topic, newest first
    user_texts: list = field(default_factory=list)      # recent messages, oldest first
    personal: bool = True                               # 外部内容检索 switch
    locale: str = "zh-CN"

    @property
    def children(self) -> list[dict]:
        return [{"nickname": "小测", "birth_date": born_months_ago(self.months)}]


FAMILIES: tuple[Family, ...] = (
    Family(
        "christian_ai_dad", 12,
        {"parent_role": "dad", "top_concerns": ["development"], "hobbies": ["读经", "写代码"]},
        memories=[
            {"category": "fact", "key": "faith", "value": "用户是基督徒，每周去教会"},
            {"category": "fact", "key": "job", "value": "用户在做 AI 产品开发，创业中"},
            {"category": "child_state", "key": "mobility", "value": "小测最近刚会扶站，开始扶着沙发迈步"},
            {"category": "concern", "key": "time", "value": "爸爸担心陪孩子的时间太少"},
        ],
        standing=["用户创业很忙，陪孩子的时间比较少"],
        topics=["基督徒怎么看AI", "AI会不会取代程序员"],
        user_texts=["作为基督徒你怎么看AI", "AI会取代程序员吗"],
    ),
    Family(
        "one_year_old_travel_mom", 12,
        {"parent_role": "mom", "top_concerns": ["unknown"]},
        memories=[
            {"category": "preference", "key": "interest_topics", "value": "用户平时喜欢旅行"},
            {"category": "child_state", "key": "age", "value": "小测现在1岁"},
        ],
        topics=["寒暄"],
        user_texts=["你好"],
    ),
    Family(
        "solids_refusal_10m", 10,
        {"parent_role": "mom", "top_concerns": ["food", "sleep"]},
        memories=[
            {"category": "concern", "key": "副食品挫折", "value": "副食品常常只吃两口就不吃，家长很烦躁"},
            {"category": "concern", "key": "nutrition_worry", "value": "担心吃副食品量少营养不够"},
            {"category": "preference", "key": "feeding_style", "value": "不强迫孩子进食"},
        ],
        standing=["目前不想立刻全戒夜奶，先只给夜奶设边界"],
        topics=["辅食拒食", "反复吐食"],
        user_texts=["宝宝吃两口就把勺子推开", "吐出来还要不要喂"],
    ),
    Family(
        "clingy_21m", 21,
        {"parent_role": "mom", "top_concerns": ["emotion", "sleep"]},
        memories=[
            {"category": "child_state", "key": "separation_anxiety", "value": "最近突然很黏妈妈，一走开就哭"},
            {"category": "concern", "key": "托儿所情绪", "value": "下周要送托儿所，家长很愧疚"},
        ],
        topics=["丢东西发脾气"],
        user_texts=["一不给就把东西扔地上"],
    ),
    Family(
        "no_research_switch_8m", 8,
        {"parent_role": "mom", "top_concerns": ["sleep"]},
        memories=[{"category": "concern", "key": "sleep", "value": "夜醒四五次"}],
        topics=["夜醒"],
        personal=False,
    ),
    Family(
        "wheelchair_14m", 14,
        {"parent_role": "mom", "top_concerns": ["development"]},
        memories=[{"category": "child_state", "key": "diagnosis", "value": "孩子下肢瘫痪，在做康复"}],
        standing=["孩子下肢瘫痪，不能走路"],
        topics=["康复训练"],
    ),
    Family(
        "english_18m_night_waking", 18,
        {"parent_role": "mom", "top_concerns": ["food"]},
        memories=[{"category": "child_state", "key": "sleep", "value": "wakes up 3 times a night lately"}],
        topics=["夜醒"],
        user_texts=["she keeps waking up at night"],
        locale="en",
    ),
)
