"""Offline real-provider-shape → exact chosen post → public-card regressions.

No provider traffic, account, stored customer card, page scrape or model call.
"""

import asyncio

import pytest

from backend.feed import daily_post as dp
from backend.feed.post_media import social_image_url, source_image_urls
from backend.search_tavily import TavilySearchProvider
from backend.websearch import SearchImage, SearchRequest, SearchResult

SOURCE = "https://www.facebook.com/groups/public/posts/42"
FIRST = "https://scontent-sea1-1.xx.fbcdn.net/v/t39.30808-6/post.jpg?oh=public-signature"
SECOND = "https://scontent.cdninstagram.com/v/t51.2885-15/post.webp"


def test_only_daily_post_search_requests_source_linked_images(monkeypatch):
    captured = []

    async def search(_self, request):
        captured.append(request)
        return []

    monkeypatch.setenv("TAVILY_API_KEY", "offline-test-key")
    monkeypatch.setattr(TavilySearchProvider, "fetch", search)
    assert asyncio.run(dp.search_meta("toddler sleep moms", "en")) == []
    assert len(captured) == 1 and captured[0].include_images is True
    assert captured[0].include_domains == dp.META_DOMAINS
    assert SearchRequest(query="other existing search").include_images is False


@pytest.mark.parametrize("url", [
    "http://scontent.fbcdn.net/post.jpg", "https://scontent.fbcdn.net.evil.invalid/post.jpg",
    "https://user:password@scontent.fbcdn.net/post.jpg", "https://scontent.fbcdn.net:444/post.jpg",
    "https://127.0.0.1/post.jpg", "https://image.local/post.jpg", "https://scontent.fbcdn.net/embed.html",
    "https://scontent.fbcdn.net/image.svg", "https://scontent.fbcdn.net/post.jpg?access_token=secret",
    "https://scontent.fbcdn.net/post.jpg?api_key=secret", "data:image/png;base64,aaaa", "file:///private/image.jpg",
    "https://scontent.fbcdn.net/profile_picture.jpg", "https://scontent.fbcdn.net/v/t39.30808-1/123.jpg",
    "https://scontent.cdninstagram.com/v/t51.2885-19/123.jpg", "https://scontent.fbcdn.net/avatar.jpg",
    "https://scontent.fbcdn.net/post.jpg\n", None, 42, {},
])
def test_unsafe_or_known_avatar_images_are_never_thumbnails(url):
    assert social_image_url(url) is None


def test_source_images_are_bounded_deduplicated_and_exclude_page_furniture():
    images = (
        SearchImage(FIRST, "The author's profile picture"),
        SearchImage(FIRST, "A photo attached to the post"),
        SearchImage(FIRST, "Duplicate source image"),
        SearchImage("https://scontent.fbcdn.net/logo.png", "Platform logo"),
        SearchImage(SECOND, "The source post's second photo"),
        SearchImage("https://scontent.fbcdn.net/third.jpg"),
    )
    assert source_image_urls(images) == (FIRST, SECOND)
    assert social_image_url(FIRST) == FIRST, "Preserve public CDN signatures; don't rewrite URLs"
    assert source_image_urls("not an image list") == ()


def test_provider_images_follow_the_exact_selected_candidate_into_the_public_card():
    provider = TavilySearchProvider(api_key="offline-test-key")
    request = SearchRequest(query="mock source query", include_images=True)
    source_two = "https://www.facebook.com/groups/public/posts/43"
    text = "My toddler had trouble sleeping. I tried an earlier bedtime and a consistent quiet routine."
    results = provider._parse({
        "images": [{"url": "https://scontent.fbcdn.net/UNRELATED_QUERY_IMAGE.jpg"}],
        "results": [
            {"url": SOURCE, "title": "First source", "content": text,
             "images": [{"url": "https://scontent.fbcdn.net/other-post.jpg"}]},
            {"url": source_two, "title": "Selected source", "content": text,
             "images": [{"url": FIRST, "description": "A photo in this source post"}, {"url": SECOND}]},
        ],
    }, request)
    candidates = dp.to_candidates(results, exclude_urls=set())
    selected = candidates[1]
    assert (selected.thumbnail_url, selected.image_url) == (FIRST, SECOND)
    pick = {"candidate": selected, "excerpt": "", "headline": "Supplied summary", "takeaways": ["Existing point"],
            "why_this": "Existing reason", "caution": "", "author_kind": "parent",
            "thumbnail_url": "https://scontent.fbcdn.net/MODEL_INVENTED.jpg"}
    card = dp.build_card(pick, dp.Plan(basis="profile", concern="sleep"), locale="en")
    public = dp.public_card({"id": "mock-card", "day": "2026-11-04", "card": card}, audience="parent", nickname="Fixture")
    assert public["source_url"] == source_two
    assert (public["thumbnail_url"], public["image_url"]) == (FIRST, SECOND)
    assert public["headline"] == "Supplied summary" and public["takeaways"] == ["Existing point"]
    assert "MODEL_INVENTED" not in str(public) and "UNRELATED_QUERY_IMAGE" not in str(public)
    assert FIRST not in dp.chat_context(public), "Image URLs do not become new chat/model input"


def test_missing_source_images_stay_missing_even_when_query_images_exist():
    provider = TavilySearchProvider(api_key="offline-test-key")
    results = provider._parse({"images": [{"url": FIRST}], "results": [{
        "url": SOURCE, "content": "A parent describes a calm bedtime routine with their toddler every evening.",
    }]}, SearchRequest(query="q", include_images=True))
    candidates = dp.to_candidates(results, exclude_urls=set())
    assert len(candidates) == 1
    assert candidates[0].thumbnail_url == candidates[0].image_url == ""


def test_duplicate_language_results_can_supply_images_without_changing_the_post_selection():
    text = "A parent describes a calm bedtime routine with their toddler every evening."
    first = SearchResult(url=SOURCE, title="First result text", snippet=text)
    duplicate = SearchResult(url=SOURCE + "?ref=search", title="Duplicate text stays unused", snippet="", images=(SearchImage(FIRST), SearchImage(SECOND)))
    candidates = dp.to_candidates([first, duplicate], exclude_urls=set())
    assert len(candidates) == 1 and candidates[0].title == "First result text"
    assert (candidates[0].thumbnail_url, candidates[0].image_url) == (FIRST, SECOND)


def test_legacy_saved_cards_have_no_invented_metadata_and_stored_poison_is_removed():
    row = {"id": "mock-card", "day": "2026-11-04", "card": {"source_url": SOURCE, "headline": "Existing summary"}}
    card = dp.public_card(row, audience="parent", nickname="Fixture")
    assert "thumbnail_url" not in card and "image_url" not in card
    row["card"].update(thumbnail_url="https://evil.invalid/unrelated.jpg", image_url=SECOND)
    card = dp.public_card(row, audience="parent", nickname="Fixture")
    assert card["thumbnail_url"] is None and card["image_url"] == SECOND
    row["card"]["source_url"] = "https://www.facebook.com/login/"
    card = dp.public_card(row, audience="parent", nickname="Fixture")
    assert card["thumbnail_url"] is None and card["image_url"] is None
