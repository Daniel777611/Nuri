"""Discover local family activities from public organizer pages.

The caller authorizes discovery and supplies only a coarse area and age band.
Neither external queries nor the shared in-process cache carry an account ID
or child details. Dated activities require a separate organizer-page check.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import date, timedelta
from hashlib import sha256
from html.parser import HTMLParser
import re
from time import monotonic
from typing import Literal, NamedTuple, Protocol, TypedDict
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit

import httpx

from backend.alpha_nearby_events import (
    NearbyEventsRequest,
    _CANCELLED,
    _CANADA_REGIONS,
    _FAMILY,
    _ISO_DATE,
    _US_STATES,
    _WRITTEN_DATE,
    _dates,
    activity_near_location,
    public_activity_source,
)
from backend.search_tavily import SearchUnavailable, TavilySearchProvider
from backend.websearch import SearchRequest, SearchResult


class LocalActivitiesUnavailable(Exception):
    """The provider was unable to establish whether local results exist."""


class ActivityProvider(Protocol):
    async def fetch(self, request: SearchRequest) -> list[SearchResult]: ...


class LocalActivity(TypedDict):
    id: str
    kind: Literal["dated_event", "ongoing_resource"]
    title: str
    summary: str
    source_url: str
    source_label: str
    start_date: str | None
    end_date: str | None
    location_label: str


_CACHE_TTL_SECONDS = 30 * 60
_CACHE_SIZE = 256
_RESULT_LIMIT = 12
_VERIFICATION_LIMIT = 6
_ORGANIZER_BODY_LIMIT = 384 * 1024
_EVENT_LOOKAHEAD = timedelta(days=30)
# Each exact origin below serves a manually checked CivicPlus event detail
# template with dedicated title, primary date and location blocks.
_CIVICPLUS_HOSTS = {
    "montereypark.ca.gov": "www.montereypark.ca.gov",
    "www.montereypark.ca.gov": "www.montereypark.ca.gov",
    "flagstaff.az.gov": "www.flagstaff.az.gov",
    "www.flagstaff.az.gov": "www.flagstaff.az.gov",
    "smithfieldutah.gov": "smithfieldutah.gov",
    "www.smithfieldutah.gov": "smithfieldutah.gov",
    "cityoflagunaniguel.org": "www.cityoflagunaniguel.org",
    "www.cityoflagunaniguel.org": "www.cityoflagunaniguel.org",
    "dalycity.org": "www.dalycity.org",
    "www.dalycity.org": "www.dalycity.org",
}
_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_AGE_BAND_WORDS = {
    "infant": "baby infant",
    "toddler": "toddler",
    "preschool": "preschool",
    "school_age": "school-age children",
    "teen": "teen",
}
_AGE_BAND_ALIASES = {
    "baby": "infant", "newborn": "infant", "preschooler": "preschool",
    "school-age": "school_age", "school_age_child": "school_age",
}
_AGE_LABELS = {
    "infant": re.compile(r"\b(?:bab(?:y|ies)|infants?|newborns?)\b|嬰兒|婴儿", re.I),
    "toddler": re.compile(r"\btoddlers?\b|幼兒|幼儿", re.I),
    "preschool": re.compile(r"\bpre[- ]?school(?:ers?)?\b|學齡前|学龄前", re.I),
    "school_age": re.compile(r"\bschool[- ]age(?:d)?\b|學齡兒童|学龄儿童", re.I),
    "teen": re.compile(r"\b(?:teens?|teenagers?|young adults?)\b|青少年", re.I),
}
_OPEN_TO_ALL = re.compile(r"\ball ages\b|\bchildren of all ages\b|全年齡|全年龄", re.I)
_AGE_RANGE = re.compile(
    r"\bages?\s*(\d{1,2})\s*(?:–|—|-|to|through)\s*(\d{1,2})(?:\s*(months?|years?))?\b|"
    r"(\d{1,2})\s*(?:–|—|-|至|到)\s*(\d{1,2})\s*(歲|岁|個月|个月)",
    re.I,
)
_AGE_BANDS_MONTHS = {
    "infant": (0, 11), "toddler": (12, 35), "preschool": (36, 59),
    "school_age": (60, 155), "teen": (156, 215),
}
_RESOURCE = re.compile(
    r"library|libraries|museum|community cent(?:er|re)|recreation|playground|"
    r"nature cent(?:er|re)|parks? department|park district|family resource|"
    r"圖書館|图书馆|博物館|博物馆|親子館|亲子馆|公園|公园|社區中心|社区中心",
    re.I,
)
_ONGOING = re.compile(
    r"\b(?:calendar|programs|hours|recurring|weekly|daily|monthly|open to|"
    r"year[- ]round|visit|membership|family resources|park amenities)\b|"
    r"開放|开放|每週|每周|每月|活動行事曆|活动日历|開館|开馆|服務|服务",
    re.I,
)
_WEEKLY_SCHEDULE = re.compile(
    r"\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)days\s+(?:at|from)\s+\d{1,2}(?::\d{2})?\b",
    re.I,
)
_EVENT_INSTANCE = re.compile(
    r"/(?:events?|sessions?)/[^/?]+|/calendar/event/|(?:^|[?&])(?:eid|eventid|event_id)=",
    re.I,
)
_LISTING_TITLE = re.compile(
    r"\b(?:events? calendar|upcoming events|all events|program calendar|library calendar)\b|活動行事曆|活动日历",
    re.I,
)
_EVENT_ANCHOR = re.compile(
    r"\b(?:on|on:|date|when|held|schedule(?:d)?|starts?|takes place|story\s*time|"
    r"event|session|workshop)(?:\s+(?:on|for|at|from))?\b[\s:,.–—-]*"
    r"(?:\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[\s,.]*)?$|"
    r"(?:日期|時間|时间|舉行|举行|活動|活动|場次|场次)[\s：，、]*$",
    re.I,
)
_EVENT_TIME = re.compile(r"^[\s,:，、–—-]*(?:at\s+)?(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)\b)", re.I)
_ORGANIZER_TIME_DATE = re.compile(
    r"\b\d{1,2}:\d{2}\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}:\d{2}\s*(?:am|pm)?\s*"
    r"\|\s*(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s*$",
    re.I,
)
_PUBLICATION_DATE = re.compile(
    r"(?:\b(?:published|posted|updated|last modified|copyright)(?:\s+(?:(?:on|at|date)))?|"
    r"發布|发布|更新|刊登|版權|版权)[\s:：,，–—-]*$",
    re.I,
)
_MARKETPLACE = re.compile(
    r"(?:^|\.)(?:eventbrite|meetup|allevents|eventful|patch|ticketmaster|yelp|tripadvisor|"
    r"facebook|instagram|threads|reddit|tiktok|youtube|xiaohongshu)\.[a-z.]+$",
    re.I,
)
_TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid"}
_PRIVATE_PARAMS = {"token", "auth", "key", "api_key", "email", "session", "session_id", "password"}
_cache: OrderedDict[tuple[str, ...], tuple[float, list[LocalActivity]]] = OrderedDict()


def _age_band(value: str) -> str:
    normalized = value.strip().lower()
    normalized = _AGE_BAND_ALIASES.get(normalized, normalized)
    return normalized if normalized in _AGE_BAND_WORDS else ""


def _query(area: NearbyEventsRequest, band: str, today: date, *, resource: bool) -> SearchRequest:
    place = ", ".join(filter(None, (area.city, area.region, area.country)))
    terms = (
        "public library children's calendar recurring programs community center parks children's museum"
        if resource else
        f"library storytime parent child workshop official event calendar {today} to {today + timedelta(days=30)}"
    )
    if area.locale.startswith("zh"):
        terms += " 圖書館 親子活動" if area.locale == "zh-TW" else " 图书馆 亲子活动"
    return SearchRequest(
        query=" ".join(filter(None, (f'"{place}"', _AGE_BAND_WORDS.get(band, ""), terms))),
        lang="en" if area.locale == "en" else "zh",
        max_results=_RESULT_LIMIT,
    )


def _safe_link(url: str) -> tuple[str, str] | None:
    source = public_activity_source(url, allow_listing=True)
    if not source or _MARKETPLACE.search(source[0]):
        return None
    host, clean_url = source
    parsed = urlsplit(clean_url)
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    if any(key.lower() in _PRIVATE_PARAMS for key, _ in pairs):
        return None
    query = urlencode([(key, value) for key, value in pairs
                       if not key.lower().startswith("utm_") and key.lower() not in _TRACKING_PARAMS])
    return host, parsed._replace(query=query).geturl()


class OrganizerEvent(NamedTuple):
    title: str
    day: date
    description: str
    location: str


def _organizer_event_url(url: str) -> str | None:
    """Reconstruct the only URL that may be requested for this event ID."""
    parsed = urlsplit(url)
    host = _CIVICPLUS_HOSTS.get(parsed.hostname or "")
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        return None
    if parsed.port not in (None, 443):
        return None
    matched = re.fullmatch(r"/m/calendar/event/detail/([1-9][0-9]{0,8})/?", parsed.path, re.I)
    if matched and not parsed.query:
        event_id = matched[1]
    elif parsed.path.lower() == "/calendar.aspx":
        fields = parse_qsl(parsed.query, keep_blank_values=True)
        ids = [value for key, value in fields if key.lower() == "eid"]
        if len(ids) != 1 or not re.fullmatch(r"[1-9][0-9]{0,8}", ids[0]):
            return None
        if any(key.lower() not in {"eid", "caltype", "day", "month", "year"} or not value.isascii()
               or not value.isdecimal() for key, value in fields):
            return None
        event_id = ids[0]
    else:
        return None
    return f"https://{host}/m/calendar/event/detail/{event_id}"


class _OrganizerHTML(HTMLParser):
    """Capture only the event's dedicated CivicPlus fields before Related Events."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.fields: dict[str, list[str]] = {}
        self.text: list[str] = []
        self.active: tuple[str, str] | None = None
        self.depth = 0
        self.completed_primary = False
        self.hidden: str | None = None

    def handle_starttag(self, tag, attrs):
        if self.completed_primary or self.hidden:
            return
        attr = dict(attrs)
        if attr.get("aria-labelledby") == "calendar-related-events-heading":
            self.completed_primary = True
            return
        if tag in {"script", "style", "svg"}:
            self.hidden = tag
            return
        if self.active:
            if tag == self.active[1]:
                self.depth += 1
            return
        if tag == "h1" and "calendar-event-title" in (attr.get("class") or "").split():
            field = "title"
        elif tag == "div" and attr.get("id") == "event-description":
            field = "description"
        elif tag == "div" and attr.get("aria-label") == "Event details":
            field = "details"
        elif tag == "div" and attr.get("aria-label") == "Event location":
            field = "location"
        else:
            return
        self.active = field, tag
        self.depth = 1
        self.text = []

    def handle_data(self, text):
        if not self.completed_primary and not self.hidden and self.active:
            self.text.append(text)

    def handle_endtag(self, tag):
        if self.hidden == tag:
            self.hidden = None
            return
        if self.completed_primary or self.hidden or not self.active or tag != self.active[1]:
            return
        self.depth -= 1
        if self.depth == 0:
            self.fields.setdefault(self.active[0], []).append(" ".join(" ".join(self.text).split()))
            self.active = None

    def event(self) -> OrganizerEvent | None:
        if any(len(self.fields.get(field) or []) != 1 for field in ("title", "details", "location")):
            return None
        title = self.fields["title"][0]
        location = self.fields["location"][0]
        details = self.fields["details"][0]
        dates = list(_WRITTEN_DATE.finditer(details))
        values = _dates(details)
        if not title or not location or len(dates) != 1 or len(values) != 1:
            return None
        matched = dates[0]
        if not _ORGANIZER_TIME_DATE.fullmatch(details[:matched.start()]) or matched.end() != len(details):
            return None
        day = next(iter(values))
        weekday = details.split("|", 1)[1].split(",", 1)[0].strip().casefold()
        if weekday != _WEEKDAYS[day.weekday()]:
            return None
        descriptions = self.fields.get("description") or [""]
        if len(descriptions) != 1 or _CANCELLED.search(f"{title} {descriptions[0]} {details}"):
            return None
        return OrganizerEvent(title, day, descriptions[0], location)


async def _verify_organizer(client: httpx.AsyncClient, url: str) -> OrganizerEvent | None:
    if _organizer_event_url(url) != url:
        return None
    try:
        async with asyncio.timeout(4):
            async with client.stream("GET", url, headers={"Accept": "text/html", "Accept-Encoding": "identity"},
                                     follow_redirects=False) as response:
                if response.status_code != 200 or response.headers.get("content-encoding", "identity").lower() != "identity":
                    return None
                if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "text/html":
                    return None
                body = bytearray()
                async for chunk in response.aiter_raw(chunk_size=16 * 1024):
                    if len(body) + len(chunk) > _ORGANIZER_BODY_LIMIT:
                        return None
                    body.extend(chunk)
                    if b'aria-labelledby="calendar-related-events-heading"' in body:
                        break
    except (httpx.HTTPError, TimeoutError):
        return None
    parser = _OrganizerHTML()
    parser.feed(body.decode("utf-8", errors="replace"))
    parser.close()
    return parser.event()


def _organizer_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(trust_env=False, timeout=4, follow_redirects=False)


async def _verify_events(results: list[SearchResult]) -> dict[str, OrganizerEvent]:
    urls = dict.fromkeys(canonical for result in results
                         if (source := _safe_link(result.url))
                         and (canonical := _organizer_event_url(source[1])))
    chosen = list(urls)[:_VERIFICATION_LIMIT]
    if not chosen:
        return {}
    slots = asyncio.Semaphore(3)
    async with _organizer_client() as client:
        async def verify(url: str) -> OrganizerEvent | None:
            async with slots:
                return await _verify_organizer(client, url)
        answers = await asyncio.gather(*(verify(url) for url in chosen))
    return {url: event for url, event in zip(chosen, answers) if event is not None}


def _source_priority(host: str, title: str, city: str) -> int:
    if host in _CIVICPLUS_HOSTS:
        return 3
    if host.endswith(".gov.taipei") or re.search(r"\.(?:gov|edu)(?:\.[a-z]{2})?$|\.ac\.[a-z]{2}$", host):
        return 3
    if host.endswith((".libcal.com", ".bibliocommons.com")):
        return 3
    # Non-government venues can host their own pages. Look for a venue brand
    # in the hostname, or a city-named organization with matching page copy.
    city_slug = "".join(char for char in city.casefold() if char.isascii() and char.isalpha())
    matched_city_host = len(city_slug) >= 3 and city_slug in host
    return 2 if (_RESOURCE.search(host) or
                 (_RESOURCE.search(title) and (matched_city_host or host.endswith(".org")))) else 0


def _plain_place(value: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFKD", value)
                   if not unicodedata.combining(char))


def _place_pattern(value: str) -> str:
    name = re.escape(value)
    return rf"(?<!\w){name}(?!\w)" if value.isascii() else name


def _matches_area(area: NearbyEventsRequest, visible: str) -> bool:
    if not activity_near_location(area, visible):
        return False
    city, region = _plain_place(area.city), _plain_place(area.region)
    if not region or city.casefold() == region.casefold():
        return True
    text = _plain_place(" ".join(visible.split()))
    city_pattern = _place_pattern(city)

    # The existing locality rule recognizes North American postal regions
    # case-insensitively. Recheck the short form in its printed casing so
    # common words like "on" and "in" cannot stand in for provinces/states.
    states = _US_STATES if area.country == "US" else _CANADA_REGIONS if area.country == "CA" else {}
    postal = next(((code, name) for code, name in states.items()
                   if region.casefold() in (code.casefold(), name.casefold())), None)
    if postal:
        code, name = postal
        return bool(re.search(
            rf"(?i:{city_pattern})[\s,]+(?:(?i:{_place_pattern(name)})|{_place_pattern(code)})", text,
        ))

    # A provided region narrows the requested location in every country.
    # Require it close to the named city, rather than evoking an unrelated
    # area that happened to occur somewhere else on a listing.
    region_pattern = _place_pattern(region)
    return bool(re.search(rf"{city_pattern}.{{0,64}}{region_pattern}|{region_pattern}.{{0,64}}{city_pattern}",
                          text, re.I))


def _age_priority(title: str, snippet: str, age_band: str) -> int:
    if not age_band:
        return 0
    for text in (title, snippet):
        if _OPEN_TO_ALL.search(text):
            return 0
        ranges = []
        for match in _AGE_RANGE.finditer(text):
            lower, upper = (int(match[1]), int(match[2])) if match[1] else (int(match[4]), int(match[5]))
            months = (match[3] or "").lower().startswith("month") or match[6] in {"個月", "个月"}
            if lower <= upper and (months or upper <= 21):
                ranges.append((lower, upper) if months else (lower * 12, upper * 12 + 11))
        if ranges:
            start, end = _AGE_BANDS_MONTHS[age_band]
            return 1 if any(low <= end and high >= start for low, high in ranges) else -1
        stated = {label for label, pattern in _AGE_LABELS.items() if pattern.search(text)}
        if stated:
            return 1 if age_band in stated else -1
    return 0


def _dated_evidence(title: str, snippet: str, *, official: bool) -> bool:
    """Accept an explicit date attached to the activity, not a page timestamp."""
    for index, text in enumerate((title, snippet)):
        for match in (*_ISO_DATE.finditer(text), *_WRITTEN_DATE.finditer(text)):
            before = text[max(0, match.start() - 48):match.start()]
            after = text[match.end():match.end() + 38]
            if _PUBLICATION_DATE.search(before):
                continue
            if index == 0 or _EVENT_ANCHOR.search(before) or _EVENT_TIME.match(after):
                return True
            if official and _ORGANIZER_TIME_DATE.search(before):
                return True
    return False


def _brief(snippet: str) -> str:
    cleaned = " ".join(re.sub(r"<[^>]*>", "", snippet).split())
    return cleaned if len(cleaned) <= 240 else cleaned[:237].rsplit(" ", 1)[0] + "…"


def _collect(results: list[SearchResult], area: NearbyEventsRequest, age_band: str,
             today: date, verified: dict[str, OrganizerEvent]) -> list[LocalActivity]:
    where = ", ".join(filter(None, (area.city, area.region, area.country)))
    ranked: dict[str, tuple[tuple[int, int, str, int], LocalActivity]] = {}
    for order, result in enumerate(results):
        source = _safe_link(result.url)
        title = _brief(result.title)[:160]
        if not source or not title or result.title == result.url:
            continue
        host, url = source
        snippet = result.snippet[:3000]
        canonical = _organizer_event_url(url)
        event = verified.get(canonical or "")
        if canonical:
            if not event or not today <= event.day <= today + _EVENT_LOOKAHEAD:
                continue
            url = canonical
            title = _brief(event.title)[:160]
            snippet = event.description[:3000]
        visible = f"{title} {snippet} {event.location if event else ''}"
        priority = _source_priority(host, title, area.city)
        age_priority = _age_priority(title, snippet, age_band)
        if not priority or age_priority < 0 or _CANCELLED.search(visible):
            continue
        if not _FAMILY.search(visible) or not _matches_area(area, visible):
            continue

        official = priority == 3
        is_listing = bool(_LISTING_TITLE.search(title))
        day = event.day.isoformat() if event else None
        path = urlsplit(url).path
        # A dated event excluded by freshness, ambiguity or its missing date
        # must never come back via the resource category.
        if not day:
            if _EVENT_INSTANCE.search(url.removeprefix(f"https://{host}")) and (
                not is_listing or not path.rstrip("/").endswith("/calendar")
            ):
                continue
            if not is_listing and _dated_evidence(title, snippet, official=official):
                continue
            resource = _RESOURCE.search(f"{host} {title} {path}") and _ONGOING.search(visible)
            official_program = official and _RESOURCE.search(visible) and _WEEKLY_SCHEDULE.search(visible)
            if not resource and not official_program:
                continue

        item_id = sha256(f"{url}\n{day or ''}".encode()).hexdigest()[:24]
        rank = (-priority, -age_priority, day or "9999-12-31", order)
        if item_id in ranked and ranked[item_id][0] <= rank:
            continue
        ranked[item_id] = (rank, {
            "id": item_id,
            "kind": "dated_event" if day else "ongoing_resource",
            "title": title,
            "summary": _brief(snippet),
            "source_url": url,
            "source_label": host,
            "start_date": day,
            "end_date": None,
            "location_label": where,
        })
    return [item for _, item in sorted(ranked.values(), key=lambda entry: entry[0])]


async def discover_local_activities(
    *, city: str, region: str = "", country: str = "", age_band: str = "",
    locale: str = "zh-CN", today: date, provider: ActivityProvider | None = None,
    limit: int = 6,
) -> list[LocalActivity]:
    """Return verified candidates for the family's local date.

    Dated events need organizer evidence and a single explicit future date.
    An official venue / programs calendar can still be useful with no date.
    """
    if not city.strip():
        return []
    area = NearbyEventsRequest(city=city, region=region, country=country.upper(), locale=locale)
    band = _age_band(age_band)
    key = (area.city.casefold(), area.region.casefold(), area.country, area.locale, band, today.isoformat())
    requested_limit = max(1, min(limit, _RESULT_LIMIT))
    default_provider = provider is None
    known = _cache.get(key) if default_provider else None
    if known and monotonic() < known[0]:
        _cache.move_to_end(key)
        return [item.copy() for item in known[1][:requested_limit]]
    finder = provider if provider is not None else TavilySearchProvider()

    async def search(resource: bool) -> list[SearchResult] | None:
        try:
            async with asyncio.timeout(14):
                return await finder.fetch(_query(area, band, today, resource=resource))
        except (SearchUnavailable, TimeoutError):
            return None

    pages = await asyncio.gather(search(False), search(True))
    results = [result for page in pages if page for result in page]
    candidates = _collect(results, area, band, today, await _verify_events(results))
    if any(page is None for page in pages) and not candidates:
        raise LocalActivitiesUnavailable("Local activity lookup unavailable") from None
    if default_provider and all(page is not None for page in pages):
        _cache[key] = (monotonic() + _CACHE_TTL_SECONDS, candidates)
        _cache.move_to_end(key)
        if len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return [item.copy() for item in candidates[:requested_limit]]
