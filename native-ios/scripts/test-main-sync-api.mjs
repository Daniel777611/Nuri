import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Actual client modules, memory-only credentials, and an invalid-domain
// transport. Never call production, a database, Google, or an AI provider.
function load(path, dependencies = {}) {
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)((name) => {
    assert.ok(name in dependencies, "unexpected dependency " + name);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const response = (value, status = 200) => ({ ok: status < 400, status,
  json: async () => value, text: async () => JSON.stringify(value) });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const video = (owner = "A") => ({
  id: "video-" + owner, card_id: "dailyvideo:video-" + owner, day: "2026-10-05",
  platform: "youtube", video_id: "mockVideo01", source_url: "https://video.invalid/" + owner,
  thumbnail_url: "https://image.invalid/" + owner, title: "Mock title", display_title: "Saved " + owner,
  channel: "Mock channel", speaker_kind: "institution", video_lang: "en", summary: "",
  concern: "Mock concern", basis: "conversation", locale: "en", nickname: owner, intro: "Mock intro",
});

function fixture() {
  const originalFetch = globalThis.fetch;
  const secure = new Map(), ordinary = new Map(), calls = [];
  const storage = {
    secureGet: async (key, fallback) => secure.get(key) ?? fallback,
    secureSet: async (key, value) => { secure.set(key, value); return true; },
    secureRemove: async (key) => { secure.delete(key); return true; },
    getItem: async (key, fallback) => ordinary.get(key) ?? fallback,
    setItem: async (key, value) => { ordinary.set(key, value); return true; },
    removeItem: async (key) => { ordinary.delete(key); return true; },
  };
  const policy = load("../src/aiConsent.ts");
  const client = load("../src/api.ts", {
    "./theme": { API: "https://main-sync.invalid/api" }, "./utils/storage": { storage },
    "./preview-api": { isPreviewMode: false }, "./aiConsent": policy,
    "./sessionBoundary": load("../src/sessionBoundary.ts"),
  });
  const f = { ...client, calls, secure, responder: null,
    restore: () => { globalThis.fetch = originalFetch; },
    async login(owner) { await client.auth.setToken("account-" + owner); },
    async permit() { await client.aiConsent.refresh(); await client.aiConsent.setAllowed(true, client.aiConsent.getState()); },
  };
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(url.startsWith("https://main-sync.invalid/api/"), "real network forbidden");
    const path = url.slice("https://main-sync.invalid/api".length);
    const owner = init.headers?.Authorization?.replace("Bearer account-", "") || "none";
    calls.push({ path, owner, method: init.method || "GET", body: init.body, cache: init.cache });
    if (path === "/auth/me") return response({ id: "user-" + owner });
    const custom = f.responder && await f.responder(path, init, owner);
    if (custom) return custom;
    if (path === "/auth/google") return response({ access_token: "mock-new-token", token_type: "bearer", user: { id: "mock-google-user", email: "mock@example.invalid" }, created: false });
    if (/^\/feed\/daily-video(?:\?|$)/.test(path) || /^\/feed\/daily-video\/[^/]+$/.test(path)) return response({ state: "ready", day: "2026-10-05", card: video(owner) });
    if (path.endsWith("/summary")) return response({ summary: "Mock summary" });
    if (path.endsWith("/events")) return response({ recorded: true }, 202);
    if (path === "/chat/main/checkin") return response({ state: "ready", id: "checkin-" + owner, session_id: "session-" + owner, topic: "Mock topic", line: "Mock line", opened: false });
    if (path.endsWith("/open")) return response({ session_id: "session-" + owner });
    throw new Error("unexpected fixture route " + path);
  };
  return f;
}

test("new generation / summary / check-in / events fail closed without permission; saved video is read-only", async () => {
  const f = fixture();
  try {
    await f.login("A");
    for (const run of [() => f.api.getDailyVideo(), () => f.api.getDailyVideoSummary("video-A"),
      () => f.api.dailyVideoEvent("video-A", "open"), () => f.api.getMainCheckin(), () => f.api.openMainCheckin("checkin-A")]) {
      await assert.rejects(run(), (error) => error.aiConsentRequired === true);
    }
    assert.ok(f.calls.every((call) => call.path === "/auth/me"));
    f.calls.length = 0;
    const saved = await f.api.getDailyVideoById("video-A");
    assert.equal(saved.card.display_title, "Saved A");
    assert.deepEqual(f.calls.map(({ path, method, cache }) => ({ path, method, cache })),
      [{ path: "/feed/daily-video/video-A", method: "GET", cache: "no-store" }]);
    assert.equal(f.aiConsent.getState().status, "not_allowed");
  } finally { f.restore(); }
});

test("exact method/path/body contracts match main's daily-video and check-in endpoints", async () => {
  const f = fixture();
  try {
    await f.login("A"); await f.permit(); f.calls.length = 0;
    assert.equal((await f.api.getDailyVideo()).state, "ready");
    assert.equal((await f.api.getDailyVideoSummary("row /?#")).summary, "Mock summary");
    for (const event of ["open", "source_click", "chat"]) assert.equal((await f.api.dailyVideoEvent("row /?#", event)).recorded, true);
    assert.equal((await f.api.getMainCheckin()).state, "ready");
    assert.deepEqual(await f.api.openMainCheckin("check /?#"), { session_id: "session-A" });
    assert.match(f.calls[0].path, /^\/feed\/daily-video(?:\?tz=[^&]+)?$/);
    assert.equal(f.calls[1].path, "/feed/daily-video/row%20%2F%3F%23/summary");
    assert.deepEqual(f.calls.slice(2, 5).map(({ method, body, path }) => [method, JSON.parse(body), path]),
      ["open", "source_click", "chat"].map((event) => ["POST", { event }, "/feed/daily-video/row%20%2F%3F%23/events"]));
    assert.deepEqual(f.calls.slice(5).map(({ method, path }) => [method, path]),
      [["GET", "/chat/main/checkin"], ["POST", "/chat/main/checkin/check%20%2F%3F%23/open"]]);
  } finally { f.restore(); }
});

for (const status of [401, 404, 503]) test("video HTTP " + status + " remains an honest error and never clears identity", async () => {
  const f = fixture();
  try {
    await f.login("A"); f.responder = () => response({ detail: "fixture failure" }, status);
    await assert.rejects(f.api.getDailyVideoById("video-A"), (error) => error.status === status);
    assert.equal(await f.auth.getToken(), "account-A");
  } finally { f.restore(); }
});

for (const operation of ["saved", "generated", "summary", "checkin", "open", "google"]) {
  test("late A " + operation + " response cannot be published in B's session", async () => {
    const f = fixture(), held = deferred();
    try {
      await f.login("A"); await f.permit();
      f.responder = () => ({ ...response(null), json: () => held.promise });
      const call = operation === "saved" ? f.api.getDailyVideoById("video-A")
        : operation === "generated" ? f.api.getDailyVideo()
        : operation === "summary" ? f.api.getDailyVideoSummary("video-A")
        : operation === "checkin" ? f.api.getMainCheckin()
        : operation === "open" ? f.api.openMainCheckin("checkin-A")
        : f.api.googleLogin({ credential: "mock-id-token-only", language: "en" });
      const rejected = assert.rejects(call, (error) => error.name === "SessionChangedError");
      await tick(); await f.login("B"); held.resolve({ privateFixture: "old-A" });
      await rejected;
      assert.equal(await f.auth.getToken(), "account-B");
    } finally { f.restore(); }
  });
}

test("Google exchange is not AI-gated and cannot install a session itself", async () => {
  const f = fixture();
  try {
    await f.login("A");
    const result = await f.api.googleLogin({ credential: "mock-id-token-only", language: "zh-TW" });
    assert.equal(result.created, false); assert.equal(result.token_type, "bearer");
    assert.equal(await f.auth.getToken(), "account-A");
    assert.deepEqual(f.calls.map(({ path, method, body }) => ({ path, method, body: JSON.parse(body) })),
      [{ path: "/auth/google", method: "POST", body: { credential: "mock-id-token-only", language: "zh-TW" } }]);
  } finally { f.restore(); }
});

for (const [status, code] of [[401, "GOOGLE_TOKEN_INVALID"], [503, "GOOGLE_SIGNIN_UNAVAILABLE"]]) {
  test("Google " + code + " preserves the current NURI identity and stable error classification", async () => {
    const f = fixture();
    try {
      await f.login("A"); f.responder = () => response({ detail: code }, status);
      await assert.rejects(f.api.googleLogin({ credential: "mock-id-token-only" }),
        (error) => error.status === status && f.apiErrorDetail(error) === code);
      assert.equal(await f.auth.getToken(), "account-A");
    } finally { f.restore(); }
  });
}

test("read exceptions and safe permission return paths are exact, not arbitrary video URLs", () => {
  const { requiresAIConsent } = load("../src/aiConsent.ts");
  assert.equal(requiresAIConsent("/feed/daily-video/video-A"), false);
  for (const path of ["/feed/daily-video", "/feed/daily-video/video-A/summary", "/feed/daily-video/video-A/events", "/chat/main/checkin"]) {
    assert.equal(requiresAIConsent(path), true, path);
  }
  assert.equal(requiresAIConsent("/feed/daily-video/video-A", { method: "POST" }), true);
  const { aiPermissionReturnPath } = load("../src/aiPermissionNavigation.ts");
  assert.equal(aiPermissionReturnPath("/daily-video"), "/daily-video");
  for (const value of ["https://outside.invalid/daily-video", "/daily-video?next=//outside.invalid", "/daily-video/../login", ["/daily-video"]]) assert.equal(aiPermissionReturnPath(value), null);
  const { safeNotificationRoute } = load("../src/nativePushRuntime.ts");
  assert.equal(safeNotificationRoute("/notifications/12345678-1234-1234-1234-123456789abc"), "/notifications/12345678-1234-1234-1234-123456789abc");
  assert.equal(safeNotificationRoute("/daily-video?id=video-A"), null, "APNs stays on the owned notification lookup, not arbitrary content URLs");
});

test("preview video/check-in/Google fixtures use the same shapes and check-in open is idempotent", async () => {
  const { previewRequest } = load("../src/preview-api.ts");
  const daily = await previewRequest("/feed/daily-video?tz=UTC");
  assert.equal(daily.card.platform, "youtube"); assert.equal(daily.card.summary, "");
  assert.equal(daily.card.card_id, "dailyvideo:" + daily.card.id);
  assert.equal((await previewRequest("/feed/daily-video/preview-daily-video")).card.id, daily.card.id);
  assert.equal(typeof (await previewRequest("/feed/daily-video/preview-daily-video/summary")).summary, "string");
  assert.deepEqual(await previewRequest("/feed/daily-video/preview-daily-video/events", { method: "POST", body: '{"event":"open"}' }), { recorded: true });
  const first = await previewRequest("/chat/main/checkin"); assert.equal(first.state, "ready");
  const opened = await previewRequest("/chat/main/checkin/preview-checkin/open", { method: "POST" });
  await previewRequest("/chat/main/checkin/preview-checkin/open", { method: "POST" });
  const messages = await previewRequest("/chat/sessions/" + opened.session_id + "/messages");
  assert.equal(messages.filter((message) => message.id === "checkin-preview").length, 1);
  assert.equal((await previewRequest("/chat/main/checkin")).opened, true);
  const google = await previewRequest("/auth/google", { method: "POST", body: '{"credential":"local-only-fixture"}' });
  assert.equal(google.token_type, "bearer"); assert.equal(google.created, false); assert.ok(google.user.id);
  assert.equal((await previewRequest("/notifications/preview-video/open", { method: "POST" })).kind, "daily_video");
});
