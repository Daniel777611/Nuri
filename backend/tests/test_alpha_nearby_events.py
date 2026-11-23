from datetime import date

import pytest
from pydantic import ValidationError

from backend.alpha_nearby_events import NearbyEventsRequest, parse_nearby_events
from backend.websearch import SearchResult


def source(snippet: str, url: str = "https://library.example.org/events/storytime") -> SearchResult:
    return SearchResult(title="Children's storytime workshop", snippet=snippet, url=url)


@pytest.mark.parametrize("date_text", ["November 24, 2026", "24 November 2026", "2026-11-24"])
def test_explicit_local_date_has_organizer_reference(date_text):
    request = NearbyEventsRequest(city="Savannah", region="GA", country="US")
    event = source(f"Register for the Savannah, Georgia library storytime on {date_text}.")
    rows = parse_nearby_events([event, event], request, date(2026, 11, 22))
    assert len(rows) == 1
    assert (rows[0]["date"], rows[0]["category"], rows[0]["url"]) == ("2026-11-24", "library", event.url)


def test_rejects_other_cities_ambiguous_dates_cancellations_and_listing_pages():
    request = NearbyEventsRequest(city="Savannah", region="GA", country="US")
    examples = [
        source("Savannah, Tennessee library event on November 24, 2026."),
        source("Atlanta, Georgia library event on November 24, 2026."),
        source("Savannah, GA library storytime. On Tuesday."),
        source("Savannah, GA library events on November 24, 2026 and December 2, 2026."),
        source("Savannah, GA library event November 24, 2026 cancelled."),
        source("Savannah, GA library event November 21, 2026."),
        source("Savannah, GA library event November 24, 2026.", "https://library.example.org/events"),
        source("Savannah, GA library event November 24, 2026.", "https://localhost.test/storytime"),
    ]
    assert parse_nearby_events(examples, request, date(2026, 11, 22)) == []


def test_interprets_a_chinese_calendar_date_and_does_not_accept_coordinates():
    request = NearbyEventsRequest(city="臺北市", country="TW", locale="zh-TW")
    event = source("臺北市圖書館新書親子活動，2026年11月24日，請事先報名。")
    assert parse_nearby_events([event], request, date(2026, 11, 22))[0]["date"] == "2026-11-24"
    with pytest.raises(ValidationError):
        NearbyEventsRequest(city="Savannah", latitude=32.08)
    with pytest.raises(ValidationError):
        NearbyEventsRequest(city="123 private street")
