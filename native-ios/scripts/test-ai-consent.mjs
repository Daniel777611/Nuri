import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function load(path, dependencies = {}, jsx = false) {
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: jsx ? ts.JsxEmit.ReactJSX : undefined },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output)((name) => {
    assert.ok(name in dependencies, "unexpected dependency " + name);
    return dependencies[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}
const policy = load("../src/aiConsent.ts");
const copy = load("../src/aiConsentCopy.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const nativeResponse = globalThis.Response;

function fixture({ nativeXHR = false, values = new Map(), ordinary = new Map() } = {}) {
  const calls = [];
  const secureReads = [];
  const writes = [];
  let readBarrier = null;
  let writeBarrier = null;
  let failSecureWrite = false;
  let failOrdinaryRead = false;
  let failSecureRead = false;
  const storage = {
    secureGet: async (key, fallback) => {
      if (key.startsWith("ai_consent.")) {
        secureReads.push(key);
        const value = values.get(key) ?? fallback;
        if (readBarrier) await readBarrier.promise;
        return failSecureRead ? fallback : value;
      }
      return values.get(key) ?? fallback;
    },
    secureSet: async (key, value) => {
      if (key.startsWith("ai_consent.")) {
        writes.push([key, value]);
        if (writeBarrier) await writeBarrier.promise;
        if (failSecureWrite) return false;
      }
      values.set(key, value); return true;
    },
    secureRemove: async (key) => { values.delete(key); return true; },
    getItem: async (key, fallback) => failOrdinaryRead && key.startsWith("ai_consent.") ? fallback : ordinary.get(key) ?? fallback,
    setItem: async (key, value) => { ordinary.set(key, value); return true; },
    removeItem: async (key) => { ordinary.delete(key); return true; },
  };
  const oldResponse = globalThis.Response;
  if (nativeXHR) globalThis.Response = class { constructor() { throw new Error("native has no fetch stream"); } };
  const client = load("../src/api.ts", {
    "./theme": { API: "https://nuri.invalid/api" }, "./preview-api": { isPreviewMode: false },
    "./utils/storage": { storage }, "./aiConsent": policy,
    "./sessionBoundary": load("../src/sessionBoundary.ts"),
  });
  globalThis.Response = oldResponse;
  const response = async (url, init = {}) => {
    const path = url.replace("https://nuri.invalid/api", "");
    calls.push({ path, method: init.method || "GET", body: init.body, owner: init.headers?.Authorization });
    if (path === "/auth/me") return { ok: true, status: 200, json: async () => ({ id: init.headers?.Authorization === "Bearer account-B" ? "user-B" : "user-A" }) };
    if (path.endsWith("/stream")) return new nativeResponse('data: {"type":"done","user_message":{"id":"u"},"ai_messages":[]}\n\n', { headers: { "content-type": "text/event-stream" } });
    return { ok: true, status: 200, json: async () => ({ id: "session", text: "mock transcript", items: [] }) };
  };
  globalThis.fetch = response;
  globalThis.XMLHttpRequest = class {
    HEADERS_RECEIVED = 2;
    readyState = 4;
    status = 200;
    responseText = 'data: {"type":"done","user_message":{"id":"u"},"ai_messages":[]}\n\n';
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    getResponseHeader() { return "text/event-stream"; }
    send(body) { calls.push({ path: this.url.replace("https://nuri.invalid/api", ""), method: this.method, body, xhr: true }); this.onload(); }
  };
  const permit = async () => {
    await client.aiConsent.refresh();
    assert.equal(await client.aiConsent.setAllowed(true, client.aiConsent.getState()), true);
  };
  return { ...client, permit, calls, values, ordinary, secureReads, writes,
    pauseReads: () => readBarrier = deferred(), releaseReads: () => { const b = readBarrier; readBarrier = null; b.resolve(); },
    pauseWrites: () => writeBarrier = deferred(), releaseWrites: () => { const b = writeBarrier; writeBarrier = null; b.resolve(); },
    failSecureWrites: () => { failSecureWrite = true; },
    failSecureReads: () => { failSecureRead = true; },
    failOrdinaryReads: () => { failOrdinaryRead = true; },
  };
}
const aiCalls = (f) => f.calls.filter((call) => call.path !== "/auth/me" || call.method !== "GET");
const blocked = (error) => error.aiConsentRequired === true;

test("fresh/restored account has no assumed permission; auto greeting and home effects never reach network", async () => {
  const f = fixture(); await f.auth.setToken("account-A");
  for (const run of [() => f.api.getOrStartMainSession(), () => f.api.startSession({ child_id: "child" }), () => f.api.getDailyPost(), () => f.api.getMainConversationPreview(), () => f.api.getPersonalizedFeed()]) await assert.rejects(run(), blocked);
  assert.deepEqual(aiCalls(f), []);
  assert.ok(f.calls.every((call) => call.path === "/auth/me"));
  assert.equal(f.aiConsent.getState().status, "not_allowed");
});

test("every actual profile/text/audio/image/context adapter is fail-closed, not only composer UI", async () => {
  const f = fixture(); await f.auth.setToken("account-A");
  const operations = [
    () => f.api.addChild({ nickname: "mock" }), () => f.api.updateChild("child", { birth_date: "2020-01-01" }), () => f.api.updateMe({ nickname: "mock" }),
    () => f.api.sendMessage("session", { text: "mock" }), () => f.api.sendMessage("session", { text: "", image_base64: "data:image/jpeg;base64,bW9jaw==" }),
    () => f.api.streamMessage("session", { text: "mock" }, () => {}), () => f.api.transcribeVoice("bW9jaw==", "en"),
    () => f.api.generateCards({ keywords: ["mock"] }), () => f.api.preparePersonalizedFeed([]), () => f.api.getCardDetail("card"), () => f.api.getCardResearch("card"),
    () => f.api.taskInsights(), () => f.api.createTask({ text: "mock" }), () => f.api.updateTask("task", { mood: "mock" }),
    () => f.api.openNotification("notification"), () => f.api.setPrivacy({ daily_push: true }), () => f.api.setPrivacy({ allow_external_content_research: true }), () => f.api.setPrivacy({ allow_history_training: true }),
  ];
  for (const run of operations) await assert.rejects(run(), blocked);
  assert.deepEqual(aiCalls(f), []);
});

test("login/privacy/deletion and existing non-AI reads remain usable without AI permission", async () => {
  const f = fixture(); await f.auth.setToken("account-A");
  await f.api.login({ email: "mock@example.invalid", password: "mock" });
  await f.api.getPrivacy(); await f.api.setPrivacy({ daily_push: false, allow_external_content_research: false, allow_history_training: false });
  await f.api.listChildren(); await f.api.listTasks(); await f.api.listSessions(); await f.api.getMessages("session"); await f.api.wipe(); await f.api.deleteChild("child"); await f.api.billingStatus();
  assert.equal(f.calls.length, 10);
  assert.equal(policy.requiresAIConsent("/auth/account", { method: "DELETE" }), false);
  assert.equal(f.secureReads.length, 0);
});

test("explicit permission allows real adapters, including SSE, voice payload and selected image", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.permit(); f.calls.length = 0;
  await f.api.addChild({ nickname: "mock" }); await f.api.updateMe({ city: "mock" });
  await f.api.getOrStartMainSession(); await f.api.sendMessage("session", { text: "mock" });
  const image = "data:image/jpeg;base64,bW9jaw=="; await f.api.sendMessage("session", { image_base64: image });
  await f.api.transcribeVoice("bW9jaw==", "en"); await f.api.streamMessage("session", { text: "mock" }, () => {});
  assert.equal(aiCalls(f).length, 7);
  assert.ok(aiCalls(f).every((call) => call.owner === "Bearer account-A"));
  assert.ok(f.calls.some((call) => call.path === "/chat/transcribe" && JSON.parse(call.body).audio_base64 === "bW9jaw=="));
  assert.ok(f.calls.some((call) => JSON.parse(call.body || "{}").image_base64 === image));
  const [key, raw] = f.writes.at(-1); const record = JSON.parse(raw);
  assert.equal(key, `ai_consent.${policy.AI_CONSENT_VERSION}.user-A`);
  assert.deepEqual([record.allowed, record.provider, record.userId, record.version], [true, "OpenAI", "user-A", policy.AI_CONSENT_VERSION]);
  assert.ok(!raw.includes("account-A"));
});

test("native XHR path is denied before send, then allowed only after explicit permission", async () => {
  const f = fixture({ nativeXHR: true }); await f.auth.setToken("account-A");
  await assert.rejects(f.api.streamMessage("session", { text: "mock" }, () => {}), blocked);
  assert.deepEqual(aiCalls(f), []); await f.permit();
  await f.api.streamMessage("session", { text: "mock" }, () => {});
  assert.equal(aiCalls(f).length, 1); assert.equal(aiCalls(f)[0].xhr, true);
});

test("user switch and token refresh bind verified me.id; stale UI cannot grant B", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.permit(); const old = f.aiConsent.getState();
  await f.auth.setToken("account-B");
  assert.equal(await f.aiConsent.setAllowed(true, old), false);
  await assert.rejects(f.api.getOrStartMainSession(), blocked);
  assert.equal(f.aiConsent.getState().userId, "user-B");
  await f.auth.setToken("account-A"); await f.api.getOrStartMainSession();
  assert.equal(f.aiConsent.getState().userId, "user-A");
});

test("old version/corrupt approval and privacy training/research switches are not AI permission", async () => {
  const f = fixture(); await f.auth.setToken("account-A");
  const key = `ai_consent.${policy.AI_CONSENT_VERSION}.user-A`;
  f.values.set(key, JSON.stringify({ allowed: true, userId: "user-A", provider: "OpenAI", version: "old" })); f.ordinary.set(key + ".deny", false);
  await assert.rejects(f.api.transcribeVoice("mock"), blocked);
  f.values.set(key, "corrupt"); await assert.rejects(f.api.getDailyPost(), blocked);
  assert.deepEqual(aiCalls(f), []);
});

test("withdrawal invalidates a granted lease immediately and blocks the next voice/image/auto-session request", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.permit();
  const lease = await f.aiConsent.authorize("account-A");
  const withdrawing = f.aiConsent.setAllowed(false, f.aiConsent.getState());
  assert.throws(() => f.aiConsent.assertCurrent(lease), blocked);
  await withdrawing; f.calls.length = 0;
  for (const run of [() => f.api.transcribeVoice("mock"), () => f.api.sendMessage("session", { image_base64: "mock" }), () => f.api.getOrStartMainSession()]) await assert.rejects(run(), blocked);
  assert.deepEqual(aiCalls(f), []);
});

test("restore read paused for A cannot apply to B or send an old automatic request", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.permit();
  f.calls.length = 0; f.pauseReads();
  const pending = f.api.getOrStartMainSession(); const rejection = assert.rejects(pending, blocked); await tick();
  await f.auth.setToken("account-B"); f.releaseReads(); await rejection;
  assert.deepEqual(aiCalls(f), []);
});

test("read in flight across withdrawal cannot send audio even if it captured the old saved grant", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.permit(); f.calls.length = 0; f.pauseReads();
  const pending = f.api.transcribeVoice("mock"); const rejection = assert.rejects(pending, blocked); await tick();
  await f.aiConsent.setAllowed(false, f.aiConsent.getState()); f.releaseReads(); await rejection;
  assert.deepEqual(aiCalls(f), []);
});

test("slow grant followed by withdrawal is serialized and cannot restore true", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.aiConsent.refresh(); const snapshot = f.aiConsent.getState();
  f.pauseWrites(); const grant = f.aiConsent.setAllowed(true, snapshot); await tick();
  const revoke = f.aiConsent.setAllowed(false, snapshot); f.releaseWrites();
  assert.equal(await grant, false); assert.equal(await revoke, true);
  const record = JSON.parse(f.values.get(`ai_consent.${policy.AI_CONSENT_VERSION}.user-A`));
  assert.equal(record.allowed, false); await assert.rejects(f.api.getOrStartMainSession(), blocked);
});

test("slow A grant cannot enable B or silently become durable after switching away", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.aiConsent.refresh();
  f.pauseWrites(); const grant = f.aiConsent.setAllowed(true, f.aiConsent.getState()); const rejection = assert.rejects(grant, blocked); await tick();
  await f.auth.setToken("account-B"); f.releaseWrites(); await rejection;
  await assert.rejects(f.api.getOrStartMainSession(), blocked);
  await f.auth.setToken("account-A"); await assert.rejects(f.api.getOrStartMainSession(), blocked);
});

test("failed secure withdrawal remains denied after restore through the deny-only journal", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.permit(); f.failSecureWrites();
  await assert.rejects(f.aiConsent.setAllowed(false, f.aiConsent.getState()), (error) => error.code === "AI_CONSENT_STORAGE_FAILED");
  await assert.rejects(f.api.getOrStartMainSession(), blocked);
  const restored = fixture({ values: f.values, ordinary: f.ordinary });
  await assert.rejects(restored.api.getOrStartMainSession(), blocked);
  assert.deepEqual(aiCalls(restored), []);
});

test("either unreadable permission medium fails closed instead of trusting a cached grant", async () => {
  for (const fail of ["failSecureReads", "failOrdinaryReads"]) {
    const f = fixture(); await f.auth.setToken("account-A"); await f.permit(); f[fail](); f.calls.length = 0;
    await assert.rejects(f.api.getDailyPost(), blocked); assert.deepEqual(aiCalls(f), []);
  }
});

test("sign-out invalidates permission leases while preserving per-user saved choice", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.permit(); const lease = await f.aiConsent.authorize("account-A");
  await f.auth.clearToken({ forceLocal: true, expectedToken: "account-A" });
  assert.throws(() => f.aiConsent.assertCurrent(lease), blocked);
  await assert.rejects(f.api.getOrStartMainSession(), blocked);
  assert.ok(f.values.has(`ai_consent.${policy.AI_CONSENT_VERSION}.user-A`));
});

test("withdrawal after authorization resolves but before actual fetch/XHR send still prevents upload", async () => {
  for (const nativeXHR of [false, true]) {
    const f = fixture({ nativeXHR }); await f.auth.setToken("account-A"); await f.permit(); f.calls.length = 0;
    const authorize = f.aiConsent.authorize;
    f.aiConsent.authorize = async (token) => {
      const lease = await authorize(token);
      await f.aiConsent.setAllowed(false, f.aiConsent.getState());
      return lease;
    };
    await assert.rejects(f.api.streamMessage("session", { image_base64: "mock" }, () => {}), blocked);
    assert.deepEqual(aiCalls(f), []);
  }
});

test("old refresh completing after a choice cannot overwrite the current permission state", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.permit(); f.pauseReads();
  const refresh = f.aiConsent.refresh(); await tick();
  await f.aiConsent.setAllowed(false, f.aiConsent.getState()); f.releaseReads(); await refresh;
  assert.equal(f.aiConsent.getState().status, "not_allowed");
  await assert.rejects(f.api.getOrStartMainSession(), blocked);
});

function uiFixture(f, locale) {
  let cursor = 0; const states = []; const effects = []; const links = []; const routes = [];
  const dependencies = {
    react: { useState: (initial) => { const n = cursor++; if (!(n in states)) states[n] = initial; return [states[n], (value) => { states[n] = value; }]; }, useRef: (initial) => ({ current: initial }), useEffect: (callback) => effects.push(callback) },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" },
    "react-native": { ActivityIndicator: "ActivityIndicator", Linking: { openURL: async (url) => links.push(url) }, Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View", StyleSheet: { create: (styles) => styles } },
    "expo-router": { useRouter: () => ({ replace: (route) => routes.push(route) }) },
    "@/src/api": f, "@/src/aiConsent": policy, "@/src/aiConsentCopy": copy, "@/src/useAIConsent": { useAIConsent: () => ({ state: f.aiConsent.getState(), refresh: f.aiConsent.refresh }) },
    "@/src/i18n": { useT: () => ({ locale }) }, "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" }, "@/src/theme": { colors: {} },
  };
  const page = load("../app/ai-permission.tsx", dependencies, true).default;
  const render = () => { cursor = 0; return page(); };
  const find = (node, id) => {
    if (!node || typeof node !== "object") return null;
    if (node.props?.testID === id) return node;
    for (const child of Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]) { const found = find(child, id); if (found) return found; }
    return null;
  };
  return { render, find, links, routes, unmount: () => effects.forEach((run) => run()?.()) };
}
for (const locale of ["zh-CN", "zh-TW", "en"]) test("actual " + locale + " page has explicit allow/decline, verified links and non-AI route", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.aiConsent.refresh(); const ui = uiFixture(f, locale); let tree = ui.render();
  const allow = ui.find(tree, "ai-permission-allow"); assert.ok(allow);
  ui.find(tree, "ai-permission-privacy").props.onPress(); ui.find(tree, "ai-permission-provider").props.onPress();
  assert.deepEqual(ui.links, [policy.AI_PRIVACY_URL, policy.AI_PROVIDER_DATA_URL]);
  ui.find(tree, "ai-permission-decline").props.onPress(); await tick();
  await assert.rejects(f.api.getOrStartMainSession(), blocked);
  tree = ui.render(); ui.find(tree, "ai-permission-non-ai").props.onPress(); assert.deepEqual(ui.routes, ["/(tabs)/profile"]);
  ui.find(tree, "ai-permission-allow").props.onPress(); await tick();
  await f.api.getOrStartMainSession();
  tree = ui.render(); assert.equal(ui.find(tree, "ai-permission-allow"), null);
  ui.find(tree, "ai-permission-decline").props.onPress(); await tick(); await assert.rejects(f.api.transcribeVoice("mock"), blocked);
});

test("late actual page callback from A cannot grant a newly signed-in B", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.aiConsent.refresh(); const ui = uiFixture(f, "en");
  const stale = ui.find(ui.render(), "ai-permission-allow").props.onPress;
  await f.auth.setToken("account-B"); await f.aiConsent.refresh(); stale(); await tick();
  await assert.rejects(f.api.getOrStartMainSession(), blocked);
  assert.equal(f.writes.length, 0);
});

test("actual button callback after page unmount cannot grant permission", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.aiConsent.refresh(); const ui = uiFixture(f, "en");
  const callback = ui.find(ui.render(), "ai-permission-allow").props.onPress;
  ui.unmount(); callback(); await tick();
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.api.getOrStartMainSession(), blocked);
});
