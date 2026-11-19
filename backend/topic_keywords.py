"""What a piece of text is about, as the eight onboarding concerns.

Plain keyword rules: the same answer every time, explainable, and free. Shared
by the community question matching (which parents get a question) and the
daily cards (which search words a chat topic becomes), so one table decides
what "about sleep" means everywhere.
"""

from __future__ import annotations

from typing import Optional

#: users.top_concerns code → words that mark text as being about it.
#: Chinese entries match as substrings; English ones in lower case.
TOPIC_KEYWORDS: dict[str, tuple[str, ...]] = {
    "sleep": ("睡", "觉", "夜醒", "哄睡", "午休", "作息", "sleep", "nap", "bedtime"),
    "food": ("吃", "饭", "奶", "辅食", "挑食", "喂", "断奶", "零食", "eat", "food", "feed", "milk"),
    "emotion": ("哭", "情绪", "脾气", "发火", "安抚", "焦虑", "害怕", "分离", "tantrum", "cry", "emotion", "anxious"),
    "development": ("说话", "走路", "发育", "语言", "爬", "大运动", "认知", "迟", "speech", "walk", "develop"),
    "health": ("发烧", "生病", "咳", "感冒", "疫苗", "过敏", "湿疹", "医院", "便秘", "长牙", "fever", "sick", "vaccine", "allergy", "teeth"),
    "childcare": ("托育", "幼儿园", "托班", "保姆", "阿姨", "上学", "入园", "入托", "分离焦虑", "daycare", "nursery", "preschool"),
    "parenting": ("管教", "规矩", "教育", "习惯", "屏幕", "手机", "电视", "奖励", "惩罚", "discipline", "screen", "rules"),
    "family": ("老人", "爷爷", "奶奶", "外婆", "老公", "伴侣", "二胎", "兄弟", "姐妹", "家人", "partner", "sibling", "grandparent"),
}


def topics_in(text: str) -> set[str]:
    """Every concern the text touches."""
    lowered = (text or "").lower()
    return {topic for topic, words in TOPIC_KEYWORDS.items() if any(word in lowered for word in words)}


def main_topic(text: str) -> Optional[str]:
    """The one concern the text is most about, or None.

    Each matching keyword counts by its length, so the specific phrase wins
    over the loose one: 入园分离焦虑 is childcare (入园 + 分离焦虑), not emotion
    (分离 + 焦虑). Ties go to the order of TOPIC_KEYWORDS."""
    lowered = (text or "").lower()
    best, best_score = None, 0
    for topic, words in TOPIC_KEYWORDS.items():
        score = sum(len(word) for word in words if word in lowered)
        if score > best_score:
            best, best_score = topic, score
    return best
