"""Feature rollout for the three explicitly released mobile channels."""

import os


def mobile_updates_enabled() -> bool:
    branch = os.getenv("VERCEL_GIT_COMMIT_REF")
    if branch in {"Testing-Backend-Alpha", "Testing-Backend-Beta"}:
        return True
    return branch == "main" and os.getenv("VERCEL_ENV") == "production"
