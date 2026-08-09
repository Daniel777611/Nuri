"""What the conversation says the feed should be about.

Pure text analysis over the parent's recent messages: telling a real parenting
concern from an acknowledgement, from a complaint about the product, from a
request to do something; extracting the topic; and ranking the learning
library against it.

No I/O beyond loading the recent chat, and no notion of what a card looks
like — that is `delivery.py`, which imports this. The dependency runs one way,
which is what made the split possible at all.

This is the most testable code in the backend and was the least reachable,
buried four thousand lines into an app module.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse

import anyio

from backend import (
    content_research,
    locales,
    memstore,
    recommendation_feedback,
    runtime,
    stores,
)
from backend.content_library import (
    AUTHORITY_VIDEO_FORBIDDEN_PARENT_ORG_IDS,
    CASE_FORBIDDEN_PARENT_ORG_IDS,
    ENGLISH_AUTHORITY_SOURCE_PARENT_ORG_IDS,
    FEATURED_FORBIDDEN_PARENT_ORG_IDS,
    LEARNING_CONTENT_BY_ID,
    LEARNING_CONTENT_CARDS,
    US_AUTHORITY_SOURCE_PARENT_ORG_IDS,
    case_article_reader_experience_status,
    is_trusted_resource_url,
    order_learning_resources,
    resource_parent_org_id as policy_resource_parent_org_id,
    source_parent_org_id,
)
from backend.content_research import (
    CONTENT_CATEGORIES,
    DELIVERY_SOURCE_CONTRACT_VERSION,
    DYNAMIC_RESEARCH_CARD_PREFIX,
    MAX_TOTAL_RESEARCH_RESOURCES,
    MIN_TOTAL_RESEARCH_RESOURCES,
    redact_conversation_text,
    reviewed_learning_resource_bundle,
    reviewed_resource_matches_context,
    summarize_resource_slots,
)
from backend.nuri_core import dialogue_reply, outcome_store
from backend.recommendation_feedback import (
    LEARNING_EVENT_NAMES,
    category_preference_mix,
    recent_resource_urls,
    weighted_category_for_window,
)
from backend.recommendation_snapshots import (
    SNAPSHOT_CONTEXT_VERSION,
    SNAPSHOT_VERSION,
    build_snapshot,
    carry_prepared_resource_state,
    parse_snapshot,
    prepared_resource_pair,
    prepared_resource_pairs,
    snapshot_storage_key,
    snapshot_with_active_resource_pair,
    snapshot_with_prepared_resource_pair,
    snapshot_with_prepared_resource_pairs,
    snapshot_with_resource_readiness,
)


def _recommendation_activity_key(row: dict) -> tuple[str, str]:
    return (str(row.get("created_at") or ""), str(row.get("id") or ""))


_ACCOUNT_HISTORY_SESSION_LIMIT = 5
_ACCOUNT_HISTORY_USER_MESSAGE_LIMIT = 18
_CURRENT_SESSION_USER_HISTORY_LIMIT = 24


def _safe_context_message(message: dict, *, context_scope: str) -> dict:
    """Return only the conversation fields needed by recommendation ranking."""

    return {
        "id": message.get("id"),
        "session_id": message.get("session_id"),
        "role": message.get("role"),
        "text": str(message.get("text") or ""),
        "created_at": message.get("created_at"),
        "context_scope": context_scope,
    }


def _recent_account_user_signals(
    messages: list[dict],
    *,
    current_session_id: str,
) -> list[dict]:
    """Select a bounded, balanced set of user-authored account history.

    The caller must already have scoped ``messages`` to one authenticated user
    and excluded card-linked sessions.  We keep at most five other main chats
    and at most four messages from any one chat so a long stale conversation
    cannot drown out the current request.
    """

    selected: list[dict] = []
    session_counts: dict[str, int] = {}
    for message in sorted(messages, key=_recommendation_activity_key, reverse=True):
        session_id = str(message.get("session_id") or "")
        if not session_id or session_id == current_session_id:
            continue
        if message.get("role") != "user" or not str(message.get("text") or "").strip():
            continue
        if session_id not in session_counts:
            if len(session_counts) >= _ACCOUNT_HISTORY_SESSION_LIMIT:
                continue
            session_counts[session_id] = 0
        if session_counts[session_id] >= 4:
            continue
        session_counts[session_id] += 1
        selected.append(message)
        if len(selected) >= _ACCOUNT_HISTORY_USER_MESSAGE_LIMIT:
            break
    return [
        _safe_context_message(message, context_scope="account_history")
        for message in reversed(selected)
    ]


def recent_main_chat_from_memory(
    uid: str,
    limit: int = 12,
    preferred_session_id: Optional[str] = None,
    through_created_at: Optional[str] = None,
) -> dict:
    """Resolve the user's real main conversation without trusting a client ID."""

    sessions = [
        session
        for session in memstore.sessions.values()
        if session.get("user_id") == uid and not session.get("source_card_id")
    ]
    if not sessions:
        return {"state": "no_history", "session_id": None, "messages": []}

    session_ids = {session["id"] for session in sessions}
    all_user_messages = [
        {**message, "session_id": message.get("session_id") or session_id}
        for session_id in session_ids
        for message in memstore.messages.get(session_id, [])
        if message.get("role") == "user" and str(message.get("text") or "").strip()
    ]
    last_user_message = max(
        all_user_messages,
        key=_recommendation_activity_key,
        default=None,
    )
    preferred_session = next(
        (session for session in sessions if session.get("id") == preferred_session_id),
        None,
    )
    if preferred_session_id and not preferred_session:
        return {
            "state": "context_not_found",
            "session_id": None,
            "messages": [],
            "context_created_at": None,
            "history_session_count": 0,
            "history_user_message_count": 0,
        }
    if preferred_session:
        session = preferred_session
        preferred_messages = [
            message
            for message in memstore.messages.get(session["id"], [])
            if not through_created_at
            or str(message.get("created_at") or "") <= through_created_at
        ]
        last_user_message = next(
            (
                message
                for message in reversed(
                    sorted(preferred_messages, key=_recommendation_activity_key)
                )
                if message.get("role") == "user"
                and str(message.get("text") or "").strip()
            ),
            None,
        )
    elif last_user_message:
        session = next(
            item for item in sessions if item["id"] == last_user_message.get("session_id")
        )
    else:
        session = max(sessions, key=_recommendation_activity_key)

    all_current_messages = sorted(
        [
            message
            for message in memstore.messages.get(session["id"], [])
            if not through_created_at
            or str(message.get("created_at") or "") <= through_created_at
        ],
        key=_recommendation_activity_key,
    )
    messages = all_current_messages[-limit:]
    safe_messages = [
        _safe_context_message(
            {**message, "session_id": message.get("session_id") or session["id"]},
            context_scope="current_session",
        )
        for message in messages
        if message.get("role") in {"user", "ai", "assistant"}
    ]
    recent_message_ids = {
        str(message.get("id") or "") for message in safe_messages if message.get("id")
    }
    bounded_current_user_messages = [
        item
        for item in all_current_messages
        if item.get("role") == "user" and str(item.get("text") or "").strip()
    ][-_CURRENT_SESSION_USER_HISTORY_LIMIT:]
    deeper_current_user_messages = [
        _safe_context_message(
            {**message, "session_id": message.get("session_id") or session["id"]},
            context_scope="current_session_history",
        )
        for message in bounded_current_user_messages
        if str(message.get("id") or "") not in recent_message_ids
    ]
    history_messages = (
        []
        if preferred_session_id or through_created_at
        else _recent_account_user_signals(
            all_user_messages,
            current_session_id=session["id"],
        )
    )
    return {
        "state": "ready" if last_user_message else "no_user_message",
        "session_id": session.get("id"),
        "messages": [
            *history_messages,
            *deeper_current_user_messages,
            *safe_messages,
        ],
        "context_created_at": (safe_messages[-1].get("created_at") if safe_messages else None),
        "history_session_count": len(
            {message.get("session_id") for message in history_messages}
        ),
        "history_user_message_count": len(history_messages),
        "current_session_user_message_count": sum(
            1
            for message in [*deeper_current_user_messages, *safe_messages]
            if message.get("role") == "user"
        ),
    }


async def load_recent_main_chat(
    uid: str,
    limit: int = 12,
    preferred_session_id: Optional[str] = None,
    through_created_at: Optional[str] = None,
) -> dict:
    """Load recent main-chat context scoped to ``uid``.

    Card-linked conversations are intentionally excluded.  When Supabase is
    temporarily unavailable we return a safe default state instead of exposing
    another user's process-local data or breaking the home screen.
    """

    privacy = await stores.get_privacy(uid, fail_closed=True)
    preferred_locale = locales.normalize_preferred_locale(privacy.get("language"))
    external_research_allowed = bool(
        privacy.get("allow_external_content_research") is True
    )
    if privacy.get(stores.PRIVACY_STORAGE_UNAVAILABLE):
        return {
            "state": "unavailable",
            "session_id": None,
            "messages": [],
            "preferred_locale": preferred_locale,
            "external_research_allowed": False,
        }
    if privacy.get("allow_history_training") is False:
        return {
            "state": "privacy_off",
            "session_id": None,
            "messages": [],
            "preferred_locale": preferred_locale,
            "external_research_allowed": False,
        }

    sb = runtime.get_supabase()
    if not sb:
        return {
            **recent_main_chat_from_memory(
                uid, limit, preferred_session_id, through_created_at
            ),
            "preferred_locale": preferred_locale,
            "external_research_allowed": external_research_allowed,
        }

    try:
        session_res = await anyio.to_thread.run_sync(
            lambda: sb.table("chat_sessions")
            .select("id,title,source_card_id,created_at")
            .eq("user_id", uid)
            .execute()
        )
        main_sessions = [
            session
            for session in (session_res.data or [])
            if not session.get("source_card_id")
        ]
        if not main_sessions:
            return {
                "state": "no_history",
                "session_id": None,
                "messages": [],
                "preferred_locale": preferred_locale,
                "external_research_allowed": external_research_allowed,
            }

        session_ids = [session["id"] for session in main_sessions]
        preferred_session = next(
            (
                item
                for item in main_sessions
                if item.get("id") == preferred_session_id
            ),
            None,
        )
        if preferred_session_id and not preferred_session:
            return {
                "state": "context_not_found",
                "session_id": None,
                "messages": [],
                "context_created_at": None,
                "history_session_count": 0,
                "history_user_message_count": 0,
                "preferred_locale": preferred_locale,
                "external_research_allowed": external_research_allowed,
            }
        if preferred_session:
            session = preferred_session
        else:
            # This first query only identifies the active main conversation.
            # Account history is loaded separately below; otherwise a long
            # current chat can consume the global PostgREST limit and erase all
            # continuity signals from the user's other conversations.
            latest_user_res = await anyio.to_thread.run_sync(
                lambda: sb.table("chat_messages")
                .select("id,session_id,role,text,created_at")
                .in_("session_id", session_ids)
                .eq("role", "user")
                .order("created_at", desc=True)
                .order("id", desc=True)
                .limit(1)
                .execute()
            )
            last_user_message = ((latest_user_res.data or []) or [None])[0]
            if last_user_message:
                session = next(
                    item
                    for item in main_sessions
                    if item["id"] == last_user_message.get("session_id")
                )
            else:
                session = max(main_sessions, key=_recommendation_activity_key)

        def load_context_messages():
            query = (
                sb.table("chat_messages")
                .select("id,session_id,role,text,created_at")
                .eq("session_id", session["id"])
            )
            if through_created_at:
                query = query.lte("created_at", through_created_at)
            return (
                query.order("created_at", desc=True)
                .order("id", desc=True)
                .limit(limit)
                .execute()
            )

        message_res = await anyio.to_thread.run_sync(load_context_messages)
        current_messages = list(reversed(message_res.data or []))

        def load_current_user_history():
            query = (
                sb.table("chat_messages")
                .select("id,session_id,role,text,created_at")
                .eq("session_id", session["id"])
                .eq("role", "user")
            )
            if through_created_at:
                query = query.lte("created_at", through_created_at)
            return (
                query.order("created_at", desc=True)
                .order("id", desc=True)
                .limit(_CURRENT_SESSION_USER_HISTORY_LIMIT)
                .execute()
            )

        current_user_history_res = await anyio.to_thread.run_sync(
            load_current_user_history
        )
        recent_message_ids = {
            str(message.get("id") or "")
            for message in current_messages
            if message.get("id")
        }
        deeper_current_user_messages = [
            _safe_context_message(
                message,
                context_scope="current_session_history",
            )
            for message in reversed(current_user_history_res.data or [])
            if str(message.get("id") or "") not in recent_message_ids
        ]
        history_messages: list[dict] = []
        if not preferred_session_id and not through_created_at:
            history_sessions = sorted(
                (
                    item
                    for item in main_sessions
                    if item.get("id") != session["id"]
                ),
                key=_recommendation_activity_key,
                reverse=True,
            )[:_ACCOUNT_HISTORY_SESSION_LIMIT]

            async def load_history_session(history_session_id: str):
                return await anyio.to_thread.run_sync(
                    lambda: sb.table("chat_messages")
                    .select("id,session_id,role,text,created_at")
                    .eq("session_id", history_session_id)
                    .eq("role", "user")
                    .order("created_at", desc=True)
                    .order("id", desc=True)
                    # Fetch enough from each candidate session for the global
                    # 18-message selector below to find durable themes. A fixed
                    # four-message slice hid older but repeatedly important
                    # context in accounts with one long historical main chat.
                    .limit(_ACCOUNT_HISTORY_USER_MESSAGE_LIMIT)
                    .execute()
                )

            history_results = await asyncio.gather(
                *(
                    load_history_session(str(item["id"]))
                    for item in history_sessions
                )
            )
            history_user_messages = [
                message
                for result in history_results
                for message in (result.data or [])
            ]
            history_messages = _recent_account_user_signals(
                history_user_messages,
                current_session_id=session["id"],
            )
        messages = [
            *history_messages,
            *deeper_current_user_messages,
            *[
                _safe_context_message(message, context_scope="current_session")
                for message in current_messages
                if message.get("role") in {"user", "ai", "assistant"}
            ],
        ]
        session_has_user_message = any(
            message.get("role") == "user"
            and str(message.get("text") or "").strip()
            for message in [*deeper_current_user_messages, *current_messages]
        )
        return {
            "state": "ready" if session_has_user_message else "no_user_message",
            "session_id": session.get("id"),
            "messages": messages,
            "context_created_at": (
                current_messages[-1].get("created_at") if current_messages else None
            ),
            "history_session_count": len(
                {message.get("session_id") for message in history_messages}
            ),
            "history_user_message_count": len(history_messages),
            "current_session_user_message_count": sum(
                1
                for message in [*deeper_current_user_messages, *current_messages]
                if message.get("role") == "user"
            ),
            "preferred_locale": preferred_locale,
            "external_research_allowed": external_research_allowed,
        }
    except Exception as exc:
        print(f"[warn] personalized feed conversation lookup failed: {exc}")
        return {
            "state": "unavailable",
            "session_id": None,
            "messages": [],
            "preferred_locale": preferred_locale,
            "external_research_allowed": False,
        }


CONVERSATION_MATCH_MIN_SCORE = 8
_WEAK_MATCH_TERMS = frozenset(
    {
        "沟通",
        "表达",
        "互动",
        "连接",
        "安全",
        "压力",
        "play",
        "words",
        "behavior",
        "food",
        # Age alone describes context, not the family's current goal.  It may
        # support a development match but must not beat an explicit language,
        # sleep or behavior concern.
        "月龄",
        "9个月",
        "九个月",
        "10个月",
        "十个月",
        "11个月",
        "十一个月",
        "一岁",
    }
)
_NEGATION_MARKERS = (
    "不是",
    "并不是",
    "不属于",
    "不用",
    "无需",
    "不要聊",
    "不想聊",
    "无关",
    "没关系",
    "没有关系",
    "not about",
    "unrelated",
    "isn't",
    "is not",
    "isnt",
    "aren't",
    "are not",
    "not ",
    "don't mean",
    "do not mean",
    "is unrelated",
    "isn't related",
)
_TOPIC_CLAUSE_BOUNDARIES = (
    "，",
    ",",
    "。",
    ".",
    "！",
    "!",
    "？",
    "?",
    "；",
    ";",
    "\n",
    " but ",
    " however ",
    "而是",
    "但是",
    "但",
)
_FOLLOW_UP_MARKERS = (
    "任务",
    "怎么做",
    "怎么办",
    "具体",
    "继续",
    "给我",
    "建议",
    "接下来",
    "哪些",
    "什么引导",
    "什么样的引导",
    "如何",
)
_ACTION_REQUEST_LABELS = (
    ("任务", "可执行任务"),
    ("方案", "可执行方案"),
    ("计划", "行动计划"),
    ("练习", "日常练习"),
    ("步骤", "具体步骤"),
    ("怎么做", "具体做法"),
    ("怎么办", "具体做法"),
    ("action plan", "行动方案"),
    ("task", "可执行任务"),
)
_ACTION_ONLY_FILLERS = (
    "也",
    "再",
    "请",
    "帮我",
    "给我",
    "可以",
    "能不能",
    "想要",
    "需要",
    "一些",
    "几个",
    "一个",
    "具体",
    "接下来",
    "现在",
    "吧",
    "吗",
    "呢",
    "please",
    "give me",
    "some",
    "a",
    "an",
    "the",
    "for me",
    "create",
    "make",
    "can you",
    "could you",
    "would you",
    "你",
    "适合我的",
    "適合我的",
    "适合我",
    "適合我",
    "个",
    "個",
    "项",
    "項",
    "条",
    "條",
)
TOPIC_SIGNAL_ALIASES: dict[str, tuple[str, ...]] = {
    "learn_language_milestones": (
        "发声",
        "轮流发声",
        "音节",
        "重复音节",
        "模仿音节",
        "学他发音",
        "学她发音",
        "咿呀",
        "语音理解",
        "模仿声音",
        "声音回应",
        "回应名字",
        "名字反应",
        "叫他或她时会回应",
        "叫他时会回应",
        "叫她时会回应",
        "听到名字会回应",
        "短句回应",
    ),
    "learn_serve_and_return": (
        "轮流互动",
        "轮流回应",
        "跟随孩子",
        "陪孩子",
        "陪娃",
        "陪他的时间",
        "陪她的时间",
        "陪孩子的时间",
        "陪宝宝的时间",
        "陪娃的时间",
        "陪伴时间",
        "没空陪孩子",
        "没空陪他",
        "没空陪她",
        "很少陪孩子",
        "很少陪他",
        "很少陪她",
        "主要是妈妈在照顾",
        "主要是妈妈再照顾",
        "主要是爸爸在照顾",
        "主要是爸爸再照顾",
        "主要由妈妈照顾",
        "主要由爸爸照顾",
    ),
}
_PRODUCT_META_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:为什么|为何|为啥|怎么|怎么会|还是|又|一直|现在|这里|这个地方)?"
        r"[^，。！？,;!?\n]{0,10}(?:没有|没|未|不显示|看不到|找不到|没收到)"
        r"[^，。！？,;!?\n]{0,16}(?:任[务務]卡(?:片)?|推送卡片|推荐卡片|推薦卡片)",
        r"(?:任[务務]卡(?:片)?|推送卡片|推荐卡片|推薦卡片)"
        r"[^，。！？,;!?\n]{0,16}(?:在哪|在哪里|不见|不見|没有|沒有|没了|沒了|"
        r"不显示|不顯示|看不到|找不到|没生成|沒生成|未生成)",
        r"(?:系统|系統|页面|頁面|首页|首頁|应用|應用|app|nuri|你)"
        r"[^，。！？,;!?\n]{0,16}(?:没有|沒有|没|沒|未|不)"
        r"[^，。！？,;!?\n]{0,12}(?:生成|显示|顯示|给|給)"
        r"[^，。！？,;!?\n]{0,8}(?:任[务務]卡(?:片)?|推荐卡片|推薦卡片)",
        r"\b(?:why|where|how come)\b[^.?!\n]{0,32}"
        r"\b(?:task cards?|recommendation cards?)\b|"
        r"\b(?:task cards?|recommendation cards?)\b[^.?!\n]{0,24}"
        r"\b(?:missing|not showing|not generated|gone)\b",
    )
)
_RECOMMENDATION_FEEDBACK_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:(?:这个|這個|这条|這條|这些|這些)\s*)?"
        r"(?:这段内容|這段內容|这段推荐|這段推薦|推荐(?:卡片|内容)?|"
        r"推薦(?:卡片|內容)?|推送(?:卡片|内容|內容)?|"
        r"卡片|你给的(?:推荐|内容|卡片)|你給的(?:推薦|內容|卡片))"
        r"[^，。！？,;!?\n]{0,24}(?:不相关|不相關|无关|無關|不准确|不準確|"
        r"不够准确|不夠準確|不合适|不合適|不适合|不適合|"
        r"关系不大|關係不大|不是我想要的)",
        r"(?:不相关|不相關|无关|無關|不准确|不準確|不够准确|不夠準確)"
        r"[^，。！？,;!?\n]{0,16}(?:推荐|推薦|推送|内容|內容|卡片|对话|對話)",
        r"\b(?:this|these|the|your)?\s*"
        r"(?:recommendations?|suggestions?|recommended\s+content|suggested\s+content|"
        r"content|cards?)\b[^.?!\n]{0,32}"
        r"\b(?:irrelevant|not\s+relevant|inaccurate|not\s+accurate|"
        r"unsuitable|not\s+suitable)\b",
        r"\b(?:irrelevant|not\s+relevant|inaccurate|not\s+accurate|"
        r"unsuitable|not\s+suitable)\b[^.?!\n]{0,32}"
        r"\b(?:recommendations?|suggestions?|content|cards?)\b",
    )
)
_CONVERSATION_META_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:我们|我們).{0,8}(?:讨论过|討論過|聊过|聊過).{0,8}(?:什么|什麼)",
        r"你.{0,8}(?:记得|記得).{0,8}(?:什么|什麼)",
        r"你.{0,8}(?:认为|認為|觉得|覺得)我.{0,12}(?:什么样|什麼樣).{0,8}(?:父亲|父親|爸爸|母亲|母親|妈妈|媽媽)",
        r"\bwhat\s+(?:have|did)\s+we\s+(?:discuss(?:ed)?|talk(?:ed)?\s+about)\b",
        r"\bwhat\s+do\s+you\s+remember\s+about\s+me\b",
        r"\bwhat\s+kind\s+of\s+(?:father|mother|parent)\s+do\s+you\s+think\s+i\s+am\b",
    )
)
_GENERIC_CONTEXT_REQUEST_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"你?.{0,6}(?:认为|認為|觉得|覺得)?我(?:现在|現在)?"
        r".{0,6}最需要.{0,8}(?:什么样|什麼樣|什么|什麼)?"
        r".{0,6}(?:引导|引導|帮助|幫助|建议|建議|支持)",
        r"(?:结合|結合|根据|根據).{0,12}(?:我的情况|我的情況|我们的对话|我們的對話)"
        r".{0,12}(?:给我|給我|推荐|推薦|建议|建議)",
    )
)
_CONTEXT_CORRECTION_ONLY_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"^我?(?:并|並)?(?:没有|沒有|没|沒|不是|并不是|並不是|不觉得|不覺得|不认为|不認為)"
        r".{0,12}(?:愧疚|内疚|內疚|自责|自責|后悔|後悔|焦虑|焦慮)[啊呀吧呢]?$",
    )
)
_NON_PARENTING_TOPIC_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?:只|只是|仅仅|僅僅).{0,10}(?:创业|創業|公司|工作|生意)"
        r".{0,12}(?:没有|沒有|没|沒|未|不).{0,8}(?:谈|談|聊|说|說|涉及)"
        r".{0,6}(?:孩子|宝宝|寶寶|育儿|育兒)",
        r"(?:创业|創業|公司|工作|生意).{0,12}(?:和|与|與)"
        r".{0,6}(?:孩子|宝宝|寶寶|育儿|育兒).{0,6}(?:无关|無關|没关系|沒關係)",
        r"(?:这次|這次|这里|這裡|当前|當前)?\s*"
        r"(?:没有|沒有|没|沒|未|不在|不是在)"
        r".{0,4}(?:谈|談|聊|说|說|讨论|討論|涉及)"
        r".{0,10}(?:孩子|宝宝|寶寶|育儿|育兒|陪伴|亲子|親子)",
    )
)
_PARENTING_CONTEXT_TERMS = (
    "孩子",
    "宝宝",
    "寶寶",
    "宝贝",
    "寶貝",
    "育儿",
    "育兒",
    "亲子",
    "親子",
    "陪伴",
    "陪他",
    "陪她",
    "照顾他",
    "照顧他",
    "照顾她",
    "照顧她",
    "儿子",
    "兒子",
    "女儿",
    "女兒",
)
_DYNAMIC_PARENTING_DOMAIN_TERMS = (
    "child",
    "children",
    "baby",
    "parent",
    "family",
    "caregiver",
    "father",
    "mother",
    "dad",
    "mom",
    "school",
    "preschool",
    "daycare",
    "父亲",
    "父親",
    "母亲",
    "母親",
    "爸爸",
    "妈妈",
    "媽媽",
    "家长",
    "家長",
    "家庭",
    "照顾者",
    "照顧者",
    "蒙特梭利",
    "montessori",
    "森林学校",
    "森林學校",
    "forest school",
    "幼儿园",
    "幼兒園",
    "托育",
    "早教",
    "学校",
    "學校",
    "堂兄",
    "堂姐",
    "亲属",
    "親屬",
    "霸凌",
    "移居",
)
_CONTEXT_REJECTION_MARKERS = (
    "不想继续",
    "不要继续",
    "别再",
    "不再聊",
    "换个话题",
    "换一个话题",
    "另一个话题",
    "别聊",
    "不想聊",
    "stop talking",
    "don't continue",
    "do not continue",
    "change the subject",
    "different topic",
    "move on",
)
_ACKNOWLEDGEMENT_ONLY = frozenset(
    {"谢谢", "谢谢你", "好的", "好", "明白了", "知道了", "收到", "ok", "okay", "thanks", "thank you"}
)
def _is_acknowledgement_only(text: str) -> bool:
    """Recognize one or more acknowledgement phrases with no real topic."""

    normalized = re.sub(r"[\s，。！？,.!?]+", "", text.casefold())
    if not normalized:
        return True
    tokens = sorted(
        {
            re.sub(r"[\s，。！？,.!?]+", "", value.casefold())
            for value in _ACKNOWLEDGEMENT_ONLY
        },
        key=len,
        reverse=True,
    )
    residue = normalized
    for token in tokens:
        residue = residue.replace(token, "")
    return not residue


def is_product_meta_request(text: str) -> bool:
    """Exclude feedback about NURI's UI/cards from parenting-topic ranking."""

    normalized = " ".join((text or "").strip().split())
    return bool(normalized) and any(
        pattern.search(normalized) for pattern in _PRODUCT_META_PATTERNS
    )


def is_recommendation_feedback(text: str) -> bool:
    normalized = " ".join((text or "").strip().split())
    return bool(normalized) and any(
        pattern.search(normalized) for pattern in _RECOMMENDATION_FEEDBACK_PATTERNS
    )


def is_conversation_meta_request(text: str) -> bool:
    normalized = " ".join((text or "").strip().split())
    return bool(normalized) and any(
        pattern.search(normalized) for pattern in _CONVERSATION_META_PATTERNS
    )


def _is_context_correction_only(text: str) -> bool:
    normalized = " ".join((text or "").strip().split()).strip("，。！？,.!?；;：:")
    return bool(normalized) and any(
        pattern.fullmatch(normalized)
        for pattern in _CONTEXT_CORRECTION_ONLY_PATTERNS
    )


def _is_explicitly_non_parenting_topic(text: str) -> bool:
    normalized = " ".join((text or "").strip().split())
    return bool(normalized) and any(
        pattern.search(normalized) for pattern in _NON_PARENTING_TOPIC_PATTERNS
    )


def is_generic_context_request(text: str) -> bool:
    normalized = " ".join((text or "").strip().split()).strip(
        "，。！？,.!?；;：:"
    )
    if is_action_only_request(normalized):
        return True
    return bool(normalized) and any(
        pattern.fullmatch(normalized) for pattern in _GENERIC_CONTEXT_REQUEST_PATTERNS
    )


def clean_parenting_signal(text: str) -> str:
    """Remove product/conversation feedback clauses, preserving family facts."""

    normalized = " ".join((text or "").strip().split())
    if not normalized:
        return ""
    clauses = re.split(
        r"(?:[，,。！？!?；;]+|但是|但|不过|不過|其实|其實|然而)",
        normalized,
    )
    kept: list[str] = []
    for raw_clause in clauses:
        clause = raw_clause.strip(" \t\r\n，。！？,.!?；;：:")
        if not clause:
            continue
        if (
            is_product_meta_request(clause)
            or is_recommendation_feedback(clause)
            or is_conversation_meta_request(clause)
            or _is_context_correction_only(clause)
            or _is_explicitly_non_parenting_topic(clause)
        ):
            continue
        kept.append(clause)
    return "，".join(kept)


def _current_action_intent(text: str) -> Optional[str]:
    casefolded = text.casefold()
    return next(
        (label for marker, label in _ACTION_REQUEST_LABELS if marker in casefolded),
        None,
    )


def recommendation_intent_code(text: str) -> str:
    casefolded = text.casefold()
    if _current_action_intent(casefolded):
        return "action_plan"
    if any(marker in casefolded for marker in ("比较", "对比", "区别", "怎么选", "选择", " vs ", " versus ")):
        return "compare"
    if any(
        marker in casefolded
        for marker in (
            "我很累",
            "我撑不住",
            "我快崩溃",
            "我很焦虑",
            "安慰我",
            "陪陪我",
            "support me",
        )
    ):
        return "support"
    return "learn"


def is_action_only_request(text: str) -> bool:
    """Detect generic requests such as “给我一些任务吧” without a topic."""

    if not _current_action_intent(text):
        return False
    residue = text.casefold()
    for marker, _label in _ACTION_REQUEST_LABELS:
        if re.fullmatch(r"[a-z][a-z ]*", marker):
            suffix = "s?" if marker == "task" else ""
            residue = re.sub(
                rf"(?<![a-z0-9]){re.escape(marker)}{suffix}(?![a-z0-9])",
                " ",
                residue,
            )
        else:
            residue = residue.replace(marker, "")
    for filler in _ACTION_ONLY_FILLERS:
        if re.fullmatch(r"[a-z][a-z ]*", filler):
            residue = re.sub(
                rf"(?<![a-z0-9]){re.escape(filler)}(?![a-z0-9])",
                " ",
                residue,
            )
        else:
            residue = residue.replace(filler, "")
    residue = re.sub(r"(?:\d+|[一二两兩三四五六七八九十百几幾]+)", "", residue)
    residue = re.sub(r"[^a-z0-9\u3400-\u9fff]+", "", residue)
    return not residue


def _conversation_goal_signal(messages: list[dict]) -> tuple[str, str]:
    """Return the nearest concrete user goal and whether it is cross-session."""

    user_messages = [
        message
        for message in messages
        if message.get("role") == "user" and str(message.get("text") or "").strip()
    ]
    current_messages = [
        message
        for message in user_messages
        if message.get("context_scope") != "account_history"
    ]
    history_messages = [
        message
        for message in user_messages
        if message.get("context_scope") == "account_history"
    ]
    for scope, candidates in (
        ("current_session", current_messages),
        ("account_history", history_messages),
    ):
        for message in reversed(candidates):
            raw_text = str(message.get("text") or "").strip()
            text = clean_parenting_signal(raw_text)
            if (
                _is_acknowledgement_only(text)
                or is_generic_context_request(raw_text)
                or not text
            ):
                continue
            return text, scope
    latest = clean_parenting_signal(
        str((current_messages or history_messages or [{}])[-1].get("text") or "")
    )
    return latest, "current_session" if current_messages else "account_history"


def _conversation_topic_excerpt(messages: list[dict], limit: int = 84) -> str:
    """Return a short, redacted description of the latest real user topic."""

    latest, _scope = _conversation_goal_signal(messages)
    topic = " ".join(redact_conversation_text(latest, 240).split())
    topic = topic.strip(" \t\r\n，。！？,.!?；;：:")
    if len(topic) > limit:
        topic = f"{topic[: limit - 1].rstrip()}…"
    return topic


def _has_parenting_domain_signal(topic: str) -> bool:
    normalized = " ".join((topic or "").casefold().split())
    if not normalized:
        return False
    if _matched_terms(
        normalized,
        [*_PARENTING_CONTEXT_TERMS, *_DYNAMIC_PARENTING_DOMAIN_TERMS],
    ):
        return True
    for card in LEARNING_CONTENT_CARDS:
        terms = [
            *card.get("match_terms", []),
            *TOPIC_SIGNAL_ALIASES.get(str(card.get("id") or ""), ()),
        ]
        if _matched_terms(normalized, terms):
            return True
    return False


def _is_dynamic_topic_candidate(topic: str) -> bool:
    if _is_acknowledgement_only(topic):
        return False
    if is_generic_context_request(topic):
        return False
    if (
        is_product_meta_request(topic)
        or is_recommendation_feedback(topic)
        or is_conversation_meta_request(topic)
        or _is_explicitly_non_parenting_topic(topic)
    ):
        return False
    if not _has_parenting_domain_signal(topic):
        return False
    # “换个话题” alone contains no topic to research.  Once the user names a
    # concrete new subject, the longer message remains eligible.
    if len(topic) <= 60 and any(
        marker in topic.casefold() for marker in _CONTEXT_REJECTION_MARKERS
    ):
        return False
    return True


def _dynamic_research_card_id(
    *,
    session_id: Optional[str],
    topic: str,
) -> str:
    """Build an addressable ID without placing conversation text in the URL.

    Identity is the topic, not the moment. This used to hash
    `context_created_at` — the timestamp of the last message — which meant the
    card was a different card after every turn, including after "谢谢". The
    research cache keys on the card id, so a mechanically rotating id made the
    most expensive call in the system incapable of ever hitting it.

    The topic excerpt still moves when the parent genuinely asks something new,
    and a new id is right then: that is a different subject deserving different
    content. What is gone is the churn that had nothing to do with the subject.
    """

    normalized_topic = " ".join(topic.casefold().split())
    material = "\n".join((session_id or "no-session", normalized_topic))
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:20]
    return f"{DYNAMIC_RESEARCH_CARD_PREFIX}{digest}"


def _build_dynamic_research_card(
    messages: list[dict],
    *,
    session_id: Optional[str],
    context_created_at: Optional[str],
    include_detail: bool,
) -> Optional[dict]:
    """Create a transient card for a real topic outside the reviewed library.

    A dynamic card deliberately has no static resources.  Presenting a sleep,
    emotion or development bundle under an unrelated topic (for example,
    Montessori school choice) is more misleading than showing a bounded
    research state.  The research endpoint only publishes a complete verified
    six-to-nine item bundle; the frontend hides category shelves until that
    quality threshold is met.
    """

    topic = _conversation_topic_excerpt(messages)
    if not _is_dynamic_topic_candidate(topic):
        return None
    card_id = _dynamic_research_card_id(session_id=session_id, topic=topic)
    latest_current_user_text = next(
        (
            str(message.get("text") or "")
            for message in reversed(messages)
            if message.get("role") == "user"
            and message.get("context_scope") != "account_history"
        ),
        topic,
    )
    intent_source = (
        topic
        if (
            is_product_meta_request(latest_current_user_text)
            or is_recommendation_feedback(latest_current_user_text)
            or is_conversation_meta_request(latest_current_user_text)
            or _is_context_correction_only(latest_current_user_text)
        )
        else latest_current_user_text
    )
    card = {
        "id": card_id,
        "topic": topic,
        "topic_label": topic,
        "type": "tip",
        "type_label": "对话精选",
        "cta": "为这次对话检索内容",
        "publisher": "NURI 个性化内容研究",
        "title": f"继续了解：{topic}",
        "summary": (
            "NURI 会依据这次对话，分别核验权威内容、精彩解读和真实家庭案例。"
        ),
        "personalization_reason": f"因为你最近和 NURI 聊到“{topic}”",
        "is_conversation_match": True,
        "is_dynamic_research_card": True,
        "related_session_id": session_id,
        "context_created_at": context_created_at,
        "recommendation_focus": topic,
        "recommendation_intent": recommendation_intent_code(intent_source),
        "recommendation_score": CONVERSATION_MATCH_MIN_SCORE,
    }
    if include_detail:
        card.update(
            {
                "body": (
                    "这是根据你刚刚提出的具体问题建立的学习主题。完成外部检索后，"
                    "这里只会展示六至九项通过来源、语言和内容核验的结果：三个类别，"
                    "每类至少一篇文章和一个视频；第三项只有同样可靠时才会加入。"
                ),
                "hook_line": "让 NURI 围绕这次真实对话继续筛选。",
                "tags": ["#对话相关", "#个性化检索"],
                "resources": [],
            }
        )
    return card


def restore_dynamic_research_card_from_snapshot(
    snapshot: dict,
    *,
    include_detail: bool,
) -> Optional[dict]:
    """Rebuild a novel-topic card when its goal came from account history.

    A detail request deliberately reloads only the bound main session.  For a
    generic current follow-up such as “给我任务”, that session may not contain
    the concrete cross-session topic that originally created the dynamic card.
    The snapshot keeps only the bounded, redacted focus required to restore it.
    """

    focus = str(snapshot.get("recommendation_focus") or "").strip()
    if not focus:
        return None
    card = _build_dynamic_research_card(
        [
            {
                "role": "user",
                "text": focus,
                "context_scope": "current_session",
            }
        ],
        session_id=snapshot.get("session_id"),
        context_created_at=snapshot.get("context_created_at"),
        include_detail=include_detail,
    )
    if card:
        card["id"] = snapshot["card_id"]
    return card


def _term_occurrences(text: str, term: str) -> list[tuple[int, int]]:
    """Find complete English terms and literal CJK phrases."""

    if not text or not term:
        return []
    normalized_term = term.casefold()
    if re.fullmatch(r"[a-z0-9][a-z0-9 '\-]*", normalized_term):
        pattern = re.compile(
            rf"(?<![a-z0-9]){re.escape(normalized_term)}(?![a-z0-9])",
            re.IGNORECASE,
        )
        return [(match.start(), match.end()) for match in pattern.finditer(text)]

    positions: list[tuple[int, int]] = []
    start = 0
    while True:
        index = text.find(normalized_term, start)
        if index < 0:
            break
        positions.append((index, index + len(normalized_term)))
        start = index + max(1, len(normalized_term))
    return positions


def _term_is_present(text: str, term: str) -> bool:
    """Return True when at least one occurrence is not locally negated."""

    for start, end in _term_occurrences(text, term):
        clause_start = 0
        clause_end = len(text)
        for boundary in _TOPIC_CLAUSE_BOUNDARIES:
            previous = text.rfind(boundary, 0, start)
            if previous >= 0:
                clause_start = max(clause_start, previous + len(boundary))
            following = text.find(boundary, end)
            if following >= 0:
                clause_end = min(clause_end, following)
        clause = text[clause_start:clause_end]
        if not any(marker in clause for marker in _NEGATION_MARKERS):
            return True
    return False


def _matched_terms(text: str, terms: list[object]) -> list[str]:
    """Return specific, non-overlapping topic signals found in ``text``."""

    matches = {
        str(raw_term).casefold()
        for raw_term in terms
        if str(raw_term).strip() and _term_is_present(text, str(raw_term).casefold())
    }
    ordered = sorted(matches, key=lambda value: (-len(value), value))
    selected: list[str] = []
    for term in ordered:
        if any(term in more_specific for more_specific in selected):
            continue
        selected.append(term)
    return selected


def _signal_score(matches: list[str], strong_base: int, weak_base: int, bonus_cap: int) -> int:
    if not matches:
        return 0
    has_strong_signal = any(term not in _WEAK_MATCH_TERMS for term in matches)
    base = strong_base if has_strong_signal else weak_base
    return base + min(bonus_cap, max(0, len(matches) - 1))


def _is_context_follow_up(text: str) -> bool:
    casefolded = text.casefold()
    if _is_acknowledgement_only(text):
        return False
    if any(marker in casefolded for marker in _CONTEXT_REJECTION_MARKERS):
        return False
    return any(marker in casefolded for marker in _FOLLOW_UP_MARKERS)


def _conversation_focus_for_terms(
    messages: list[dict], terms: list[object]
) -> tuple[str, str]:
    """Return the closest substantive user statement matching one card."""

    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        raw_text = str(message.get("text") or "").strip()
        text = clean_parenting_signal(raw_text)
        if (
            not text
            or _is_acknowledgement_only(text)
            or is_generic_context_request(raw_text)
        ):
            continue
        if _matched_terms(text.casefold(), terms):
            scope = (
                "account_history"
                if message.get("context_scope") == "account_history"
                else "current_session"
            )
            return text, scope
    return "", "current_session"


def rank_learning_content(
    messages: list[dict],
    count: int = 4,
    session_id: Optional[str] = None,
    context_created_at: Optional[str] = None,
    context_state: str = "ready",
    include_detail: bool = False,
    behavior_events: Optional[list[dict]] = None,
) -> tuple[list[dict], bool]:
    """Rank candidates by conversation relevance, affinity, and freshness."""

    raw_current_user_texts = [
        str(message.get("text") or "").strip()
        for message in messages
        if message.get("role") == "user" and str(message.get("text") or "").strip()
        and message.get("context_scope") != "account_history"
    ]
    raw_historical_user_texts = [
        str(message.get("text") or "").strip()
        for message in messages
        if message.get("role") == "user" and str(message.get("text") or "").strip()
        and message.get("context_scope") == "account_history"
    ]
    current_user_texts = [
        cleaned
        for text in raw_current_user_texts
        if (cleaned := clean_parenting_signal(text))
    ]
    historical_user_texts = [
        cleaned
        for text in raw_historical_user_texts
        if (cleaned := clean_parenting_signal(text))
    ]
    user_texts = [*historical_user_texts, *current_user_texts]
    raw_last_user_text = raw_current_user_texts[-1] if raw_current_user_texts else ""
    cleaned_last_user_text = clean_parenting_signal(raw_last_user_text)
    latest_meta_feedback = bool(raw_last_user_text) and (
        is_product_meta_request(raw_last_user_text)
        or is_recommendation_feedback(raw_last_user_text)
        or is_conversation_meta_request(raw_last_user_text)
        or _is_context_correction_only(raw_last_user_text)
    )
    latest_meta_only = latest_meta_feedback and not cleaned_last_user_text
    generic_context_request = is_generic_context_request(raw_last_user_text)
    topical_current_user_texts = [
        cleaned
        for raw_text in raw_current_user_texts
        if (cleaned := clean_parenting_signal(raw_text))
        and not _is_acknowledgement_only(cleaned)
        and not is_generic_context_request(raw_text)
    ]
    # Partition only substantive family statements.  Generic task/guidance
    # requests, corrections and product feedback therefore do not consume the
    # four-message topical window in a long-running main conversation.
    last_user_text = (
        topical_current_user_texts[-1].casefold()
        if topical_current_user_texts
        else ""
    )
    previous_user_text = " ".join(topical_current_user_texts[-4:-1]).casefold()
    older_user_text = " ".join(topical_current_user_texts[:-4]).casefold()
    substantive_history_texts = [
        cleaned
        for raw_text in raw_historical_user_texts
        if (cleaned := clean_parenting_signal(raw_text))
        and not _is_acknowledgement_only(cleaned)
        and not is_generic_context_request(raw_text)
    ]
    latest_history_text = (
        substantive_history_texts[-1].casefold()
        if substantive_history_texts
        else ""
    )
    older_history_text = " ".join(substantive_history_texts[:-1]).casefold()
    allow_assistant_context = (
        not latest_meta_only and _is_context_follow_up(raw_last_user_text)
    )
    action_intent = (
        None if latest_meta_only else _current_action_intent(raw_last_user_text)
    )
    action_only_request = is_action_only_request(raw_last_user_text)
    inherit_prior_context = generic_context_request or latest_meta_only
    goal_text, goal_scope = _conversation_goal_signal(messages)
    safe_goal = " ".join(redact_conversation_text(goal_text, 160).split())
    if len(safe_goal) > 48:
        safe_goal = f"{safe_goal[:47].rstrip()}…"

    last_user_index = max(
        (
            index
            for index, message in enumerate(messages)
            if message.get("role") == "user"
            and message.get("context_scope") != "account_history"
        ),
        default=-1,
    )
    assistants_after_user = [
        str(message.get("text") or "").strip()
        for message in messages[last_user_index + 1 :]
        if message.get("role") in {"ai", "assistant"}
        and str(message.get("text") or "").strip()
    ]
    assistants_before_user = [
        str(message.get("text") or "").strip()
        for message in messages[:last_user_index]
        if message.get("role") in {"ai", "assistant"}
        and str(message.get("text") or "").strip()
    ]
    if latest_meta_only:
        assistant_context_text = ""
    elif assistants_after_user:
        assistant_context_text = assistants_after_user[-1].casefold()
    elif allow_assistant_context and assistants_before_user:
        # A short follow-up such as “给我几个任务” legitimately refers to the
        # immediately preceding NURI answer.  Explicit topic switches do not.
        assistant_context_text = assistants_before_user[-1].casefold()
    else:
        assistant_context_text = ""

    ranked: list[
        tuple[int, int, int, int, dict, Optional[str], str, str, dict]
    ] = []
    for index, card in enumerate(LEARNING_CONTENT_CARDS):
        terms = [
            *card.get("match_terms", []),
            *TOPIC_SIGNAL_ALIASES.get(str(card.get("id") or ""), ()),
        ]
        latest_matches = _matched_terms(last_user_text, terms)
        recent_matches = _matched_terms(previous_user_text, terms)
        older_matches = _matched_terms(older_user_text, terms)
        latest_history_matches = _matched_terms(latest_history_text, terms)
        older_history_matches = _matched_terms(older_history_text, terms)
        assistant_matches = _matched_terms(assistant_context_text, terms)

        latest_score = _signal_score(latest_matches, 14, 5, 3)
        recent_score = _signal_score(recent_matches, 10, 3, 3)
        # Older statements provide continuity, but cannot outweigh a concrete
        # need the parent expressed more recently.  This matters in one long
        # main chat where a topic may have been repeated many times before the
        # user's situation changed (for example, a busy parent asking for
        # short, high-quality ways to connect after discussing milestones).
        older_matching_message_count = sum(
            1
            for text in topical_current_user_texts[:-4]
            if _matched_terms(text.casefold(), terms)
        )
        # One old mention stays below the personalization threshold.  A topic
        # the parent returned to several times remains eligible as a secondary
        # card even when a newer concern becomes Top-1.  This preserves durable
        # themes such as repeated questions about a child's key developmental
        # window without letting one stale aside outrank the current need.
        older_repeat_bonus = min(4, max(0, older_matching_message_count - 1))
        older_score = (
            _signal_score(older_matches, 5, 1, 1) + older_repeat_bonus
        )
        # Cross-session history is continuity, not the present request.  It can
        # resolve a generic “give me a task” follow-up, but otherwise remains a
        # weak preference signal and cannot establish a personalized match.
        history_score = _signal_score(
            latest_history_matches,
            8 if inherit_prior_context and not recent_matches else 3,
            2 if inherit_prior_context and not recent_matches else 1,
            2,
        )
        history_score += _signal_score(older_history_matches, 1, 0, 1)
        user_signal_score = latest_score + recent_score + older_score + history_score
        assistant_score = 0
        if assistant_context_text and (latest_matches or recent_matches or history_score):
            # Assistant text may clarify a user-established goal, never create
            # one.  This prevents a broad AI aside such as “精细动作” from
            # outranking the parent's explicit language-interaction concern.
            assistant_score = _signal_score(assistant_matches, 3, 1, 1)
        conversation_score = user_signal_score + assistant_score
        behavior = recommendation_feedback.card_behavior_signal(
            str(card.get("id") or ""),
            behavior_events or [],
        )
        score = conversation_score + int(behavior.get("score") or 0)

        reason_term = next(
            (
                candidate
                for candidates in (
                    latest_matches,
                    recent_matches,
                    latest_history_matches,
                    assistant_matches,
                )
                for candidate in candidates
                if candidate not in _WEAK_MATCH_TERMS
            ),
            None,
        )
        focus_text, focus_scope = _conversation_focus_for_terms(messages, terms)
        ranked.append(
            (
                score,
                conversation_score,
                user_signal_score,
                index,
                card,
                reason_term,
                focus_text,
                focus_scope,
                behavior,
            )
        )

    def _eligible_match(item: tuple) -> bool:
        return bool(
            item[1] >= CONVERSATION_MATCH_MIN_SCORE
            and item[2] >= CONVERSATION_MATCH_MIN_SCORE
            and not item[8].get("explicit_negative")
        )

    # A prior click must never manufacture relevance for an unrelated current
    # conversation. Eligible conversation candidates come first; behaviour and
    # freshness only reorder candidates inside that pool.
    ranked.sort(
        key=lambda item: (
            not _eligible_match(item),
            -item[0],
            -item[1],
            item[3],
        )
    )
    has_conversation_match = bool(
        raw_current_user_texts
        and ranked
        and any(_eligible_match(item) for item in ranked)
    )
    has_explicitly_rejected_match = bool(
        raw_current_user_texts
        and any(
            item[1] >= CONVERSATION_MATCH_MIN_SCORE
            and item[2] >= CONVERSATION_MATCH_MIN_SCORE
            and item[8].get("explicit_negative")
            for item in ranked
        )
    )
    selected: list[dict] = []
    for (
        score,
        conversation_score,
        user_signal_score,
        _,
        card,
        reason_term,
        focus_text,
        focus_scope,
        behavior,
    ) in ranked[
        : max(1, min(count, len(LEARNING_CONTENT_CARDS)))
    ]:
        safe_focus = " ".join(redact_conversation_text(focus_text, 160).split())
        if len(safe_focus) > 48:
            safe_focus = f"{safe_focus[:47].rstrip()}…"
        if not safe_focus:
            safe_focus = safe_goal
        if (
            conversation_score >= CONVERSATION_MATCH_MIN_SCORE
            and user_signal_score >= CONVERSATION_MATCH_MIN_SCORE
            and has_conversation_match
            and not behavior.get("explicit_negative")
        ):
            if latest_meta_only and safe_focus:
                continuity = (
                    "结合你最近其他对话里提到的"
                    if focus_scope == "account_history"
                    else "延续你之前提到的"
                )
                reason = (
                    f"{continuity}“{safe_focus}”，"
                    f"这篇内容与“{card['topic_label']}”直接相关"
                )
            elif action_intent and safe_focus:
                continuity = "结合你最近其他对话里提到的" if focus_scope == "account_history" else "延续你提到的"
                reason = (
                    f"你现在想要{action_intent}，{continuity}“{safe_focus}”；"
                    f"这篇内容与“{card['topic_label']}”直接相关"
                )
            elif inherit_prior_context and safe_focus:
                continuity = "结合你最近其他对话里提到的" if focus_scope == "account_history" else "延续你之前提到的"
                reason = (
                    f"{continuity}“{safe_focus}”，"
                    f"这篇内容与“{card['topic_label']}”直接相关"
                )
            elif reason_term:
                reason = (
                    f"因为你最近重点聊到“{reason_term}”，"
                    f"这篇内容与“{card['topic_label']}”直接相关"
                )
            else:
                reason = f"因为你最近和 NURI 聊到了“{card['topic_label']}”"
            related_session_id = session_id
            is_match = True
        elif context_state == "privacy_off":
            reason = "你已关闭对话个性化，这是 NURI 的可信来源精选"
            related_session_id = None
            is_match = False
        elif context_state == "unavailable":
            reason = "近期对话暂时无法读取，这是 NURI 的可信来源精选"
            related_session_id = None
            is_match = False
        elif not user_texts:
            reason = "还没有足够的近期对话，这是 NURI 的可信来源精选"
            related_session_id = None
            is_match = False
        else:
            reason = "NURI 从可信育儿来源中为你补充精选"
            related_session_id = None
            is_match = False

        hidden_fields = {"match_terms"}
        if not include_detail:
            hidden_fields.update({"body", "hook_line", "resources", "tags"})
        public_card = {key: value for key, value in card.items() if key not in hidden_fields}
        public_card.update(
            {
                "personalization_reason": reason,
                "is_conversation_match": is_match,
                "related_session_id": related_session_id,
            }
        )
        if is_match:
            public_card.update(
                {
                    "recommendation_focus": safe_focus or reason_term or card["topic_label"],
                    "recommendation_intent": recommendation_intent_code(
                        raw_last_user_text
                        if action_intent
                        else (safe_focus or goal_text)
                    ),
                    "recommendation_score": score,
                    "reason_codes": [
                        "recent_conversation",
                        *(
                            ["learned_preference"]
                            if int(behavior.get("affinity") or 0) > 0
                            else []
                        ),
                        *(
                            ["freshness_adjusted"]
                            if int(behavior.get("freshness_penalty") or 0) < 0
                            else []
                        ),
                    ],
                }
            )
        selected.append(public_card)

    if (
        not has_conversation_match
        and not has_explicitly_rejected_match
        and context_state == "ready"
        and raw_current_user_texts
    ):
        dynamic_card = _build_dynamic_research_card(
            messages,
            session_id=session_id,
            context_created_at=context_created_at,
            include_detail=include_detail,
        )
        if dynamic_card:
            selected = [dynamic_card, *selected[: max(0, count - 1)]]
            has_conversation_match = True
    return selected, has_conversation_match
