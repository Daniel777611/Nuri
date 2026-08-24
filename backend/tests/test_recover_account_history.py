from __future__ import annotations

import copy
import hashlib
import json
import re
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from backend.scripts import recover_account_history as recovery


@contextmanager
def _raises(exception_type, match=None):
    try:
        yield
    except exception_type as exc:
        if match is not None and re.search(match, str(exc)) is None:
            raise AssertionError(f"{exc!s} does not match {match!r}") from exc
    else:
        raise AssertionError(f"expected {exception_type.__name__}")


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, database, table):
        self.database = database
        self.table = table
        self.operation = "select"
        self.filters = []
        self.start = None
        self.end = None
        self.limit_count = None
        self.payload = None

    def select(self, _columns):
        self.operation = "select"
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, set(values)))
        return self

    def range(self, start, end):
        self.start, self.end = start, end
        return self

    def limit(self, value):
        self.limit_count = value
        return self

    def insert(self, payload):
        self.operation = "insert"
        self.payload = copy.deepcopy(payload)
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def _matches(self, row):
        for operation, column, expected in self.filters:
            if operation == "eq" and row.get(column) != expected:
                return False
            if operation == "in" and row.get(column) not in expected:
                return False
        return True

    def execute(self):
        rows = self.database.rows.setdefault(self.table, [])
        if self.operation == "insert":
            batch = self.payload if isinstance(self.payload, list) else [self.payload]
            known_ids = {row.get("id") for row in rows}
            for item in batch:
                if item.get("id") in known_ids:
                    raise RuntimeError("duplicate id")
                rows.append(copy.deepcopy(item))
                known_ids.add(item.get("id"))
            self.database.mutations.append(("insert", self.table, len(batch)))
            return _Result(copy.deepcopy(batch))
        matched = [row for row in rows if self._matches(row)]
        if self.operation == "delete":
            deleted_ids = {id(row) for row in matched}
            self.database.rows[self.table] = [row for row in rows if id(row) not in deleted_ids]
            self.database.mutations.append(("delete", self.table, len(matched)))
            return _Result(copy.deepcopy(matched))
        if self.start is not None:
            matched = matched[self.start : self.end + 1]
        if self.limit_count is not None:
            matched = matched[: self.limit_count]
        return _Result(copy.deepcopy(matched))


class _FakeSupabase:
    def __init__(self, rows):
        self.rows = copy.deepcopy(rows)
        for table in recovery.TABLES:
            self.rows.setdefault(table, [])
        self.mutations = []

    def table(self, name):
        assert name in recovery.TABLES, f"out-of-scope table used: {name}"
        return _Query(self, name)


def _user(uid, email):
    return {
        "id": uid,
        "email": email,
        "nickname": "Parent",
        "city": "Chicago",
        "parent_role": "mom",
        "top_concerns": [],
        "hashed_password": f"secret-{uid}",
        "created_at": "2026-01-01T00:00:00+00:00",
    }


def _child(cid, uid, nickname="米 米", birth="2024-06-01", **extra):
    return {
        "id": cid,
        "user_id": uid,
        "nickname": nickname,
        "birth_date": birth,
        "gender": extra.get("gender", "other"),
        "allergies": extra.get("allergies", []),
        "notes": extra.get("notes", ""),
        "created_at": extra.get("created_at", "2026-01-02T00:00:00+00:00"),
    }


def _session(sid, uid):
    return {
        "id": sid,
        "user_id": uid,
        "title": "和NURI聊天",
        "source_card_id": None,
        "script_key": "free",
        "step": 0,
        "created_at": "2026-01-03T00:00:00+00:00",
        "state_summary": None,
        "state_covered_tokens": 0,
        "state_updated_at": None,
    }


def _message(mid, sid, role, text, created_at):
    return {
        "id": mid,
        "session_id": sid,
        "role": role,
        "text": text,
        "image_base64": None,
        "quick_replies": [],
        "transition": None,
        "sources": [],
        "created_at": created_at,
    }


def _normalized(nid, uid, child_id, session_id, text="private input"):
    return {
        "id": nid,
        "user_id": uid,
        "child_id": child_id,
        "session_id": session_id,
        "source": "chat",
        "raw_text": text,
        "normalized_text": text,
        "normalization_version": "v1",
        "raw_image_base64": None,
        "raw_image_url": None,
        "raw_image_metadata": None,
        "card_ref": None,
        "context_hints": {},
        "created_at": "2026-01-04T00:00:00+00:00",
    }


def _memory(mid, uid, child_id, key="sleep_routine", value="source value", source_id="sm1"):
    return {
        "id": mid,
        "user_id": uid,
        "child_id": child_id,
        "category": "fact",
        "key": key,
        "value": value,
        "confidence": 0.8,
        "source_type": "chat",
        "source_id": source_id,
        "status": "active",
        "created_at": "2026-01-05T00:00:00+00:00",
        "updated_at": "2026-01-05T00:00:00+00:00",
        "last_confirmed_at": "2026-01-05T00:00:00+00:00",
    }


def _database(*, target_messages=None, duplicate_target_children=False):
    target_messages = target_messages or [
        _message("tgreeting", "ts", "ai", "hello", "2026-01-03T00:00:00+00:00")
    ]
    target_children = [_child("tc", "target", nickname="米米")]
    if duplicate_target_children:
        target_children.append(_child("tc2", "target", nickname=" 米 米 "))
    return _FakeSupabase(
        {
            "users": [
                _user("target", "target@example.com"),
                _user("source", "source@example.com"),
            ],
            "children": [*target_children, _child("sc", "source")],
            "chat_sessions": [
                _session("ts", "target"),
                _session("ss1", "source"),
                _session("ss2", "source"),
            ],
            "chat_messages": [
                *target_messages,
                _message("sm1", "ss1", "user", "first secret", "2026-01-04T00:00:00+00:00"),
                _message("sm2", "ss1", "ai", "first reply", "2026-01-04T00:01:00+00:00"),
                _message("sm3", "ss2", "user", "second secret", "2026-01-05T00:00:00+00:00"),
            ],
            "normalized_inputs": [
                _normalized("sn1", "source", "sc", "ss1"),
            ],
            "user_memories": [
                _memory("tm-conflict", "target", "tc", value="target wins"),
                _memory("sm-conflict", "source", "sc", value="source loses"),
                _memory("sm-new", "source", None, key="family_language", value="中文"),
            ],
        }
    )


def _case_canonical_email_and_child_identity_are_strict():
    assert recovery.canonical_email("parent@example.com") == "parent@example.com"
    with _raises(recovery.RecoveryError):
        recovery.canonical_email(" Parent@example.com ")
    with _raises(recovery.RecoveryError):
        recovery.canonical_email("Parent@example.com")
    assert recovery.child_identity(_child("a", "u", nickname=" 米\u3000米 ")) == (
        "米米",
        "2024-06-01",
    )


def _case_dry_run_writes_complete_hashed_backup_without_database_mutation(tmp_path):
    database = _database()
    before = copy.deepcopy(database.rows)

    result = recovery.recover_account_history(
        database,
        target_email="target@example.com",
        source_emails=["source@example.com"],
        backup_dir=tmp_path,
    )

    assert result.applied is False
    assert database.rows == before
    assert database.mutations == []
    backup_bytes = result.backup.backup_path.read_bytes()
    assert hashlib.sha256(backup_bytes).hexdigest() == result.backup.sha256
    manifest = json.loads(result.backup.manifest_path.read_text("utf-8"))
    assert manifest["sha256"] == result.backup.sha256
    assert manifest["target_email_masked"] == "t***@example.com"
    assert "target@example.com" not in result.backup.manifest_path.read_text("utf-8")
    document = json.loads(backup_bytes)
    assert document["tables"]["users"][0]["hashed_password"].startswith("secret-")
    assert {row["id"] for row in document["tables"]["chat_messages"]} == {
        "tgreeting", "sm1", "sm2", "sm3"
    }
    assert result.plan.session_map == {"ss1": "ts", "ss2": "ts"}
    assert result.plan.placeholder_greeting_id == "tgreeting"
    assert len(result.plan.preserved_memory_conflicts) == 1


def _case_apply_copies_verifies_then_removes_only_empty_target_greeting(tmp_path):
    database = _database()
    source_before = {
        table: copy.deepcopy(rows)
        for table, rows in database.rows.items()
    }

    result = recovery.recover_account_history(
        database,
        target_email="target@example.com",
        source_emails=["source@example.com"],
        backup_dir=tmp_path,
        apply=True,
    )

    assert result.applied
    target_messages = [row for row in database.rows["chat_messages"] if row["session_id"] == "ts"]
    assert "tgreeting" not in {row["id"] for row in target_messages}
    copied = {row["text"]: row for row in target_messages}
    assert set(copied) == {"first secret", "first reply", "second secret"}
    assert copied["first secret"]["created_at"] == "2026-01-04T00:00:00+00:00"
    assert all(row["session_id"] == "ts" for row in copied.values())
    copied_input = next(row for row in database.rows["normalized_inputs"] if row["user_id"] == "target")
    assert copied_input["session_id"] == "ts"
    assert copied_input["child_id"] == "tc"
    copied_memory = next(
        row for row in database.rows["user_memories"]
        if row["user_id"] == "target" and row["key"] == "family_language"
    )
    assert copied_memory["created_at"] == "2026-01-05T00:00:00+00:00"
    assert copied_memory["source_id"] == result.plan.message_map["sm1"]
    assert next(row for row in database.rows["user_memories"] if row["id"] == "tm-conflict")["value"] == "target wins"

    # No source row was changed or deleted.
    for table in recovery.TABLES:
        if table == "users":
            source_ids = {"source"}
        elif table in {"children", "chat_sessions", "normalized_inputs", "user_memories"}:
            source_ids = {row["id"] for row in source_before[table] if row.get("user_id") == "source"}
        else:
            source_session_ids = {"ss1", "ss2"}
            source_ids = {row["id"] for row in source_before[table] if row.get("session_id") in source_session_ids}
        current = {row["id"]: row for row in database.rows[table]}
        original = {row["id"]: row for row in source_before[table]}
        assert all(current[row_id] == original[row_id] for row_id in source_ids)


def _case_apply_is_idempotent_and_does_not_duplicate_copies(tmp_path):
    database = _database()
    first = recovery.recover_account_history(
        database,
        target_email="target@example.com",
        source_emails=["source@example.com"],
        backup_dir=tmp_path,
        apply=True,
    )
    counts = {table: len(database.rows[table]) for table in recovery.TABLES}

    second = recovery.recover_account_history(
        database,
        target_email="target@example.com",
        source_emails=["source@example.com"],
        backup_dir=tmp_path,
        apply=True,
    )

    assert first.plan.message_map == second.plan.message_map
    assert {table: len(database.rows[table]) for table in recovery.TABLES} == counts
    assert second.plan.placeholder_greeting_id is None


def _case_ambiguous_child_mapping_backs_up_then_blocks_apply(tmp_path):
    database = _database(duplicate_target_children=True)
    before = copy.deepcopy(database.rows)

    with _raises(recovery.RecoveryConflict, match="apply refused"):
        recovery.recover_account_history(
            database,
            target_email="target@example.com",
            source_emails=["source@example.com"],
            backup_dir=tmp_path,
            apply=True,
        )

    assert database.rows == before
    assert list(tmp_path.glob("*.json"))


def _case_unknown_missing_required_field_blocks_apply_without_mutation(tmp_path):
    database = _database()
    del next(row for row in database.rows["chat_messages"] if row["id"] == "sm1")["quick_replies"]
    before = copy.deepcopy(database.rows)

    with _raises(recovery.RecoveryConflict, match="apply refused"):
        recovery.recover_account_history(
            database,
            target_email="target@example.com",
            source_emails=["source@example.com"],
            backup_dir=tmp_path,
            apply=True,
        )

    assert database.rows == before


def _case_existing_target_user_message_prevents_placeholder_deletion(tmp_path):
    database = _database(
        target_messages=[
            _message("tgreeting", "ts", "ai", "hello", "2026-01-03T00:00:00+00:00"),
            _message("tuser", "ts", "user", "keep me", "2026-01-03T00:01:00+00:00"),
        ]
    )

    result = recovery.recover_account_history(
        database,
        target_email="target@example.com",
        source_emails=["source@example.com"],
        backup_dir=tmp_path,
        apply=True,
    )

    assert result.plan.placeholder_greeting_id is None
    assert {"tgreeting", "tuser"}.issubset(
        {row["id"] for row in database.rows["chat_messages"]}
    )


def _case_target_requires_exactly_one_session(tmp_path):
    database = _database()
    database.rows["chat_sessions"].append(_session("ts2", "target"))

    result = recovery.recover_account_history(
        database,
        target_email="target@example.com",
        source_emails=["source@example.com"],
        backup_dir=tmp_path,
    )

    assert not result.plan.safe_to_apply
    assert "at most one canonical session" in result.plan.conflicts[0]


def _case_zero_target_session_is_created_and_idempotent(tmp_path):
    database = _database()
    database.rows["chat_sessions"] = [
        row for row in database.rows["chat_sessions"] if row["user_id"] != "target"
    ]
    database.rows["chat_messages"] = [
        row for row in database.rows["chat_messages"] if row["session_id"] != "ts"
    ]
    earliest_source = next(
        row for row in database.rows["chat_sessions"] if row["id"] == "ss1"
    )
    earliest_source["child_id"] = "sc"
    earliest_source["state_summary"] = "source-only stale state"
    earliest_source["state_covered_tokens"] = 321
    earliest_source["state_updated_at"] = "2026-01-06T00:00:00+00:00"

    first = recovery.recover_account_history(
        database,
        target_email="target@example.com",
        source_emails=["source@example.com"],
        backup_dir=tmp_path,
        apply=True,
    )

    expected_session_id = recovery.deterministic_id("chat_session", "target", "ss1")
    assert first.plan.canonical_session_id == expected_session_id
    target_sessions = [
        row for row in database.rows["chat_sessions"] if row["user_id"] == "target"
    ]
    assert len(target_sessions) == 1
    canonical = target_sessions[0]
    assert canonical["id"] == expected_session_id
    assert canonical["title"] == "NURI"
    assert canonical["source_card_id"] is None
    assert canonical["child_id"] == "tc"
    assert canonical["state_summary"] is None
    assert canonical["state_covered_tokens"] == 0
    assert canonical["state_updated_at"] is None
    assert canonical["created_at"] == earliest_source["created_at"]
    assert {
        row["session_id"]
        for row in database.rows["chat_messages"]
        if row["id"] in first.plan.message_map.values()
    } == {expected_session_id}
    counts = {table: len(database.rows[table]) for table in recovery.TABLES}

    second = recovery.recover_account_history(
        database,
        target_email="target@example.com",
        source_emails=["source@example.com"],
        backup_dir=tmp_path,
        apply=True,
    )

    assert second.plan.canonical_session_id == expected_session_id
    assert second.plan.inserts["chat_sessions"] == []
    assert {table: len(database.rows[table]) for table in recovery.TABLES} == counts


class RecoverAccountHistoryTests(unittest.TestCase):
    def _with_temp_dir(self, function):
        with tempfile.TemporaryDirectory() as directory:
            function(Path(directory))

    def test_canonical_email_and_child_identity_are_strict(self):
        _case_canonical_email_and_child_identity_are_strict()

    def test_dry_run_writes_complete_hashed_backup_without_database_mutation(self):
        self._with_temp_dir(_case_dry_run_writes_complete_hashed_backup_without_database_mutation)

    def test_apply_copies_verifies_then_removes_only_empty_target_greeting(self):
        self._with_temp_dir(_case_apply_copies_verifies_then_removes_only_empty_target_greeting)

    def test_apply_is_idempotent_and_does_not_duplicate_copies(self):
        self._with_temp_dir(_case_apply_is_idempotent_and_does_not_duplicate_copies)

    def test_ambiguous_child_mapping_backs_up_then_blocks_apply(self):
        self._with_temp_dir(_case_ambiguous_child_mapping_backs_up_then_blocks_apply)

    def test_unknown_missing_required_field_blocks_apply_without_mutation(self):
        self._with_temp_dir(_case_unknown_missing_required_field_blocks_apply_without_mutation)

    def test_existing_target_user_message_prevents_placeholder_deletion(self):
        self._with_temp_dir(_case_existing_target_user_message_prevents_placeholder_deletion)

    def test_target_requires_exactly_one_session(self):
        self._with_temp_dir(_case_target_requires_exactly_one_session)

    def test_zero_target_session_is_created_and_idempotent(self):
        self._with_temp_dir(_case_zero_target_session_is_created_and_idempotent)


if __name__ == "__main__":
    unittest.main()
