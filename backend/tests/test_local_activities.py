from datetime import date

import pytest
from pydantic import ValidationError

from backend.feed import local_activities as activities
from backend.search_tavily import SearchUnavailable
from backend.websearch import SearchResult


TODAY = date(2026, 11, 23)
AREA = {"city": "Savannah", "region": "GA", "country": "US", "locale": "en"}


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


@pytest.mark.anyio
async def test_real_links_honest_date_and_persistent_calendar():
    event = fixture_source(
        "Toddler Storytime at the Library",
        "Join the Savannah, Georgia library for toddler storytime on November 25, 2026.",
        "/events/storytime?utm_source=search&event_id=11#calendar",
    )
    duplicates = fixture_source(event.title, event.snippet, "/events/storytime?event_id=11&gclid=track")
    resource = fixture_source(
        "Savannah Public Library Children's Events Calendar",
        "Find recurring children's programs and visit the library in Savannah, GA. Storytime on November 25, 2026.",
        "/events/calendar",
    )
    provider = FakeProvider([event, duplicates], [resource])
    items = await activities.discover_local_activities(**AREA, today=TODAY, provider=provider, age_band="toddler")
    assert len(items) == 2
    first, second = items
    assert first["kind"] == "dated_event"
    assert first["start_date"] == "2026-11-25"
    assert first["end_date"] is None
    assert first["source_url"] == "https://savannahga.gov/events/storytime?event_id=11"
    assert first["location_label"] == "Savannah, GA, US"
    assert second["kind"] == "ongoing_resource"
    assert second["start_date"] is None
    assert second["source_url"] == resource.url
    assert len(provider.requests) == 2
    assert all('"Savannah, GA, US"' in request.query and "toddler" in request.query
               for request in provider.requests)


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
async def test_localized_input_accepts_explicit_chinese_date_but_only_sends_age_band():
    event = fixture_source(
        "臺北市圖書館親子故事活動",
        "臺北市圖書館親子故事活動，2026年11月25日，請事先報名。",
        "/event/123",
        host="library.gov.taipei",
    )
    provider = FakeProvider([event])
    [item] = await activities.discover_local_activities(
        city="臺北市", region="臺北市", country="TW", locale="zh-TW", today=TODAY,
        age_band="private input 2022-10-10", provider=provider,
    )
    assert item["kind"] == "dated_event"
    assert item["start_date"] == "2026-11-25"
    assert item["title"] == event.title
    assert all("臺北市" in request.query and request.lang == "zh" and "private input" not in request.query
               and "2022-10-10" not in request.query for request in provider.requests)


@pytest.mark.anyio
async def test_official_calendar_layout_and_regular_storytime_are_distinct():
    # Recorded public page excerpts exercise the organizer's own layout.
    host = "www.montereypark.ca.gov"
    event = fixture_source(
        "Calendar • Family Storytime",
        "11:00 AM - 11:30 AM | Saturday, December 5, 2026. Library Storytime Room. "
        "Monterey Park CA 91754. Family storytime is for all ages.",
        path="/m/calendar/event/detail/12977", host=host,
    )
    program = fixture_source(
        "Storytime | Monterey Park, CA - Official Website",
        "Family Storytime. Tuesdays at 6:30 p.m. in the Storytime Room. "
        "Monterey Park Bruggemeyer Library. Monterey Park, CA 91754.",
        path="/285/Storytime", host=host,
    )
    copied = fixture_source(program.title, program.snippet, path="/285/Storytime", host="montereyparklibrary.com")
    items = await activities.discover_local_activities(
        city="Monterey Park", region="CA", country="US", age_band="preschool",
        locale="en", today=TODAY, provider=FakeProvider([event], [program, copied]),
    )
    assert [(item["kind"], item["start_date"], item["source_url"]) for item in items] == [
        ("dated_event", "2026-12-05", event.url),
        ("ongoing_resource", None, program.url),
    ]


@pytest.mark.anyio
async def test_same_city_name_requires_the_requested_international_region():
    cambridge_uk = fixture_source(
        "Library Storytime", "Cambridge, Cambridgeshire, family event on November 25, 2026.",
        host="cambridgeshire.gov.uk",
    )
    cambridge_us = fixture_source(
        "Library Storytime", "Cambridge, Massachusetts, family event on November 25, 2026.",
        host="cambridgema.gov",
    )
    [item] = await activities.discover_local_activities(
        city="Cambridge", region="Cambridgeshire", country="GB", locale="en",
        today=TODAY, provider=FakeProvider([cambridge_us, cambridge_uk]),
    )
    assert item["source_url"] == cambridge_uk.url

    london_uk = fixture_source(
        "Library Storytime", "Family workshop in London on November 25, 2026.",
        host="london.gov.uk",
    )
    london_ca = fixture_source(
        "Library Storytime", "London, ON, family workshop on November 25, 2026.",
        host="londonpubliclibrary.ca",
    )
    [item] = await activities.discover_local_activities(
        city="London", region="Ontario", country="CA", locale="en",
        today=TODAY, provider=FakeProvider([london_uk, london_ca]),
    )
    assert item["source_url"] == london_ca.url


@pytest.mark.anyio
async def test_school_age_accepts_a_source_for_ages_starting_at_five():
    event = fixture_source(
        "Children's Library Workshop", "Savannah, Georgia family event on November 25, 2026. Ages 5–6.",
    )
    [item] = await activities.discover_local_activities(
        **AREA, today=TODAY, provider=FakeProvider([event]), age_band="school_age",
    )
    assert item["source_url"] == event.url
    assert await activities.discover_local_activities(
        **AREA, today=TODAY, provider=FakeProvider([event]), age_band="preschool",
    ) == []


@pytest.mark.anyio
async def test_blank_or_precise_location_does_not_contact_provider():
    provider = FakeProvider()
    assert await activities.discover_local_activities(city="", today=TODAY, provider=provider) == []
    with pytest.raises(ValidationError):
        await activities.discover_local_activities(city="130 Private St", today=TODAY, provider=provider)
    assert provider.requests == []


@pytest.mark.anyio
async def test_partial_provider_failure_is_distinct_from_empty_results():
    resource = fixture_source(
        "Public Library Children's Calendar",
        "Savannah, GA library programs for the whole family. Check visiting hours.",
        "/calendar",
    )
    failing = SearchUnavailable("private vendor error")
    rows = await activities.discover_local_activities(
        **AREA, today=TODAY, provider=FakeProvider(failing, [resource]),
    )
    assert len(rows) == 1 and rows[0]["kind"] == "ongoing_resource"
    with pytest.raises(activities.LocalActivitiesUnavailable, match="^Local activity lookup unavailable$"):
        await activities.discover_local_activities(**AREA, today=TODAY, provider=FakeProvider(failing))
    assert await activities.discover_local_activities(
        **AREA, today=TODAY, provider=FakeProvider(),
    ) == []


@pytest.mark.anyio
async def test_cache_is_scoped_to_area_age_band_locale_and_day(monkeypatch):
    event = fixture_source("Library Storytime", "Savannah, Georgia family event on November 25, 2026.")
    provider = FakeProvider([event])

    async def fetch(request):
        provider.requests.append(request)
        return [event]

    monkeypatch.setattr(provider, "fetch", fetch)
    monkeypatch.setattr(activities, "TavilySearchProvider", lambda: provider)
    monkeypatch.setattr(activities, "_cache", activities.OrderedDict())
    rows = await activities.discover_local_activities(**AREA, today=TODAY, age_band="toddler")
    rows[0]["title"] = "locally modified"
    again = await activities.discover_local_activities(**AREA, today=TODAY, age_band="toddler")
    assert len(provider.requests) == 2
    assert again[0]["title"] == event.title
    await activities.discover_local_activities(**AREA, today=TODAY, age_band="preschool")
    assert len(provider.requests) == 4
    after = await activities.discover_local_activities(**AREA, today=date(2026, 11, 26), age_band="preschool")
    assert after == []
    assert len(provider.requests) == 6
