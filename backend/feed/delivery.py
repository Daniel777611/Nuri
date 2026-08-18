"""Turning ranked content into cards a parent can be shown.

The delivery contract: pairing each category with sources that satisfy it,
honouring the requested locale, gating on publisher authority and reader
experience, deciding when a package is ready versus still preparing, and
decorating the card that results.

Imports `signals` for the conversation read; nothing here goes back the other
way. Reads and writes recommendation snapshots through `stores`, and logs
engagement through the outcome subsystem — both one-directional, which is what
the store/delivery inversion in the previous commit bought.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse

import anyio
from fastapi import HTTPException

from backend import (
    content_research,
    llm_usage,
    locales,
    memstore,
    recommendation_feedback,
    runtime,
    stores,
)
from backend.runtime import OPENAI_CONTENT_RESEARCH_MODEL, content_research_limiter
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
from backend.feed import signals


CATEGORY_CARD_META = {
    "authority": {
        "label": "权威来源",
        "eyebrow": "事实与安全底线",
        "description": "来自政府、大学、医院、医学组织或专业期刊。",
        "fallback_title": "权威机构如何看“{topic_label}”",
        "fallback_publisher": "NURI 权威来源筛选",
    },
    "featured": {
        "label": "精选内容",
        "eyebrow": "清楚、实用、值得看",
        "description": "专业可靠、讲解精彩，也适合家庭直接使用。",
        "fallback_title": "围绕“{topic_label}”的实用方法精选",
        "fallback_publisher": "NURI 编辑精选",
    },
    "case": {
        "label": "真实案例",
        "eyebrow": "其他家庭的真实实践",
        "description": "用具体家庭经历呈现过程、调整与可借鉴做法。",
        "fallback_title": "其他家庭如何面对“{topic_label}”",
        "fallback_publisher": "NURI 真实家庭案例",
    },
}


_DELIVERY_ACTION_STEPS = {
    "authority": [
        "先看与孩子当前阶段对应的观察点",
        "用一周时间记录最常出现的行为和变化",
        "如果持续担心，带着记录咨询儿科或儿童发展专业人员",
    ],
    "featured": [
        "今天选择一个本来就会发生的日常场景",
        "照着内容示范练习五分钟，不额外增加复杂任务",
        "观察孩子的回应，明天只调整一个小地方",
    ],
    "case": [
        "先找出案例与你家处境最相似的一点",
        "只借鉴一个低风险做法试一周",
        "根据孩子反应调整，不把单个家庭经验当作诊断或保证",
    ],
}


def resource_parent_org_id(resource: dict) -> str:
    """Return a stable organization key for package-level diversity."""

    # Never trust an externally supplied ``parent_org_id``. The shared source
    # policy derives identity from registered destination/evidence domains,
    # then reviewed publisher aliases or a deterministic host/creator fallback.
    return policy_resource_parent_org_id(resource)


def _resource_with_delivery_metadata(resource: dict) -> dict:
    """Add bounded presentation metadata without inventing source facts."""

    value = dict(resource)
    value["parent_org_id"] = resource_parent_org_id(value)
    value.setdefault("author", "")
    value.setdefault("updated_at", "")
    if not isinstance(value.get("estimated_minutes"), int):
        value["estimated_minutes"] = 4 if value.get("kind") == "article" else 5
    return value


def _delivery_locale_priority(resource: dict, preferred_locale: Optional[str]) -> int:
    """Rank delivery language without letting an English fallback lead zh-CN.

    A Chinese account first sees an institution's official Chinese edition,
    then an original/allowlisted Chinese destination.  A NURI-guided English
    article remains a last-resort reading fallback.  English-audio video is
    ranked after every Chinese option (and the delivery gate normally rejects
    it entirely), so provider result order can never promote it accidentally.
    """

    if preferred_locale != "zh-CN":
        return 0
    kind = str(resource.get("kind") or "")
    translation_type = str(resource.get("translation_type") or "")
    source_language = str(resource.get("source_language") or "").casefold()
    content_locale = str(resource.get("content_locale") or "").casefold()
    display_locale = str(resource.get("display_locale") or "")
    spoken_language = str(resource.get("spoken_language") or "").casefold()

    # Video language is a hard user-experience boundary: subtitles, a Chinese
    # guide, or a localized title do not turn English audio into Chinese video.
    if kind == "video" and spoken_language not in {
        "mandarin",
        "putonghua",
        "chinese",
        "国语",
        "普通话",
        "华语",
    }:
        return 90
    if translation_type == "official_translation" and display_locale == "zh-CN":
        return 0
    # For a Simplified-Chinese account, verified Mandarin is the actual video
    # language requirement. A Taiwan Mandarin explanation should not be pushed
    # below a lower-quality mainland clip solely because its metadata uses
    # Traditional Chinese; the visible region/script label is still retained.
    if kind == "video" and display_locale == "zh-CN":
        return 1
    if display_locale == "zh-CN" and (
        source_language in {"zh", "zh-cn", "chinese", "mandarin"}
        or content_locale in {"zh", "zh-cn", "chinese", "mandarin"}
    ):
        return 1
    if (
        translation_type == "original"
        and (
            source_language in {"zh-tw", "traditional-chinese"}
            or content_locale in {"zh-tw", "traditional-chinese"}
        )
    ):
        return 5
    if (
        kind == "article"
        and source_language == "en"
        and translation_type == "nuri_guide"
        and display_locale == "zh-CN"
    ):
        return 10
    return 50


def _delivery_resource_sort_key(
    resource: dict,
    preferred_locale: Optional[str],
    content_category: str,
) -> tuple[int, int, int, int]:
    """Sort by language, editorial quality, authority, then freshness."""

    quality_priority = 0
    substance_status = str(
        resource.get("content_substance_status") or ""
    ).casefold()
    readability_status = str(
        resource.get("featured_readability_status") or ""
    ).casefold()
    case_process_status = str(
        resource.get("case_process_status") or ""
    ).casefold()
    case_reader_status = str(
        resource.get("case_reader_experience_status")
        or case_article_reader_experience_status(resource.get("url"))
    ).casefold()
    if str(resource.get("kind") or "") == "video":
        if substance_status in {"ad_like", "rejected"}:
            quality_priority = 90
        elif substance_status != "verified":
            quality_priority = 1
    if content_category == "featured":
        if readability_status == "rejected":
            quality_priority = 90
        elif readability_status != "verified":
            quality_priority = max(quality_priority, 1)
    if content_category == "case":
        if case_process_status in {"promotion_only", "rejected"}:
            quality_priority = 90
        elif case_process_status != "verified":
            quality_priority = max(quality_priority, 1)
        if str(resource.get("kind") or "") == "article":
            if case_reader_status == "rejected":
                quality_priority = 90
            elif case_reader_status != "verified":
                quality_priority = max(quality_priority, 1)

    authority_priority = 0
    if content_category == "authority":
        if is_us_authority_resource(resource):
            authority_priority = 0
        elif resource_parent_org_id(resource) in ENGLISH_AUTHORITY_SOURCE_PARENT_ORG_IDS:
            authority_priority = 1
        else:
            authority_priority = 2
    return (
        _delivery_locale_priority(resource, preferred_locale),
        quality_priority,
        authority_priority,
        0 if resource.get("research_source") == "openai_web_search" else 1,
    )


def delivery_contract_pair(
    resources: list[dict],
    content_category: str,
    preferred_locale: str,
    *,
    require_dynamic: bool = True,
) -> list[dict]:
    """Select one publishable article/video pair that satisfies the lane contract."""

    matching = [
        _resource_with_delivery_metadata(resource)
        for resource in resources
        if str(resource.get("content_category") or "") == content_category
        and not content_research.delivery_lane_rejection_reason(
            resource,
            preferred_locale,
            require_dynamic=require_dynamic,
        )
    ]
    matching.sort(
        key=lambda resource: _delivery_resource_sort_key(
            resource,
            preferred_locale,
            content_category,
        )
    )
    pair: list[dict] = []
    for kind in ("article", "video"):
        resource = next(
            (item for item in matching if item.get("kind") == kind),
            None,
        )
        if resource:
            pair.append(resource)
    return pair


def prepared_snapshot_set_meets_source_contract(snapshots: list[dict]) -> bool:
    """Reject previously prepared packages created under the old source rules."""

    if not snapshots or any(
        snapshot.get("version") != SNAPSHOT_VERSION
        or snapshot.get("context_version") != SNAPSHOT_CONTEXT_VERSION
        or snapshot.get("source_contract_version")
        != DELIVERY_SOURCE_CONTRACT_VERSION
        for snapshot in snapshots
    ):
        return False
    for snapshot in snapshots:
        category = str(snapshot.get("content_category") or "")
        locale = str(snapshot.get("preferred_locale") or "zh-CN")
        pairs = prepared_resource_pairs(snapshot)
        if not pairs:
            return False
        if any(
            len(
                delivery_contract_pair(
                    pair["resources"],
                    category,
                    locale,
                    require_dynamic=False,
                )
            )
            != 2
            for pair in pairs
        ):
            return False
    return True


def delivery_gate_diagnostics(
    resources: list[dict],
    locale: str,
    *,
    require_dynamic: bool = True,
) -> dict:
    reasons: dict[str, int] = {}
    accepted = {category: {"article": 0, "video": 0} for category in CONTENT_CATEGORIES}
    for resource in resources:
        category = str(resource.get("content_category") or "")
        kind = str(resource.get("kind") or "")
        reason = content_research.delivery_lane_rejection_reason(
            resource,
            locale,
            require_dynamic=require_dynamic,
        )
        if reason:
            reasons[reason] = reasons.get(reason, 0) + 1
        elif category in accepted and kind in accepted[category]:
            accepted[category][kind] += 1
    return {"accepted_slots": accepted, "rejection_counts": reasons}


def attach_featured_evidence_anchor(resources: list[dict]) -> list[dict]:
    """Bind every featured item to the vetted authority lane in its package."""

    normalized = [_resource_with_delivery_metadata(resource) for resource in resources]
    authority_article = next(
        (
            resource
            for resource in normalized
            if resource.get("content_category") == "authority"
            and resource.get("kind") == "article"
        ),
        None,
    )
    if not authority_article:
        return normalized
    anchor = {
        "title": str(authority_article.get("title") or "")[:180],
        "publisher": str(authority_article.get("publisher") or "")[:140],
        "url": str(authority_article.get("url") or ""),
        "source_tier": "authority",
    }
    for resource in normalized:
        if resource.get("content_category") == "featured":
            resource["evidence_anchor"] = dict(anchor)
    return normalized


def category_resource_pair_options(
    resources: list[dict],
    content_category: str,
    *,
    excluded_primary_orgs: Optional[set[str]] = None,
    preferred_locale: Optional[str] = None,
    require_dynamic: bool = True,
    max_pairs: int = 3,
) -> list[list[dict]]:
    """Build a primary pair and instant alternatives from a validated pool."""

    matching = [
        _resource_with_delivery_metadata(resource)
        for resource in resources
        if str(resource.get("content_category") or "") == content_category
        and (
            not preferred_locale
            or not content_research.delivery_lane_rejection_reason(
                resource,
                preferred_locale,
                require_dynamic=require_dynamic,
            )
        )
    ]
    articles = [resource for resource in matching if resource.get("kind") == "article"]
    videos = [resource for resource in matching if resource.get("kind") == "video"]
    articles.sort(
        key=lambda resource: _delivery_resource_sort_key(
            resource,
            preferred_locale,
            content_category,
        )
    )
    videos.sort(
        key=lambda resource: _delivery_resource_sort_key(
            resource,
            preferred_locale,
            content_category,
        )
    )
    candidates: list[list[dict]] = []
    seen: set[tuple[str, str]] = set()
    for article in articles:
        for video in videos:
            signature = (
                str(article.get("url") or ""),
                str(video.get("url") or ""),
            )
            if signature in seen:
                continue
            seen.add(signature)
            candidates.append([article, video])
    candidates.sort(
        key=lambda pair: (
            max(
                _delivery_locale_priority(resource, preferred_locale)
                for resource in pair
            ),
            sum(
                _delivery_locale_priority(resource, preferred_locale)
                for resource in pair
            ),
            # Source diversity is a tie-breaker inside the same language tier;
            # it must never force a Chinese user onto an English or less-local
            # destination merely to avoid reusing an institution.
            sum(
                _delivery_resource_sort_key(
                    resource,
                    preferred_locale,
                    content_category,
                )[1]
                for resource in pair
            ),
            # Source diversity matters only after both resources satisfy the
            # strongest editorial-quality tier. A different publisher cannot
            # compensate for an ad-like video or a hard-to-read article.
            sum(
                resource_parent_org_id(resource)
                in (excluded_primary_orgs or set())
                for resource in pair
            ),
            pair[0].get("research_source") != "openai_web_search",
            pair[1].get("research_source") != "openai_web_search",
        )
    )
    if not candidates:
        return []
    # Pick a strong primary, then maximize *both* format changes.  With two
    # articles and two videos this yields A1+V1, A2+V2 before A1+V2, so a
    # parent asking for another group does not immediately see half the same
    # content again.  Only a genuinely sparse pool is allowed to reuse one
    # side of the pair.
    selected = [candidates.pop(0)]
    used_article_urls = {str(selected[0][0].get("url") or "")}
    used_video_urls = {str(selected[0][1].get("url") or "")}
    while candidates and len(selected) < max(1, max_pairs):
        candidates.sort(
            key=lambda pair: (
                -max(
                    _delivery_locale_priority(resource, preferred_locale)
                    for resource in pair
                ),
                -sum(
                    _delivery_locale_priority(resource, preferred_locale)
                    for resource in pair
                ),
                str(pair[0].get("url") or "") not in used_article_urls
                and str(pair[1].get("url") or "") not in used_video_urls,
                str(pair[0].get("url") or "") not in used_article_urls,
                str(pair[1].get("url") or "") not in used_video_urls,
                pair[0].get("research_source") == "openai_web_search",
                pair[1].get("research_source") == "openai_web_search",
            ),
            reverse=True,
        )
        chosen = candidates.pop(0)
        selected.append(chosen)
        used_article_urls.add(str(chosen[0].get("url") or ""))
        used_video_urls.add(str(chosen[1].get("url") or ""))
    return selected


def _compact_stage_label(card: dict) -> str:
    raw = str(card.get("child_age_context") or "").strip()
    if "：" in raw:
        raw = raw.split("：", 1)[1]
    return raw[:80] or locales.phrase(
        "stage.unknown", card.get("preferred_locale")
    )


def _delivery_title(card: dict, content_category: str, resources: list[dict]) -> str:
    locale = str(card.get("preferred_locale") or "zh-CN")
    article = next(
        (resource for resource in resources if resource.get("kind") == "article"),
        {},
    )
    topic = locales.topic_label(
        card.get("topic_label") or card.get("topic") or "这个问题", locale
    )
    # English leads with the article's own title where there is one: the topic
    # label is composed in Chinese and reads oddly inside an English sentence.
    if locale == "en":
        topic = str(article.get("title") or topic).strip()
    return locales.phrase(
        f"title.{content_category}",
        locale,
        topic=topic,
        stage=_compact_stage_label(card),
    )[:180]


def decorate_delivery_card(card: dict, resources: list[dict]) -> None:
    """Apply the user-facing learning-capsule contract to one card."""

    category = str(card.get("content_category") or "")
    if category not in CONTENT_CATEGORIES:
        return
    pair = [_resource_with_delivery_metadata(resource) for resource in resources]
    article = next((resource for resource in pair if resource.get("kind") == "article"), {})
    video = next((resource for resource in pair if resource.get("kind") == "video"), {})
    card["delivery_title"] = _delivery_title(card, category, pair)
    card["source_label"] = str(article.get("publisher") or card.get("publisher") or "")
    article_language = str(article.get("language") or "").strip()
    video_language = str(video.get("language") or "").strip()
    card["language_label"] = " · ".join(
        value for value in (article_language, video_language) if value
    )[:120]
    estimated_minutes = sum(
        int(resource.get("estimated_minutes") or 0) for resource in pair
    )
    card["estimated_time_label"] = (
        f"约 {estimated_minutes} 分钟" if estimated_minutes else "约 5–10 分钟"
    )
    card["applicable_stage"] = _compact_stage_label(card)
    focus = str(
        card.get("recommendation_focus")
        or card.get("topic_label")
        or card.get("topic")
        or "这个问题"
    ).strip()
    # Composed with the family's own words inside it, so the frontend cannot
    # translate it: it arrives finished and matches no key. The locale is the
    # one the settings screen already saves — `_delivery_title` above has
    # branched on it all along, which is why the card could show an English
    # title over a Simplified guide.
    locale = card.get("preferred_locale")
    stage = _compact_stage_label(card)

    def _guide(for_locale: str) -> str:
        return locales.phrase(
            "guide",
            for_locale,
            focus=focus[:80],
            stage=stage,
            intro=locales.phrase(f"intro.{category}", for_locale),
        )[:300]

    card["guide"] = _guide(str(locale or "zh-CN"))
    card["action_steps"] = list(_DELIVERY_ACTION_STEPS[category])

    # Every language at once, because composing costs nothing here and the
    # alternative is worse than it sounds: a prepared card is frozen into a
    # snapshot, so a family that switches language keeps reading the old one
    # until something re-prepares it. The flat fields above stay exactly as they
    # were for any client that has not learned to read this.
    #
    # Only what this file composes. Resource titles, publishers and descriptions
    # are the publisher's words in the publisher's language, and the delivery
    # gate already picks *different resources* per locale — so there is no one
    # card here to render three ways, only one wrapper around three selections.
    card["text_i18n"] = {
        candidate: {
            "delivery_title": _delivery_title(
                {**card, "preferred_locale": candidate}, category, pair
            ),
            "guide": _guide(candidate),
            "applicable_stage": stage,
        }
        for candidate in sorted(locales.SUPPORTED_PREFERRED_LOCALES)
    }


def resource_blueprint(
    content_category: Optional[str] = None,
) -> dict[str, list[str]]:
    if content_category in CONTENT_CATEGORIES:
        return {str(content_category): ["article", "video"]}
    # Each editorial lane offers a real choice while preserving format
    # diversity. The third slot is quality-gated rather than quota-filled.
    return {
        category: ["article", "video", "article_or_video_optional"]
        for category in CONTENT_CATEGORIES
    }


def select_category_resource_pair(
    resources: list[dict],
    content_category: Optional[str],
    preferred_locale: Optional[str] = None,
) -> list[dict]:
    """Return at most one article and one video for one editorial lane."""

    if content_category not in CONTENT_CATEGORIES:
        return list(resources)
    matching = [
        resource
        for resource in resources
        if str(resource.get("content_category") or "") == content_category
        and reviewed_editorial_quality_allowed(resource)
    ]
    # Language fitness is the first ordering axis.  Among equally localized
    # authority items, prefer verified U.S. public-health, pediatric and
    # university sources without trusting model-authored country labels.
    matching.sort(
        key=lambda resource: _delivery_resource_sort_key(
            resource,
            preferred_locale,
            str(content_category),
        )
    )
    pair: list[dict] = []
    for kind in ("article", "video"):
        selected = next(
            (resource for resource in matching if resource.get("kind") == kind),
            None,
        )
        if selected:
            pair.append(selected)
    return pair


def reviewed_editorial_quality_allowed(resource: dict) -> bool:
    """Apply lane-quality exclusions before a reviewed pair reaches the UI."""

    category = str(resource.get("content_category") or "")
    kind = str(resource.get("kind") or "")
    org_id = resource_parent_org_id(resource)
    if category == "featured" and org_id in FEATURED_FORBIDDEN_PARENT_ORG_IDS:
        return False
    if (
        category == "authority"
        and kind == "video"
        and org_id in AUTHORITY_VIDEO_FORBIDDEN_PARENT_ORG_IDS
    ):
        return False
    if category == "case" and org_id in CASE_FORBIDDEN_PARENT_ORG_IDS:
        return False
    if (
        category == "case"
        and kind == "article"
        and case_article_reader_experience_status(resource.get("url")) == "rejected"
    ):
        return False
    if category == "case":
        case_process_status = str(
            resource.get("case_process_status") or ""
        ).casefold()
        if case_process_status in {"promotion_only", "rejected"}:
            return False
        if case_process_status != "verified":
            return False
        if (
            kind == "video"
            and str(resource.get("content_substance_status") or "").casefold()
            != "verified"
        ):
            return False
    if kind == "video" and str(
        resource.get("content_substance_status") or ""
    ).casefold() in {"ad_like", "rejected"}:
        return False
    return not (
        category == "featured"
        and str(resource.get("featured_readability_status") or "").casefold()
        == "rejected"
    )


_YOUTUBE_HOSTS = frozenset(
    {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
)
_REVIEWED_US_AUTHORITY_VIDEO_IDS = frozenset(
    {
        "sleep-aap-video",
        "food-aap-video",
        "development-cdc-video",
        "language-cdc-video",
        "safety-aap-video",
    }
)


def _safe_https_hostname(url: object) -> str:
    """Return a normalized host only for an ordinary, safe HTTPS URL."""

    try:
        parsed = urlparse(str(url or ""))
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        return ""
    return parsed.hostname.rstrip(".").lower()


def _is_direct_us_authority_url(url: object) -> bool:
    host = _safe_https_hostname(url)
    if not host or host in _YOUTUBE_HOSTS:
        return False
    return source_parent_org_id(url) in US_AUTHORITY_SOURCE_PARENT_ORG_IDS


def is_us_authority_resource(resource: dict) -> bool:
    """Recognize real U.S. institutions without trusting model country labels."""

    url = str(resource.get("url") or "")
    if _is_direct_us_authority_url(url):
        return True

    host = _safe_https_hostname(url)
    if host not in _YOUTUBE_HOSTS:
        return False

    # A hosted video needs evidence beyond a mutable publisher/country string.
    # Reviewed AAP/CDC IDs are tied to manually checked URLs.  Dynamic results
    # can qualify only when they cite the corresponding institution page.
    if (
        str(resource.get("id") or "") in _REVIEWED_US_AUTHORITY_VIDEO_IDS
        and is_trusted_resource_url(url)
    ):
        return True
    return any(
        _is_direct_us_authority_url(resource.get(field))
        for field in (
            "evidence_url",
            "authority_evidence_url",
            "publisher_evidence_url",
            "source_evidence_url",
        )
    )


def reviewed_category_resource_pair(
    resources: list[dict],
    locale: str,
    content_category: Optional[str],
    topic_context: Optional[dict] = None,
) -> list[dict]:
    """Select a stable same-language article/video pair for a category card.

    The conversation-aware filter is preferred.  If it removes one format, the
    manually reviewed resources on the same base topic are allowed to fill that
    format; this never crosses topic, category or language boundaries.
    """

    reviewed = reviewed_resources_for_context(resources, locale, topic_context)
    pair = select_category_resource_pair(
        reviewed,
        content_category,
        preferred_locale=locale,
    )
    # Never refill a missing format from an unfiltered pool.  That old fallback
    # could put a 10–12 month article back beside a 30 month recommendation.
    # A stage-correct single format is safer than a visually complete wrong-age
    # pair; live research may later supply the missing format.
    return pair


def category_feed_card(
    base_card: dict,
    content_category: str,
    locale: str,
    *,
    context_state: str,
) -> dict:
    """Present one ranked topic as a clearly labelled editorial-lane card."""

    card = dict(base_card)
    card["preferred_locale"] = locale
    meta = CATEGORY_CARD_META[content_category]
    library_resources = LEARNING_CONTENT_BY_ID.get(
        str(base_card.get("id") or ""), {}
    ).get("resources", [])
    topic_context = (
        base_card
        if base_card.get("child_age_context")
        or (context_state == "ready" and base_card.get("is_conversation_match"))
        else None
    )
    pair = reviewed_category_resource_pair(
        library_resources,
        locale,
        content_category,
        topic_context,
    )
    article = next(
        (resource for resource in pair if resource.get("kind") == "article"),
        None,
    )
    topic_label = str(
        card.get("topic_label") or card.get("topic") or "这个育儿问题"
    ).strip()
    card.update(
        {
            "content_category": content_category,
            "content_category_label": meta["label"],
            "content_category_eyebrow": meta["eyebrow"],
            "content_category_description": meta["description"],
            "type_label": meta["label"],
            "resource_pair_complete": len(pair) == 2,
            "resource_summary": summarize_resource_slots(pair, locale),
            # When no reviewed article survives the language, age and topic
            # gates, do not repeat the base topic headline across all three
            # editorial lanes or imply that its publisher supplied every lane.
            # These labels describe the pending lane honestly until research
            # produces a concrete article title on the detail page.
            "title": meta["fallback_title"].format(topic_label=topic_label),
            "publisher": meta["fallback_publisher"],
            "headline_source": "category_fallback",
        }
    )
    # The card is about the concrete content the user will open, while the
    # topic and NURI guide remain available on the detail page.
    if (
        (context_state != "ready" or not runtime.content_research_oai)
        and article
        and str(article.get("title") or "").strip()
    ):
        card["title"] = article["title"]
        card["summary"] = article.get("description") or card.get("summary")
        card["publisher"] = article.get("publisher") or card.get("publisher")
        card["headline_source"] = "reviewed_article"
    decorate_delivery_card(card, pair)
    return card


def resource_matches_preferred_locale(resource: dict, locale: str) -> bool:
    """Keep Chinese fallbacks available without disguising their script.

    Exact reviewed Traditional-Chinese parent/editorial pages are a better
    fallback for a Chinese account than an English original. Their existing
    ``language`` and region labels remain visible, so this does not present a
    Taiwan source as Simplified Chinese.
    """

    locales = resource.get("locales") or []
    if locale not in locales:
        return False
    if locale != "zh-CN":
        return True
    reviewed_chinese_fallback = bool(
        resource.get("research_source") == "reviewed_whitelist"
        and str(resource.get("content_category") or "") in {"featured", "case"}
        and (
            str(resource.get("content_category") or "") != "case"
            or str(resource.get("case_process_status") or "").casefold()
            == "verified"
        )
        and (
            str(resource.get("source_region") or "").upper() == "TW"
            or str(resource.get("script_language") or "") == "zh-Hant"
        )
    )
    if reviewed_chinese_fallback:
        return True
    if (
        str(resource.get("kind") or "") == "video"
        and str(resource.get("spoken_language") or "").casefold()
        in {"mandarin", "putonghua", "chinese", "国语", "普通话", "华语"}
    ):
        # Spoken Mandarin is the hard boundary for zh-CN video delivery. Keep
        # the Taiwan/Traditional label visible, but do not discard a stronger
        # Mandarin explanation because its publishing metadata is zh-Hant.
        return True
    if str(resource.get("source_region") or "").upper() == "TW":
        return False
    if str(resource.get("script_language") or "") == "zh-Hant":
        return False
    identity = " ".join(
        str(resource.get(field) or "")
        for field in ("language", "publisher", "trust_note", "recognition")
    )
    return not any(
        marker in identity for marker in ("繁体", "繁體", "台湾", "台灣", "臺灣")
    )


def reviewed_resources_for_context(
    resources: list[dict],
    locale: str,
    topic_context: Optional[dict] = None,
) -> list[dict]:
    """Return reviewed items that are trusted, locale-correct and relevant."""

    return order_learning_resources(
        [
            resource
            for resource in resources
            if is_trusted_resource_url(str(resource.get("url") or ""))
            and not (
                str(resource.get("content_category") or "") == "case"
                and str(resource.get("kind") or "") == "article"
                and case_article_reader_experience_status(resource.get("url"))
                == "rejected"
            )
            and resource_matches_preferred_locale(resource, locale)
            and (
                topic_context is None
                or reviewed_resource_matches_context(resource, topic_context)
            )
        ],
        locale,
    )


def _research_safety_identifier(uid: str) -> str:
    """Create a stable, privacy-preserving API safety identifier."""

    digest = hashlib.sha256(f"nuri-content:{uid}".encode("utf-8")).hexdigest()
    return f"nuri_{digest[:32]}"


def context_requires_urgent_handoff(context: dict) -> bool:
    """Keep emergencies out of learning-content research."""

    recent_text = "\n".join(
        str(message.get("text") or "")
        for message in (context.get("messages") or [])[-6:]
    )
    return bool(recent_text and dialogue_reply.urgent_task_suppressed(recent_text))


async def research_card_detail_resources(
    *,
    card: dict,
    context: dict,
    uid: Optional[str],
    force: bool = False,
    # Weaker than `force`: ignore a remembered failure, keep a remembered
    # success. What the preparation route wants, and what it used to ask for
    # with `force` — which also discarded every usable bundle.
    retry_failed: bool = False,
    extra_excluded_urls: Optional[list[str]] = None,
    # Names the caller in the usage log only. Defaulted rather than required so
    # the plain detail load keeps its three-kwarg call contract intact.
    call_label: str = "detail",
) -> Optional[dict]:
    """Run bounded, validated web research for a conversation-matched detail."""

    # Safety is evaluated before consent/provider eligibility.  Emergency text
    # must never be used for external research, regardless of the user's saved
    # privacy setting or the availability of an OpenAI client.
    if context_requires_urgent_handoff(context):
        return None
    if (
        not uid
        or not runtime.content_research_oai
        or not context.get("external_research_allowed")
        or context.get("state") != "ready"
        or not context.get("messages")
        or not card.get("is_conversation_match")
    ):
        return None
    llm_usage.set_user(uid)
    behavior_events = await outcome_store.get_events(uid)
    excluded_urls = list(
        dict.fromkeys(
            [
                *recent_resource_urls(behavior_events),
                *(extra_excluded_urls or []),
            ]
        )
    )[:120]
    feedback_preferences = recommendation_feedback.card_behavior_signal(
        str(card.get("id") or ""), behavior_events
    ).get("content_refresh_reasons") or []
    try:
        return await anyio.to_thread.run_sync(
            lambda: content_research.research_learning_resources(
                runtime.content_research_oai,
                card=card,
                messages=context.get("messages") or [],
                preferred_locale=str(context.get("preferred_locale") or "zh-CN"),
                model=OPENAI_CONTENT_RESEARCH_MODEL,
                safety_identifier=_research_safety_identifier(uid),
                force=force,
                retry_failed=retry_failed,
                excluded_urls=excluded_urls,
                feedback_preferences=feedback_preferences,
                call_label=call_label,
            ),
            limiter=content_research_limiter,
        )
    except Exception as exc:
        # Dynamic research is an enhancement.  A provider outage, timeout, bad
        # result or incomplete quality bundle must never break the reviewed detail.
        print(f"[warn] conversation content research fell back: {type(exc).__name__}")
        return {"_provider_failure": "retryable"}


def prepared_content_set_id(snapshots: list[dict], _resources: list[dict]) -> str:
    first = snapshots[0]
    # Bind the public set ID to the frozen recommendation group, not to one
    # provider response. Two Vercel instances may finish equivalent research
    # concurrently; a stable ID lets either completed response open whichever
    # valid winner is durably stored, instead of turning the first link stale.
    material = {
        "card_id": first.get("card_id"),
        "session_id": first.get("session_id"),
        "context_created_at": first.get("context_created_at"),
        "child_profile_fingerprint": first.get("child_profile_fingerprint"),
        "preferred_locale": first.get("preferred_locale"),
        "recommendations": sorted(
            (
                str(snapshot.get("recommendation_id") or ""),
                str(snapshot.get("content_category") or ""),
            )
            for snapshot in snapshots
        ),
    }
    digest = hashlib.sha256(
        json.dumps(material, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return f"pcs_{digest[:24]}"


def prepare_response_items(snapshots: list[dict]) -> list[dict]:
    items: list[dict] = []
    for snapshot in snapshots:
        pair = prepared_resource_pair(snapshot)
        pair_pool = prepared_resource_pairs(snapshot)
        readiness = "ready" if pair else str(
            snapshot.get("resource_readiness") or "retryable"
        )
        if readiness not in {"preparing", "ready", "retryable"}:
            readiness = "retryable"
        item = {
            "card_id": snapshot.get("card_id"),
            "recommendation_id": snapshot.get("recommendation_id"),
            "content_category": snapshot.get("content_category"),
            "resource_readiness": readiness,
            "resource_pair_complete": bool(pair),
            "prepared_content_set_id": (
                snapshot.get("prepared_content_set_id") if pair else None
            ),
            "resources": pair or [],
            "active_pair_id": pair_pool[0]["pair_id"] if pair_pool else None,
            "alternate_resource_pairs": pair_pool[1:],
            "alternate_count": max(0, len(pair_pool) - 1),
            "research_status": "ready" if pair else readiness,
        }
        if pair:
            article = next(
                resource for resource in pair if resource.get("kind") == "article"
            )
            item["title"] = article.get("title")
            item["publisher"] = article.get("publisher")
            item["source_label"] = article.get("publisher")
            item["child_age_context"] = snapshot.get("child_age_context") or ""
            item["preferred_locale"] = (
                snapshot.get("preferred_locale") or "zh-CN"
            )
            item["topic_label"] = snapshot.get("recommendation_focus") or "这个问题"
            item["recommendation_focus"] = snapshot.get("recommendation_focus") or ""
            decorate_delivery_card(item, pair)
        items.append(item)
    return items


def prepare_retry_or_previous_payload(snapshots: list[dict]) -> dict:
    """Keep a complete previous set published while its upgrade is retryable."""

    pairs = [prepared_resource_pair(snapshot) for snapshot in snapshots]
    set_ids = {
        str(snapshot.get("prepared_content_set_id") or "")
        for snapshot, pair in zip(snapshots, pairs)
        if pair
    }
    if (
        all(pairs)
        and len(set_ids) == 1
        and prepared_snapshot_set_meets_source_contract(snapshots)
    ):
        previous_set_id = next(iter(set_ids))
        return {
            "resource_readiness": "ready",
            "prepared_content_set_id": previous_set_id,
            "recommendation_set_id": previous_set_id,
            "publication_state": "published",
            "upgrade_state": "preparing",
            "items": prepare_response_items(snapshots),
        }
    return {
        "resource_readiness": "retryable",
        "prepared_content_set_id": None,
        "recommendation_set_id": None,
        "publication_state": "preparing",
        "items": prepare_response_items(snapshots),
    }


async def mark_prepare_retryable(uid: str, snapshots: list[dict]) -> list[dict]:
    retryable: list[dict] = []
    for snapshot in snapshots:
        current = await stores.get_snapshot_persistent(
            uid,
            snapshot.get("recommendation_id"),
        )
        if current and prepared_resource_pair(current) and prepared_snapshot_set_meets_source_contract([current]):
            retryable.append(current)
        elif prepared_resource_pair(snapshot) and prepared_snapshot_set_meets_source_contract([snapshot]):
            retryable.append(snapshot)
        else:
            # Failure is returned to this caller, but is intentionally not an
            # app_settings write: a stale failed request must never downgrade a
            # pair concurrently published by another Vercel invocation.
            retryable.append(
                snapshot_with_resource_readiness(snapshot, "retryable")
            )
    return retryable


async def record_resource_delivery(
    *,
    uid: str,
    card_id: str,
    recommendation_id: Optional[str],
    content_category: Optional[str],
    preferred_locale: str,
    resources: list[dict],
) -> None:
    events = [
        outcome_store.new_event(
            event="resource_delivered",
            card_id=card_id,
            trusted_resource_url=True,
            recommendation_id=recommendation_id,
            resource_id=str(resource.get("id") or ""),
            resource_url=str(resource.get("url") or ""),
            resource_kind=str(resource.get("kind") or ""),
            content_category=str(
                resource.get("content_category") or content_category or ""
            ),
            locale=(resource.get("locales") or [preferred_locale])[0],
            position=index,
        )
        for index, resource in enumerate(resources)
        if resource.get("id") and resource.get("url")
    ]
    if events:
        await outcome_store.append_events(uid, events)


def log_personalized_feed_decision(uid: str, context: dict, items: list[dict]) -> None:
    """Emit ranking diagnostics without storing conversation text or user IDs."""

    try:
        user_messages = [
            message
            for message in (context.get("messages") or [])
            if message.get("role") == "user"
        ]
        payload = {
            "event": "personalized_feed_ranked",
            "user_ref": hashlib.sha256(
                f"nuri-feed:{uid}".encode("utf-8")
            ).hexdigest()[:12],
            "context_state": context.get("state", "no_history"),
            "message_count": len(context.get("messages") or []),
            "user_message_count": len(user_messages),
            "current_session_user_message_count": int(
                context.get("current_session_user_message_count") or 0
            ),
            "account_history_user_message_count": int(
                context.get("history_user_message_count") or 0
            ),
            "filtered_product_feedback_count": sum(
                1
                for message in user_messages
                if signals.is_product_meta_request(str(message.get("text") or ""))
                or signals.is_recommendation_feedback(str(message.get("text") or ""))
            ),
            "selected": [
                {
                    "id": str(item.get("id") or ""),
                    "match": bool(item.get("is_conversation_match")),
                    "dynamic": bool(item.get("is_dynamic_research_card")),
                    "score": item.get("recommendation_score"),
                }
                for item in items
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        # Observability must never be allowed to break a parent's home feed.
        print(f"[warn] personalized feed diagnostics failed: {type(exc).__name__}")


# ── Snapshot -> card, the delivery half ──────────────────────────────────────
# These two read and write recommendation snapshots, but what they do with one
# is decorate a home card — which is this layer's job, not the store's. They
# sat among the _db_* helpers and called decorate_delivery_card and
# prepared_snapshot_set_meets_source_contract back out of it, which made the
# store and delivery layers mutually dependent and neither of them separable.
# Here the dependency runs one way: delivery calls the store.
def _apply_prepared_snapshot_to_feed_card(card: dict, snapshot: dict) -> None:
    """Expose a prepared, binding-validated pair on its matching home card."""

    source_contract_ready = prepared_snapshot_set_meets_source_contract([snapshot])
    pair = prepared_resource_pair(snapshot) if source_contract_ready else None
    pair_pool = prepared_resource_pairs(snapshot) if source_contract_ready else []
    readiness = str(snapshot.get("resource_readiness") or "")
    if pair:
        article = next(resource for resource in pair if resource.get("kind") == "article")
        card["resource_readiness"] = "ready"
        card["resource_pair_complete"] = True
        card["prepared_content_set_id"] = snapshot.get("prepared_content_set_id")
        card["resource_summary"] = summarize_resource_slots(
            pair,
            str(snapshot.get("preferred_locale") or "zh-CN"),
        )
        card["resources"] = pair
        card["active_pair_id"] = pair_pool[0]["pair_id"] if pair_pool else None
        card["alternate_resource_pairs"] = pair_pool[1:]
        card["alternate_count"] = max(0, len(pair_pool) - 1)
        card["title"] = article.get("title") or card.get("title")
        card["summary"] = article.get("description") or card.get("summary")
        card["publisher"] = article.get("publisher") or card.get("publisher")
        card["headline_source"] = "prepared_article"
        decorate_delivery_card(card, pair)
        return
    if card.get("resource_readiness") == "ready" and card.get("resource_pair_complete"):
        card["prepared_content_set_id"] = None
        return
    card["resource_readiness"] = (
        readiness if readiness in {"preparing", "retryable"} else "preparing"
    )
    card["prepared_content_set_id"] = None


async def attach_recommendation_snapshots(
    uid: str,
    cards: list[dict],
    context: dict,
) -> list[dict]:
    """Persist one bounded snapshot per conversation-matched card.

    ``app_settings`` already exists in every deployed NURI database, so this
    adds stable detail links without making a schema migration a prerequisite.
    A process-local copy keeps local preview/tests useful; the legacy session
    and cutoff fields remain on every card as a safe compatibility fallback.
    """

    pairs: list[tuple[dict, dict]] = []
    for card in cards:
        if not card.get("is_conversation_match"):
            continue
        snapshot = build_snapshot(uid, card, context)
        requested_readiness = str(card.get("resource_readiness") or "")
        if requested_readiness in {"preparing", "retryable"}:
            snapshot["resource_readiness"] = requested_readiness
        try:
            previous = await stores.get_snapshot(
                uid,
                snapshot["recommendation_id"],
            )
        except HTTPException:
            previous = None
        if previous:
            snapshot = carry_prepared_resource_state(previous, snapshot)
        pairs.append((card, snapshot))

    if not pairs:
        return cards

    persisted = await stores.persist_snapshots(
        uid,
        [snapshot for _, snapshot in pairs],
    )

    for card, snapshot in pairs:
        if persisted:
            card["recommendation_id"] = snapshot["recommendation_id"]
            card["recommendation_context_status"] = "persisted"
            _apply_prepared_snapshot_to_feed_card(card, snapshot)
        else:
            card.pop("recommendation_id", None)
            card["recommendation_context_status"] = "legacy_fallback"
    return cards
