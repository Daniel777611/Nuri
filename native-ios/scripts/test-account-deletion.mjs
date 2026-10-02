import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function load(path, dependencies = {}, jsx = false) {
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: jsx ? ts.JsxEmit.ReactJSX : undefined },
  }).outputText;
  const result = { exports: {} };
  new Function("require", "module", "exports", output)((name) => {
    assert.ok(name in dependencies, "unexpected import " + name);
    return dependencies[name];
  }, result, result.exports);
  return result.exports;
}
const helper = load("../src/accountDeletion.ts");
const policy = load("../src/aiConsent.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const confirmed = { ok: true, account_deleted: true, subscription_cancelled: false };
const ownerA = { token: "account-A", id: "user-A", email: "a@example.invalid" };

function fixture({ status = 200, result = confirmed, locale = "en" } = {}) {
  const values = new Map();
  const ordinary = new Map();
  const requests = [];
  const clearCalls = [];
  const routes = [];
  const links = [];
  let removeSucceeds = true;
  let serverBarrier = null;
  let removalBarrier = null;
  let nullReadBarrier = null;
  let networkError = null;
  const storage = {
    secureGet: async (key, fallback) => values.get(key) ?? fallback,
    secureSet: async (key, value) => { values.set(key, value); return true; },
    secureRemove: async (key) => { if (removalBarrier) await removalBarrier.promise; if (!removeSucceeds) return false; values.delete(key); return true; },
    getItem: async (key, fallback) => ordinary.get(key) ?? fallback,
    setItem: async (key, value) => { ordinary.set(key, value); return true; },
    removeItem: async (key) => { ordinary.delete(key); return true; },
  };
  const client = load("../src/api.ts", {
    "./theme": { API: "https://nuri.invalid/api" }, "./preview-api": { isPreviewMode: false },
    "./utils/storage": { storage }, "./aiConsent": policy,
    "./sessionBoundary": load("../src/sessionBoundary.ts"),
  });
  // No production address or real deletion is ever contacted by this test.
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(url.startsWith("https://nuri.invalid/api"));
    const path = url.slice("https://nuri.invalid/api".length);
    requests.push({ path, method: init.method || "GET", body: init.body, owner: init.headers?.Authorization });
    if (path === "/auth/me") {
      const b = init.headers?.Authorization === "Bearer account-B";
      return { ok: true, status: 200, json: async () => ({ id: b ? "user-B" : "user-A", email: b ? "b@example.invalid" : "a@example.invalid" }) };
    }
    assert.equal(path, "/auth/account", "unexpected transport route");
    if (serverBarrier) await serverBarrier.promise;
    if (networkError) throw networkError;
    return { ok: status >= 200 && status < 300, status, json: async () => result, text: async () => JSON.stringify(result) };
  };
  const realClear = client.auth.clearToken;
  client.auth.clearToken = async (options) => { clearCalls.push(options); return realClear(options); };
  const realGet = client.auth.getToken;
  client.auth.getToken = async () => {
    const value = await realGet();
    if (value === null && nullReadBarrier) await nullReadBarrier.promise;
    return value;
  };
  let stateCursor = 0;
  let refCursor = 0;
  const states = [];
  const refs = [];
  const focus = [];
  let cleanups = [];
  const jsx = (type, props) => ({ type, props });
  const page = load("../app/account-deletion.tsx", {
    react: {
      useState: (initial) => { const n = stateCursor++; if (!(n in states)) states[n] = typeof initial === "function" ? initial() : initial; return [states[n], (value) => { states[n] = typeof value === "function" ? value(states[n]) : value; }]; },
      useRef: (initial) => refs[refCursor++] ||= { current: initial },
      useCallback: (callback) => callback,
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      ActivityIndicator: "ActivityIndicator", KeyboardAvoidingView: "KeyboardAvoidingView", Linking: { openURL: async (url) => links.push(url) }, Platform: { OS: "ios" },
      Pressable: "Pressable", ScrollView: "ScrollView", StyleSheet: { create: (styles) => styles }, Text: "Text", TextInput: "TextInput", View: "View",
    },
    "expo-router": { useRouter: () => ({ replace: (route) => routes.push(route) }), useFocusEffect: (callback) => focus.push(callback) },
    "@react-navigation/elements": { useHeaderHeight: () => 64 },
    "@/src/api": client, "@/src/accountDeletion": helper,
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@/src/i18n": { useT: () => ({ locale }) }, "@/src/theme": { colors: {}, radius: {}, spacing: {} },
  }, true).default;
  const render = () => { stateCursor = refCursor = 0; focus.length = 0; return page(); };
  const find = (node, id) => {
    if (!node || typeof node !== "object") return null;
    if (node.props?.testID === id) return node;
    for (const child of Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]) { const found = find(child, id); if (found) return found; }
    return null;
  };
  const mount = async () => { render(); cleanups = focus.map((run) => run()); await settle(); return render(); };
  const fill = (password = "mock-password", confirmation = "DELETE") => {
    let tree = render(); find(tree, "delete-account-password").props.onChangeText(password);
    find(tree, "delete-account-confirmation").props.onChangeText(confirmation); tree = render(); return tree;
  };
  const submit = () => find(fill(), "delete-account-submit").props.onPress();
  return { ...client, requests, clearCalls, routes, links, values, render, find, mount, fill, submit,
    unmount: () => { cleanups.forEach((cleanup) => cleanup?.()); cleanups = []; },
    pauseServer: () => serverBarrier = deferred(), releaseServer: () => { const b = serverBarrier; serverBarrier = null; b.resolve(); },
    pauseRemoval: () => removalBarrier = deferred(), releaseRemoval: () => { const b = removalBarrier; removalBarrier = null; b.resolve(); },
    pauseNullRead: () => nullReadBarrier = deferred(), releaseNullRead: () => { const b = nullReadBarrier; nullReadBarrier = null; b.resolve(); },
    failRemoval: () => { removeSucceeds = false; }, allowRemoval: () => { removeSucceeds = true; },
    failNetwork: () => { networkError = new Error("mock transport aborted"); },
  };
}
const deletions = (f) => f.requests.filter((request) => request.path === "/auth/account");

test("strict DELETE confirmation and UTF-8 bcrypt bound execute before any irreversible transport", async () => {
  const calls = [];
  const transport = { getToken: async () => ownerA.token, deleteAccount: async (...args) => { calls.push(args); return confirmed; }, clearToken: async () => true };
  for (const confirmation of ["", "delete", " DELETE", "DELETE ", "Delete"]) await assert.rejects(helper.deleteOwnedAccount(ownerA, "mock", confirmation, transport), (error) => error.code === "INVALID_CONFIRMATION");
  for (const password of ["", "a".repeat(73), "中".repeat(25), "🙂".repeat(19), "\uD800"]) {
    assert.equal(helper.validDeletionPassword(password), false);
    await assert.rejects(helper.deleteOwnedAccount(ownerA, password, "DELETE", transport), (error) => error.code === "INVALID_PASSWORD");
  }
  assert.deepEqual(calls, []);
  for (const password of ["a".repeat(72), "中".repeat(24), "🙂".repeat(18), " mock password "]) {
    assert.equal(helper.validDeletionPassword(password), true);
    assert.equal((await helper.deleteOwnedAccount(ownerA, password, "DELETE", transport)).deleted, true);
    assert.equal(calls.at(-1)[0], password, "passwords must never be trimmed");
  }
});

test("helper accepts only true account_deleted, never obsolete deleted or a nonconfirmed result", async () => {
  for (const result of [undefined, null, {}, { deleted: true }, { account_deleted: false }, { account_deleted: "true" }]) {
    let clears = 0;
    await assert.rejects(helper.deleteOwnedAccount(ownerA, "mock", "DELETE", { getToken: async () => ownerA.token, deleteAccount: async () => result, clearToken: async () => { clears++; return true; } }), (error) => error.code === "RESULT_UNCONFIRMED");
    assert.equal(clears, 0);
  }
});

test("actual helper/API confirmation uses captured owner and local force-CAS cleanup", async () => {
  const f = fixture(); await f.auth.setToken(ownerA.token);
  assert.deepEqual(await helper.deleteOwnedAccount(ownerA, " mock password ", "DELETE", { getToken: f.auth.getToken, deleteAccount: f.api.deleteAccount, clearToken: f.auth.clearToken }), { deleted: true, signedOut: true });
  const request = deletions(f)[0]; assert.equal(request.method, "DELETE"); assert.equal(request.owner, "Bearer account-A");
  assert.deepEqual(JSON.parse(request.body), { confirmation: "DELETE", password: " mock password " });
  assert.deepEqual(f.clearCalls, [{ expectedToken: "account-A", forceLocal: true }]);
  assert.equal(await f.auth.getToken(), null);
});

test("actual helper sends A request, then atomic cleanup refuses a replacement B", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); f.pauseServer();
  const pending = helper.deleteOwnedAccount(ownerA, "mock", "DELETE", { getToken: f.auth.getToken, deleteAccount: f.api.deleteAccount, clearToken: f.auth.clearToken });
  await settle(); await f.auth.setToken("account-B"); f.releaseServer();
  assert.deepEqual(await pending, { deleted: true, signedOut: false });
  assert.equal(deletions(f)[0].owner, "Bearer account-A"); assert.equal(await f.auth.getToken(), "account-B");
});

test("old owner before submission cannot initiate deletion under B", async () => {
  const f = fixture(); await f.auth.setToken("account-B");
  await assert.rejects(helper.deleteOwnedAccount(ownerA, "mock", "DELETE", { getToken: f.auth.getToken, deleteAccount: f.api.deleteAccount, clearToken: f.auth.clearToken }), (error) => error.code === "SESSION_CHANGED");
  assert.deepEqual(deletions(f), []); assert.deepEqual(f.clearCalls, []);
});

for (const locale of ["zh-CN", "zh-TW", "en"]) test("actual " + locale + " page confirms deletion, warns shared account and routes only after local cleanup", async () => {
  const f = fixture({ locale }); await f.auth.setToken("account-A"); await f.mount();
  const tree = f.fill(); assert.equal(f.find(tree, "delete-account-submit").props.disabled, false);
  assert.ok(f.find(tree, "delete-account-shared-warning"));
  f.find(tree, "delete-account-submit").props.onPress(); await settle();
  assert.deepEqual(f.routes, ["/login"]); assert.equal(await f.auth.getToken(), null); assert.equal(deletions(f).length, 1);
});

test("actual page and object detail code: wrong current password preserves the session and never clears", async () => {
  const f = fixture({ status: 403, result: { detail: { code: "ACCOUNT_REAUTH_FAILED", deletion_state: "not_started" } } });
  await f.auth.setToken("account-A"); await f.mount(); f.submit(); await settle();
  assert.equal(await f.auth.getToken(), "account-A"); assert.deepEqual(f.clearCalls, []); assert.deepEqual(f.routes, []);
  assert.match(f.find(f.render(), "delete-account-message").props.children, /password is incorrect.*not deleted/i);
});

for (const [status, result] of [[404, { detail: "not found" }], [503, { detail: { code: "ACCOUNT_DELETION_UNAVAILABLE", deletion_state: "not_started" } }], [503, { detail: { code: "ACCOUNT_DELETION_INCOMPLETE", deletion_state: "partial" } }], [503, { detail: { code: "ACCOUNT_DELETION_UNCONFIRMED", deletion_state: "unknown" } }], [200, { deleted: true }]]) test("actual page never treats " + status + " " + JSON.stringify(result) + " as deletion success", async () => {
  const f = fixture({ status, result }); await f.auth.setToken("account-A"); await f.mount(); f.submit(); await settle();
  assert.equal(await f.auth.getToken(), "account-A"); assert.deepEqual(f.clearCalls, []); assert.deepEqual(f.routes, []);
  assert.ok(f.find(f.render(), "delete-account-message"));
});

test("transport timeout/abort is unconfirmed, not deleted, and preserves local credentials", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.mount(); f.failNetwork(); f.submit(); await settle();
  assert.equal(await f.auth.getToken(), "account-A"); assert.deepEqual(f.clearCalls, []); assert.deepEqual(f.routes, []);
  assert.match(f.find(f.render(), "delete-account-message").props.children, /could not be confirmed/i);
});

test("pending actual submit callback cannot start a duplicate irreversible request", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.mount(); f.pauseServer();
  const button = f.find(f.fill(), "delete-account-submit"); button.props.onPress(); button.props.onPress(); await settle();
  assert.equal(deletions(f).length, 1); assert.equal(f.find(f.render(), "delete-account-submit").props.disabled, true);
  f.releaseServer(); await settle(); assert.equal(deletions(f).length, 1);
});

test("stale page A callback cannot delete or clear a newly published B", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.mount();
  const callback = f.find(f.fill(), "delete-account-submit").props.onPress;
  await f.auth.setToken("account-B"); callback(); await settle();
  assert.deepEqual(deletions(f), []); assert.deepEqual(f.clearCalls, []); assert.deepEqual(f.routes, []);
  assert.equal(await f.auth.getToken(), "account-B");
});

test("actual page deleting A while B signs in keeps B and does not navigate login", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.mount(); f.pauseServer(); f.submit(); await settle();
  await f.auth.setToken("account-B"); f.releaseServer(); await settle();
  assert.equal(deletions(f)[0].owner, "Bearer account-A"); assert.equal(await f.auth.getToken(), "account-B"); assert.deepEqual(f.routes, []);
});

test("clear A already queued, B subsequently publishes: actual callback cannot overwrite B with login", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.mount(); f.pauseRemoval(); f.submit(); await settle();
  const login = f.auth.setToken("account-B"); f.releaseRemoval(); await login; await settle();
  assert.equal(await f.auth.getToken(), "account-B"); assert.deepEqual(f.routes, []);
});

test("early null read, later B publish before continuation: live published-token guard prevents login navigation", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.mount(); f.pauseNullRead(); f.submit(); await settle();
  await f.auth.setToken("account-B"); f.releaseNullRead(); await settle();
  assert.equal(await f.auth.getToken(), "account-B"); assert.deepEqual(f.routes, []);
});

test("confirmed server deletion + Keychain failure exposes real local-only CAS retry without another DELETE", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.mount(); f.failRemoval(); f.submit(); await settle();
  assert.equal(await f.auth.getToken(), null, "local tombstone must not expose the deleted account");
  assert.equal(f.values.get("auth_token"), "account-A"); assert.deepEqual(f.routes, []);
  const retry = f.find(f.render(), "delete-account-retry-local"); assert.ok(retry); assert.equal(retry.props.disabled, false);
  f.allowRemoval(); retry.props.onPress(); await settle();
  assert.equal(f.values.has("auth_token"), false); assert.deepEqual(f.routes, ["/login"]); assert.equal(deletions(f).length, 1);
  assert.deepEqual(f.clearCalls, [{ expectedToken: "account-A", forceLocal: true }, { expectedToken: "account-A", forceLocal: true }]);
});

test("local-cleanup retry for deleted A does not clear an intervening B sign-in", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.mount(); f.failRemoval(); f.submit(); await settle();
  const retry = f.find(f.render(), "delete-account-retry-local").props.onPress;
  f.allowRemoval(); await f.auth.setToken("account-B"); retry(); await settle();
  assert.equal(await f.auth.getToken(), "account-B"); assert.deepEqual(f.routes, []); assert.equal(deletions(f).length, 1);
});

test("unmounted actual page callback starts no deletion; an already sent confirmation cannot navigate after unmount", async () => {
  const f = fixture(); await f.auth.setToken("account-A"); await f.mount();
  const stale = f.find(f.fill(), "delete-account-submit").props.onPress; f.unmount(); stale(); await settle();
  assert.deepEqual(deletions(f), []); assert.deepEqual(f.clearCalls, []);
  await f.mount(); f.pauseServer(); f.submit(); await settle(); f.unmount(); f.releaseServer(); await settle();
  assert.equal(deletions(f).length, 1); assert.deepEqual(f.routes, []);
});
