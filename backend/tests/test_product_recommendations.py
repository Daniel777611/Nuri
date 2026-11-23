"""Broad shopping requests attach retailer media without replacing the chat reply."""

import asyncio

import httpx

from backend.product_recommendations import recommendation_transition, requested_recommendations
from backend.websearch import SearchResult


PRIOR_REPLY = ("给 13 个月的宝宝推荐：绘本：Brown Bear, Brown Bear；Dear Zoo；"
               "Where’ s Spot?；Goodnight Moon。玩具：动物模型、积木、球、车车、假装电话。")
FOLLOW_UP = "我要你推荐绘本和玩具的时候就是要图和链接的。"


def earlier_reply(text=PRIOR_REPLY):
    return [{"role": "ai", "text": text}, {"role": "user", "text": FOLLOW_UP}]


def resolve(text, history=(), reply="", load=None):
    requests = []

    def handle(request):
        requests.append(str(request.url))
        body_type = "image/jpeg" if request.headers["accept"] == "image/*" else "text/html"
        status = load(request) if load else 200
        return httpx.Response(status, headers={"Content-Type": body_type})

    async def run():
        request = requested_recommendations(text, list(history))
        assert request is not None
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            return await recommendation_transition(request, reply, client=client)

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
    assert requested_recommendations("Dear Zoo 绘本多少钱？", history) is None
    assert requested_recommendations("Buy Dear Zoo board book 9781416947370", history) is None
    assert requested_recommendations("推荐绘本和玩具之前，宝宝阿莫西林用量？", history) is None
    assert requested_recommendations("昨天提到哪些故事？", history) is None


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
        return httpx.Response(200, headers={"Content-Type": "text/html"}, text=f"""
          <meta property="og:type" content="product">
          <meta property="og:title" content="Story collection">
          <meta property="og:image" content="{image}">
        """)

    async def run():
        request = requested_recommendations("给 8 岁孩子推荐绘本。叫她小九，英国买。", [])
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            return await recommendation_transition(request, "", client=client, provider=Provider())

    cards = asyncio.run(run())
    assert calls[0].query == "children's picture books 6-8 years"
    assert calls[0].include_domains == ("amazon.co.uk",)
    assert [(row["url"], row["image_url"]) for row in cards["offers"]] == [(product, image)]
