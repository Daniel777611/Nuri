"""Broad shopping requests attach retailer media without replacing the chat reply."""

import asyncio
import json
from datetime import datetime, timezone

import httpx

from backend.product_recommendations import exact_catalog_request, recommendation_transition, requested_recommendations
from backend.websearch import SearchImage, SearchResult


PRIOR_REPLY = ("给 13 个月的宝宝推荐：绘本：Brown Bear, Brown Bear；Dear Zoo；"
               "Where’ s Spot?；Goodnight Moon。玩具：动物模型、积木、球、车车、假装电话。")
FOLLOW_UP = "我要你推荐绘本和玩具的时候就是要图和链接的。"


def earlier_reply(text=PRIOR_REPLY):
    return [{"role": "ai", "text": text}, {"role": "user", "text": FOLLOW_UP}]


def resolve(text, history=(), reply="", load=None, *, children=None, provider=None):
    requests = []

    def handle(request):
        requests.append(str(request.url))
        body_type = "image/jpeg" if request.headers["accept"] == "image/*" else "text/html"
        result = load(request) if load else 200
        if isinstance(result, httpx.Response):
            return result
        return httpx.Response(result, headers={"Content-Type": body_type})

    async def run():
        request = requested_recommendations(text, list(history), children=children)
        assert request is not None
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            return await recommendation_transition(request, reply, client=client, provider=provider)

    return asyncio.run(run()), requests


def test_screenshot_followup_returns_covers_and_real_store_links_for_book_and_toy_recommendations():
    cards, calls = resolve(FOLLOW_UP, earlier_reply(), "可以直接点开下方的卡片。")
    assert cards["kind"] == "product_comparison"
    assert cards["status"] == "links_only" and cards["best_price_url"] is None
    assert [offer["title"] for offer in cards["offers"][:4]] == [
        "Brown Bear, Brown Bear, What Do You See?", "Dear Zoo", "Where’s Spot?", "Goodnight Moon",
    ]
    assert any("Animal Stacking Cars" in row["title"] for row in cards["offers"][4:])
    assert any("Chatter Telephone" in row["title"] for row in cards["offers"][4:])
    assert all(row["price_amount"] is None and row["availability"] == "unknown" for row in cards["offers"])
    assert {url for row in cards["offers"] for url in (row["url"], row["image_url"])} == set(calls)


def test_first_recommendation_prioritizes_suggested_title_and_does_not_send_private_chat():
    cards, calls = resolve("可以推荐绘本给小九吗？邮箱 secret@example.com。", reply="我会先读 Goodnight Moon。")
    assert cards["offers"][0]["title"] == "Goodnight Moon"
    assert not any("小九" in url or "secret" in url or "%40" in url for url in calls)


def test_bounded_followup_does_not_take_an_unrelated_media_or_exact_checkout_request():
    history = earlier_reply()
    assert requested_recommendations("把刚才这些的图和链接也发给我", history).categories == ("books", "toys")
    assert requested_recommendations("能把上面的文章链接给我吗？", history) is None
    assert requested_recommendations("推荐几个玩具的使用视频", history) is None
    assert requested_recommendations("发 Dear Zoo 的图和链接", []).categories == ("books",)
    assert requested_recommendations("发 Dear Zoo 的图、链接和价格", []).categories == ("books",)
    assert requested_recommendations("把刚才的价格也发一下", history).categories == ("books", "toys")
    assert requested_recommendations("推荐绘本和玩具，带图片、链接和价格", []).categories == ("books", "toys")
    assert requested_recommendations("Dear Zoo 绘本多少钱？", history) is None
    assert requested_recommendations("Buy Dear Zoo board book 9781416947370", history) is None
    assert requested_recommendations("推荐绘本和玩具之前，宝宝阿莫西林用量？", history) is None
    assert requested_recommendations("昨天提到哪些故事？", history) is None


def product_markup(url, title, price, currency, *, isbn=None, expires=None, image=None):
    offer = {
        "@type": "Offer", "price": price, "priceCurrency": currency,
        "availability": "https://schema.org/InStock", "url": url,
    }
    if expires:
        offer["priceValidUntil"] = expires
    product = {"@type": "Product", "name": title, "offers": offer}
    if isbn:
        product["gtin13"] = isbn
    if image:
        product["image"] = image
    html = '<script type="application/ld+json">' + json.dumps(product) + "</script>"
    return httpx.Response(200, headers={"Content-Type": "text/html"}, text=html)


def test_product_followup_recovers_the_subject_when_the_reply_only_describes_cards():
    history = [
        {"role": "user", "text": "推荐 Dear Zoo 绘本，想给 13 个月宝宝看。"},
        {"role": "ai", "text": "我找到了这些商家的商品页面。", "transition": {"kind": "product_comparison"}},
    ]
    cards, _ = resolve("这些多少钱？", history)
    assert [offer["title"] for offer in cards["offers"]] == ["Dear Zoo"]


def test_live_recommendation_prices_use_exact_products_and_current_timestamp():
    def load(request):
        if request.headers["accept"] == "image/*":
            return 200
        if "9781416947370" in str(request.url):
            return product_markup(str(request.url), "Dear Zoo", "7.99", "USD", isbn="9781416947370")
        if "70513884" in str(request.url):
            return product_markup(str(request.url), "Stack & Nest Cups", "2.99", "USD")
        return 200

    before = datetime.now(timezone.utc)
    history = earlier_reply("推荐绘本 Dear Zoo 和玩具叠叠杯。")
    cards, _ = resolve("把刚才这些的价格、图和链接发给我", history, load=load)
    assert cards["status"] == "ready" and cards["best_price_url"] is None
    assert datetime.fromisoformat(cards["checked_at"]) >= before
    assert [(offer["price_amount"], offer["currency"], offer["availability"]) for offer in cards["offers"]] == [
        ("7.99", "USD", "in_stock"), ("2.99", "USD", "in_stock"),
    ]


def test_expired_or_wrong_edition_prices_keep_the_picture_and_link():
    def load(request):
        if request.headers["accept"] == "image/*":
            return 200
        if "9781416947370" in str(request.url):
            return product_markup(str(request.url), "Dear Zoo", "7.99", "USD", isbn="9781416947370", expires="2000-01-01")
        if "9780805047905" in str(request.url):
            return httpx.Response(302, headers={"Location": str(request.url).replace("9780805047905", "9780805017441")})
        return 200

    history = earlier_reply("推荐绘本 Dear Zoo 和 Brown Bear。")
    cards, calls = resolve("把刚才这些的图和链接发给我", history, load=load)
    assert cards["status"] == "links_only"
    assert len(cards["offers"]) == 2
    assert all(row["image_url"] and row["price_amount"] is None for row in cards["offers"])
    assert not any("9780805017441" in url for url in calls)


def test_age_filters_toy_options_and_definitely_unavailable_pages_are_dropped():
    cards, _ = resolve("给 7 个月宝宝推荐玩具", load=lambda request: 404 if "70513884" in str(request.url) else 200)
    assert [offer["title"] for offer in cards["offers"]] == ["Fisher-Price Chatter Telephone"]


def test_access_limit_keeps_previously_verified_image_and_url_without_current_price_or_stock():
    cards, _ = resolve("给 13 个月宝宝推荐绘本", load=lambda _: 429)
    assert cards["status"] == "links_only"
    assert cards["checked_at"].startswith("2026-11-23")
    assert all(offer["image_url"] and offer["price_amount"] is None for offer in cards["offers"])
    missing, _ = resolve("给 13 个月宝宝推荐绘本", load=lambda _: 410)
    assert missing is None


def test_searches_a_non_us_store_for_older_children_without_sharing_the_conversation():
    calls = []
    product = "https://www.amazon.co.uk/dp/0746069952"
    image = "https://m.media-amazon.com/images/I/cover.jpg"

    class Provider:
        name = "test"

        async def search(self, query):
            calls.append(query)
            return [SearchResult("Story collection", product),
                    SearchResult("Wrong storefront", "https://www.amazon.com/dp/0746069952")]

    def handle(request):
        if str(request.url) == image:
            return httpx.Response(200, headers={"Content-Type": "image/jpeg"})
        assert str(request.url) == product
        return product_markup(product, "Story collection", "12.99", "GBP", image=image)

    async def run():
        request = requested_recommendations("给 8 岁孩子推荐绘本。叫她小九，英国买。", [])
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            return await recommendation_transition(request, "", client=client, provider=Provider())

    cards = asyncio.run(run())
    assert calls[0].query == "children's picture books 6-8 years"
    assert calls[0].include_domains == ("amazon.co.uk",)
    assert [(row["url"], row["image_url"]) for row in cards["offers"]] == [(product, image)]
    assert [(row["price_amount"], row["currency"]) for row in cards["offers"]] == [("12.99", "GBP")]


def test_named_catalog_book_and_explicit_toy_both_survive_one_request():
    request = requested_recommendations("给我 Dear Zoo 和叠叠杯玩具的图、链接和价格", [])
    assert set(request.categories) == {"books", "toys"}


def test_short_product_link_follow_up_does_not_steal_video_link():
    assert requested_recommendations("那你给我的链接在哪里呢?", earlier_reply()).categories == ("books", "toys")
    history = earlier_reply("可以找这些玩具收纳的 YouTube 视频。")
    assert requested_recommendations("那你给我的链接在哪里呢?", history) is None


def test_exact_catalog_price_fallback_never_substitutes_another_book():
    request = exact_catalog_request("Dear Zoo 绘本多少钱？")
    calls = []

    def load(page):
        calls.append(str(page.url))
        return httpx.Response(410, headers={"Content-Type": "text/html"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(load)) as client:
            return await recommendation_transition(request, "", locale="zh-CN", client=client)

    assert asyncio.run(run()) is None
    assert len(calls) == 2 and all("9781416947370" in url for url in calls)


def test_natural_first_turn_attaches_age_appropriate_products_without_llm_reply(monkeypatch):
    monkeypatch.setattr("backend.alpha_milestones.age_in_months", lambda _: 7)
    cards, urls = resolve("给我几款适合小九的玩具", children=[{"nickname": "小九", "birth_date": "2026-05-22"}])
    assert {row["title"] for row in cards["offers"]} == {"Fisher-Price Chatter Telephone", "IKEA UPPSTÅ Stack & Nest Cups"}
    assert all(row["image_url"] and row["url"] for row in cards["offers"])
    assert all("小九" not in url and "2026-05-22" not in url for url in urls)
    assert requested_recommendations("I need a stroller", []).categories == ("strollers",)
    assert requested_recommendations("宝宝安全座椅有哪些推荐？", []).categories == ("car_seats",)
    assert requested_recommendations("给我几个推荐安全座椅安装的影片", []) is None


def test_discovery_preserves_exact_search_photo_when_merchant_blocks_page_and_drops_irrelevant_hits():
    product = "https://www.amazon.com/dp/B000000003"
    image = "https://m.media-amazon.com/images/I/stroller.jpg"
    redirected_image = "https://m.media-amazon.com/images/I/redirected.jpg"
    queries = []

    class Provider:
        name = "fixture"

        async def search(self, query):
            queries.append(query)
            return [
                SearchResult("New picture book", "https://www.amazon.com/dp/B000000001"),
                SearchResult("Toy train", "https://www.amazon.com/dp/B000000002"),
                SearchResult("Compact travel stroller", product, snippet="Sale $49.99",
                             images=(SearchImage(redirected_image), SearchImage(image))),
                SearchResult("Wrong storefront stroller", "https://www.amazon.co.uk/dp/B000000003"),
            ]

    def load(request):
        if str(request.url) == redirected_image:
            return httpx.Response(302, headers={"Location": "https://unverified.example/photo"})
        if str(request.url) == image:
            return 200
        return 403

    cards, fetched = resolve("给 13 个月宝宝挑几款 Amazon 婴儿推车", load=load, provider=Provider())
    assert len(queries) == 1
    assert queries[0].query == "baby strollers 12-24 months"
    assert queries[0].include_domains == ("amazon.com",)
    assert queries[0].include_images
    assert set(fetched) == {product, image, redirected_image}
    assert cards["status"] == "links_only"
    assert [(row["url"], row["image_url"], row["price_amount"]) for row in cards["offers"]] == [(product, image, None)]


def test_specific_title_in_another_market_does_not_substitute_an_unrelated_listing():
    queries = []

    class Provider:
        name = "fixture"

        async def search(self, query):
            queries.append(query)
            return [SearchResult("Other board book", "https://www.amazon.co.uk/dp/B000000001")]

    cards, urls = resolve("发 Dear Zoo 英国 Amazon 的图和链接", provider=Provider())
    assert [query.query for query in queries] == ["Dear Zoo"]
    assert queries[0].include_domains == ("amazon.co.uk",)
    assert cards is None and urls == []
