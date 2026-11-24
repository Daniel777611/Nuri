"""Help Alpha testers start a translation conversation with a synthetic parent."""
import logging

import anyio

from backend import community
from backend.alpha_community_bots import TABLE, request_key
from backend.alpha_community_seed import PASSWORD_DISABLED, bot_email, bot_user_id, load_personas

LOG = logging.getLogger(__name__)


async def _enabled_parent(uid):
    parent = next((p for p in load_personas() if bot_user_id(p["slug"]) == uid), None)
    if parent is None:
        return None
    account = await community._one("users", lambda q: q.eq("id", uid).eq(
        "email", bot_email(parent["slug"])).eq("hashed_password", PASSWORD_DISABLED).eq("is_internal", True))
    if not account:
        return None
    state = await community._one(TABLE, lambda q: q.eq("id", 1).eq("enabled", True))
    return parent if state else None


async def greet_inviter(tester_id, public_parent_id, result):
    """Accept an incoming tester invitation and leave one message in the bot's language."""
    invitation = result.get("invitation")
    if not invitation or invitation["direction"] != "sent" or invitation["state"] not in {"pending", "accepted"}:
        return result
    try:
        with anyio.fail_after(12):
            profile = await community._profile_by_public(public_parent_id)
            if not profile:
                return result
            bot_id = profile["user_id"]
            parent = await _enabled_parent(bot_id)
            if not parent:
                return result
            invite_id = invitation["invitation_id"]
            if invitation["state"] == "pending":
                await community.decide_invitation(bot_id, invite_id, community.InvitationDecisionIn(
                    decision="accept", client_request_id=request_key("tester-invite", invite_id),
                    expected_version=invitation["version"],
                ))
            chat = (await community.start_conversation(bot_id, community.ConversationIn(
                relationship_id=(await community._relation_view(bot_id, tester_id))["relationship_id"],
                client_request_id=request_key("tester-chat", invite_id),
            )))["conversation"]
            await community.send_message(bot_id, chat["conversation_id"], community.MessageIn(
                text=parent["question"], language=parent["language"],
                client_message_id=request_key("tester-greeting", invite_id),
            ))
            row = await community._one("community_invitations", lambda q: q.eq("id", invite_id))
            return {**result, "relationship": await community._relation_view(tester_id, bot_id),
                    "invitation": await community._invitation_dto(tester_id, row)}
    except Exception as exc:
        LOG.warning("Alpha test invitation helper failed: %s", type(exc).__name__)
        return result


async def allow_bot_translation(tester_id, conversation_id, result):
    """Record the bot's decision in a translation request initiated by the tester."""
    request = result["request"]
    if (request["purpose"] != "translation" or request["state"] != "pending"
            or request["initiated_by"] != "me" or request["my_decision"] != "allow"):
        return result
    try:
        with anyio.fail_after(10):
            _, bot_id = await community._member_conversation(tester_id, conversation_id)
            if not await _enabled_parent(bot_id):
                return result
            await community.decide_ai_consent(bot_id, request["request_id"], community.ConsentDecisionIn(
                decision="allow", notice_version=request["notice_version"], expected_version=request["version"],
                client_request_id=request_key("tester-translation", request["request_id"]),
            ))
            state = await community.ai_activity(tester_id, conversation_id)
            return {"request": state["requests"]["translation"]}
    except Exception as exc:
        LOG.warning("Alpha test consent helper failed: %s", type(exc).__name__)
        return result
