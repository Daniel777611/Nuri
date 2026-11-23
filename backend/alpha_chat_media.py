"""Bounded, provider-backed resources for an explicit Alpha chat request."""

from __future__ import annotations

import asyncio
import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from .content_research import redact_conversation_text
from .feed.daily_video import thumbnail_url, video_id_of, watch_url
from .nuri_core.family_store import redact_child_profile_text
from .websearch import SearchRequest, SearchResult, get_provider

_REQUEST = re.compile(
    r"\b(?:find|share|send|show|recommend|suggest|give|link|need|where|any|looking for)\b"
    r"|有没有|有沒有|可以|能不能|给我|給我|推荐|推薦|发我|發我|分享|链接|連結|鏈接|看看|"
    r"(?:^|[，。])找|帮我找|幫我找|想看|[?？]",
    re.I,
)
_MEDIA = {
    "video": re.compile(r"\b(?:youtube|videos?|clips?)\b|视频|影片|視訊|錄影|录像", re.I | re.ASCII),
    "article": re.compile(r"\b(?:articles?|reading material|sources?|webpages?)\b|文章|资料|資料|网页|網頁|来源|來源", re.I),
    "image": re.compile(r"\b(?:images?|pictures?|photos?|diagrams?|illustrations?)\b|图片|圖片|照片|示意图|示意圖|图解|圖解|插图|插圖", re.I),
}
_CREDENTIAL = re.compile(r"(?:token|secret|password|authorization|credential|api[_-]?key|session|signature|^sig$|^jwt$)", re.I)
_SAFE_PATH = re.compile(r"\.(?:jpe?g|png|webp|avif|gif)$", re.I)
_DECORATION = re.compile(r"(?:avatar|favicon|\blogo\b|\bicon\b|profile picture)", re.I)
_PRIVATE_TEXT = re.compile(
    r"\[(?:邮箱|电话|编号|链接|名字|地址|address|name|school)\]|https?://|"
    r"\b(?:my (?:address|phone|email|name)|(?:diagnosed|diagnosis) (?:with|is)|medical record|password)\b|"
    r"家庭地址|我的(?:姓名|地址|電話|电话)|确诊|確診", re.I,
)
_SHORT_REFERENCE = re.compile(
    r"^(?:(?:find|share|send|show|recommend|suggest|give|me|a|some|any|please|can|could|you|on|"
    r"tutorials?|the|this|that|these|those|about|it|to|of|look|for|with|help|do|have|is|there|links?|examples?|more)\b|"
    r"有沒有|有没有|有|給我|给我|能不能|可以|有什麼|有什么|推薦|推荐|找|看看|分享|教學|教学|教程|"
    r"這個|这个|這方面|这方面|那些|剛才|刚才|上面|一個|一个|幾個|几个|一些|一下|發我|发我|發|发|链接|連結|鏈接|的|啊|呀|嗎|吗|[\W_])+?$",
    re.I,
)
_ARTICLE_DOMAINS = (
    "healthychildren.org", "kidshealth.org", "nhs.uk", "cdc.gov", "nih.gov", "who.int",
    "unicef.org", "zerotothree.org", "childmind.org", "raisingchildren.net.au", "parenting.com.tw",
)
_MEDICAL_TEXT = re.compile(
    r"\b(?:emergency|medical|diagnos\w*|medication|dosage|overdose|seizure|fever|choking|bleeding)\b"
    r"|急救|急诊|急診|窒息|中毒|抽搐|剂量|劑量|服药|服藥|发烧|發燒|出血", re.I,
)
_MAX_ITEMS = 6


@dataclass(frozen=True)
class _VideoTopic:
    english: str
    simplified: str
    traditional: str
    terms: re.Pattern[str]

    def query(self, locale: str) -> str:
        if locale == "zh-TW":
            return self.traditional
        return self.simplified if locale.startswith("zh") else self.english


# Keep outbound video requests to known public educational subjects. The topic
# detector can read the current message locally without sending it to YouTube
# search. English and both Chinese locales use the same relevance criteria.
_SPEECH_VIDEO_TOPIC = _VideoTopic(
    "child speech and language development toddler first words parent tips",
    "幼儿语言发育 宝宝学说话 亲子互动",
    "幼兒語言發展 寶寶學說話 親子互動",
    re.compile(
        r"\blanguage (?:development|milestones?|learning|stimulation|skills)\b"
        r"|\bspeech (?:and language|language|development|milestones?|stimulation|skills|therapy)\b"
        r"|\bfirst words?\b|\b(?:help|teach|encourage)(?:ing)?\b.{0,45}\b(?:talk|speak|talking|speaking)\b"
        r"|\b(?:learn|learning|start|starting)(?: to)? (?:talk|speak|talking|speaking)\b"
        r"|(?:[语語][言音]|[说說][话話]|[开開]口|口[语語])(?:[发發][育展]|[启啟][蒙发發]|培[养養]|引[导導]|[训訓]練|里程碑|能力|[练練]習)"
        r"|[语語]言(?:表[达達]|能力|刺激|理解)|[学學][说說講讲][话話]|教.{0,12}[说說講讲][话話]"
        r"|[说說][话話](?:技巧|[训练訓練])|[开開]口[说說][话話]|[说說]出第一[个個][词詞]|幼[儿兒][语語]言|[语語]言[学习學習]", re.I,
    ),
)
_VIDEO_TOPICS = (
    _SPEECH_VIDEO_TOPIC,
    _VideoTopic(
        "baby chicken puree introducing solids preparation for parents",
        "婴儿鸡肉泥 辅食 制作方法",
        "嬰兒雞肉泥 副食品 製作方法",
        re.compile(r"\bchicken\b.{0,18}\bpur[ée]e\b|[鸡雞]肉泥|[鸡雞]蓉", re.I),
    ),
    _VideoTopic(
        "starting solids for babies infant complementary feeding parent guide",
        "宝宝辅食添加 婴儿第一口辅食 家长教程",
        "寶寶副食品入門 嬰兒開始吃副食品 家長教學",
        re.compile(
            r"\b(?:start(?:ing)?|introduc(?:e|ing)|first) (?:solid foods?|solids)\b"
            r"|\b(?:baby[- ]led weaning|complementary feeding|infant feeding)\b"
            r"|(?:[辅輔]食|副食品)(?:添加|入[门門]|起步|製作|制作)|(?:[辅輔]食|副食品)"
            r"|第一口(?:[辅輔]食|副食品)", re.I,
        ),
    ),
    _VideoTopic(
        "baby toddler sleep bedtime routine parent guide",
        "婴幼儿睡眠 宝宝入睡 睡前流程",
        "嬰幼兒睡眠 寶寶入睡 睡前流程",
        re.compile(
            r"\b(?:sleep (?:regressions?|training|routines?|tips|schedules?)|bedtime routines?|"
            r"(?:baby|infant|toddler|children'?s) sleep|sleeping through the night)\b"
            r"|睡眠倒退|睡前(?:[仪儀]式|流程|[习習][惯慣])|哄睡|夜醒|[婴嬰]幼[儿兒]睡眠|(?:宝宝|寶寶)(?:睡眠|入睡)", re.I,
        ),
    ),
    _VideoTopic(
        "toddler tantrums emotion regulation calm parent strategies",
        "幼儿发脾气 情绪调节 家长应对",
        "幼兒發脾氣 情緒調節 家長應對",
        re.compile(
            r"\b(?:tantrums?|child emotional regulation|emotion regulation|managing big feelings|emotional outbursts?)\b"
            r"|[发發]脾[气氣]|情[绪緒](?:崩[溃潰]|[调調][节節]|管理)|哭[闹鬧]|孩子生[气氣]", re.I,
        ),
    ),
    _VideoTopic(
        "toddler potty training toilet learning parent guide",
        "幼儿如厕训练 宝宝戒尿布 家长指南",
        "幼兒如廁訓練 寶寶戒尿布 家長指南",
        re.compile(
            r"\b(?:potty training|toilet training|toilet learning)\b|如[厕廁]|戒尿布|便盆[训訓]練|上[厕廁]所[训訓]練", re.I,
        ),
    ),
    _VideoTopic(
        "picky eating toddlers children mealtime parent guide",
        "宝宝挑食 幼儿餐桌习惯 家长应对",
        "寶寶挑食 幼兒餐桌習慣 家長應對",
        re.compile(r"\b(?:picky eat(?:ers?|ing)|fussy eat(?:ers?|ing)|food refusal)\b|挑食|[厌厭]食|不[爱愛]吃[饭飯]", re.I),
    ),
    _VideoTopic(
        "child separation anxiety preschool transitions parent guide",
        "幼儿分离焦虑 入园适应 家长指南",
        "幼兒分離焦慮 入園適應 家長指南",
        re.compile(r"\b(?:separation anxiety|preschool drop[- ]off)\b|分[离離]焦[虑慮]|入[园園][适適][应應]", re.I),
    ),
    _VideoTopic(
        "baby tummy time crawling gross motor development parent guide",
        "宝宝趴卧 爬行 大运动发展 家长指南",
        "寶寶趴臥 爬行 大肌肉動作發展 家長指南",
        re.compile(r"\b(?:tummy time|baby crawl(?:ing|s)?|gross motor development)\b|趴[卧臥]|[婴嬰][儿兒]爬行|宝宝爬行|寶寶爬行|大[运運]动[发發]展|大肌肉[动動]作", re.I),
    ),
    _VideoTopic(
        "change a diaper baby diaper changing parent demonstration",
        "婴儿更换尿布 宝宝换纸尿裤 示范",
        "嬰兒更換尿布 寶寶換尿片 示範",
        re.compile(r"\b(?:diaper chang(?:e|es|ing)|chang(?:e|ing) (?:a |the )?(?:diapers?|napp(?:y|ies)))\b|(?:[换換]|更[换換])(?:[纸紙])?尿(?:布|片|[裤褲])|尿布(?:替[换換]|更[换換])", re.I),
    ),
    _VideoTopic(
        "baby carrier fitting babywearing safe positioning parent demonstration",
        "婴儿背带 穿戴 背娃 示范",
        "嬰兒背帶 穿戴 背巾 示範",
        re.compile(r"\b(?:baby carriers?|babywearing|baby wraps?|infant carriers?)\b|(?:[婴嬰][儿兒]|寶寶|宝宝)背[带帶]|背[带帶][穿用]戴|[婴嬰][儿兒]背巾|背娃", re.I),
    ),
    _VideoTopic(
        "how to bathe a newborn baby bath parent demonstration",
        "新生儿洗澡 婴儿沐浴 教程",
        "新生兒洗澡 嬰兒沐浴 教學",
        re.compile(r"\b(?:baby bath(?:ing)?|newborn bath(?:ing)?|bathe (?:a |an |your )?(?:newborn|baby|infant))\b|(?:[婴嬰][儿兒]|新生[儿兒]|寶寶|宝宝)(?:洗澡|沐浴)|[给給](?:宝宝|寶寶|[婴嬰][儿兒])洗澡", re.I),
    ),
    _VideoTopic(
        "child car seat installation harness fitting parent demonstration",
        "儿童汽车安全座椅 安装 安全带",
        "兒童汽車安全座椅 安裝 安全帶",
        re.compile(r"\b(?:car seats?|booster seats?|rear[- ]facing|child passenger safety)\b|(?:(?:儿童|兒童|汽[车車])(?:汽[车車])?)?安全座椅|后向座椅|後向座椅", re.I),
    ),
    _VideoTopic(
        "breastfeeding latch positions baby feeding parent guide",
        "母乳喂养 哺乳姿势 含乳示范",
        "母乳哺餵 哺乳姿勢 含乳示範",
        re.compile(r"\b(?:breastfeeding|breast feeding|breastfeed|nursing positions?|latching on)\b|母乳(?:喂[养養]|哺[餵喂])|哺乳|含乳", re.I),
    ),
    _VideoTopic(
        "baby bottle feeding paced feeding infant formula preparation parent guide",
        "婴儿奶瓶喂养 节奏喂奶 冲调配方奶",
        "嬰兒奶瓶餵養 節奏餵奶 沖泡配方奶",
        re.compile(r"\b(?:bottle[- ]feeding|paced feeding|formula preparation|prepar(?:e|ing) infant formula)\b|奶瓶(?:喂[养養]|[餵喂]奶)|[冲沖](?:泡|[调調])(?:配方)?奶|[节節]奏[喂餵]奶", re.I),
    ),
)
_CHILD_VIDEO = re.compile(
    r"\b(?:bab(?:y|ies)|toddler(?:s)?|child(?:ren|hood)?|infant(?:s)?|newborn(?:s)?|kids?|preschool(?:ers?)?|parent(?:ing|s)?"
    r"|(?:one|two|three|1|2|3)[ -]year[ -]olds?)\b|寶寶|宝宝|[嬰婴][兒儿]|幼[兒儿]|孩[子童]|小孩|小朋友|親子|亲子|育[兒儿]|月[龄齡]|早教",
    re.I,
)
_OFF_TOPIC_VIDEO = re.compile(
    r"\b(?:large language models?|llms?|language models?|chatgpt|openai|deepseek|generative ai|ai models?|"
    r"machine learning|prompt engineering|stock trading|short straddle|straddles?|options trading|crypto(?:currency)?|"
    r"forex|financial markets?)\b"
    r"|大(?:[语語]言)?模型|人工智能|人工智慧|生成式.{0,3}AI|模型(?:[训訓]練|训练)|股[市票]|期[权權]|加密[货貨][币幣]|交易策略",
    re.I,
)


_EXPLICIT_ZH_VIDEO = re.compile(
    r"\b(?:only|just) (?:in )?(?:chinese|mandarin)\b|\b(?:chinese|mandarin)[ -]only\b"
    r"|\b(?:in chinese|mandarin chinese|chinese[- ]language|(?:chinese|mandarin) videos?)\b|中文(?:的|語音|语音|配音|解說|解说|[视視]頻|视频|影片)"
    r"|(?<!不)(?:只[要給给]|要|找|看)[\s]*(?:中文|普通[话話]|[国國][语語]|[华華][语語])|不要英文",
    re.I,
)
_EXPLICIT_EN_VIDEO = re.compile(
    r"\b(?:in english|english[ -]only|english-language)\b|(?<!不)(?:要|找|只看)英文|不要中文|英文(?:的视频|的影片|視頻|视频|影片)",
    re.I,
)
_HAN_TEXT = re.compile(r"[㐀-鿿]")
# Each ID was checked against YouTube's public metadata and the named
# institution's public educational video page. No treatment videos are here.
_SPEECH_VIDEO_RESOURCES = {
    "zh": (
        ("如何協助孩子語言發展", "K2tgEp7iTdU",
         "https://www.hch.gov.tw/?aid=627&iid=241&page_name=detail&pid=0"),
    ),
    "en": (
        ("5 Steps for Brain-Building Serve and Return · Harvard", "KNrnZag17Ek",
         "https://developingchild.harvard.edu/resources/videos/how-to-5-steps-for-brain-building-serve-and-return/"),
        ("Through the Eyes of a Child (ages 1–2) · Communication Trust", "-zA3zK0g5ic",
         "https://www.cpft.nhs.uk/speech-and-language-therapy-late-talkers/"),
    ),
}


def _speech_video_fallback(topic: _VideoTopic, locale: str) -> list[dict[str, str]]:
    if topic is not _SPEECH_VIDEO_TOPIC:
        return []
    rows = _SPEECH_VIDEO_RESOURCES["zh" if locale.startswith("zh") else "en"]
    return [
        {"type": "video", "title": title, "source_url": source, **public_video_fields(watch_url(video_id))}
        for title, video_id, source in rows
    ]


def _video_subject(value: str) -> str:
    return unicodedata.normalize("NFKC", value)


def _video_topic(text: str, route, children: list, allow_history: bool) -> _VideoTopic | None:
    if _PRIVATE_TEXT.search(redact_conversation_text(text)):
        return None
    direct = _video_subject(redact_conversation_text(redact_child_profile_text(text, children), 320))
    if _OFF_TOPIC_VIDEO.search(direct):
        return None
    if direct_topic := next((topic for topic in _VIDEO_TOPICS if topic.terms.search(direct)), None):
        return direct_topic
    # Only unambiguously short requests can inherit a prior subject. Confine
    # history use to a recognized router label under the existing user opt-in.
    if not (allow_history and route and route.ok and not _query(text, None, children, "en", False)):
        return None
    for signal in (route.topic, route.search_query, route.search_query_zh):
        safe = _video_subject(redact_conversation_text(redact_child_profile_text(signal, children), 120))
        if _PRIVATE_TEXT.search(safe) or _OFF_TOPIC_VIDEO.search(safe):
            continue
        if match := next((topic for topic in _VIDEO_TOPICS if topic.terms.search(safe)), None):
            return match
    return None


def _video_items(topic: _VideoTopic, rows: list[SearchResult], language: str = "") -> list[dict[str, str]]:
    scored: list[tuple[int, dict[str, str]]] = []
    for row in rows:
        title = _plain_title(row.title).removesuffix(" - YouTube")
        title_evidence = _video_subject(title)
        snippet = _video_subject(row.snippet[:600])
        if (not title or _OFF_TOPIC_VIDEO.search(title_evidence) or _OFF_TOPIC_VIDEO.search(snippet)
                or _MEDICAL_TEXT.search(title_evidence)):
            continue
        if ((language == "zh" and not _HAN_TEXT.search(title_evidence))
                or (language == "en" and _HAN_TEXT.search(title_evidence))):
            continue
        child_in_title = bool(_CHILD_VIDEO.search(title_evidence))
        if not topic.terms.search(title_evidence) or not (child_in_title or _CHILD_VIDEO.search(snippet)):
            continue
        if fields := public_video_fields(row.url):
            scored.append((2 if child_in_title else 1, {"type": "video", "title": title, **fields}))
    # Use the snippet to corroborate the audience, never to turn an unrelated
    # title into a match. Prefer titles that themselves name the child audience.
    unique: dict[str, dict[str, str]] = {}
    for _, item in sorted(scored, key=lambda row: -row[0]):
        unique.setdefault(item["video_id"], item)
    return list(unique.values())


def requested_media(text: str | None) -> tuple[str, ...]:
    value = (text or "").strip()
    if not 3 <= len(value) <= 320 or not _REQUEST.search(value):
        return ()
    return tuple(kind for kind, token in _MEDIA.items() if token.search(value))


def _safe_url(value: object, *, image: bool = False) -> str | None:
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f\\]", value):
        return None
    try:
        url = urlsplit(value)
        host = url.hostname or ""
        if (url.scheme != "https" or url.username or url.password or url.port is not None
                or not re.fullmatch(r"(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,63}", host, re.I)
                or host.endswith((".local", ".localhost", ".internal", ".lan", ".home", ".test", ".example"))
                or any(_CREDENTIAL.search(key) for key, _ in parse_qsl(url.query))):
            return None
        if image and (not _SAFE_PATH.search(url.path) or _DECORATION.search(url.path)):
            return None
        return urlunsplit(("https", host, url.path or "/", url.query, ""))
    except ValueError:
        return None


def public_video_fields(value: object) -> dict[str, str]:
    url = _safe_url(value)
    video_id = video_id_of(url) if url else None
    if not video_id:
        return {}
    return {"url": watch_url(video_id), "video_id": video_id, "thumbnail_url": thumbnail_url(video_id)}


def public_article_url(value: object) -> str | None:
    return _safe_url(value)


def _plain_title(value: str) -> str:
    return re.sub(r"[\s\x00-\x1f\x7f]+", " ", value).strip()[:160]


def _query(text: str, route, children: list, locale: str, allow_history: bool) -> str:
    if _PRIVATE_TEXT.search(redact_conversation_text(text)):
        return ""
    subject = text
    if allow_history and route and route.ok:
        routed = route.search_query_zh if locale.startswith("zh") else route.search_query
        subject = routed or route.topic or text
    subject = redact_conversation_text(redact_child_profile_text(subject, children), 180)
    if _PRIVATE_TEXT.search(subject):
        return ""
    for regex in _MEDIA.values():
        subject = regex.sub(" ", subject)
    if len(subject.strip()) < 3 or _SHORT_REFERENCE.fullmatch(subject):
        return ""
    return re.sub(r"\s+", " ", subject).strip()


def _images(result: SearchResult) -> list[str]:
    return [
        url for image in result.images[:4]
        if not _DECORATION.search(image.description or "") and (url := _safe_url(image.url, image=True))
    ]


def _result_items(kind: str, rows: list[SearchResult], authority_only: bool) -> list[dict[str, str]]:
    items = []
    for row in rows:
        title = _plain_title(row.title)
        if not title:
            continue
        if (source := _safe_url(row.url)) is None or public_video_fields(source):
            continue
        host = urlsplit(source).hostname or ""
        trusted = any(host == trusted or host.endswith("." + trusted) for trusted in _ARTICLE_DOMAINS)
        if not (trusted or row.tier == "authority" or not authority_only and row.tier == "good"):
            continue
        images = _images(row)
        if kind == "article":
            item = {"type": "article", "title": title, "url": source}
            if images:
                item["thumbnail_url"] = images[0]
            items.append(item)
        else:
            for image in images[:2]:
                items.append({"type": "image", "title": title, "url": image, "thumbnail_url": image, "source_url": source})
    return items


async def find_chat_media(
    text: str,
    kinds: tuple[str, ...],
    *, locale: str,
    route,
    children: list,
    allow_history: bool,
    existing: list[SearchResult],
    authority_only: bool = False,
) -> dict | None:
    """Only provider URLs reach cards. Share no transcript with the provider."""
    if _PRIVATE_TEXT.search(redact_conversation_text(text)):
        return None
    query = _query(text, route, children, locale, allow_history)
    medical = bool(authority_only or getattr(route, "is_medical", False)
                   or _MEDICAL_TEXT.search(text) or _MEDICAL_TEXT.search(query))
    topic = _video_topic(text, route, children, allow_history) if "video" in kinds and not medical else None
    if not topic and (not query or not any(kind != "video" for kind in kinds)):
        return None
    lang = "zh" if locale.startswith("zh") else "en"
    provider = get_provider()
    live_provider = provider.name not in ("null", "stub")

    async def search(request: SearchRequest) -> list[SearchResult]:
        if not live_provider:
            return []
        try:
            return await asyncio.wait_for(provider.search(request), 5.0)
        except Exception:
            # The optional carousel must never fail or cancel a chat reply.
            return []

    async def videos():
        if not topic:
            return []
        language = "zh" if _EXPLICIT_ZH_VIDEO.search(text) else "en" if _EXPLICIT_EN_VIDEO.search(text) else ""
        search_locale = "en" if language == "en" else "zh-CN" if language == "zh" and lang != "zh" else locale
        rows = await search(SearchRequest(
            query=topic.query(search_locale), lang="zh" if search_locale.startswith("zh") else "en",
            include_domains=("youtube.com",), max_results=8,
        ))
        selected = _video_items(topic, rows, language)
        return (selected or _speech_video_fallback(topic, search_locale))[:_MAX_ITEMS if len(kinds) == 1 else 3]

    async def articles_and_images():
        requested = [kind for kind in ("article", "image") if kind in kinds]
        if not requested or not query or not live_provider:
            return []
        # Existing ranked articles cost no extra web request. An image-only
        # search asks the provider for images tied to those exact source rows.
        per_kind = _MAX_ITEMS if len(kinds) == 1 else 3 if len(kinds) == 2 else 2
        if "image" not in requested and (usable := _result_items("article", existing, medical)):
            return usable[:per_kind]
        rows = await search(SearchRequest(
            query=query, lang=lang, include_domains=_ARTICLE_DOMAINS,
            max_results=6, include_images=True,
        ))
        return [item for kind in requested for item in _result_items(kind, rows, medical)[:per_kind]]

    items = []
    seen = set()
    for group in await asyncio.gather(videos(), articles_and_images()):
        for item in group:
            if item["url"] not in seen:
                seen.add(item["url"])
                items.append(item)
    return {"kind": "chat_media", "items": items[:_MAX_ITEMS]} if items else None
