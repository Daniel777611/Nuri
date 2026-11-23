import asyncio
from types import SimpleNamespace

from backend import alpha_chat_media as media
from backend.router import TurnRoute
from backend.websearch import SearchImage, SearchResult


def _lookup(text, *, allow_history=False, route=None, authority_only=False):
    return asyncio.run(media.find_chat_media(
        text, media.requested_media(text), locale="zh-CN" if "视频" in text else "en",
        route=route, children=[{"nickname": "Juniper"}], allow_history=allow_history,
        existing=[], authority_only=authority_only,
    ))


def _provider(monkeypatch):
    calls = []

    class Provider:
        name = "tavily"

        async def search(self, request):
            calls.append(request)
            if request.include_domains == ("youtube.com",):
                return [
                    SearchResult("An example feeding tutorial - YouTube", "https://youtu.be/abcdefghijk?feature=share"),
                    SearchResult("same video", "https://www.youtube.com/watch?v=abcdefghijk"),
                    SearchResult("not a video", "https://youtube.com.evil.org/watch?v=zzzzzzzzzzz"),
                    SearchResult("not a video", "https://www.youtube.com/playlist?list=abcdefghijk"),
                ]
            return [
                SearchResult("Guide to starting solids", "https://www.healthychildren.org/English/solids", images=(
                    SearchImage("https://cdn.healthychildren.org/cover.jpg"),
                    SearchImage("https://cdn.healthychildren.org/icon.png", "profile picture"),
                    SearchImage("https://192.168.1.1/cover.jpg"),
                    SearchImage("https://cdn.healthychildren.org/cover.png?access_token=secret"),
                )),
                SearchResult("untrusted page", "https://unknown-webpage.xyz/solids"),
                SearchResult("private host", "https://a.internal/solids", tier="authority"),
            ]

    monkeypatch.setattr(media, "get_provider", Provider)
    return calls


def test_mixed_requests_include_canonical_video_article_and_provenance_image(monkeypatch):
    calls = _provider(monkeypatch)
    result = _lookup("Show me videos, images and articles about starting solids")
    assert [item["type"] for item in result["items"]] == ["video", "article", "image"]
    video, article, image = result["items"]
    assert video["video_id"] == "abcdefghijk"
    assert video["url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    assert video["thumbnail_url"] == "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"
    assert article["thumbnail_url"] == image["url"] == "https://cdn.healthychildren.org/cover.jpg"
    assert article["url"] == image["source_url"]
    assert len(calls) == 2


def test_does_not_search_passthrough_urls_generic_or_private_requests(monkeypatch):
    calls = _provider(monkeypatch)
    assert media.requested_media("I watched a video about feeding") == ()
    assert _lookup("Find videos about the diagnosis for me@example.org") is None
    assert _lookup("Find videos https://internal.home/key?token=secret") is None
    assert _lookup("有没有youtube视频教程分享给我？") is None
    assert _lookup("有没有 YouTube 视频链接？") is None
    assert not calls


def test_followup_query_uses_context_only_when_authorized_and_scrubs_child_name(monkeypatch):
    calls = _provider(monkeypatch)
    route = TurnRoute(needs_search=True, search_query_zh="Juniper 七个月宝宝 鸡肉泥")
    assert _lookup("有没有youtube视频教程分享给我？", route=route) is None
    assert not calls
    assert _lookup("有没有youtube视频教程分享给我？", route=route, allow_history=True)
    assert len(calls) == 1
    assert "鸡肉泥" in calls[0].query and "Juniper" not in calls[0].query


def test_medical_case_never_searches_for_unvetted_video(monkeypatch):
    calls = _provider(monkeypatch)
    result = _lookup("Show me videos and articles about toddler fever", authority_only=True)
    assert result and all(item["type"] == "article" for item in result["items"])
    assert len(calls) == 1 and "youtube.com" not in calls[0].include_domains


def test_chat_attachment_respects_release_feature_scope_and_emergency(monkeypatch):
    from backend import main

    calls = []

    async def fake_media(*args, **kwargs):
        calls.append(kwargs)
        return {"kind": "chat_media", "items": []}

    async def fake_privacy(uid, *, fail_closed):
        assert uid == "test-owner" and fail_closed
        return {"allow_external_content_research": False}

    monkeypatch.setattr(media, "find_chat_media", fake_media)
    monkeypatch.setattr(main.stores, "get_privacy", fake_privacy)
    turn = SimpleNamespace(owner_uid="test-owner", context_hints={"children": []})
    body = main.UserMessageIn(text="Find a video about introducing solid foods", include_media=True)
    context = main._ReplyContext(route=TurnRoute())
    monkeypatch.setattr(main.runtime, "alpha_features_available", lambda: False)
    assert asyncio.run(main._find_turn_chat_media(body, turn, context)) is None
    monkeypatch.setattr(main.runtime, "alpha_features_available", lambda: True)
    assert asyncio.run(main._find_turn_chat_media(body.model_copy(update={"include_media": False}), turn, context)) is None
    critical = context._replace(evidence=SimpleNamespace(risk_tier="emergency"))
    assert asyncio.run(main._find_turn_chat_media(body, turn, critical)) is None
    assert not calls
    assert asyncio.run(main._find_turn_chat_media(body, turn, context))["kind"] == "chat_media"
    assert [call["allow_history"] for call in calls] == [False]
