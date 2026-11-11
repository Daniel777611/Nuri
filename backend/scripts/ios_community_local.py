"""Opt-in, loopback-only Community simulator fixture. NEVER a production app.

Launch from the repository root with the public, local-only gate:

    PYTHON_DOTENV_DISABLED=1 NURI_IOS_COMMUNITY_LOCAL=1 \
      python backend/scripts/ios_community_local.py --enable-local-only

The two fictional email accounts below use password ``local-only``. Their
tokens are public test constants, NOT credentials for any deployed service.
The real Community module is loaded in a private namespace with in-memory
ports. Production runtime/main, dotenv, Supabase, OpenAI, APNs and FCM clients
are never imported. All state is discarded when this process exits.
"""

from __future__ import annotations

import argparse
import builtins
from collections import Counter
from contextlib import asynccontextmanager
import importlib.util
import os
from pathlib import Path
import sys
import time
from types import ModuleType, SimpleNamespace
from typing import Optional
import uuid

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field


HOST = "127.0.0.1"
PORT = 8765
ORIGIN = f"http://{HOST}:{PORT}"
ENABLE_ENV = "NURI_IOS_COMMUNITY_LOCAL"
LOCAL_PASSWORD = "local-only"
LOCAL_ACCOUNTS = {
    "ann@community.local.invalid": ("local_ann", "nuri-local-ann-only"),
    "ben@community.local.invalid": ("local_ben", "nuri-local-ben-only"),
}
SYNTHETIC_TRANSCRIPT = "[LOCAL SYNTHETIC TRANSCRIPTION — NOT REAL AI] A local demo voice draft."
_BACKEND = Path(__file__).resolve().parents[1]


def _require_enabled(enabled: bool) -> None:
    if not enabled or os.environ.get(ENABLE_ENV) != "1":
        raise RuntimeError("Local fixture is OFF. Both the explicit flag and local-only environment gate are required.")
    if os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"):
        raise RuntimeError("Local fixture must not run in a Vercel deployment.")
    # Defense in depth. No dotenv/runtime module is imported by this fixture.
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"


def _private_module(path: Path, label: str, importer=None, printer=None) -> ModuleType:
    name = f"_nuri_ios_local_{label}_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Local fixture source is unavailable")
    module = importlib.util.module_from_spec(spec)
    if importer or printer:
        module.__dict__["__builtins__"] = {**vars(builtins), "__import__": importer or builtins.__import__, "print": printer or print}
    # Pydantic resolves postponed annotations through the defining module.
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


class _Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(max_length=100)
    password: str = Field(max_length=100)
    language: Optional[str] = Field(None, max_length=16)


def create_app(*, enabled: bool = False) -> FastAPI:
    """Explicit test factory; importing this file never creates/starts an app."""
    _require_enabled(enabled)
    fake = _private_module(_BACKEND / "tests" / "community_fakes.py", "db")
    image_input = _private_module(_BACKEND / "nuri_core" / "image_input.py", "image")
    db = fake.FakeDB()
    aggregate = Counter()
    capabilities: dict[str, dict] = {}

    def capability(path: str, operation: str, ttl: int) -> str:
        key = uuid.uuid4().hex
        capabilities[key] = {"path": path, "operation": operation, "until": time.monotonic() + ttl}
        return f"{ORIGIN}/__local__/media/{key}"

    class LocalBucket(fake.Bucket):
        def create_signed_url(self, path, expires_in):
            return {"signedURL": capability(path, "read", expires_in)}

        def create_signed_upload_url(self, path):
            return {"signed_url": capability(path, "write", 1800), "token": "public-local-upload-only", "path": path}

    db.storage.from_ = lambda _bucket: LocalBucket(db.storage)

    async def queue(_db, row):
        existing = next((item for item in db.rows("notification_events") if item.get("dedupe_key") == row.get("dedupe_key")), None)
        if existing:
            return dict(existing)
        event_id = str(uuid.uuid4())
        result = db.table("notification_events").insert({**row, "id": event_id, "route": f"/notifications/{event_id}"}).execute().data[0]
        aggregate["local_notifications_queued"] += 1
        return result

    class TranscribeIn(BaseModel):
        audio_base64: str = Field(max_length=20_000_000)
        locale: Optional[str] = None

    async def synthetic_audio(_body, _uid):
        aggregate["synthetic_transcriptions"] += 1
        return {"text": SYNTHETIC_TRANSCRIPT}

    runtime = SimpleNamespace(get_supabase=lambda: db, aoai=None, elapsed_ms=lambda started: (time.perf_counter() - started) * 1000)
    ports = SimpleNamespace(
        runtime=runtime, llm_usage=SimpleNamespace(record=lambda *_args, **_kwargs: None),
        push_service=SimpleNamespace(_queue=queue),
        main=SimpleNamespace(TranscribeIn=TranscribeIn, transcribe_audio=synthetic_audio),
    )
    import_module = builtins.__import__

    def isolated_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "backend":
            if any(not hasattr(ports, item) for item in fromlist):
                raise ImportError("Local fixture refuses an unconfigured production backend dependency")
            return ports
        if name == "backend.nuri_core" and tuple(fromlist) == ("image_input",):
            return SimpleNamespace(image_input=image_input)
        if name.startswith("backend.") or name.split(".", 1)[0] in {"openai", "supabase", "dotenv"}:
            raise ImportError("Production infrastructure is not available in the local fixture")
        return import_module(name, globals, locals, fromlist, level)

    def count_diagnostic(*_args, **_kwargs):
        # Production helpers may print exceptions. Retain only an aggregate,
        # never their arguments, request text, ids, tokens or image/audio data.
        aggregate["local_contract_diagnostics"] += 1

    community = _private_module(_BACKEND / "community.py", "community", isolated_import, count_diagnostic)
    # A real network client is never present, including recipient ranking.
    community.AI_MATCHING = False

    async def synthetic_complete(site, _uid, _system, _text):
        aggregate["synthetic_completions"] += 1
        kind = "TRANSLATION" if site == "community.translate" else "POLISH"
        return f"[LOCAL SYNTHETIC {kind} — NOT REAL AI] A clearly labelled local demo draft."

    community._complete = synthetic_complete
    fixture_ids = {}

    async def seed():
        for index, (email, (uid, _token)) in enumerate(LOCAL_ACCOUNTS.items()):
            db.rows("users").append({"id": uid, "email": email, "nickname": f"LOCAL DEMO {'Ann' if index == 0 else 'Ben'}",
                                     "city": "Synthetic demo city", "parent_role": "mom" if index == 0 else "dad", "top_concerns": ["sleep"],
                                     "onboarding_completed": True, "email_verified": True})
            db.rows("children").append({"id": str(uuid.uuid4()), "user_id": uid, "nickname": "LOCAL DEMO child",
                                        "birth_date": "2024-05-01", "gender": "other", "allergies": [], "notes": "Synthetic fixture only"})
            await community.patch_my_profile(uid, community.ProfilePatch(display_name=f"LOCAL DEMO {'Ann' if index == 0 else 'Ben'}",
                about="Synthetic local simulator fixture — not a real parent", city="Synthetic demo city", intents=["casual_chat"], gender_tag="mom" if index == 0 else "dad"))
        ann = (await community.get_my_profile("local_ann"))["profile"]["parent_id"]
        ben = (await community.get_my_profile("local_ben"))["profile"]["parent_id"]
        invitation = await community.send_invitation("local_ben", community.InvitationIn(target_parent_id=ann, client_request_id="local-seed-invitation"))
        await community.decide_invitation("local_ann", invitation["invitation"]["invitation_id"], community.InvitationDecisionIn(decision="accept", client_request_id="local-seed-accept"))
        conversation = (await community.start_conversation("local_ann", community.ConversationIn(target_parent_id=ben, client_request_id="local-seed-conversation")))["conversation"]
        message = await community.send_message("local_ben", conversation["conversation_id"], community.MessageIn(text="[LOCAL DEMO] Hello from the synthetic second parent.", client_message_id="local-seed-message"))
        question = await community.create_question("local_ben", community.QuestionIn(body="[LOCAL DEMO] What makes a calm bedtime routine?", client_request_id="local-seed-question"))
        fixture_ids.update(ann_parent_id=ann, ben_parent_id=ben, conversation_id=conversation["conversation_id"],
                           message_id=message["message"]["message_id"], question_id=question["question"]["question_id"])

    @asynccontextmanager
    async def lifespan(_app):
        await seed()
        yield
        db.tables.clear()
        db.storage.objects.clear()
        capabilities.clear()

    app = FastAPI(title="LOCAL ONLY — Synthetic Nuri Community", lifespan=lifespan)
    app.state.local_only = True
    app.state.db, app.state.community, app.state.runtime = db, community, runtime
    app.state.fixture_ids, app.state.aggregate = fixture_ids, aggregate
    app.state.media_capabilities = capabilities

    async def uid(authorization: Optional[str] = Header(None)):
        token = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
        actor = next((actor for actor, value in LOCAL_ACCOUNTS.values() if value == token), None)
        if not actor or not any(row["id"] == actor for row in db.rows("users")):
            raise HTTPException(401, "A public local fixture token is required")
        return actor

    @app.exception_handler(HTTPException)
    async def error(_request, exc):
        code = getattr(exc, "error_code", "UNAUTHORIZED" if exc.status_code == 401 else "NOT_FOUND_OR_NOT_ACCESSIBLE" if exc.status_code == 404 else "LOCAL_FIXTURE_ERROR")
        return JSONResponse(status_code=exc.status_code, headers=exc.headers, content={"detail": exc.detail,
            "error": {"code": code, "message": str(exc.detail), "retryable": getattr(exc, "retryable", False), "retry_after_ms": None},
            "context": getattr(exc, "extra", {}), "request_id": "synthetic-local"})

    @app.exception_handler(RequestValidationError)
    async def invalid(_request, exc):
        # Never echo a password, audio clip or private message in error input.
        fields = [{key: value for key, value in item.items() if key not in {"input", "ctx"}} for item in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": fields, "error": {"code": "VALIDATION_FAILED", "message": "Invalid local fixture request", "retryable": False}, "request_id": "synthetic-local"})

    @app.middleware("http")
    async def count_requests(request: Request, call_next):
        response = await call_next(request)
        route = getattr(request.scope.get("route"), "path", "unmatched")
        aggregate[f"http:{request.method}:{route}:{response.status_code}"] += 1
        response.headers["X-Nuri-Local-Only"] = "synthetic-fixture"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    async def health():
        return {"ok": True, "local_only": True, "synthetic": True, "production_connections": False}

    @app.get("/__local__/summary")
    async def summary():
        return {"local_only": True, "synthetic": True, "users": len(db.rows("users")), "counts": dict(aggregate)}

    @app.post("/api/auth/login")
    async def login(body: _Login):
        account = LOCAL_ACCOUNTS.get(body.email.strip().lower())
        if not account or body.password != LOCAL_PASSWORD:
            raise HTTPException(401, "Use a fictional local fixture account")
        actor, token = account
        user = next(row for row in db.rows("users") if row["id"] == actor)
        return {"access_token": token, "token_type": "bearer", "user": dict(user)}

    @app.get("/api/auth/me")
    async def me(actor: str = Depends(uid)):
        return dict(next(row for row in db.rows("users") if row["id"] == actor))

    @app.get("/api/children")
    async def children(actor: str = Depends(uid)):
        return [dict(row) for row in db.rows("children") if row["user_id"] == actor]

    @app.get("/api/notifications")
    async def notifications(actor: str = Depends(uid)):
        return {"items": [{"id": row["id"], "type": row["type"], "title": row["title"], "body": row["body"], "sent_at": row["created_at"]}
                          for row in reversed(db.rows("notification_events")) if row["user_id"] == actor]}

    @app.get("/api/notifications/{notification_id}")
    async def notification(notification_id: str, actor: str = Depends(uid)):
        row = await community._own_community_event(actor, notification_id)
        return {"id": row["id"], "type": row["type"], "title": row["title"], "content": row["body"],
                "target": row["data"]["target"], "created_at": row["created_at"]}

    @app.post("/api/notifications/{notification_id}/open")
    async def old_notification_open(notification_id: str, actor: str = Depends(uid)):
        await community._own_community_event(actor, notification_id)
        raise community.CommunityError("RELATIONSHIP_NOT_ALLOWED", "Local community events never open a Nuri AI chat")

    def media_capability(key: str, operation: str):
        item = capabilities.get(key)
        if not item or item["operation"] != operation or item["until"] <= time.monotonic():
            raise HTTPException(404, "Local image capability not found or expired")
        return item["path"]

    @app.get("/__local__/media/{key}")
    async def read_media(key: str):
        path = media_capability(key, "read")
        raw = db.storage.objects.get(path)
        if raw is None:
            raise HTTPException(404, "Local image is unavailable")
        suffix = path.rsplit(".", 1)[-1]
        return Response(raw, media_type="image/" + ("jpeg" if suffix in {"jpg", "jpeg"} else suffix))

    @app.put("/__local__/media/{key}")
    async def put_media(key: str, request: Request):
        path = media_capability(key, "write")
        raw = await request.body()
        if not raw or len(raw) > community.MEDIA_MAX_BYTES:
            raise HTTPException(422, "Local image exceeds the image limit")
        db.storage.objects[path] = raw
        return {"local_only": True, "stored": True}

    app.include_router(community.build_router(uid))
    return app


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="OFF by default. Loopback-only synthetic Community; never production.")
    parser.add_argument("--enable-local-only", action="store_true", help="Required together with NURI_IOS_COMMUNITY_LOCAL=1")
    args = parser.parse_args(argv)
    try:
        app = create_app(enabled=args.enable_local_only)
    except RuntimeError as exc:
        parser.error(str(exc))
    import uvicorn

    print("LOCAL ONLY: 2 fictional accounts; in-memory DB/images/notifications; synthetic AI; zero production connections.")
    uvicorn.run(app, host=HOST, port=PORT, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
