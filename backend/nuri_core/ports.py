"""What the four subsystems need from the application, as injected callables.

`nuri_core` must not import main.py. main.py is 9,800 lines with a FastAPI app
and two OpenAI clients at module scope; importing it from a subsystem would
make every one of these modules untestable and would create the import cycle
the partition exists to avoid.

So main.py builds one `CorePorts` at startup and passes it down. Everything is
optional and defaults to a no-op returning empty, which means a test can supply
only the two or three ports the subsystem under test actually calls, and a
half-configured deployment degrades one block at a time instead of failing the
turn.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Sequence


async def _none_async(*_args, **_kwargs):
    return None


async def _empty_str_async(*_args, **_kwargs) -> str:
    return ""


async def _empty_list_async(*_args, **_kwargs) -> list:
    return []


async def _empty_profile_async(*_args, **_kwargs) -> tuple[dict, list]:
    return {}, []


def _empty_str(*_args, **_kwargs) -> str:
    return ""


def _false(*_args, **_kwargs) -> bool:
    return False


@dataclass
class CorePorts:
    """The application surface the subsystems are allowed to touch."""

    # ── infrastructure ────────────────────────────────────────────────────
    #: Returns the Supabase client, or None when unconfigured. A getter rather
    #: than the client itself because main.py creates it lazily.
    supabase: Callable[[], Any] = lambda: None
    #: Async OpenAI client, used by the knowledge model's router call.
    aoai: Any = None
    #: Runs a blocking callable off the event loop. anyio.to_thread.run_sync in
    #: production; a direct call in tests.
    to_thread: Callable[..., Awaitable[Any]] = _none_async

    # ── 1 家庭模型 ────────────────────────────────────────────────────────
    load_profile: Callable[[Optional[str]], Awaitable[tuple[dict, list]]] = _empty_profile_async
    profile_ctx: Callable[..., str] = _empty_str
    age_label: Callable[[str], str] = _empty_str
    #: Completed months since a birth date, or None. Directive conditions need
    #: the number; the label is only for the prompt.
    age_months: Callable[[str], Optional[int]] = lambda _birth_date: None
    memory_context: Callable[[Optional[str]], Awaitable[str]] = _empty_str_async
    follow_up_context: Callable[[Optional[str]], Awaitable[str]] = _empty_str_async

    # ── 2 知识与决策模型 ──────────────────────────────────────────────────
    #: Synchronous internal-namespace RAG lookup. Called off-thread.
    internal_rules: Callable[[str], str] = _empty_str
    #: async (query, zh_query, scope, is_medical) -> list[SearchResult]
    search_sources: Optional[Callable[..., Awaitable[Sequence[Any]]]] = None
    sources_prompt_block: Callable[[Sequence[Any]], str] = _empty_str
    search_provider_name: Callable[[], str] = lambda: ""

    # ── 3 对话与主动模型 ──────────────────────────────────────────────────
    persona: str = ""
    #: Legacy always-on style rules, kept as a directive source until the rows
    #: are migrated into nuri_directives.
    style_rules: Callable[..., Awaitable[str]] = _empty_str_async
    card_ctx: Callable[..., str] = _empty_str
    gen_cards: Callable[[], Awaitable[list]] = _empty_list_async

    # ── 横切 Safety Layer ─────────────────────────────────────────────────
    #: (user_text, ai_text) -> True when the turn describes an emergency.
    is_urgent: Callable[..., bool] = _false
    #: (user_text) -> True when the parent describes danger to themselves.
    #: Separate from is_urgent because the handoff is different: a crisis line,
    #: not an ambulance for the child.
    is_crisis: Callable[..., bool] = _false

    # ── tuning ────────────────────────────────────────────────────────────
    settings: dict = field(default_factory=dict)

    def setting(self, key: str, default: Any) -> Any:
        value = self.settings.get(key, default)
        return default if value is None else value
