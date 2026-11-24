"""Discover local family activities from public organizer pages.

The caller authorizes discovery and supplies only a coarse area and age band.
Neither external queries nor the shared in-process cache carry an account ID
or child details. Dated activities require a separate organizer-page check.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from datetime import date, datetime, timedelta
from hashlib import sha256
from html.parser import HTMLParser
import re
from time import monotonic
from typing import Literal, Protocol, TypedDict
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit
from zoneinfo import ZoneInfo

import httpx

from backend.alpha_nearby_events import (
    NearbyEventsRequest,
    _CANCELLED,
    _CANADA_REGIONS,
    _FAMILY,
    _US_STATES,
    _WRITTEN_DATE,
    _dates,
    activity_near_location,
    public_activity_source,
)
from backend.search_tavily import SearchUnavailable, TavilySearchProvider
from backend.websearch import SearchRequest, SearchResult
from .local_activity_organizers import (
    FORT_BEND_HOST, FortBendEventHTML, FortBendListingHTML, OrganizerEvent,
    clean_text, fort_bend_event_url,
)


class LocalActivitiesUnavailable(Exception):
    """The provider was unable to establish whether local results exist."""


class ActivityProvider(Protocol):
    async def fetch(self, request: SearchRequest) -> list[SearchResult]: ...


class LocalActivity(TypedDict):
    id: str
    kind: Literal["dated_event"]
    title: str
    summary: str
    description: str
    source_url: str
    event_source_verified: Literal[True]
    source_label: str
    start_date: str
    end_date: str
    starts_at: str
    ends_at: str
    time_zone: str
    location_label: str
    venue_name: str
    address: str
    room: str | None
    age_label: str
    match_reason: str | None
    registration_required: bool | None
    registration_url: str | None
    registration_notes: str | None
    cost: str | None
    _age_ranges: tuple[tuple[int, int], ...]


_CACHE_TTL_SECONDS = 30 * 60
_CACHE_SIZE = 256
_RESULT_LIMIT = 12
_VERIFICATION_LIMIT = 18
_ORGANIZER_BODY_LIMIT = 384 * 1024
_ORGANIZER_LISTING_LIMIT = 1024 * 1024
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
_CIVICPLUS_TIME_ZONES = {
    "www.montereypark.ca.gov": "America/Los_Angeles",
    "www.flagstaff.az.gov": "America/Phoenix",
    "smithfieldutah.gov": "America/Denver",
    "www.cityoflagunaniguel.org": "America/Los_Angeles",
    "www.dalycity.org": "America/Los_Angeles",
}
_FORT_BEND_AGE_GROUPS = {
    "infant": (500,), "toddler": (500, 91), "preschool": (91,),
    "school_age": (227, 92), "teen": (93, 92),
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
    r"\bage[ds]?\s*(\d{1,2})\s*(?:–|—|-|to|through)\s*(\d{1,2})(?:\s*(months?|years?))?\b|"
    r"(\d{1,2})\s*(?:–|—|-|至|到)\s*(\d{1,2})\s*(歲|岁|個月|个月)",
    re.I,
)
_AGE_RANGE_UNITS = re.compile(r"\b(\d{1,2})\s*(?:–|—|-|to|through)\s*(\d{1,2})\s+(months?|years?)\s+(?:of age|old)", re.I)
_AGE_BANDS_MONTHS = {
    "infant": (0, 11), "toddler": (12, 35), "preschool": (36, 59),
    "school_age": (60, 155), "teen": (156, 215),
}
_ORGANIZER_TIME_DATE = re.compile(
    r"(?P<start>\d{1,2}:\d{2}\s*(?:am|pm))\s*[-–—]\s*(?P<end>\d{1,2}:\d{2}\s*(?:am|pm))"
    r"\s*\|\s*(?P<weekday>(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day),\s*$",
    re.I,
)
_TRACKING_PARAMS = {"fbclid", "gclid", "mc_cid", "mc_eid"}
_PRIVATE_PARAMS = {"token", "auth", "key", "api_key", "email", "session", "session_id", "password"}
_cache: OrderedDict[tuple[str, ...], tuple[float, list[LocalActivity]]] = OrderedDict()


def _age_band(value: str) -> str:
    normalized = value.strip().lower()
    normalized = _AGE_BAND_ALIASES.get(normalized, normalized)
    return normalized if normalized in _AGE_BAND_WORDS else ""


def _query(area: NearbyEventsRequest, band: str, today: date) -> SearchRequest:
    place = ", ".join(filter(None, (area.city, area.region, area.country)))
    terms = f"library storytime parent child workshop official event details {today} to {today + _EVENT_LOOKAHEAD}"
    if area.locale.startswith("zh"):
        terms += " 圖書館 親子活動" if area.locale == "zh-TW" else " 图书馆 亲子活动"
    return SearchRequest(
        query=" ".join(filter(None, (f'"{place}"', _AGE_BAND_WORDS.get(band, ""), terms))),
        lang="en" if area.locale == "en" else "zh",
        max_results=_RESULT_LIMIT,
    )


def _safe_link(url: str) -> tuple[str, str] | None:
    source = public_activity_source(url, allow_listing=True)
    if not source:
        return None
    host, clean_url = source
    parsed = urlsplit(clean_url)
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    if any(key.lower() in _PRIVATE_PARAMS for key, _ in pairs):
        return None
    query = urlencode([(key, value) for key, value in pairs
                       if not key.lower().startswith("utm_") and key.lower() not in _TRACKING_PARAMS])
    return host, parsed._replace(query=query).geturl()


def _organizer_event_url(url: str) -> str | None:
    """Reconstruct the only URL that may be requested for this event ID."""
    if canonical := fort_bend_event_url(url):
        return canonical
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
        self.location_link: str | None = None
        self.location_text: list[str] = []

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
            if self.active[0] == "location" and tag == "a":
                href = attr.get("href") or ""
                self.location_link = "address" if urlsplit(href).hostname == "maps.google.com" else "venue"
                self.location_text = []
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
            if self.location_link:
                self.location_text.append(text)

    def handle_endtag(self, tag):
        if self.hidden == tag:
            self.hidden = None
        if tag == "a" and self.location_link:
            self.fields.setdefault(self.location_link, []).append(clean_text(" ".join(self.location_text), 300))
            self.location_link = None
            return
        if self.completed_primary or self.hidden or not self.active or tag != self.active[1]:
            return
        self.depth -= 1
        if self.depth == 0:
            self.fields.setdefault(self.active[0], []).append(" ".join(" ".join(self.text).split()))
            self.active = None

    def event(self, time_zone: str) -> OrganizerEvent | None:
        if any(len(self.fields.get(field) or []) != 1 for field in (
            "title", "details", "location", "venue", "address",
        )):
            return None
        title = self.fields["title"][0]
        venue = self.fields["venue"][0]
        address = self.fields["address"][0]
        details = self.fields["details"][0]
        dates = list(_WRITTEN_DATE.finditer(details))
        values = _dates(details)
        if not title or not venue or not address or len(dates) != 1 or len(values) != 1:
            return None
        matched = dates[0]
        times = _ORGANIZER_TIME_DATE.fullmatch(details[:matched.start()])
        if not times or matched.end() != len(details):
            return None
        day = next(iter(values))
        if times["weekday"].casefold() != _WEEKDAYS[day.weekday()]:
            return None
        descriptions = self.fields.get("description") or [""]
        if len(descriptions) != 1 or _CANCELLED.search(f"{title} {descriptions[0]} {details}"):
            return None
        zone = ZoneInfo(time_zone)
        try:
            start, end = (
                datetime.combine(day, datetime.strptime(times[key].upper().replace(" ", ""), "%I:%M%p").time(), zone)
                for key in ("start", "end")
            )
        except ValueError:
            return None
        if end <= start:
            return None
        desc = descriptions[0]
        needs_registration = re.search(r"\b(?:registration (?:is )?required|must (?:pre-)?register)\b", desc, re.I)
        no_registration = re.search(r"\b(?:no registration (?:is )?(?:required|needed)|registration is not required)\b",
                                    desc, re.I)
        cost = "Free" if re.search(r"\b(?:free admission|free event|free to attend|no (?:admission )?fee)\b", desc, re.I) else None
        return OrganizerEvent(
            title, start, end, time_zone, desc, venue, address,
            registration_required=False if no_registration else True if needs_registration else None,
            cost=cost,
        )


async def _organizer_html(client: httpx.AsyncClient, url: str, *, limit: int, stop: bytes = b"") -> str | None:
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
                    if len(body) + len(chunk) > limit:
                        return None
                    body.extend(chunk)
                    if stop and stop in body:
                        break
    except (httpx.HTTPError, TimeoutError):
        return None
    return body.decode("utf-8", errors="replace")


async def _verify_organizer(client: httpx.AsyncClient, url: str) -> OrganizerEvent | None:
    if _organizer_event_url(url) != url:
        return None
    if urlsplit(url).hostname == FORT_BEND_HOST:
        html = await _organizer_html(client, url, limit=_ORGANIZER_BODY_LIMIT, stop=b"</article>")
        if html is None:
            return None
        parser = FortBendEventHTML(url)
        parser.feed(html)
        parser.close()
        return parser.event()
    zone = _CIVICPLUS_TIME_ZONES[urlsplit(url).hostname or ""]
    html = await _organizer_html(
        client, url, limit=_ORGANIZER_BODY_LIMIT, stop=b'aria-labelledby="calendar-related-events-heading"',
    )
    if html is None:
        return None
    parser = _OrganizerHTML()
    parser.feed(html)
    parser.close()
    return parser.event(zone)


def _organizer_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(trust_env=False, timeout=4, follow_redirects=False)


async def _fort_bend_listings(area: NearbyEventsRequest, band: str) -> list[str] | None:
    # The organizer publishes these branch and audience IDs in its filters.
    # Use event detail pages for all facts; the list only supplies candidates.
    if area.country != "US" or area.region.casefold() not in {"tx", "texas"} or area.city.casefold() != "sugar land":
        return None
    query = urlencode([
        *((f"branches[{branch}]", branch) for branch in (103, 108, 109)),
        *((f"age_groups[{group}]", group) for group in _FORT_BEND_AGE_GROUPS.get(band, ())),
    ])
    async with _organizer_client() as client:
        body = await _organizer_html(client, f"https://{FORT_BEND_HOST}/events/list?{query}",
                                     limit=_ORGANIZER_LISTING_LIMIT)
    if body is None:
        return None
    parser = FortBendListingHTML()
    parser.feed(body)
    parser.close()
    return list(parser.urls)


async def _verify_events(results: list[SearchResult], known_urls: list[str]) -> dict[str, OrganizerEvent]:
    candidates = [canonical for result in results if (source := _safe_link(result.url))
                  and (canonical := _organizer_event_url(source[1]))]
    chosen = list(dict.fromkeys([*known_urls, *candidates]))[:_VERIFICATION_LIMIT]
    if not chosen:
        return {}
    slots = asyncio.Semaphore(6)
    async with _organizer_client() as client:
        async def verify(url: str) -> OrganizerEvent | None:
            async with slots:
                return await _verify_organizer(client, url)
        answers = await asyncio.gather(*(verify(url) for url in chosen))
    return {url: event for url, event in zip(chosen, answers) if event is not None}


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


_AGE_NAMES = {
    "infant": ("婴儿", "Infants", "嬰兒"),
    "toddler": ("幼儿", "Toddlers", "幼兒"),
    "preschool": ("学龄前儿童", "Preschoolers", "學齡前兒童"),
    "school_age": ("学龄儿童", "School-age children", "學齡兒童"),
    "teen": ("青少年", "Teens", "青少年"),
}
_LIBRARY_GROUPS = {
    "infant": "infant", "preschool": "preschool", "elementary": "school_age",
    "middle grades": "school_age", "teens": "teen",
}
_REGISTRATION_CLOSED = re.compile(
    r"\bregistration (?:is closed|has (?:closed|ended))\b|\bthe event is full\b|报名已结束|報名已截止", re.I,
)


def _copy(locale: str, simplified: str, english: str, traditional: str) -> str:
    return english if locale == "en" else traditional if locale == "zh-TW" else simplified


def _age_evidence(event: OrganizerEvent, locale: str, *, library: bool) -> tuple[tuple[tuple[int, int], ...], str]:
    visible = f"{event.title} {event.description}"
    if _OPEN_TO_ALL.search(visible):
        return ((0, 215),), _copy(locale, "全年龄", "All ages", "全年齡")
    ranges, labels = [], []
    matches = [
        (
            int(m[1] or m[4]), int(m[2] or m[5]),
            (m[3] or "").lower().startswith("month") or m[6] in {"個月", "个月"},
        )
        for m in _AGE_RANGE.finditer(visible)
    ]
    matches.extend((int(m[1]), int(m[2]), m[3].lower().startswith("month"))
                   for m in _AGE_RANGE_UNITS.finditer(visible))
    # These two recurring Fort Bend programs' targets are stated in the
    # organizer's published youth-program guides. Individual events can
    # be tagged Preschool and omit that narrower age range in the body.
    # https://www.fortbendlibraries.gov/media/4172
    if library and not matches:
        if re.match(r"^Toddler Time\b", event.title, re.I):
            matches.append((12, 36, True))
        elif re.match(r"^Mother Goose(?: Time)?\b", event.title, re.I):
            matches.append((0, 12, True))
    for lower, upper, months in dict.fromkeys(matches):
        if not 0 <= lower <= upper <= (215 if months else 21):
            continue
        ranges.append((lower, upper) if months else (lower * 12, upper * 12 + 11))
        labels.append(_copy(
            locale, f"{lower}–{upper}{'个月' if months else '岁'}",
            f"{lower}–{upper} {'months' if months else 'years'}",
            f"{lower}–{upper}{'個月' if months else '歲'}",
        ))
    if ranges:
        return tuple(ranges), ", ".join(labels)
    groups = {group for group, pattern in _AGE_LABELS.items() if pattern.search(event.title)}
    if not groups:
        groups = {_LIBRARY_GROUPS[tag.casefold()] for tag in event.audience if tag.casefold() in _LIBRARY_GROUPS}
    if not groups:
        groups = {group for group, pattern in _AGE_LABELS.items() if pattern.search(event.description)}
    bands = [group for group in _AGE_BANDS_MONTHS if group in groups]
    return (tuple(_AGE_BANDS_MONTHS[group] for group in bands),
            ", ".join(_copy(locale, *_AGE_NAMES[group]) for group in bands))


def _description(event: OrganizerEvent, locale: str, *, library: bool) -> str:
    if event.description:
        return event.description
    if library and re.match(r"^Toddler Time\b", event.title, re.I):
        return _copy(locale, "面向幼儿和照护者的图书馆故事时间。",
                     "A library storytime for toddlers and their caregivers.",
                     "面向幼兒和照顧者的圖書館故事時間。")
    if library and re.match(r"^Mother Goose(?: Time)?\b", event.title, re.I):
        return _copy(locale, "面向尚未学会走路的婴儿和照护者的图书馆亲子活动。",
                     "A library program for pre-walking infants and their caregivers.",
                     "面向尚未學會走路的嬰兒和照顧者的圖書館親子活動。")
    if library and event.program and event.room:
        return _copy(locale, f"图书馆将这场活动归为「{event.program}」，地点为 {event.room}。",
                     f"The library lists this as a {event.program} session in {event.room}.",
                     f"圖書館將這場活動歸為「{event.program}」，地點為 {event.room}。")
    return ""


def _collect(verified: dict[str, OrganizerEvent], area: NearbyEventsRequest, age_band: str,
             today: date) -> list[LocalActivity]:
    # The currently verified organizer integrations all serve U.S. locations.
    if area.country and area.country != "US":
        return []
    items = []
    for url, event in sorted(verified.items(), key=lambda row: (row[1].starts_at, row[0])):
        starts, ends = event.starts_at, event.ends_at
        if not today <= starts.date() <= today + _EVENT_LOOKAHEAD:
            continue
        host = urlsplit(url).hostname or ""
        library = host == FORT_BEND_HOST
        desc = _description(event, area.locale, library=library)
        if not desc or not _matches_area(area, event.address):
            continue
        visible = f"{event.title} {desc}"
        if _CANCELLED.search(visible) or _REGISTRATION_CLOSED.search(f"{desc} {event.registration_notes or ''}"):
            continue
        # A library may publish adult events as well. Require organizer
        # evidence about the children's audience even on a trusted host.
        ages, label = _age_evidence(event, area.locale, library=library)
        if not ages or not (_FAMILY.search(visible) or (library and event.audience)):
            continue
        if age_band:
            low, high = _AGE_BANDS_MONTHS[age_band]
            if not any(a <= high and b >= low for a, b in ages):
                continue
        item_id = sha256(f"{url}\n{starts.date().isoformat()}".encode()).hexdigest()[:24]
        items.append({
            "id": item_id, "kind": "dated_event", "title": clean_text(event.title, 160),
            "summary": clean_text(desc, 220), "description": desc, "source_url": url,
            "event_source_verified": True, "source_label": host,
            "start_date": starts.date().isoformat(), "end_date": ends.date().isoformat(),
            "starts_at": starts.isoformat(), "ends_at": ends.isoformat(), "time_zone": event.time_zone,
            "location_label": event.address, "venue_name": event.venue_name, "address": event.address,
            "room": event.room or None, "age_label": label, "match_reason": None,
            "registration_required": event.registration_required, "registration_url": event.registration_url,
            "registration_notes": event.registration_notes,
            "cost": _copy(area.locale, "免费", "Free", "免費") if event.cost == "Free" else event.cost,
            "_age_ranges": ages,
        })
    return items


async def discover_local_activities(
    *, city: str, region: str = "", country: str = "", age_band: str = "",
    locale: str = "zh-CN", today: date, provider: ActivityProvider | None = None,
    limit: int = 6,
) -> list[LocalActivity]:
    """Verify single event pages in the requested area and date window."""
    if not city.strip():
        return []
    area = NearbyEventsRequest(city=city, region=region, country=country.upper(), locale=locale)
    band = _age_band(age_band)
    key = (area.city.casefold(), area.region.casefold(), area.country, area.locale, band, today.isoformat())
    requested_limit = max(1, min(limit, _VERIFICATION_LIMIT))
    default_provider = provider is None
    known = _cache.get(key) if default_provider else None
    if known and monotonic() < known[0]:
        _cache.move_to_end(key)
        return [item.copy() for item in known[1][:requested_limit]]
    finder = provider if provider is not None else TavilySearchProvider()

    async def search() -> list[SearchResult] | None:
        try:
            async with asyncio.timeout(14):
                return await finder.fetch(_query(area, band, today))
        except (SearchUnavailable, TimeoutError):
            return None

    search_results, official_urls = await asyncio.gather(search(), _fort_bend_listings(area, band))
    verified = await _verify_events(search_results or [], official_urls or [])
    candidates = _collect(verified, area, band, today)
    if search_results is None and official_urls is None and not candidates:
        raise LocalActivitiesUnavailable("Local activity lookup unavailable") from None
    if default_provider and (search_results is not None or official_urls is not None):
        _cache[key] = (monotonic() + _CACHE_TTL_SECONDS, candidates)
        _cache.move_to_end(key)
        if len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return [item.copy() for item in candidates[:requested_limit]]
