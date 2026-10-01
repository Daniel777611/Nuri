import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/nativePushRuntime.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
new Function("module", "exports", output)(module, module.exports);
const { NativePushRuntime, parseNativeToken, safeNotificationRoute } = module.exports;

function loadTypeScript(relative, dependencies) {
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    assert.ok(name in dependencies, `unexpected runtime dependency: ${name}`);
    return dependencies[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

const state = {
  token: "aa".repeat(32), environment: "production",
  installationId: "b22911a4-37dd-47b1-a775-632b0b800733", bundleId: "com.ordashtech.nuri.nativelab",
  permissionStatus: "authorized", timeZone: "America/Chicago", appVersion: "0.3.0", buildNumber: "15",
};
const notification = "/notifications/12345678-1234-1234-1234-123456789abc";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

function apiFixture() {
  const secureValues = new Map();
  const ordinaryValues = new Map();
  let removeCredentials = true;
  const storage = {
    secureGet: async (key, fallback) => secureValues.get(key) ?? fallback,
    secureSet: async (key, value) => { secureValues.set(key, value); return true; },
    secureRemove: async (key) => {
      if (!removeCredentials) return false;
      secureValues.delete(key);
      return true;
    },
    getItem: async (key, fallback) => ordinaryValues.get(key) ?? fallback,
    removeItem: async (key) => { ordinaryValues.delete(key); return true; },
    setItem: async (key, value) => { ordinaryValues.set(key, value); return true; },
  };
  const client = loadTypeScript("../src/api.ts", {
    "./theme": { API: "https://nuri.invalid/api" },
    "./preview-api": { isPreviewMode: false }, "./utils/storage": { storage },
  });
  return { client, storage, secureValues, ordinaryValues,
    failCredentialRemoval: () => { removeCredentials = false; },
    allowCredentialRemoval: () => { removeCredentials = true; } };
}

function successfulResponse(method) {
  return { ok: true, status: method === "DELETE" ? 204 : 200, json: async () => ({ active: true }) };
}

function fixture(overrides = {}) {
  const calls = [];
  let stored = null;
  const runtime = new NativePushRuntime({
    register: async (device, session) => { calls.push(["register", session, device]); },
    deactivate: async (id, session) => { calls.push(["delete", session, id]); },
    rememberInstallation: async (id) => { stored = id; },
    storedInstallation: async () => stored,
    forgetInstallation: async () => { stored = null; },
    openRoute: (route) => { calls.push(["route", route]); },
    now: () => 1000,
    ...overrides,
  });
  return { runtime, calls, stored: () => stored };
}

assert.equal(parseNativeToken({ ...state, bundleId: "other.app" }), null);
assert.equal(parseNativeToken({ ...state, bundleId: "com.ordashtech.nuri" }), null,
  "the lab must reject the original web-shell identity instead of spoofing its APNs topic");
assert.equal(parseNativeToken({ ...state, bundleId: undefined }), null);
assert.equal(parseNativeToken({ ...state, token: "not-an-apns-token" }), null);
assert.equal(parseNativeToken({ ...state, installationId: "bad" }), null);
assert.equal(parseNativeToken({ ...state, permissionStatus: "invented" }), null);
assert.equal(parseNativeToken(state).apns_token, state.token);
assert.equal(parseNativeToken(state).bundle_id, "com.ordashtech.nuri.nativelab");
for (const route of ["https://nurifam.app/notifications/12345678", "/notifications/../login", "/notifications/%2e%2e", "/chat/12345678", "/notifications/12345678?x=1"]) {
  assert.equal(safeNotificationRoute(route), null);
}
assert.equal(safeNotificationRoute(notification), notification);

// Native storage and reminder ownership are lab-only, even if these bridge
// sources were accidentally compiled into a build with the original app ID.
// Generated iOS copies are managed by prebuild, not edited by this test.
{
  const swift = readFileSync(new URL("../native/NuriPushBridge.swift", import.meta.url), "utf8");
  const delegate = readFileSync(new URL("../native/NuriAppDelegate.swift", import.meta.url), "utf8");
  for (const contents of [swift, delegate]) {
    assert.doesNotMatch(contents, /"com\.ordashtech\.nuri(?!\.nativelab)[^"]*"/,
      "native lab must not read, delete or migrate the original app's namespaces");
  }
  const expectedKeys = {
    expectedBundleId: "com.ordashtech.nuri.nativelab",
    tokenKey: "com.ordashtech.nuri.nativelab.apns-token",
    tokenEnvironmentKey: "com.ordashtech.nuri.nativelab.apns-token-environment",
    keychainService: "com.ordashtech.nuri.nativelab.installation",
    keychainAccount: "native-lab-installation-id",
    enabledKey: "com.ordashtech.nuri.nativelab.reminder-enabled",
    intervalKey: "com.ordashtech.nuri.nativelab.reminder-interval-seconds",
    reminderIdentifier: "com.ordashtech.nuri.nativelab.local-reminder",
    batchIdentifierPrefix: "com.ordashtech.nuri.nativelab.local-reminder.batch.",
  };
  for (const [name, expected] of Object.entries(expectedKeys)) {
    assert.equal(swift.match(new RegExp(`private let ${name} = "([^"]+)"`))?.[1], expected);
  }
  assert.match(swift, /guard Bundle\.main\.bundleIdentifier == expectedBundleId else \{ return \}/);
  assert.match(swift, /guard let bundleId = bundle\.bundleIdentifier, bundleId == self\.expectedBundleId/);
  assert.doesNotMatch(swift, /bundleIdentifier\s*\?\?|legacyIntervalKey|legacyIdentifiers|removeLegacyTests|kSecAttrAccessGroup/);
  assert.match(delegate, /"com\.ordashtech\.nuri\.nativelab\.reminders-initialized"/);
  assert.match(swift, /Notification\.Name\("NuriNativeLabPushStateDidChange"\)/);
  assert.match(swift, /Notification\.Name\("NuriNativeLabNotificationRouteDidOpen"\)/);
  assert.match(swift, /实验版远程 APNs 尚待后端支持/);
}

// A backend which only allowlists the original bundle rejects Native Lab with
// 422. Preserve its true topic, leave registration retryable, and do not alter
// the signed-in session as if this capability error were an authentication 401.
{
  const attempted = [];
  const { runtime } = fixture({ register: async (device, owner) => {
    attempted.push([device.bundle_id, owner]);
    throw { status: 422, message: "bundle not supported" };
  } });
  await runtime.acceptState(state);
  await runtime.setSession("lab-owner");
  await runtime.sync();
  assert.deepEqual(attempted, [["com.ordashtech.nuri.nativelab", "lab-owner"],
    ["com.ordashtech.nuri.nativelab", "lab-owner"]]);
}

// Native token and signed-in JWT may arrive in either order; duplicates are
// local no-ops, while a new owner or changed device state gets an upsert.
{
  const { runtime, calls } = fixture();
  await runtime.acceptState(state);
  assert.equal(calls.length, 0);
  await runtime.setSession("owner-a");
  await runtime.acceptState(state);
  await runtime.sync();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "owner-a");
  await runtime.setSession("owner-b");
  assert.equal(calls.filter(([kind]) => kind === "register").length, 2);
  assert.equal(calls.filter(([kind]) => kind === "register")[1][1], "owner-b");
  await runtime.acceptState({ ...state, token: "bb".repeat(32) });
  assert.equal(calls.filter(([kind]) => kind === "register")[2][2].apns_token, "bb".repeat(32));
}

// Cold-start routing waits for both login and a mounted authenticated screen.
// A fresh JWT after an expired session must not drop the pending notification.
{
  const { runtime, calls } = fixture();
  runtime.receiveRoute(notification);
  await runtime.setSession("expired-session");
  await runtime.setSession(null);
  await runtime.setSession("signed-in-session");
  assert.equal(calls.length, 0);
  runtime.setNavigationReady(true);
  runtime.receiveRoute(notification);
  assert.deepEqual(calls, [["route", notification]]);
  runtime.setNavigationReady(false);
  runtime.receiveRoute("/notifications/87654321");
  await runtime.setSession(null);
  await runtime.setSession("other-account");
  runtime.setNavigationReady(true);
  assert.equal(calls.length, 1, "logout cancels a previous account's pending route");
}

// Permission revocation retires the device, including when no cached token is
// available; re-enabling authorization registers the same installation again.
{
  const { runtime, calls, stored } = fixture();
  await runtime.setSession("owner");
  await runtime.acceptState(state);
  assert.equal(stored(), state.installationId);
  await runtime.setPermission("denied");
  await runtime.sync();
  assert.equal(calls.filter(([kind]) => kind === "delete").length, 1);
  assert.equal(stored(), null);
  await runtime.setPermission("authorized");
  assert.equal(calls.filter(([kind]) => kind === "register").length, 2);
  const noToken = fixture({ storedInstallation: async () => state.installationId });
  await noToken.runtime.setSession("owner");
  await noToken.runtime.setPermission("denied");
  assert.deepEqual(noToken.calls, [["delete", "owner", state.installationId]]);
}

// A POST finishing after logout/account switch cannot reactivate the old
// owner: the serial writer compensates before the next owner's registration.
{
  const posted = deferred();
  const calls = [];
  const { runtime } = fixture({
    register: async (_device, session) => {
      calls.push(["register", session]);
      if (session === "owner-a") await posted.promise;
    },
    deactivate: async (_id, session) => { calls.push(["delete", session]); },
  });
  await runtime.setSession("owner-a");
  const registering = runtime.acceptState(state);
  await tick();
  void runtime.setSession(null);
  void runtime.setSession("owner-b");
  posted.resolve();
  await registering;
  await tick();
  assert.deepEqual(calls, [["register", "owner-a"], ["delete", "owner-a"], ["register", "owner-b"]]);
}

// The old registration may reach the server even when its response is lost.
// Failed cleanup is handed to the app API's bounded in-memory retry queue.
{
  const posted = deferred();
  const calls = [];
  let deletions = 0;
  const { runtime } = fixture({
    register: async () => { await posted.promise; throw new Error("response lost"); },
    deactivate: async () => {
      deletions += 1;
      calls.push("delete");
      if (deletions === 1) throw new Error("offline");
    },
  });
  await runtime.setSession("owner");
  const registering = runtime.acceptState(state);
  await tick();
  void runtime.setSession(null);
  posted.resolve();
  await registering;
  await runtime.sync();
  assert.equal(deletions, 1);
}

// Transient network failures remain retryable instead of marking the device
// registered. Unmount cancels pending navigation without unregistering a user.
{
  let attempts = 0;
  const { runtime, calls } = fixture({ register: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("offline");
  } });
  await runtime.setSession("owner");
  await runtime.acceptState(state);
  await runtime.sync();
  assert.equal(attempts, 2);
  runtime.receiveRoute(notification);
  runtime.dispose();
  runtime.setNavigationReady(true);
  assert.equal(calls.length, 0);
}

// An expired old JWT cannot permanently block the next account's upsert.
{
  const posted = deferred();
  const owners = [];
  const { runtime } = fixture({
    register: async (_device, owner) => {
      owners.push(owner);
      if (owner === "expired-owner") await posted.promise;
    },
    deactivate: async () => { throw { status: 401 }; },
  });
  await runtime.setSession("expired-owner");
  const registering = runtime.acceptState(state);
  await tick();
  void runtime.setSession("new-owner");
  posted.resolve();
  await registering;
  assert.deepEqual(owners, ["expired-owner", "new-owner"]);
}

// Public native reminder helpers validate the same bounds as the Swift
// scheduler and clearly target local reminders, separately from /privacy.
const wrappers = readFileSync(new URL("../src/nativePush.ts", import.meta.url), "utf8");
assert.match(wrappers, /MAX_LOCAL_REMINDER_INTERVAL_SECONDS = 31_536_000/);
assert.match(wrappers, /Number\.isSafeInteger\(intervalSeconds\)/);
assert.match(wrappers, /updateReminderSettings\(enabled, intervalSeconds\)/);
const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
assert.match(api, /subscribeSessionChange:/);
assert.match(api, /sessionToken === undefined \? await getToken\(\) : sessionToken/);
assert.match(api, /publishSession\(null\)/);

// Exercise the public bridge helpers against the real Swift-shaped contract.
{
  const handlers = new Map();
  const settings = { enabled: true, intervalSeconds: 37, permissionStatus: "authorized", scheduled: true,
    mode: "limited", pendingCount: 60, coverageSeconds: 2220 };
  let openedSettings = false;
  let updated;
  const helpers = loadTypeScript("../src/nativePush.ts", {
    "react-native": {
      Platform: { OS: "ios" }, Linking: { openSettings: async () => { openedSettings = true; } },
      NativeModules: { NuriPushBridge: {
        getReminderSettings: async () => settings,
        updateReminderSettings: async (enabled, interval) => { updated = [enabled, interval]; return settings; },
        requestPushRegistration: async () => state,
      } },
      NativeEventEmitter: class {
        addListener(name, listener) {
          handlers.set(name, listener);
          return { remove: () => handlers.delete(name) };
        }
      },
    },
    "./nativePushRuntime": module.exports,
  });
  assert.equal(await helpers.getReminderSettings(), settings);
  await helpers.setReminderSettings(true, 37);
  assert.deepEqual(updated, [true, 37]);
  for (const interval of [0, -1, 1.5, Infinity, 31_536_001]) {
    await assert.rejects(helpers.setReminderSettings(true, interval));
  }
  await helpers.setReminderSettings(false, 31_536_000);
  assert.equal(await helpers.requestNotificationPermission(), state);
  await helpers.openNotificationSettings();
  assert.equal(openedSettings, true);
  const received = [];
  const remove = helpers.subscribeNativePush((value) => received.push(value), (value) => received.push(value));
  handlers.get("nuriPushStateChanged")(state);
  handlers.get("nuriNotificationRouteOpened")({ route: notification });
  assert.deepEqual(received, [state, notification]);
  remove();
  assert.equal(handlers.size, 0);
}

// Exercise actual auth storage ordering and captured JWT request headers.
{
  const values = new Map();
  const requests = [];
  const deletion = deferred();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(init);
    if (init.method === "DELETE") await deletion.promise;
    return { ok: true, status: init.method === "DELETE" ? 204 : 200, json: async () => ({ active: true }) };
  };
  try {
    const storage = {
      secureGet: async (key, fallback) => values.get(key) || fallback,
      secureSet: async (key, value) => { values.set(key, value); return true; },
      secureRemove: async (key) => { values.delete(key); return true; },
      getItem: async (key, fallback) => values.get(key) || fallback,
      removeItem: async (key) => { values.delete(key); return true; },
      setItem: async (key, value) => { values.set(key, value); return true; },
    };
    const client = loadTypeScript("../src/api.ts", {
      "./theme": { API: "https://nuri.invalid/api" },
      "./preview-api": { isPreviewMode: false }, "./utils/storage": { storage },
    });
    const sessions = [];
    const unsubscribe = client.auth.subscribeSessionChange((session) => sessions.push(session));
    await client.auth.setToken("owner-a");
    values.set(client.PUSH_INSTALLATION_KEY, state.installationId);
    const signout = client.auth.clearToken();
    await tick();
    assert.equal(await client.auth.getToken(), null);
    assert.equal(requests[0].headers.Authorization, "Bearer owner-a");
    const login = client.auth.setToken("owner-b");
    deletion.resolve();
    await Promise.all([signout, login]);
    assert.deepEqual(sessions, ["owner-a", null, "owner-b"]);
    assert.equal(await client.auth.getToken(), "owner-b");
    await client.api.registerPushDevice(parseNativeToken(state), "captured-owner-a");
    assert.equal(requests[1].headers.Authorization, "Bearer captured-owner-a");
    unsubscribe();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// A confirmed registration survives an offline DELETE. Ordinary logout must
// report an incomplete exit; only explicit local-only exit removes the JWT.
// Its bounded in-memory cleanup is retried once when foreground events recur.
{
  const { client, secureValues, ordinaryValues } = apiFixture();
  const originalFetch = globalThis.fetch;
  let online = true;
  let serverOwner = null;
  let deleteAttempts = 0;
  let retryGate = null;
  globalThis.fetch = async (url, init) => {
    assert.ok(url.startsWith("https://nuri.invalid/"), "regression tests must never call a real backend");
    const owner = init.headers.Authorization.slice("Bearer ".length);
    if (init.method === "POST") serverOwner = owner;
    if (init.method === "DELETE") {
      deleteAttempts += 1;
      if (!online) throw new Error("offline");
      if (retryGate) await retryGate.promise;
      // Backend DELETE filters user_id as well as installation_id.
      if (serverOwner === owner) serverOwner = null;
    }
    return successfulResponse(init.method);
  };
  try {
    await client.auth.setToken("offline-owner");
    ordinaryValues.set(client.PUSH_INSTALLATION_KEY, state.installationId);
    await client.api.registerPushDevice(parseNativeToken(state), "offline-owner");
    online = false;
    await assert.rejects(client.auth.clearToken(), (error) => error.code === "PUSH_CLEANUP_PENDING");
    assert.equal(await client.auth.getToken(), "offline-owner");
    assert.equal(ordinaryValues.get(client.PUSH_INSTALLATION_KEY), state.installationId);
    assert.equal(serverOwner, "offline-owner");
    assert.equal(client.auth.getPushCleanupStatus().pending, true);
    await client.auth.clearToken({ forceLocal: true });
    assert.equal(await client.auth.getToken(), null);
    assert.equal(secureValues.has(client.auth.TOKEN_KEY), false);
    assert.equal([...ordinaryValues.values()].includes("offline-owner"), false);
    assert.equal(deleteAttempts, 1, "force-local exit must not wait for a second network attempt");
    online = true;
    retryGate = deferred();
    const retry = client.auth.retryPendingPushCleanup();
    const sameRetry = client.auth.retryPendingPushCleanup();
    assert.equal(retry, sameRetry, "foreground and route changes share one cleanup retry");
    await tick();
    assert.equal(deleteAttempts, 2);
    retryGate.resolve();
    await retry;
    assert.equal(serverOwner, null);
    assert.equal(ordinaryValues.has(client.PUSH_INSTALLATION_KEY), false);
    assert.deepEqual(client.auth.getPushCleanupStatus(), { pending: false, retryUntil: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// An unsuccessful Keychain deletion is not a successful logout. The current
// process is tombstoned so foreground restoration cannot silently log in again.
{
  const fixture = apiFixture();
  await fixture.client.auth.setToken("undeletable-owner");
  fixture.failCredentialRemoval();
  await assert.rejects(fixture.client.auth.clearToken(), (error) => error.code === "LOCAL_SIGNOUT_FAILED");
  assert.equal(fixture.secureValues.get(fixture.client.auth.TOKEN_KEY), "undeletable-owner");
  assert.equal(await fixture.client.auth.getToken(), null);
  fixture.allowCredentialRemoval();
  await fixture.client.auth.clearToken({ forceLocal: true });
  assert.equal(fixture.secureValues.has(fixture.client.auth.TOKEN_KEY), false);
}

// Retrying after the five-minute cache expires never resurrects the old JWT.
// The unresolved metadata remains visible: termination/expiry cannot prove a
// remote DELETE occurred, so the UI must still disclose the notification risk.
{
  const { client, ordinaryValues } = apiFixture();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let currentTime = originalNow();
  const postingGate = deferred();
  const requests = [];
  Date.now = () => currentTime;
  globalThis.fetch = async (_url, init) => {
    requests.push([init.method, init.headers.Authorization]);
    assert.equal(init.method, "POST", "must not retry an expired owner");
    await postingGate.promise;
    return successfulResponse(init.method);
  };
  try {
    await client.auth.setToken("expired-cleanup-owner");
    ordinaryValues.set(client.PUSH_INSTALLATION_KEY, state.installationId);
    await client.auth.clearToken({ forceLocal: true });
    assert.equal(client.auth.getPushCleanupStatus().retryUntil, currentTime + 5 * 60 * 1000);
    // Hold the shared writer on another installation; this retry is queued
    // before expiry and therefore must check the cache again when it executes.
    const posting = client.api.registerPushDevice(parseNativeToken({ ...state,
      installationId: "b22911a4-37dd-47b1-a775-632b0b800734" }), "queue-owner");
    await tick();
    const retry = client.auth.retryPendingPushCleanup();
    currentTime += 5 * 60 * 1000 + 1;
    postingGate.resolve();
    await posting;
    assert.deepEqual(await retry, { pending: true, retryUntil: null });
    assert.deepEqual(requests, [["POST", "Bearer queue-owner"]]);
    assert.equal([...ordinaryValues.values()].includes("expired-cleanup-owner"), false);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
}

// A retry already in flight at expiry can finish, but failure must not renew
// the old JWT retention window for another five minutes.
{
  const { client, ordinaryValues } = apiFixture();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let currentTime = originalNow();
  let requests = 0;
  const retryGate = deferred();
  Date.now = () => currentTime;
  globalThis.fetch = async () => {
    requests += 1;
    await retryGate.promise;
    throw new Error("late offline failure");
  };
  try {
    await client.auth.setToken("expiring-inflight-owner");
    ordinaryValues.set(client.PUSH_INSTALLATION_KEY, state.installationId);
    await client.auth.clearToken({ forceLocal: true });
    const retry = client.auth.retryPendingPushCleanup();
    await tick();
    currentTime += 5 * 60 * 1000 + 1;
    assert.deepEqual(client.auth.getPushCleanupStatus(), { pending: true, retryUntil: null });
    retryGate.resolve();
    assert.deepEqual(await retry, { pending: true, retryUntil: null });
    await client.auth.retryPendingPushCleanup();
    assert.equal(requests, 1);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
}

// The app-lifetime singleton survives a hook remount while A's POST is still
// in flight. It compensates A before B registers, using the actual API queue.
{
  const { client, storage, ordinaryValues } = apiFixture();
  const lifetime = loadTypeScript("../src/nativePushRuntime.ts", {});
  const originalFetch = globalThis.fetch;
  const posted = deferred();
  const calls = [];
  let serverOwner = null;
  globalThis.fetch = async (_url, init) => {
    const owner = init.headers.Authorization.slice("Bearer ".length);
    if (init.method === "POST") {
      calls.push(["post_start", owner]);
      if (owner === "owner-a") await posted.promise;
      serverOwner = owner;
      calls.push(["post_commit", owner]);
    } else if (init.method === "DELETE") {
      calls.push(["delete", owner]);
      if (serverOwner === owner) serverOwner = null;
    }
    return successfulResponse(init.method);
  };
  const routes = [];
  const deps = {
    register: client.api.registerPushDevice,
    deactivate: client.api.deactivatePushDevice,
    rememberInstallation: (id) => storage.setItem(client.PUSH_INSTALLATION_KEY, id),
    storedInstallation: () => storage.getItem(client.PUSH_INSTALLATION_KEY, null),
    forgetInstallation: () => storage.removeItem(client.PUSH_INSTALLATION_KEY),
    openRoute: (route) => routes.push(["old", route]),
  };
  try {
    const old = lifetime.getAppNativePushRuntime(deps);
    await old.setSession("owner-a");
    const registering = old.acceptState(state);
    await tick();
    old.dispose();
    const fresh = lifetime.getAppNativePushRuntime({ ...deps, openRoute: (route) => routes.push(["new", route]) });
    assert.equal(fresh, old);
    const switching = fresh.setSession("owner-b");
    await tick();
    assert.deepEqual(calls, [["post_start", "owner-a"]]);
    posted.resolve();
    await Promise.all([registering, switching]);
    assert.equal(serverOwner, "owner-b");
    assert.deepEqual(calls, [["post_start", "owner-a"], ["post_commit", "owner-a"], ["delete", "owner-a"],
      ["post_start", "owner-b"], ["post_commit", "owner-b"]]);
    await client.api.deactivatePushDevice(state.installationId, "owner-a");
    assert.equal(serverOwner, "owner-b", "captured A cleanup cannot delete the current B owner");
    assert.equal(ordinaryValues.get(client.PUSH_INSTALLATION_KEY), state.installationId);
    fresh.setNavigationReady(true);
    fresh.receiveRoute(notification);
    assert.deepEqual(routes, [["new", notification]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The same global API writer also protects two independently created runtimes
// (e.g. an already dispatched old POST) even after the old UI has detached.
{
  const { client, storage } = apiFixture();
  const originalFetch = globalThis.fetch;
  const posted = deferred();
  const posts = [];
  let serverOwner = null;
  globalThis.fetch = async (_url, init) => {
    const owner = init.headers.Authorization.slice("Bearer ".length);
    if (init.method === "POST") {
      posts.push(owner);
      if (owner === "owner-a") await posted.promise;
      serverOwner = owner;
    } else if (init.method === "DELETE" && serverOwner === owner) serverOwner = null;
    return successfulResponse(init.method);
  };
  const deps = {
    register: client.api.registerPushDevice, deactivate: client.api.deactivatePushDevice,
    rememberInstallation: (id) => storage.setItem(client.PUSH_INSTALLATION_KEY, id),
    storedInstallation: () => storage.getItem(client.PUSH_INSTALLATION_KEY, null),
    forgetInstallation: () => storage.removeItem(client.PUSH_INSTALLATION_KEY), openRoute: () => {},
  };
  try {
    const old = new NativePushRuntime(deps);
    await old.acceptState(state);
    const registering = old.setSession("owner-a");
    await tick();
    old.dispose();
    void old.setSession(null);
    const fresh = new NativePushRuntime(deps);
    await fresh.acceptState(state);
    const switching = fresh.setSession("owner-b");
    await tick();
    assert.deepEqual(posts, ["owner-a"]);
    posted.resolve();
    await Promise.all([registering, switching]);
    await tick();
    assert.equal(serverOwner, "owner-b");
    assert.deepEqual(posts, ["owner-a", "owner-b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Mount the actual native hook with a minimal hook harness: the initial APNs
// snapshot still works if registration fails, and routing waits through login.
{
  const refs = [];
  const effects = [];
  let refIndex = 0;
  let effectIndex = 0;
  let segments = ["login"];
  let pathname = "/login";
  let session = null;
  let sessionListener;
  let stateListener;
  let routeListener;
  let foreground;
  let nativeState = state;
  let requestsFail = true;
  let registrationsRequested = 0;
  let deliveredCleared = 0;
  let registrationGate = null;
  let permissionOverride = null;
  const registrations = [];
  const deletions = [];
  const routes = [];
  const values = new Map([["ui_language", "en"]]);
  const router = { push: (route) => routes.push(route) };
  const bridge = {
    getInitialState: async () => ({ pushState: state, route: notification }),
    requestPushRegistration: async () => {
      registrationsRequested += 1;
      if (requestsFail) throw new Error("APNs temporarily unavailable");
      const captured = nativeState;
      if (registrationGate) await registrationGate.promise;
      return captured;
    },
    getReminderSettings: async () => ({ permissionStatus: permissionOverride || nativeState.permissionStatus }),
    clearDeliveredNotifications: async () => {
      deliveredCleared += 1;
      throw new Error("displayed notification cleanup failed");
    },
  };
  const hook = loadTypeScript("../src/usePushBridge.native.ts", {
    react: {
      useRef: (initial) => {
        const index = refIndex++;
        return refs[index] ||= { current: initial };
      },
      useEffect: (run, dependencies) => {
        const index = effectIndex++;
        const old = effects[index];
        if (!old || dependencies.some((value, i) => value !== old.dependencies[i])) {
          old?.cleanup?.();
          effects[index] = { dependencies, run };
        }
      },
    },
    "react-native": { AppState: { addEventListener: (_name, listener) => {
      foreground = listener;
      return { remove: () => { foreground = null; } };
    } } },
    "expo-router": { usePathname: () => pathname, useRootNavigationState: () => ({ key: "mounted" }),
      useRouter: () => router, useSegments: () => segments },
    "./api": {
      api: {
        registerPushDevice: async (device, owner) => { registrations.push([owner, device]); },
        deactivatePushDevice: async (id, owner) => { deletions.push([id, owner]); },
      },
      auth: { getToken: async () => session, retryPendingPushCleanup: async () => ({}), subscribeSessionChange: (listener) => {
        sessionListener = listener;
        return () => { sessionListener = null; };
      } }, PUSH_INSTALLATION_KEY: "installation",
    },
    "./utils/storage": { storage: {
      getItem: async (key, fallback) => values.get(key) || fallback,
      setItem: async (key, value) => { values.set(key, value); return true; },
      removeItem: async (key) => { values.delete(key); return true; },
    } },
    "./preview-api": { isPreviewMode: false },
    "./nativePush": { getNativePushBridge: () => bridge, subscribeNativePush: (onState, onRoute) => {
      stateListener = onState;
      routeListener = onRoute;
      return () => { stateListener = null; routeListener = null; };
    } },
    "./nativePushRuntime": module.exports,
  });
  function render() {
    refIndex = 0;
    effectIndex = 0;
    hook.usePushBridge();
    effects.forEach((effect) => {
      if (effect.run) {
        effect.cleanup = effect.run();
        effect.run = null;
      }
    });
  }
  render();
  await tick();
  assert.equal(registrations.length, 0);
  assert.equal(deliveredCleared, 0, "cold-start null session must not clear delivered notifications");
  session = "signed-in-owner";
  sessionListener(session);
  await tick();
  assert.equal(registrations[0][0], session);
  assert.equal(registrations[0][1].locale, "en");
  assert.equal(routes.length, 0);
  segments = ["(tabs)"];
  pathname = "/";
  render();
  await tick();
  assert.deepEqual(routes, [notification]);
  nativeState = { ...state, permissionStatus: "denied" };
  stateListener(nativeState);
  await tick();
  assert.deepEqual(deletions[0], [state.installationId, session]);
  requestsFail = false;
  nativeState = state;
  const beforeForeground = registrationsRequested;
  foreground("active");
  await tick();
  assert.ok(registrationsRequested > beforeForeground);
  assert.equal(registrations.length, 2);
  registrationGate = deferred();
  permissionOverride = "denied";
  foreground("active");
  await tick();
  registrationGate.resolve();
  await tick();
  assert.equal(registrations.length, 2, "a stale authorized snapshot cannot undo a newer denied permission");
  session = null;
  sessionListener(null);
  await tick();
  assert.equal(deliveredCleared, 1);
  effects.forEach((effect) => effect.cleanup?.());
  assert.equal(sessionListener, null);
  assert.equal(stateListener, null);
  assert.equal(routeListener, null);
  assert.equal(foreground, null);
}
console.log("Native APNs runtime: parsing, routing, permission, session races and retry checks passed.");
