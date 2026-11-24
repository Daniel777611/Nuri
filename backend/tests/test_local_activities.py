from datetime import date
from html import escape
import json
from urllib.parse import urlencode

import httpx
import pytest
from pydantic import ValidationError

from backend.feed import local_activities as activities
from backend.search_tavily import SearchUnavailable
from backend.websearch import SearchResult


TODAY = date(2026, 11, 23)
AREA = {"city": "Savannah", "region": "GA", "country": "US", "locale": "en"}
MONTEREY = {"city": "Monterey Park", "region": "CA", "country": "US", "locale": "en"}
MONTEREY_HOST = "www.montereypark.ca.gov"
FORT_BEND_HOST = "www.fortbendlibraries.gov"
SUGAR_LAND = {"city": "Sugar Land", "region": "TX", "country": "US", "locale": "zh-CN"}


def fixture_source(title, text, path="/events/storytime", host="savannahga.gov"):
    return SearchResult(title=title, snippet=text, url=f"https://{host}{path}")


class FakeProvider:
    def __init__(self, events=(), resources=()):
        self.queues = [events, resources]
        self.requests = []

    async def fetch(self, request):
        result = self.queues[len(self.requests)]
        self.requests.append(request)
        if isinstance(result, Exception):
            raise result
        return list(result)


def organizer_page(title, details, description="A library storytime for all ages. No registration required.",
                   location="318 S Ramona Ave, Monterey Park CA 91754", extra=""):
    return (
        f'<h1 class="calendar-event-title headline">{escape(title)}</h1>'
        f'<div id="event-description">{escape(description)}</div>'
        f'<div aria-label="Event details"><div>{escape(details)}</div></div>'
        '<div aria-label="Event location"><a>Monterey Park Bruggemeyer Library</a>'
        f'<a href="https://maps.google.com/maps?q=library">{escape(location)}</a></div>'
        f'{extra}'
    )


class _HtmlStream(httpx.AsyncByteStream):
    def __init__(self, html):
        self.html = html.encode()

    async def __aiter__(self):
        for index in range(0, len(self.html), 8192):
            yield self.html[index:index + 8192]


@pytest.fixture(autouse=True)
def organizer_http(monkeypatch):
    routes = {}
    visited = []

    def handle(request):
        visited.append(str(request.url))
        html, status, headers = routes.get(str(request.url), ("", 404, {}))
        return httpx.Response(status, headers={"Content-Type": "text/html", **headers}, stream=_HtmlStream(html))

    monkeypatch.setattr(activities, "_organizer_client",
                        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle), follow_redirects=False))
    return routes, visited


@pytest.mark.anyio
async def test_real_event_canonical_and_complete_details(organizer_http):
    routes, visited = organizer_http
    event = fixture_source(
        "Preschool Storytime", "Date: November 24, 2026. Monterey Park CA.",
        "/Calendar.aspx?EID=13076&utm_source=search#calendar", MONTEREY_HOST,
    )
    canonical = f"https://{MONTEREY_HOST}/m/calendar/event/detail/13076"
    duplicates = fixture_source(event.title, event.snippet, "/m/calendar/event/detail/13076?gclid=track", MONTEREY_HOST)
    routes[canonical] = (organizer_page(
        event.title, "11:30 AM - 12:00 PM | Wednesday, November 25, 2026",
        description="Preschool Storytime is for children ages 3 - 5 and their caregivers.",
        extra='<div aria-labelledby="calendar-related-events-heading">'
              '<div aria-label="Event details">6:30 PM - 7:00 PM | Tuesday, November 24, 2026</div></div>',
    ), 200, {})
    resource = fixture_source(
        "Monterey Park Public Library Children's Events Calendar",
        "Find recurring children's programs and visit in Monterey Park, CA. Storytime on November 25, 2026.",
        "/events/calendar", MONTEREY_HOST,
    )
    provider = FakeProvider([event, duplicates, resource])
    items = await activities.discover_local_activities(**MONTEREY, today=TODAY, provider=provider, age_band="preschool")
    [first] = items
    assert first["kind"] == "dated_event"
    assert first["start_date"] == "2026-11-25"
    assert first["end_date"] == "2026-11-25"
    assert first["starts_at"] == "2026-11-25T11:30:00-08:00"
    assert first["ends_at"] == "2026-11-25T12:00:00-08:00"
    assert first["source_url"] == canonical
    assert first["venue_name"] == "Monterey Park Bruggemeyer Library"
    assert first["address"] == "318 S Ramona Ave, Monterey Park CA 91754"
    assert first["age_label"] == "3–5 years"
    assert first["event_source_verified"] is True
    assert "November 24" not in first["summary"]
    assert visited == [canonical]
    assert len(provider.requests) == 1
    assert all('"Monterey Park, CA, US"' in request.query and "preschool" in request.query
               for request in provider.requests)


def fort_bend_event_page(source, *, registration_status, has_event_form, status="EventScheduled"):
    detail = {
        "@type": "Event", "eventStatus": f"https://schema.org/{status}",
        "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
        "name": "Toddler Time", "startDate": "2026-12-01T10:30:00-06:00",
        "endDate": "2026-12-01T11:15:00-06:00",
        "description": "<p>Stories and songs for children ages 12–36 months and their caregivers.</p>",
        "location": {"name": "Sugar Land Branch Library", "address": {
            "streetAddress": "550 Eldridge Rd", "addressLocality": "Sugar Land",
            "addressRegion": "TX", "postalCode": "77478",
        }},
        "offers": {"price": "0.00", "priceCurrency": "USD", "url": source},
    }
    form_path = source.removeprefix(f"https://{FORT_BEND_HOST}") if has_event_form else "/events"
    return (
        f'<link rel="canonical" href="{source}">'
        f'<script type="application/ld+json">{json.dumps(detail)}</script>'
        '<article class="lc-event--full"><p class="lc-event-room">Meeting Room</p>'
        '<div class="lc-event__age-groups">Age Group: Preschool</div>'
        f'<div class="lc-messages__message">{registration_status}</div>'
        f'<form id="lc-registration-ui-registration-form-opener-form" action="{form_path}"></form>'
        '</article>'
    )


@pytest.mark.anyio
async def test_fort_bend_listing_keeps_exact_official_event_and_registration_links(organizer_http):
    routes, visited = organizer_http
    source = f"https://{FORT_BEND_HOST}/event/toddler-time-138092"
    no_direct = f"https://{FORT_BEND_HOST}/event/toddler-time-138093"
    closed = f"https://{FORT_BEND_HOST}/event/toddler-time-138094"
    canceled = f"https://{FORT_BEND_HOST}/event/toddler-time-138095"
    query = urlencode([
        ("branches[103]", 103), ("branches[108]", 108), ("branches[109]", 109),
        ("age_groups[500]", 500), ("age_groups[91]", 91),
    ])
    listing = f"https://{FORT_BEND_HOST}/events/list?{query}"
    routes[listing] = ("".join(
        f'<a href="{url.removeprefix(f"https://{FORT_BEND_HOST}")}">Toddler Time</a>'
        for url in (source, no_direct, closed, canceled)
    ) + '<a href="/events/month">The calendar</a>', 200, {})
    routes[source] = (fort_bend_event_page(
        source, registration_status="Registration is required for this event.", has_event_form=True,
    ), 200, {})
    routes[no_direct] = (fort_bend_event_page(
        no_direct, registration_status="Registration is required for this event.", has_event_form=False,
    ), 200, {})
    routes[closed] = (fort_bend_event_page(
        closed, registration_status="Registration is closed.", has_event_form=False,
    ), 200, {})
    routes[canceled] = (fort_bend_event_page(
        canceled, registration_status="", has_event_form=False, status="EventCancelled",
    ), 200, {})

    first, second = await activities.discover_local_activities(
        **SUGAR_LAND, today=TODAY, age_band="toddler", provider=FakeProvider(SearchUnavailable("test")),
    )
    assert first["source_url"] == source
    assert first["registration_required"] is True
    assert first["registration_url"] == f"{source}#lc-registration-ui-registration-form-opener-form"
    assert first["cost"] == "免费"
    assert first["age_label"] == "12–36个月"
    assert first["starts_at"] == "2026-12-01T10:30:00-06:00"
    assert first["ends_at"] == "2026-12-01T11:15:00-06:00"
    assert first["venue_name"] == "Sugar Land Branch Library"
    assert first["address"] == "550 Eldridge Rd, Sugar Land, TX 77478"
    assert first["room"] == "Meeting Room"
    assert second["source_url"] == no_direct and second["registration_required"] is True
    assert second["registration_url"] is None
    assert set(visited) == {listing, source, no_direct, closed, canceled}


@pytest.mark.anyio
async def test_excludes_expired_mismatched_city_mismatched_age_and_non_organizers():
    examples = [
        fixture_source("Library Storytime", "Savannah, Georgia library event on November 21, 2026."),
        fixture_source("Library Storytime", "Savannah, Tennessee library event on November 24, 2026."),
        fixture_source("Teen Library Workshop", "Savannah, Georgia teen workshop on November 25, 2026."),
        fixture_source("Children's Library Workshop", "Savannah, Georgia family event on November 25, 2026. Ages 7–10."),
        fixture_source("Library Storytime", "Savannah, Georgia library event on November 24, 2026.", host="eventbrite.com"),
        fixture_source("Library Storytime", "Savannah, Georgia library event on November 24, 2026.", path="/events/secret?token=secret"),
        fixture_source("Library Storytime", "Savannah, Georgia library event on November 24, 2026. Event postponed."),
        fixture_source("Library Storytime", "Savannah, Georgia library event. Published on November 23, 2026."),
        fixture_source("Library Storytime", "Savannah, Georgia library event on November 24, 2026 and November 25, 2026."),
        fixture_source("Library Storytime", "Savannah, Georgia library event on Tuesday."),
        fixture_source("Library Storytime", "Savannah, Georgia library event on November 24, 2026.", host="127.0.0.1"),
        fixture_source("Library Storytime", "Savannah, Georgia library event on November 24, 2026.", host="internal.local"),
    ]
    items = await activities.discover_local_activities(
        **AREA, today=TODAY, provider=FakeProvider(examples), age_band="toddler",
    )
    assert items == []


@pytest.mark.anyio
async def test_localized_input_excludes_generic_sources_and_only_sends_age_band():
    program = fixture_source(
        "臺北市圖書館親子故事活動", "臺北市圖書館親子故事活動。每週開放親子共讀服務。",
        "/library/family-storytime",
        host="library.gov.taipei",
    )
    provider = FakeProvider([program])
    items = await activities.discover_local_activities(
        city="臺北市", region="臺北市", country="TW", locale="zh-TW", today=TODAY,
        age_band="private input 2022-10-10", provider=provider,
    )
    assert items == []
    assert all("臺北市" in request.query and request.lang == "zh" and "private input" not in request.query
               and "2022-10-10" not in request.query for request in provider.requests)


@pytest.mark.anyio
async def test_official_calendar_layout_and_regular_storytime_are_distinct(organizer_http):
    # Recorded public page excerpts exercise the organizer's own layout.
    host = "www.montereypark.ca.gov"
    event = fixture_source(
        "Calendar • Family Storytime",
        "11:00 AM - 11:30 AM | Saturday, December 5, 2026. Library Storytime Room. "
        "Monterey Park CA 91754. Family storytime is for all ages.",
        path="/m/calendar/event/detail/12977", host=host,
    )
    routes, _ = organizer_http
    routes[event.url] = (organizer_page(
        "Family Storytime", "11:00 AM - 11:30 AM | Saturday, December 5, 2026",
    ), 200, {})
    program = fixture_source(
        "Storytime | Monterey Park, CA - Official Website",
        "Family Storytime. Tuesdays at 6:30 p.m. in the Storytime Room. "
        "Monterey Park Bruggemeyer Library. Monterey Park, CA 91754.",
        path="/285/Storytime", host=host,
    )
    copied = fixture_source(program.title, program.snippet, path="/285/Storytime", host="montereyparklibrary.com")
    items = await activities.discover_local_activities(
        city="Monterey Park", region="CA", country="US", age_band="preschool",
        locale="en", today=TODAY, provider=FakeProvider([event, program, copied]),
    )
    assert [(item["kind"], item["start_date"], item["source_url"]) for item in items] == [
        ("dated_event", "2026-12-05", event.url),
    ]
    assert items[0]["registration_required"] is False


@pytest.mark.anyio
@pytest.mark.parametrize("failure", ["redirect", "duplicate_details", "wrong_weekday", "expired", "wrong_city", "oversized"])
async def test_unverified_or_expired_event_never_becomes_a_resource(failure, organizer_http):
    routes, visited = organizer_http
    event = fixture_source(
        "Monterey Park Library Storytime Programs",
        "Monterey Park, CA recurring family programs. Date: November 24, 2026.",
        "/m/calendar/event/detail/13076", MONTEREY_HOST,
    )
    when = "11:30 AM - 12:00 PM | Wednesday, November 25, 2026"
    location = "Monterey Park CA 91754"
    extra = ""
    status, headers = 200, {}
    if failure == "redirect":
        status, headers = 302, {"Location": "https://example.org/event"}
    if failure == "duplicate_details":
        extra = '<div aria-label="Event details">10:00 AM - 11:00 AM | Thursday, November 26, 2026</div>'
    if failure == "wrong_weekday":
        when = when.replace("Wednesday", "Tuesday")
    if failure == "expired":
        when = "11:30 AM - 12:00 PM | Sunday, November 22, 2026"
    if failure == "wrong_city":
        location = "Flagstaff AZ 86001"
    html = organizer_page("Library Storytime", when, location=location, extra=extra)
    if failure == "oversized":
        html = "<!--" + "x" * activities._ORGANIZER_BODY_LIMIT + "-->" + html
    routes[event.url] = (html, status, headers)

    unknown = fixture_source(event.title, event.snippet, "/m/calendar/event/detail/13076", "unverified.gov")
    assert await activities.discover_local_activities(
        **MONTEREY, today=TODAY, provider=FakeProvider([event, unknown]),
    ) == []
    assert visited == [event.url]


@pytest.mark.anyio
async def test_same_city_name_requires_the_requested_international_region():
    cambridge_uk = fixture_source(
        "Public Library Storytime Programs", "Cambridge, Cambridgeshire, weekly family activities.",
        path="/library/children",
        host="cambridgeshire.gov.uk",
    )
    cambridge_us = fixture_source(
        "Public Library Storytime Programs", "Cambridge, Massachusetts, weekly family activities.",
        path="/library/children",
        host="cambridgema.gov",
    )
    area = activities.NearbyEventsRequest(city="Cambridge", region="Cambridgeshire", country="GB", locale="en")
    assert activities._matches_area(area, cambridge_uk.snippet)
    assert not activities._matches_area(area, cambridge_us.snippet)

    london_uk = fixture_source(
        "Public Library Storytime Programs", "Recurring family workshops in London on Saturdays.",
        path="/library/children",
        host="london.gov.uk",
    )
    london_ca = fixture_source(
        "Public Library Storytime Programs", "London, ON, recurring family workshops on Saturdays.",
        path="/library/children",
        host="londonpubliclibrary.ca",
    )
    area = activities.NearbyEventsRequest(city="London", region="Ontario", country="CA", locale="en")
    assert activities._matches_area(area, london_ca.snippet)
    assert not activities._matches_area(area, london_uk.snippet)


@pytest.mark.anyio
async def test_school_age_accepts_a_source_for_ages_starting_at_five(organizer_http):
    routes, _ = organizer_http
    event = fixture_source(
        "Children's Library Workshop", "Savannah, Georgia weekly family program. Ages 5–6.",
        path="/m/calendar/event/detail/12456", host=MONTEREY_HOST,
    )
    routes[event.url] = (organizer_page(
        event.title, "11:00 AM - 11:30 AM | Saturday, December 5, 2026",
        description="Children's library workshop for ages 5–6.",
    ), 200, {})
    [item] = await activities.discover_local_activities(
        **MONTEREY, today=TODAY, provider=FakeProvider([event]), age_band="school_age",
    )
    assert item["source_url"] == event.url
    assert item["age_label"] == "5–6 years"
    assert await activities.discover_local_activities(
        **MONTEREY, today=TODAY, provider=FakeProvider([event]), age_band="toddler",
    ) == []


@pytest.mark.anyio
async def test_blank_or_precise_location_does_not_contact_provider():
    provider = FakeProvider()
    assert await activities.discover_local_activities(city="", today=TODAY, provider=provider) == []
    with pytest.raises(ValidationError):
        await activities.discover_local_activities(city="130 Private St", today=TODAY, provider=provider)
    assert provider.requests == []


@pytest.mark.anyio
async def test_provider_failure_is_distinct_from_empty_results():
    failing = SearchUnavailable("private vendor error")
    with pytest.raises(activities.LocalActivitiesUnavailable, match="^Local activity lookup unavailable$"):
        await activities.discover_local_activities(**AREA, today=TODAY, provider=FakeProvider(failing))
    assert await activities.discover_local_activities(
        **AREA, today=TODAY, provider=FakeProvider(),
    ) == []


@pytest.mark.anyio
async def test_cache_is_scoped_to_area_age_band_locale_and_day(monkeypatch, organizer_http):
    routes, _ = organizer_http
    event = fixture_source(
        "Library Storytime Programs", "Savannah, Georgia recurring family programs.",
        path="/m/calendar/event/detail/12555", host=MONTEREY_HOST,
    )
    routes[event.url] = (organizer_page(
        event.title, "11:00 AM - 11:30 AM | Saturday, December 5, 2026",
    ), 200, {})
    provider = FakeProvider([event])

    async def fetch(request):
        provider.requests.append(request)
        return [event]

    monkeypatch.setattr(provider, "fetch", fetch)
    monkeypatch.setattr(activities, "TavilySearchProvider", lambda: provider)
    monkeypatch.setattr(activities, "_cache", activities.OrderedDict())
    rows = await activities.discover_local_activities(**MONTEREY, today=TODAY, age_band="toddler")
    rows[0]["title"] = "locally modified"
    again = await activities.discover_local_activities(**MONTEREY, today=TODAY, age_band="toddler")
    assert len(provider.requests) == 1
    assert again[0]["title"] == event.title
    await activities.discover_local_activities(**MONTEREY, today=TODAY, age_band="preschool")
    assert len(provider.requests) == 2
    after = await activities.discover_local_activities(**MONTEREY, today=date(2026, 11, 26), age_band="preschool")
    assert after and after[0]["kind"] == "dated_event"
    assert len(provider.requests) == 3
