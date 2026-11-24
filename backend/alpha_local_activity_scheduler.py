"""Gate the opt-in Alpha activity scheduler to the testing deployment."""

from __future__ import annotations

from datetime import datetime
import hashlib
import hmac
import re
from typing import Any
from zoneinfo import ZoneInfo

import anyio
from fastapi import HTTPException

from backend import runtime


TABLE = "alpha_local_activity_scheduler"


async def authorize(authorization: str | None) -> tuple[Any, bool]:
    if not runtime.alpha_features_available():
        raise HTTPException(404, "Not found")
    match = re.fullmatch(r"Bearer ([a-f0-9]{64})", authorization or "")
    if not match:
        raise HTTPException(401, "Unauthorized")
    sb = runtime.get_supabase()
    if sb is None:
        raise HTTPException(503, "Alpha activity scheduler unavailable")

    def load() -> list[dict]:
        return sb.table(TABLE).select("enabled,token_sha256").eq("id", 1).limit(1).execute().data or []

    try:
        records = await anyio.to_thread.run_sync(load)
    except Exception:
        raise HTTPException(503, "Alpha activity scheduler unavailable") from None
    if not records:
        raise HTTPException(503, "Alpha activity scheduler unavailable")

    record = records[0]
    expected = record.get("token_sha256")
    token_hash = hashlib.sha256(match.group(1).encode("ascii")).hexdigest()
    if not isinstance(expected, str) or not hmac.compare_digest(expected, token_hash):
        raise HTTPException(401, "Unauthorized")
    return sb, record.get("enabled") is True


async def public_city_probe() -> dict:
    """Run a fixed public city lookup with no family, queue, or delivery data."""
    from backend.feed.local_activities import LocalActivitiesUnavailable, discover_local_activities

    try:
        items = await discover_local_activities(
            city="Monterey Park", region="CA", country="US", age_band="preschool", locale="en",
            today=datetime.now(ZoneInfo("America/Los_Angeles")).date(),
        )
    except LocalActivitiesUnavailable:
        raise HTTPException(503, "Local activity lookup unavailable") from None
    return {
        "ok": True,
        "state": "ready" if items else "empty",
        "dated_events": sum(item["kind"] == "dated_event" for item in items),
        "ongoing_resources": sum(item["kind"] == "ongoing_resource" for item in items),
        "sources": [{
            "kind": item["kind"], "source_url": item["source_url"], "start_date": item["start_date"],
        } for item in items[:4]],
    }
