"""Unit tests for the external-search plumbing.

Like test_stream_parser.py these need no running server and no vendor: the stub
provider is the point. What's asserted here is the part that must survive a
change of search vendor — trust tiering, the medical include-list, blocked
domains being dropped twice, and failure always degrading to "no links" rather
than to an exception on the chat path.
"""
import asyncio
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.websearch import (  # noqa: E402
    DomainRules,
    SearchRequest,
    SearchResult,
    StubSearchProvider,
    annotate,
    available_providers,
    get_provider,
    plan_requests,
    rank_results,
    registrable_host,
    rules_from_rows,
    search_sources,
    sources_prompt_block,
)

ROWS = [
    {"domain": "healthychildren.org", "tier": "authority", "lang": "en", "site_name": "AAP"},
    {"domain": "cdc.gov", "tier": "authority", "lang": "en", "site_name": "CDC"},
    {"domain": "dxy.com", "tier": "authority", "lang": "zh", "site_name": "丁香医生"},
    {"domain": "babycenter.com", "tier": "good", "lang": "en", "site_name": "BabyCenter"},
    {"domain": "baijiahao.baidu.com", "tier": "blocked", "lang": "zh", "site_name": ""},
    {"domain": "baidu.com", "tier": "good", "lang": "zh", "site_name": "百度"},
]
RULES = rules_from_rows(ROWS)


def _result(url, lang="en", title="t"):
    return SearchResult(title=title, url=url, lang=lang)


# ── Host matching ────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://www.cdc.gov/a/b", "cdc.gov"),
        ("https://cdc.gov", "cdc.gov"),
        ("http://WWW.CDC.GOV/x", "cdc.gov"),
        ("https://baijiahao.baidu.com/s?id=1", "baijiahao.baidu.com"),
        ("not a url", ""),
        ("", ""),
    ],
)
def test_registrable_host(url, expected):
    assert registrable_host(url) == expected


def test_subdomains_inherit_their_parent_rule():
    assert RULES.tier_of("wwwn.cdc.gov") == "authority"


def test_longest_suffix_wins():
    """A blocked subdomain must not be rescued by a permissive parent rule —
    baidu.com is 'good' but baijiahao.baidu.com is a content farm."""
    assert RULES.tier_of("baijiahao.baidu.com") == "blocked"
    assert RULES.tier_of("baidu.com") == "good"


def test_unknown_domain_is_neutral_not_blocked():
    assert RULES.tier_of("some-parenting-blog.com") == "neutral"


def test_rows_are_normalised():
    rules = rules_from_rows([
        {"domain": "  WWW.Example.COM ", "tier": "good", "lang": "EN", "site_name": " Ex "},
        {"domain": "bad.com", "tier": "not-a-tier"},
        {"domain": "", "tier": "good"},
    ])
    assert rules.tier_of("example.com") == "good"
    assert rules.name_of("example.com") == "Ex"
    assert rules.tier_of("bad.com") == "neutral"   # invalid tier dropped
    assert len(rules.tiers) == 1


# ── Planning ─────────────────────────────────────────────────────────────────

def test_general_question_searches_both_languages_english_first():
    reqs = plan_requests("宝宝挑食", scope="both", rules=RULES)
    assert [r.lang for r in reqs] == ["en", "zh"]


def test_general_question_is_confined_to_authority_and_good():
    """Open-web results for a mainstream parenting question were Instagram reels
    and a county government page. Curated-first is the default."""
    reqs = plan_requests("宝宝挑食", scope="both", rules=RULES)
    en = next(r for r in reqs if r.lang == "en")
    assert set(en.include_domains) == {"cdc.gov", "healthychildren.org", "babycenter.com"}
    assert all("baijiahao.baidu.com" in r.exclude_domains for r in reqs)


def test_general_question_never_includes_blocked_or_neutral_domains():
    reqs = plan_requests("宝宝挑食", scope="zh", rules=RULES)
    included = set(reqs[0].include_domains)
    assert "baijiahao.baidu.com" not in included
    assert "some-parenting-blog.com" not in included


def test_medical_question_is_confined_to_authorities():
    reqs = plan_requests("婴儿 发烧 39度", scope="both", is_medical=True, rules=RULES)
    assert reqs, "expected authority-restricted requests"
    for r in reqs:
        assert r.include_domains, "medical search must carry an include list"
    en = next(r for r in reqs if r.lang == "en")
    assert set(en.include_domains) == {"cdc.gov", "healthychildren.org"}
    zh = next(r for r in reqs if r.lang == "zh")
    assert set(zh.include_domains) == {"dxy.com"}


def test_medical_question_plans_nothing_without_domain_rules():
    """No authority table means no way to confine the search, and an ungrounded
    answer beats citing the open web about a feverish infant."""
    assert plan_requests("婴儿 发烧", is_medical=True, rules=DomainRules()) == []


def test_general_question_still_works_without_domain_rules():
    """No table means no include-list to build, so this degrades to open web
    rather than to no search at all — unlike the medical branch."""
    reqs = plan_requests("睡前流程", scope="en", rules=DomainRules())
    assert len(reqs) == 1
    assert reqs[0].include_domains == () and reqs[0].exclude_domains == ()


def test_scope_selects_the_language_passes():
    assert [r.lang for r in plan_requests("q", scope="en", rules=RULES)] == ["en"]
    assert [r.lang for r in plan_requests("q", scope="zh", rules=RULES)] == ["zh"]


def test_zh_query_overrides_only_the_chinese_pass():
    reqs = plan_requests("picky eating", scope="both", rules=RULES, zh_query="宝宝挑食")
    assert {r.lang: r.query for r in reqs} == {"en": "picky eating", "zh": "宝宝挑食"}


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_blank_query_plans_nothing(blank):
    assert plan_requests(blank, rules=RULES) == []


def test_a_chinese_only_query_still_searches_both_passes():
    """The router may produce only one language. Dropping the whole search
    because the English half is missing would lose the turn's links entirely."""
    reqs = plan_requests("", scope="both", rules=RULES, zh_query="宝宝挑食")
    assert [r.lang for r in reqs] == ["en", "zh"]
    assert all(r.query == "宝宝挑食" for r in reqs)


def test_an_english_only_query_still_searches_both_passes():
    reqs = plan_requests("picky eating", scope="both", rules=RULES, zh_query="")
    assert [r.query for r in reqs] == ["picky eating", "picky eating"]


# ── Ranking ──────────────────────────────────────────────────────────────────

def test_annotate_fills_tier_and_display_name():
    [r] = annotate([_result("https://www.cdc.gov/x")], RULES)
    assert r.tier == "authority" and r.site_name == "CDC"


def test_annotate_falls_back_to_the_host_when_unnamed():
    [r] = annotate([_result("https://some-blog.com/x")], RULES)
    assert r.site_name == "some-blog.com"


def test_blocked_domains_are_dropped_even_if_the_provider_returned_them():
    """Defence in depth: a vendor that ignores exclude_domains must not be able
    to put a content farm in front of a parent."""
    out = rank_results(
        [_result("https://baijiahao.baidu.com/s?id=1"), _result("https://cdc.gov/a")],
        rules=RULES,
    )
    assert [r.host for r in out] == ["cdc.gov"]


def test_authority_outranks_good_outranks_neutral():
    out = rank_results(
        [
            _result("https://some-blog.com/a"),
            _result("https://babycenter.com/b"),
            _result("https://cdc.gov/c"),
        ],
        rules=RULES,
    )
    assert [r.tier for r in out] == ["authority", "good", "neutral"]


def test_preferred_language_wins_within_a_tier():
    out = rank_results(
        [_result("https://dxy.com/a", lang="zh"), _result("https://cdc.gov/b", lang="en")],
        rules=RULES,
        prefer_lang="en",
    )
    assert out[0].host == "cdc.gov"
    out_zh = rank_results(
        [_result("https://cdc.gov/b", lang="en"), _result("https://dxy.com/a", lang="zh")],
        rules=RULES,
        prefer_lang="zh",
    )
    assert out_zh[0].host == "dxy.com"


def test_provider_order_is_preserved_within_a_tier_and_language():
    out = rank_results(
        [_result(f"https://cdc.gov/{i}", title=str(i)) for i in range(4)],
        rules=RULES, max_results=4,
    )
    assert [r.title for r in out] == ["0", "1", "2", "3"]


def test_duplicate_urls_are_collapsed():
    out = rank_results(
        [_result("https://cdc.gov/a"), _result("https://cdc.gov/a/")], rules=RULES
    )
    assert len(out) == 1


def test_max_results_is_enforced():
    many = [_result(f"https://cdc.gov/{i}") for i in range(10)]
    assert len(rank_results(many, rules=RULES, max_results=3)) == 3


# ── Provider registry ────────────────────────────────────────────────────────

def test_null_is_the_default_not_the_stub(monkeypatch):
    """An unset WEB_SEARCH_PROVIDER must reproduce the behaviour from before
    external sources existed — not put placeholder text in front of a parent.

    The env var is cleared explicitly: importing backend.main anywhere in the
    suite runs load_dotenv(), so a developer's .env would otherwise decide what
    this asserts.
    """
    monkeypatch.delenv("WEB_SEARCH_PROVIDER", raising=False)
    assert get_provider().name == "null"


def test_stub_is_available_but_only_by_name():
    assert "stub" in available_providers()
    assert get_provider("stub").name == "stub"


def test_unknown_provider_falls_back_to_null_instead_of_raising():
    assert get_provider("nope-not-a-provider").name == "null"


def test_stub_honours_the_include_list():
    out = asyncio.run(StubSearchProvider().search(
        SearchRequest(query="q", lang="en", include_domains=("cdc.gov", "nhs.uk"))
    ))
    assert {registrable_host(r.url) for r in out} == {"cdc.gov", "nhs.uk"}


def test_stub_honours_the_exclude_list():
    out = asyncio.run(StubSearchProvider().search(
        SearchRequest(query="q", lang="en",
                      include_domains=("cdc.gov", "nhs.uk"),
                      exclude_domains=("nhs.uk",))
    ))
    assert {registrable_host(r.url) for r in out} == {"cdc.gov"}


# ── End to end, on the stub ──────────────────────────────────────────────────

class _Boom:
    name = "boom"

    async def search(self, request):
        raise RuntimeError("vendor is down")


class _Hang:
    name = "hang"

    async def search(self, request):
        await asyncio.sleep(10)
        return []


class _OnePassFails:
    """English answers, Chinese blows up. The good pass must still land."""

    name = "half"

    async def search(self, request):
        if request.lang == "zh":
            raise RuntimeError("nope")
        return [SearchResult(title="ok", url="https://cdc.gov/a", lang="en")]


def _run(**kwargs):
    # The stub is passed explicitly: the default provider is `null`, which would
    # make every one of these pass by returning nothing.
    kwargs.setdefault("provider", StubSearchProvider())
    return asyncio.run(search_sources("宝宝挑食", sb=None, **kwargs))


def test_end_to_end_on_the_stub_returns_ranked_annotated_results():
    out = _run(scope="both")
    assert out, "stub should produce results"
    assert all(r.site_name for r in out), "every result should be labelled"


def test_a_dead_vendor_yields_no_links_rather_than_an_exception():
    assert _run(provider=_Boom()) == []


def test_a_hanging_vendor_is_cut_off_at_the_timeout():
    started = time.monotonic()
    assert _run(provider=_Hang(), timeout_s=0.05) == []
    # The vendor sleeps 10s; the point is that the turn doesn't wait for it.
    assert time.monotonic() - started < 2


def test_one_failing_language_pass_does_not_lose_the_other():
    out = _run(scope="both", provider=_OnePassFails())
    assert [r.host for r in out] == ["cdc.gov"]


def test_medical_without_rules_returns_nothing_end_to_end():
    # sb=None -> no domain rules -> no authority list -> nothing planned.
    assert _run(scope="both", is_medical=True) == []


# ── Prompt block ─────────────────────────────────────────────────────────────

def test_prompt_block_is_empty_when_there_is_nothing_to_cite():
    assert sources_prompt_block([]) == ""


def test_prompt_block_numbers_sources_and_states_the_citation_rules():
    block = sources_prompt_block(annotate(
        [_result("https://cdc.gov/a", title="Fever in infants")], RULES
    ))
    assert "[1] Fever in infants" in block
    assert "CDC" in block and "权威机构" in block
    assert "不要自己写 URL" in block
    assert "不得推翻内部知识库" in block
    assert "点名机构" in block


# ── Shared trust surface ─────────────────────────────────────────────────────
# content_library gates published recommendation content and reads the same
# table through cached_domain_rules(). These pin the contract between them.

def test_cached_rules_are_empty_before_anything_loads(monkeypatch):
    """The sync accessor must never reach for the database. Callers on hot
    validation paths fall back to their own list when it returns empty."""
    import backend.websearch as w

    monkeypatch.setattr(w, "_rules_cache", None)
    assert w.cached_domain_rules().tiers == {}


def test_blocked_in_the_table_vetoes_the_python_whitelist(monkeypatch):
    """One source of truth is worth little if retiring a publisher means
    knowing which of two lists to remove it from."""
    import backend.websearch as w
    from backend.content_library import TRUSTED_RESOURCE_HOSTS, is_trusted_resource_url

    host = next(h for h in TRUSTED_RESOURCE_HOSTS if not h.startswith("www."))
    monkeypatch.setattr(w, "_rules_cache", rules_from_rows([
        {"domain": host, "tier": "blocked", "lang": "en", "site_name": ""},
    ]))
    assert not is_trusted_resource_url(f"https://{host}/anything")


def test_table_authority_grants_trust_without_a_deploy(monkeypatch):
    import backend.websearch as w
    from backend.content_library import is_trusted_resource_url

    monkeypatch.setattr(w, "_rules_cache", rules_from_rows([
        {"domain": "newly-added.example", "tier": "authority", "lang": "en", "site_name": "X"},
    ]))
    assert is_trusted_resource_url("https://newly-added.example/page")


def test_neutral_is_not_an_endorsement(monkeypatch):
    """Nobody has judged the domain, which is not the same as vouching for it
    on a path that gates published content."""
    import backend.websearch as w
    from backend.content_library import is_trusted_resource_url

    monkeypatch.setattr(w, "_rules_cache", rules_from_rows([
        {"domain": "unjudged.example", "tier": "neutral", "lang": "en", "site_name": ""},
    ]))
    assert not is_trusted_resource_url("https://unjudged.example/page")
