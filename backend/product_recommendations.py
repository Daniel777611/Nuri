"""Illustrated retailer recommendations for the Alpha chat."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit

import httpx

from .alpha_milestones import child_age
from .product_comparison import (
    _BUY,
    _MEDICAL_USE,
    _MEDICINE_FOR_CONDITION,
    _PUBLIC_ITEM_ID,
    _RESTRICTED,
    _clean_text,
    _listing_key,
    _pick_search_hits,
    _product_image,
    _read_listing_page,
    retailer_listing_data,
    retailer_listing_url,
)
from .websearch import SearchProvider, SearchRequest, SearchResult, get_provider

_TOPICS = {
    "books": re.compile(r"\b(?:books?|picturebooks?|storybooks?|story collection)\b|绘本|繪本|童书|童書|图画书|圖畫書|[婴嬰]幼[儿兒].{0,8}的书", re.I),
    "toys": re.compile(r"\b(?:toys?|stacking cups|stacking rings|building blocks|pretend play|playsets?|dolls?)\b|玩具|积木|積木", re.I),
    "diapers": re.compile(r"\b(?:diapers?|napp(?:y|ies))\b|尿布|尿[裤褲]", re.I),
    "strollers": re.compile(r"\b(?:strollers?|prams?|pushchairs?)\b|[婴嬰][儿兒]车|[婴嬰][儿兒]車|童[车車]|推[车車]", re.I),
    "car_seats": re.compile(r"\b(?:car seats?|booster seats?)\b|安全座椅|汽[车車]座椅", re.I),
    "monitors": re.compile(r"\bbaby monitors?\b|(?:[婴嬰][儿兒]|宝宝|寶寶)[监監][视視][器機]", re.I),
    "bottles": re.compile(r"\b(?:baby bottles?|feeding bottles?)\b|奶瓶", re.I),
    "carriers": re.compile(r"\b(?:baby carriers?|infant carriers?|baby wraps?)\b|背[带帶]|背[巾帶]", re.I),
    "high_chairs": re.compile(r"\bhigh[ -]?chairs?\b|(?:[婴嬰][儿兒]|宝宝|寶寶|[儿兒]童)[餐饭飯]椅", re.I),
    "cribs": re.compile(r"\b(?:cribs?|cots?|bassinets?)\b|(?:[婴嬰][儿兒]|宝宝|寶寶)床", re.I),
}
_SUBJECTS = {
    "books": "children's picture books",
    "toys": "children's toys",
    "diapers": "baby diapers",
    "strollers": "baby strollers",
    "car_seats": "child car seats",
    "monitors": "baby monitors",
    "bottles": "baby feeding bottles",
    "carriers": "baby carriers",
    "high_chairs": "baby high chairs",
    "cribs": "baby cribs",
}
_RECOMMEND = re.compile(
    r"\b(?:recommend(?:ation|ations)?|suggest(?:ion|ions)?|looking for|find me|"
    r"give me (?:some|a few|a couple of|your|a)|i(?:'m| am) after|i need|which .{1,45} should i get)\b|"
    r"推荐|推薦|建议|建議|(?:哪些|什么|什麼|哪款|哪种|哪種).{0,10}(?:适合|適合|好用)|"
    r"有什么|有什麼|有哪些|帮我找|幫我找|(?:给|給)我(?:找|挑|[选選]|[一几幾]?[个個本款件套])|"
    r"(?:找|挑|[选選]|想要|需要)[一几幾][个個本款件套种種]|(?:想|需要)(?:找|挑|[选選])",
    re.I,
)
_ATTACHMENT = re.compile(r"\b(?:photos?|images?|pictures?|links?|thumbnails?)\b|图片|圖片|封面|照片|发图|發圖|图和|圖和|链接|連結|鏈接|网址|網址", re.I)
_LINK_FOLLOW_UP = re.compile(
    r"(?:链接|連結|鏈接|网址|網址).{0,8}(?:在(?:哪|哪里|哪裡)|在哪|呢)"
    r"|^(?:我(?:就)?要的是|都[说說]了).{0,10}(?:链接|連結|鏈接)"
    r"|\b(?:where(?:'s|\s+(?:is|are))|send|give)\b.{0,40}\b(?:links?|urls?)\b",
    re.I,
)
_PRICE = re.compile(r"\b(?:cheapest|price|prices|how much|cost)\b|比价|比價|价格|價格|多少钱|多少錢|售价|售價", re.I)
_NON_PRODUCT_MEDIA = re.compile(r"\b(?:videos?|articles?|tutorials?)\b|视频|影片|視訊|文章|教程|教學", re.I)
_FOLLOW_UP = re.compile(
    r"\b(?:those|these|them|previous|above|ones|earlier|just)\b|这些|這些|那些|上述|刚才|剛才|上面|只要|要图|要圖|给我图|給我圖|的时候|的時候",
    re.I,
)
_US_STORES = ("barnesandnoble.com", "bookshop.org", "target.com", "walmart.com", "amazon.com", "ikea.com", "lego.com",
              "lakeshorelearning.com")
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
_STORES_BY_NAME = {
    "amazon.": re.compile(r"\bamazon\b|亚马逊|亞馬遜", re.I),
    "walmart.": re.compile(r"\bwalmart\b|沃尔玛|沃爾瑪", re.I),
    "target.com": re.compile(r"\btarget\b", re.I),
    "barnesandnoble.com": re.compile(r"\bbarnes\s*(?:&|and)\s*noble\b", re.I),
    "bookshop.org": re.compile(r"\bbookshop\.org\b", re.I),
    "ikea.com": re.compile(r"\bikea\b|宜家", re.I),
    "lego.com": re.compile(r"\blego\b|乐高|樂高", re.I),
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
            "https://www.barnesandnoble.com/w/goodnight-moon-margaret-wise-brown/1105127857?ean=9780694003617",
            "https://cdn.shopify.com/s/files/1/0674/5433/7265/files/9780694003617_p0.jpg?v=1768976243", maximum_months=72),
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
    Listing("toys", "IKEA UPPSTÅ Stacking Rings", ("stacking ring", "叠叠环", "疊疊環", "叠环", "疊環", "套圈"),
            "https://www.ikea.com/us/en/p/uppsta-stacking-rings-multicolor-00513892/",
            "https://www.ikea.com/us/en/images/products/uppsta-stacking-rings-multicolor__1609662_pe1046436_s5.jpg?f=s",
            12, 36),
)


@dataclass(frozen=True)
class DiscoveryRequest:
    categories: tuple[str, ...]
    text: str
    previous_reply: str
    exact_only: bool = False
    age_months: int | None = None


def _categories(text: str) -> tuple[str, ...]:
    return tuple(category for category, pattern in _TOPICS.items() if pattern.search(text))


def requested_recommendations(text: str, history: list, *, children: list | None = None) -> DiscoveryRequest | None:
    """Use the latest same-session reply locally to resolve a short follow-up."""
    if (not 4 <= len(text) <= 400 or _MEDICAL_USE.search(text) or _MEDICINE_FOR_CONDITION.search(text)
            or _RESTRICTED.search(text) or _PUBLIC_ITEM_ID.search(text) or _NON_PRODUCT_MEDIA.search(text)):
        return None
    named = tuple(item for item in _CATALOG if _match_position(item, text) < len(text.casefold()))
    categories = tuple(dict.fromkeys((*_categories(text), *(item.category for item in named))))
    wants_recommendations = _RECOMMEND.search(text)
    wants_attachments = _ATTACHMENT.search(text)
    follow_up = _FOLLOW_UP.search(text)
    link_follow_up = _LINK_FOLLOW_UP.search(text)
    wants_price = _PRICE.search(text)
    # An explicit price or named-item checkout stays on the SKU lookup path.
    if not wants_attachments and (wants_price or _BUY.search(text)) and (named or not (wants_recommendations or follow_up)):
        return None
    if not (wants_recommendations or wants_attachments or wants_price and follow_up):
        return None
    prior = ""
    if (wants_attachments or wants_price) and (follow_up or link_follow_up or not wants_recommendations):
        recent = history[-8:]
        for index in range(len(recent) - 1, -1, -1):
            row = recent[index]
            if row.get("role") != "ai":
                continue
            prior = row.get("text") or ""
            transition = row.get("transition")
            if isinstance(transition, dict) and transition.get("kind") == "product_comparison":
                # Direct card replies need not repeat the category in prose.
                # Recover it from the user request that produced those cards.
                subject = next((item.get("text") or "" for item in reversed(recent[:index])
                                if item.get("role") == "user"), "")
                prior = f"{subject}\n{prior}"
            break
    if not categories and (follow_up or link_follow_up) and not _NON_PRODUCT_MEDIA.search(prior):
        prior_matches = tuple(item.category for item in _CATALOG if _match_position(item, prior) < len(prior.casefold()))
        if follow_up or prior_matches or _RECOMMEND.search(prior):
            categories = tuple(dict.fromkeys((*_categories(prior), *prior_matches)))
    if not categories:
        return None
    age = child_age(text, children or [], [prior] if prior else [])
    return DiscoveryRequest(categories, text, prior, age_months=age)


def exact_catalog_request(text: str) -> DiscoveryRequest | None:
    if (_MEDICAL_USE.search(text) or _MEDICINE_FOR_CONDITION.search(text) or _RESTRICTED.search(text)
            or _PUBLIC_ITEM_ID.search(text) or _NON_PRODUCT_MEDIA.search(text)):
        return None
    categories = tuple(dict.fromkeys(
        item.category for item in _CATALOG if _match_position(item, text) < len(text.casefold())
    ))
    return DiscoveryRequest(categories, text, "", exact_only=True) if categories else None


def attachment_only(request: DiscoveryRequest) -> bool:
    text = request.text
    return bool(
        (_ATTACHMENT.search(text) or _PRICE.search(text)) and
        (not _RECOMMEND.search(text) or _FOLLOW_UP.search(text))
    )


def _match_position(item: Listing, text: str) -> int:
    folded = text.casefold()
    return min((index for alias in item.aliases if (index := folded.find(alias)) >= 0), default=len(folded))


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
    stores = _MARKET_STORES.get(code, _US_STORES)
    requested = tuple(name for name, pattern in _STORES_BY_NAME.items() if pattern.search(text))
    return tuple(store for store in stores if store.startswith(requested)) if requested else stores


def _public_query(category: str, age: int | None) -> str:
    subject = "board books" if category == "books" and age is not None and age < 36 else _SUBJECTS[category]
    if age is None:
        return subject
    for upper, label in ((6, "newborn"), (12, "6-12 months"), (24, "12-24 months"),
                         (36, "2 years"), (72, "preschool"), (108, "6-8 years"), (144, "9-11 years")):
        if age < upper:
            return f"{subject} {label}"
    return f"{subject} ages 12 and up"


async def _search_listings(search: SearchProvider, category: str,
                           age: int | None, stores: tuple[str, ...], *,
                           listing: Listing | None = None) -> list[tuple[str, SearchResult]]:
    if not stores or search.name in {"null", "stub"}:
        return []
    try:
        async with asyncio.timeout(4.5):
            rows = await search.search(SearchRequest(
                query=listing.title if listing else _public_query(category, age),
                include_domains=stores, max_results=8, include_images=True,
            ))
    except Exception:
        return []

    relevant = []
    for hit in rows:
        checked = retailer_listing_url(hit.url)
        if not checked or (host := _listing_key(checked[0])[0]) not in stores:
            continue
        if listing:
            if _match_position(listing, hit.title) == len(hit.title.casefold()):
                continue
        elif not (
            _TOPICS[category].search(f"{hit.title} {hit.snippet}")
            or category == "books" and host in {"barnesandnoble.com", "bookshop.org"}
        ):
            continue
        relevant.append(hit)
    urls = {}
    for hit, url, _ in _pick_search_hits(relevant):
        key = _listing_key(url)
        urls.setdefault((*key, urlsplit(url).query), (url, hit))
    return list(urls.values())[:4]


async def _probe_image(client: httpx.AsyncClient, url: str) -> bool | None:
    try:
        async with asyncio.timeout(2.2):
            async with client.stream("GET", url, headers={"Accept": "image/*"}) as response:
                if response.status_code == 200:
                    return response.headers.get("content-type", "").lower().startswith("image/")
                if response.is_redirect or response.status_code in {404, 410}:
                    return False
                # Some shops decline automated access. A previously verified
                # page and photo still make a useful card without a price.
                return None
    except (httpx.HTTPError, TimeoutError):
        return None


async def _load_listing(http: httpx.AsyncClient, url: str) -> tuple[str, str | None] | None:
    try:
        async with asyncio.timeout(3.6):
            return await _read_listing_page(http, url, exact=True)
    except TimeoutError:
        return None


async def recommendation_transition(request: DiscoveryRequest, reply: str, *, locale: str = "en",
                                    client: httpx.AsyncClient | None = None,
                                    provider: SearchProvider | None = None) -> dict | None:
    now = datetime.now(timezone.utc)

    async def inspect(http: httpx.AsyncClient, source: str, fallback: Listing | None = None,
                      hit: SearchResult | None = None):
        checked = retailer_listing_url(source)
        if not checked:
            return None
        url, retailer = checked
        image_url = _product_image(fallback.image_url, url) if fallback else None
        if image_url:
            page, image_ok = await asyncio.gather(_load_listing(http, url), _probe_image(http, image_url))
        else:
            page, image_ok = await _load_listing(http, url), False
        if page and page[1] is None:
            return None
        fetched_url, markup = page or (url, None)
        data = retailer_listing_data(markup, fetched_url, now=now) if markup else None
        if data and data.get("_restricted"):
            return None
        details = data or {}
        title = fallback.title if fallback else details.get("title") or _clean_text(hit.title if hit else "", 180)
        if not title:
            return None
        if not image_url or image_ok is False:
            # A photograph can come from the retailer metadata or from this
            # exact search result. Query-level photos have no product identity.
            source_images = [_product_image(image.url, fetched_url) for image in hit.images[:3]] if hit else []
            candidates = list(dict.fromkeys(url for url in (details.get("image_url"), *source_images) if url))
            verified = await asyncio.gather(*(_probe_image(http, candidate) for candidate in candidates))
            image_url = next((candidate for candidate, ok in zip(candidates, verified) if ok is True), None)
            if not image_url:
                return None
        edition = dict(parse_qsl(urlsplit(url).query)).get("ean")
        if edition and details.get("_identity") != "gtin:" + edition.zfill(14):
            # A bookseller can serve a different format or generic page meta
            # for the requested book. Quote only the exact edition's offer.
            details = {}
        offer_url = details.get("_offer_url", fetched_url)
        if (*_listing_key(offer_url), urlsplit(offer_url).query) != (*_listing_key(url), urlsplit(url).query):
            offer_url, details = fetched_url, {}
        return ({
            "title": title,
            "url": offer_url,
            "retailer": retailer,
            "image_url": image_url,
            "price_amount": details.get("price_amount"),
            "currency": details.get("currency"),
            "availability": details.get("availability", "unknown"),
        }, bool(markup))

    stores = _market_stores(f"{request.text}\n{request.previous_reply}", locale)
    search = provider if provider is not None else get_provider()
    age = request.age_months
    if age is None:
        age = child_age(request.text, [], [request.previous_reply, reply])

    async def category_cards(http: httpx.AsyncClient, category: str):
        limit = 2 if category == "toys" and len(request.categories) > 1 else 4
        catalog = _select(request, reply, category, age)
        snapshot = [item for item in catalog if _listing_key(item.retailer_url)[0] in stores]
        context = "\n".join((request.text, request.previous_reply, reply)).casefold()
        requested = request.text.casefold()
        mentioned = [item for item in catalog if _match_position(item, requested) < len(requested)]
        if not mentioned:
            if request.exact_only:
                return []
            mentioned = [item for item in catalog if _match_position(item, context) < len(context)]
        selected = [item for item in snapshot if item in mentioned] if mentioned else snapshot
        results = await asyncio.gather(*(inspect(http, item.retailer_url, item) for item in selected[:limit]))
        cards = [result for result in results if result]
        if cards:
            return cards

        if mentioned:
            groups = await asyncio.gather(*(
                _search_listings(search, category, age, stores, listing=item) for item in mentioned[:limit]
            ))
            rows = list(dict(url_hit for group in groups for url_hit in group).items())
        else:
            rows = await _search_listings(search, category, age, stores)
        results = await asyncio.gather(*(inspect(http, url, hit=hit) for url, hit in rows[:limit]))
        return [result for result in results if result]

    async def get_cards(http: httpx.AsyncClient):
        groups = await asyncio.gather(*(category_cards(http, category) for category in request.categories))
        return [result for group in groups for result in group]

    if client is None:
        async with httpx.AsyncClient(timeout=3.0, follow_redirects=False, trust_env=False,
                                     limits=httpx.Limits(max_connections=12), headers={"Accept": "text/html"}) as http:
            cards = await get_cards(http)
    else:
        cards = await get_cards(client)
    if not cards:
        return None
    offers = [offer for offer, _ in cards]
    checked_at = now if any(live for _, live in cards) else _CATALOG_CHECKED_AT
    return {
        "kind": "product_comparison",
        "status": "ready" if any(offer["price_amount"] for offer in offers) else "links_only",
        "checked_at": checked_at.isoformat(),
        "offers": offers,
        "best_price_url": None,
        "is_medication": False,
    }
