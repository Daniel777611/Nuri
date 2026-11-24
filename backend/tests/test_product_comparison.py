"""Retail evidence, privacy boundaries and variant-safe price comparisons."""

import asyncio
import json
from datetime import datetime, timezone

import httpx

from backend.product_comparison import is_product_request, lookup_product_comparison, retailer_listing_url
from backend.websearch import SearchImage, SearchResult

WALMART = "https://www.walmart.com/ip/Example-Board-Book/1234567"
AMAZON = "https://www.amazon.com/dp/B000000001"
TARGET = "https://www.target.com/p/example-board-book/-/A-123456"
WALMART_IMAGE = "https://i5.walmartimages.com/asr/example-book.jpg"
NOW = datetime(2026, 11, 22, 12, tzinfo=timezone.utc)
GTIN = "9780140502411"
OTHER_GTIN = "9780140502428"


class FixtureSearch:
    name = "fixture"

    def __init__(self, rows):
        self.rows = rows
        self.requests = []

    async def search(self, request):
        self.requests.append(request)
        return self.rows


def product_page(price, *, gtin=GTIN, currency="USD", availability="InStock", until=None):
    offer = {
        "@type": "Offer", "price": price, "priceCurrency": currency,
        "itemCondition": "https://schema.org/NewCondition",
        "availability": "https://schema.org/" + availability,
    }
    if until is not None:
        offer["priceValidUntil"] = until
    structured = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Example Board Book",
        "gtin13": gtin,
        "image": [WALMART_IMAGE],
        "offers": offer,
    }
    markup = '<script type="application/ld+json">' + json.dumps(structured) + "</script>"
    return httpx.Response(200, headers={"Content-Type": "text/html"}, text=markup)


def lookup(rows, load_page, text="Compare prices for Example Board Book", locale="en"):
    vendor = FixtureSearch(rows)
    visited = []

    def handle(request):
        url = str(request.url)
        visited.append(url)
        return load_page(url)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle), follow_redirects=False) as client:
            return await lookup_product_comparison(text, locale, provider=vendor, client=client, now=NOW)

    return asyncio.run(run()), vendor.requests, visited


def hit(url, title="Example Board Book", snippet="", images=()):
    return SearchResult(title, url, snippet=snippet, images=images)


def test_price_comparison_checks_current_retail_pages_and_only_chooses_same_item():
    rows = [hit(WALMART + "?affp1=tracking"), hit(AMAZON), hit(TARGET)]
    pages = {WALMART: product_page("12.99"), AMAZON: product_page("15.00"),
             TARGET: product_page("5.99", gtin=OTHER_GTIN)}
    result, queries, visits = lookup(rows, pages.__getitem__)
    card = result.transition
    assert card["kind"] == "product_comparison"
    assert card["checked_at"] == NOW.isoformat()
    assert card["best_price_url"] == WALMART
    assert set(visits) == set(pages)
    assert len(queries) == 1
    assert {"walmart.com", "amazon.com", "target.com", "bookshop.org"} <= set(queries[0].include_domains)
    assert [(row["price_amount"], row["currency"]) for row in card["offers"]] == [
        ("12.99", "USD"), ("15.00", "USD"), ("5.99", "USD"),
    ]
    assert all(row["image_url"] == WALMART_IMAGE for row in card["offers"])
    assert all(not any(key.startswith("_") for key in row) for row in card["offers"])


def test_checkout_amount_does_not_compare_currencies_or_out_of_stock_items():
    pages = {
        WALMART: product_page("12.99"),
        AMAZON: product_page("9.50", currency="CAD"),
        TARGET: product_page("7.99", availability="OutOfStock"),
    }
    result, _, _ = lookup([hit(WALMART), hit(AMAZON), hit(TARGET)], pages.__getitem__)
    assert result.transition["best_price_url"] is None
    assert result.transition["offers"][2]["availability"] == "out_of_stock"


def test_stale_snippet_and_blocked_retailer_do_not_create_a_price():
    search_image = SearchImage(WALMART_IMAGE)
    result, _, _ = lookup(
        [hit(WALMART, snippet="As low as $8.97 today", images=(search_image,)), hit(AMAZON, snippet="$1.99")],
        lambda url: product_page("20.99", until="2026-11-21") if url == WALMART else httpx.Response(403),
        text="查一下 Example Board Book 多少钱", locale="zh-CN",
    )
    assert result.transition["status"] == "links_only"
    assert result.transition["best_price_url"] is None
    assert all(offer["price_amount"] is None for offer in result.transition["offers"])
    assert result.transition["offers"][0]["image_url"] == WALMART_IMAGE
    assert "核实" in result.reply


def test_removed_listing_does_not_get_promoted_by_its_search_result():
    result, _, visits = lookup(
        [hit(WALMART, images=(SearchImage(WALMART_IMAGE),)), hit(AMAZON)],
        lambda url: httpx.Response(410) if url == WALMART else product_page("15.00"),
    )
    assert set(visits) == {WALMART, AMAZON}
    assert [row["url"] for row in result.transition["offers"]] == [AMAZON]


def test_search_results_cannot_fetch_untrusted_hosts_or_follow_non_product_redirects():
    rows = [
        hit("https://www.walmart.com.evil.example/ip/1234567"),
        hit("http://www.walmart.com/ip/1234567"),
        hit("https://www.amazon.com/gp/redirect"),
        hit("https://account:secret@www.amazon.com/dp/B000000001"),
        hit(WALMART),
    ]
    result, _, visits = lookup(rows, lambda _: httpx.Response(
        302, headers={"Location": "https://127.0.0.1/private"},
    ))
    assert visits == [WALMART]
    assert result.transition["status"] == "links_only"
    assert result.transition["offers"][0]["url"] == WALMART


def test_direct_book_links_keep_the_exact_edition_and_drop_affiliate_data():
    book = "https://bookshop.org/p/books/example-board-book/74cd8c1f531192bc"
    result = retailer_listing_url(book + "?aid=123&ean=9780399226908&listref=private")
    assert result == (book + "?ean=9780399226908", "Bookshop.org")
    assert retailer_listing_url(book + "?ean=incorrect") is None


def test_public_isbn_reaches_search_while_unlabeled_personal_numbers_do_not():
    _, queries, _ = lookup([], lambda _: httpx.Response(500), text="Buy The Very Hungry Caterpillar board book 9780399226908")
    assert len(queries) == 1 and "9780399226908" in queries[0].query
    result, queries, _ = lookup([], lambda _: httpx.Response(500), text="Buy a book for account 1112233334444")
    assert not queries and result.transition["status"] == "private"


def test_private_and_prescription_queries_send_nothing_to_vendor():
    for text, status in [
        ("Buy Example Book for name@example.com", "private"),
        ("Where can I buy amoxicillin?", "restricted"),
        ("帮我买阿莫西林", "restricted"),
    ]:
        result, queries, visits = lookup([], lambda _: httpx.Response(500), text=text)
        assert result.transition["status"] == status
        assert not queries and not visits


def test_restricted_listing_never_falls_back_to_a_clickable_search_result():
    page = '<script type="application/ld+json">' + json.dumps({
        "@type": "Product", "name": "Ordinary listing title",
        "description": "This is a prescription-only medicine",
    }) + "</script>"
    result, _, visits = lookup(
        [hit(WALMART, title="Ordinary listing title")],
        lambda _: httpx.Response(200, headers={"Content-Type": "text/html"}, text=page),
    )
    assert visits == [WALMART]
    assert result.transition["offers"] == []


def test_regular_chat_and_treatment_questions_do_not_trigger_shopping():
    assert is_product_request("推荐几本适合两岁的绘本")
    assert is_product_request("Where can I buy Tylenol 24 tablets?")
    assert not is_product_request("What is the usual dosage of Tylenol?")
    assert not is_product_request("Where can I buy medicine for my child's cough?")
    assert not is_product_request("What did we discuss yesterday?")
    result, queries, visits = lookup([], lambda _: httpx.Response(500), text="Can my child take ibuprofen?")
    assert result is None and not queries and not visits
