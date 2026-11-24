"""Alpha-only public activity discovery. Only a city, region and country leave Nuri."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
import ipaddress
import re
from time import monotonic
import unicodedata
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .runtime import alpha_features_available as is_alpha_backend
from .search_tavily import SearchUnavailable, TavilySearchProvider
from .websearch import SearchRequest, SearchResult

_DATE_LOOKAHEAD = timedelta(days=30)
_MONTHS = (
    "January February March April May June July August September October November December"
).split()
_MONTH_NUMBER = {name.lower(): i for i, name in enumerate(_MONTHS, 1)}
_MONTH_NUMBER.update({name[:3].lower(): i for i, name in enumerate(_MONTHS, 1)})
_MONTH_RE = "|".join(_MONTH_NUMBER)
_ISO_DATE = re.compile(r"(?<!\d)(20\d{2})[-年](0?[1-9]|1[0-2])[-月](0?[1-9]|[12]\d|3[01])(?:日|\b)")
_WRITTEN_DATE = re.compile(
    rf"\b({_MONTH_RE})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(20\d{{2}})\b"
    rf"|\b(\d{{1,2}})\s+({_MONTH_RE})\.?\s+(20\d{{2}})\b", re.IGNORECASE
)
_LIBRARY = re.compile(r"librar(?:y|ies)|biblioth[eè]que|biblioteca|図書館|도서관|圖書館|图书馆", re.I)
_FAMILY = re.compile(
    r"story\s*time|child(?:ren)?|famil(?:y|ies)|kids|toddler|preschool|juvenil|enfant|"
    r"親子|亲子|兒童|儿童|おはなし|子ども|어린이", re.I
)
_EVENT = re.compile(
    r"events?|register|calendar|story\s*time|workshop|session|program|registration|"
    r"活动|活動|報名|报名|イベント|행사|atelier|calendario|taller", re.I
)
_CANCELLED = re.compile(r"\bcancel(?:led|ed)\b|\bpostponed\b|已取消|延期|中止", re.I)
_LISTING_PATH = re.compile(r"^/(?:[a-z]{2}/)?(?:calendar|events?|programs?|activities|news)/?$", re.I)
_SEARCH_ENGINES = {"google.com", "bing.com", "search.yahoo.com", "facebook.com", "instagram.com"}
_US_STATES = dict(pair.split(":", 1) for pair in (
    "AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|"
    "DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|"
    "IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|"
    "MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|"
    "NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|"
    "OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|"
    "SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|"
    "WV:West Virginia|WI:Wisconsin|WY:Wyoming"
).split("|"))
_CANADA_REGIONS = {
    "AB": "Alberta", "BC": "British Columbia", "MB": "Manitoba", "NB": "New Brunswick",
    "NL": "Newfoundland and Labrador", "NT": "Northwest Territories", "NS": "Nova Scotia",
    "NU": "Nunavut", "ON": "Ontario", "PE": "Prince Edward Island", "QC": "Quebec",
    "SK": "Saskatchewan", "YT": "Yukon",
}
_cache: OrderedDict[tuple[str, ...], tuple[float, list[dict[str, str]]]] = OrderedDict()
_last_request: OrderedDict[str, float] = OrderedDict()
_search_slots = asyncio.Semaphore(6)


class NearbyEventsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    city: str = Field(min_length=2, max_length=80)
    region: str = Field(default="", max_length=70)
    country: str = Field(default="", pattern=r"^(?:[A-Z]{2})?$")
    locale: str = Field(default="en", pattern=r"^(en|zh-CN|zh-TW)$")

    @field_validator("city", "region")
    @classmethod
    def validate_locality(cls, value: str) -> str:
        # Prevent street addresses and arbitrary search queries from arriving
        # via this endpoint. Apple's administrative names can include numbers
        # only in exceptionally large second-level regions, which are optional.
        value = unicodedata.normalize("NFC", value)
        if value and not all(
            unicodedata.category(char)[0] in ("L", "M") or char in " .,'’-"
            for char in value
        ):
            raise ValueError("Use only a city or region name")
        if value and not any(char.isalpha() for char in value):
            raise ValueError("Use only a city or region name")
        return " ".join(value.split())


def _dates(text: str) -> set[date]:
    values: set[date] = set()
    parts = [tuple(map(int, m.groups())) for m in _ISO_DATE.finditer(text)]
    for m in _WRITTEN_DATE.finditer(text):
        if m[1]:
            parts.append((int(m[3]), _MONTH_NUMBER[m[1].lower()], int(m[2])))
        else:
            parts.append((int(m[6]), _MONTH_NUMBER[m[5].lower()], int(m[4])))
    for year, month, day in parts:
        try:
            values.add(date(year, month, day))
        except ValueError:
            continue
    return values


def public_activity_source(url: str, *, allow_listing: bool = False) -> tuple[str, str] | None:
    if len(url) > 900 or any(ord(char) < 33 or char == "\\" for char in url):
        return None
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        # Provider results are displayed, not fetched by Nuri. Keep links to
        # an ordinary public hostname and a particular event page.
        if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", host) or host.endswith((".local", ".test", ".internal", ".localhost")):
            return None
        try:
            ipaddress.ip_address(host)
            return None
        except ValueError:
            if not any(char.isalpha() for char in host.split(".")[-1]):
                return None
        if any(host == excluded or host.endswith("." + excluded) for excluded in _SEARCH_ENGINES):
            return None
        if not allow_listing and (not parsed.path.strip("/") or _LISTING_PATH.fullmatch(parsed.path)):
            return None
        return host, parsed._replace(fragment="").geturl()
    except ValueError:
        return None


def activity_near_location(area: NearbyEventsRequest, combined: str) -> bool:
    # Bound Latin names by word boundaries rather than accepting e.g. York in
    # Yorkshire. Non-segmented writing (e.g. 臺北市) can match within a place name.
    def strip_accents(value: str) -> str:
        return "".join(char for char in unicodedata.normalize("NFKD", value)
                       if not unicodedata.combining(char))

    city = strip_accents(area.city.casefold())
    folded = strip_accents(combined.casefold())
    city_matches = (
        re.search(rf"(?<!\w){re.escape(city)}(?!\w)", folded) is not None
        if city.isascii() else city in folded
    )
    if not city_matches:
        return False
    # North American locality names are re-used across state/provincial
    # lines. If a known state/province is supplied, match the city line
    # rather than treating an unrelated reference elsewhere as evidence.
    if area.country in ("", "US", "CA") and area.region:
        states = _CANADA_REGIONS if area.country == "CA" else _US_STATES
        if not area.country and area.region.upper() in _CANADA_REGIONS:
            states = _CANADA_REGIONS
        region = next(((code, name) for code, name in states.items()
                       if area.region.casefold() in (code.casefold(), name.casefold())), None)
        if region:
            code, name = region
            region_match = rf"(?<!\w){re.escape(city)}(?:\s*,\s*|\s+)(?:{code.lower()}|{re.escape(name.casefold())})(?!\w)"
            return re.search(region_match, folded) is not None
    return True


def parse_nearby_events(
    results: list[SearchResult], area: NearbyEventsRequest, today: date
) -> list[dict[str, str]]:
    unique: dict[tuple[str, date], dict[str, str]] = {}
    for result in results:
        title = " ".join(result.title.split())[:160]
        text = " ".join(result.snippet.split())[:3000]
        source = public_activity_source(result.url)
        if not source or not title or title == result.url:
            continue
        host, url = source
        combined = f"{title} {text}"
        if not _FAMILY.search(combined) or not _EVENT.search(combined) or _CANCELLED.search(combined):
            continue
        if not activity_near_location(area, combined):
            continue
        # Listings containing several dates frequently mix sessions from
        # different organizers. Prefer a page with a single explicit date,
        # and never treat the indexing provider's published_at as event day.
        dated = _dates(combined)
        if len(dated) != 1:
            continue
        day = next(iter(dated))
        if not today <= day <= today + _DATE_LOOKAHEAD:
            continue
        key = url, day
        unique[key] = {
            "id": sha256(f"{url}\n{day.isoformat()}".encode()).hexdigest()[:24],
            "title": title,
            "date": day.isoformat(),
            "url": url,
            "source": host,
            "category": "library" if _LIBRARY.search(f"{host} {combined}") else "family",
        }
    return sorted(unique.values(), key=lambda item: (item["date"], item["title"]))[:8]


def _search_query(area: NearbyEventsRequest, today: date) -> str:
    place = ", ".join(value for value in (area.city, area.region, area.country) if value)
    end = today + _DATE_LOOKAHEAD
    categories = {
        "zh-CN": "图书馆 故事时间 亲子 儿童 活动",
        "zh-TW": "圖書館 故事時間 親子 兒童 活動",
    }.get(area.locale, "library storytime children's workshops family events")
    # Even parents using Chinese may be looking for a library in an English
    # speaking city. Ask for organizer pages and exact dates in either language.
    return (
        f'{categories} library storytime family events in "{place}" '
        f"scheduled {today.isoformat()} to {end.isoformat()} organizer registration event date"
    )


async def find_nearby_events(body: NearbyEventsRequest, user_id: str) -> dict:
    """Call from an existing authenticated route. No location is persisted."""
    if not is_alpha_backend():
        raise HTTPException(status_code=404, detail="Not found")
    today = datetime.now(timezone.utc).date()
    key = (body.city.casefold(), body.region.casefold(), body.country, body.locale, today.isoformat())
    tick = monotonic()
    known = _cache.get(key)
    if known and known[0] > tick:
        _cache.move_to_end(key)
        return {"events": known[1]}
    if tick - _last_request.get(user_id, float("-inf")) < 30:
        raise HTTPException(status_code=429, detail="Retry shortly")
    _last_request[user_id] = tick
    _last_request.move_to_end(user_id)
    if len(_last_request) > 1024:
        _last_request.popitem(last=False)
    request = SearchRequest(
        query=_search_query(body, today),
        lang="en" if body.locale == "en" else "zh",
        max_results=12,
    )
    try:
        async with asyncio.timeout(14):
            async with _search_slots:
                search = await TavilySearchProvider().fetch(request)
    except (SearchUnavailable, TimeoutError):
        # Never expose provider details, search text, identities or credentials.
        raise HTTPException(status_code=503, detail="Nearby activity lookup unavailable") from None
    events = parse_nearby_events(search, body, today)
    _cache[key] = (monotonic() + 30 * 60, events)
    _cache.move_to_end(key)
    if len(_cache) > 256:
        _cache.popitem(last=False)
    return {"events": events}
