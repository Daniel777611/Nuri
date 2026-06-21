import { API } from "./theme";

async function req<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} ${res.status}: ${text}`);
  }
  return res.json();
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
  listFavorites: () => req(`/favorites`),
  toggleFavorite: (card_id: string) =>
    req(`/favorites/toggle`, { method: "POST", body: JSON.stringify({ card_id }) }),

  trackEvent: (event: string, payload: any = {}) =>
    req(`/analytics`, { method: "POST", body: JSON.stringify({ event, ...payload }) }),

  startSession: (b: any) =>
    req(`/chat/sessions`, { method: "POST", body: JSON.stringify(b) }),
  listSessions: () => req(`/chat/sessions`),
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
};
