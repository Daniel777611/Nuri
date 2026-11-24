"""Exercise the Alpha Community translation path with two synthetic parents."""

import hashlib

from fastapi import HTTPException

from backend import community, runtime
from backend.alpha_community_seed import PASSWORD_DISABLED, bot_email, bot_user_id


def _key(action: str, *parts: str) -> str:
    digest = hashlib.sha256("\0".join(parts).encode()).hexdigest()[:32]
    return f"alpha-bot-translation-{action}-{digest}"


def _choose_parent(personas: dict[str, dict], language: str) -> str:
    for uid, persona in sorted(personas.items()):
        if persona["language"] == language and bot_user_id(persona["slug"]) == uid:
            return uid
    raise HTTPException(422, "No verified Alpha parent for this language")


async def _verify_accounts(personas: dict[str, dict], parents: list[str]) -> None:
    rows = await community._select("users", lambda q: q.in_("id", parents))
    verified = {
        row["id"] for row in rows
        if row["id"] in parents
        and row.get("email") == bot_email(personas[row["id"]]["slug"])
        and row.get("hashed_password") == PASSWORD_DISABLED
        and row.get("is_internal") is True
    }
    if verified != set(parents):
        raise HTTPException(409, "Alpha translation test requires two synthetic accounts")


async def _connect(initiator: str, peer: str) -> str:
    profiles = await community._profiles([initiator, peer])
    if set(profiles) != {initiator, peer}:
        raise HTTPException(409, "Alpha translation test profiles are unavailable")
    target = str(profiles[peer]["public_id"])
    pair = [initiator, peer]
    invitation = (await community.send_invitation(initiator, community.InvitationIn(
        target_parent_id=target, client_request_id=_key("invite", *pair),
    )))["invitation"]
    if invitation and invitation["state"] == "pending":
        await community.decide_invitation(peer, invitation["invitation_id"], community.InvitationDecisionIn(
            decision="accept", client_request_id=_key("accept", *pair),
        ))
    conversation = (await community.start_conversation(initiator, community.ConversationIn(
        target_parent_id=target, client_request_id=_key("conversation", *pair),
    )))["conversation"]
    conversation_id = conversation["conversation_id"]
    _, other = await community._member_conversation(initiator, conversation_id)
    if other != peer:
        raise HTTPException(409, "Alpha translation test conversation did not match its pair")
    return conversation_id


async def _ensure_translation_consent(initiator: str, peer: str, conversation_id: str,
                                      scope: dict) -> dict:
    notice = scope["notice_version"]
    request = scope["requests"]["translation"]
    if not request:
        request = (await community.request_ai_consent(initiator, conversation_id, community.ConsentRequestIn(
            purpose="translation", notice_version=notice,
            client_request_id=_key("consent", conversation_id, str(scope["epoch"]), notice),
        )))["request"]
    for parent, decision in ((initiator, "my_decision"), (peer, "parent_decision")):
        if request[decision] != "allow":
            await community.decide_ai_consent(parent, request["request_id"], community.ConsentDecisionIn(
                decision="allow", notice_version=notice,
                client_request_id=_key("allow", request["request_id"], parent),
            ))
    latest = (await community.ai_activity(initiator, conversation_id))["requests"]["translation"]
    if not latest or not latest["effective"] or latest["my_decision"] != "allow" or latest["parent_decision"] != "allow":
        raise HTTPException(409, "Alpha translation test did not obtain both consent decisions")
    return latest


async def verify_one_language(personas: dict[str, dict], language: str) -> dict:
    """Send one source-language message into an iOS-supported target locale.

    Uses stable keys to resume after a partial run or reuse an existing result.
    The caller supplies the verified persona map from the Alpha scheduler.
    """
    if not runtime.alpha_features_available():
        raise HTTPException(404, "Not found")
    target_language = {
        "en": "zh-CN", "zh-CN": "zh-TW", "zh-TW": "en", "es": "zh-CN",
        "fr": "zh-TW", "he": "zh-CN", "ja": "en", "ko": "zh-TW",
    }[language]
    sender = _choose_parent(personas, language)
    receiver = _choose_parent(personas, target_language)
    initiator, peer = sorted([sender, receiver])
    await _verify_accounts(personas, [initiator, peer])
    conversation_id = await _connect(initiator, peer)
    source = personas[sender]["question"].strip()
    message = (await community.send_message(sender, conversation_id, community.MessageIn(
        text=source, language=language,
        client_message_id=_key("message", conversation_id, sender, language, source),
    )))["message"]
    message_id = message["message_id"]
    translation_input = community.TranslationIn(
        target_language=target_language, ai_consent_version=community.NURI_AI_CONSENT_VERSION,
        client_request_id=_key("translate", message_id, receiver, target_language),
    )
    scope = await community.ai_activity(initiator, conversation_id)
    grant = scope["requests"]["translation"]
    blocked_before_consent = None
    if not grant or not grant["effective"]:
        try:
            await community.translate_message(receiver, message_id, translation_input)
        except community.CommunityError as error:
            if error.error_code != "CONSENT_REQUIRED":
                raise
            blocked_before_consent = True
        else:
            raise HTTPException(409, "Alpha translation test succeeded before both parents consented")
    await _ensure_translation_consent(initiator, peer, conversation_id, scope)
    result = await community.translate_message(receiver, message_id, translation_input)
    translation = result["translation"]
    saved = await community._one("community_messages", lambda q: q.eq("id", message_id).eq("sender_id", sender))
    if (result["original"] != {"text": source, "language": language} or not saved
            or saved.get("body") != source or saved.get("language") != language):
        raise HTTPException(409, "Alpha translation test did not preserve the original")
    translated = translation["text"].strip()
    if (translation["state"] != "succeeded" or translation["target_language"] != target_language
            or not translated or translated.casefold() == source.casefold()):
        raise HTTPException(502, "Alpha translation test did not return a different target-language message")
    return {
        "ok": True, "source_language": language, "target_language": target_language,
        "consent_effective": True, "blocked_before_consent": blocked_before_consent,
        "original_preserved": True, "message_id": message_id,
        "original_text": source, "translated_text": translated,
    }
