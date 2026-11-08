import type { communityApi } from "./communityApi";
import type { FinalCommunityEvent } from "./uiuxfinal/communityModel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCommunityNotificationKind = (value: unknown) => typeof value === "string" && value.startsWith("community_");
export class CommunityTargetUnavailable extends Error {
  constructor() { super("Community target is unavailable"); this.name = "CommunityTargetUnavailable"; }
}
type Entry = { events: FinalCommunityEvent[]; conversation?: { parentId: string; id: string } };
type Client = Pick<typeof communityApi, "notificationTarget" | "question" | "messages">;
/** Only a current server authorization can open a typed Community target.
 * Never navigate to a route/URL supplied by a push payload or query string. */
export async function loadCommunityNotificationEntry(id: string, api: Client): Promise<Entry> {
  if (!UUID.test(id)) throw new CommunityTargetUnavailable();
  const result = await api.notificationTarget(id);
  if (result.notification_id !== id || result.accessible !== true || !result.target) throw new CommunityTargetUnavailable();
  const target = result.target;
  switch (target.kind) {
    case "community_question": {
      if (!UUID.test(target.question_id) || !UUID.test(target.delivery_id)) throw new CommunityTargetUnavailable();
      const { question } = await api.question(target.question_id);
      if (question.question_id !== target.question_id) throw new CommunityTargetUnavailable();
      if(!question.is_mine&&(!question.delivery||question.delivery.delivery_id!==target.delivery_id||!["waiting","replied","locked"].includes(question.delivery.state)))throw new CommunityTargetUnavailable();
      return { events: question.is_mine ? [{ type: "openQuestion", id: target.question_id }] : [
        { type: "openReceived", id: target.question_id, deliveryID: target.delivery_id, status: question.delivery!.state },
      ] };
    }
    case "community_reply":
      if (!UUID.test(target.question_id) || target.thread_id !== "all" && !UUID.test(target.thread_id)) throw new CommunityTargetUnavailable();
      return { events: [{ type: "openQuestion", id: target.question_id }, { type: "replyTarget", target: target.thread_id }] };
    case "community_invitation":
      if (!UUID.test(target.invitation_id)) throw new CommunityTargetUnavailable();
      return { events: [{ type: "go", screen: "invitations" }] };
    case "community_conversation":
    case "community_ai_consent": {
      if (!UUID.test(target.conversation_id)) throw new CommunityTargetUnavailable();
      const { conversation } = await api.messages(target.conversation_id);
      const parent = conversation.parent;
      if (conversation.conversation_id !== target.conversation_id || !parent?.parent_id || !UUID.test(parent.parent_id)) throw new CommunityTargetUnavailable();
      return { events: [{ type: "person", person: parent.parent_id, name: parent.display_name, screen: "chat" }], conversation: { parentId: parent.parent_id, id: target.conversation_id } };
    }
    default: throw new CommunityTargetUnavailable();
  }
}
