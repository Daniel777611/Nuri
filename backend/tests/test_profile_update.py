"""Profile updates from onboarding and the profile page."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend import main


def test_a_retired_concern_is_dropped_not_refused():
    """lulala01017's account still held "education"; every onboarding save 422'd."""
    update = main.UserUpdate(top_concerns=["emotion", "education", "health"], onboarding_completed=True)
    assert update.top_concerns == ["emotion", "health"]
    assert update.onboarding_completed is True


def test_current_concerns_pass_through():
    assert main.UserUpdate(top_concerns=["sleep", "other"]).top_concerns == ["sleep", "other"]


def test_leaving_concerns_out_leaves_them_alone():
    assert "top_concerns" not in main.UserUpdate(nickname="Linda").model_dump(exclude_unset=True)


def test_a_bad_parent_role_is_still_refused():
    with pytest.raises(ValidationError):
        main.UserUpdate(parent_role="aunt")
