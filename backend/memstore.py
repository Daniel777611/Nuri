"""The in-memory fallback stores, for when Supabase is unavailable.

Every `_db_*` helper in the store layer follows the same shape: try the
database, and on no-client or failure fall back to one of these. That is what
makes the app runnable with no credentials at all, which is how most of the
test suite and every local preview runs.

Process-local and therefore per-worker: two Vercel instances do not see each
other's data. That is fine for the purpose — this is a development and
degraded-mode fallback, not a cache and not a database.

**Never rebind these names.** Other modules hold references to the objects, so
`tasks = [t for t in tasks if ...]` updates only the rebinding module's view and
silently leaves everyone else on the old list. Mutate in place — `tasks[:] =
[...]`, `.clear()`, `.pop()`. Four sites in main.py used `global` to rebind and
had to be converted when this module was split out.

State that genuinely is a scalar and genuinely is reassigned — the feed mode,
the "does the events table exist" probe — deliberately lives with its own store
module instead, where `global` is correct and local.
"""

from __future__ import annotations

import asyncio
from typing import Any

users_email: dict[str, dict] = {}     # email -> user doc
users_id:    dict[str, dict] = {}     # id    -> user doc
children:    list[dict]      = []
sessions:    dict[str, dict] = {}     # session_id -> session doc
messages:    dict[str, list] = {}     # session_id -> [msg, ...]
tasks:       list[dict]      = []
favorites:   dict[str, set]  = {}     # uid_or_anon -> {card_id, ...}
collections: dict[str, list] = {}     # uid_or_anon -> [{id, name, created_at}]
fav_cols:    dict[str, dict] = {}     # uid_or_anon -> {card_id: collection_id|None}
analytics:   list[dict]      = []
privacy:     dict[str, dict] = {}     # uid_or_singleton -> settings

#: (uid, recommendation_id) -> snapshot
recommendation_snapshots: dict[tuple[str, str], dict] = {}
#: uid -> [event, ...]
recommendation_events: dict[str, list[dict]] = {}
#: uid -> lock. Appends read-modify-write a user's whole event list, so
#: concurrent turns for one parent must not interleave.
recommendation_event_locks: dict[str, asyncio.Lock] = {}


def clear_all() -> None:
    """Wipe everything. Used by the anonymous branch of /privacy/wipe."""
    for container in (
        users_email, users_id, sessions, messages, favorites, collections,
        fav_cols, privacy, recommendation_snapshots, recommendation_events,
        recommendation_event_locks,
    ):
        container.clear()
    children.clear()
    tasks.clear()
    analytics.clear()
