"""The refresh button, and why it did nothing.

The home screen has always sent a nonce with the request — `client_refresh` in
api.ts, generated fresh on each tap. Nothing on the server read it. Meanwhile
`weighted_category_for_window` buckets the draw on a six-hour window, so the
category the carousel leads with was fixed for six hours no matter how many
times a parent tapped. The button was not broken so much as unplugged.

Mixing the nonce into the user key moves the draw for whoever is asking, and
only for them: a parent who is not tapping keeps the stable six-hour carousel
the window exists to give them.
"""
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.recommendation_feedback import (  # noqa: E402
    CONTENT_CATEGORY_NAMES,
    weighted_category_for_window,
)

EVEN = {"authority": 34, "featured": 33, "case": 33}


def test_without_a_nonce_the_window_is_stable():
    """The property the six-hour bucket exists for: the carousel must not jump
    on every render."""
    draws = {weighted_category_for_window("user-abc", EVEN) for _ in range(20)}
    assert len(draws) == 1


def test_a_nonce_moves_the_draw():
    draws = [weighted_category_for_window(f"user-abc:{i}", EVEN) for i in range(24)]
    assert len(set(draws)) == len(CONTENT_CATEGORY_NAMES)


def test_two_users_tapping_the_same_nonce_do_not_collide():
    """The nonce is per-tap, not per-user, so it must not become the whole key."""
    a = [weighted_category_for_window(f"user-a:{i}", EVEN) for i in range(40)]
    b = [weighted_category_for_window(f"user-b:{i}", EVEN) for i in range(40)]
    assert a != b


def test_the_learned_mix_still_decides_the_odds():
    """Refreshing must resample the preference distribution, not replace it with
    a uniform one — the mix is what the questionnaire and every card tap feed."""
    skew = {"authority": 80, "featured": 10, "case": 10}
    counts = collections.Counter(
        weighted_category_for_window(f"user-abc:{i}", skew) for i in range(3000)
    )
    assert 74 <= counts["authority"] / 30 <= 86
    for quiet in ("featured", "case"):
        assert 5 <= counts[quiet] / 30 <= 16


def test_an_even_mix_reaches_every_category():
    counts = collections.Counter(
        weighted_category_for_window(f"user-abc:{i}", EVEN) for i in range(3000)
    )
    for category in CONTENT_CATEGORY_NAMES:
        assert 28 <= counts[category] / 30 <= 39, (category, counts)


def test_an_empty_mix_does_not_raise():
    assert weighted_category_for_window("user-abc:1", {}) in CONTENT_CATEGORY_NAMES
