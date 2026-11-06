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
  intents: IntentCode[]; role: "mom" | "dad" | null; avatar: { media_id: string } | null; anonymous?: boolean;
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
  last_message_seq: number | null; last_message_at: string | null;
};
export type InboxItem = Conversation & {
  kind: "conversation"; unread_count: number;
  last_message: { preview: string; sender: "me" | "parent"; seq: number } | null;
};
export type Message = {
  message_id: string; conversation_id: string; seq: number; sender: "me" | "parent"; text: string;
  media: { media_id: string }[]; created_at: string; state: "saved"; client_message_id: string | null;
};
export type Recommendation = { parent: PublicParent; distance_miles: number | null; shared_intents: IntentCode[]; relationship: RelationView };
export type Preferences = {
  parent_message_notifications_enabled: boolean; profile_hidden: boolean; auto_translate_messages: boolean; version: number;
};
export type ConsentRequest = {
  request_id: string; purpose: string; notice_version: string; state: "pending" | "effective" | "declined" | "revoked" | "superseded";
  epoch: number; version: number; initiated_by: "me" | "parent"; my_decision: "allow" | "decline" | "pending";
  parent_decision: "allow" | "decline" | "pending"; effective: boolean;
};
export type AIParticipation = {
  conversation_id: string; epoch: number; effective: boolean; notice_version: string;
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

export const communityApi = {
  // P01–P04
  myProfile: () => get<MyProfile>("/profiles/me"),
  saveProfile: (patch: { display_name?: string; about?: string; city?: string; intents?: IntentCode[]; expected_version?: number }) =>
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
  myQuestions: (params: { status?: "all" | "open" | "closed"; q?: string; cursor?: string | null } = {}) =>
    get<Page<Question>>(`/me/questions${q({ status: params.status, q: params.q, cursor: params.cursor, page_size: 50 })}`),
  question: (questionId: string) => get<{ question: Question }>(`/questions/${encodeURIComponent(questionId)}`),
  transitionQuestions: (action: "close" | "delete", ids: { question_id: string; expected_version?: number }[], key: string) =>
    send<{ results: { question_id: string; ok: boolean; error?: { code: string } }[]; all_succeeded: boolean }>(
      "POST", "/questions/batch-transitions", { action, items: ids, confirmed: true, client_request_id: key }),
  // P11–P14
  deliveries: (tab: "waiting" | "replied" | "locked", cursor?: string | null) =>
    get<Page<Delivery>>(`/me/question-deliveries${q({ tab, cursor, page_size: 50 })}`),
  respond: (deliveryId: string, body: string, key: string, expectedVersion?: number) =>
    send<{ reply: Reply; delivery: DeliveryMeta; created: boolean }>("POST", `/question-deliveries/${encodeURIComponent(deliveryId)}/responses`,
      { body, client_request_id: key, expected_version: expectedVersion }),
  replies: (questionId: string) =>
    get<Page<Reply> & { question: Question; all_thread: { thread_id: "all"; comment_count: number; can_post: boolean } | null }>(
      `/questions/${encodeURIComponent(questionId)}/replies${q({ page_size: 50 })}`),
  comments: (questionId: string, threadId: string) =>
    get<Page<Comment> & { can_post: boolean }>(`/questions/${encodeURIComponent(questionId)}/reply-threads/${encodeURIComponent(threadId)}/comments${q({ page_size: 50 })}`),
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
  inbox: () => get<Page<InboxItem> & { summary: { pending_invitations: number; waiting_questions: number; unread_conversations: number } }>(`/me/inbox${q({ page_size: 50 })}`),
  openConversation: (parentId: string, key: string) =>
    send<{ conversation: Conversation }>("POST", "/conversations", { target_parent_id: parentId, client_request_id: key }),
  messages: (conversationId: string, cursor?: string | null) =>
    get<Page<Message> & { conversation: Conversation }>(`/conversations/${encodeURIComponent(conversationId)}/messages${q({ cursor, page_size: 50 })}`),
  sendMessage: (conversationId: string, text: string, key: string) =>
    send<{ message: Message; created: boolean }>("POST", `/conversations/${encodeURIComponent(conversationId)}/messages`, { text, client_message_id: key }),
  markRead: (conversationId: string, seq: number) =>
    send<{ last_read_seq: number; unread_count: number }>("PUT", `/conversations/${encodeURIComponent(conversationId)}/read-cursor`, { last_read_seq: seq }),
  // P24
  preferences: () => get<Preferences>("/preferences"),
  savePreferences: (patch: Partial<Omit<Preferences, "version">> & { expected_version?: number }) =>
    send<Preferences>("PATCH", "/preferences", patch),
  // P25–P28
  aiParticipation: (conversationId: string) => get<AIParticipation>(`/conversations/${encodeURIComponent(conversationId)}/ai-participation`),
  requestAI: (conversationId: string, noticeVersion: string, key: string) =>
    send<{ request: ConsentRequest; created: boolean }>("POST", `/conversations/${encodeURIComponent(conversationId)}/ai-consent-requests`,
      { purpose: "conversation_notes", notice_version: noticeVersion, client_request_id: key }),
  decideAI: (requestId: string, decision: "allow" | "decline", noticeVersion: string, key: string) =>
    send<{ request: ConsentRequest }>("PUT", `/ai-consent-requests/${encodeURIComponent(requestId)}/my-decision`,
      { decision, notice_version: noticeVersion, client_request_id: key }),
  revokeAI: (conversationId: string) =>
    send<{ effective: boolean }>("DELETE", `/conversations/${encodeURIComponent(conversationId)}/ai-participation`),
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
