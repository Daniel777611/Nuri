import asyncio
import json
from datetime import date
from types import SimpleNamespace

import httpx
import pytest

from backend import alpha_chat_media as media
from backend.router import TurnRoute
from backend.websearch import SearchImage, SearchResult


def _lookup(text, *, locale=None, allow_history=False, route=None, authority_only=False, history=(), children=None,
            existing=None):
    return asyncio.run(media.find_chat_media(
        text, media.requested_media(text, history), locale=locale or ("zh-CN" if "视频" in text else "en"),
        route=route, children=children if children is not None else [{"nickname": "Juniper"}], allow_history=allow_history,
        existing=existing or [], authority_only=authority_only, history=history,
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
            if "fever" in request.query:
                return [SearchResult("Fever in toddlers", "https://www.healthychildren.org/English/fever", images=(
                    SearchImage("https://cdn.healthychildren.org/cover.jpg"),
                ))]
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
        SearchResult("幼儿语言发展：陪孩子学说话 - YouTube", f"https://youtu.be/{valid_id}"),
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


FEEDING_HISTORY = [
    {"role": "user", "text": "我想找 13 个月孩子吃饭吐食、挑食的 YouTube 视频"},
    {"role": "ai", "text": "我可以给你一些 13 个月宝宝饮食、吐食、挑食的 YouTube 搜索句。"},
]

MILESTONE_REQUEST = "你给我查一下关于我家小孩现在的关于现在他的他所处于的发展关键期的相关的视频教程。"
MILESTONE_RETRY = "你怎么会没找到呢?任何发展关键期的跟我家小孩现在有相关的你都可以用啊，帮我找找。"
MILESTONE_HISTORY = [
    {"role": "user", "text": MILESTONE_REQUEST},
    {"role": "ai", "text": "可以看 CDC 的发育里程碑示例，也可以找幼儿挑食应对视频。"},
]


def _child(months, nickname="Juniper"):
    today = date.today()
    year, zero_month = divmod(today.year * 12 + today.month - 1 - months, 12)
    return {"nickname": nickname, "birth_date": date(year, zero_month + 1, 1).isoformat()}


def test_contextual_early_learning_videos_search_with_age_without_exporting_identifiers(monkeypatch):
    calls = _provider(monkeypatch, [
        SearchResult("13个月宝宝的早教游戏", "https://youtu.be/abcdefghijk"),
        SearchResult("Toddler Early Learning Activities for 13 Month Olds", "https://youtu.be/lmnopqrstuv"),
        SearchResult("Grok 人工智能早教？大语言模型", "https://youtu.be/zzzzzzzzzzz"),
    ])
    child = _child(13, "测试小朋友")
    result = _lookup("给我几个适合测试小朋友现在的情况的早教的视频。", children=[child])
    assert [item["video_id"] for item in result["items"]] == ["abcdefghijk"]
    assert len(calls) == 1
    assert "13个月" in calls[0].query and "早教" in calls[0].query
    assert "测试小朋友" not in calls[0].query and child["birth_date"] not in calls[0].query
    assert all(item["url"].startswith("https://www.youtube.com/watch?v=") for item in result["items"])
    assert all(item["thumbnail_url"].startswith("https://i.ytimg.com/vi/") for item in result["items"])


def test_video_retry_uses_other_search_language_only_if_user_allows_either(monkeypatch, caplog):
    calls = []

    class Provider:
        name = "tavily"

        async def search(self, request):
            calls.append(request)
            return [SearchResult("睡眠人工智能模型", "https://youtu.be/zzzzzzzzzzz")] if request.lang == "zh" else [
                SearchResult("Baby sleep: bedtime routine for toddlers", "https://youtu.be/abcdefghijk"),
            ]

    monkeypatch.setattr(media, "get_provider", Provider)
    result = _lookup("给我几个宝宝睡眠视频。", children=[_child(13)])
    assert [item["video_id"] for item in result["items"]] == ["abcdefghijk"]
    assert result["items"][0]["title"].endswith("（英文）")
    assert [(request.lang, request.include_domains) for request in calls] == [
        ("zh", ("youtube.com",)), ("en", ("youtube.com",)),
    ]
    assert "status=filtered candidate_count=1" in caplog.text
    assert calls[0].query not in caplog.text
    assert "zzzzzzzzzzz" not in caplog.text

    calls.clear()
    result = _lookup("给我几个宝宝睡眠视频，只要中文。", children=[_child(13)])
    assert [request.lang for request in calls] == ["zh"]
    assert result is None


@pytest.mark.parametrize("locale,video_ids", [
    ("zh-CN", ["lmnopqrstuv", "zzzzzzzzzzz"]),
    ("zh-TW", ["zzzzzzzzzzz", "lmnopqrstuv"]),
    ("en", ["abcdefghijk"]),
])
def test_app_locale_prioritizes_actual_video_language_and_script(monkeypatch, locale, video_ids):
    calls = _provider(monkeypatch, [
        SearchResult("Toddler language development: how to help babies talk", "https://youtu.be/abcdefghijk", lang="zh"),
        SearchResult("幼儿语言发展：家長怎麼讓孩子開口說話", "https://youtu.be/zzzzzzzzzzz", lang="en"),
        SearchResult("幼儿语言发展：家长怎么让孩子开口说话", "https://youtu.be/lmnopqrstuv", lang="en"),
    ])
    result = _lookup("Show me speech and language development videos for toddlers", locale=locale)
    assert [item["video_id"] for item in result["items"]] == video_ids
    assert [request.lang for request in calls] == ["en" if locale == "en" else "zh"]


def test_reviewed_chinese_video_beats_live_english_result(monkeypatch):
    calls = _provider(monkeypatch, [
        SearchResult("Early learning activities for toddlers", "https://youtu.be/abcdefghijk"),
    ])
    result = _lookup("给我几个早教视频。", locale="zh-CN")
    assert [item["video_id"] for item in result["items"]] == ["TW3J7YhX2CI"]
    assert [request.lang for request in calls] == ["zh"]


def test_article_locale_and_explicit_override_use_actual_publisher_variants(monkeypatch):
    _provider(monkeypatch, [])
    covers = (SearchImage("https://www.fhs.gov.hk/cover.jpg"),)
    english = SearchResult("What to do about picky eaters", "https://www.fhs.gov.hk/english/health_info/child/20033.html",
                           images=covers, lang="zh")
    traditional = SearchResult("孩子偏食怎麼辦？", "https://www.fhs.gov.hk/tc_chi/health_info/child/20033.html",
                               images=covers, lang="en")
    simplified = SearchResult("孩子偏食怎么办？", "https://www.fhs.gov.hk/sc_chi/health_info/child/20033.html",
                              images=covers, lang="en")
    existing = [english, traditional, simplified]

    async def keep_mocked_covers(rows):
        return rows

    monkeypatch.setattr(media, "_with_article_covers", keep_mocked_covers)
    result = _lookup("给我几篇幼儿挑食的文章", locale="zh-CN", existing=existing)
    assert [item["url"] for item in result["items"]] == [simplified.url, traditional.url]
    result = _lookup("給我幾篇幼兒挑食的文章", locale="zh-TW", existing=existing)
    assert [item["url"] for item in result["items"]] == [traditional.url, simplified.url]
    result = _lookup("给我几篇幼儿挑食的文章，只要英文", locale="zh-CN", existing=existing)
    assert result["items"][0]["url"] == english.url
    assert all("/tc_chi/" not in item["url"] and "/sc_chi/" not in item["url"] for item in result["items"])


@pytest.mark.parametrize("text", [
    "我想要的是绘本介绍或者读绘本的视频。",
    "不是书单，我想看读绘本的视频。",
])
def test_reading_video_correction_triggers_media_and_gets_playable_links(monkeypatch, text):
    calls = _provider(monkeypatch, [
        SearchResult("幼儿绘本亲子共读 - YouTube", "https://youtu.be/abcdefghijk"),
        SearchResult("Read Aloud Picture Books for Toddlers", "https://youtu.be/lmnopqrstuv"),
    ])
    assert media.requested_media(text) == ("video",)
    result = _lookup(text)
    assert [item["video_id"] for item in result["items"]] == ["abcdefghijk"]
    assert len(calls) == 1 and "书单" not in calls[0].query


def test_named_book_only_shows_results_for_the_requested_title(monkeypatch):
    calls = _provider(monkeypatch, [
        SearchResult("Goodnight Moon Read Aloud for Kids", "https://youtu.be/zzzzzzzzzzz"),
        SearchResult("Brown Bear, Brown Bear, What Do You See? Read Aloud", "https://youtu.be/abcdefghijk"),
    ])
    text = "给测试小朋友找《Brown Bear, Brown Bear》的绘本朗读视频。"
    result = _lookup(text, children=[_child(13, "测试小朋友")])
    assert [item["video_id"] for item in result["items"]] == ["abcdefghijk"]
    assert "Brown Bear, Brown Bear" in calls[0].query and "测试小朋友" not in calls[0].query
    assert "测试小朋友" not in str(result)


def test_reading_followup_without_content_research_uses_reviewed_video_only(monkeypatch):
    calls = _provider(monkeypatch, [
        SearchResult("Brown Bear, Brown Bear, What Do You See? Read Aloud", "https://youtu.be/abcdefghijk"),
    ])
    earlier = "我想要《Brown Bear, Brown Bear》的绘本朗读视频。"
    result = _lookup("视频链接呢？", history=[{"role": "user", "text": earlier}])
    assert [item["video_id"] for item in result["items"]] == ["77arbp2TjXQ"]
    assert not calls


@pytest.mark.parametrize("text", [
    "给我推荐婴儿推车，并告诉我怎么用",
    "Recommend a stroller and explain why",
    "推荐适合一岁小孩的积木，并说说原因",
])
def test_recommendation_plus_explicit_advice_is_mixed(text):
    assert not media.resource_only_request(text)


@pytest.mark.parametrize("text,history", [
    (MILESTONE_REQUEST, ()),
    (MILESTONE_RETRY, MILESTONE_HISTORY),
    ("视频链接呢？", MILESTONE_HISTORY),
])
def test_current_stage_uses_owned_profile_and_official_clips_without_search(monkeypatch, text, history):
    calls = _provider(monkeypatch, [])
    result = _lookup(text, locale="zh-CN", history=history, children=[_child(13)], authority_only=True)
    assert media.requested_media(text, history) == ("video",)
    assert [item["video_id"] for item in result["items"]] == [
        "NlWnbuOMMEE", "yVL2RclZ1J0",
    ]
    assert all(item["url"].startswith("https://www.youtube.com/watch?v=") for item in result["items"])
    assert all(item["thumbnail_url"].startswith("https://i.ytimg.com/vi/") for item in result["items"])
    assert all(item["source_url"] == "https://www.youtube.com/user/hpagov" for item in result["items"])
    assert all("Juniper" not in str(item) for item in result["items"])
    assert not calls


def test_milestone_video_picks_the_named_child_or_a_general_overview(monkeypatch):
    calls = _provider(monkeypatch, [])
    siblings = [_child(13, "小叶"), _child(9, "小雨")]
    named = _lookup("请给我小雨的发展关键期视频", children=siblings)
    assert [item["video_id"] for item in named["items"]] == ["wG2wh9b3X8I", "yVL2RclZ1J0"]
    ambiguous = _lookup(MILESTONE_REQUEST, children=siblings)
    assert [item["video_id"] for item in ambiguous["items"]] == ["yVL2RclZ1J0"]
    assert not calls


def test_explicit_english_milestones_keep_the_cdc_examples(monkeypatch):
    calls = _provider(monkeypatch, [])
    result = _lookup("找几个发育里程碑的视频，只要英文", locale="zh-CN", children=[_child(13)])
    assert [item["video_id"] for item in result["items"]] == [
        "GqV34gup6TQ", "Bu2W89FzKiw", "IsWTBFfj3Y0", "dWmRzywu97U", "3Qke5GVhqHw",
    ]
    assert not calls


def test_milestone_article_links_to_the_actual_chinese_checklist_and_image_keeps_provenance(monkeypatch):
    calls = _provider(monkeypatch, [])
    result = _lookup("给我找发育里程碑的文章和照片", locale="zh-CN", children=[_child(9)])
    article, image = result["items"]
    assert article["url"].endswith("/cdc-milestone-checklists-ltsae-chinese.pdf")
    assert image["source_url"] == "https://www.cdc.gov/act-early/milestones-in-action/9-months.html"
    assert image["url"] == "https://i.ytimg.com/vi/2zEEh4hM7dw/hqdefault.jpg"
    assert not calls


def test_milestone_examples_do_not_override_explicit_diagnostic_requests(monkeypatch):
    calls = _provider(monkeypatch, [])
    clinical = "孩子发育迟缓，这些发育里程碑是不是正常？给我视频。"
    assert _lookup(clinical, children=[_child(13)], authority_only=True) is None
    assert _lookup("视频链接呢？", children=[_child(13)], history=[
        {"role": "user", "text": clinical},
    ], authority_only=True) is None
    assert media.requested_media("告诉我什么是发育里程碑") == ()
    assert not calls


@pytest.mark.parametrize("text", [
    "那你给我的链接在哪里呢?",
    "我要的是链接啊,你让我去搜,你让我去搜那你来干嘛呢?",
])
def test_link_only_follow_up_uses_the_previous_video_subject_without_exporting_history(monkeypatch, text):
    calls = _provider(monkeypatch)
    result = _lookup(text, locale="zh-CN", history=FEEDING_HISTORY)
    assert media.requested_media(text, FEEDING_HISTORY) == ("video",)
    assert [item["video_id"] for item in result["items"]] == ["W9LxMa7jRoM", "fLH9JRiRha0"]
    assert all(item["thumbnail_url"].startswith("https://i.ytimg.com/vi/") for item in result["items"])
    assert "点卡片" in media.resource_reply(result, "zh-CN")
    assert not calls


def test_concrete_video_beyond_reviewed_topics_still_requires_title_evidence(monkeypatch):
    calls = _provider(monkeypatch, [
        SearchResult("How to replace a stroller wheel - YouTube", "https://youtu.be/abcdefghijk"),
        SearchResult("Wheel of Fortune - YouTube", "https://youtu.be/lmnopqrstuv", snippet="stroller replacement videos"),
        SearchResult("Trading stocks for parents - YouTube", "https://youtu.be/zzzzzzzzzzz"),
    ])
    result = _lookup("Show me a YouTube video about stroller wheel replacement")
    assert [item["video_id"] for item in result["items"]] == ["abcdefghijk"]
    assert "stroller wheel replacement" in calls[0].query


def test_explicit_article_and_image_request_has_reviewed_source_picture_if_provider_is_down(monkeypatch):
    class Offline:
        name = "null"

    monkeypatch.setattr(media, "get_provider", Offline)
    result = _lookup("给我几篇幼儿挑食的文章和图片", locale="zh-CN")
    assert [item["type"] for item in result["items"]] == ["article", "image"]
    assert result["items"][0]["url"].startswith("https://www.fhs.gov.hk/")
    assert result["items"][-1]["source_url"] == "https://www.cdc.gov/nutrition/features/help-picky-eater.html"
    assert result["items"][-1]["thumbnail_url"].endswith("Pickyeater.jpg")


def test_publisher_declared_cover_is_source_specific_and_does_not_follow_redirects():
    seen = []

    def handle(request):
        seen.append(str(request.url))
        return httpx.Response(200, headers={"Content-Type": "text/html"}, text=(
            '<meta property="og:image" content="https://www.cdc.gov/images/logo.png">'
            '<meta property="og:image" content="/images/family-meal.jpg"></head>'
        ))

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            assert await media._read_article_cover(client, "https://www.cdc.gov/article") == (
                "https://www.cdc.gov/images/family-meal.jpg"
            )
            assert await media._read_article_cover(client, "https://unknown.example/article") is None

    asyncio.run(run())
    assert seen == ["https://www.cdc.gov/article"]


def test_explicit_link_again_does_not_treat_sign_in_or_a_new_subject_as_previous_topic(monkeypatch):
    calls = _provider(monkeypatch, [])
    assert media.requested_media("请给我登录链接？", FEEDING_HISTORY) == ()
    assert _lookup("Find me a link for toddler sleep routines", history=FEEDING_HISTORY) is None
    assert not calls or all("picky" not in call.query for call in calls)


@pytest.mark.parametrize("streamed", [False, True])
@pytest.mark.parametrize("request_text,history,video_id,risk", [
    ("那你给我的链接在哪里呢?", FEEDING_HISTORY, "W9LxMa7jRoM", "none"),
    (MILESTONE_REQUEST, (), "NlWnbuOMMEE", "medical"),
    (MILESTONE_RETRY, MILESTONE_HISTORY, "NlWnbuOMMEE", "none"),
    ("视频链接呢？", MILESTONE_HISTORY, "NlWnbuOMMEE", "medical"),
])
def test_resource_requests_return_and_persist_cards_and_direct_copy(monkeypatch, streamed, request_text,
                                                               history, video_id, risk):
    from backend import main
    from backend.tests.test_single_session import _Supabase, _install_turn_dependencies

    sb = _Supabase([{"id": "resource-chat", "user_id": "fixture-parent", "created_at": "2026-11-01T00:00:00+00:00"}])
    for index, row in enumerate(history):
        sb.message_inserts.append({
            **row, "id": f"prior-{index}", "session_id": "resource-chat",
            "created_at": f"2026-11-01T00:00:0{index}+00:00",
        })

    async def noop(*_args, **_kwargs):
        return None

    async def context(turn, *_args):
        assert turn.owner_uid == "fixture-parent"
        return main._ReplyContext(evidence=SimpleNamespace(risk_tier=risk))

    async def load_profile(uid):
        assert uid == "fixture-parent"
        return {}, [_child(13)]

    async def privacy(*_args, **_kwargs):
        return {"allow_external_content_research": False}

    def unexpected_generation(*_args, **_kwargs):
        raise AssertionError("A link-only response must describe the actual card outcome")

    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    monkeypatch.setattr(main.runtime, "alpha_features_available", lambda: True)
    monkeypatch.setattr(main, "oai", object())
    monkeypatch.setattr(main, "aoai", object())
    monkeypatch.setattr(main, "_reply_context", context)
    monkeypatch.setattr(main, "_require_chat_allowance", noop)
    monkeypatch.setattr(main, "_after_turn", noop)
    monkeypatch.setattr(main._TurnMetrics, "flush", noop)
    monkeypatch.setattr(main.core_family, "extract_and_upsert_memories", noop)
    monkeypatch.setattr(main.core_dialogue_reply, "style_rules_fingerprint", noop)
    monkeypatch.setattr(main.core_dialogue_reply, "nuri_reply_sync", unexpected_generation)
    monkeypatch.setattr(main.core_dialogue_reply, "nuri_reply_stream", unexpected_generation)
    monkeypatch.setattr(main.stores, "get_privacy", privacy)
    monkeypatch.setitem(main.app.dependency_overrides, main._req_uid, lambda: "fixture-parent")
    calls = _provider(monkeypatch, [])
    _install_turn_dependencies(monkeypatch, [])
    monkeypatch.setattr(main.core_family_store, "load_profile", load_profile)

    async def run():
        target = "/api/chat/sessions/resource-chat/messages" + ("/stream" if streamed else "")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://fixture-nuri.test") as client:
            return await client.post(target, json={
                "text": request_text,
                "client_message_id": "verified-link-only-follow-up",
                "compare_products": True,
                "include_media": True,
                "client_context": {"locale": "zh-CN"},
            })

    response = asyncio.run(run())
    assert response.status_code == 200, response.text
    if streamed:
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert events[-1]["type"] == "done"
        reply, = events[-1]["ai_messages"]
        assert events[0] == {"type": "delta", "text": reply["text"]}
    else:
        reply, = response.json()["ai_messages"]
    assert "点卡片" in reply["text"]
    assert reply["transition"]["items"][0]["video_id"] == video_id
    saved, = [row for row in sb.message_inserts if row.get("id") == reply["id"]]
    assert saved["transition"]["kind"] == reply["transition"]["kind"]
    assert saved["transition"]["items"] == reply["transition"]["items"]
    assert not calls


def test_current_thread_explicit_subject_can_be_retried_after_router_failure(monkeypatch):
    calls = _provider(monkeypatch, [
        SearchResult("How to replace a stroller wheel", "https://youtu.be/abcdefghijk"),
    ])
    history = [
        {"role": "user", "text": "Can you show me a YouTube video about stroller wheel replacement?"},
        {"role": "ai", "text": "I couldn't verify a link."},
    ]
    request = "Where’s the link?"
    assert _lookup(request, history=history, route=TurnRoute(ok=False)) is None
    assert not calls
    result = _lookup(request, history=history, route=TurnRoute(ok=False), allow_history=True)
    assert [item["video_id"] for item in result["items"]] == ["abcdefghijk"]
    assert "stroller wheel replacement" in calls[0].query
