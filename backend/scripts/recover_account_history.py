"""Conservatively copy visible chat history and long-term memory between accounts.

This is an operator tool, not an application endpoint.  Its deliberately small
scope is:

* children
* chat sessions (mapped to the target's existing or deterministically created
  canonical session)
* chat messages
* normalized inputs
* user memories

It never changes or deletes a source row and it does not migrate tasks,
recommendations, favourites, permissions, privacy settings, or credentials.
The default mode is a read-only dry run, but a full local JSON backup is still
written so the operator can inspect and independently archive it before using
``--apply``.

PostgREST does not provide a transaction spanning several HTTP requests.
Recovery is therefore compensating and restart-safe: inserted identifiers are
UUIDv5 values derived from the target and source row IDs, existing target rows
are never overwritten, every planned row is re-read before the optional target
placeholder greeting is removed, and the source remains a complete rollback
copy.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

PAGE_SIZE = 500
ID_NAMESPACE = uuid.UUID("e47ff7c9-0f87-5d77-b151-976df81a6a37")
_EMAIL_RE = re.compile(
    r"(?=.{3,254}\Z)"
    r"[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@"
    r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]{2,63}\Z"
)
TABLES = (
    "users",
    "children",
    "chat_sessions",
    "chat_messages",
    "normalized_inputs",
    "user_memories",
)

# Known NOT NULL fields from the checked-in migrations.  Rows are copied with
# every unknown column intact, so a newly added required column is preserved.
# Missing known fields are unsafe because PostgREST may otherwise apply a
# default and silently change historical meaning.
REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "users": ("id", "email", "nickname", "city", "hashed_password", "created_at"),
    "children": (
        "id", "user_id", "nickname", "birth_date", "gender", "allergies",
        "notes", "created_at",
    ),
    "chat_sessions": ("id", "title", "script_key", "step", "created_at"),
    "chat_messages": (
        "id", "session_id", "role", "text", "quick_replies", "created_at",
    ),
    "normalized_inputs": (
        "id", "source", "raw_text", "normalized_text",
        "normalization_version", "context_hints", "created_at",
    ),
    "user_memories": (
        "id", "user_id", "category", "key", "value", "confidence",
        "source_type", "status", "created_at", "updated_at",
    ),
}


class RecoveryError(RuntimeError):
    """Safe-to-display operator failure without row contents."""


class RecoveryConflict(RecoveryError):
    """The observed data cannot be merged without an unsafe choice."""


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def canonical_email(value: str) -> str:
    """Require the exact canonical address that will be queried in ``users``."""

    if not isinstance(value, str) or value != value.strip() or not value:
        raise RecoveryError("email must be non-empty, trimmed, and canonical")
    # Registration lower-cases addresses before storing them.  This deliberately
    # accepts a conservative ASCII subset instead of normalising operator input:
    # a Unicode/case rewrite during an account recovery is an ambiguity, not a
    # convenience.  The subsequent query also requires one exact returned row.
    if value != value.casefold() or not _EMAIL_RE.fullmatch(value):
        raise RecoveryError("email must exactly match a valid lower-case stored address")
    return value


def masked_email(value: str) -> str:
    local, _, domain = value.partition("@")
    visible = local[:1] if local else "?"
    return f"{visible}***@{domain}" if domain else "***"


def id_hash(value: object) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:12]


def deterministic_id(entity: str, target_uid: str, source_id: str) -> str:
    return str(uuid.uuid5(ID_NAMESPACE, f"{entity}:{target_uid}:{source_id}"))


def normalize_child_name(value: object) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(char for char in normalized.strip() if not char.isspace())


def child_identity(row: Mapping[str, Any]) -> tuple[str, str]:
    nickname = normalize_child_name(row.get("nickname"))
    raw_birth = str(row.get("birth_date") or "")
    try:
        birth = date.fromisoformat(raw_birth).isoformat()
    except ValueError as exc:
        raise RecoveryConflict(
            f"child {id_hash(row.get('id'))} has an invalid birth_date"
        ) from exc
    if not nickname:
        raise RecoveryConflict(
            f"child {id_hash(row.get('id'))} has an empty normalized nickname"
        )
    return nickname, birth


def _jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(
        _jsonable(value), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


def rows_equal(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    return canonical_json(left) == canonical_json(right)


def _dedupe_rows(rows: Iterable[Mapping[str, Any]], table: str) -> list[dict]:
    found: dict[str, dict] = {}
    for raw in rows:
        row = dict(raw)
        row_id = str(row.get("id") or "")
        if not row_id:
            raise RecoveryConflict(f"{table} contains a row without id")
        previous = found.get(row_id)
        if previous is not None and not rows_equal(previous, row):
            raise RecoveryConflict(
                f"{table} returned inconsistent copies of row {id_hash(row_id)}"
            )
        found[row_id] = row
    return sorted(found.values(), key=lambda row: str(row.get("id") or ""))


def validate_required_fields(table: str, rows: Sequence[Mapping[str, Any]]) -> list[str]:
    failures: list[str] = []
    for row in rows:
        for field_name in REQUIRED_FIELDS[table]:
            if field_name not in row or row[field_name] is None:
                failures.append(
                    f"{table} row={id_hash(row.get('id'))} missing_required={field_name}"
                )
    return failures


def _response_rows(result: object, table: str) -> list[dict]:
    data = getattr(result, "data", None)
    if not isinstance(data, list):
        raise RecoveryError(f"database returned an invalid response for {table}")
    if not all(isinstance(row, dict) for row in data):
        raise RecoveryError(f"database returned a non-object row for {table}")
    return [dict(row) for row in data]


def paged_select(
    client: object,
    table: str,
    configure: Optional[Callable[[Any], Any]] = None,
) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        query = client.table(table).select("*")
        if configure:
            query = configure(query)
        query = query.range(offset, offset + PAGE_SIZE - 1)
        try:
            batch = _response_rows(query.execute(), table)
        except RecoveryError:
            raise
        except Exception as exc:
            raise RecoveryError(
                f"database read failed for {table} ({type(exc).__name__})"
            ) from exc
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows


def select_in(client: object, table: str, column: str, values: Iterable[str]) -> list[dict]:
    unique_values = sorted({str(value) for value in values if value is not None})
    if not unique_values:
        return []
    rows: list[dict] = []
    for start in range(0, len(unique_values), 100):
        batch = unique_values[start : start + 100]
        rows.extend(
            paged_select(
                client,
                table,
                lambda query, batch=batch: query.in_(column, batch),
            )
        )
    return _dedupe_rows(rows, table)


def find_user_by_email(client: object, email: str) -> dict:
    try:
        result = (
            client.table("users").select("*").eq("email", email).limit(2).execute()
        )
        rows = _response_rows(result, "users")
    except RecoveryError:
        raise
    except Exception as exc:
        raise RecoveryError(
            f"database read failed for users ({type(exc).__name__})"
        ) from exc
    if len(rows) != 1:
        raise RecoveryConflict(
            f"expected exactly one users row for {masked_email(email)}; found {len(rows)}"
        )
    if rows[0].get("email") != email:
        raise RecoveryConflict(f"database did not return an exact email match for {masked_email(email)}")
    return rows[0]


@dataclass(frozen=True)
class BackupArtifact:
    backup_path: Path
    manifest_path: Path
    sha256: str


@dataclass
class RecoverySnapshot:
    target_user: dict
    source_users: list[dict]
    tables: dict[str, list[dict]]

    @property
    def target_uid(self) -> str:
        return str(self.target_user["id"])

    @property
    def source_uids(self) -> set[str]:
        return {str(row["id"]) for row in self.source_users}

    def document(self) -> dict:
        return {
            "format": "nuri-account-history-backup-v1",
            "created_at": _utc_now().isoformat(),
            "target_user_id": self.target_uid,
            "source_user_ids": sorted(self.source_uids),
            "tables": {table: self.tables[table] for table in TABLES},
        }


@dataclass
class RecoveryPlan:
    canonical_session_id: Optional[str] = None
    child_map: dict[str, str] = field(default_factory=dict)
    session_map: dict[str, str] = field(default_factory=dict)
    message_map: dict[str, str] = field(default_factory=dict)
    inserts: dict[str, list[dict]] = field(
        default_factory=lambda: {
            "children": [],
            "chat_sessions": [],
            "chat_messages": [],
            "normalized_inputs": [],
            "user_memories": [],
        }
    )
    conflicts: list[str] = field(default_factory=list)
    preserved_memory_conflicts: list[str] = field(default_factory=list)
    notices: list[str] = field(default_factory=list)
    placeholder_greeting_id: Optional[str] = None
    placeholder_greeting_row: Optional[dict] = None

    @property
    def safe_to_apply(self) -> bool:
        return not self.conflicts and bool(self.canonical_session_id)


@dataclass(frozen=True)
class RecoveryResult:
    applied: bool
    backup: BackupArtifact
    plan: RecoveryPlan


def collect_snapshot(client: object, target_email: str, source_emails: Sequence[str]) -> RecoverySnapshot:
    target = find_user_by_email(client, target_email)
    sources = [find_user_by_email(client, email) for email in source_emails]
    target_uid = str(target.get("id") or "")
    source_uids = [str(row.get("id") or "") for row in sources]
    if not target_uid or any(not uid for uid in source_uids):
        raise RecoveryConflict("a selected users row has no id")
    if target_uid in source_uids or len(source_uids) != len(set(source_uids)):
        raise RecoveryConflict("target and source accounts must be distinct")

    account_uids = [target_uid, *source_uids]
    children = select_in(client, "children", "user_id", account_uids)
    sessions = select_in(client, "chat_sessions", "user_id", account_uids)
    child_ids = [str(row["id"]) for row in children]
    session_ids = [str(row["id"]) for row in sessions]
    messages = select_in(client, "chat_messages", "session_id", session_ids)

    normalized_inputs = _dedupe_rows(
        [
            *select_in(client, "normalized_inputs", "user_id", account_uids),
            *select_in(client, "normalized_inputs", "child_id", child_ids),
            *select_in(client, "normalized_inputs", "session_id", session_ids),
        ],
        "normalized_inputs",
    )
    memories = _dedupe_rows(
        [
            *select_in(client, "user_memories", "user_id", account_uids),
            *select_in(client, "user_memories", "child_id", child_ids),
        ],
        "user_memories",
    )
    users = sorted([target, *sources], key=lambda row: str(row["id"]))
    tables = {
        "users": users,
        "children": children,
        "chat_sessions": sessions,
        "chat_messages": messages,
        "normalized_inputs": normalized_inputs,
        "user_memories": memories,
    }
    return RecoverySnapshot(target_user=target, source_users=sources, tables=tables)


def write_backup(
    snapshot: RecoverySnapshot,
    backup_dir: Path,
    *,
    target_email: str,
    source_emails: Sequence[str],
) -> BackupArtifact:
    backup_dir = backup_dir.expanduser().resolve()
    backup_dir.mkdir(parents=True, exist_ok=True)
    try:
        backup_dir.chmod(0o700)
    except OSError:
        pass

    stamp = _utc_now().strftime("%Y%m%dT%H%M%S.%fZ")
    stem = f"account-history-{stamp}-{id_hash(snapshot.target_uid)}"
    backup_path = backup_dir / f"{stem}.json"
    manifest_path = backup_dir / f"{stem}.manifest.json"
    payload = (canonical_json(snapshot.document()) + "\n").encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()

    try:
        with backup_path.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            backup_path.chmod(0o600)
        except OSError:
            pass
        manifest = {
            "format": "nuri-account-history-backup-manifest-v1",
            "backup_file": backup_path.name,
            "sha256": digest,
            "bytes": len(payload),
            "target_email_masked": masked_email(target_email),
            "source_emails_masked": [masked_email(value) for value in source_emails],
            "target_user_hash": id_hash(snapshot.target_uid),
            "source_user_hashes": sorted(id_hash(value) for value in snapshot.source_uids),
            "row_counts": {table: len(snapshot.tables[table]) for table in TABLES},
            "created_at": _utc_now().isoformat(),
        }
        manifest_payload = (canonical_json(manifest) + "\n").encode("utf-8")
        with manifest_path.open("xb") as handle:
            handle.write(manifest_payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            manifest_path.chmod(0o600)
        except OSError:
            pass
    except Exception as exc:
        for path in (manifest_path, backup_path):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise RecoveryError(f"could not write backup ({type(exc).__name__})") from exc

    if hashlib.sha256(backup_path.read_bytes()).hexdigest() != digest:
        raise RecoveryError("backup SHA256 verification failed")
    return BackupArtifact(backup_path=backup_path, manifest_path=manifest_path, sha256=digest)


def _source_rows(snapshot: RecoverySnapshot, table: str) -> list[dict]:
    source_uids = snapshot.source_uids
    return [row for row in snapshot.tables[table] if str(row.get("user_id")) in source_uids]


def _target_rows(snapshot: RecoverySnapshot, table: str) -> list[dict]:
    target_uid = snapshot.target_uid
    return [row for row in snapshot.tables[table] if str(row.get("user_id")) == target_uid]


def _copy_row(raw: Mapping[str, Any], **updates: Any) -> dict:
    row = _jsonable(dict(raw))
    row.update(updates)
    return row


def _child_profile_signature(row: Mapping[str, Any]) -> str:
    # created_at and IDs are provenance, not identity/profile disagreement.
    fields = {
        key: row.get(key)
        for key in row
        if key not in {"id", "user_id", "created_at"}
    }
    return canonical_json(fields)


def _memory_key(row: Mapping[str, Any], mapped_child_id: Optional[str]) -> tuple[str, str, str]:
    return (
        mapped_child_id or "",
        str(row.get("category") or ""),
        str(row.get("key") or ""),
    )


def _row_index(rows: Sequence[Mapping[str, Any]]) -> dict[str, dict]:
    return {str(row.get("id")): dict(row) for row in rows if row.get("id")}


def build_plan(snapshot: RecoverySnapshot) -> RecoveryPlan:
    plan = RecoveryPlan()
    for table in TABLES:
        plan.conflicts.extend(validate_required_fields(table, snapshot.tables[table]))
    if plan.conflicts:
        return plan

    target_uid = snapshot.target_uid
    source_uids = snapshot.source_uids
    target_sessions = _target_rows(snapshot, "chat_sessions")
    source_sessions = _source_rows(snapshot, "chat_sessions")
    if len(target_sessions) > 1:
        plan.conflicts.append(
            f"target must have at most one canonical session; found {len(target_sessions)}"
        )
        return plan
    if target_sessions:
        canonical_session_id = str(target_sessions[0]["id"])
    elif source_sessions:
        earliest_source_session = min(
            source_sessions,
            key=lambda row: (str(row.get("created_at") or ""), str(row["id"])),
        )
        canonical_session_id = deterministic_id(
            "chat_session", target_uid, str(earliest_source_session["id"])
        )
    else:
        plan.conflicts.append(
            "target has no canonical session and no source session can seed one"
        )
        return plan
    plan.canonical_session_id = canonical_session_id

    plan.session_map = {
        str(row["id"]): canonical_session_id for row in source_sessions
    }

    target_children = _target_rows(snapshot, "children")
    source_children = _source_rows(snapshot, "children")
    target_by_identity: dict[tuple[str, str], list[dict]] = {}
    source_by_identity: dict[tuple[str, str], list[dict]] = {}
    try:
        for row in target_children:
            target_by_identity.setdefault(child_identity(row), []).append(row)
        for row in source_children:
            source_by_identity.setdefault(child_identity(row), []).append(row)
    except RecoveryConflict as exc:
        plan.conflicts.append(str(exc))
        return plan

    for identity, rows in sorted(source_by_identity.items()):
        matches = target_by_identity.get(identity, [])
        if len(matches) > 1:
            plan.conflicts.append(
                "ambiguous target child identity=" + id_hash(canonical_json(identity))
            )
            continue
        if matches:
            target_child = matches[0]
            target_child_id = str(target_child["id"])
            for source_child in rows:
                plan.child_map[str(source_child["id"])] = target_child_id
                if _child_profile_signature(source_child) != _child_profile_signature(target_child):
                    plan.notices.append(
                        "target child profile preserved identity="
                        + id_hash(canonical_json(identity))
                    )
            continue

        signatures = {_child_profile_signature(row) for row in rows}
        if len(signatures) > 1:
            plan.conflicts.append(
                "source child profiles disagree identity=" + id_hash(canonical_json(identity))
            )
            continue
        source_child = sorted(
            rows,
            key=lambda row: (str(row.get("created_at") or ""), str(row["id"])),
        )[0]
        identity_material = f"{identity[0]}:{identity[1]}"
        target_child_id = deterministic_id("child", target_uid, identity_material)
        plan.inserts["children"].append(
            _copy_row(source_child, id=target_child_id, user_id=target_uid)
        )
        for row in rows:
            plan.child_map[str(row["id"])] = target_child_id

    if plan.conflicts:
        return plan

    if not target_sessions:
        earliest_source_session = min(
            source_sessions,
            key=lambda row: (str(row.get("created_at") or ""), str(row["id"])),
        )
        session_updates: dict[str, Any] = {
            "id": canonical_session_id,
            "user_id": target_uid,
            "title": "NURI",
            "source_card_id": None,
        }
        # Newer deployments may attach a child directly to a session.  Copy the
        # column only when it exists in the live row, and never retain a source
        # account's child identifier.
        if "child_id" in earliest_source_session:
            source_session_child = earliest_source_session.get("child_id")
            if source_session_child is None:
                session_updates["child_id"] = None
            elif str(source_session_child) in plan.child_map:
                session_updates["child_id"] = plan.child_map[str(source_session_child)]
            else:
                plan.conflicts.append(
                    "seed chat_session has an unmapped child row="
                    + id_hash(earliest_source_session["id"])
                )
        for field_name, cleared_value in (
            ("state_summary", None),
            ("state_covered_tokens", 0),
            ("state_updated_at", None),
        ):
            if field_name in earliest_source_session:
                session_updates[field_name] = cleared_value
        plan.inserts["chat_sessions"].append(
            _copy_row(earliest_source_session, **session_updates)
        )

    if plan.conflicts:
        return plan

    all_messages = snapshot.tables["chat_messages"]
    target_message_index = _row_index(
        [row for row in all_messages if str(row.get("session_id")) == canonical_session_id]
    )
    source_session_ids = set(plan.session_map)
    source_messages = [
        row for row in all_messages if str(row.get("session_id")) in source_session_ids
    ]
    for row in sorted(source_messages, key=lambda item: (str(item["created_at"]), str(item["id"]))):
        source_id = str(row["id"])
        target_id = deterministic_id("message", target_uid, source_id)
        planned = _copy_row(
            row, id=target_id, session_id=canonical_session_id
        )
        plan.message_map[source_id] = target_id
        existing = target_message_index.get(target_id)
        if existing is not None:
            if not rows_equal(existing, planned):
                plan.conflicts.append(
                    f"chat_messages deterministic id collision row={id_hash(target_id)}"
                )
            continue
        plan.inserts["chat_messages"].append(planned)
        target_message_index[target_id] = planned

    target_messages_before = [
        row for row in all_messages if str(row.get("session_id")) == canonical_session_id
    ]
    user_messages_before = [
        row for row in target_messages_before if str(row.get("role") or "").casefold() == "user"
    ]
    if (
        len(target_messages_before) == 1
        and not user_messages_before
        and str(target_messages_before[0].get("role") or "").casefold() in {"ai", "assistant"}
    ):
        plan.placeholder_greeting_id = str(target_messages_before[0]["id"])
        plan.placeholder_greeting_row = dict(target_messages_before[0])

    source_child_ids = set(plan.child_map)
    target_child_ids = {str(row["id"]) for row in target_children}
    source_normalized = []
    for row in snapshot.tables["normalized_inputs"]:
        user_link = str(row.get("user_id") or "")
        session_link = str(row.get("session_id") or "")
        child_link = str(row.get("child_id") or "")
        source_links = sum(
            (
                user_link in source_uids,
                session_link in source_session_ids,
                child_link in source_child_ids,
            )
        )
        target_links = sum(
            (
                user_link == target_uid,
                session_link == canonical_session_id,
                child_link in target_child_ids,
            )
        )
        if source_links and target_links:
            plan.conflicts.append(
                f"normalized_inputs has mixed account links row={id_hash(row.get('id'))}"
            )
        elif source_links:
            source_normalized.append(row)

    target_normalized_index = _row_index(
        [row for row in snapshot.tables["normalized_inputs"] if str(row.get("user_id")) == target_uid]
    )
    for row in sorted(source_normalized, key=lambda item: (str(item["created_at"]), str(item["id"]))):
        source_id = str(row["id"])
        child_id = row.get("child_id")
        session_id = row.get("session_id")
        if child_id is not None and str(child_id) not in plan.child_map:
            plan.conflicts.append(
                f"normalized_inputs has unmapped child row={id_hash(source_id)}"
            )
            continue
        if session_id is not None and str(session_id) not in plan.session_map:
            plan.conflicts.append(
                f"normalized_inputs has unmapped session row={id_hash(source_id)}"
            )
            continue
        target_id = deterministic_id("normalized_input", target_uid, source_id)
        planned = _copy_row(
            row,
            id=target_id,
            user_id=target_uid,
            child_id=plan.child_map.get(str(child_id)) if child_id is not None else None,
            session_id=canonical_session_id if session_id is not None else None,
        )
        existing = target_normalized_index.get(target_id)
        if existing is not None:
            if not rows_equal(existing, planned):
                plan.conflicts.append(
                    f"normalized_inputs deterministic id collision row={id_hash(target_id)}"
                )
            continue
        plan.inserts["normalized_inputs"].append(planned)
        target_normalized_index[target_id] = planned

    target_memories = _target_rows(snapshot, "user_memories")
    memory_index: dict[tuple[str, str, str], dict] = {
        _memory_key(row, str(row["child_id"]) if row.get("child_id") is not None else None): row
        for row in target_memories
    }
    for row in sorted(
        _source_rows(snapshot, "user_memories"),
        key=lambda item: (str(item["created_at"]), str(item["id"])),
    ):
        source_id = str(row["id"])
        child_id = row.get("child_id")
        if child_id is not None and str(child_id) not in plan.child_map:
            plan.conflicts.append(f"user_memories has unmapped child row={id_hash(source_id)}")
            continue
        mapped_child = plan.child_map.get(str(child_id)) if child_id is not None else None
        logical_key = _memory_key(row, mapped_child)
        if logical_key in memory_index:
            plan.preserved_memory_conflicts.append(
                "target memory preserved key_hash=" + id_hash(canonical_json(logical_key))
            )
            continue
        target_id = deterministic_id("user_memory", target_uid, source_id)
        mapped_source_id = plan.message_map.get(str(row.get("source_id")), row.get("source_id"))
        planned = _copy_row(
            row,
            id=target_id,
            user_id=target_uid,
            child_id=mapped_child,
            source_id=mapped_source_id,
        )
        plan.inserts["user_memories"].append(planned)
        memory_index[logical_key] = planned

    for table, rows in plan.inserts.items():
        plan.conflicts.extend(validate_required_fields(table, rows))
    return plan


def _fetch_by_ids(client: object, table: str, ids: Iterable[str]) -> dict[str, dict]:
    return _row_index(select_in(client, table, "id", ids))


def preflight_global_id_collisions(client: object, plan: RecoveryPlan) -> None:
    for table, planned_rows in plan.inserts.items():
        if not planned_rows:
            continue
        existing = _fetch_by_ids(client, table, [str(row["id"]) for row in planned_rows])
        for row in planned_rows:
            row_id = str(row["id"])
            if row_id in existing and not rows_equal(existing[row_id], row):
                raise RecoveryConflict(
                    f"{table} deterministic id collision row={id_hash(row_id)}"
                )


def _insert_rows(client: object, table: str, rows: Sequence[dict]) -> None:
    if not rows:
        return
    existing = _fetch_by_ids(client, table, [str(row["id"]) for row in rows])
    missing = []
    for row in rows:
        row_id = str(row["id"])
        if row_id in existing:
            if not rows_equal(existing[row_id], row):
                raise RecoveryConflict(
                    f"{table} existing row differs row={id_hash(row_id)}"
                )
        else:
            missing.append(row)
    for start in range(0, len(missing), 100):
        batch = missing[start : start + 100]
        try:
            client.table(table).insert(batch).execute()
        except Exception as exc:
            raise RecoveryError(
                f"database insert failed for {table} ({type(exc).__name__})"
            ) from exc


def verify_applied_rows(client: object, plan: RecoveryPlan) -> None:
    for table, planned_rows in plan.inserts.items():
        if not planned_rows:
            continue
        actual = _fetch_by_ids(client, table, [str(row["id"]) for row in planned_rows])
        for planned in planned_rows:
            row_id = str(planned["id"])
            if row_id not in actual or not rows_equal(actual[row_id], planned):
                raise RecoveryError(
                    f"post-copy verification failed for {table} row={id_hash(row_id)}"
                )


def _source_snapshot_rows(snapshot: RecoverySnapshot) -> dict[str, list[dict]]:
    source_uids = snapshot.source_uids
    source_children = _source_rows(snapshot, "children")
    source_sessions = _source_rows(snapshot, "chat_sessions")
    source_child_ids = {str(row["id"]) for row in source_children}
    source_session_ids = {str(row["id"]) for row in source_sessions}
    return {
        "users": [
            row for row in snapshot.tables["users"] if str(row.get("id")) in source_uids
        ],
        "children": source_children,
        "chat_sessions": source_sessions,
        "chat_messages": [
            row
            for row in snapshot.tables["chat_messages"]
            if str(row.get("session_id")) in source_session_ids
        ],
        "normalized_inputs": [
            row
            for row in snapshot.tables["normalized_inputs"]
            if (
                str(row.get("user_id")) in source_uids
                or str(row.get("child_id")) in source_child_ids
                or str(row.get("session_id")) in source_session_ids
            )
        ],
        "user_memories": [
            row
            for row in snapshot.tables["user_memories"]
            if (
                str(row.get("user_id")) in source_uids
                or str(row.get("child_id")) in source_child_ids
            )
        ],
    }


def verify_source_unchanged(client: object, snapshot: RecoverySnapshot) -> None:
    """Detect source edits/new rows before the only target-side deletion."""

    expected = _source_snapshot_rows(snapshot)
    source_uids = snapshot.source_uids
    actual_users = select_in(client, "users", "id", source_uids)
    actual_children = select_in(client, "children", "user_id", source_uids)
    actual_sessions = select_in(client, "chat_sessions", "user_id", source_uids)
    child_ids = [str(row["id"]) for row in actual_children]
    session_ids = [str(row["id"]) for row in actual_sessions]
    actual = {
        "users": actual_users,
        "children": actual_children,
        "chat_sessions": actual_sessions,
        "chat_messages": select_in(client, "chat_messages", "session_id", session_ids),
        "normalized_inputs": _dedupe_rows(
            [
                *select_in(client, "normalized_inputs", "user_id", source_uids),
                *select_in(client, "normalized_inputs", "child_id", child_ids),
                *select_in(client, "normalized_inputs", "session_id", session_ids),
            ],
            "normalized_inputs",
        ),
        "user_memories": _dedupe_rows(
            [
                *select_in(client, "user_memories", "user_id", source_uids),
                *select_in(client, "user_memories", "child_id", child_ids),
            ],
            "user_memories",
        ),
    }
    for table in TABLES:
        if canonical_json(_dedupe_rows(expected[table], table)) != canonical_json(actual[table]):
            raise RecoveryConflict(f"source changed during recovery table={table}")


def delete_verified_placeholder(client: object, plan: RecoveryPlan) -> bool:
    greeting_id = plan.placeholder_greeting_id
    canonical_session_id = plan.canonical_session_id
    if not greeting_id or not canonical_session_id:
        return False
    # The caller built this guard from the original backup and has already
    # verified all copied rows.  Re-read the exact target row before deleting.
    existing = _fetch_by_ids(client, "chat_messages", [greeting_id])
    greeting = existing.get(greeting_id)
    if greeting is None:
        return False  # idempotent re-run
    if plan.placeholder_greeting_row is None or not rows_equal(
        greeting, plan.placeholder_greeting_row
    ):
        raise RecoveryConflict("placeholder greeting changed after planning")
    session_rows = select_in(
        client, "chat_messages", "session_id", [canonical_session_id]
    )
    allowed_ids = {greeting_id, *plan.message_map.values()}
    unexpected_ids = {
        str(row["id"]) for row in session_rows if str(row["id"]) not in allowed_ids
    }
    if unexpected_ids:
        raise RecoveryConflict(
            f"target session gained {len(unexpected_ids)} unplanned message(s)"
        )
    try:
        (
            client.table("chat_messages")
            .delete()
            .eq("id", greeting_id)
            .eq("session_id", canonical_session_id)
            .execute()
        )
    except Exception as exc:
        raise RecoveryError(
            f"placeholder deletion failed ({type(exc).__name__})"
        ) from exc
    if greeting_id in _fetch_by_ids(client, "chat_messages", [greeting_id]):
        raise RecoveryError("placeholder deletion verification failed")
    return True


def apply_plan(
    client: object,
    plan: RecoveryPlan,
    snapshot: Optional[RecoverySnapshot] = None,
) -> bool:
    if not plan.safe_to_apply:
        raise RecoveryConflict("recovery plan contains blocking conflicts")
    preflight_global_id_collisions(client, plan)
    for table in (
        "children",
        "chat_sessions",
        "chat_messages",
        "normalized_inputs",
        "user_memories",
    ):
        _insert_rows(client, table, plan.inserts[table])
    verify_applied_rows(client, plan)
    if snapshot is not None:
        verify_source_unchanged(client, snapshot)
    return delete_verified_placeholder(client, plan)


def recover_account_history(
    client: object,
    *,
    target_email: str,
    source_emails: Sequence[str],
    backup_dir: Path,
    apply: bool = False,
) -> RecoveryResult:
    target_email = canonical_email(target_email)
    if not source_emails:
        raise RecoveryError("at least one --source-email is required")
    normalized_sources = [canonical_email(value) for value in source_emails]
    if len(normalized_sources) != len(set(normalized_sources)):
        raise RecoveryError("source emails must be unique")
    if target_email in normalized_sources:
        raise RecoveryError("target email cannot also be a source email")

    snapshot = collect_snapshot(client, target_email, normalized_sources)
    backup = write_backup(
        snapshot,
        backup_dir,
        target_email=target_email,
        source_emails=normalized_sources,
    )
    plan = build_plan(snapshot)
    if apply:
        if plan.conflicts:
            raise RecoveryConflict(
                f"apply refused: {len(plan.conflicts)} blocking conflict(s); backup={backup.backup_path.name}"
            )
        apply_plan(client, plan, snapshot)
    return RecoveryResult(applied=apply, backup=backup, plan=plan)


def _build_client() -> object:
    url = os.getenv("SUPABASE_URL")
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not service_key:
        raise RecoveryError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"
        )
    try:
        from supabase import create_client
    except ImportError as exc:  # pragma: no cover - deployment packaging guard
        raise RecoveryError("supabase package is not installed") from exc
    return create_client(url, service_key)


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-email", required=True)
    parser.add_argument("--source-email", action="append", required=True)
    parser.add_argument(
        "--backup-dir",
        type=Path,
        default=Path("account-history-backups"),
        help="local directory for the sensitive JSON backup and SHA256 manifest",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write target copies after backup and preflight; default is dry-run",
    )
    return parser.parse_args(argv)


def _print_result(result: RecoveryResult) -> None:
    plan = result.plan
    mode = "APPLIED" if result.applied else "DRY-RUN"
    print(f"[{mode}] backup={result.backup.backup_path.name} sha256={result.backup.sha256}")
    print(
        "planned inserts: "
        + ", ".join(f"{table}={len(rows)}" for table, rows in plan.inserts.items())
    )
    print(
        f"blocking_conflicts={len(plan.conflicts)} "
        f"preserved_memory_conflicts={len(plan.preserved_memory_conflicts)} "
        f"notices={len(plan.notices)}"
    )
    for item in [*plan.conflicts, *plan.preserved_memory_conflicts, *plan.notices]:
        print(f"- {item}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        args = parse_args(argv)
        target = canonical_email(args.target_email)
        sources = [canonical_email(value) for value in args.source_email]
        print(
            f"mode={'apply' if args.apply else 'dry-run'} "
            f"target={masked_email(target)} sources={','.join(masked_email(v) for v in sources)}"
        )
        result = recover_account_history(
            _build_client(),
            target_email=target,
            source_emails=sources,
            backup_dir=args.backup_dir,
            apply=args.apply,
        )
        _print_result(result)
        return 0 if not result.plan.conflicts else 2
    except RecoveryError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
