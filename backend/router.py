"""The per-turn router: one small-model call that decides two things.

    * whether this turn needs external sources, and what to search for
    * whether this turn should produce task cards

Both decisions used to be made elsewhere and worse. Task cards were a
`suggest_tasks` boolean the main model set while writing its reply, judged
against four fairly subjective sentences — which is why testers reported the
cards appearing with "no rules". Moving it here makes it a separate, cheap,
auditable call with explicit criteria and a logged reason.

It is also what makes the search step affordable: routing runs inside the
existing parallel context phase, so the only latency actually added to a turn is
the search itself.

Two properties everything downstream depends on:

  * It never raises. Any failure returns `NO_ROUTE` with `ok=False` — no search,
    no task cards, reply unaffected.
  * It never blocks past `timeout_s`. This sits in front of the parent's first
    visible token.

`ok=False` is deliberately visible rather than silent: a wrong ROUTER_MODEL
would otherwise degrade every turn to "never search, never suggest tasks" and
look exactly like a product decision. Log it, and record it on the turn metrics.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from dataclasses import dataclass, replace
from typing import Literal, Optional, Sequence

from backend import llm_usage
from backend.nuri_core import family_store

Scope = Literal["en", "zh", "both"]

#: Must name a small, fast model — this call sits on the critical path and runs
#: on every turn. Verify the name against the account's available models: a
#: typo here degrades silently to "no search, no tasks" on every single turn.
ROUTER_MODEL = os.getenv("ROUTER_MODEL", "gpt-5-mini")

#: Routing gates the search, so the two are serial: this plus
#: WEB_SEARCH_TIMEOUT_S is the worst case added to first-token latency.
#: gpt-5-mini at minimal reasoning is usually 1.6-2.3s but has been seen past
#: 3s. Raising the ceiling costs nothing on a normal turn — the call returns
#: when it returns — while a timeout costs the turn its sources entirely, so
#: this is deliberately generous rather than tight.
ROUTER_TIMEOUT_S = float(os.getenv("ROUTER_TIMEOUT_S", "4.5"))

#: Classification needs no deliberation, and the default setting is ruinous
#: here: the same call measured 10.5s at gpt-5-mini's default effort against
#: 1.65s at minimal — 6x, on the critical path, for a labelling task.
#: Set to "" to omit the parameter entirely for models that don't accept it.
ROUTER_REASONING_EFFORT = os.getenv("ROUTER_REASONING_EFFORT", "minimal")

#: Turns of raw history handed to the router. The main reply gets 40; the router
#: only needs enough to tell "still venting" from "asking a concrete question",
#: and a shorter prompt is a faster and cheaper one.
ROUTER_HISTORY_WINDOW = int(os.getenv("ROUTER_HISTORY_WINDOW", "4"))

_VALID_SCOPES = ("en", "zh", "both")


@dataclass(frozen=True)
class TurnRoute:
    needs_search: bool = False
    #: English keywords. This is the query that reaches AAP/CDC-grade sources,
    #: which is the whole point of searching in English for these users.
    search_query: str = ""
    #: Chinese keywords for the zh pass. Kept separate because a Chinese query
    #: against English institutions retrieves badly, and vice versa.
    search_query_zh: str = ""
    search_scope: Scope = "both"
    is_medical: bool = False
    suggest_tasks: bool = False
    #: Short noun phrase naming what this turn is about ("睡眠倒退", "辅食添加").
    #: The task budget is spent per topic per day, so this is what decides
    #: whether a turn is a new concern or more of the one already handled —
    #: see _plan_task_cards in main.py. Filled on every turn, not only the ones
    #: that suggest tasks, so the log shows what a day actually covered.
    topic: str = ""
    #: Short rationale, logged so the task-card criteria can be tuned against
    #: real turns instead of guessed at.
    reason: str = ""
    #: False when the call failed and these are defaults, not decisions.
    ok: bool = True
    error: str = ""


NO_ROUTE = TurnRoute(ok=True)


def _failed(error: str) -> TurnRoute:
    return TurnRoute(ok=False, error=error[:300])


_ROUTER_SYSTEM = """你是育儿助手 NURI 的分流器。你不回答家长，只判断这一轮该怎么处理，然后输出 JSON。

【needs_search】这一轮的回复需不需要外部依据
**判断的对象是"NURI 接下来要说的话"，不是"家长这句话是不是在提问"。**
真实咨询里家长大多数发言都是在回答 NURI 的追问、补充细节，但 NURI 接下来往往
仍要就发育、喂养、睡眠、安全或医疗下判断——那种回复就需要依据，填 true。
true：接下来的回复会涉及月龄／年龄的发展常识、喂养或睡眠做法、医疗或安全、
      疫苗时程、托育安排，也就是任何"权威机构说过什么"能让回答更站得住的内容
false：只有纯粹的情绪安抚、寒暄、道谢，或这一轮 NURI 只是继续追问、不下任何结论
拿不准就填 true。多搜一次的代价只是延迟，少搜一次的代价是回答没有依据

【search_query / search_query_zh】英文和中文各一组关键词
- 最多 8 个词，像真人在搜索框里打的，不堆同义词——堆了结果只会更差
- 必须带上孩子的月龄或年龄，4个月和2岁的答案完全不同
- 例：'4 month old refusing solids' / '4个月 宝宝 不吃辅食'
- needs_search 为 false 时两个都留空

【search_scope】
both：默认，英文权威来源优先
zh：只跟中文语境有关时，例如国内政策、和长辈的教养观念冲突
en：只跟北美体系有关时，例如美国疫苗时程、保险、托育制度

【is_medical】发烧、用药、疫苗、过敏、外伤、发育迟缓、喂养障碍、以及任何"要不要看医生"
拿不准就填 true——这会把检索限制在权威机构，宁可保守
**is_medical 为 true 时 needs_search 也必须是 true，并给出两组关键词。**
医疗问题正是最需要权威依据的场合，绝不能凭印象直接回答

【suggest_tasks】全部满足才是 true：
- 出现了具体的育儿场景、困扰或目标，不是泛泛聊天
- 背景已经够清楚，知道给什么任务有意义
- 自然到了"我来帮你整理几件可以做的事"的时机
纯情绪倾诉、寒暄、还在追问了解情况的阶段，一律 false

【topic】这一轮在谈的核心话题，4-10 个字的名词短语
例：「睡眠倒退」「辅食添加」「入园分离焦虑」「兄弟争抢玩具」
- **每轮都要填**，包括 suggest_tasks 为 false 的时候
- **标签要稳定**：同一个困扰在后续几轮里必须给出同样的词。一天里同一个话题
  只会生成一次任务，标签飘移会让同一件事重复占用额度
- 填这一轮真正在谈的事，不要填「育儿」「带娃」这种没有区分度的大词

【reason】30字以内，中文，**必须同时说明 needs_search 和 suggest_tasks 两个判断**
例：「要讲副食品准备信号，需依据；已有具体目标，给任务」"""


def _condense(history: Sequence[dict], window: int = ROUTER_HISTORY_WINDOW) -> str:
    """Flatten recent turns into plain text. Task-card and other transition
    messages are skipped — they're UI payloads, not things anyone said."""
    lines = []
    for m in list(history)[-window:]:
        text = (m.get("text") or "").strip()
        if not text or (m.get("transition") or {}).get("kind"):
            continue
        who = "家长" if m.get("role") == "user" else "NURI"
        lines.append(f"{who}: {text}")
    return "\n".join(lines)


_ROUTER_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "turn_route",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "needs_search": {"type": "boolean"},
                "search_query": {"type": "string"},
                "search_query_zh": {"type": "string"},
                "search_scope": {"type": "string", "enum": list(_VALID_SCOPES)},
                "is_medical": {"type": "boolean"},
                "suggest_tasks": {"type": "boolean"},
                "topic": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": [
                "needs_search", "search_query", "search_query_zh",
                "search_scope", "is_medical", "suggest_tasks", "topic", "reason",
            ],
            "additionalProperties": False,
        },
    },
}


def parse_route(raw: str) -> TurnRoute:
    """Parse and sanitise the model's JSON.

    Separated from the network call so the invariants below are testable without
    a model: a route that says "search" but supplies no query is corrected here
    rather than surfacing as a confusing no-op further down.

    `suggest_tasks` here is only the model's opinion that the *moment* is right.
    Whether cards are actually drafted — and how many — is a budget decision
    that needs the day's history and the parent's open tasks, so it lives in
    main.py's `_plan_task_cards`.
    """
    data = json.loads(raw)

    scope = data.get("search_scope")
    if scope not in _VALID_SCOPES:
        scope = "both"

    query = (data.get("search_query") or "").strip()
    query_zh = (data.get("search_query_zh") or "").strip()
    # A search with nothing to search for is a wasted round trip.
    needs_search = bool(data.get("needs_search")) and bool(query or query_zh)

    return TurnRoute(
        needs_search=needs_search,
        search_query=query if needs_search else "",
        search_query_zh=query_zh if needs_search else "",
        search_scope=scope,
        is_medical=bool(data.get("is_medical")),
        suggest_tasks=bool(data.get("suggest_tasks")),
        topic=(data.get("topic") or "").strip()[:40],
        reason=(data.get("reason") or "").strip()[:120],
    )


async def route_turn(
    history: Sequence[dict],
    *,
    client,
    child_context: str = "",
    sensitive_children: Sequence[dict] = (),
    model: str = ROUTER_MODEL,
    timeout_s: float = ROUTER_TIMEOUT_S,
) -> TurnRoute:
    """Classify one turn. `client` is an async OpenAI client (main.py's `aoai`),
    passed in rather than imported so this module stays independent of main.py.

    `child_context` should carry the child's age — the search query is close to
    useless without it, since advice for a 4-month-old and a 2-year-old share
    almost nothing.
    """
    if client is None:
        return _failed("no model client")

    # This model may author an external search query.  It must not see the
    # account's exact child identifiers even when those facts appeared in a
    # recent user or NURI message.
    safe_history = family_store.redact_child_profile_history(
        list(history), list(sensitive_children),
    )
    convo = _condense(safe_history)
    if not convo:
        return NO_ROUTE

    user_block = (f"{child_context}\n\n" if child_context else "") + f"对话：\n{convo}"

    messages = [
        {"role": "system", "content": _ROUTER_SYSTEM},
        {"role": "user", "content": user_block},
    ]

    async def call(reasoning: str) -> str:
        extra = {"reasoning_effort": reasoning} if reasoning else {}
        started = time.perf_counter()
        resp = await client.chat.completions.create(
            model=model, messages=messages,
            response_format=_ROUTER_RESPONSE_FORMAT, **extra,
        )
        # Small per call, but it runs on every turn — the kind of line that only
        # shows up as a problem once it is being counted.
        await llm_usage.arecord(
            "chat.router", model, usage=getattr(resp, "usage", None),
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        return resp.choices[0].message.content or ""

    async def call_with_fallback() -> str:
        try:
            return await call(ROUTER_REASONING_EFFORT)
        except TypeError as e:
            # Model or SDK doesn't take the parameter. Retry without it rather
            # than degrading the whole turn to "no search, no tasks" over a
            # keyword — the call itself is fine, just slower.
            print(f"[warn] router: reasoning_effort rejected ({e}); retrying without")
            return await call("")
        except Exception as e:
            if "reasoning_effort" not in str(e):
                raise
            print(f"[warn] router: reasoning_effort rejected ({e}); retrying without")
            return await call("")

    try:
        raw = await asyncio.wait_for(call_with_fallback(), timeout=timeout_s)
    except asyncio.TimeoutError:
        print(f"[warn] router timed out after {timeout_s}s (model={model})")
        return _failed("timeout")
    except Exception as e:
        print(f"[warn] router failed (model={model}): {type(e).__name__}: {e}")
        return _failed(f"{type(e).__name__}: {e}")

    try:
        route = parse_route(raw)
        # Treat model output as untrusted.  A router can echo text from its
        # prompt or reconstruct a birthday in another supported display form;
        # scrub every field that can reach search or persistent turn metrics.
        search_query = family_store.redact_child_profile_text(
            route.search_query, list(sensitive_children),
        ).strip()
        search_query_zh = family_store.redact_child_profile_text(
            route.search_query_zh, list(sensitive_children),
        ).strip()
        return replace(
            route,
            needs_search=bool(route.needs_search and (search_query or search_query_zh)),
            search_query=search_query if route.needs_search else "",
            search_query_zh=search_query_zh if route.needs_search else "",
            topic=family_store.redact_child_profile_text(
                route.topic, list(sensitive_children),
            ).strip()[:40],
            reason=family_store.redact_child_profile_text(
                route.reason, list(sensitive_children),
            ).strip()[:120],
        )
    except Exception as e:
        print(f"[warn] router returned unparsable JSON: {type(e).__name__}: {e}")
        return _failed(f"parse: {type(e).__name__}")


def route_metrics(route: TurnRoute) -> dict:
    """Flatten a route into columns for chat_turn_logs. `route_reason` is the
    one that earns its keep: it's what lets someone look at a week of real
    turns and actually tune when task cards should appear."""
    return {
        "route_ok": route.ok,
        "route_error": route.error,
        "needs_search": route.needs_search,
        "search_scope": route.search_scope,
        "is_medical": route.is_medical,
        "suggested_tasks": route.suggest_tasks,
        "route_reason": route.reason,
        "route_topic": route.topic,
    }
