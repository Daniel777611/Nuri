import asyncio
from types import SimpleNamespace

from backend import alpha_chat_media as media
from backend.router import TurnRoute
from backend.websearch import SearchImage, SearchResult


def _lookup(text, *, locale=None, allow_history=False, route=None, authority_only=False):
    return asyncio.run(media.find_chat_media(
        text, media.requested_media(text), locale=locale or ("zh-CN" if "视频" in text else "en"),
        route=route, children=[{"nickname": "Juniper"}], allow_history=allow_history,
        existing=[], authority_only=authority_only,
    ))


def _provider(monkeypatch, videos=None):
    calls = []

    class Provider:
        name = "tavily"

        async def search(self, request):
            calls.append(request)
            if request.include_domains == ("youtube.com",):
                return videos if videos is not None else [
                    SearchResult("Introducing solids for babies - YouTube", "https://youtu.be/abcdefghijk?feature=share"),
                    SearchResult("Chicken puree for babies - YouTube", "https://youtu.be/lmnopqrstuv?feature=share"),
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


def test_language_development_drops_ai_finance_and_wrong_parenting_topics(monkeypatch):
    valid_id = "abcdefghijk"
    calls = _provider(monkeypatch, [
        SearchResult("最新 Grok 大语言模型", "https://www.youtube.com/watch?v=Grok0123456",
                     snippet="Babies, toddler language development, first words."),
        SearchResult("Short Straddle Explained", "https://www.youtube.com/watch?v=Stock123456",
                     snippet="See more: child speech and language development."),
        SearchResult("Toddler bedtime routine", "https://www.youtube.com/watch?v=Sleep123456",
                     snippet="First words and toddler language development are in another video."),
        SearchResult("Best cartoons for toddlers", "https://www.youtube.com/watch?v=Cartoon2345",
                     snippet="Tagged: first words, toddler language development."),
        SearchResult("Toddler speech and language development - YouTube", f"https://youtu.be/{valid_id}"),
        SearchResult("Speech and language development for adults", "https://youtu.be/zzzzzzzzzzz"),
    ])
    result = _lookup("给我推荐一些孩子语言发展的 YouTube 视频。", locale="zh-CN")
    assert [item["video_id"] for item in result["items"]] == [valid_id]
    assert calls[0].query == "幼儿语言发育 宝宝学说话 亲子互动"


def test_traditional_chinese_has_han_specific_query_and_verified_fallback(monkeypatch):
    calls = _provider(monkeypatch, [
        SearchResult("Toddler speech and language development", "https://youtu.be/abcdefghijk"),
        SearchResult("期權交易新手教學", "https://youtu.be/lmnopqrstuv"),
    ])
    result = _lookup("可不可以分享幼兒語言發展的影片？只要中文。", locale="zh-TW")
    assert [(item["video_id"], item["title"]) for item in result["items"]] == [
        ("K2tgEp7iTdU", "如何協助孩子語言發展"),
    ]
    assert result["items"][0]["source_url"].startswith("https://www.hch.gov.tw/")
    assert calls[0].query == "幼兒語言發展 寶寶學說話 親子互動"


def test_english_speech_request_fails_over_to_reviewed_educational_sources(monkeypatch):
    calls = _provider(monkeypatch, [])
    result = _lookup("Show me a video on toddler speech and language development")
    assert [item["video_id"] for item in result["items"]] == ["KNrnZag17Ek", "-zA3zK0g5ic"]
    assert all(item["thumbnail_url"].startswith("https://i.ytimg.com/vi/") for item in result["items"])
    assert calls[0].query == "child speech and language development toddler first words parent tips"


def test_no_topics_weak_other_topics_and_medical_cases_do_not_get_speech_fallback(monkeypatch):
    calls = _provider(monkeypatch, [
        SearchResult("Finance Course", "https://youtu.be/abcdefghijk"),
    ])
    assert _lookup("Show me a video about toddler bedtime routines") is None
    assert _lookup("Show me a tutorial video on stock trading", allow_history=True,
                   route=TurnRoute(topic="幼儿语言发展")) is None
    assert _lookup("Can you recommend a video for my child's language development diagnosis?") is None
    assert _lookup("Share a video on toddler speech development", authority_only=True) is None
    assert len(calls) == 1


def test_context_only_selects_topic_and_never_sends_route_text_or_child_data(monkeypatch):
    calls = _provider(monkeypatch, [])
    route = TurnRoute(
        topic="Juniper宝宝学说话", search_query="toddlers speech age 26 months private details here",
        search_query_zh="宝宝学说话, 12月12日生日, 额外的文字",
    )
    request = "有没有这方面的 YouTube 视频？"
    assert _lookup(request, route=route, allow_history=False) is None
    result = _lookup(request, route=route, allow_history=True)
    assert result["items"][0]["video_id"] == "K2tgEp7iTdU"
    assert len(calls) == 1
    assert calls[0].query == "幼儿语言发育 宝宝学说话 亲子互动"


def test_weak_video_does_not_remove_useful_article_and_image(monkeypatch):
    _provider(monkeypatch, [SearchResult("short straddle explained", "https://youtu.be/abcdefghijk")])
    result = _lookup("Show me videos, images and articles about starting solids")
    assert [item["type"] for item in result["items"]] == ["article", "image"]


def test_concrete_parenting_tasks_keep_relevant_results_without_sending_raw_text(monkeypatch):
    calls = _provider(monkeypatch, [
        SearchResult("How to fit your baby carrier safely", "https://youtu.be/abcdefghijk"),
        SearchResult("Diaper changing tutorial for newborns", "https://youtu.be/lmnopqrstuv"),
        SearchResult("Preparing a baby bath", "https://youtu.be/zzzzzzzzzzz"),
    ])
    result = _lookup("Can you show me a video about fitting my baby carrier from the orange shop?")
    assert [item["video_id"] for item in result["items"]] == ["abcdefghijk"]
    assert calls[0].query == "baby carrier fitting babywearing safe positioning parent demonstration"
    result = _lookup("给我看宝宝换尿布的视频吧，Juniper家的。")
    assert [item["video_id"] for item in result["items"]] == ["lmnopqrstuv"]
    assert calls[1].query == "婴儿更换尿布 宝宝换纸尿裤 示范"


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
