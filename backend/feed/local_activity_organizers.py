"""Read trusted organizer event pages. Search snippets never supply event facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from html import unescape
from html.parser import HTMLParser
import json
import re
from urllib.parse import urlsplit


FORT_BEND_HOST = "www.fortbendlibraries.gov"
FORT_BEND_ALIASES = frozenset({
    FORT_BEND_HOST, "fortbendlibraries.gov", "www.fortbend.lib.tx.us", "fortbend.lib.tx.us",
})
_FORT_BEND_EVENT = re.compile(r"/event/[a-z0-9][a-z0-9-]{0,150}-[1-9][0-9]{0,9}/?", re.I)
_REGISTRATION_FORM = "lc-registration-ui-registration-form-opener-form"


@dataclass(frozen=True)
class OrganizerEvent:
    title: str
    starts_at: datetime
    ends_at: datetime
    time_zone: str
    description: str
    venue_name: str
    address: str
    room: str = ""
    audience: tuple[str, ...] = ()
    program: str = ""
    registration_required: bool | None = None
    registration_url: str | None = None
    registration_notes: str | None = None
    cost: str | None = None


def fort_bend_event_url(url: str) -> str | None:
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in FORT_BEND_ALIASES
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.query or not _FORT_BEND_EVENT.fullmatch(parsed.path)):
        return None
    return f"https://{FORT_BEND_HOST}{parsed.path.rstrip('/')}"


def clean_text(value: object, limit: int = 1200) -> str:
    if not isinstance(value, str):
        return ""
    value = " ".join(unescape(re.sub(r"<[^>]*>", " ", value)).split())
    if len(value) <= limit:
        return value
    return value[:limit - 1].rstrip() + "…"


def _local_time(value: object) -> datetime | None:
    if not isinstance(value, str) or "T" not in value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.utcoffset() is not None else None


def _cost(value: object, source_url: str) -> str | None:
    if not isinstance(value, dict) or value.get("url") != source_url:
        return None
    price, currency = value.get("price"), value.get("priceCurrency")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        return None
    try:
        amount = Decimal(str(price))
    except InvalidOperation:
        return None
    if not amount.is_finite() or not 0 <= amount <= 100000:
        return None
    return "Free" if amount == 0 else f"{currency} {amount:.2f}"


class FortBendEventHTML(HTMLParser):
    """Capture metadata and only the primary article's own supporting fields."""

    def __init__(self, source_url: str):
        super().__init__(convert_charrefs=True)
        self.source_url = source_url
        self.canonical = ""
        self.metadata: list[dict] = []
        self.json_text: list[str] | None = None
        self.in_event = False
        self.in_registration_form = False
        self.fields: dict[str, list[str]] = {}
        self.capture: tuple[str, str, int] | None = None
        self.chunks: list[str] = []

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        classes = (attr.get("class") or "").split()
        if tag == "link" and attr.get("rel") == "canonical":
            self.canonical = attr.get("href") or ""
        elif tag == "script" and attr.get("type") == "application/ld+json":
            self.json_text = []
        if tag == "article" and "lc-event--full" in classes:
            self.in_event = True
        if not self.in_event:
            return
        if (tag == "form" and attr.get("id") == _REGISTRATION_FORM
                and attr.get("action") == urlsplit(self.source_url).path):
            self.in_registration_form = True
        if self.capture:
            field, active_tag, depth = self.capture
            if tag == active_tag:
                self.capture = field, active_tag, depth + 1
            return
        field = next((field for css, field in (
            ("lc-event-room", "room"), ("lc-event__age-groups", "age"),
            ("lc-event__program-types", "program"), ("lc-messages__message", "registration"),
        ) if css in classes), None)
        if field:
            self.capture = field, tag, 1
            self.chunks = []

    def handle_data(self, data):
        if self.json_text is not None:
            self.json_text.append(data)
        if self.capture:
            self.chunks.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.json_text is not None:
            try:
                value = json.loads("".join(self.json_text))
                if isinstance(value, dict) and value.get("@type") == "Event":
                    self.metadata.append(value)
            except json.JSONDecodeError:
                pass
            self.json_text = None
        if tag == "article":
            self.in_event = False
        if self.capture and tag == self.capture[1]:
            field, active_tag, depth = self.capture
            self.capture = (field, active_tag, depth - 1) if depth > 1 else None
            if depth == 1:
                self.fields.setdefault(field, []).append(clean_text(" ".join(self.chunks), 300))

    def event(self) -> OrganizerEvent | None:
        if self.canonical != self.source_url or len(self.metadata) != 1:
            return None
        row = self.metadata[0]
        if (row.get("eventStatus") != "https://schema.org/EventScheduled"
                or row.get("eventAttendanceMode") != "https://schema.org/OfflineEventAttendanceMode"):
            return None
        title = clean_text(row.get("name"), 160)
        start, end = _local_time(row.get("startDate")), _local_time(row.get("endDate"))
        location = row.get("location")
        if not title or not start or not end or end <= start or not isinstance(location, dict):
            return None
        street = location.get("address")
        venue = clean_text(location.get("name"), 160)
        if not venue or not isinstance(street, dict):
            return None
        address = [clean_text(street.get(field), 160) for field in (
            "streetAddress", "addressLocality", "addressRegion", "postalCode",
        )]
        if not all(address[:3]):
            return None
        age = ", ".join(self.fields.get("age") or []).removeprefix("Age Group:").strip()
        program = ", ".join(self.fields.get("program") or []).removeprefix("Program Type:").strip()
        description = clean_text(row.get("description"))
        registration = self.fields.get("registration") or []
        required = any("registration is required" in entry.casefold() for entry in registration)
        description_optional = re.search(
            r"\b(?:no registration (?:is )?(?:required|needed)|registration (?:is )?(?:not required|optional))\b",
            description, re.I,
        )
        description_requires = re.search(r"\b(?:registration (?:is )?required|must (?:pre-)?register)\b",
                                         description, re.I)
        requirement = True if required else None
        if requirement is None:
            if description_optional:
                requirement = False
            elif description_requires:
                requirement = True
        notes = [entry for entry in registration if entry.casefold().startswith("registration")
                 and "is required" not in entry.casefold()]
        return OrganizerEvent(
            title, start, end, "America/Chicago", description, venue,
            f"{address[0]}, {address[1]}, {' '.join(part for part in address[2:] if part)}",
            room=next(iter(self.fields.get("room") or []), ""),
            audience=tuple(part.strip() for part in age.split(",") if part.strip()),
            program=program,
            registration_required=requirement,
            registration_url=f"{self.source_url}#{_REGISTRATION_FORM}" if self.in_registration_form else None,
            registration_notes=" ".join(notes)[:400] or None,
            cost=_cost(row.get("offers"), self.source_url),
        )


class FortBendListingHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.urls: dict[str, None] = {}

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        href = dict(attrs).get("href") or ""
        if _FORT_BEND_EVENT.fullmatch(href):
            self.urls.setdefault(f"https://{FORT_BEND_HOST}{href.rstrip('/')}", None)
