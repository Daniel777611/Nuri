"""Durable chat messages from a consented Alpha live voice call."""

from datetime import datetime, timedelta, timezone
import logging
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

import anyio
from fastapi import HTTPException
from pydantic import BaseModel, Field, StrictInt, field_validator, model_validator

PROOF_TTL = 3600
_log = logging.getLogger(__name__)


class _Entry(BaseModel):
    item_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    role: Literal["user", "ai"]
    text: str = Field(min_length=1, max_length=2048)
    order: StrictInt = Field(ge=0, le=65535)

    @field_validator("text")
    @classmethod
    def _clean_text(cls, text: str) -> str:
        cleaned = text.strip()
        if not cleaned or "\x00" in cleaned:
            raise ValueError("Voice transcript text is empty or invalid")
        try:
            cleaned.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("Voice transcript text is invalid") from None
        return cleaned


class Transcript(BaseModel):
    session_id: UUID
    call_id: str = Field(pattern=r"^rtc_[A-Za-z0-9_-]{1,128}$")
    expires: StrictInt
    proof: str = Field(pattern=r"^[a-f0-9]{64}$")
    entries: list[_Entry] = Field(min_length=1, max_length=256)

    @model_validator(mode="after")
    def _entries_fit_call(self):
        ids = {entry.item_id for entry in self.entries}
        orders = {entry.order for entry in self.entries}
        if len(ids) != len(self.entries) or len(orders) != len(self.entries):
            raise ValueError("Voice transcript entries must have unique IDs and positions")
        if sum(len(entry.text.encode("utf-8")) for entry in self.entries) > 128 * 1024:
            raise ValueError("Voice transcript is too large")
        return self


def _message_rows(transcript: Transcript) -> list[dict]:
    session_id = str(transcript.session_id)
    # Proof expiration signs the call start. Stable timestamps preserve the
    # order of transcript items even if they arrived or were retried out of order.
    anchor = datetime.fromtimestamp(transcript.expires - PROOF_TTL + 1, tz=timezone.utc)
    return [
        {
            "id": str(uuid5(NAMESPACE_URL, f"urn:nuri:voice:{session_id}:{transcript.call_id}:{entry.item_id}")),
            "session_id": session_id,
            "role": entry.role,
            "text": entry.text,
            "quick_replies": [],
            "transition": {"kind": "realtime_voice"},
            "created_at": (anchor + timedelta(microseconds=entry.order)).isoformat(),
        }
        for entry in sorted(transcript.entries, key=lambda entry: entry.order)
    ]


def _confirm(stored: dict, expected: dict) -> None:
    comparable = ("session_id", "role", "text", "transition")
    if any(stored.get(field) != expected[field] for field in comparable):
        raise HTTPException(409, "Voice transcript item was already saved with different content")
    try:
        timestamp = datetime.fromisoformat(stored["created_at"].replace("Z", "+00:00"))
    except (KeyError, ValueError, TypeError, AttributeError):
        raise HTTPException(503, "Voice transcript has no confirmed timestamp") from None
    if timestamp != datetime.fromisoformat(expected["created_at"]):
        raise HTTPException(409, "Voice transcript item was already saved in a different position")


async def save(sb, transcript: Transcript) -> list[dict]:
    """Insert once and return only rows durably written to the authorized chat."""
    rows = _message_rows(transcript)
    session_id = str(transcript.session_id)
    ids = [row["id"] for row in rows]

    def persist() -> list[dict]:
        def read() -> dict[str, dict]:
            result = sb.table("chat_messages").select("id,session_id,role,text,transition,quick_replies,created_at").eq(
                "session_id", session_id,
            ).in_("id", ids).execute()
            return {entry["id"]: entry for entry in (result.data or [])}

        existing = read()
        new_rows = []
        for row in rows:
            if row["id"] in existing:
                _confirm(existing[row["id"]], row)
            else:
                new_rows.append(row)
        if new_rows:
            sb.table("chat_messages").upsert(new_rows, on_conflict="id", ignore_duplicates=True).execute()
            existing = read()
        if any(row["id"] not in existing for row in rows):
            raise HTTPException(503, "Voice transcript could not be confirmed")
        for row in rows:
            _confirm(existing[row["id"]], row)
        return [existing[row["id"]] for row in rows]

    try:
        return await anyio.to_thread.run_sync(persist)
    except HTTPException:
        raise
    except Exception as exc:
        _log.warning("Voice transcript storage unavailable (%s)", type(exc).__name__)
        raise HTTPException(503, "Could not save the voice transcript") from None
