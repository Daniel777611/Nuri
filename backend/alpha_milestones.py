"""CDC milestone examples, selected locally by age for Alpha chat."""

import re
import unicodedata
from dataclasses import dataclass

from .feed.daily_video import thumbnail_url, watch_url
from .nuri_core.family_store import age_in_months


_CDC_LIBRARY = "https://www.cdc.gov/act-early/milestones-in-action/"
_CDC_LIBRARY_IMAGE = "https://www.cdc.gov/act-early/media/images/2025/06/30-month-image-1.png"


@dataclass(frozen=True)
class _Example:
    video_id: str
    en: str
    simplified: str
    traditional: str

    def title(self, locale: str) -> str:
        if locale == "zh-TW":
            return self.traditional
        return self.simplified if locale.startswith("zh") else self.en


# Video IDs are the official YouTube embeds on the corresponding CDC pages.
_EXAMPLES = {
    2: ("2-months", (
        _Example("osLAmjKZm6s", "Smiling back", "回应大人的微笑", "回應大人的微笑"),
        _Example("nFVh8cPr9Dk", "Early vocal sounds", "哭声以外的发声", "哭聲以外的發聲"),
    )),
    4: ("4-months", (
        _Example("8wSuua6pKHI", "Responding with sounds", "用声音回应大人", "用聲音回應大人"),
        _Example("dUFpDchxJ1Y", "Smiling to get attention", "用微笑吸引注意", "用微笑吸引注意"),
    )),
    6: ("6-months", (
        _Example("FCcQeYVNVGE", "Taking turns making sounds", "轮流发声互动", "輪流發聲互動"),
        _Example("5tgdkihi3r4", "Rolling from tummy to back", "从俯卧翻到仰卧", "從俯臥翻到仰臥"),
    )),
    9: ("9-months", (
        _Example("2zEEh4hM7dw", "Looking when called by name", "听到名字会转头看", "聽到名字會轉頭看"),
        _Example("blts1HhYk6s", "Getting into a sitting position", "自己坐起来", "自己坐起來"),
    )),
    12: ("1-year", (
        _Example("GqV34gup6TQ", "Waving goodbye", "挥手说再见", "揮手說再見"),
        _Example("Bu2W89FzKiw", "Putting a block in a container", "把积木放进容器", "把積木放進容器"),
        _Example("IsWTBFfj3Y0", "Walking while holding furniture", "扶着家具走路", "扶著家具走路"),
    )),
    15: ("15-months", (
        _Example("dWmRzywu97U", "Trying new words", "尝试说出新词", "嘗試說出新詞"),
        _Example("3Qke5GVhqHw", "Stacking blocks", "叠积木", "疊積木"),
    )),
    18: ("18-months", (
        _Example("iKkgvaSbgG4", "Following a one-step instruction", "听懂一个简单指令", "聽懂一個簡單指令"),
        _Example("tx8SPSsz0OU", "Walking independently", "自己走路", "自己走路"),
    )),
    24: ("2-years", (
        _Example("pdsFkcXTDYs", "Putting two words together", "把两个词连起来说", "把兩個詞連起來說"),
        _Example("1wkCI61aomg", "Running", "跑起来", "跑起來"),
    )),
    30: ("30-months", (
        _Example("hVUjgMbakKs", "Playing near and with other children", "和其他孩子一起玩", "和其他孩子一起玩"),
        _Example("NVppuNRxftc", "Following two-step instructions", "听懂两步指令", "聽懂兩步指令"),
    )),
    36: ("3-years", (
        _Example("X3O7LI3NKq4", "Joining other children at play", "加入其他孩子的游戏", "加入其他孩子的遊戲"),
        _Example("yryiHkVtFmY", "Having a back-and-forth conversation", "一来一回地对话", "一來一回地對話"),
    )),
    48: ("4-years", (
        _Example("sLTgWGGBAqo", "Pretending during play", "在游戏里扮演角色", "在遊戲裡扮演角色"),
        _Example("3J8tGSlybC4", "Speaking in longer sentences", "说比较完整的句子", "說比較完整的句子"),
    )),
    60: ("5-years", (
        _Example("d1msWmNsrfE", "Telling a short story", "讲一个简短的故事", "講一個簡短的故事"),
        _Example("O0vJb3Z9DaM", "Counting to ten", "数到十", "數到十"),
    )),
}
_OVERVIEW = _Example("T7bCsIIpC7M", "Milestones Matter for Families", "家长怎样观察发展里程碑", "家長怎樣觀察發展里程碑")

_AGE_IN_MONTHS = re.compile(r"(?<!\d)(\d{1,3})\s*(?:[-– ]?months?(?![a-z])|[个個]月|月[龄齡大])", re.I)
_AGE_IN_YEARS = re.compile(
    r"(?<!\d)(\d{1,2})\s*(?:[-– ]?years?(?![a-z])|[岁歲](?:\s*(\d{1,2})\s*[个個]?月)?)", re.I,
)


def _stated_age(text: str) -> int | None:
    text = unicodedata.normalize("NFKC", text)
    years = list(_AGE_IN_YEARS.finditer(text))
    # Exclude the month part already read as part of a combined age.
    months = [match for match in _AGE_IN_MONTHS.finditer(text)
              if not any(year.start() <= match.start() < year.end() for year in years)]
    ages = {12 * int(match[1]) + int(match[2] or 0) for match in years}
    ages.update(int(match[1]) for match in months)
    return next(iter(ages)) if len(ages) == 1 else None


def child_age(text: str, children: list, recent_requests: list[str]) -> int | None:
    """Resolve a specifically requested age or an unambiguous saved child."""
    if (specified := _stated_age(text)) is not None:
        return specified
    born = [(str(row.get("nickname") or "").strip(), age_in_months(row.get("birth_date")))
            for row in children if isinstance(row, dict)]
    for message in (text, *recent_requests):
        mentioned = [
            age for name, age in born if len(name) >= 2
            and re.search(rf"(?<![a-z0-9]){re.escape(name)}(?![a-z0-9])", message, re.I)
        ]
        if mentioned:
            return mentioned[0] if len(mentioned) == 1 else None
    ages = {age for _, age in born if age is not None}
    if len(ages) == 1:
        return next(iter(ages))
    if not ages:
        for message in recent_requests:
            if (specified := _stated_age(message)) is not None:
                return specified
    return None


def _age_title(months: int, locale: str) -> str:
    if locale.startswith("zh"):
        return f"{months} 月齡" if locale == "zh-TW" else f"{months} 月龄"
    return f"{months}-month"


def _age_group(months: int | None) -> tuple[int | None, int | None]:
    if months is None:
        return None, None
    group = max((age for age in _EXAMPLES if age <= months), default=2)
    upcoming = next((age for age in _EXAMPLES if group < age and 0 < age - months <= 2), None)
    return group, upcoming


def reviewed_cards(months: int | None, locale: str, kinds: tuple[str, ...],
                   *, include_videos: bool = True) -> list[dict[str, str]]:
    # The CDC photo and video series ends at 5 years. Leave other ages to
    # the ordinary provider instead of sending a preschool clip by default.
    if months is not None and months >= 72:
        return []
    group, upcoming = _age_group(months)
    source = f"{_CDC_LIBRARY}{_EXAMPLES[group][0]}.html" if group is not None else _CDC_LIBRARY
    examples = _EXAMPLES[group][1] if group is not None else (_OVERVIEW,)
    title = ("CDC 發展里程碑照片與影片" if locale == "zh-TW" else "CDC 发展里程碑照片和视频"
             if locale.startswith("zh") else "CDC milestone photos and videos")
    if group is not None:
        title = f"{_age_title(group, locale)} · {title}"
    cover = thumbnail_url(examples[0].video_id) if group is not None else _CDC_LIBRARY_IMAGE
    items = []
    if include_videos and "video" in kinds:
        for stage in (group, upcoming) if upcoming is not None else (group,):
            video_rows = _EXAMPLES[stage][1] if stage is not None else (_OVERVIEW,)
            clip_limit = 2 if len(kinds) > 1 or stage == upcoming else 3
            stage_source = f"{_CDC_LIBRARY}{_EXAMPLES[stage][0]}.html" if stage is not None else _CDC_LIBRARY
            for video in video_rows[:clip_limit]:
                clip_title = video.title(locale)
                if stage is not None:
                    clip_title = f"{_age_title(stage, locale)} · {clip_title}"
                items.append({
                    "type": "video", "video_id": video.video_id, "title": clip_title,
                    "url": watch_url(video.video_id), "thumbnail_url": thumbnail_url(video.video_id),
                    "source_url": stage_source,
                })
    if "article" in kinds:
        items.append({"type": "article", "title": title, "url": source, "thumbnail_url": cover})
    if "image" in kinds:
        items.append({"type": "image", "title": title, "url": cover, "thumbnail_url": cover, "source_url": source})
    return items
