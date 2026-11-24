"""Alpha shopping lookup. Search discovers listings; retailers supply prices."""

from __future__ import annotations

import asyncio
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit

import httpx

from .content_research import redact_conversation_text
from .websearch import SearchProvider, SearchRequest, SearchResult, get_provider

# Exact sites and listing paths, never a caller-supplied fetch target.
_AMAZON = r"/(?:[a-zA-Z0-9_%.-]+/)?(?:dp|gp/product)/[A-Z0-9]{10}/?"
_RETAILERS = {
    "amazon.com": ("Amazon", _AMAZON),
    "amazon.ca": ("Amazon Canada", _AMAZON),
    "amazon.co.uk": ("Amazon UK", _AMAZON),
    "amazon.de": ("Amazon Germany", _AMAZON),
    "amazon.fr": ("Amazon France", _AMAZON),
    "amazon.co.jp": ("Amazon Japan", _AMAZON),
    "amazon.com.au": ("Amazon Australia", _AMAZON),
    "walmart.com": ("Walmart", r"/ip/(?:[^/]+/)?[0-9]+/?"),
    "walmart.ca": ("Walmart Canada", r"/en/ip/(?:[^/]+/)?[A-Za-z0-9]+/?"),
    "target.com": ("Target", r"/p/(?:[^/]+/)?-/A-[0-9]+/?"),
    "barnesandnoble.com": ("Barnes & Noble", r"/w/[^/]+/[0-9]+/?"),
    "bookshop.org": ("Bookshop.org", r"/p/books/[^/]+(?:/[0-9a-z]{6,32})?/?"),
    "rei.com": ("REI", r"/product/[0-9]+/[^/]+/?"),
    "lego.com": ("LEGO", r"/[a-z]{2}-[a-z]{2}/product/[^/]+-[0-9]+/?"),
    "ikea.com": ("IKEA", r"/[a-z]{2}/[a-z]{2}/p/[^/]+-[A-Za-z0-9]+/?"),
    "lakeshorelearning.com": ("Lakeshore Learning", r"/products/(?:[^/]+/){1,7}p/[^/]+/?"),
    "walgreens.com": ("Walgreens", r"/store/c/(?:[^/]+/){1,4}ID=[A-Za-z0-9]+-product/?"),
    "cvs.com": ("CVS", r"/shop/[^/]+-prodid-[A-Za-z0-9]+/?"),
    "iherb.com": ("iHerb", r"/(?:pr|r)/[^/]+/[0-9]+/?"),
}
_IMAGE_HOSTS = {
    "m.media-amazon.com", "images-na.ssl-images-amazon.com", "images.amazon.com",
    "i5.walmartimages.com", "i5.walmartimages.ca", "target.scene7.com",
    "prodimage.images-bn.com",
    "images.booksense.com", "images-us.bookshop.org", "www.rei.com", "rei.com", "www.lego.com",
    "www.ikea.com", "www.lakeshorelearning.com", "www.walgreens.com",
    "pics.walgreens.com", "www.cvs.com", "s3.images-iherb.com",
    "cloudinary.images-iherb.com", "images.iherb.com",
}
_CURRENCIES = {
    "AUD", "CAD", "CHF", "CNY", "EUR", "GBP", "HKD", "INR", "JPY", "KRW",
    "MXN", "MYR", "NZD", "SGD", "TWD", "USD", "ZAR",
}
_BUY = re.compile(
    r"\b(?:buy|purchase|shopping|cheapest|lowest\s+price|compare\s+(?:the\s+)?prices?|price\s+comparison|"
    r"where\s+(?:can\s+i\s+)?(?:to\s+)?(?:buy|order|get)|how\s+much\b.{0,100}\bcosts?\b|"
    r"prices?\s+(?:on|for|of|at)|(?:amazon|walmart|target|cvs|walgreens)\s+(?:link|price)|"
    r"find\s+(?:me\s+)?(?:a\s+)?(?:product|shopping|store)\s+links?)\b"
    r"|比价|比價|多少钱|多少錢|什么价|什麼價|哪里可以买|哪裡可以買|哪儿买|哪兒買|"
    r"哪里买|哪裡買|哪里最便宜|哪裡最便宜|购买链接|購買連結|購買鏈接|购买网址|購買網址|售价|售價|"
    r"(?:amazon|walmart|target|亚马逊|亞馬遜|沃尔玛|沃爾瑪).{0,12}(?:链接|連結|鏈接|价格|價格)|"
    r"(?:想|要|准备|準備|打算|帮我|幫我)买|(?:想|要|準備|打算|幫我)買"
    r"|(?:查|看看|找找|对比|對比|比较|比較).{0,24}(?:价格|價格|价钱|價錢)",
    re.I,
)
_PRODUCT_RECOMMENDATION = re.compile(
    r"\b(?:recommend|suggest|find\s+me|looking\s+for)\b.{0,80}\b"
    r"(?:picture\s+books?|board\s+books?|diapers?|strollers?|car\s+seats?|"
    r"baby\s+monitors?|toys?|feeding\s+bottles?|baby\s+carriers?)\b|"
    r"(?:推荐|推薦|找|买|買).{0,22}(?:绘本|繪本|尿布|纸尿裤|紙尿褲|婴儿车|嬰兒車|"
    r"儿童座椅|兒童座椅|玩具|奶瓶|背带|背帶)",
    re.I,
)
_RESTRICTED = re.compile(
    r"\b(?:prescription(?:-only)?|without\s+(?:a\s+)?(?:prescription|doctor)|rx[- ]only|"
    r"opioids?|fentanyl|oxycontin|oxycodone|hydrocodone|methadone|codeine|"
    r"antibiotics?|amoxicillin|azithromycin|augmentin|adderall|ritalin|xanax|"
    r"semaglutide|tirzepatide|ozempic|mounjaro|wegovy|insulin|epipen|"
    r"firearm|ammunition|explosives?|pesticide\s+poison)\b|"
    r"(?:处方|處方|抗生素|阿莫西林|阿奇霉素|芬太尼|胰岛素|胰島素|司美格鲁肽|司美格魯肽|枪支|槍支|炸药|炸藥)",
    re.I,
)
_MEDICAL_USE = re.compile(
    r"\b(?:dosage|dose|dosing|symptoms|side effects|treat|treatment|overdose|"
    r"can (?:i |my (?:baby|child) )?(?:take|use)|should (?:i |my (?:baby|child) )?(?:take|use))\b"
    r"|剂量|劑量|用量|怎么(?:吃|服)|怎麼(?:吃|服)|症状|症狀|能不能(?:吃|服用)|可以(?:吃|服用).*吗",
    re.I,
)
_MEDICINE_FOR_CONDITION = re.compile(
    r"\b(?:medicines?|medication|drugs?|remedy|remedies|pain relievers?)\s+(?:for|to)\b|"
    r"\b(?:cough|fever|allergy|pain|rash|nausea)\s+(?:medicines?|medication|drugs?|remedy|remedies)\b"
    r"|(?:止咳|退烧|退燒|发烧|發燒|发热|發熱|过敏|過敏|止痛|治病).{0,7}(?:的)?[药藥]",
    re.I,
)
_MEDICATION = re.compile(
    r"\b(?:medicine|medication|acetaminophen|paracetamol|ibuprofen|aspirin|tylenol|motrin|"
    r"advil|benadryl|zyrtec|claritin|tablets?|capsules?|pain reliever)\b|药|藥",
    re.I,
)
_PRIVATE_MARKER = re.compile(r"\[(?:邮箱|电话|编号|链接|名字|地址|address|name|school)\]")
_PUBLIC_ITEM_ID = re.compile(
    r"\b(?:(?:ISBN(?:-13)?|UPC|EAN|GTIN)\s*[:#]?\s*([0-9][0-9 -]{6,21}[0-9])|((?:978|979)[0-9]{10}))\b",
    re.I,
)
_PRIVATE_CONTEXT = re.compile(
    r"\b(?:my (?:child|son|daughter|baby) (?:has|is|takes|weighs)|at my address|"
    r"send it to|diagnosed with|my (?:name|address) is|"
    r"(?:account|phone|card|order|passport|member)(?:\s+number|\s+id)?\s*[:#]?\s*\d)\b|"
    r"(?:我的(?:地址|姓名)|宝宝(?:发烧|過敏|发病)|寶寶(?:發燒|過敏|發病)|确诊|確診)",
    re.I,
)
_IN_STOCK = {"instock", "limitedavailability", "onlineonly"}
_OUT_OF_STOCK = {"outofstock", "soldout", "discontinued", "preorder", "backorder"}
_MAX_OFFERS = 6
_PAGE_LIMIT = 2_000_000


@dataclass(frozen=True)
class ProductLookup:
    reply: str
    transition: dict[str, Any]


def is_product_request(text: str | None) -> bool:
    value = (text or "").strip()
    return (
        5 <= len(value) <= 300
        and bool(_BUY.search(value) or _PRODUCT_RECOMMENDATION.search(value))
        and not _MEDICAL_USE.search(value)
        and not _MEDICINE_FOR_CONDITION.search(value)
    )


def _clean_text(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    visible = "".join(" " if unicodedata.category(ch).startswith("C") else ch for ch in value[:limit * 3])
    return re.sub(r"\s+", " ", visible).strip()[:limit]


def _https(value: object):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f\\]", value):
        return None
    try:
        parts = urlsplit(value)
        if parts.scheme == "https" and parts.hostname and not parts.username and not parts.password and parts.port is None:
            return parts
    except ValueError:
        pass
    return None


def retailer_listing_url(value: object) -> tuple[str, str] | None:
    parts = _https(value)
    if parts is None:
        return None
    host = (parts.hostname or "").removeprefix("www.")
    entry = _RETAILERS.get(host)
    if not entry or not re.fullmatch(entry[1], parts.path, re.I) or _RESTRICTED.search(parts.path):
        return None
    # Preserve edition selection on booksellers. Strip every other query,
    # including affiliate IDs, session data and redirects.
    ean = ""
    if host in {"bookshop.org", "barnesandnoble.com"}:
        editions = [val for key, val in parse_qsl(parts.query) if key == "ean"]
        if editions:
            if len(editions) != 1 or not re.fullmatch(r"[0-9]{13}", editions[0]):
                return None
            ean = "ean=" + editions[0]
    return urlunsplit(("https", parts.hostname, parts.path, ean, "")), entry[0]


def _listing_key(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    host = (parts.hostname or "").removeprefix("www.")
    path = parts.path.rstrip("/")
    # These retailer IDs define their product path; cosmetic slugs and
    # alternate path forms can differ between the search hit and the offer.
    if host.startswith(("amazon.", "walmart.")) or host == "target.com":
        path = path.rsplit("/", 1)[-1].upper()
    return host, path


def _product_image(value: Any, page: str) -> str | None:
    if isinstance(value, dict):
        value = value.get("contentUrl") or value.get("url")
    if not isinstance(value, str):
        return None
    parts = _https(urljoin(page, value))
    if parts is None or parts.fragment:
        return None
    # Barnes & Noble's public listing may point to its Shopify asset directory.
    official_bn_image = (
        _listing_key(page)[0] == "barnesandnoble.com"
        and parts.hostname == "cdn.shopify.com"
        and parts.path.startswith("/s/files/1/0674/5433/7265/files/")
    )
    if parts.hostname not in _IMAGE_HOSTS and not official_bn_image:
        return None
    if re.search(r"(?:^|[/_.-])(?:logo|favicon|avatar|placeholder)(?:[/_.-]|$)", parts.path, re.I):
        return None
    if any(re.search(r"token|password|signature|api[_-]?key|authorization", key, re.I)
           for key, _ in parse_qsl(parts.query)):
        return None
    return urlunsplit(parts)


class _ListingMarkup(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self.tags: dict[str, str] = {}
        self._in_json = False
        self._size = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "script" and (attributes.get("type") or "").strip().lower() == "application/ld+json":
            self._in_json = True
            self._parts = []
            self._size = 0
        elif tag == "meta":
            key = (attributes.get("property") or "").lower()
            if key in {"og:type", "og:title", "og:image", "product:price:amount", "product:price:currency", "product:availability"}:
                self.tags.setdefault(key, attributes.get("content") or "")

    def handle_data(self, data):
        if self._in_json:
            self._size += len(data)
            if self._size <= 400_000:
                self._parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._in_json:
            if len(self.blocks) < 20 and self._size <= 400_000:
                self.blocks.append("".join(self._parts))
            self._in_json = False


def _types(node: dict) -> set[str]:
    value = node.get("@type")
    names = value if isinstance(value, list) else [value]
    return {item.rstrip("/").rsplit("/", 1)[-1] for item in names if isinstance(item, str)}


def _graph(value: object, depth: int = 0):
    """Only top-level JSON-LD and named graph containers, never accessories."""
    if depth > 4:
        return
    if isinstance(value, list):
        for row in value[:40]:
            yield from _graph(row, depth + 1)
    elif isinstance(value, dict):
        yield value
        for key in ("@graph", "mainEntity"):
            if key in value:
                yield from _graph(value[key], depth + 1)


def _price(value: object, currency: object) -> tuple[str, str] | None:
    if not isinstance(currency, str) or currency not in _CURRENCIES or isinstance(value, bool):
        return None
    if not isinstance(value, (str, int, float, Decimal)):
        return None
    source = str(value)
    if not re.fullmatch(r"\d{1,7}(?:\.\d{1,4})?", source):
        return None
    try:
        amount = Decimal(source)
    except InvalidOperation:
        return None
    return (format(amount, "f"), currency) if amount > 0 else None


def _availability(value: object) -> str:
    code = str(value or "").rstrip("/").rsplit("/", 1)[-1].lower().replace(" ", "")
    if code in _IN_STOCK:
        return "in_stock"
    return "out_of_stock" if code in _OUT_OF_STOCK else "unknown"


def _valid_gtin(value: object) -> str | None:
    digits = re.sub(r"[- ]", "", str(value or ""))
    if len(digits) not in {8, 12, 13, 14} or not digits.isascii() or not digits.isdigit() or not digits.strip("0"):
        return None
    total = sum(int(ch) * (3 if i % 2 else 1) for i, ch in enumerate(reversed(digits)))
    return digits if total % 10 == 0 else None


def _product_identifier(product: dict, title: str, edition: str = "") -> str | None:
    ids = [product.get(key) for key in ("gtin14", "gtin13", "gtin12", "gtin8", "gtin", "isbn")]
    if edition:
        ids.append(edition)
    for raw in ids:
        if digits := _valid_gtin(raw):
            return "gtin:" + digits.zfill(14)
    brand = product.get("brand")
    label = _clean_text(brand.get("name") if isinstance(brand, dict) else brand, 60)
    mpn = _clean_text(product.get("mpn"), 64)
    if label and mpn and title:
        # Exact name in addition to MPN keeps pack counts and variants apart.
        return "mpn:" + "|".join((label, mpn, title)).casefold()
    return None


def _shopping_query(text: str) -> str:
    # Recognized item codes are public identifiers needed to find an exact
    # edition. Keep the usual redactor for every other identifying number.
    known_ids: dict[str, str] = {}

    def replace(match: re.Match) -> str:
        digits = _valid_gtin(match.group(1) or match.group(2))
        if not digits:
            return match.group(0)
        key = f"PublicRetailCode{len(known_ids)}"
        known_ids[key] = digits
        return key

    query = redact_conversation_text(_PUBLIC_ITEM_ID.sub(replace, text), 220)
    for key, digits in known_ids.items():
        query = query.replace(key, digits)
    return query


def _listing_offer(product: dict, page: str, today: date) -> tuple[str, str, str, str, str] | None:
    offers = product.get("offers")
    candidates = offers if isinstance(offers, list) else [offers]
    found = []
    requested_edition = dict(parse_qsl(urlsplit(page).query)).get("ean", "")
    for row in candidates[:20]:
        if not isinstance(row, dict) or "Offer" not in _types(row):
            continue
        offer_page = page
        if row.get("url"):
            target = retailer_listing_url(urljoin(page, str(row["url"])))
            if not target or _listing_key(target[0]) != _listing_key(page):
                continue
            offer_edition = dict(parse_qsl(urlsplit(target[0]).query)).get("ean", "")
            if requested_edition and offer_edition != requested_edition:
                continue
            offer_page = target[0]
        elif requested_edition and _product_identifier(product, "") != "gtin:" + requested_edition.zfill(14):
            continue
        expiry = row.get("priceValidUntil")
        if expiry is not None:
            try:
                if not isinstance(expiry, str) or date.fromisoformat(expiry[:10]) < today:
                    continue
            except ValueError:
                continue
        price = _price(row.get("price"), row.get("priceCurrency"))
        if not price:
            continue
        availability = _availability(row.get("availability"))
        condition_value = str(row.get("itemCondition") or "").rstrip("/").rsplit("/", 1)[-1]
        if condition_value and condition_value != "NewCondition":
            continue
        found.append((*price, availability, condition_value, offer_page))
    unique = list(dict.fromkeys(found))
    # Variant and marketplace aggregate prices can be a different package or
    # membership offer. Do not pick one silently when the page has several.
    return unique[0] if len(unique) == 1 else None


def retailer_listing_data(html: str, canonical: str, *, now: datetime) -> dict[str, Any] | None:
    parser = _ListingMarkup()
    try:
        parser.feed(html)
        products = []
        for block in parser.blocks:
            try:
                products.extend(row for row in _graph(json.loads(block)) if "Product" in _types(row))
            except (ValueError, RecursionError):
                continue
    except (ValueError, RecursionError):
        return None
    public = []
    for product in products:
        if product.get("url"):
            target = retailer_listing_url(urljoin(canonical, str(product["url"])))
            if not target or _listing_key(target[0]) != _listing_key(canonical):
                continue
        title = _clean_text(product.get("name"), 180)
        if not title:
            continue
        description = _clean_text(product.get("description"), 300)
        if _RESTRICTED.search(title) or _RESTRICTED.search(description):
            return {"_restricted": True}
        value = product.get("image")
        images = value if isinstance(value, list) else [value]
        media = next((valid for image in images[:8] if (valid := _product_image(image, canonical))), None)
        parsed_offer = _listing_offer(product, canonical, now.date())
        amount, currency, availability, condition, offer_page = parsed_offer or (None, None, "unknown", "", canonical)
        edition = dict(parse_qsl(urlsplit(offer_page).query)).get("ean", "") if parsed_offer else ""
        public.append({
            "title": title, "image_url": media,
            "price_amount": amount, "currency": currency, "availability": availability,
            "_identity": _product_identifier(product, title, edition), "_condition": condition,
            "_offer_url": offer_page,
        })
    unique = [row for index, row in enumerate(public) if row not in public[:index]]
    if len(unique) == 1:
        return unique[0]
    tags = parser.tags
    if unique or products or tags.get("og:type", "").lower() != "product":
        return None
    title = _clean_text(tags.get("og:title"), 180)
    if not title:
        return None
    if _RESTRICTED.search(title):
        return {"_restricted": True}
    amount, currency = _price(tags.get("product:price:amount"), tags.get("product:price:currency")) or (None, None)
    return {
        "title": title, "image_url": _product_image(tags.get("og:image"), canonical),
        "price_amount": amount, "currency": currency, "availability": _availability(tags.get("product:availability")),
        "_identity": None, "_condition": "",
    }


async def _read_listing_page(client: httpx.AsyncClient, page: str, *,
                             exact: bool = False) -> tuple[str, str | None] | None:
    """Return an empty body marker for a confirmed removed listing."""
    wanted = (*_listing_key(page), urlsplit(page).query) if exact else None
    active = page
    for _ in range(3):
        valid = retailer_listing_url(active)
        if not valid:
            return None
        try:
            async with client.stream("GET", valid[0]) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    redirect = retailer_listing_url(urljoin(active, response.headers.get("location", "")))
                    if not redirect or redirect[1] != valid[1] or redirect[0] == valid[0]:
                        return None
                    if wanted and (*_listing_key(redirect[0]), urlsplit(redirect[0]).query) != wanted:
                        return None
                    active = redirect[0]
                    continue
                if response.status_code in {404, 410}:
                    return valid[0], None
                if response.status_code != 200 or "text/html" not in response.headers.get("content-type", "").lower():
                    return None
                chunked = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=16_384):
                    if len(chunked) + len(chunk) > _PAGE_LIMIT:
                        break
                    chunked.extend(chunk)
                return valid[0], chunked.decode(response.encoding or "utf-8", errors="replace")
        except (httpx.HTTPError, LookupError):
            return None
    return None


async def _page_markup(client: httpx.AsyncClient, page: str) -> tuple[str, str] | None:
    result = await _read_listing_page(client, page)
    return (result[0], result[1]) if result is not None and result[1] is not None else None


def _pick_search_hits(results: list[SearchResult]) -> list[tuple[SearchResult, str, str]]:
    first_by_retailer: dict[str, list[tuple[SearchResult, str, str]]] = {}
    seen = set()
    for item in results:
        checked = retailer_listing_url(item.url)
        if not checked or _RESTRICTED.search(item.title) or _RESTRICTED.search(item.snippet):
            continue
        url, retailer = checked
        if url in seen:
            continue
        seen.add(url)
        first_by_retailer.setdefault(retailer, []).append((item, url, retailer))
    first = [items[0] for items in first_by_retailer.values()]
    second = [items[1] for items in first_by_retailer.values() if len(items) > 1]
    return (first + second)[:_MAX_OFFERS]


def _best_offer(rows: list[dict]) -> str | None:
    by_item: dict[tuple[str, str, str], list[dict]] = {}
    for row in rows:
        if row.get("_identity") and row.get("currency") and row.get("price_amount") and row["availability"] == "in_stock":
            key = (row["_identity"], row["currency"], row["_condition"])
            by_item.setdefault(key, []).append(row)
    pairs = [group for group in by_item.values() if len({row["retailer"] for row in group}) >= 2]
    if not pairs:
        return None
    # Search relevance picks the first comparable product group. Do not
    # compare its total price with another product, package, or currency.
    return min(pairs[0], key=lambda row: Decimal(row["price_amount"]))["url"]


_REPLIES = {
    "en": {
        "ready": "I found these retailer listings. Check the store for current availability, shipping and tax.",
        "links_only": "I found retailer listings, but their current prices could not be verified. Open a store below to check.",
        "no_results": "I couldn’t find a verified retailer listing. Try the product’s full name, model, or pack size.",
        "unavailable": "Shopping lookup is temporarily unavailable. Please try again shortly.",
        "restricted": "I can compare retail listings for everyday products and named over-the-counter items. Ask a pharmacist or prescriber about prescription medicines.",
        "private": "Send only the product name, model, or pack size so I can search retailer listings.",
    },
    "zh-CN": {
        "ready": "我找到了这些商家的商品页面。库存、运费和税费请以商家页面为准。",
        "links_only": "我找到了商家页面，但没能核实当前售价。可以打开下方商品链接查看。",
        "no_results": "我没找到可核实的商品页面。可以发给我完整商品名、型号或包装规格。",
        "unavailable": "商品查询暂时不可用，请稍后再试。",
        "restricted": "我可以比较日用品和指定非处方商品的零售页面。有关处方药，请咨询药师或开药的医生。",
        "private": "请只发商品名、型号或包装规格，我可以据此查询商家。",
    },
    "zh-TW": {
        "ready": "我找到了這些商家的商品頁面。庫存、運費和稅費請以商家頁面為準。",
        "links_only": "我找到了商家頁面，但未能核實目前售價。可以打開下方商品連結查看。",
        "no_results": "我沒找到可核實的商品頁面。可以傳給我完整商品名、型號或包裝規格。",
        "unavailable": "商品查詢暫時無法使用，請稍後再試。",
        "restricted": "我可以比較日用品和指定非處方商品的零售頁面。關於處方藥，請諮詢藥師或開藥的醫師。",
        "private": "請只傳商品名、型號或包裝規格，我可以據此查詢商家。",
    },
}


def product_lookup_reply(status: str, locale: str) -> str:
    return _REPLIES.get(locale, _REPLIES["en"])[status]


def _lookup(status: str, locale: str, now: datetime, offers: list[dict] | None = None,
            *, is_medication: bool = False) -> ProductLookup:
    rows = offers or []
    return ProductLookup(product_lookup_reply(status, locale), {
        "kind": "product_comparison",
        "status": status,
        "checked_at": now.isoformat(),
        "offers": [{key: value for key, value in offer.items() if not key.startswith("_")} for offer in rows],
        "best_price_url": _best_offer(rows),
        "is_medication": is_medication,
    })


async def lookup_product_comparison(text: str, locale: str, *, provider: SearchProvider | None = None,
                                    client: httpx.AsyncClient | None = None,
                                    now: datetime | None = None) -> ProductLookup | None:
    if not is_product_request(text):
        return None
    checked_at = now or datetime.now(timezone.utc)
    query = _shopping_query(text)
    if _PRIVATE_MARKER.search(query) or _PRIVATE_CONTEXT.search(query):
        return _lookup("private", locale, checked_at)
    if _RESTRICTED.search(query):
        return _lookup("restricted", locale, checked_at)
    medication = bool(_MEDICATION.search(query))
    search = provider if provider is not None else get_provider()
    if search.name in {"null", "stub"}:
        return _lookup("unavailable", locale, checked_at, is_medication=medication)
    try:
        results = await asyncio.wait_for(search.search(SearchRequest(
            query=query, lang="zh" if locale.startswith("zh") else "en",
            include_domains=tuple(_RETAILERS), max_results=16,
            include_images=True,
        )), timeout=6.0)
    except (TimeoutError, httpx.HTTPError):
        return _lookup("unavailable", locale, checked_at, is_medication=medication)
    candidates = _pick_search_hits(results)
    if not candidates:
        return _lookup("no_results", locale, checked_at, is_medication=medication)

    async def inspect(http: httpx.AsyncClient):
        async def item_result(item: SearchResult, url: str, retailer: str):
            try:
                outcome = await asyncio.wait_for(_page_markup(http, url), timeout=4.0)
            except TimeoutError:
                outcome = None
            canonical, markup = outcome or (url, "")
            data = retailer_listing_data(markup, canonical, now=checked_at) if markup else None
            if data and data.get("_restricted"):
                return None
            if data is None:
                # A trusted listing URL can still be useful when the page has
                # no machine-readable offer or declines automated access.
                title = _clean_text(item.title, 180)
                if not title or _RESTRICTED.search(title):
                    return None
                data = {"title": title, "price_amount": None, "currency": None, "availability": "unknown",
                        "image_url": None, "_identity": None, "_condition": ""}
            if not data["image_url"]:
                data["image_url"] = next((safe for image in item.images[:8]
                                          if (safe := _product_image(image.url, canonical))), None)
            return {**data, "url": data.get("_offer_url", canonical), "retailer": retailer}

        return await asyncio.gather(*(item_result(*item) for item in candidates))

    if client is None:
        async with httpx.AsyncClient(timeout=3.5, follow_redirects=False, trust_env=False,
                                     limits=httpx.Limits(max_connections=_MAX_OFFERS),
                                     headers={"Accept": "text/html"}) as http:
            resolved = await inspect(http)
    else:
        resolved = await inspect(client)
    rows = list({offer["url"]: offer for offer in resolved if offer is not None}.values())
    status = "ready" if any(offer["price_amount"] for offer in rows) else "links_only" if rows else "no_results"
    return _lookup(status, locale, checked_at, rows, is_medication=medication)
