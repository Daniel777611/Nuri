/** Community API client: /api/community/v1 (backend/community.py).
 *
 * Shapes mirror backend/docs/community_api.md exactly. Every creating write
 * carries a client key the caller keeps for retries: resending the same key
 * after an unknown outcome returns the first result instead of a duplicate.
 */
import { ApiError, apiRequest } from "./api";
import { AI_CONSENT_VERSION } from "./aiConsent";

const V1 = "/community/v1";

export type Page<T> = { items: T[]; next_cursor: string | null; has_more: boolean };
export type IntentCode =
  | "share_parenting_ideas" | "talk_parenting" | "similar_experiences"
  | "outings_with_children" | "nearby_parents" | "casual_chat";
/** By the index the design's intent chips use (communityModel / ProfileEditor). */
export const INTENT_CODES: readonly IntentCode[] = [
  "share_parenting_ideas", "talk_parenting", "similar_experiences",
  "outings_with_children", "nearby_parents", "casual_chat",
];
export const intentIndexes = (codes: readonly string[] = []) =>
  codes.map(code => INTENT_CODES.indexOf(code as IntentCode)).filter(index => index >= 0);
export const intentCodes = (indexes: readonly number[]) =>
  INTENT_CODES.filter((_, index) => indexes.includes(index));

export type PublicParent = {
  parent_id: string | null; display_name: string; about: string; city: string;
  intents: IntentCode[]; role: "mom" | "dad" | null; gender_tag?: "mom" | "dad" | "other" | null;
  avatar: { media_id: string } | null; anonymous?: boolean;
};
export type RelationState = "none" | "invitation_sent" | "invitation_received" | "connected" | "disconnected" | "blocked_by_me";
export type RelationView = {
  state: RelationState; relationship_id: string | null; invitation_id: string | null;
  conversation_id: string | null; allowed_actions: string[];
};
export type MyProfile = {
  exists: boolean;
  profile: (PublicParent & { location_shared: boolean; version: number; updated_at: string }) | null;
  visibility: "visible" | "hidden" | null;
};
export type Question = {
  question_id: string; body: string; original_language: string; version_source: "original" | "polished";
  anonymous: boolean; show_child_age: boolean; child_age_months: number | null;
  status: "open" | "closed"; reply_count: number; author: PublicParent; is_mine: boolean;
  allowed_actions: string[]; version: number; created_at: string; updated_at: string;
  delivery?: DeliveryMeta;
};
export type DeliveryMeta = {
  delivery_id: string; state: "waiting" | "replied" | "locked"; lock_reason: string | null;
  expires_at: string; version: number;
};
export type Reply = {
  reply_id: string; thread_id: string; body: string; language: string; anonymous: boolean;
  created_at: string; author: PublicParent; is_mine: boolean; comment_count: number; allowed_actions: string[];
};
export type Delivery = DeliveryMeta & { question: Question; my_reply: Omit<Reply, "author" | "is_mine" | "comment_count" | "allowed_actions"> | null };
export type Comment = { comment_id: string; body: string; seq: number; created_at: string; is_mine: boolean; author: PublicParent };
export type Invitation = {
  invitation_id: string; direction: "sent" | "received"; state: string; version: number;
  parent: PublicParent | null; created_at: string;
};
export type Contact = { relationship_id: string; state: string; version: number; parent: PublicParent; conversation_id: string | null };
export type Conversation = {
  conversation_id: string; parent: PublicParent | null; relationship_state: string;
  allowed_actions: string[]; ai: { effective: boolean; epoch: number };
  message_media_limit?: number;
  last_message_seq: number | null; last_message_at: string | null;
};
export type InboxItem = Conversation & {
  kind: "conversation"; unread_count: number;
  last_message: { preview: string; sender: "me" | "parent"; seq: number } | null;
};
export type Message = {
  message_id: string; conversation_id: string; seq: number; sender: "me" | "parent"; text: string;
  language?: string | null;
  media: { media_id: string }[]; created_at: string; state: "saved"; client_message_id: string | null;
};
export type Recommendation = { parent: PublicParent; distance_miles: number | null; shared_intents: IntentCode[]; relationship: RelationView };
export type ReportKind = "question" | "reply" | "comment" | "message" | "parent";
export type ReportReason = "harassment" | "sexual" | "hate" | "child_safety" | "self_harm" | "spam" | "other";
export type Preferences = {
  parent_message_notifications_enabled: boolean; profile_hidden: boolean; auto_translate_messages: boolean; version: number;
};
export type CommunityNotificationTarget =
  | { kind: "community_question"; question_id: string; delivery_id: string }
  | { kind: "community_reply"; question_id: string; thread_id: string; reply_id?: string; comment_id?: string }
  | { kind: "community_invitation"; invitation_id: string; state?: string }
  | { kind: "community_conversation"; conversation_id: string }
  | { kind: "community_ai_consent"; conversation_id: string; consent_request_id?: string };
export type BottleNotification = {
  notification_id: string;
  target: Extract<CommunityNotificationTarget, { kind: "community_question" | "community_reply" }>;
};
export type BottleNotificationSnapshot = { notifications: BottleNotification[]; waiting: Delivery[]; waitingError?: Error };
type CommunityNotification = {
  notification_id: string;
  target: CommunityNotificationTarget | null;
  read_at: string | null;
};
export type CommunityNotificationTargetResult = { notification_id: string } & (
  | { accessible: true; target: CommunityNotificationTarget; reason: null }
  | { accessible: false; target: null; reason: string }
);
export type AIPurpose = "conversation_notes" | "translation";
export type ConsentRequest = {
  request_id: string; purpose: AIPurpose; notice_version: string; state: "pending" | "effective" | "declined" | "revoked" | "superseded";
  epoch: number; version: number; initiated_by: "me" | "parent"; my_decision: "allow" | "decline" | "pending";
  parent_decision: "allow" | "decline" | "pending"; effective: boolean;
  effective_from_seq: number | null;
};
export type AIParticipation = {
  conversation_id: string; epoch: number; effective: boolean; notice_version: string;
  notes_offer_eligible?: boolean;
  requests: { conversation_notes: ConsentRequest | null; translation: ConsentRequest | null };
};

/** A new client key for one logical write; keep it for that write's retries. */
export function communityKey(tag: string): string {
  const random = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${tag}-${random}`;
}

/** The Community error code in a failed call (VERSION_CONFLICT, …), or "". */
export function communityErrorCode(error: unknown): string {
  if (!(error instanceof ApiError)) return "";
  try {
    const parsed = JSON.parse(error.message.slice(error.message.indexOf("{")));
    return String(parsed?.error?.code || "");
  } catch { return ""; }
}

const q = (params: Record<string, string | number | boolean | null | undefined>) => {
  const parts = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
};
const get = <T,>(path: string) => apiRequest<T>(V1 + path);
const send = <T,>(method: string, path: string, body?: unknown, timeoutMs?: number) =>
  apiRequest<T>(V1 + path, { method, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs);

async function readUnreadBottleNotifications(isCurrent: () => boolean): Promise<BottleNotification[]> {
  const unread = new Map<string, BottleNotification>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  while (isCurrent()) {
    const page: Page<CommunityNotification> = await get(`/me/notifications${q({ cursor, page_size: 50 })}`);
    if (!isCurrent()) break;
    for (const item of page.items) {
      const { notification_id, target, read_at } = item;
      if (!notification_id || read_at !== null) continue;
      if ((target?.kind === "community_reply" && target.question_id && target.thread_id)
        || (target?.kind === "community_question" && target.question_id && target.delivery_id)) {
        unread.set(notification_id, { notification_id, target });
      }
    }
    if (!page.has_more) return [...unread.values()];
    cursor = page.next_cursor;
    if (!cursor || cursors.has(cursor)) throw new Error("Invalid Community notification cursor");
    cursors.add(cursor);
  }
  return [];
}

/** The preview, waiting list and received badge share this current-account
 * snapshot. Notification rows can survive after their delivery stops waiting. */
export async function bottleNotificationSnapshot(isCurrent: () => boolean): Promise<BottleNotificationSnapshot> {
  let waitingError: Error | undefined;
  const [events, waiting] = await Promise.all([
    readUnreadBottleNotifications(isCurrent).catch(() => []),
    waitingBottleDeliveries(isCurrent).catch(error => {
      waitingError = error instanceof Error ? error : new Error("Received questions are unavailable");
      return [];
    }),
  ]);
  if (!isCurrent()) return { notifications: [], waiting: [] };
  const replies = await validateBottleReplyNotifications(events, isCurrent);
  const validReplies = new Set(replies.map(event => event.notification_id));
  const deliveries = new Map(waiting.map(delivery => [delivery.delivery_id, delivery.question.question_id]));
  return isCurrent() ? {
    notifications: events.filter(event => event.target.kind === "community_question"
      ? deliveries.get(event.target.delivery_id) === event.target.question_id
      : validReplies.has(event.notification_id)),
    waiting,
    ...(waitingError ? { waitingError } : {}),
  } : { notifications: [], waiting: [] };
}

export async function unreadBottleNotifications(isCurrent: () => boolean): Promise<BottleNotification[]> {
  return (await bottleNotificationSnapshot(isCurrent)).notifications;
}

async function waitingBottleDeliveries(isCurrent: () => boolean): Promise<Delivery[]> {
  const waiting = new Map<string, Delivery>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  while (isCurrent()) {
    const page: Page<Delivery> = await get(`/me/question-deliveries${q({ tab: "waiting", cursor, page_size: 50 })}`);
    if (!isCurrent()) return [];
    for (const delivery of page.items) {
      if (delivery.delivery_id && delivery.state === "waiting" && !delivery.lock_reason && !delivery.my_reply
        && delivery.question?.question_id && delivery.question.is_mine === false && delivery.question.status === "open") {
        waiting.set(delivery.delivery_id, delivery);
      }
    }
    if (!page.has_more) return [...waiting.values()];
    cursor = page.next_cursor;
    if (!cursor || cursors.has(cursor)) throw new Error("Invalid Community delivery cursor");
    cursors.add(cursor);
  }
  return [];
}

/** Notification targets may outlive a deleted reply or refer to someone else's
 * question. Count only replies which are still visible on an owned question. */
async function validateBottleReplyNotifications(events: BottleNotification[], isCurrent: () => boolean): Promise<BottleNotification[]> {
  const byQuestion = new Map<string, BottleNotification[]>();
  const valid = new Set<string>();
  for (const event of events) {
    if (event.target.kind !== "community_reply") continue;
    const group = byQuestion.get(event.target.question_id) ?? [];
    group.push(event);
    byQuestion.set(event.target.question_id, group);
  }
  const groups = [...byQuestion.entries()];
  let next = 0;
  const validate = async () => {
    while (isCurrent() && next < groups.length) {
      const [questionId, group] = groups[next++];
      const pending = new Map(group.map(event => [event.notification_id, event]));
      const cursors = new Set<string>();
      let cursor: string | null = null;
      try {
        while (isCurrent() && pending.size) {
          const page: ReplyPage = await get(`/questions/${encodeURIComponent(questionId)}/replies${q({ cursor, page_size: 50 })}`);
          if (!isCurrent() || !page.question.is_mine || page.question.question_id !== questionId) break;
          const targets = new Set(page.items.map(reply => reply.reply_id));
          if (page.all_thread?.comment_count) targets.add("all");
          for (const [id, event] of pending) {
            if (event.target.kind === "community_reply" && targets.has(event.target.thread_id)) {
              valid.add(id);
              pending.delete(id);
            }
          }
          if (!page.has_more) break;
          cursor = page.next_cursor;
          if (!cursor || cursors.has(cursor)) break;
          cursors.add(cursor);
        }
      } catch {
        // An inaccessible or failed target is unknown, never a positive badge.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, groups.length) }, validate));
  return isCurrent() ? events.filter(event => valid.has(event.notification_id)) : [];
}

export type ReplyPage = Page<Reply> & {
  question: Question;
  all_thread: { thread_id: "all"; comment_count: number; can_post: boolean } | null;
};

export const communityApi = {
  notificationTarget: (id: string) => get<CommunityNotificationTargetResult>(`/me/notifications/${encodeURIComponent(id)}/target`),
  markNotificationRead: (id: string) => send<{ notification_id: string; read_at: string | null }>("POST", `/me/notifications/${encodeURIComponent(id)}/read`),
  // P01–P04
  myProfile: () => get<MyProfile>("/profiles/me"),
  saveProfile: (patch: { display_name?: string; about?: string; city?: string; intents?: IntentCode[]; gender_tag?: "mom" | "dad" | "other"; expected_version?: number }) =>
    send<MyProfile>("PATCH", "/profiles/me", patch),
  parent: (parentId: string) => get<{ parent: PublicParent; relationship: RelationView }>(`/parents/${encodeURIComponent(parentId)}`),
  recommendations: (filters: { role?: "any" | "mom" | "dad"; distance_miles?: number | null; cursor?: string | null } = {}) =>
    get<Page<Recommendation>>(`/recommendations${q({ role: filters.role, distance_miles: filters.distance_miles, cursor: filters.cursor })}`),
  // P05–P10
  polish: (text: string, language: string, key: string) =>
    send<{ original: string; polish: { id: string; text: string } }>("POST", "/question-polishes",
      { text, language, ai_consent_version: AI_CONSENT_VERSION, client_request_id: key }, 30000),
  ask: (body: { body: string; original_language: string; version_source: "original" | "polished"; polish_id?: string | null; anonymous: boolean; show_child_age: boolean; client_request_id: string }) =>
    send<{ question: Question; delivery: { recipient_count: number; state: string }; created: boolean }>("POST", "/questions", body, 20000),
  myQuestions: (params: { status?: "all" | "open" | "closed"; q?: string; cursor?: string | null; pageSize?: number } = {}) =>
    get<Page<Question>>(`/me/questions${q({ status: params.status, q: params.q, cursor: params.cursor, page_size: params.pageSize ?? 50 })}`),
  question: (questionId: string) => get<{ question: Question }>(`/questions/${encodeURIComponent(questionId)}`),
  transitionQuestions: (action: "close" | "delete", ids: { question_id: string; expected_version?: number }[], key: string) =>
    send<{ results: { question_id: string; ok: boolean; error?: { code: string } }[]; all_succeeded: boolean }>(
      "POST", "/questions/batch-transitions", { action, items: ids, confirmed: true, client_request_id: key }),
  // P11–P14
  deliveries: (tab: "waiting" | "replied" | "locked", cursor?: string | null, pageSize = 50) =>
    get<Page<Delivery>>(`/me/question-deliveries${q({ tab, cursor, page_size: pageSize })}`),
  respond: (deliveryId: string, body: string, key: string, expectedVersion?: number) =>
    send<{ reply: Reply; delivery: DeliveryMeta; created: boolean }>("POST", `/question-deliveries/${encodeURIComponent(deliveryId)}/responses`,
      { body, client_request_id: key, expected_version: expectedVersion }),
  replies: (questionId: string, cursor?: string | null) =>
    get<ReplyPage>(`/questions/${encodeURIComponent(questionId)}/replies${q({ cursor, page_size: 50 })}`),
  comments: (questionId: string, threadId: string, cursor?: string | null) =>
    get<Page<Comment> & { thread_id: string; can_post: boolean }>(`/questions/${encodeURIComponent(questionId)}/reply-threads/${encodeURIComponent(threadId)}/comments${q({ cursor, page_size: 50 })}`),
  comment: (questionId: string, threadId: string, body: string, key: string) =>
    send<{ comment: Comment; created: boolean }>("POST", `/questions/${encodeURIComponent(questionId)}/reply-threads/${encodeURIComponent(threadId)}/comments`,
      { body, client_message_id: key }),
  // P15–P19
  invitations: (direction: "received" | "sent", state = "pending") =>
    get<Page<Invitation>>(`/invitations${q({ direction, state, page_size: 50 })}`),
  invite: (parentId: string, key: string) =>
    send<{ invitation: Invitation | null; relationship: RelationView; created: boolean }>("POST", "/invitations", { target_parent_id: parentId, client_request_id: key }),
  decideInvitation: (invitationId: string, decision: "accept" | "decline", key: string) =>
    send<{ invitation: Invitation; relationship: RelationView }>("POST", `/invitations/${encodeURIComponent(invitationId)}/decisions`, { decision, client_request_id: key }),
  contacts: () => get<Page<Contact>>(`/me/contacts${q({ page_size: 50 })}`),
  disconnect: (relationshipId: string) =>
    send<{ state: string }>("DELETE", `/relationships/${encodeURIComponent(relationshipId)}${q({ confirmed: true })}`),
  blocks: () => get<Page<{ parent: PublicParent; blocked_at: string }>>(`/me/blocks${q({ page_size: 50 })}`),
  block: (parentId: string) => send<{ blocked: true; relationship: RelationView }>("PUT", `/me/blocks/${encodeURIComponent(parentId)}`, { confirmed: true }),
  unblock: (parentId: string) => send<{ blocked: false }>("DELETE", `/me/blocks/${encodeURIComponent(parentId)}${q({ confirmed: true })}`),
  // P20–P23
  inbox: (cursor?: string | null) => get<Page<InboxItem> & { summary: { pending_invitations: number; waiting_questions: number; unread_conversations: number } }>(`/me/inbox${q({ cursor, page_size: 50 })}`),
  openConversation: (parentId: string, key: string) =>
    send<{ conversation: Conversation }>("POST", "/conversations", { target_parent_id: parentId, client_request_id: key }),
  messages: (conversationId: string, cursor?: string | null) =>
    get<Page<Message> & { conversation: Conversation }>(`/conversations/${encodeURIComponent(conversationId)}/messages${q({ cursor, page_size: 50 })}`),
  sendMessage: (conversationId: string, text: string, key: string, mediaIds: string[] = []) =>
    send<{ message: Message; created: boolean }>("POST", `/conversations/${encodeURIComponent(conversationId)}/messages`,
      mediaIds.length ? { text, media_ids: mediaIds, client_message_id: key } : { text, client_message_id: key }, mediaIds.length ? 20000 : undefined),
  // P31–P33: one prepared image (data URI) in, a ready media id out.
  uploadImage: (dataUri: string, purpose: "message" | "avatar", key: string) =>
    send<{ media: { media_id: string; state: string; width: number | null; height: number | null }; created: boolean }>(
      "POST", "/media", { purpose, data_uri: dataUri, client_request_id: key }, 45000),
  mediaAccess: (mediaId: string) =>
    get<{ media: { media_id: string; width: number | null; height: number | null }; access: { url: string; expires_in_s: number } }>(
      `/media/${encodeURIComponent(mediaId)}/access`),
  // P30: voice is transcription only (D14) — the text comes back as an editable draft.
  transcribe: (audioBase64: string, locale: string, key: string) =>
    send<{ draft_text: string }>("POST", "/transcriptions",
      { audio_base64: audioBase64, locale, ai_consent_version: AI_CONSENT_VERSION, client_request_id: key }, 45000),
  markRead: (conversationId: string, seq: number) =>
    send<{ last_read_seq: number; unread_count: number }>("PUT", `/conversations/${encodeURIComponent(conversationId)}/read-cursor`, { last_read_seq: seq }),
  // Reports (Google Play UGC): a person reviews them; the author is never shown to the reporter.
  report: (body: { target_kind: ReportKind; target_id: string; reason: ReportReason; note?: string; block?: boolean }) =>
    send<{ report_id: string; status: "received"; blocked: boolean; block_available: boolean }>("POST", "/reports", body),
  // P24
  preferences: () => get<Preferences>("/preferences"),
  savePreferences: (patch: Partial<Omit<Preferences, "version">> & { expected_version?: number }) =>
    send<Preferences>("PATCH", "/preferences", patch),
  // P25–P28
  aiParticipation: (conversationId: string) => get<AIParticipation>(`/conversations/${encodeURIComponent(conversationId)}/ai-participation`),
  requestAI: (conversationId: string, noticeVersion: string, key: string, purpose: AIPurpose = "conversation_notes") =>
    send<{ request: ConsentRequest; created: boolean }>("POST", `/conversations/${encodeURIComponent(conversationId)}/ai-consent-requests`,
      { purpose, notice_version: noticeVersion, client_request_id: key }),
  decideAI: (requestId: string, decision: "allow" | "decline", noticeVersion: string, key: string, expectedVersion?: number) =>
    send<{ request: ConsentRequest }>("PUT", `/ai-consent-requests/${encodeURIComponent(requestId)}/my-decision`,
      { decision, notice_version: noticeVersion, client_request_id: key, expected_version: expectedVersion }),
  revokeAI: (conversationId: string, purpose?: AIPurpose) =>
    send<{ effective: boolean }>("DELETE", `/conversations/${encodeURIComponent(conversationId)}/ai-participation${q({ purpose })}`),
  // P29 returns a separate translation; it never changes the saved original.
  translateMessage: (messageId: string, targetLanguage: string, key: string) =>
    send<MessageTranslation>("POST", `/messages/${encodeURIComponent(messageId)}/translations`,
      { target_language: targetLanguage, ai_consent_version: AI_CONSENT_VERSION, client_request_id: key }, 30000),
};

export type MessageTranslation = {
  message_id: string; original: { text: string; language: string | null };
  translation: { id: string; kind: "translation"; state: string; text: string; target_language: string; created_at: string };
};

/** "约 1.5 英里" style label input; null when either parent shared no location. */
export function childAgeLabel(months: number | null | undefined, en: boolean): string | null {
  if (months === null || months === undefined) return null;
  const years = Math.floor(months / 12), rest = months % 12;
  if (en) return years ? `${years} yr${years > 1 ? "s" : ""}${rest ? ` ${rest} mo` : ""}` : `${rest} mo`;
  return years ? `${years}岁${rest ? `${rest}个月` : ""}` : `${rest}个月`;
}

/** "今天 09:35" / "11月3日" / "Today 09:35" / "Nov 3". */
export function shortTime(iso: string | null | undefined, en: boolean, now = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  if (t.toDateString() === now.toDateString()) return en ? `Today ${hm}` : `今天 ${hm}`;
  return en ? t.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : `${t.getMonth() + 1}月${t.getDate()}日`;
}
