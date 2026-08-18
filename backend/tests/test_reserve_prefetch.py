"""The reserve bundle, and why the detail screen's swap button depends on it.

「换一个」 renders when `alternate_resource_pairs` is non-empty, and that field is
`pair_pool[1:]` — everything past the pair on screen. A primary bundle's floor is
one article and one video per category, which is exactly one pair, so without a
reserve there is never a second pair and the button never appears. That is what
"the refresh button is gone" was.

The loop was removed for a real reason — it fired on nearly every preparation and
was awaited inside the request — so it returns in a cheaper shape. These pin the
two things that make it cheaper, not merely the fact that it runs.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.feed import delivery as feed_delivery  # noqa: E402
from backend.tests.test_content_research import (  # noqa: E402
    _delivery_ready_parsed_bundle,
    _parsed_bundle,
)
from backend.tests.test_feed_prepare_failures import _PrepareHarness  # noqa: E402


def _reserve_bundle() -> dict:
    """Distinct URLs, so its resources widen the pool instead of being dropped
    as duplicates of the primary bundle's."""
    bundle = _delivery_ready_parsed_bundle()
    for resource in bundle.get("resources", []):
        resource["url"] = resource["url"].replace("https://", "https://alt.")
    return bundle


def test_a_reserve_is_fetched_so_a_second_pair_exists(monkeypatch):
    harness = _PrepareHarness(monkeypatch)
    harness.use_research_results(
        monkeypatch, _delivery_ready_parsed_bundle(), _reserve_bundle()
    )
    result = harness.run()

    assert result["resource_readiness"] == "ready"
    assert all(len(item["alternate_resource_pairs"]) >= 1 for item in result["items"])


def test_the_reserve_call_keeps_the_research_cache_reachable(monkeypatch):
    """`force=True` discarded cached successes as well as failures, so every
    preparation of the same topic paid full price. The cache keys on the card id,
    and a dynamic card's id hashes the session and the normalised topic — so
    `retry_failed` is what turns this from a per-reply cost into a per-topic one.
    """
    seen = []

    async def research(**kwargs):
        seen.append(kwargs)
        # Minimal primary: exactly one article and one video per category, which
        # is the floor, so a second pair can only come from a reserve.
        return (
            _reserve_bundle()
            if len(seen) > 1
            else _parsed_bundle(include_optional_third=False)
        )

    harness = _PrepareHarness(monkeypatch)
    monkeypatch.setattr(feed_delivery, "research_card_detail_resources", research)
    harness.run()

    assert len(seen) >= 2, "no reserve attempt was made"
    reserve = seen[1]
    assert reserve.get("force") is not True
    assert reserve.get("retry_failed") is True


def test_the_reserve_excludes_what_the_primary_bundle_already_used(monkeypatch):
    """Without this the reserve returns the same URLs and adds nothing, having
    spent a full research run to do it."""
    seen = []

    async def research(**kwargs):
        seen.append(kwargs)
        # Minimal primary: exactly one article and one video per category, which
        # is the floor, so a second pair can only come from a reserve.
        return (
            _reserve_bundle()
            if len(seen) > 1
            else _parsed_bundle(include_optional_third=False)
        )

    harness = _PrepareHarness(monkeypatch)
    monkeypatch.setattr(feed_delivery, "research_card_detail_resources", research)
    harness.run()

    excluded = set(seen[1].get("extra_excluded_urls") or [])
    primary = {
        r["url"]
        for r in _parsed_bundle(include_optional_third=False)["resources"]
    }
    assert primary & excluded


def test_a_failing_reserve_does_not_lose_the_published_bundle(monkeypatch):
    """Best effort throughout: the primary set is already complete and must
    survive a reserve that raises."""
    calls = []

    async def research(**kwargs):
        calls.append(kwargs)
        if len(calls) > 1:
            raise RuntimeError("provider down")
        return _delivery_ready_parsed_bundle()

    harness = _PrepareHarness(monkeypatch)
    monkeypatch.setattr(feed_delivery, "research_card_detail_resources", research)
    result = harness.run()

    assert result["resource_readiness"] == "ready"
    assert all(item["resource_pair_complete"] for item in result["items"])


def test_only_one_reserve_attempt(monkeypatch):
    """The original ran the loop twice. A pair is one article crossed with one
    video and the primary floor is one of each, so the trigger holds on nearly
    every preparation — halving the loop halves a cost that is paid often."""
    calls = []

    async def research(**kwargs):
        calls.append(kwargs)
        # Never widens the pool, so a loop would keep going if there were one.
        return _parsed_bundle(include_optional_third=False)

    harness = _PrepareHarness(monkeypatch)
    monkeypatch.setattr(feed_delivery, "research_card_detail_resources", research)
    harness.run()

    assert len(calls) <= 2, calls
