"""Process-wide infrastructure: configuration, clients, and the clock.

Everything in here was previously the first three hundred lines of main.py,
which meant that any module wanting a Supabase handle had to import a 10,000
line file with a FastAPI app at module scope. That is the single reason the
four subsystems in `nuri_core` had to receive their data through injected
callables instead of just reading it.

This module imports nothing from the rest of the backend, so anything may
import it. Keep it that way: a dependency pointing back out of here is how the
import cycle comes back.

main.py re-exports every name below, so existing `from backend.main import
OPENAI_TIMEOUT_S` style imports and the tests that monkeypatch them keep
working unchanged.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import anyio
from dotenv import load_dotenv
from openai import AsyncOpenAI, OpenAI

load_dotenv()

# ── Optional dependencies ────────────────────────────────────────────────────
# Both are absent in some deployment targets and in most test runs. Failing to
# import must degrade a feature, never the process.
try:
    from supabase import Client, create_client
    _SUPABASE_OK = True
except ImportError:  # pragma: no cover - exercised by deployment, not tests
    Client = None
    create_client = None
    _SUPABASE_OK = False

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover
    PdfReader = None


# ── Env ──────────────────────────────────────────────────────────────────────
OPENAI_API_KEY   = os.getenv("OPENAI_API_KEY")
SUPABASE_URL     = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
SUPABASE_KEY     = SUPABASE_SERVICE_ROLE_KEY or os.getenv("SUPABASE_ANON_KEY")
VECTOR_NAMESPACE = os.getenv("VECTOR_NAMESPACE", "pdf")
FRONTEND_DIST    = Path(__file__).resolve().parents[1] / "frontend" / "dist"
VECTOR_TABLE     = os.getenv("SUPABASE_VECTOR_TABLE", "rag_chunks")
# Internal knowledge base: NURI-authored guidance treated as mandatory rules,
# distinct from VECTOR_NAMESPACE (external reference books). Ingested via
# backend/scripts/ingest_internal_docs.py, not the /admin/books flow.
INTERNAL_NAMESPACE      = os.getenv("INTERNAL_VECTOR_NAMESPACE", "internal")
INTERNAL_TOP_K          = int(os.getenv("INTERNAL_TOP_K", "3"))
INTERNAL_MIN_SIMILARITY = float(os.getenv("INTERNAL_MIN_SIMILARITY", "0.5"))

_LOCAL_ONLY_JWT_SECRET = "dev-secret-change-in-prod"


def _load_jwt_secret() -> str:
    """Refuse to boot a deployed app with a guessable signing key.

    Local development keeps the historical fallback so a fresh clone remains
    runnable.  Vercel Preview and Production must receive a high-entropy secret
    through environment configuration; silently accepting the public fallback
    would let anybody mint an authenticated token for an arbitrary user id.
    """

    value = (os.getenv("JWT_SECRET") or "").strip()
    deployment_env = (os.getenv("VERCEL_ENV") or "").strip().lower()
    if deployment_env in {"preview", "production"}:
        if value == _LOCAL_ONLY_JWT_SECRET or len(value) < 32:
            raise RuntimeError(
                "JWT_SECRET must be configured with at least 32 random "
                f"characters in Vercel {deployment_env}"
            )
    return value or _LOCAL_ONLY_JWT_SECRET


JWT_SECRET       = _load_jwt_secret()
RECOMMENDATION_SNAPSHOT_SECRET = (
    os.getenv("RECOMMENDATION_SNAPSHOT_SECRET") or SUPABASE_SERVICE_ROLE_KEY
)
ADMIN_KEY        = os.getenv("ADMIN_KEY", "")
JWT_ALG          = "HS256"
JWT_EXP_MIN      = int(os.getenv("JWT_EXPIRES_MINUTES", "10080"))  # 7 days
EMBED_DIM        = 1024
APP_URL          = os.getenv("APP_URL", "https://family-growth-ktm1oyan2-ordashlabs.vercel.app")
SMTP_HOST        = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT        = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER        = os.getenv("SMTP_USER", "")
SMTP_PASSWORD    = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM        = os.getenv("SMTP_FROM", "")

# The SDK defaults (timeout=600s, max_retries=2) let a single stalled call hold
# a worker thread for ~30 minutes, which starves the shared thread pool and
# freezes the whole app.
#
# These ceilings are sized against the Vercel function's maxDuration (see
# vercel.json) so a pathological turn is cut short by us, with a usable error,
# rather than by the platform mid-response. They are ceilings for stalls, not
# expected timings — a normal turn returns in a few seconds.
OPENAI_TIMEOUT_S       = float(os.getenv("OPENAI_TIMEOUT_S", "45"))   # main chat reply
OPENAI_FAST_TIMEOUT_S  = float(os.getenv("OPENAI_FAST_TIMEOUT_S", "15"))  # titles, embeddings, #fix
OPENAI_TASKS_TIMEOUT_S = float(os.getenv("OPENAI_TASKS_TIMEOUT_S", "25"))  # task suggestions
# One preparation request performs at most three sequential Responses calls
# (the initial bundle plus two bounded repair passes).  The browser waits 110s
# for the whole request, so an individual 100s SDK timeout could leave the UI
# waiting on work that may legally run for almost five minutes.  Keep the
# provider-call ceiling at 30s even when an older Vercel environment still has
# the former 100s value; three calls plus persistence remain inside the client
# budget and well below the function maxDuration.
OPENAI_CONTENT_RESEARCH_TIMEOUT_S = max(
    5.0,
    min(float(os.getenv("OPENAI_CONTENT_RESEARCH_TIMEOUT_S", "30")), 30.0),
)
OPENAI_CONTENT_RESEARCH_MODEL = os.getenv(
    "OPENAI_CONTENT_RESEARCH_MODEL", "gpt-5.4-mini"
)
OPENAI_CONTENT_RESEARCH_CONCURRENCY = int(
    os.getenv("OPENAI_CONTENT_RESEARCH_CONCURRENCY", "2")
)
OPENAI_MAX_RETRIES     = int(os.getenv("OPENAI_MAX_RETRIES", "1"))


# ── Paused subsystems ────────────────────────────────────────────────────────
# Card research and the daily push are the two largest LLM line items outside
# the chat turn, and neither is on the critical path. Both are paused by
# default so a deploy is enough to stop the spend; set the variable to 1 in the
# environment to bring either back without a code change.
#
# Paused card research is not a broken feed: `content_research_oai is None` is
# a branch the delivery layer already takes, and it serves the reviewed
# library instead of live web research.
def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


KNOWLEDGE_CARDS_ENABLED = _env_flag("KNOWLEDGE_CARDS_ENABLED", False)
DAILY_PUSH_ENABLED = _env_flag("DAILY_PUSH_ENABLED", False)

# Every blocking call (Supabase queries and OpenAI alike) shares anyio's
# process-wide thread limiter, which defaults to 40. A handful of in-flight LLM
# calls would otherwise hold every token and stall unrelated DB queries, so a
# slow model turn reads as a total app freeze.
THREAD_LIMIT = int(os.getenv("ANYIO_THREAD_LIMIT", "120"))


# ── Clients ──────────────────────────────────────────────────────────────────
oai = (
    OpenAI(api_key=OPENAI_API_KEY, timeout=OPENAI_TIMEOUT_S, max_retries=OPENAI_MAX_RETRIES)
    if OPENAI_API_KEY else None
)
# Used by the streaming chat path. Being natively async, it holds no worker
# thread for the length of the call, unlike the blocking client above.
aoai = (
    AsyncOpenAI(api_key=OPENAI_API_KEY, timeout=OPENAI_TIMEOUT_S, max_retries=OPENAI_MAX_RETRIES)
    if OPENAI_API_KEY else None
)
content_research_oai = (
    OpenAI(
        api_key=OPENAI_API_KEY,
        timeout=OPENAI_CONTENT_RESEARCH_TIMEOUT_S,
        max_retries=0,
    )
    if OPENAI_API_KEY and KNOWLEDGE_CARDS_ENABLED
    else None
)
content_research_limiter = anyio.CapacityLimiter(
    max(1, OPENAI_CONTENT_RESEARCH_CONCURRENCY)
)

supabase_client = None


def get_supabase() -> Optional["Client"]:
    """The shared Supabase handle, or None when unconfigured.

    A getter rather than a module constant because the client is created on
    first use: import time is the worst moment to make a network-capable
    object, and half the test suite runs with no credentials at all.
    """
    global supabase_client
    if supabase_client is not None:
        return supabase_client
    if not (_SUPABASE_OK and SUPABASE_URL and SUPABASE_KEY and create_client):
        return None
    try:
        supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        return supabase_client
    except Exception as e:
        print(f"[warn] Supabase init skipped: {e}")
    return None


# ── Clock ────────────────────────────────────────────────────────────────────

def now() -> str:
    """UTC, ISO 8601. Every timestamp written to the database goes through
    here so a row's age never depends on which machine wrote it."""
    return datetime.now(timezone.utc).isoformat()


def elapsed_ms(start: float) -> int:
    """Elapsed milliseconds since a perf_counter() reading."""
    return int((time.perf_counter() - start) * 1000)
