import { API } from "./theme";
import { storage } from "./utils/storage";

const TOKEN_KEY = "auth_token";

async function getToken(): Promise<string | null> {
  return (await storage.secureGet(TOKEN_KEY, "")) || null;
}

export const auth = {
  TOKEN_KEY,
  setToken: (t: string) => storage.secureSet(TOKEN_KEY, t),
  clearToken: () => storage.secureRemove(TOKEN_KEY),
  getToken,
};

async function req<T = any>(path: string, init?: RequestInit, timeoutMs = 12000): Promise<T> {
  const token = await getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(API + path, { ...init, headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${path} ${res.status}: ${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  listChildren: () => req("/children"),
  addChild: (b: any) => req("/children", { method: "POST", body: JSON.stringify(b) }),
  updateChild: (id: string, b: any) =>
    req(`/children/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  deleteChild: (id: string) => req(`/children/${id}`, { method: "DELETE" }),

  getFeed: (shuffle = false) => req(`/feed${shuffle ? "?shuffle=true" : ""}`),
  getCardDetail: (id: string) => req(`/feed/${id}/detail`),
  getAltCard: (exclude: string) =>
    req(`/feed/alt?exclude=${encodeURIComponent(exclude)}`),
  searchCards: (q: string, type?: string) =>
    req(`/feed/search?q=${encodeURIComponent(q)}${type ? `&type=${encodeURIComponent(type)}` : ""}`),
  generateCards: (b: { session_id?: string; keywords?: string[]; count?: number }) =>
    req(`/feed/generate`, { method: "POST", body: JSON.stringify(b) }),
  listFavorites: () => req(`/favorites`),
  toggleFavorite: (card_id: string) =>
    req(`/favorites/toggle`, { method: "POST", body: JSON.stringify({ card_id }) }),

  trackEvent: (event: string, payload: any = {}) =>
    req(`/analytics`, { method: "POST", body: JSON.stringify({ event, ...payload }) }),

  startSession: (b: any) =>
    req(`/chat/sessions`, { method: "POST", body: JSON.stringify(b) }),
  listSessions: () => req(`/chat/sessions`),
  deleteSession: (sid: string) =>
    req(`/chat/sessions/${sid}`, { method: "DELETE" }),
  getMessages: (sid: string) => req(`/chat/sessions/${sid}/messages`),
  sendMessage: (sid: string, b: any) =>
    req(`/chat/sessions/${sid}/messages`, {
      method: "POST",
      body: JSON.stringify(b),
    }),

  listTasks: (scope?: "today" | "week") =>
    req(`/tasks${scope ? `?scope=${scope}` : ""}`),
  updateTask: (id: string, b: any) =>
    req(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  taskInsights: () => req(`/tasks/insights`),

  getPrivacy: () => req(`/privacy`),
  setPrivacy: (b: any) => req(`/privacy`, { method: "PUT", body: JSON.stringify(b) }),
  wipe: () => req(`/privacy/wipe`, { method: "POST" }),

  register: (b: any) => req(`/auth/register`, { method: "POST", body: JSON.stringify(b) }),
  login: (b: any) => req(`/auth/login`, { method: "POST", body: JSON.stringify(b) }),
  me: () => req(`/auth/me`),
};
