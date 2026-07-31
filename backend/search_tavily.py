"""Tavily adapter — the only vendor-specific code in the search path.

Loaded on demand by websearch.get_provider() when WEB_SEARCH_PROVIDER=tavily,
so nothing here runs unless it's asked for.

Its whole job is: SearchRequest in, SearchResult out. It does not rank, does not
decide which domains are trustworthy, and does not raise — all three live in
websearch.py so that swapping vendors cannot quietly change what a parent sees.

Configuration:
    TAVILY_API_KEY        required; without it this provider returns nothing
    WEB_SEARCH_PROVIDER   set to "tavily" to switch it on
    TAVILY_SEARCH_DEPTH   "basic" (default) or "advanced"
    TAVILY_TIMEOUT_S      per-request HTTP timeout
    TAVILY_API_URL        override for testing or a future endpoint change

Tavily is a good fit here because include/exclude domains are native request
parameters rather than `site:` string hacks, and because it returns cleaned
article text — so the snippet the model cites from needs no separate page fetch.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from .websearch import DEFAULT_TIMEOUT_S, SearchRequest, SearchResult, register_provider

TAVILY_API_URL = os.getenv("TAVILY_API_URL", "https://api.tavily.com/search")
TAVILY_SEARCH_DEPTH = os.getenv("TAVILY_SEARCH_DEPTH", "basic")
TAVILY_TIMEOUT_S = float(os.getenv("TAVILY_TIMEOUT_S", str(DEFAULT_TIMEOUT_S)))

#: Tavily caps this; asking for more than the ranking step will keep is just
#: latency spent on results that get truncated.
_MAX_RESULTS_CAP = 20


class TavilySearchProvider:
    name = "tavily"

    def __init__(self, api_key: str | None = None, api_url: str | None = None):
        self.api_key = api_key if api_key is not None else os.getenv("TAVILY_API_KEY", "")
        self.api_url = api_url or TAVILY_API_URL

    def _payload(self, request: SearchRequest) -> dict[str, Any]:
        body: dict[str, Any] = {
            "query": request.query,
            "max_results": min(request.max_results, _MAX_RESULTS_CAP),
            "search_depth": TAVILY_SEARCH_DEPTH,
            # Tavily can synthesise an answer and return full page HTML. Both
            # are declined: the answer would compete with NURI's own reply, and
            # raw content would blow up the prompt for no gain over the snippet.
            "include_answer": False,
            "include_raw_content": False,
        }
        # Sent only when non-empty. An empty include_domains is the difference
        # between "search everywhere" and "search nowhere" on some APIs, and
        # that is not a distinction worth discovering in production.
        if request.include_domains:
            body["include_domains"] = list(request.include_domains)
        if request.exclude_domains:
            body["exclude_domains"] = list(request.exclude_domains)
        return body

    def _parse(self, data: Any, request: SearchRequest) -> list[SearchResult]:
        """Read the response defensively: an unexpected shape should cost this
        turn its links, not raise inside a chat request."""
        results = (data or {}).get("results") if isinstance(data, dict) else None
        if not isinstance(results, list):
            return []
        out: list[SearchResult] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            url = (item.get("url") or "").strip()
            if not url:
                continue
            out.append(SearchResult(
                title=(item.get("title") or "").strip() or url,
                url=url,
                snippet=(item.get("content") or "").strip(),
                # The request's language, not a guess from the response: the
                # planner already decided which language pass this was.
                lang=request.lang,
                published_at=(item.get("published_date") or "").strip(),
            ))
        return out

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        if not self.api_key:
            print("[error] TAVILY_API_KEY is not set; no sources this turn")
            return []
        try:
            # A client per call rather than a module-level one: on serverless a
            # cached client outlives the event loop it was built for, and the
            # resulting reuse errors are miserable to diagnose.
            async with httpx.AsyncClient(timeout=TAVILY_TIMEOUT_S) as client:
                resp = await client.post(
                    self.api_url,
                    json=self._payload(request),
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                )
            if resp.status_code >= 400:
                # Body, truncated, because Tavily explains quota and key
                # problems there and the status alone doesn't distinguish them.
                print(f"[error] tavily HTTP {resp.status_code}: {resp.text[:300]}")
                return []
            return self._parse(resp.json(), request)
        except Exception as e:
            print(f"[error] tavily search failed: {type(e).__name__}: {e}")
            return []


register_provider("tavily", TavilySearchProvider)
