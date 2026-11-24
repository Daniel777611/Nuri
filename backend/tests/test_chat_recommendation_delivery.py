import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from backend import alpha_chat_media, main, product_recommendations
from backend.tests.test_alpha_chat_media import _child
from backend.tests.test_product_recommendations import product_markup
from backend.tests.test_single_session import _Supabase, _install_turn_dependencies
from backend.websearch import NullSearchProvider, SearchResult


@pytest.mark.parametrize(("selected", "saved", "expected"), [
    ("zh-CN", "en", "zh-CN"),
    ("en", "zh-CN", "en"),
    ("zh", "en", "zh-CN"),
    (None, "zh-TW", "zh-TW"),
    ("unspecified", "en", "en"),
])
def test_resource_search_uses_current_app_language_then_saved_preference(monkeypatch, selected, saved, expected):
    async def privacy(*_args, **_kwargs):
        return {"language": saved}

    async def find_media(*_args, locale, **_kwargs):
        assert locale == expected
        return {"kind": "chat_media", "items": []}

    monkeypatch.setattr(main.stores, "get_privacy", privacy)
    monkeypatch.setattr(alpha_chat_media, "find_chat_media", find_media)
    body = main.UserMessageIn(
        text="Find a video",
        client_context={"locale": selected} if selected else None,
    )
    turn = SimpleNamespace(owner_uid="fixture-parent", context_hints={})
    assert asyncio.run(main._find_turn_chat_media(body, turn, main._ReplyContext(), ("video",)))


@pytest.mark.parametrize("streamed", [False, True])
@pytest.mark.parametrize(("kind", "question", "video_title"), [
    ("video", "给我几个适合测试宝宝现在的情况的早教视频。", "13个月宝宝的早教游戏"),
    ("video", "给我推荐几个适合测试宝宝的绘本朗读视频。", "13个月宝宝亲子共读绘本朗读"),
    ("product", "推荐几本适合测试宝宝现在看的绘本。", None),
])
def test_alpha_recommendation_delivers_verified_cards_on_first_reply(monkeypatch, streamed, kind, question, video_title):
    session_id = "recommendation-chat"
    uid = "fixture-parent"
    sb = _Supabase([{"id": session_id, "user_id": uid, "created_at": "2026-11-01T00:00:00+00:00"}])

    async def noop(*_args, **_kwargs):
        pass

    async def reply_context(*_args):
        return main._ReplyContext(evidence=SimpleNamespace(risk_tier="none"))

    child = {**_child(13), "nickname": "测试宝宝"}

    async def load_profile(_uid):
        return {}, [child]

    async def privacy(*_args, **_kwargs):
        return {"allow_external_content_research": False}

    def unexpected_generation(*_args, **_kwargs):
        raise AssertionError("A direct recommendation with cards uses the actual lookup result")

    calls = []

    class VideoProvider:
        name = "fixture"

        async def search(self, request):
            calls.append(request)
            return [
                SearchResult(video_title, "https://youtu.be/abcdefghijk"),
                SearchResult("AI 大语言模型早教数据训练", "https://youtu.be/lmnopqrstuv"),
            ]

    def merchant(request):
        url = str(request.url)
        if request.headers.get("accept") == "image/*":
            return httpx.Response(200, headers={"Content-Type": "image/jpeg"})
        if "9781416947370" in url:
            return product_markup(url, "Dear Zoo", "7.99", "USD", isbn="9781416947370")
        return httpx.Response(200, headers={"Content-Type": "text/html"})

    recommend = product_recommendations.recommendation_transition

    async def recommend_with_merchant_fixture(request, reply, *, locale):
        async with httpx.AsyncClient(transport=httpx.MockTransport(merchant)) as client:
            return await recommend(request, reply, locale=locale, client=client, provider=NullSearchProvider())

    _install_turn_dependencies(monkeypatch, [])
    monkeypatch.setattr(main, "_get_supabase", lambda: sb)
    monkeypatch.setattr(main.runtime, "alpha_features_available", lambda: True)
    monkeypatch.setattr(main, "oai", object())
    monkeypatch.setattr(main, "aoai", object())
    monkeypatch.setattr(main, "_reply_context", reply_context)
    monkeypatch.setattr(main, "_require_chat_allowance", noop)
    monkeypatch.setattr(main, "_after_turn", noop)
    monkeypatch.setattr(main._TurnMetrics, "flush", noop)
    monkeypatch.setattr(main.core_family_store, "load_profile", load_profile)
    monkeypatch.setattr(main.core_family, "extract_and_upsert_memories", noop)
    monkeypatch.setattr(main.core_dialogue_reply, "style_rules_fingerprint", noop)
    monkeypatch.setattr(main.core_dialogue_reply, "nuri_reply_sync", unexpected_generation)
    monkeypatch.setattr(main.core_dialogue_reply, "nuri_reply_stream", unexpected_generation)
    monkeypatch.setattr(main.stores, "get_privacy", privacy)
    monkeypatch.setattr(alpha_chat_media, "get_provider", VideoProvider)
    monkeypatch.setattr(product_recommendations, "recommendation_transition", recommend_with_merchant_fixture)
    if kind == "video":
        def unexpected_comparison(*_args, **_kwargs):
            raise AssertionError("A video about a product must use media retrieval, not shopping")

        monkeypatch.setattr(main, "lookup_product_comparison", unexpected_comparison)
    monkeypatch.setitem(main.app.dependency_overrides, main._req_uid, lambda: uid)

    async def send():
        path = f"/api/chat/sessions/{session_id}/messages" + ("/stream" if streamed else "")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://fixture.test") as client:
            return await client.post(path, json={
                "text": question,
                "client_message_id": "first-recommendation",
                "compare_products": True,
                "include_media": True,
                "client_context": {"locale": "zh-CN"},
            })

    response = asyncio.run(send())
    assert response.status_code == 200, response.text
    if streamed:
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert events[-1]["type"] == "done"
        payload = events[-1]
    else:
        payload = response.json()
    reply, = payload["ai_messages"]
    saved, = [row for row in sb.message_inserts if row["id"] == reply["id"]]
    transition = reply["transition"]
    assert {key: value for key, value in saved["transition"].items() if not key.startswith("_")} == transition
    if kind == "video":
        assert transition["kind"] == "chat_media"
        card, = transition["items"]
        assert card["url"] == "https://www.youtube.com/watch?v=abcdefghijk"
        assert card["thumbnail_url"].startswith("https://i.ytimg.com/")
        assert card["video_id"] == "abcdefghijk"
        assert any("13个月" in request.query for request in calls)
        assert all("测试宝宝" not in request.query and child["birth_date"] not in request.query for request in calls)
    else:
        assert transition["kind"] == "product_comparison"
        assert transition["status"] == "ready"
        offer, = [row for row in transition["offers"] if row["title"] == "Dear Zoo"]
        assert "9781416947370" in offer["url"]
        assert offer["image_url"].startswith("https://")
        assert (offer["price_amount"], offer["currency"]) == ("7.99", "USD")
