// Native Lab permission is not a cloud privacy/training preference. Never
// infer it from history, research, registration, or an earlier app install.
export const AI_CONSENT_VERSION = "2026-10-01.1";
export const AI_PROVIDER = "OpenAI";
export const AI_PRIVACY_URL = "https://nurifam.com/privacy";
export const AI_PROVIDER_DATA_URL = "https://developers.openai.com/api/docs/guides/your-data";

export type AIConsentState = {
  status: "unknown" | "loading" | "signed_out" | "not_allowed" | "allowed" | "error";
  userId: string | null;
  session: number;
  version: string;
  // Classification only; never retain the backend response body or token.
  failure?: "session" | "unavailable";
};
type Context = { token: string; userId: string; session: number };
export type AIConsentLease = Context & { decision: number };
type Storage = {
  secureGet(key: string, fallback: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<boolean>;
  getItem(key: string, fallback: boolean): Promise<boolean | null>;
  setItem(key: string, value: boolean): Promise<boolean>;
};

export class AIConsentError extends Error {
  readonly aiConsentRequired = true;
  constructor(public readonly code: "AI_CONSENT_REQUIRED" | "AI_SESSION_CHANGED" | "AI_CONSENT_STORAGE_FAILED") {
    super(code);
    this.name = "AIConsentError";
  }
}

/** Conservative API boundary: even a GET can start personalized generation.
 * Exact read-only exceptions are audited against the shared backend. Do not
 * generalize these to all GETs: daily-post can invoke OpenAI on first load. */
export function requiresAIConsent(path: string, init?: RequestInit): boolean {
  const route = path.split("?")[0];
  const method = (init?.method || "GET").toUpperCase();
  if (method === "GET" && (["/feed", "/feed/search", "/feed/alt", "/chat/main/preview"].includes(route)
      || /^\/feed\/[a-zA-Z0-9_-]+\/detail$/.test(route)
      || /^\/feed\/daily-post\/[a-zA-Z0-9_-]+$/.test(route))) return false;
  if (route.startsWith("/feed")) return true;
  if (route === "/chat/main/preview" || route === "/chat/transcribe") return true;
  if (route.startsWith("/chat") && method !== "GET" && method !== "DELETE") return true;
  if (/^\/notifications\/[^/]+\/open$/.test(route)) return true;
  if (route === "/tasks/insights") return true;
  if ((route === "/auth/me" || route.startsWith("/children") || route.startsWith("/tasks"))
      && ["POST", "PUT", "PATCH"].includes(method)) return true;
  if (route === "/recommendations/events" || route === "/analytics") return true;
  if (route === "/privacy" && method === "PUT") {
    // Disabling a cloud preference must remain available without permission.
    try {
      const body = JSON.parse(String(init?.body || "{}"));
      return body.daily_push === true || body.allow_external_content_research === true || body.allow_history_training === true;
    } catch { return true; }
  }
  return false;
}

export class AIConsentController {
  private session = 0;
  private decision = 0;
  private context: Context | null = null;
  private blocked = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(state: AIConsentState) => void>();
  private state: AIConsentState = { status: "unknown", userId: null, session: 0, version: AI_CONSENT_VERSION };

  constructor(private readonly deps: {
    storage: Storage;
    getToken(): Promise<string | null>;
    // Must be the authenticated /auth/me result, never an unverified JWT claim.
    resolveUser(token: string): Promise<string>;
  }) {}

  getState = (): AIConsentState => ({ ...this.state });
  subscribe = (listener: (state: AIConsentState) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(status: AIConsentState["status"], userId = this.context?.userId || null, failure?: AIConsentState["failure"]) {
    this.state = { status, userId, session: this.session, version: AI_CONSENT_VERSION, ...(failure ? { failure } : {}) };
    this.listeners.forEach((listener) => { try { listener(this.getState()); } catch { /* UI cannot bypass the gate. */ } });
  }
  sessionChanged = () => {
    this.session++;
    this.decision++;
    this.context = null;
    this.publish("unknown");
  };
  private key(userId: string) { return `ai_consent.${AI_CONSENT_VERSION}.${userId}`; }
  private denyKey(userId: string) { return `${this.key(userId)}.deny`; }
  private same(context: Context) {
    return context.session === this.session && this.context?.token === context.token && this.context.userId === context.userId;
  }
  private async current(context: Context) {
    const token = await this.deps.getToken();
    if (!this.same(context) || token !== context.token) throw new AIConsentError("AI_SESSION_CHANGED");
  }
  private async identify(expectedToken?: string | null): Promise<Context> {
    const session = this.session;
    const token = await this.deps.getToken();
    if (session !== this.session || (expectedToken !== undefined && token !== expectedToken)) throw new AIConsentError("AI_SESSION_CHANGED");
    if (!token) { this.publish("signed_out"); throw new AIConsentError("AI_CONSENT_REQUIRED"); }
    if (this.context?.token === token && this.context.session === session) return this.context;
    const userId = await this.deps.resolveUser(token);
    if (session !== this.session || typeof userId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) throw new AIConsentError("AI_SESSION_CHANGED");
    const currentToken = await this.deps.getToken();
    if (session !== this.session || currentToken !== token) throw new AIConsentError("AI_SESSION_CHANGED");
    return this.context = { token, userId, session };
  }
  private async read(context: Context, decision: number): Promise<boolean> {
    const [raw, denied] = await Promise.all([
      this.deps.storage.secureGet(this.key(context.userId), ""),
      // Deny-only journal: missing/unreadable metadata is NOT permission. It
      // protects restore when one persistence medium fails during withdrawal.
      this.deps.storage.getItem(this.denyKey(context.userId), true),
    ]);
    await this.current(context);
    if (decision !== this.decision) throw new AIConsentError("AI_SESSION_CHANGED");
    let record: any = null;
    try { record = JSON.parse(raw || ""); } catch { /* absent or corrupt => denied */ }
    return !this.blocked.has(context.userId) && denied === false && record?.allowed === true
      && record.userId === context.userId && record.version === AI_CONSENT_VERSION && record.provider === AI_PROVIDER;
  }
  refresh = async (): Promise<AIConsentState> => {
    const session = this.session;
    const decision = this.decision;
    this.publish("loading");
    try {
      const context = await this.identify();
      const allowed = await this.read(context, decision);
      if (!this.same(context) || decision !== this.decision) return this.getState();
      this.publish(allowed ? "allowed" : "not_allowed");
    } catch (error) {
      if (session === this.session && decision === this.decision && this.state.status !== "signed_out") {
        const status = error && typeof error === "object" && "status" in error ? error.status : null;
        this.publish("error", null, status === 401 ? "session" : "unavailable");
      }
      if (!(error instanceof AIConsentError)) throw error;
    }
    return this.getState();
  };
  authorize = async (token: string | null): Promise<AIConsentLease> => {
    const context = await this.identify(token);
    const decision = this.decision;
    const allowed = await this.read(context, decision);
    if (!this.same(context) || decision !== this.decision) throw new AIConsentError("AI_SESSION_CHANGED");
    if (!allowed) {
      this.publish("not_allowed");
      throw new AIConsentError("AI_CONSENT_REQUIRED");
    }
    this.publish("allowed");
    return { ...context, decision };
  };
  // Invoke immediately before fetch/xhr.send, with no await in between.
  assertCurrent = (lease: AIConsentLease) => {
    if (!this.same(lease) || lease.decision !== this.decision || this.blocked.has(lease.userId)) throw new AIConsentError("AI_SESSION_CHANGED");
  };
  setAllowed = (allowed: boolean, expected: AIConsentState): Promise<boolean> => {
    const context = this.context;
    if (!context || expected.version !== AI_CONSENT_VERSION || expected.session !== this.session || expected.userId !== context.userId) return Promise.resolve(false);
    const decision = ++this.decision;
    this.blocked.add(context.userId); // Withdrawal gates the next request synchronously.
    this.publish("not_allowed");
    const write = async () => {
      await this.current(context);
      if (decision !== this.decision) return false;
      const journal = allowed ? true : await this.deps.storage.setItem(this.denyKey(context.userId), true);
      const saved = await this.deps.storage.secureSet(this.key(context.userId), JSON.stringify({
        version: AI_CONSENT_VERSION, provider: AI_PROVIDER, userId: context.userId, allowed, decidedAt: new Date().toISOString(),
      }));
      await this.current(context);
      if (decision !== this.decision) return false;
      const permitted = allowed && saved ? await this.deps.storage.setItem(this.denyKey(context.userId), false) : journal;
      await this.current(context);
      if (decision !== this.decision) return false;
      if (!saved || !permitted) throw new AIConsentError("AI_CONSENT_STORAGE_FAILED");
      if (allowed) this.blocked.delete(context.userId);
      this.publish(allowed ? "allowed" : "not_allowed");
      return true;
    };
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => {});
    return next;
  };
}
