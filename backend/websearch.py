"""External web search: provider abstraction, trust tiering, result ranking.

Wired into the chat turn through `_reply_context`, as one more parallel
context block.

The shape:

    mini router decides {needs_search, query, scope, is_medical}
        -> plan_requests()   turns that into 1-2 provider calls carrying
                             include/exclude domain lists
        -> provider.search() the only vendor-specific code in the system
        -> rank_results()    authority first, preferred language first,
                             blocked domains dropped a second time

No provider is bound by default: `WEB_SEARCH_PROVIDER` is "null" until someone
sets it, which reproduces the system's behaviour before external sources
existed. Setting it to "stub" gives deterministic fake results that still honour
the include/exclude lists, so the whole chain above can be exercised locally
without a vendor key. The stub is never a fallback — only ever an explicit
choice — because placeholder text reaching a real parent is worse than no links.

Design rules that outlive whichever vendor wins:
  * A provider only ever fetches. Trust decisions live here, in shared code, so
    swapping vendors can't quietly change which sources a parent sees.
  * Blocked domains are filtered after the provider answers as well as before.
    A provider that ignores `exclude_domains` must not be able to surface a
    content farm.
  * Failure is always an empty list, never an exception. A turn without links
    is fine; a turn that 500s because a search vendor was slow is not.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field, replace
from typing import Callable, Iterable, Literal, Optional, Protocol, Sequence
from urllib.parse import urlsplit

try:  # Matches main.py: blocking work shares anyio's process-wide thread limiter.
    import anyio
except ImportError:  # pragma: no cover - anyio ships with FastAPI
    anyio = None  # type: ignore[assignment]


# ── Types ────────────────────────────────────────────────────────────────────

Tier = Literal["authority", "good", "neutral", "blocked"]
Lang = Literal["en", "zh"]
Scope = Literal["en", "zh", "both"]

#: Rank order for sorting. Lower sorts first. "blocked" never reaches a sort.
_TIER_RANK: dict[str, int] = {"authority": 0, "good": 1, "neutral": 2}

#: How long a whole search step may take before the turn gives up on links.
#: This sits in front of the parent's first visible token, so it wants to be as
#: small as it can be — but measured against Tavily, a single pass runs
#: 1.9-2.3s for a short query, but 4-5.5s once a domain include-list and a
#: longer query are involved — 2.5s and 4.0s both timed out on real turns.
DEFAULT_TIMEOUT_S = float(os.getenv("WEB_SEARCH_TIMEOUT_S", "6.0"))

#: Results handed to the prompt after ranking. Three, because this — not the
#: domain list — is what Tavily's latency tracks: measured at 2.3-2.4s for five
#: results and 0.72-0.74s for three, with or without an include-list. The best
#: replies cited three sources anyway, so the extra two bought nothing but a
#: second and a half in front of the parent's first token.
DEFAULT_MAX_RESULTS = int(os.getenv("WEB_SEARCH_MAX_RESULTS", "3"))

#: When true, general (non-medical) questions search the open web minus the
#: block-list instead of the curated authority+good list. Off by default — see
#: plan_requests() for what the open web actually returned when tried.
ALLOW_OPEN_WEB = os.getenv("WEB_SEARCH_ALLOW_OPEN_WEB", "0") not in ("0", "", "false", "False")


@dataclass(frozen=True)
class SearchResult:
    """One citable source. `site_name` and `tier` are filled in by
    :func:`annotate`, not by the provider — see the module docstring."""

    title: str
    url: str
    snippet: str = ""
    lang: Lang = "en"
    published_at: str = ""
    site_name: str = ""
    tier: Tier = "neutral"

    @property
    def host(self) -> str:
        return registrable_host(self.url)


@dataclass(frozen=True)
class SearchRequest:
    """A single provider call. One request never mixes languages: two languages
    means two requests, so each can carry its own domain list and so a slow or
    empty pass in one language can't take the other down with it."""

    query: str
    lang: Lang = "en"
    include_domains: tuple[str, ...] = ()
    exclude_domains: tuple[str, ...] = ()
    max_results: int = DEFAULT_MAX_RESULTS


@dataclass(frozen=True)
class DomainRules:
    """The `source_domains` table, shaped for lookup."""

    tiers: dict[str, Tier] = field(default_factory=dict)
    names: dict[str, str] = field(default_factory=dict)
    langs: dict[str, str] = field(default_factory=dict)

    def _match(self, host: str) -> Optional[str]:
        """Longest matching suffix, so a rule on `baijiahao.baidu.com` wins over
        one on `baidu.com` rather than being shadowed by it."""
        best: Optional[str] = None
        for domain in self.tiers:
            if host == domain or host.endswith("." + domain):
                if best is None or len(domain) > len(best):
                    best = domain
        return best

    def tier_of(self, host: str) -> Tier:
        match = self._match(host)
        return self.tiers[match] if match else "neutral"

    def name_of(self, host: str) -> str:
        match = self._match(host)
        return (self.names.get(match) or "") if match else ""

    def domains(self, tier: Tier, lang: Optional[str] = None) -> tuple[str, ...]:
        """Domains at `tier`, optionally limited to one language. Rows marked
        'any' are always included."""
        out = [
            d for d, t in self.tiers.items()
            if t == tier and (lang is None or self.langs.get(d, "any") in (lang, "any"))
        ]
        return tuple(sorted(out))


EMPTY_RULES = DomainRules()


# ── Provider abstraction ─────────────────────────────────────────────────────

class SearchProvider(Protocol):
    """The entire vendor surface. Implementations translate a SearchRequest into
    one API call and the response into SearchResults — nothing else. They must
    not rank, must not decide trust, and must not raise: an unreachable vendor
    returns an empty list."""

    name: str

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        ...


ProviderFactory = Callable[[], SearchProvider]
_REGISTRY: dict[str, ProviderFactory] = {}

#: Adapters imported on demand, so `WEB_SEARCH_PROVIDER=tavily` works without
#: anyone remembering to import the module for its registration side effect.
#: Forgetting that import would silently fall back to no search at all.
_LAZY_PROVIDERS: dict[str, str] = {"tavily": ".search_tavily"}


def register_provider(name: str, factory: ProviderFactory) -> None:
    _REGISTRY[name] = factory


def available_providers() -> tuple[str, ...]:
    return tuple(sorted(set(_REGISTRY) | set(_LAZY_PROVIDERS)))


def _ensure_registered(key: str) -> None:
    module = _LAZY_PROVIDERS.get(key)
    if key in _REGISTRY or not module:
        return
    try:
        import importlib

        importlib.import_module(module, package=__package__)
    except Exception as e:
        print(f"[error] search provider {key!r} failed to load: {type(e).__name__}: {e}")


def get_provider(name: Optional[str] = None) -> SearchProvider:
    """Resolve the configured provider.

    An unresolvable name falls back to `null` — no search — and never to `stub`.
    Stub results are placeholder text; putting them in front of a parent because
    an env var was misspelled would be far worse than showing no links, so the
    stub is only ever used when it is asked for by name.
    """
    key = name or os.getenv("WEB_SEARCH_PROVIDER", "null")
    _ensure_registered(key)
    factory = _REGISTRY.get(key)
    if not factory:
        print(f"[error] search provider {key!r} unavailable; no sources this turn")
        factory = _REGISTRY["null"]
    return factory()


# ── Stub provider ────────────────────────────────────────────────────────────

class NullSearchProvider:
    """Searches nothing. The default, and the fallback whenever a configured
    provider can't be resolved — the system's behaviour before external sources
    existed, which is always a safe place to land."""

    name = "null"

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        return []


register_provider("null", NullSearchProvider)


class StubSearchProvider:
    """Deterministic fake results for local runs and tests.

    It honours include/exclude so the planning and ranking code downstream is
    genuinely exercised rather than merely executed: results are minted on the
    include-list when there is one, and never on the exclude-list.
    """

    name = "stub"

    #: Stand-ins used when a request carries no include-list. Chosen to span
    #: tiers so ranking has something to actually sort.
    _OPEN_HOSTS: dict[str, tuple[str, ...]] = {
        "en": ("healthychildren.org", "babycenter.com", "example-parenting-blog.com"),
        "zh": ("dxy.com", "haodf.com", "example-mama-blog.cn"),
    }

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        hosts: Sequence[str] = request.include_domains or self._OPEN_HOSTS.get(request.lang, ())
        excluded = set(request.exclude_domains)
        picked = [h for h in hosts if h not in excluded][: request.max_results]
        label = "Search result" if request.lang == "en" else "搜索结果"
        return [
            SearchResult(
                title=f"[stub] {label} {i + 1}: {request.query}",
                url=f"https://{host}/stub/{i + 1}",
                snippet=(
                    f"[stub] Placeholder snippet for {request.query!r} from {host}. "
                    "Replace WEB_SEARCH_PROVIDER with a real provider to get live sources."
                ),
                lang=request.lang,
            )
            for i, host in enumerate(picked)
        ]


register_provider("stub", StubSearchProvider)


# ── Domain rules ─────────────────────────────────────────────────────────────

_RULES_TTL_S = float(os.getenv("SOURCE_DOMAINS_TTL_S", "300"))
_rules_cache: Optional[DomainRules] = None
_rules_cached_at: float = 0.0


def _read_domain_rows(sb) -> list[dict]:
    return (
        sb.table("source_domains")
        .select("domain,tier,lang,site_name")
        .eq("active", True)
        .execute()
        .data
        or []
    )


def rules_from_rows(rows: Iterable[dict]) -> DomainRules:
    tiers: dict[str, Tier] = {}
    names: dict[str, str] = {}
    langs: dict[str, str] = {}
    for row in rows:
        domain = (row.get("domain") or "").strip().lower().lstrip(".")
        tier = row.get("tier")
        if not domain or tier not in ("authority", "good", "neutral", "blocked"):
            continue
        if domain.startswith("www."):
            domain = domain[4:]
        tiers[domain] = tier  # type: ignore[assignment]
        names[domain] = (row.get("site_name") or "").strip()
        langs[domain] = (row.get("lang") or "any").strip().lower()
    return DomainRules(tiers=tiers, names=names, langs=langs)


def clear_rules_cache() -> None:
    """Drop the cached table. Call after an admin edit so a bad source stops
    being cited immediately rather than up to the TTL later."""
    global _rules_cache, _rules_cached_at
    _rules_cache = None
    _rules_cached_at = 0.0


async def load_domain_rules(sb, *, ttl_s: float = _RULES_TTL_S) -> DomainRules:
    """Read `source_domains`, cached. The table changes rarely and this would
    otherwise be a database round trip on the critical path of every turn.

    Returns empty rules when Supabase is unavailable — which means no
    include-list and no block-list, so callers must treat "no rules" as a reason
    to stay off medical topics rather than as an open door. See
    :func:`plan_requests`.
    """
    global _rules_cache, _rules_cached_at
    now = time.monotonic()
    if _rules_cache is not None and (now - _rules_cached_at) < ttl_s:
        return _rules_cache
    if not sb:
        return EMPTY_RULES
    try:
        if anyio is not None:
            rows = await anyio.to_thread.run_sync(lambda: _read_domain_rows(sb))
        else:  # pragma: no cover
            rows = await asyncio.to_thread(_read_domain_rows, sb)
    except Exception as e:
        print(f"[warn] load_domain_rules: {e}")
        # Serve a stale copy over none: yesterday's block-list beats no list.
        return _rules_cache if _rules_cache is not None else EMPTY_RULES
    _rules_cache = rules_from_rows(rows)
    _rules_cached_at = now
    return _rules_cache


# ── URL helpers ──────────────────────────────────────────────────────────────

def registrable_host(url: str) -> str:
    """Lowercased host with any leading `www.` removed. Not a public-suffix
    parse — rules are written as the host they should match, and matching is
    suffix-based, so `cdc.gov` covers `www.cdc.gov` and `wwwn.cdc.gov` alike."""
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


# ── Planning ─────────────────────────────────────────────────────────────────

def plan_requests(
    query: str,
    *,
    scope: Scope = "both",
    is_medical: bool = False,
    rules: DomainRules = EMPTY_RULES,
    max_results: int = DEFAULT_MAX_RESULTS,
    zh_query: Optional[str] = None,
) -> list[SearchRequest]:
    """Turn the router's decision into provider calls.

    English leads by product decision: the differentiating value for North
    American Chinese-speaking parents is reaching AAP/CDC-grade guidance they
    can't read in the original, so the English pass comes first and, on medical
    questions, is the one restricted to vetted institutions.

    Medical/safety questions are confined to the `authority` tier. If the table
    is unreachable there is no authority list to confine them to, so no medical
    request is planned at all — an ungrounded answer is better than one
    citing whatever the open web returned about a feverish infant.

    General questions are confined to `authority` + `good`. That is a stronger
    restriction than the original design, and it was earned: an open-web pass
    for "4 month old refusing solids" came back with two Instagram reels, a
    Florida county government page and a doctor-booking site, and not one vetted
    source. Curated-first is not a marginal quality gain here. Set
    WEB_SEARCH_ALLOW_OPEN_WEB=1 to go back to searching everything minus the
    block-list — the table stays editable without a deploy either way.
    """
    query = (query or "").strip()
    zh_query = (zh_query or "").strip()
    if not query and not zh_query:
        return []

    langs: list[Lang] = {"en": ["en"], "zh": ["zh"], "both": ["en", "zh"]}[scope]
    blocked = rules.domains("blocked")
    out: list[SearchRequest] = []

    for lang in langs:
        # Each pass falls back to the other language's text rather than being
        # skipped: the router may only produce one of the two, and a Chinese
        # query against English sources still beats no search at all.
        text = (zh_query or query) if lang == "zh" else (query or zh_query)
        if not text:
            continue
        if is_medical:
            include = rules.domains("authority", lang)
            if not include:
                continue
            out.append(SearchRequest(
                query=text, lang=lang, include_domains=include, max_results=max_results,
            ))
            continue

        include = () if ALLOW_OPEN_WEB else (
            rules.domains("authority", lang) + rules.domains("good", lang)
        )
        out.append(SearchRequest(
            query=text, lang=lang,
            include_domains=include,
            # Still sent alongside an include-list: belt and braces costs
            # nothing, and the two lists are maintained by different people at
            # different times.
            exclude_domains=blocked,
            max_results=max_results,
        ))
    return out


# ── Annotation & ranking ─────────────────────────────────────────────────────

def annotate(results: Iterable[SearchResult], rules: DomainRules) -> list[SearchResult]:
    """Stamp each result with the tier and display name for its host. Providers
    don't get to assert either — that's what keeps trust decisions in one place
    when a vendor is swapped."""
    out = []
    for r in results:
        host = r.host
        out.append(replace(
            r,
            tier=rules.tier_of(host),
            site_name=rules.name_of(host) or r.site_name or host,
        ))
    return out


def rank_results(
    results: Iterable[SearchResult],
    *,
    rules: DomainRules = EMPTY_RULES,
    prefer_lang: Lang = "en",
    max_results: int = DEFAULT_MAX_RESULTS,
) -> list[SearchResult]:
    """Annotate, drop blocked and duplicate sources, then sort.

    Order is tier, then preferred language, then the order the provider gave —
    a stable sort, so within a tier the vendor's own relevance judgement is
    preserved rather than being scrambled by a tiebreaker of ours.
    """
    seen: set[str] = set()
    keep: list[SearchResult] = []
    for r in annotate(results, rules):
        if r.tier == "blocked" or not r.url:
            continue
        key = r.url.rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        keep.append(r)

    keep.sort(key=lambda r: (
        _TIER_RANK.get(r.tier, len(_TIER_RANK)),
        0 if r.lang == prefer_lang else 1,
    ))
    return keep[:max_results]


# ── Top-level entry point ────────────────────────────────────────────────────

async def search_sources(
    query: str,
    *,
    scope: Scope = "both",
    is_medical: bool = False,
    sb=None,
    provider: Optional[SearchProvider] = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    max_results: int = DEFAULT_MAX_RESULTS,
    zh_query: Optional[str] = None,
) -> list[SearchResult]:
    """Plan, fetch and rank in one call. Never raises and never blocks past
    `timeout_s`; a timeout, a dead vendor or an empty index all come back the
    same way, as no sources.

    The language passes run concurrently and are gathered with
    `return_exceptions=True`, so one failing pass still lets the other's results
    through instead of losing the whole step.
    """
    rules = await load_domain_rules(sb)
    requests = plan_requests(
        query, scope=scope, is_medical=is_medical, rules=rules,
        max_results=max_results, zh_query=zh_query,
    )
    if not requests:
        return []

    engine = provider or get_provider()

    async def run_all() -> list[SearchResult]:
        batches = await asyncio.gather(
            *(engine.search(r) for r in requests), return_exceptions=True
        )
        merged: list[SearchResult] = []
        for request, batch in zip(requests, batches):
            if isinstance(batch, BaseException):
                print(f"[warn] search failed ({engine.name}, {request.lang}): "
                      f"{type(batch).__name__}: {batch}")
                continue
            merged.extend(batch)
        return merged

    try:
        merged = await asyncio.wait_for(run_all(), timeout=timeout_s)
    except asyncio.TimeoutError:
        print(f"[warn] search timed out after {timeout_s}s ({engine.name})")
        return []
    except Exception as e:
        print(f"[warn] search step failed ({engine.name}): {type(e).__name__}: {e}")
        return []

    prefer: Lang = "zh" if scope == "zh" else "en"
    return rank_results(merged, rules=rules, prefer_lang=prefer, max_results=max_results)


# ── Prompt rendering ─────────────────────────────────────────────────────────

def sources_prompt_block(results: Sequence[SearchResult]) -> str:
    """Render sources as the numbered allow-list the model cites from.

    The numbering is the whole point: the model cites [1]/[2], and those indices
    map back to real URLs the search returned. It never writes a URL itself,
    which is the one rule that keeps a parenting app from linking a parent to a
    hallucinated medical page.
    """
    if not results:
        return ""
    lines = []
    for i, r in enumerate(results, 1):
        label = r.site_name or r.host
        if r.tier == "authority":
            label += "，权威机构"
        snippet = (r.snippet or "").strip().replace("\n", " ")
        if len(snippet) > 400:
            snippet = snippet[:400] + "…"
        lines.append(f"[{i}] {r.title}（{label}）\n    {snippet}")
    return (
        "以下是本轮检索到的外部来源。规则：\n"
        "- 只能引用这个清单里的来源，在正文中用 [1] [2] 标注\n"
        "- 绝对不要自己写 URL，也不要修改这里的任何一个链接\n"
        "- 没有合适的来源就不要引用，宁可不给也不要给错\n"
        "- 这些是外部网页，属于最弱的一层依据，不得推翻内部知识库的准则\n"
        "- 英文来源必须用家长的语言转述，并点名机构（例如“美国儿科学会（AAP）建议……”）\n"
        "- 中英文来源说法冲突时，明确讲清楚分歧存在，不要假装只有一种说法\n\n"
        + "\n".join(lines)
    )
