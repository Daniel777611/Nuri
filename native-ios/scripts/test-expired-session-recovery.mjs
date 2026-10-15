import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function load(relative, dependencies) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    assert.ok(name in dependencies, `unexpected import ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const states = [];
const refs = [];
const callbacks = [];
const effects = [];
let stateIndex = 0;
let refIndex = 0;
let callbackIndex = 0;
let effectIndex = 0;
let locale = "zh-CN";
let settingsOpened = 0;
const react = {
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  useState: (initial) => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
  },
  useRef: (initial) => refs[refIndex++] ||= { current: initial },
  useCallback: (fn) => callbacks[callbackIndex++] ||= fn,
  useEffect: (run) => {
    const index = effectIndex++;
    if (!(index in effects)) effects[index] = run();
  },
};
const jsx = (type, props) => ({ type, props });
const values = new Map();
let deleteSucceeds = true;
let removalBarrier = null;
const storage = {
  secureGet: async (key, fallback) => values.get(key) || fallback,
  secureSet: async (key, value) => { values.set(key, value); return true; },
  secureRemove: async (key) => {
    if (removalBarrier) await removalBarrier;
    if (!deleteSucceeds) return false;
    values.delete(key);
    return true;
  },
  getItem: async (key, fallback) => values.get(key) || fallback,
  setItem: async (key, value) => { values.set(key, value); return true; },
  removeItem: async (key) => { values.delete(key); return true; },
};
const client = load("../src/api.ts", {
  "./theme": { API: "https://nuri.invalid/api" },
  "./preview-api": { isPreviewMode: false }, "./utils/storage": { storage },
  "./aiConsent": load("../src/aiConsent.ts", {}),
  "./sessionBoundary": load("../src/sessionBoundary.ts", {}),
});
const helper = load("../src/authExpiredRecovery.tsx", {
  react,
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "react-native": { Pressable: "Pressable", Text: "Text", View: "View", StyleSheet: { create: (value) => value } },
  "./api": client,
  "./components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
  "./i18n": { useT: () => ({ locale }) },
  "./nativePush": { openNotificationSettings: async () => { settingsOpened += 1; throw new Error("settings unavailable"); } },
});
function resetHooks() {
  effects.forEach((effect) => effect?.());
  states.length = refs.length = callbacks.length = effects.length = 0;
}
function render(renderable) {
  stateIndex = refIndex = callbackIndex = effectIndex = 0;
  return renderable();
}
function findById(tree, id) {
  if (!tree || typeof tree !== "object") return null;
  if (tree.props?.testID === id) return tree;
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children.flat() : [children]) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

// An expired JWT plus a remembered install must clear locally without asking
// the rejected JWT to authenticate DELETE. These tests never contact a host.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("recovery must not call the network"); };
try {
  await client.auth.setToken("expired-owner");
  values.set(client.PUSH_INSTALLATION_KEY, "b22911a4-37dd-47b1-a775-632b0b800733");
  for (const error of [{ status: 500 }, { status: 503 }, { status: 429 }, new Error("offline")]) {
    assert.equal((await helper.recoverExpiredSession(error, "expired-owner")).kind, "not_rejected");
    assert.equal(await client.auth.getToken(), "expired-owner", "non-401 must preserve credentials");
  }
  assert.equal((await helper.recoverExpiredSession({ status: 401 }, "expired-owner")).kind, "cleared");
  assert.equal(await client.auth.getToken(), null);
  assert.equal(client.auth.getPushCleanupStatus().pending, true, "unconfirmed push retirement remains disclosed");

  // Keychain deletion failure stays actionable, never restoring the expired
  // session in this process or exposing a registration/profile form.
  await client.auth.setToken("expired-owner");
  deleteSucceeds = false;
  resetHooks();
  let routed = 0;
  let recovery = render(() => helper.useExpiredSessionRecovery(() => { routed += 1; }));
  await recovery.recover({ status: 401 }, "expired-owner");
  recovery = render(() => helper.useExpiredSessionRecovery(() => { routed += 1; }));
  assert.equal(recovery.blocked, true);
  assert.equal(recovery.failureCode, "LOCAL_SIGNOUT_FAILED");
  assert.equal(recovery.pending, false);
  assert.equal(routed, 0);
  assert.equal(await client.auth.getToken(), null);
  deleteSucceeds = true;
  await recovery.recover();
  recovery = render(() => helper.useExpiredSessionRecovery(() => { routed += 1; }));
  assert.equal(recovery.blocked, false);
  assert.equal(routed, 1);
  assert.equal(values.has(client.auth.TOKEN_KEY), false);

  // Unmounted pages must not navigate once their cleanup finishes.
  await client.auth.setToken("expired-owner");
  resetHooks();
  recovery = render(() => helper.useExpiredSessionRecovery(() => { routed += 1; }));
  const cleanup = recovery.recover({ status: 401 }, "expired-owner");
  effects.forEach((effect) => effect?.());
  await cleanup;
  assert.equal(routed, 1);

  // A 401 that only arrives after unmount cannot start clearing a later login.
  await client.auth.setToken("owner-a");
  resetHooks();
  recovery = render(() => helper.useExpiredSessionRecovery(() => { routed += 1; }));
  effects.forEach((effect) => effect?.());
  await client.auth.setToken("owner-b");
  await recovery.recover({ status: 401 }, "owner-a");
  assert.equal(await client.auth.getToken(), "owner-b");
  assert.equal(routed, 1);

  // Even a still-mounted page must not clear B because an old A request failed.
  resetHooks();
  recovery = render(() => helper.useExpiredSessionRecovery(() => { routed += 1; }));
  assert.equal((await helper.recoverExpiredSession({ status: 401 }, "owner-a")).kind, "session_changed");
  await recovery.recover({ status: 401 }, "owner-a");
  assert.equal(await client.auth.getToken(), "owner-b");
  assert.equal(routed, 1);

  // Queue-order race: B's login may have been queued before A's 401 cleanup.
  // The expected-owner comparison must happen inside the serialized callback,
  // before session broadcasts, push cleanup or credential removal.
  await client.auth.setToken("owner-a");
  const sessionEvents = [];
  const unsubscribe = client.auth.subscribeSessionChange((value) => sessionEvents.push(value));
  const newerLogin = client.auth.setToken("owner-b");
  const lateCleanup = helper.recoverExpiredSession({ status: 401 }, "owner-a");
  await newerLogin;
  assert.equal((await lateCleanup).kind, "session_changed");
  assert.equal(await client.auth.getToken(), "owner-b");
  assert.deepEqual(sessionEvents, ["owner-b"], "mismatch must not publish logout or clear delivered notifications");
  unsubscribe();

  // A late /me result cannot overwrite the newer account's local routing flag.
  assert.equal(await client.auth.setOnboarded(false, { expectedToken: "owner-b" }), true);
  assert.equal(await client.auth.setOnboarded(true, { expectedToken: "owner-a" }), false);
  assert.equal(await client.auth.getOnboarded(), false);
  assert.equal(await client.auth.setOnboarded(true, { expectedToken: "owner-b" }), true);
  assert.equal(await client.auth.getOnboarded(), true);
  await client.auth.setToken("owner-a");
  const queuedLogin = client.auth.setToken("owner-b");
  const staleOnboarding = client.auth.setOnboarded(false, { expectedToken: "owner-a" });
  await queuedLogin;
  assert.equal(await staleOnboarding, false);
  assert.equal(await client.auth.getOnboarded(), true);

  // A failed Keychain removal exposes no session to onboarding writes, even
  // though recovery must still be able to compare its raw credential on retry.
  deleteSucceeds = false;
  await assert.rejects(client.auth.clearToken({ forceLocal: true, expectedToken: "owner-b" }),
    (error) => error.code === "LOCAL_SIGNOUT_FAILED");
  assert.equal(await client.auth.setOnboarded(false, { expectedToken: "owner-b" }), false);
  assert.equal(await client.auth.getOnboarded(), true);
  deleteSucceeds = true;
  assert.equal(await client.auth.clearToken({ forceLocal: true, expectedToken: "owner-b" }), true);

  // If B queues login while A's own clearing is already running, B's token is
  // safe in the auth queue. A must also avoid late navigation once B is active.
  await client.auth.setToken("owner-a");
  resetHooks();
  recovery = render(() => helper.useExpiredSessionRecovery(() => { routed += 1; }));
  let finishRemoval;
  removalBarrier = new Promise((resolve) => { finishRemoval = resolve; });
  const retiringA = recovery.recover({ status: 401 }, "owner-a");
  await tick();
  const loginDuringCleanup = client.auth.setToken("owner-b");
  finishRemoval();
  await Promise.all([retiringA, loginDuringCleanup]);
  removalBarrier = null;
  assert.equal(await client.auth.getToken(), "owner-b");
  assert.equal(routed, 1, "retired owner must not navigate over a login completed during clearing");

  // The failure panel has a retry and system-settings action. A failed system
  // settings promise is caught and converted to text, not an unhandled reject.
  resetHooks();
  let tree = render(() => helper.ExpiredSessionRecoveryNotice({ pending: false, onRetry: async () => {} }));
  assert.ok(findById(tree, "expired-session-cleanup-retry"));
  findById(tree, "expired-session-notification-settings").props.onPress();
  await tick();
  tree = render(() => helper.ExpiredSessionRecoveryNotice({ pending: false, onRetry: async () => {} }));
  assert.equal(settingsOpened, 1);
  assert.match(JSON.stringify(tree), /系统设置暂时无法打开/);
  for (const nextLocale of ["en", "zh-TW"]) {
    locale = nextLocale;
    tree = render(() => helper.ExpiredSessionRecoveryNotice({ pending: true, onRetry: async () => {} }));
    assert.equal(findById(tree, "expired-session-cleanup-retry").props.disabled, true);
  }
} finally {
  globalThis.fetch = originalFetch;
}

// The affected consumers must invoke the guarded helper for every old 401
// branch, block forms after cleanup failure, and never invoke strict logout.
for (const [path, count] of [["../app/onboarding.tsx", 2], ["../app/child/[id].tsx", 3], ["../app/register.tsx", 1]]) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  assert.equal((source.match(/await recoverExpiredCredentials\((?:error|err), (?:requestToken|token)\)/g) || []).length, count);
  assert.doesNotMatch(source, /auth\.clearToken\(/);
  assert.match(source, /if \(recovery\.blocked\) return <ExpiredSessionRecoveryNotice/);
}
const profile = readFileSync(new URL("../app/(tabs)/profile.tsx", import.meta.url), "utf8");
assert.match(profile, /auth\.clearToken\(\{ expectedToken: owner\.token/);
console.log("Expired JWT recovery: 401-only cleanup, Keychain retry, stale-session/queue races, guarded onboarding and actionable UI checks passed.");
