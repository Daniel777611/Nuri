"""What OpenAI actually billed, from its organization Costs and Usage APIs.

Our own llm_call_logs only see calls made by this environment with logging on.
Evals run with LLM_USAGE_LOGGING=0, the dev database logs to itself, and any
other holder of the same key logs nowhere — which is how a $20 top-up could
show ~$7.5 of recorded spend. The organization APIs are the bill itself, for
every project and key, so they answer "where did the money go" without that
blind spot.

They need an Admin key (OPENAI_ADMIN_KEY), created by an organization owner
and far more powerful than an inference key, so it is read here and nowhere
else, never sent to a browser, and only used for GETs.

Everything is bucketed by UTC day because that is how OpenAI buckets costs;
converting to the admin's timezone would split a bucket we can't split.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import httpx

from backend import usage_dashboard

API_BASE = "https://api.openai.com/v1/organization"
TIMEOUT_S = float(os.getenv("OPENAI_ADMIN_TIMEOUT_S", "20"))
#: Buckets per page. 0 leaves the parameter out and takes OpenAI's default.
PAGE_LIMIT = int(os.getenv("OPENAI_BILLING_PAGE_LIMIT", "31"))
MAX_PAGES = 40
MAX_DAYS = 90
#: The bill changes a few times an hour at most, and every dashboard load
#: would otherwise be a dozen round trips to OpenAI.
CACHE_TTL_S = 600
#: The standing budget: 1,200 turns for $20.
TARGET_USD_PER_TURN = round(20 / 1200, 4)
UNASSIGNED_PROJECT = "未归属项目（默认项目）"
OTHER_LINE_ITEM = "其余"
TOP_LINE_ITEMS = 8


class BillingError(RuntimeError):
    """OpenAI refused or failed a billing read; the message is for the admin."""

    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


def admin_key() -> str:
    return "".join(os.getenv("OPENAI_ADMIN_KEY", "").split())


def _openai_message(text: str) -> str:
    """OpenAI's own reason — it names the missing scope or the wrong key type,
    which the status code alone doesn't. It never echoes the key."""
    try:
        import json

        error = json.loads(text or "{}").get("error") or {}
        message = error.get("message") if isinstance(error, dict) else str(error)
    except Exception:
        message = text
    return " ".join(str(message or "").split())[:300]


def _explain(status: int, text: str, path: str) -> str:
    reason = _openai_message(text)
    said = f"OpenAI 的原话：{reason}" if reason else "OpenAI 没有给出原因"
    where = f"{path} 接口"
    if status == 401:
        return f"{where}拒绝了这把密钥（401）：密钥无效、已吊销，或环境变量填错了。{said}"
    if status == 403:
        return (
            f"{where}拒绝了这把密钥（403）：它不是组织 Owner 创建的 Admin key（sk-admin- 开头），"
            f"或者创建时没给读取用量/账单的权限。{said}"
        )
    if status == 429:
        return f"{where}限流（429），过一会儿再刷新。"
    return f"{where}返回 {status}。{said}"


# ── Window ───────────────────────────────────────────────────────────────────

def _utc_midnight(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc)


def window_days(days: int, now: datetime) -> list[date]:
    today = now.astimezone(timezone.utc).date()
    return [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]


def window_start(days: int, now: datetime) -> datetime:
    return _utc_midnight(window_days(days, now)[0])


# ── Fetch ────────────────────────────────────────────────────────────────────

@dataclass
class Raw:
    costs: list[dict]
    usage: list[dict]
    projects: dict[str, str]
    #: What could not be read, for the panel to say so.
    notes: list[str] = field(default_factory=list)


_CACHE: dict[tuple, tuple[float, Raw]] = {}


async def _pages(client: httpx.AsyncClient, path: str, params: dict, key: str) -> list[dict]:
    """Every bucket, following `next_page` until OpenAI says there are no more."""
    buckets: list[dict] = []
    cursor: Optional[str] = None
    for _ in range(MAX_PAGES):
        query = dict(params)
        if PAGE_LIMIT > 0:
            query["limit"] = PAGE_LIMIT
        if cursor:
            query["page"] = cursor
        resp = await client.get(
            f"{API_BASE}/{path}", params=query, headers={"Authorization": f"Bearer {key}"},
        )
        if resp.status_code >= 400:
            raise BillingError(_explain(resp.status_code, resp.text, path), resp.status_code)
        body = resp.json()
        buckets.extend(body.get("data") or [])
        cursor = body.get("next_page")
        if not cursor or body.get("has_more") is False:
            return buckets
    return buckets


async def _project_names(client: httpx.AsyncClient, key: str) -> dict[str, str]:
    """id → name. A nicety: a failure here leaves ids on screen, not an error."""
    names: dict[str, str] = {}
    after: Optional[str] = None
    try:
        for _ in range(MAX_PAGES):
            params: dict = {"limit": 100, "include_archived": "true"}
            if after:
                params["after"] = after
            resp = await client.get(
                f"{API_BASE}/projects", params=params, headers={"Authorization": f"Bearer {key}"},
            )
            if resp.status_code >= 400:
                return names
            body = resp.json()
            for project in body.get("data") or []:
                if project.get("id"):
                    names[project["id"]] = project.get("name") or project["id"]
            after = body.get("last_id")
            if not body.get("has_more") or not after:
                return names
    except Exception as exc:
        print(f"[warn] openai projects lookup failed: {type(exc).__name__}")
    return names


async def fetch_openai(
    key: str, *, days: int, now: datetime, refresh: bool = False,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> Raw:
    first = window_days(days, now)[0]
    today = now.astimezone(timezone.utc).date()
    # Month-to-date needs the 1st even when the window starts later.
    costs_from = min(first, today.replace(day=1))
    end = int(_utc_midnight(today + timedelta(days=1)).timestamp())
    cache_key = (hashlib.sha256(key.encode()).hexdigest()[:12], days, today.isoformat())
    cached = _CACHE.get(cache_key)
    if cached and not refresh and time.monotonic() - cached[0] < CACHE_TTL_S:
        return cached[1]

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, transport=transport) as client:
            costs, usage, projects = await asyncio.gather(
                _pages(client, "costs", {
                    "start_time": int(_utc_midnight(costs_from).timestamp()), "end_time": end,
                    "bucket_width": "1d", "group_by": ["project_id", "line_item"],
                }, key),
                _pages(client, "usage/completions", {
                    "start_time": int(_utc_midnight(first).timestamp()), "end_time": end,
                    "bucket_width": "1d",
                }, key),
                _project_names(client, key),
                return_exceptions=True,
            )
    except Exception as exc:
        raise BillingError(f"连不上 OpenAI 账单接口：{type(exc).__name__}") from exc
    # The bill is the point; without it there is nothing to show. Token usage
    # only feeds the cache share and the unlogged comparison, so a key that can
    # read one but not the other still gets the money.
    if isinstance(costs, BaseException):
        if isinstance(costs, BillingError):
            raise costs
        raise BillingError(f"连不上 OpenAI 账单接口：{type(costs).__name__}") from costs
    notes: list[str] = []
    if isinstance(usage, BaseException):
        notes.append(str(usage) if isinstance(usage, BillingError) else f"用量接口读取失败：{type(usage).__name__}")
        usage = []
    if isinstance(projects, BaseException):
        projects = {}
    raw = Raw(costs=costs, usage=usage, projects=projects, notes=notes)
    _CACHE[cache_key] = (time.monotonic(), raw)
    return raw


def fetch_logged(sb, since: datetime) -> tuple[int, Optional[dict[str, int]], list[str]]:
    """(successful turns, tokens this database logged per UTC day, truncated).

    Embeddings are left out because the usage figure they are compared with
    counts completions only.
    """
    truncated: list[str] = []
    since_iso = since.isoformat()
    turn_rows = usage_dashboard._page_through(
        lambda: sb.table("chat_turn_logs").select("created_at,status")
        .gte("created_at", since_iso).order("created_at"),
        "chat_turn_logs", truncated,
    )
    turns = sum(1 for row in turn_rows if (row.get("status") or "ok") == "ok")
    try:
        calls = usage_dashboard._page_through(
            lambda: sb.table("llm_call_logs")
            .select("created_at,model,prompt_tokens,completion_tokens,total_tokens")
            .gte("created_at", since_iso).order("created_at"),
            "llm_call_logs", truncated,
        )
    except Exception as exc:
        if not usage_dashboard._table_missing(exc):
            raise
        return turns, None, truncated
    by_day: dict[str, int] = {}
    for row in calls:
        if str(row.get("model") or "").startswith("text-embedding"):
            continue
        moment = usage_dashboard.parse_ts(row.get("created_at"))
        if not moment:
            continue
        day = moment.astimezone(timezone.utc).date().isoformat()
        by_day[day] = by_day.get(day, 0) + usage_dashboard._row_tokens(row)
    return turns, by_day, truncated


# ── Summarize ────────────────────────────────────────────────────────────────

def _usd(result: dict) -> float:
    amount = result.get("amount")
    if isinstance(amount, dict):
        amount = amount.get("value")
    try:
        return float(amount or 0)
    except (TypeError, ValueError):
        return 0.0


def _bucket_day(bucket: dict) -> Optional[str]:
    try:
        return datetime.fromtimestamp(int(bucket["start_time"]), timezone.utc).date().isoformat()
    except (KeyError, TypeError, ValueError):
        return None


def _shares(totals: dict[str, float], grand: float) -> list[tuple[str, float, float]]:
    return sorted(
        ((name, round(usd, 4), round(usd / grand, 4) if grand else 0.0) for name, usd in totals.items()),
        key=lambda item: -item[1],
    )


def summarize(
    raw: Raw, *, days: int, now: datetime, turns: Optional[int] = None,
    logged_by_day: Optional[dict[str, int]] = None, truncated: Optional[list[str]] = None,
) -> dict:
    day_list = window_days(days, now)
    day_keys = [d.isoformat() for d in day_list]
    in_window = set(day_keys)
    month_start = day_list[-1].replace(day=1).isoformat()

    daily = {
        key: {"day": key, "usd": 0.0, "input_tokens": 0, "output_tokens": 0,
              "cached_tokens": 0, "requests": 0,
              "logged_tokens": None if logged_by_day is None else int(logged_by_day.get(key, 0))}
        for key in day_keys
    }
    project_usd: dict[str, float] = {}
    project_name: dict[str, str] = {}
    line_usd: dict[str, float] = {}
    total = month_to_date = 0.0

    for bucket in raw.costs:
        day = _bucket_day(bucket)
        if not day:
            continue
        for result in bucket.get("results") or []:
            usd = _usd(result)
            if day >= month_start:
                month_to_date += usd
            if day not in in_window:
                continue
            total += usd
            daily[day]["usd"] += usd
            pid = str(result.get("project_id") or "")
            project_usd[pid] = project_usd.get(pid, 0.0) + usd
            project_name[pid] = (
                result.get("project_name") or raw.projects.get(pid) or (pid or UNASSIGNED_PROJECT)
            )
            line = str(result.get("line_item") or OTHER_LINE_ITEM)
            line_usd[line] = line_usd.get(line, 0.0) + usd

    usage = {"input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "requests": 0}
    for bucket in raw.usage:
        day = _bucket_day(bucket)
        if day not in in_window:
            continue
        for result in bucket.get("results") or []:
            fields = {
                "input_tokens": int(result.get("input_tokens") or 0),
                "cached_tokens": int(result.get("input_cached_tokens") or 0),
                "output_tokens": int(result.get("output_tokens") or 0),
                "requests": int(result.get("num_model_requests") or 0),
            }
            for name, value in fields.items():
                usage[name] += value
                daily[day][name] += value

    lines = _shares(line_usd, total)
    if len(lines) > TOP_LINE_ITEMS:
        rest = sum(usd for _n, usd, _s in lines[TOP_LINE_ITEMS:])
        lines = lines[:TOP_LINE_ITEMS] + [(OTHER_LINE_ITEM, round(rest, 4), round(rest / total, 4) if total else 0.0)]

    billed_tokens = usage["input_tokens"] + usage["output_tokens"]
    logged = None
    if logged_by_day is not None:
        logged_tokens = sum(int(logged_by_day.get(key, 0)) for key in day_keys)
        unlogged = max(0, billed_tokens - logged_tokens)
        logged = {
            "tokens": logged_tokens,
            "unlogged_tokens": unlogged,
            "unlogged_share": round(unlogged / billed_tokens, 4) if billed_tokens else 0.0,
        }

    return {
        "configured": True,
        "days": days,
        "since": day_keys[0],
        "until": day_keys[-1],
        "month_start": month_start,
        "currency": "usd",
        "total_usd": round(total, 4),
        "month_to_date_usd": round(month_to_date, 4),
        "daily": [{**row, "usd": round(row["usd"], 4)} for row in daily.values()],
        "projects": [
            {"id": pid, "name": project_name[pid], "usd": usd, "share": share}
            for pid, usd, share in _shares(project_usd, total)
        ],
        "line_items": [{"name": name, "usd": usd, "share": share} for name, usd, share in lines],
        "usage": {
            **usage,
            "cached_share": round(usage["cached_tokens"] / usage["input_tokens"], 4)
            if usage["input_tokens"] else 0.0,
        },
        "logged": logged,
        "turns": turns,
        "usd_per_turn": round(total / turns, 4) if turns else None,
        "target_usd_per_turn": TARGET_USD_PER_TURN,
        "fetched_at": now.isoformat(),
        "truncated": truncated or [],
        "warnings": list(raw.notes),
    }
