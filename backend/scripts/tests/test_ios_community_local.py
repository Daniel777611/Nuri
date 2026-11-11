"""Isolated tests: run with --confcutdir=backend/scripts/tests.

Do not import backend/tests/conftest.py or the production backend application.
"""

import base64
import hashlib
from io import BytesIO
import importlib.util
from pathlib import Path
import subprocess
import sys

from fastapi.testclient import TestClient
from PIL import Image
import pytest


PATH = Path(__file__).resolve().parents[1] / "ios_community_local.py"
spec = importlib.util.spec_from_file_location("ios_community_local_fixture", PATH)
local = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = local
spec.loader.exec_module(local)
V1 = "/api/community/v1"


@pytest.fixture
def demo(monkeypatch):
    monkeypatch.setenv(local.ENABLE_ENV, "1")
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("VERCEL_ENV", raising=False)
    app = local.create_app(enabled=True)
    with TestClient(app) as client:
        yield app, client


def headers(who="ann"):
    return {"Authorization": "Bearer " + local.LOCAL_ACCOUNTS[f"{who}@community.local.invalid"][1]}


def image():
    output = BytesIO()
    Image.new("RGB", (4, 4), (170, 90, 160)).save(output, "PNG")
    return output.getvalue()


def test_factory_is_off_without_both_public_local_gates(monkeypatch):
    monkeypatch.delenv(local.ENABLE_ENV, raising=False)
    with pytest.raises(RuntimeError, match="OFF"):
        local.create_app(enabled=True)
    monkeypatch.setenv(local.ENABLE_ENV, "1")
    with pytest.raises(RuntimeError, match="OFF"):
        local.create_app()
    monkeypatch.setenv("VERCEL_ENV", "preview")
    with pytest.raises(RuntimeError, match="Vercel"):
        local.create_app(enabled=True)


def test_cli_requires_opt_in_before_binding_or_loading_production():
    env = {"PATH": str(Path(sys.executable).parent), "PYTHON_DOTENV_DISABLED": "1"}
    result = subprocess.run([sys.executable, str(PATH)], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode != 0 and "OFF" in result.stderr


def test_cli_binding_is_fixed_loopback_and_access_logs_are_disabled(monkeypatch):
    monkeypatch.setenv(local.ENABLE_ENV, "1")
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("VERCEL_ENV", raising=False)
    import uvicorn
    seen = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: seen.update(kwargs))
    local.main(["--enable-local-only"])
    assert seen["host"] == "127.0.0.1" and seen["port"] == 8765 and seen["access_log"] is False


def test_synthetic_login_me_children_and_real_seeded_contract(demo):
    app, client = demo
    health = client.get("/health").json()
    assert health == {"ok": True, "local_only": True, "synthetic": True, "production_connections": False}
    assert client.get(V1 + "/profiles/me").status_code == 401
    assert client.get(V1 + "/profiles/me", headers={"Authorization": "Bearer not-a-local-token"}).status_code == 401
    login = client.post("/api/auth/login", json={"email": "ann@community.local.invalid", "password": "local-only", "language": "en"}).json()
    assert login["user"]["id"] == "local_ann" and login["user"]["onboarding_completed"] is True
    assert client.get("/api/auth/me", headers=headers()).json()["nickname"] == "LOCAL DEMO Ann"
    assert len(client.get("/api/children", headers=headers()).json()) == 1
    assert len(client.get(V1 + "/me/contacts", headers=headers()).json()["items"]) == 1
    assert len(client.get(V1 + "/me/question-deliveries", headers=headers()).json()["items"]) == 1
    messages = client.get(V1 + f"/conversations/{app.state.fixture_ids['conversation_id']}/messages", headers=headers()).json()
    assert len(messages["items"]) == 1 and messages["items"][0]["text"].startswith("[LOCAL DEMO]")
    assert messages["conversation"]["ai"]["effective"] is False


def test_real_route_validation_idempotency_and_no_fake_success(demo):
    _app, client = demo
    body = {"body": "[LOCAL DEMO] Another synthetic question", "client_request_id": "test-question-once"}
    first = client.post(V1 + "/questions", json=body, headers=headers())
    second = client.post(V1 + "/questions", json=body, headers=headers())
    conflict = client.post(V1 + "/questions", json={**body, "body": "different"}, headers=headers())
    assert first.status_code == 201 and second.status_code == 200
    assert first.json()["question"]["question_id"] == second.json()["question"]["question_id"]
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    bad = client.patch(V1 + "/profiles/me", json={"owner_id": "another"}, headers=headers())
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "VALIDATION_FAILED"


def test_synthetic_ai_is_labelled_and_still_requires_real_consent_contract(demo):
    app, client = demo
    cid = app.state.fixture_ids["conversation_id"]
    body = {"text": "A synthetic question", "language": "en", "ai_consent_version": app.state.community.NURI_AI_CONSENT_VERSION, "client_request_id": "test-polish-once"}
    denied = client.post(V1 + "/question-polishes", json={**body, "ai_consent_version": "old"}, headers=headers())
    assert denied.status_code == 403
    polish = client.post(V1 + "/question-polishes", json=body, headers=headers()).json()
    assert "LOCAL SYNTHETIC POLISH" in polish["polish"]["text"]
    mid = app.state.fixture_ids["message_id"]
    translation = {"target_language": "en", "ai_consent_version": body["ai_consent_version"], "client_request_id": "test-translation"}
    assert client.post(V1 + f"/messages/{mid}/translations", json=translation, headers=headers()).status_code == 403
    notice = app.state.community.AI_NOTICE_VERSION
    request = client.post(V1 + f"/conversations/{cid}/ai-consent-requests", json={"purpose": "translation", "notice_version": notice, "client_request_id": "test-consent-request"}, headers=headers()).json()["request"]
    assert request["effective"] is False
    client.put(V1 + f"/ai-consent-requests/{request['request_id']}/my-decision", json={"decision": "allow", "notice_version": notice, "client_request_id": "test-consent-decide"}, headers=headers("ben"))
    result = client.post(V1 + f"/messages/{mid}/translations", json=translation, headers=headers())
    assert result.status_code == 200 and "LOCAL SYNTHETIC TRANSLATION" in result.json()["translation"]["text"]
    assert app.state.runtime.aoai is None


def test_transcription_is_only_a_labelled_idempotent_draft_and_never_sends(demo):
    app, client = demo
    count = len(app.state.db.rows("community_messages"))
    body = {"audio_base64": "synthetic-not-real-audio", "locale": "en", "ai_consent_version": app.state.community.NURI_AI_CONSENT_VERSION, "client_request_id": "test-transcription-once"}
    first = client.post(V1 + "/transcriptions", json=body, headers=headers())
    second = client.post(V1 + "/transcriptions", json=body, headers=headers())
    assert first.status_code == 200 and first.json()["draft_text"] == local.SYNTHETIC_TRANSCRIPT
    assert second.json()["draft_text"] == first.json()["draft_text"]
    assert app.state.aggregate["synthetic_transcriptions"] == 1
    assert len(app.state.db.rows("community_messages")) == count


def test_direct_images_stay_in_memory_use_only_local_signed_urls_and_enforce_ownership(demo):
    app, client = demo
    raw = image()
    body = {"purpose": "message", "data_uri": "data:image/png;base64," + base64.b64encode(raw).decode(), "client_request_id": "test-local-image"}
    uploaded = client.post(V1 + "/media", json=body, headers=headers())
    assert uploaded.status_code == 201 and uploaded.json()["media"]["state"] == "ready"
    media = uploaded.json()["media"]["media_id"]
    assert client.get(V1 + f"/media/{media}/access", headers=headers("ben")).status_code == 404
    cid = app.state.fixture_ids["conversation_id"]
    assert client.post(V1 + f"/conversations/{cid}/messages", json={"media_ids": [media], "client_message_id": "test-image-message"}, headers=headers()).status_code == 201
    access = client.get(V1 + f"/media/{media}/access", headers=headers("ben")).json()["access"]["url"]
    assert access.startswith("http://127.0.0.1:8765/__local__/media/")
    read = client.get(access.removeprefix(local.ORIGIN))
    assert read.content == raw and read.headers["content-type"] == "image/png"
    assert client.get("/__local__/media/unknown").status_code == 404
    assert app.state.db.storage.objects


def test_signed_upload_validation_and_expiring_read_capabilities_are_local_only(demo):
    app, client = demo
    raw = image()
    uploaded = client.post(V1 + "/media/uploads", json={"purpose": "message", "mime_type": "image/png", "byte_size": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(), "client_request_id": "test-signed-upload"}, headers=headers()).json()
    url = uploaded["upload"]["url"]
    assert url.startswith(local.ORIGIN + "/__local__/media/")
    assert client.put(url.removeprefix(local.ORIGIN), content=raw).status_code == 200
    media = uploaded["media"]["media_id"]
    ready = client.post(V1 + f"/media/uploads/{media}/complete", json={}, headers=headers())
    assert ready.status_code == 200 and ready.json()["media"]["state"] == "ready"
    access = client.get(V1 + f"/media/{media}/access", headers=headers()).json()["access"]["url"]
    assert client.get(access.removeprefix(local.ORIGIN)).content == raw
    key = access.rsplit("/", 1)[-1]
    app.state.media_capabilities[key]["until"] = 0
    assert client.get(access.removeprefix(local.ORIGIN)).status_code == 404
    assert client.delete(V1 + f"/media/{media}", headers=headers()).status_code == 200
    assert not app.state.db.storage.objects


def test_notifications_use_real_ownership_target_recheck_and_local_queue_only(demo):
    app, client = demo
    notifications = client.get(V1 + "/me/notifications", headers=headers()).json()["items"]
    event = next(row for row in notifications if row["kind"] == "community_conversation")
    nid = event["notification_id"]
    assert client.get(V1 + f"/me/notifications/{nid}/target", headers=headers("ben")).status_code == 404
    assert client.get(V1 + f"/me/notifications/{nid}/target", headers=headers()).json()["accessible"] is True
    assert client.post("/api/notifications/" + nid + "/open", headers=headers()).status_code == 403
    assert not app.state.db.rows("chat_messages")
    client.put(V1 + "/me/blocks/" + app.state.fixture_ids["ben_parent_id"], json={"confirmed": True}, headers=headers())
    assert client.get(V1 + f"/me/notifications/{nid}/target", headers=headers()).json()["accessible"] is False
    assert app.state.aggregate["local_notifications_queued"] > 0


def test_no_production_modules_or_dotenv_loaded_and_aggregate_summary_contains_no_content(demo):
    app, client = demo
    assert app.state.runtime.aoai is None
    assert app.state.community.runtime.get_supabase() is app.state.db
    assert "backend.main" not in sys.modules and "backend.runtime" not in sys.modules
    assert "openai" not in sys.modules and "supabase" not in sys.modules and "dotenv" not in sys.modules
    summary = client.get("/__local__/summary").text
    for forbidden in ["Bearer", "local-only", "LOCAL DEMO Ann", "What makes a calm bedtime", *[token for _uid, token in local.LOCAL_ACCOUNTS.values()]]:
        assert forbidden not in summary
    assert client.get("/health").headers["X-Nuri-Local-Only"] == "synthetic-fixture"


def test_fresh_process_blocks_production_imports_env_reads_and_network_connections():
    program = '''
import importlib.abc, importlib.util, os, socket, sys
class RejectProduction(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in {"backend.main", "backend.runtime", "dotenv", "openai", "supabase"}:
            raise AssertionError("production infrastructure import attempted")
sys.meta_path.insert(0, RejectProduction())
def no_network(*args, **kwargs):
    raise AssertionError("network connection attempted")
socket.create_connection = no_network
socket.socket.connect = no_network
spec = importlib.util.spec_from_file_location("local_guarded_fixture", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from fastapi.testclient import TestClient
app = module.create_app(enabled=True)
with TestClient(app) as client:
    assert client.get("/health").json()["local_only"] is True
    token = next(iter(module.LOCAL_ACCOUNTS.values()))[1]
    response = client.get("/api/community/v1/profiles/me", headers={"Authorization": "Bearer " + token})
    assert response.status_code == 200
assert app.state.runtime.aoai is None
assert os.environ["PYTHON_DOTENV_DISABLED"] == "1"
'''
    env = {"PATH": str(Path(sys.executable).parent), "PYTHON_DOTENV_DISABLED": "1", local.ENABLE_ENV: "1",
           "OPENAI_API_KEY": "public-synthetic-unusable", "SUPABASE_URL": "https://blocked.invalid", "SUPABASE_SERVICE_ROLE_KEY": "public-synthetic-unusable"}
    result = subprocess.run([sys.executable, "-c", program, str(PATH)], env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert result.stdout == ""


def test_storage_failure_is_honest_and_contract_diagnostics_are_aggregate_only(demo, capsys):
    app, client = demo
    app.state.db.fail_tables.add("community_profiles")
    response = client.get(V1 + "/profiles/me", headers=headers())
    assert response.status_code == 503 and response.json()["error"]["code"] == "STORAGE_OR_SERVICE_UNAVAILABLE"
    assert app.state.aggregate["local_contract_diagnostics"] == 1
    assert capsys.readouterr().out == ""


def test_lifespan_exit_erases_all_in_memory_rows_and_objects(monkeypatch):
    monkeypatch.setenv(local.ENABLE_ENV, "1")
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("VERCEL_ENV", raising=False)
    app = local.create_app(enabled=True)
    with TestClient(app):
        assert len(app.state.db.rows("users")) == 2
    assert app.state.db.tables == {} and app.state.db.storage.objects == {}
