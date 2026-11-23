"""Illustrated book and toy recommendations for the Alpha chat."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from .product_comparison import (
    _BUY,
    _MEDICAL_USE,
    _MEDICINE_FOR_CONDITION,
    _PUBLIC_ITEM_ID,
    _RESTRICTED,
    _listing_key,
    _page_markup,
    _pick_search_hits,
    _product_image,
    retailer_listing_data,
    retailer_listing_url,
)
from .websearch import SearchProvider, SearchRequest, get_provider

_TOPICS = {
    "books": re.compile(r"\b(?:books?|picturebooks?)\b|绘本|繪本|童书|童書|图画书|圖畫書", re.I),
    "toys": re.compile(r"\b(?:toys?|stacking cups|stacking rings|building blocks)\b|玩具|积木|積木", re.I),
}
_RECOMMEND = re.compile(
    r"\b(?:recommend(?:ation|ations)?|suggest(?:ion|ions)?|looking for|find me)\b|"
    r"推荐|推薦|建议|建議|哪些适合|哪些適合|有什么|有什麼|帮我找|幫我找",
    re.I,
)
_ATTACHMENT = re.compile(r"\b(?:photos?|images?|pictures?|links?|thumbnails?)\b|图片|圖片|封面|照片|发图|發圖|图和|圖和|链接|連結|鏈接|网址|網址", re.I)
_PRICE = re.compile(r"\b(?:cheapest|price|prices|how much|cost)\b|比价|比價|价格|價格|多少钱|多少錢|售价|售價", re.I)
_NON_PRODUCT_MEDIA = re.compile(r"\b(?:videos?|articles?|tutorials?)\b|视频|影片|視訊|文章|教程|教學", re.I)
_FOLLOW_UP = re.compile(
    r"\b(?:those|these|them|previous|above|ones|earlier|just)\b|这些|這些|那些|上述|刚才|剛才|上面|只要|要图|要圖|给我图|給我圖|的时候|的時候",
    re.I,
)
_CHILD_AGE = re.compile(
    r"(?<!\d)(?P<count>[0-9]{1,2})\s*(?P<unit>个?月|個月|岁|歲|months?(?:\s+old)?\b|years?(?:\s+old)?\b)",
    re.I,
)
_US_STORES = ("barnesandnoble.com", "bookshop.org", "target.com", "walmart.com", "amazon.com", "ikea.com")
_MARKET_STORES = {
    "CA": ("amazon.ca", "walmart.ca"), "GB": ("amazon.co.uk",), "AU": ("amazon.com.au",),
    "DE": ("amazon.de",), "FR": ("amazon.fr",), "JP": ("amazon.co.jp",),
}
_MARKET = re.compile(
    r"\b(canada|uk|united kingdom|australia|germany|france|japan|usa|united states)\b|"
    r"(加拿大|英国|英國|澳大利亚|澳洲|德国|德國|法国|法國|日本|美国|美國)", re.I,
)
_MARKET_CODES = {
    **dict.fromkeys(("canada", "加拿大"), "CA"), **dict.fromkeys(("uk", "united kingdom", "英国", "英國"), "GB"),
    **dict.fromkeys(("australia", "澳大利亚", "澳洲"), "AU"), **dict.fromkeys(("germany", "德国", "德國"), "DE"),
    **dict.fromkeys(("france", "法国", "法國"), "FR"), **dict.fromkeys(("japan", "日本"), "JP"),
    **dict.fromkeys(("usa", "united states", "美国", "美國"), "US"),
}


@dataclass(frozen=True)
class Listing:
    category: str
    title: str
    aliases: tuple[str, ...]
    retailer_url: str
    image_url: str
    minimum_months: int = 0
    maximum_months: int | None = None


# Merchant-owned product pages and matching catalog photos were checked on
# this date. On an access restriction or timeout, the snapshot can still
# provide the product link and photo without making a price or stock claim.
_CATALOG_CHECKED_AT = datetime(2026, 11, 23, tzinfo=timezone.utc)
_CATALOG = (
    Listing("books", "Brown Bear, Brown Bear, What Do You See?", ("brown bear", "棕色的熊"),
            "https://www.barnesandnoble.com/w/brown-bear-brown-bear-what-do-you-see-bill-martin-jr/1111944184?ean=9780805047905",
            "https://cdn.shopify.com/s/files/1/0674/5433/7265/files/9780805047905_p0.jpg?v=1768966681", maximum_months=60),
    Listing("books", "Dear Zoo", ("dear zoo", "亲爱的动物园", "親愛的動物園"),
            "https://www.barnesandnoble.com/w/dear-zoo-rod-campbell/1003267843?ean=9781416947370",
            "https://cdn.shopify.com/s/files/1/0674/5433/7265/files/9781416947370_p0.jpg?v=1768989247", maximum_months=60),
    Listing("books", "Where’s Spot?", ("where's spot", "where’ s spot", "where’s spot", "小玻在哪"),
            "https://www.barnesandnoble.com/w/wheres-spot-eric-hill/1100469008?ean=9780399240461",
            "https://cdn.shopify.com/s/files/1/0674/5433/7265/files/9780399240461_p0.jpg?v=1764988900", maximum_months=60),
    Listing("books", "Goodnight Moon", ("goodnight moon", "晚安月亮"),
            "https://www.target.com/p/-/A-11340485", "https://target.scene7.com/is/image/Target/GUEST_f220e321-9c5e-43dc-b94c-a2e4063e6ecb?wid=360", maximum_months=72),
    Listing("toys", "Melissa & Doug First Play Wooden Animal Stacking Cars",
            ("stacking cars", "车车", "車車", "toy cars", "小车", "小車"),
            "https://www.target.com/p/-/A-53401107", "https://target.scene7.com/is/image/Target/GUEST_c1e8c7c3-2186-467f-8912-e02fcff2e5cf?wid=360", 9, 36),
    Listing("toys", "IKEA UPPSTÅ Stack & Nest Cups",
            ("stacking cup", "nesting cup", "叠叠杯", "疊疊杯", "套杯"),
            "https://www.ikea.com/us/en/p/uppsta-stack-nest-cups-multicolor-70513884/",
            "https://www.ikea.com/us/en/images/products/uppsta-stack-nest-cups-multicolor__1041615_pe841100_s5.jpg?f=s",
            6, 36),
    Listing("toys", "Fisher-Price Chatter Telephone",
            ("chatter telephone", "pretend phone", "假装电话", "假裝電話", "玩具电话", "玩具電話"),
            "https://www.target.com/p/fisher-price-chatter-telephone-vehicle-push-along-toy-with-sounds-for-baby-38-toddler/-/A-94748553",
            "https://target.scene7.com/is/image/Target/GUEST_a51b555f-038f-475a-9e9c-c091df249e5d?wid=300&hei=300&qlt=80",
            6, 36),
    Listing("toys", "IKEA UPPSTÅ Stacking Rings", ("stacking ring", "叠叠环", "疊疊環", "套圈"),
            "https://www.ikea.com/us/en/p/uppsta-stacking-rings-multicolor-00513892/",
            "https://www.ikea.com/us/en/images/products/uppsta-stacking-rings-multicolor__1609662_pe1046436_s5.jpg?f=s",
            12, 36),
)


@dataclass(frozen=True)
class DiscoveryRequest:
    categories: tuple[str, ...]
    text: str
    previous_reply: str


def _categories(text: str) -> tuple[str, ...]:
    return tuple(category for category, pattern in _TOPICS.items() if pattern.search(text))


def requested_recommendations(text: str, history: list) -> DiscoveryRequest | None:
    """Use the latest same-session reply locally to resolve a short follow-up."""
    if (not 4 <= len(text) <= 400 or _MEDICAL_USE.search(text) or _MEDICINE_FOR_CONDITION.search(text)
            or _RESTRICTED.search(text) or _PUBLIC_ITEM_ID.search(text) or _NON_PRODUCT_MEDIA.search(text)):
        return None
    named = tuple(item for item in _CATALOG if _match_position(item, text) < len(text.casefold()))
    categories = _categories(text) or tuple(dict.fromkeys(item.category for item in named))
    wants_recommendations = _RECOMMEND.search(text)
    wants_attachments = _ATTACHMENT.search(text)
    # An explicit price or named-item checkout stays on the SKU lookup path.
    if _PRICE.search(text) or named and _BUY.search(text) and not wants_attachments:
        return None
    if not (wants_recommendations or wants_attachments):
        return None
    prior = ""
    if wants_attachments and (_FOLLOW_UP.search(text) or not wants_recommendations):
        prior = next((row.get("text") or "" for row in reversed(history[-8:]) if row.get("role") == "ai"), "")
    if not categories and wants_attachments and _FOLLOW_UP.search(text):
        prior_matches = (item.category for item in _CATALOG if _match_position(item, prior) < len(prior.casefold()))
        categories = _categories(prior) or tuple(dict.fromkeys(prior_matches))
    return DiscoveryRequest(categories, text, prior) if categories else None


def _match_position(item: Listing, text: str) -> int:
    folded = text.casefold()
    return min((index for alias in item.aliases if (index := folded.find(alias)) >= 0), default=len(folded))


def _age_months(request: DiscoveryRequest, reply: str) -> int | None:
    age_match = _CHILD_AGE.search(request.text) or _CHILD_AGE.search(request.previous_reply) or _CHILD_AGE.search(reply)
    age = int(age_match["count"]) if age_match else None
    if age is not None and age_match["unit"].casefold().startswith(("岁", "歲", "year")):
        age *= 12
    return age


def _select(request: DiscoveryRequest, reply: str, category: str, age: int | None) -> list[Listing]:
    combined = "\n".join((request.text, request.previous_reply, reply))
    choices = [item for item in _CATALOG if item.category == category and (
        age is None or item.minimum_months <= age and (
            item.maximum_months is None or age <= item.maximum_months
        )
    )]
    return sorted(choices, key=lambda item: _match_position(item, combined))


def _market_stores(text: str, locale: str) -> tuple[str, ...]:
    explicit = _MARKET.search(text)
    code = _MARKET_CODES[explicit.group(0).casefold()] if explicit else locale.replace("_", "-").split("-")[-1].upper()
    return _MARKET_STORES.get(code, _US_STORES)


def _public_query(category: str, age: int | None) -> str:
    subject = "board books" if category == "books" and age is not None and age < 36 else {
        "books": "children's picture books", "toys": "children's toys",
    }[category]
    if age is None:
        return subject
    for upper, label in ((6, "newborn"), (12, "6-12 months"), (24, "12-24 months"),
                         (36, "2 years"), (72, "preschool"), (108, "6-8 years"), (144, "9-11 years")):
        if age < upper:
            return f"{subject} {label}"
    return f"{subject} ages 12 and up"


async def _search_listings(http: httpx.AsyncClient, search: SearchProvider, category: str,
                           age: int | None, stores: tuple[str, ...]) -> list[Listing]:
    if search.name in {"null", "stub"}:
        return []
    try:
        async with asyncio.timeout(2.8):
            rows = await search.search(SearchRequest(
                query=_public_query(category, age), include_domains=stores, max_results=8,
            ))
    except Exception:
        return []

    async def inspect(url: str) -> Listing | None:
        try:
            async with asyncio.timeout(2.2):
                page = await _page_markup(http, url)
        except TimeoutError:
            return None
        if not page or _listing_key(page[0])[0] not in stores:
            return None
        data = retailer_listing_data(page[1], page[0], now=datetime.now(timezone.utc))
        if not data or data.get("_restricted") or not data["image_url"]:
            return None
        return Listing(category, data["title"], (), page[0], data["image_url"])

    urls = [url for _, url, _ in _pick_search_hits(rows) if _listing_key(url)[0] in stores]
    resolved = await asyncio.gather(*(inspect(url) for url in urls[:4]))
    return [item for item in resolved if item]


async def _probe_public_asset(client: httpx.AsyncClient, url: str, content_type: str) -> bool | None:
    accept = "image/*" if content_type == "image/" else content_type
    try:
        async with asyncio.timeout(2.2):
            async with client.stream("GET", url, headers={"Accept": accept}) as response:
                if response.status_code == 200:
                    return response.headers.get("content-type", "").lower().startswith(content_type)
                if response.status_code in {404, 410}:
                    return False
                # Some shops decline automated access. A previously verified
                # page and photo still make a useful card without a price.
                return None
    except (httpx.HTTPError, TimeoutError):
        return None


async def recommendation_transition(request: DiscoveryRequest, reply: str, *, locale: str = "en",
                                    client: httpx.AsyncClient | None = None,
                                    provider: SearchProvider | None = None) -> dict | None:
    async def inspect(http: httpx.AsyncClient, item: Listing):
        checked = retailer_listing_url(item.retailer_url)
        image_url = _product_image(item.image_url, item.retailer_url)
        if not checked or not image_url:
            return None
        url, retailer = checked
        page_ok, image_ok = await asyncio.gather(
            _probe_public_asset(http, url, "text/html"),
            _probe_public_asset(http, image_url, "image/"),
        )
        if page_ok is False or image_ok is False:
            return None
        return ({
            "title": item.title,
            "url": url,
            "retailer": retailer,
            "image_url": image_url,
            "price_amount": None,
            "currency": None,
            "availability": "unknown",
        }, page_ok is True and image_ok is True)

    stores = _market_stores(request.text, locale)
    search = provider if provider is not None else get_provider()
    age = _age_months(request, reply)

    async def category_cards(http: httpx.AsyncClient, category: str):
        limit = 2 if category == "toys" and len(request.categories) > 1 else 4
        snapshot = _select(request, reply, category, age) if stores == _US_STORES else []
        context = "\n".join((request.text, request.previous_reply, reply)).casefold()
        requested = request.text.casefold()
        chosen = [item for item in snapshot if _match_position(item, requested) < len(requested)]
        if not chosen:
            chosen = [item for item in snapshot if _match_position(item, context) < len(context)]
        if not chosen:
            discovered = {}
            for item in await _search_listings(http, search, category, age, stores):
                discovered.setdefault(_listing_key(item.retailer_url), item)
            chosen = list(discovered.values())
        initial = (chosen or snapshot)[:limit]
        fallback = [item for item in snapshot if item not in initial][:limit]
        for group in (initial, fallback):
            results = await asyncio.gather(*(inspect(http, item) for item in group))
            if cards := [result for result in results if result]:
                return cards
        return []

    async def get_cards(http: httpx.AsyncClient):
        groups = await asyncio.gather(*(category_cards(http, category) for category in request.categories))
        return [result for group in groups for result in group]

    if client is None:
        async with httpx.AsyncClient(timeout=1.8, follow_redirects=False, trust_env=False,
                                     limits=httpx.Limits(max_connections=12)) as http:
            cards = await get_cards(http)
    else:
        cards = await get_cards(client)
    if not cards:
        return None
    checked_at = datetime.now(timezone.utc) if all(live for _, live in cards) else _CATALOG_CHECKED_AT
    return {
        "kind": "product_comparison",
        "status": "links_only",
        "checked_at": checked_at.isoformat(),
        "offers": [offer for offer, _ in cards],
        "best_price_url": None,
        "is_medication": False,
    }
