"""Account-scoped consent and prepared recommendations for a coarse locality."""

from __future__ import annotations

import asyncio
import hashlib
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anyio
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from backend import alpha_nearby_events, runtime
from backend.nuri_core import family_store

TABLE = "local_activity_areas"
KIND = "local_activity"
_ALPHA_BUNDLE = "com.ordashtech.nuri.beta"
_ALPHA_PUSH_BUILDS = frozenset(f"{_ALPHA_BUNDLE}:{number}" for number in (1097, 1098, 1099, 1102, 1103, 1104))
_MAX_ITEMS = 8
_MAX_AGE_BANDS = 2
_SEARCH_LEASE = timedelta(minutes=10)
_REFRESH_AFTER = timedelta(hours=12)
_DETAIL_LIFETIME = timedelta(days=3)
_SNAPSHOT_FORMAT = "organizer-details-v2"


class AreaPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    enabled: bool
    city: str | None = None
    region: str | None = None
    country: str | None = None

    @field_validator("country")
    @classmethod
    def upper_country(cls, country: str | None) -> str | None:
        return country.upper() if country else None

    @model_validator(mode="after")
    def validate_area(self):
        if self.enabled:
            area = alpha_nearby_events.NearbyEventsRequest(
                city=self.city or "", region=self.region or "", country=self.country or "",
            )
            if not area.country:
                raise ValueError("Choose a country code for the selected city")
            self.city, self.region, self.country = area.city, area.region or None, area.country
        elif any((self.city, self.region, self.country)):
            raise ValueError("Disable without sending location fields")
        return self


def enabled() -> bool:
    configured = os.getenv("NURI_LOCAL_ACTIVITIES_ENABLED")
    if runtime.alpha_features_available():
        return configured != "0"
    return configured == "1" and not (
        os.getenv("VERCEL") or os.getenv("VERCEL_ENV") or os.getenv("VERCEL_GIT_COMMIT_REF")
    )


def supported_builds() -> frozenset[str]:
    """Only explicitly compatible installations receive this notification kind."""
    if not enabled():
        return frozenset()
    configured = os.getenv("NURI_LOCAL_ACTIVITY_PUSH_BUILDS")
    builds = frozenset(part.strip() for part in (configured or "").split(",") if part.strip())
    if not runtime.alpha_features_available():
        return builds
    if configured is None:
        return _ALPHA_PUSH_BUILDS
    return frozenset(build for build in builds if build.startswith(f"{_ALPHA_BUNDLE}:"))


def supports_push(device: dict, builds: frozenset[str]) -> bool:
    return (
        device.get("platform") in {None, "ios"}
        and bool(device.get("bundle_id"))
        and bool(device.get("build_number"))
        and f"{device['bundle_id']}:{device['build_number']}" in builds
    )


def _state(state: str, items: list[dict] | None = None) -> dict:
    return {"state": state, "items": items or []}


async def load_area(sb: Any, uid: str) -> dict:
    def read():
        return sb.table(TABLE).select("*").eq("user_id", uid).limit(1).execute().data or []
    rows = await anyio.to_thread.run_sync(read)
    return rows[0] if rows else {}


def public_area(row: dict) -> dict:
    if not row.get("enabled"):
        return {"enabled": False, "city": None, "region": None, "country": None}
    return {field: row.get(field) for field in ("enabled", "city", "region", "country")}


async def configure(sb: Any, uid: str, patch: AreaPatch) -> dict:
    area = public_area(patch.model_dump())
    if public_area(await load_area(sb, uid)) == area:
        return area
    payload = {
        "user_id": uid, "revision": str(uuid4()), **area,
        "snapshot": {}, "refreshed_at": None, "next_search_at": "-infinity",
        "last_push_checked_at": None,
    }

    def save():
        return sb.table(TABLE).upsert(payload, on_conflict="user_id").execute()

    await anyio.to_thread.run_sync(save)
    return area


def age_bands(children: list[dict], day: date) -> list[str]:
    def band(months: int) -> str:
        if months < 12:
            return "infant"
        if months < 36:
            return "toddler"
        if months < 60:
            return "preschool"
        return "school_age" if months < 156 else "teen"

    values = []
    for child in children:
        months = family_store.age_in_months(str(child.get("birth_date") or ""), on=day)
        if months is not None and months < 216:
            values.append(band(months))
    return list(dict.fromkeys(values))


def _date_value(value: Any) -> date | None:
    try:
        return date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _moment(value: object) -> datetime | None:
    if not isinstance(value, str) or "T" not in value:
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return result if result.utcoffset() is not None else None


def active_on(item: dict, day: date, now: datetime | None = None) -> bool:
    from backend.feed.local_activities import _organizer_event_url

    if item.get("kind") != "dated_event" or item.get("event_source_verified") is not True:
        return False
    required = ("id", "title", "venue_name", "address", "description", "age_label", "source_url", "time_zone")
    if any(not isinstance(item.get(field), str) or not item[field].strip() for field in required):
        return False
    source = item["source_url"]
    try:
        if _organizer_event_url(source) != source:
            return False
    except ValueError:
        return False
    registration_url = item.get("registration_url")
    if registration_url is not None and not (
        source.startswith("https://www.fortbendlibraries.gov/event/")
        and registration_url == f"{source}#lc-registration-ui-registration-form-opener-form"
    ):
        return False
    starts, ends = _moment(item.get("starts_at")), _moment(item.get("ends_at"))
    if not starts or not ends or starts >= ends:
        return False
    try:
        zone = ZoneInfo(item["time_zone"])
    except (ValueError, ZoneInfoNotFoundError):
        return False
    if any(moment.utcoffset() != moment.astimezone(zone).utcoffset() for moment in (starts, ends)):
        return False
    if (_date_value(item.get("start_date")) != starts.date()
            or _date_value(item.get("end_date")) != ends.date()):
        return False
    return now < ends if now is not None else day <= ends.date()


def _eligible_items(items: list, day: date, now: datetime) -> list[dict]:
    return [item for item in items if isinstance(item, dict) and active_on(item, day, now)]


def _for_family(item: dict, children: list[dict], locale: str) -> dict | None:
    from backend.feed.local_activities import _copy

    event_day = _date_value(item.get("start_date"))
    if not event_day:
        return None
    ranges = item.get("_age_ranges")
    if not isinstance(ranges, (list, tuple)):
        return None
    ages = [
        family_store.age_in_months(str(child.get("birth_date") or ""), on=event_day)
        for child in children
    ]
    applicable = [
        (pair[0], pair[1]) for pair in ranges
        if isinstance(pair, (list, tuple)) and len(pair) == 2
        and type(pair[0]) is int and type(pair[1]) is int and 0 <= pair[0] <= pair[1] <= 263
    ]
    if not any(start <= age <= end for age in ages if age is not None for start, end in applicable):
        return None
    target = item["age_label"]
    return {**item, "match_reason": _copy(
        locale, f"主办方标注的适龄范围是{target}，与您家孩子在活动当天的年龄相符。",
        f"The organizer’s age guidance ({target}) matches your child’s age on the event date.",
        f"主辦方標註的適齡範圍是{target}，與您家孩子在活動當天的年齡相符。",
    )}


def _snapshot_age(area: dict, now: datetime) -> timedelta | None:
    snapshot = area.get("snapshot")
    if not isinstance(snapshot, dict) or snapshot.get("format") != _SNAPSHOT_FORMAT:
        return None
    try:
        raw = area.get("refreshed_at")
        parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            age = now - parsed
            if timedelta(0) <= age <= _DETAIL_LIFETIME:
                return age
    except (ValueError, TypeError):
        pass
    return None


def _scoped_id(item: dict, rev: str) -> str:
    return hashlib.sha256(f"{rev}:{item['id']}".encode()).hexdigest()[:32]


def _merge_results(results: list[list[dict]], rev: str, day: date, now: datetime,
                   children: list[dict], locale: str) -> list[dict]:
    # Interleave children’s age groups. The strongest result for one child
    # does not displace the whole list for their siblings.
    merged: dict[str, dict] = {}
    for index in range(max((len(group) for group in results), default=0)):
        for group in results:
            if index >= len(group):
                continue
            item = group[index]
            if active_on(item, day, now) and (scoped := _for_family(item, children, locale)):
                item_id = _scoped_id(item, rev)
                merged.setdefault(item_id, {**scoped, "id": item_id})
                if len(merged) == _MAX_ITEMS:
                    return list(merged.values())
    return list(merged.values())


def _result(items: list[dict]) -> dict:
    public = [{k: v for k, v in item.items() if not k.startswith("_")} for item in items]
    return _state("ready" if public else "empty", public)


async def recommendations(sb: Any, uid: str, *, locale: str, now: datetime,
                          day: date, area: dict | None = None) -> dict:
    from backend.feed.local_activities import LocalActivitiesUnavailable, _VERIFICATION_LIMIT, discover_local_activities

    if not enabled():
        return _state("disabled")
    area = area if area is not None else await load_area(sb, uid)
    if not area.get("enabled"):
        return _state("disabled")
    _, children = await family_store.load_profile(uid)
    bands = age_bands(children, day)
    if not bands:
        return _state("empty")

    # Spread search cost across days while retaining every child's age band.
    start = day.toordinal() % len(bands) if len(bands) > _MAX_AGE_BANDS else 0
    selected = (bands[start:] + bands[:start])[:_MAX_AGE_BANDS]
    scope = {"bands": selected, "locale": locale}
    snapshot = area.get("snapshot") or {}
    age = _snapshot_age(area, now) if snapshot.get("scope") == scope else None
    previous = [scoped for item in _eligible_items(snapshot.get("items") or [], day, now)
                if (scoped := _for_family(item, children, locale))] if age is not None else []
    if age is not None and age < _REFRESH_AFTER:
        return _result(previous)

    until = (now + _SEARCH_LEASE).isoformat()
    revision = str(area["revision"])

    def reserve():
        return sb.table(TABLE).update({"next_search_at": until}).eq(
            "user_id", uid,
        ).eq("revision", revision).eq("enabled", True).lte(
            "next_search_at", now.isoformat(),
        ).execute().data

    if not await anyio.to_thread.run_sync(reserve):
        return _result(previous) if age is not None else _state("unavailable")

    try:
        groups = await asyncio.gather(*(
            discover_local_activities(
                city=area["city"], region=area.get("region") or "", country=area["country"],
                age_band=band, locale=locale, today=day, limit=_VERIFICATION_LIMIT,
            ) for band in selected
        ), return_exceptions=True)
        for result in groups:
            if isinstance(result, BaseException) and not isinstance(result, LocalActivitiesUnavailable):
                raise result
        good = [result for result in groups if isinstance(result, list)]
        if not good:
            return _result(previous) if previous else _state("unavailable")

        items = _merge_results(good, revision, day, now, children, locale)
        if not items and len(good) != len(groups):
            return _result(previous) if previous else _state("unavailable")
        # Keep active prior in-app detail links while a new snapshot rotates
        # presentation. Any change of area/consent invalidates the whole set.
        old = _eligible_items(
            [*(snapshot.get("items") or []), *(snapshot.get("recent") or [])], day, now,
        ) if _snapshot_age(area, now) is not None else []
        ids = {item["id"] for item in items}
        retained = {}
        for item in old:
            item_id = item["id"]
            if item_id not in ids and _date_value(item.get("_valid_through")):
                if day <= _date_value(item["_valid_through"]):
                    retained.setdefault(item_id, item)
        persisted = [
            {**item, "_valid_through": (day + timedelta(days=2)).isoformat()} for item in items
        ]

        def save():
            return sb.table(TABLE).update({
                "snapshot": {
                    "format": _SNAPSHOT_FORMAT, "scope": scope,
                    "items": persisted, "recent": list(retained.values())[:24],
                },
                "refreshed_at": now.isoformat() if len(good) == len(groups) else (
                    now - _REFRESH_AFTER
                ).isoformat(),
            }).eq("user_id", uid).eq("revision", revision).eq("next_search_at", until).execute().data

        if not await anyio.to_thread.run_sync(save):
            return _state("unavailable")
        return _result(items)
    except LocalActivitiesUnavailable:
        return _result(previous) if previous else _state("unavailable")


async def find_activity(sb: Any, uid: str, item_id: str, *,
                        now: datetime, day: date, revision: str | None = None) -> dict | None:
    if not enabled():
        return None
    area = await load_area(sb, uid)
    if not area.get("enabled") or _snapshot_age(area, now) is None:
        return None
    if revision is not None and revision != str(area.get("revision")):
        return None
    snapshot = area.get("snapshot") or {}
    for item in _eligible_items([*(snapshot.get("items") or []), *(snapshot.get("recent") or [])], day, now):
        if item.get("id") == item_id:
            through = _date_value(item.get("_valid_through"))
            if through is not None and day <= through:
                _, children = await family_store.load_profile(uid)
                locale = (snapshot.get("scope") or {}).get("locale", "zh-CN")
                scoped = _for_family(item, children, locale)
                return {k: v for k, v in scoped.items() if not k.startswith("_")} if scoped else None
    return None
