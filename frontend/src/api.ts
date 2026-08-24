// Client for backend/main.py's /api/* routes. Grouped the same way as the
// route sections there (Children, Feed, Collections, ...) so the two stay
// easy to cross-reference.

import { API } from "./theme";
import { isPreviewMode, previewRequest } from "./preview-api";
import { storage } from "./utils/storage";

export type PersonalizedResourceStatus =
  | "research_on_open"
  | "reviewed"
  | "reviewed_fallback"
  | "consent_required"
  | "unavailable"
  | "urgent_suppressed"
  | string;

export type PersonalizedContentCategory = "authority" | "featured" | "case";

export type ResourceLocale = "en" | "zh-CN" | "zh-TW";

export type ResourceTranslationType =
  | "nuri_guide"
  | "official_translation"
  | "original";

export type ResourceReadiness =
  | "ready"
  | "preparing"
  | "retryable"
  | "unavailable";

export type PreparedLearningResource = {
  id: string;
  kind: "article" | "video";
  title: string;
  publisher: string;
  author?: string;
  updated_at?: string;
  language?: string;
  source_language?: ResourceLocale;
  display_locale?: ResourceLocale;
  chinese_guide?: string;
  translation_type?: ResourceTranslationType;
  translation_disclaimer?: string;
  spoken_language?: "mandarin" | "english" | "not_applicable" | string;
  estimated_minutes?: number;
  reading_minutes?: number;
  duration_minutes?: number;
  description?: string;
  url?: string;
  content_category?: PersonalizedContentCategory;
  [key: string]: unknown;
};

export type PreparedResourcePair = {
  pair_id: string;
  resources: PreparedLearningResource[];
};

export type PersonalizedFeedItem = {
  id: string;
  title: string;
  summary?: string;
  publisher?: string;
  topic?: string;
  topic_label?: string;
  content_category?: PersonalizedContentCategory;
  content_category_label?: string;
  content_category_eyebrow?: string;
  content_category_description?: string;
  delivery_title?: string;
  source_label?: string;
  language_label?: string;
  estimated_time_label?: string;
  applicable_stage?: string;
  child_age_context?: string;
  guide?: string;
  action_steps?: string[];
  personalization_reason?: string;
  is_conversation_match?: boolean;
  related_session_id?: string | null;
  context_created_at?: string | null;
  recommendation_id?: string | null;
  rank?: number;
  category_preference_weight?: number;
  is_primary_exposure_category?: boolean;
  resource_status?: PersonalizedResourceStatus;
  resource_readiness?: ResourceReadiness;
  resource_pair_complete?: boolean;
  prepared_content_set_id?: string | null;
  active_pair_id?: string | null;
  alternate_count?: number;
  alternate_resource_pairs?: PreparedResourcePair[];
  resources?: PreparedLearningResource[];
  research_status?: string;
  curation_mode?: string;
  resource_summary?: {
    preferred_locale?: string;
    categories?: Record<string, Record<string, number>>;
  };
};

export type PersonalizedFeedResponse = {
  items: PersonalizedFeedItem[];
  pending_items?: PersonalizedFeedItem[];
  personalization_mode: string;
  recommendation_set_id?: string | null;
  publication_state?: "ready" | "preparing" | string;
  feed_request_id?: string | null;
  model_version?: string | null;
  matched_topic?: string | null;
  related_session_id?: string | null;
  generated_at?: string;
  category_mix?: Record<PersonalizedContentCategory, number>;
  initial_content_category?: PersonalizedContentCategory;
};

export type PreparedFeedItem = {
  recommendation_id: string;
  content_category: PersonalizedContentCategory;
  delivery_title?: string;
  source_label?: string;
  language_label?: string;
  estimated_time_label?: string;
  applicable_stage?: string;
  child_age_context?: string;
  guide?: string;
  action_steps?: string[];
  resource_readiness: ResourceReadiness;
  resource_pair_complete: boolean;
  prepared_content_set_id?: string | null;
  active_pair_id?: string | null;
  alternate_count?: number;
  alternate_resource_pairs?: PreparedResourcePair[];
  resources?: PreparedLearningResource[];
  research_status?: string;
};

export type PrepareFeedResponse = {
  items: PreparedFeedItem[];
  recommendation_set_id?: string | null;
  publication_state?: "ready" | "preparing" | string;
  upgrade_state?: "ready" | "preparing" | string;
};

export type RecommendationEventName =
  | "feed_impression"
  | "card_open"
  | "detail_view"
  | "favorite"
  | "external_resource_click"
  | "continue_chat"
  | "detail_dwell"
  | "helpful"
  | "not_relevant"
  | "content_refresh";

export type RecommendationFeedbackReason =
  | "topic_mismatch"
  | "already_seen"
  | "repetitive"
  | "wrong_language"
  | "source_not_useful"
  | "too_long"
  | "too_commercial"
  | "not_now";

/**
 * Privacy-safe interaction data used to improve recommendation ordering.
 * Never add conversation text, names, email addresses, or other user content.
 */
export type RecommendationEventInput = {
  event: RecommendationEventName;
  card_id?: string;
  recommendation_id?: string;
  feed_request_id?: string;
  resource_id?: string;
  resource_kind?: "article" | "video";
  content_category?: "authority" | "featured" | "case";
  locale?: string;
  position?: number;
  duration_ms?: number;
  value?: number;
  reason?: RecommendationFeedbackReason;
};

export type MainConversationPreview = {
  has_conversation: boolean;
  session_id: string | null;
  title?: string | null;
  last_activity_at?: string | null;
  last_user_message?: {
    id: string;
    text: string;
    created_at?: string | null;
  } | null;
  last_message?: {
    id: string;
    role: "ai" | "user";
    text: string;
    created_at?: string | null;
  } | null;
  memory_preview?: {
    category: string;
    key: string;
    text: string;
    updated_at?: string;
  } | null;
};

function createRecommendationEventId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

// ── Token storage ────────────────────────────────────────────────────────────
const TOKEN_KEY = "auth_token";
// Last known onboarding state. Lets the launch route send a returning user to
// the right screen even when /auth/me is briefly unreachable, instead of
// treating an unanswered server as a signed-out user.
const ONBOARDED_KEY = "onboarding_completed";

async function getToken(): Promise<string | null> {
  return (await storage.secureGet(TOKEN_KEY, "")) || null;
}

export const auth = {
  TOKEN_KEY,
  setToken: (t: string) => storage.secureSet(TOKEN_KEY, t),
  clearToken: () =>
    Promise.all([storage.secureRemove(TOKEN_KEY), storage.removeItem(ONBOARDED_KEY)]),
  getToken,
  setOnboarded: (done: boolean) => storage.setItem(ONBOARDED_KEY, done),
  getOnboarded: () => storage.getItem(ONBOARDED_KEY, false),
};

// Budget for a full chat turn. Must exceed the backend's own OpenAI timeout,
// otherwise the client gives up while the server is still working — which just
// makes users resend and stack duplicate work.
const CHAT_TIMEOUT_MS = 90000;

// Carries the HTTP status so callers can tell "the server rejected this" from
// "the request never landed". Without it, a timeout is indistinguishable from a
// 401 — and treating the two alike is how a cold start became a forced logout.
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string, detail: string) {
    super(`API ${path} ${status}: ${detail}`);
    this.status = status;
  }
}

/** True only when the server actively rejected the credentials. */
export function isAuthError(err: unknown): boolean {
  return !!(err && typeof err === "object" && (err as any).status === 401);
}

// ── Fetch wrapper: attaches bearer token, applies a timeout ─────────────────
async function req<T = any>(path: string, init?: RequestInit, timeoutMs = 12000): Promise<T> {
  if (isPreviewMode) return previewRequest(path, init) as Promise<T>;
  const token = await getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const method = (init?.method || "GET").toUpperCase();
  const requestInit: RequestInit = {
    ...init,
    headers,
    // Personalized data must be re-read when a screen regains focus. Making
    // every GET explicit here also protects native-web builds and intermediary
    // browser caches that do not consistently honor response-only directives.
    ...(method === "GET" ? { cache: "no-store" as RequestCache } : {}),
  };

  const check = async (res: Response) => {
    if (!res.ok) throw new ApiError(res.status, path, await res.text());
    return res.json();
  };

  // timeoutMs=0 means no timeout (used for long-running generation calls)
  if (!timeoutMs) return check(await fetch(API + path, requestInit));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await check(
      await fetch(API + path, { ...requestInit, signal: controller.signal }),
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── SSE chat streaming ───────────────────────────────────────────────────────
// Thrown when the stream never started (no such route, non-200, wrong content
// type). Nothing was persisted server-side, so the caller can safely retry
// against the non-streaming endpoint. A failure *mid*-stream throws a plain
// Error instead: the user message is already saved, and retrying would double
// post it, so the caller should reload the thread rather than resend.
// Carries an explicit flag rather than relying on `instanceof`: subclassing
// Error survives transpilation poorly under Hermes/Babel, and a missed check
// here would silently disable the fallback.
export class StreamUnsupportedError extends Error {
  readonly streamUnsupported = true;
}

export function isStreamUnsupported(err: unknown): boolean {
  return !!(err && typeof err === "object" && (err as any).streamUnsupported);
}

// React Native's fetch resolves without a `body` stream; only web/RNW has one.
const SUPPORTS_FETCH_STREAM = (() => {
  try {
    return typeof TextDecoder !== "undefined" && !!new Response("").body;
  } catch {
    return false;
  }
})();

type SseEvent =
  | { type: "delta"; text: string }
  | { type: "done"; user_message: any; ai_messages: any[] }
  | { type: "error"; message?: string };

/** Feed raw response text in; get whole `data:` events out. */
function makeSseParser(onEvent: (e: SseEvent) => void) {
  let buffered = "";
  return (chunk: string) => {
    buffered += chunk;
    const frames = buffered.split("\n\n");
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          // A truncated frame is not worth failing the whole turn over.
        }
      }
    }
  };
}

/** Native transport: XHR exposes the response incrementally via onprogress. */
function xhrStream(
  url: string,
  headers: Record<string, string>,
  payload: string,
  feed: (chunk: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    let consumed = 0;
    let started = false;
    const drain = () => {
      const text: string = xhr.responseText ?? "";
      if (text.length > consumed) {
        feed(text.slice(consumed));
        consumed = text.length;
      }
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState === xhr.HEADERS_RECEIVED) {
        if (xhr.status < 200 || xhr.status >= 300) {
          xhr.abort();
          reject(new StreamUnsupportedError(`stream HTTP ${xhr.status}`));
          return;
        }
        started = true;
      }
    };
    xhr.onprogress = drain;
    xhr.onload = () => {
      drain();
      resolve();
    };
    xhr.onerror = () =>
      reject(started ? new Error("stream failed") : new StreamUnsupportedError("stream failed"));
    xhr.ontimeout = () => reject(new Error("stream timed out"));
    xhr.timeout = CHAT_TIMEOUT_MS;
    xhr.send(payload);
  });
}

/**
 * Stream one chat turn, invoking `onDelta` as text arrives. Resolves with the
 * same shape as the non-streaming endpoint.
 */
async function streamMessage(
  sid: string,
  body: any,
  onDelta: (chunk: string) => void,
): Promise<{ user_message: any; ai_messages: any[] }> {
  if (isPreviewMode) throw new StreamUnsupportedError("preview mode");

  const token = await getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${API}/chat/sessions/${sid}/messages/stream`;
  const payload = JSON.stringify(body);

  let result: { user_message: any; ai_messages: any[] } | null = null;
  let failure: string | null = null;
  const feed = makeSseParser((e) => {
    if (e.type === "delta") onDelta(e.text);
    else if (e.type === "done") result = { user_message: e.user_message, ai_messages: e.ai_messages };
    else if (e.type === "error") failure = e.message || "stream error";
  });

  if (!SUPPORTS_FETCH_STREAM) {
    await xhrStream(url, headers, payload, feed);
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
      if (!res.ok) throw new StreamUnsupportedError(`stream HTTP ${res.status}`);
      // A host that buffers the response (or an old backend) won't send SSE.
      if (!res.body || !(res.headers.get("content-type") || "").includes("text/event-stream")) {
        throw new StreamUnsupportedError("stream not supported by host");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (failure) throw new Error(failure);
  if (!result) throw new Error("stream ended without a result");
  return result;
}

export const api = {
  // ── Children ──────────────────────────────────────────────────────────────
  listChildren: () => req("/children"),
  addChild: (b: any) => req("/children", { method: "POST", body: JSON.stringify(b) }),
  updateChild: (id: string, b: any) =>
    req(`/children/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  deleteChild: (id: string) => req(`/children/${id}`, { method: "DELETE" }),

  // ── Feed ──────────────────────────────────────────────────────────────────
  getFeed: (shuffle = false) => req(`/feed${shuffle ? "?shuffle=true" : ""}`),
  getPersonalizedFeed: (count = 3, clientRefresh?: string) =>
    req<PersonalizedFeedResponse>(
      `/feed/personalized?count=${count}&presentation=category_cards${
        clientRefresh
          ? `&client_refresh=${encodeURIComponent(clientRefresh.slice(0, 128))}`
          : ""
      }`,
    ),
  preparePersonalizedFeed: (
    items: { card_id: string; recommendation_id: string }[],
  ) =>
    req<PrepareFeedResponse>(
      "/feed/research/prepare",
      { method: "POST", body: JSON.stringify({ items }) },
      110000,
    ),
  getCardDetail: (
    id: string,
    sessionId?: string,
    contextCreatedAt?: string,
    recommendationId?: string,
    contentCategory?: PersonalizedContentCategory,
    preparedContentSetId?: string,
  ) => {
    const query = [
      sessionId ? `session_id=${encodeURIComponent(sessionId)}` : "",
      contextCreatedAt
        ? `context_created_at=${encodeURIComponent(contextCreatedAt)}`
        : "",
      recommendationId
        ? `recommendation_id=${encodeURIComponent(recommendationId)}`
        : "",
      contentCategory
        ? `content_category=${encodeURIComponent(contentCategory)}`
        : "",
      preparedContentSetId
        ? `prepared_content_set_id=${encodeURIComponent(preparedContentSetId)}`
        : "",
    ].filter(Boolean).join("&");
    return req(`/feed/${id}/detail${query ? `?${query}` : ""}`);
  },
  // The detail first paints its reviewed fallback, then this longer request
  // replaces it with a citation-backed article/video pair for this category.
  getCardResearch: (
    id: string,
    sessionId?: string,
    contextCreatedAt?: string,
    recommendationId?: string,
    contentCategory?: PersonalizedContentCategory,
  ) => {
    const query = [
      sessionId ? `session_id=${encodeURIComponent(sessionId)}` : "",
      contextCreatedAt
        ? `context_created_at=${encodeURIComponent(contextCreatedAt)}`
        : "",
      recommendationId
        ? `recommendation_id=${encodeURIComponent(recommendationId)}`
        : "",
      contentCategory
        ? `content_category=${encodeURIComponent(contentCategory)}`
        : "",
    ].filter(Boolean).join("&");
    return req(
      `/feed/${id}/research${query ? `?${query}` : ""}`,
      { method: "POST" },
      110000
    );
  },
  getNextResourcePair: (
    id: string,
    sessionId?: string,
    contextCreatedAt?: string,
    recommendationId?: string,
    contentCategory?: PersonalizedContentCategory,
    excludeResourceIds: string[] = [],
    targetPairId?: string,
  ) => {
    const query = [
      "refresh=true",
      sessionId ? `session_id=${encodeURIComponent(sessionId)}` : "",
      contextCreatedAt
        ? `context_created_at=${encodeURIComponent(contextCreatedAt)}`
        : "",
      recommendationId
        ? `recommendation_id=${encodeURIComponent(recommendationId)}`
        : "",
      contentCategory
        ? `content_category=${encodeURIComponent(contentCategory)}`
        : "",
      excludeResourceIds.length
        ? `exclude_resource_ids=${encodeURIComponent(excludeResourceIds.slice(0, 20).join(","))}`
        : "",
      targetPairId
        ? `target_pair_id=${encodeURIComponent(targetPairId.slice(0, 160))}`
        : "",
    ].filter(Boolean).join("&");
    return req(
      `/feed/${id}/research?${query}`,
      { method: "POST" },
      110000,
    );
  },
  getAltCard: (exclude: string) =>
    req(`/feed/alt?exclude=${encodeURIComponent(exclude)}`),
  searchCards: (q: string, type?: string) =>
    req(`/feed/search?q=${encodeURIComponent(q)}${type ? `&type=${encodeURIComponent(type)}` : ""}`),
  generateCards: (b: { session_id?: string; keywords?: string[]; count?: number }) =>
    req(`/feed/generate`, { method: "POST", body: JSON.stringify(b) }, 0),

  // ── Collections ───────────────────────────────────────────────────────────
  listCollections: () => req(`/collections`),
  createCollection: (name: string) =>
    req(`/collections`, { method: "POST", body: JSON.stringify({ name }) }),
  renameCollection: (id: string, name: string) =>
    req(`/collections/${id}`, { method: "PUT", body: JSON.stringify({ name }) }),
  deleteCollection: (id: string) =>
    req(`/collections/${id}`, { method: "DELETE" }),

  // ── Favorites ─────────────────────────────────────────────────────────────
  listFavorites: () => req(`/favorites`),
  toggleFavorite: (card_id: string) =>
    req(`/favorites/toggle`, { method: "POST", body: JSON.stringify({ card_id }) }),
  saveFavorite: (card_id: string, collection_id: string) =>
    req(`/favorites/save`, { method: "POST", body: JSON.stringify({ card_id, collection_id }) }),

  // ── Analytics ─────────────────────────────────────────────────────────────
  trackEvent: (event: string, payload: any = {}) =>
    req(`/analytics`, { method: "POST", body: JSON.stringify({ event, ...payload }) }),

  trackRecommendationEvent: (payload: RecommendationEventInput) =>
    req(`/recommendations/events`, {
      method: "POST",
      body: JSON.stringify({
        client_event_id: createRecommendationEventId(),
        ...payload,
      }),
    }),

  // ── Chat ──────────────────────────────────────────────────────────────────
  startSession: (b: any) =>
    req(`/chat/sessions`, { method: "POST", body: JSON.stringify(b) }),
  listSessions: () => req(`/chat/sessions`),
  getMainConversationPreview: () => req<MainConversationPreview>(`/chat/main/preview`),
  // The server owns canonical-session selection. This endpoint is idempotent:
  // it returns the account's existing conversation and creates the first one
  // only when the account truly has none. The client must not infer identity
  // from legacy `source_card_id` values or create a duplicate itself.
  getOrStartMainSession: () =>
    req(`/chat/sessions`, { method: "POST", body: JSON.stringify({}) }),
  deleteSession: (sid: string) =>
    req(`/chat/sessions/${sid}`, { method: "DELETE" }),
  getMessages: (sid: string) => req(`/chat/sessions/${sid}/messages`),
  // A model turn can legitimately run past the 12s default. Aborting early
  // doesn't stop the backend, it just makes users resend and stack more work,
  // so this has to stay above the backend's own OpenAI timeout budget.
  sendMessage: (sid: string, b: any) =>
    req(
      `/chat/sessions/${sid}/messages`,
      { method: "POST", body: JSON.stringify(b) },
      CHAT_TIMEOUT_MS,
    ),
  streamMessage,

  // ── Tasks ─────────────────────────────────────────────────────────────────
  listTasks: (scope?: "today" | "week") =>
    req(`/tasks${scope ? `?scope=${scope}` : ""}`),
  createTask: (b: any) => req("/tasks", { method: "POST", body: JSON.stringify(b) }),
  updateTask: (id: string, b: any) =>
    req(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  deleteTask: (id: string) => req(`/tasks/${id}`, { method: "DELETE" }),
  clearCompletedTasks: () => req(`/tasks/clear-completed`, { method: "POST" }),
  taskInsights: () => req(`/tasks/insights`),

  // ── Privacy ───────────────────────────────────────────────────────────────
  getPrivacy: () => req(`/privacy`),
  setPrivacy: (b: any) => req(`/privacy`, { method: "PUT", body: JSON.stringify(b) }),
  wipe: () => req(`/privacy/wipe`, { method: "POST" }),

  // ── Auth ──────────────────────────────────────────────────────────────────
  register: (b: any) => req(`/auth/register`, { method: "POST", body: JSON.stringify(b) }),
  login: (b: any) => req(`/auth/login`, { method: "POST", body: JSON.stringify(b) }),
  // Generous timeout: this is the launch check, and it's the request most
  // likely to hit a serverless cold start.
  me: () => req(`/auth/me`, undefined, 30000),
  updateMe: (b: any) => req(`/auth/me`, { method: "PUT", body: JSON.stringify(b) }),
};
