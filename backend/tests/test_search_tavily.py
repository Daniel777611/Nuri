"""Unit tests for the Tavily adapter.

No network: httpx is served by a MockTransport, so the request Tavily would
receive and the response it would send are both asserted directly. What's being
protected is the contract the rest of the search path relies on — a provider
fetches and nothing more, and never raises on the chat path.
"""
import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.search_tavily import TavilySearchProvider  # noqa: E402
from backend.websearch import (  # noqa: E402
    NullSearchProvider,
    SearchRequest,
    available_providers,
    get_provider,
)

OK_BODY = {
    "results": [
        {
            "title": "Starting Solid Foods",
            "url": "https://www.healthychildren.org/English/ages-stages/baby/feeding",
            "content": "Most babies are ready for solids around six months...",
            "score": 0.97,
            "published_date": "2024-03-01",
        },
        {
            "title": "Introducing solids",
            "url": "https://www.nhs.uk/start4life/weaning/",
            "content": "Weaning guidance.",
        },
    ]
}


def _provider(handler, **kwargs):
    """A provider plus an AsyncClient factory whose calls `handler` serves."""
    provider = TavilySearchProvider(api_key="test-key", **kwargs)
    transport = httpx.MockTransport(handler)
    original = httpx.AsyncClient

    def patched(*a, **kw):
        kw["transport"] = transport
        return original(*a, **kw)

    return provider, patched


def _search(provider, patched, request):
    """Run a search with httpx.AsyncClient swapped for the mocked one."""
    import backend.search_tavily as mod

    real = mod.httpx.AsyncClient
    mod.httpx.AsyncClient = patched
    try:
        return asyncio.run(provider.search(request))
    finally:
        mod.httpx.AsyncClient = real


REQ = SearchRequest(query="4 month old solids", lang="en", max_results=5)


# ── Request shaping ──────────────────────────────────────────────────────────

def test_domain_lists_are_sent_as_native_parameters():
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json=OK_BODY)

    p, patched = _provider(handler)
    _search(p, patched, SearchRequest(
        query="q", lang="en",
        include_domains=("cdc.gov", "healthychildren.org"),
        exclude_domains=("baijiahao.baidu.com",),
    ))
    assert seen["include_domains"] == ["cdc.gov", "healthychildren.org"]
    assert seen["exclude_domains"] == ["baijiahao.baidu.com"]


def test_empty_domain_lists_are_omitted_entirely():
    """An empty include_domains can mean 'search nowhere' rather than
    'search everywhere', which is not a thing to discover in production."""
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json=OK_BODY)

    p, patched = _provider(handler)
    _search(p, patched, REQ)
    assert "include_domains" not in seen
    assert "exclude_domains" not in seen


def test_answer_and_raw_content_are_declined():
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json=OK_BODY)

    p, patched = _provider(handler)
    _search(p, patched, REQ)
    assert seen["include_answer"] is False
    assert seen["include_raw_content"] is False


def test_api_key_goes_in_the_authorization_header():
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json=OK_BODY)

    p, patched = _provider(handler)
    _search(p, patched, REQ)
    assert seen["auth"] == "Bearer test-key"


def test_max_results_is_capped():
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json=OK_BODY)

    p, patched = _provider(handler)
    _search(p, patched, SearchRequest(query="q", lang="en", max_results=500))
    assert seen["max_results"] <= 20


# ── Response parsing ─────────────────────────────────────────────────────────

def test_results_are_mapped_onto_searchresult():
    p, patched = _provider(lambda r: httpx.Response(200, json=OK_BODY))
    out = _search(p, patched, REQ)
    assert [r.title for r in out] == ["Starting Solid Foods", "Introducing solids"]
    assert out[0].snippet.startswith("Most babies")
    assert out[0].published_at == "2024-03-01"


def test_language_comes_from_the_request_not_a_guess():
    """The planner already decided which language pass this was."""
    p, patched = _provider(lambda r: httpx.Response(200, json=OK_BODY))
    out = _search(p, patched, SearchRequest(query="副食品", lang="zh"))
    assert all(r.lang == "zh" for r in out)


def test_the_provider_does_not_assert_trust():
    """Tier and site_name are stamped later by websearch.annotate(), so a vendor
    swap can't change which sources count as authoritative."""
    p, patched = _provider(lambda r: httpx.Response(200, json=OK_BODY))
    out = _search(p, patched, REQ)
    assert all(r.tier == "neutral" and r.site_name == "" for r in out)


def test_results_without_a_url_are_dropped():
    body = {"results": [{"title": "no url", "content": "x"}, OK_BODY["results"][0]]}
    p, patched = _provider(lambda r: httpx.Response(200, json=body))
    assert len(_search(p, patched, REQ)) == 1


def test_missing_title_falls_back_to_the_url():
    body = {"results": [{"url": "https://cdc.gov/a"}]}
    p, patched = _provider(lambda r: httpx.Response(200, json=body))
    assert _search(p, patched, REQ)[0].title == "https://cdc.gov/a"


@pytest.mark.parametrize("body", [{}, {"results": None}, {"results": "nope"}, []])
def test_unexpected_response_shapes_yield_nothing(body):
    p, patched = _provider(lambda r: httpx.Response(200, json=body))
    assert _search(p, patched, REQ) == []


# ── Failure never reaches the chat path ──────────────────────────────────────

@pytest.mark.parametrize("status", [401, 402, 429, 500, 503])
def test_http_errors_return_no_results_rather_than_raising(status):
    p, patched = _provider(lambda r: httpx.Response(status, text="denied"))
    assert _search(p, patched, REQ) == []


def test_a_network_error_returns_no_results():
    def handler(request):
        raise httpx.ConnectError("no route to host")

    p, patched = _provider(handler)
    assert _search(p, patched, REQ) == []


def test_invalid_json_returns_no_results():
    p, patched = _provider(lambda r: httpx.Response(200, text="<html>nope</html>"))
    assert _search(p, patched, REQ) == []


def test_a_missing_key_returns_no_results_without_calling_out():
    called = []

    def handler(request):
        called.append(1)
        return httpx.Response(200, json=OK_BODY)

    p, patched = _provider(handler)
    p.api_key = ""
    assert _search(p, patched, REQ) == []
    assert called == [], "should not spend a request without a key"


# ── Registration ─────────────────────────────────────────────────────────────

def test_tavily_is_reachable_by_name_without_a_manual_import():
    """websearch lazily imports this module, so WEB_SEARCH_PROVIDER=tavily
    works whether or not anything else imported it first."""
    assert "tavily" in available_providers()
    assert get_provider("tavily").name == "tavily"


def test_an_unknown_provider_falls_back_to_null_never_to_stub():
    """Placeholder text reaching a parent is worse than showing no links."""
    fallback = get_provider("definitely-not-a-provider")
    assert isinstance(fallback, NullSearchProvider)
    assert fallback.name == "null"


def test_null_provider_searches_nothing():
    assert asyncio.run(NullSearchProvider().search(REQ)) == []
