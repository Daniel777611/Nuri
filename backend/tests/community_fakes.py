"""An in-memory stand-in for the Supabase client, enough for backend/community.py.

It implements the PostgREST builder calls the module uses, the unique keys
from supabase/migrations/20261105010000_community.sql (so idempotency races
are real), identity `seq` columns, and the storage bucket calls for media.
"""

from __future__ import annotations

import itertools
import re
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


class UniqueViolation(Exception):
    code = "23505"


# table -> list of unique column tuples; a callable predicate makes it partial.
UNIQUE = {
    "community_profiles": [("user_id",), ("public_id",)],
    "community_preferences": [("user_id",)],
    "community_questions": [("author_id", "client_request_id")],
    "community_question_deliveries": [("question_id", "recipient_id")],
    "community_replies": [("delivery_id",), ("author_id", "client_request_id")],
    "community_comments": [("author_id", "client_message_id")],
    "community_invitations": [("sender_id", "client_request_id"),
                              (("sender_id", "recipient_id"), lambda r: r.get("state") == "pending")],
    "community_relationships": [("user_low", "user_high")],
    "community_blocks": [("blocker_id", "blocked_id")],
    "community_conversations": [("user_low", "user_high")],
    "community_messages": [("sender_id", "client_message_id")],
    "community_read_cursors": [("conversation_id", "user_id")],
    "community_ai_consent_requests": [("initiator_id", "client_request_id")],
    "community_ai_consent_decisions": [("request_id", "user_id")],
    "community_ai_requests": [("user_id", "kind", "client_request_id")],
    "community_media": [("owner_id", "client_request_id"), ("storage_path",)],
    "notification_events": [("dedupe_key",)],
}
NO_ID = {"community_profiles", "community_preferences", "community_blocks",
         "community_read_cursors", "community_ai_consent_decisions"}
SEQ = {"community_profiles", "community_questions", "community_question_deliveries",
       "community_replies", "community_comments", "community_invitations",
       "community_relationships", "community_blocks", "community_conversations",
       "community_messages"}
DEFAULTS = {
    "community_profiles": lambda: {"public_id": str(uuid.uuid4()), "version": 1,
                                   "approx_lat": None, "approx_lng": None, "avatar_media_id": None},
    "community_questions": lambda: {"version": 1, "status": "open"},
    "community_question_deliveries": lambda: {"version": 1, "lock_reason": None},
    "community_invitations": lambda: {"version": 1, "decided_at": None},
    "community_relationships": lambda: {"version": 1},
    "community_conversations": lambda: {"ai_epoch": 0, "last_message_seq": None, "last_message_at": None},
    "community_ai_consent_requests": lambda: {"version": 1, "effective_from_seq": None},
    "community_preferences": lambda: {"version": 1},
    "notification_events": lambda: {"read_at": None},
    "community_comments": lambda: {"reply_id": None},
}


def _value(row, key):
    if "->>" in key:
        col, sub = key.split("->>", 1)
        return (row.get(col) or {}).get(sub)
    return row.get(key)


def _cmp(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return (a > b) - (a < b)
    a, b = str(a), str(b)
    return (a > b) - (a < b)


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.orders, self.limit_n = [], [], None
        self.op, self.payload, self.on_conflict, self.ignore_dup = "select", None, None, False

    # builder ------------------------------------------------------------
    def select(self, *_a, **_k): return self
    def _f(self, fn): self.filters.append(fn); return self
    def eq(self, k, v): return self._f(lambda r: _value(r, k) is not None and str(_value(r, k)) == str(v)
                                       if not isinstance(v, bool) else _value(r, k) is v)
    def neq(self, k, v): return self._f(lambda r: str(_value(r, k)) != str(v))
    def in_(self, k, vs): s = {str(v) for v in vs}; return self._f(lambda r: str(_value(r, k)) in s)
    def lt(self, k, v): return self._f(lambda r: _value(r, k) is not None and _cmp(_value(r, k), v) < 0)
    def lte(self, k, v): return self._f(lambda r: _value(r, k) is not None and _cmp(_value(r, k), v) <= 0)
    def gt(self, k, v): return self._f(lambda r: _value(r, k) is not None and _cmp(_value(r, k), v) > 0)
    def gte(self, k, v): return self._f(lambda r: _value(r, k) is not None and _cmp(_value(r, k), v) >= 0)

    def _like(self, k, pattern, flags):
        rx = re.compile("^" + "".join(".*" if c == "%" else "." if c == "_" else re.escape(c)
                                      for c in pattern) + "$", flags)
        return self._f(lambda r: _value(r, k) is not None and bool(rx.match(str(_value(r, k)))))

    def like(self, k, p): return self._like(k, p, 0)
    def ilike(self, k, p): return self._like(k, p, re.IGNORECASE)

    def is_(self, k, v):
        assert v == "null"
        return self._f(lambda r: _value(r, k) is None)

    def order(self, k, desc=False): self.orders.append((k, desc)); return self
    def limit(self, n): self.limit_n = n; return self
    def insert(self, payload): self.op, self.payload = "insert", payload; return self
    def update(self, payload): self.op, self.payload = "update", dict(payload); return self
    def delete(self): self.op = "delete"; return self

    def upsert(self, payload, on_conflict=None, ignore_duplicates=False):
        self.op, self.payload = "upsert", payload
        self.on_conflict, self.ignore_dup = on_conflict, ignore_duplicates
        return self

    # execution ----------------------------------------------------------
    def _hits(self, rows):
        return [r for r in rows if all(f(r) for f in self.filters)]

    def _check_unique(self, rows, candidate, ignore=None):
        for spec in UNIQUE.get(self.table, []):
            cols, pred = (spec, None) if not callable(spec[-1]) else (spec[0], spec[1])
            if pred and not pred(candidate):
                continue
            key = tuple(candidate.get(c) for c in cols)
            if any(v is None for v in key):
                continue
            for r in rows:
                if r is ignore:
                    continue
                if pred and not pred(r):
                    continue
                if tuple(r.get(c) for c in cols) == key:
                    raise UniqueViolation(f"duplicate key value violates unique constraint on {cols}")

    def _new_row(self, payload):
        row = {}
        row.update(DEFAULTS.get(self.table, dict)())
        if self.table not in NO_ID:
            row["id"] = str(uuid.uuid4())
        if self.table in SEQ:
            row["seq"] = next(self.db.seq)
        row["created_at"] = self.db.tick()
        row.update(payload)
        return row

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        self.db.calls.append((self.table, self.op))
        if self.db.fail_tables and self.table in self.db.fail_tables:
            raise RuntimeError("storage down")
        if self.op in ("insert", "upsert"):
            payloads = self.payload if isinstance(self.payload, list) else [self.payload]
            out = []
            for p in payloads:
                row = self._new_row(dict(p))
                try:
                    self._check_unique(rows, row)
                except UniqueViolation:
                    if self.op == "upsert" and self.ignore_dup:
                        continue
                    raise
                rows.append(row)
                out.append(dict(row))
            return SimpleNamespace(data=out)
        hits = self._hits(rows)
        if self.op == "update":
            out = []
            for r in hits:
                merged = {**r, **self.payload}
                self._check_unique(rows, merged, ignore=r)
                r.update(self.payload)
                out.append(dict(r))
            return SimpleNamespace(data=out)
        if self.op == "delete":
            for r in hits:
                rows.remove(r)
            return SimpleNamespace(data=[dict(r) for r in hits])
        for k, desc in reversed(self.orders):
            present = [r for r in hits if _value(r, k) is not None]
            missing = [r for r in hits if _value(r, k) is None]
            present.sort(key=lambda r: (_value(r, k) if isinstance(_value(r, k), (int, float))
                                        else str(_value(r, k))), reverse=desc)
            hits = present + missing
        if self.limit_n is not None:
            hits = hits[: self.limit_n]
        return SimpleNamespace(data=[dict(r) for r in hits])


class Bucket:
    def __init__(self, store):
        self.store = store

    def create_signed_upload_url(self, path):
        return {"signed_url": f"https://storage.test/upload/{path}", "token": "upload-token", "path": path}

    def upload(self, path, data, file_options=None):
        if path in self.store.objects:
            raise RuntimeError("object exists")
        self.store.objects[path] = bytes(data)
        return {"path": path}

    def download(self, path):
        if path not in self.store.objects:
            raise RuntimeError("object not found")
        return self.store.objects[path]

    def create_signed_url(self, path, expires_in):
        return {"signedURL": f"https://storage.test/read/{path}?ttl={expires_in}"}

    def remove(self, paths):
        for p in paths:
            self.store.objects.pop(p, None)
        return [{"name": p} for p in paths]


class Storage:
    def __init__(self):
        self.objects = {}

    def from_(self, _bucket):
        return Bucket(self)


class FakeDB:
    def __init__(self):
        self.tables = {}
        self.seq = itertools.count(1)
        self.calls = []
        self.fail_tables = set()
        self.storage = Storage()
        self._clock = datetime(2026, 11, 5, 8, 0, tzinfo=timezone.utc)

    def tick(self):
        # Strictly increasing timestamps, close to now so 24h windows work.
        self._clock += timedelta(milliseconds=1)
        return datetime.now(timezone.utc).isoformat() if self.real_time else self._clock.isoformat()

    real_time = True

    def table(self, name):
        return Query(self, name)

    def rows(self, name):
        return self.tables.setdefault(name, [])
