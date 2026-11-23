"""Bounded, provider-backed resources for an explicit Alpha chat request."""

from __future__ import annotations

import asyncio
import re
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
    r"tutorials?|the|this|that|about|it|to|look|for|help|do|have|is|there|links?)\b|"
    r"有沒有|有没有|有|給我|给我|能不能|可以|推薦|推荐|找|看看|分享|教學|教学|教程|"
    r"這個|这个|那些|剛才|刚才|一個|一个|链接|連結|鏈接|的|嗎|吗|[\W_])+?$",
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
        if kind == "video":
            fields = public_video_fields(row.url)
            if fields:
                items.append({"type": "video", "title": title.removesuffix(" - YouTube"), **fields})
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
    query = _query(text, route, children, locale, allow_history)
    if not query:
        return None
    medical = bool(authority_only or getattr(route, "is_medical", False)
                   or _MEDICAL_TEXT.search(text) or _MEDICAL_TEXT.search(query))
    lang = "zh" if locale.startswith("zh") else "en"
    provider = get_provider()
    if provider.name in ("null", "stub"):
        return None

    async def search(request: SearchRequest) -> list[SearchResult]:
        try:
            return await asyncio.wait_for(provider.search(request), 5.0)
        except Exception:
            # The optional carousel must never fail or cancel a chat reply.
            return []

    async def videos():
        if "video" not in kinds or medical:
            return []
        rows = await search(SearchRequest(
            query=f"{query} {'育儿 家长 教程' if lang == 'zh' else 'parent guide tutorial'}",
            lang=lang, include_domains=("youtube.com",), max_results=6,
        ))
        return _result_items("video", rows, False)[:_MAX_ITEMS if len(kinds) == 1 else 3]

    async def articles_and_images():
        requested = [kind for kind in ("article", "image") if kind in kinds]
        if not requested:
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
