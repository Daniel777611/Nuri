import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function load(path, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    assert.ok(name in dependencies, "unexpected dependency " + name);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const IOS_ID = "123456789-labios.apps.googleusercontent.com";
const WEB_ID = "123456789-nuriweb.apps.googleusercontent.com";
const CREDENTIAL = "fixtureHeader.fixtureGoogleIdentity.fixtureSignature";
const CONFIG = { bundleId: "com.ordashtech.nuri.nativelab", iosClientId: IOS_ID, webClientId: WEB_ID, callbackRegistered: true };

// Run the real API, auth queue, native Storage, SDK adapter and session helper.
// Only OS / provider UI / server are fake. Every fetch is bounded to .invalid;
// there are no Google account actions or production/AI calls in these tests.
function fixture() {
  const originalFetch = globalThis.fetch;
  const secure = new Map(), ordinary = new Map(), requests = [], providerCalls = [];
  const f = { configuration: CONFIG, nativeLinked: true, platform: "ios", bridgeLinked: true, mounted: true,
    sdkBarrier: null, apiBarrier: null, writeBarrier: null, readBarrier: null, localeBarrier: null,
    failWrite: false, failRead: false, failOnboarding: false, cancel: false, sdkError: null,
    idToken: CREDENTIAL, responseStatus: 200, responseDetail: null,
    response: { access_token: "nuri-A", token_type: "bearer", user: { id: "user-A", email: "A@example.invalid", onboarding_completed: true, language: "en" }, created: false },
    restore: () => { globalThis.fetch = originalFetch; } };
  const base = load("../src/utils/storage/storage-base.ts");
  base.StorageBase.prototype.warn = () => {};
  const native = load("../src/utils/storage/index.ts", {
    "./storage-base": base,
    "@react-native-async-storage/async-storage": {
      getItem: async (key) => ordinary.get(key) ?? null,
      setItem: async (key, value) => { if (f.failOnboarding && key.endsWith("onboarding_completed")) throw Error("fixture ordinary fault"); ordinary.set(key, value); },
      removeItem: async (key) => { ordinary.delete(key); },
    },
    "expo-secure-store": {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
      getItemAsync: async (key, options) => {
        if (secure.size && f.readBarrier) await f.readBarrier.promise;
        if (secure.size && f.failRead) throw Error("fixture keychain read fault");
        return secure.get(options.keychainService + ":" + key) ?? null;
      },
      setItemAsync: async (key, value, options) => {
        if (value === '"nuri-A"' && f.writeBarrier) await f.writeBarrier.promise;
        if (value === '"nuri-A"' && f.failWrite) throw Error("fixture keychain write fault");
        secure.set(options.keychainService + ":" + key, value);
      },
      deleteItemAsync: async (key, options) => { secure.delete(options.keychainService + ":" + key); },
    },
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://google-signin-test.invalid/api/auth/google", "no real or unrelated endpoint may run");
    requests.push({ url, init });
    if (f.apiBarrier) await f.apiBarrier.promise;
    return new Response(JSON.stringify(f.responseStatus === 200 ? f.response : { detail: f.responseDetail }), { status: f.responseStatus });
  };
  const api = load("../src/api.ts", {
    "./theme": { API: "https://google-signin-test.invalid/api" }, "./utils/storage": native,
    "./preview-api": { isPreviewMode: false, previewRequest: () => { throw Error("Google is never a fixture preview auth flow"); } },
    "./aiConsent": load("../src/aiConsent.ts"), "./sessionBoundary": load("../src/sessionBoundary.ts"),
  });
  const sdk = { GoogleSignin: {
    configure: (value) => { providerCalls.push({ method: "configure", value }); },
    signOut: async () => { providerCalls.push({ method: "signOut" }); },
    signIn: async () => {
      providerCalls.push({ method: "signIn" });
      if (f.sdkBarrier) await f.sdkBarrier.promise;
      if (f.sdkError) throw f.sdkError;
      return f.cancel ? { type: "cancelled", data: null } : { type: "success", data: { idToken: f.idToken, user: { id: "untrusted-provider-id", email: "untrusted@example.invalid" } } };
    },
  }, isErrorWithCode: (error) => typeof error?.code === "string", statusCodes: { SIGN_IN_CANCELLED: "cancelled" },
  GoogleSigninButton: Object.assign(() => null, { Size: { Wide: 2 }, Color: { Light: "light" } }) };
  const adapter = load("../src/googleNativeAuth.ts", { "react-native": {
    Platform: { get OS() { return f.platform; } },
    TurboModuleRegistry: { get: () => f.nativeLinked ? {} : null },
    NativeModules: { get NuriGoogleAuthBridge() { return f.bridgeLinked ? { getConfiguration: async () => f.configuration } : null; } },
  }, "@react-native-google-signin/google-signin": sdk });
  const session = load("../src/googleSignInSession.ts", { "./api": api, "./googleNativeAuth": adapter });
  const routes = [], localeWrites = [];
  const options = (extra = {}) => {
    const ticket = api.auth.getSessionGeneration();
    return { ticket, current: (value) => f.mounted && value === api.auth.getSessionGeneration(), isMounted: () => f.mounted,
      language: "en", setLocale: async (value) => { localeWrites.push(value); if (f.localeBarrier) await f.localeBarrier.promise; },
      navigate: (onboarded) => { routes.push(onboarded ? "/(tabs)" : "/onboarding"); }, ...extra };
  };
  return Object.assign(f, api, adapter, session, { native, secure, ordinary, requests, providerCalls, routes, localeWrites, options, sdk });
}

test("actual installed native configuration must be the Lab bundle and have both public IDs plus callback", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.getNativeGoogleConfiguration(), CONFIG);
    for (const bad of [null, { ...CONFIG, bundleId: "com.ordashtech.nuri" }, { ...CONFIG, iosClientId: "" }, { ...CONFIG, webClientId: "" }, { ...CONFIG, callbackRegistered: false }, { ...CONFIG, iosClientId: "secret" }]) {
      f.configuration = bad; assert.equal(await f.getNativeGoogleConfiguration(), null);
      await assert.rejects(f.signInWithNativeGoogle(f.options()), { code: "unavailable" });
    }
    assert.equal(f.providerCalls.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.secure.size, 0);
  } finally { f.restore(); }
});

for (const missing of ["nativeLinked", "bridgeLinked", "platform"]) test("missing " + missing + " fails closed without loading provider UI", async () => {
  const f = fixture();
  try {
    f[missing] = missing === "platform" ? "web" : false;
    assert.equal(await f.getNativeGoogleConfiguration(), null);
    await assert.rejects(f.signInWithNativeGoogle(f.options()), { code: "unavailable" });
    assert.deepEqual(f.providerCalls, []); assert.deepEqual(f.requests, []);
  } finally { f.restore(); }
});

for (const created of [false, true]) test("actual SDK → server ID-token exchange → private Keychain follows existing " + (created ? "new" : "existing") + " account", async () => {
  const f = fixture();
  try {
    f.response = { ...f.response, created, user: { ...f.response.user, onboarding_completed: !created } };
    assert.equal(await f.signInWithNativeGoogle(f.options()), "signed-in");
    assert.deepEqual(f.routes, [created ? "/onboarding" : "/(tabs)"]);
    assert.equal(await f.auth.getToken(), "nuri-A");
    assert.equal(await f.auth.getOnboarded(), !created);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(JSON.parse(f.requests[0].init.body), { credential: CREDENTIAL, language: "en" });
    assert.equal(f.requests[0].init.method, "POST");
    assert.deepEqual(f.providerCalls.map((call) => call.method), ["configure", "signOut", "signIn", "signOut"]);
    assert.deepEqual(f.providerCalls[0].value, { iosClientId: IOS_ID, webClientId: WEB_ID, offlineAccess: false });
    assert.ok([...f.secure.keys()].every((key) => key.startsWith("com.ordashtech.nuri.nativelab.credentials.v1:")));
    assert.ok([...f.ordinary.keys()].every((key) => !key.endsWith("auth_token")));
    assert.ok(![...f.secure.values(), ...f.ordinary.values()].some((value) => value.includes(CREDENTIAL)), "Google token/profile is not persisted");
  } finally { f.restore(); }
});

for (const cancelled of ["response", "legacy-error"]) test("native cancellation " + cancelled + " never contacts backend or changes session", async () => {
  const f = fixture();
  try {
    if (cancelled === "response") f.cancel = true; else f.sdkError = { code: "cancelled", message: CREDENTIAL };
    assert.equal(await f.signInWithNativeGoogle(f.options()), "cancelled");
    assert.equal(f.requests.length, 0); assert.equal(await f.auth.getToken(), null); assert.deepEqual(f.routes, []);
  } finally { f.restore(); }
});

test("SDK failures do not expose provider error bodies / tokens", async () => {
  const f = fixture();
  try {
    f.sdkError = { message: CREDENTIAL };
    await assert.rejects(f.signInWithNativeGoogle(f.options()), (error) => error.code === "failed" && !error.message.includes(CREDENTIAL));
    assert.equal(f.requests.length, 0);
  } finally { f.restore(); }
});

for (const invalid of [null, "small", "not-a-jwt-at-all", "a".repeat(8001)]) test("invalid native ID-token shape fails closed: " + String(invalid).slice(0, 15), async () => {
  const f = fixture();
  try {
    f.idToken = invalid; await assert.rejects(f.signInWithNativeGoogle(f.options()), { code: "invalid-token" });
    assert.equal(f.requests.length, 0); assert.equal(f.secure.size, 0);
  } finally { f.restore(); }
});

for (const [status, detail] of [[401, "GOOGLE_TOKEN_INVALID"], [503, "GOOGLE_SIGNIN_UNAVAILABLE"]]) test("backend " + status + " does not install session or auto clear credentials", async () => {
  const f = fixture();
  try {
    f.responseStatus = status; f.responseDetail = detail;
    await assert.rejects(f.signInWithNativeGoogle(f.options()), (error) => f.apiErrorDetail(error) === detail);
    assert.equal(await f.auth.getToken(), null); assert.equal(f.secure.size, 0); assert.equal(f.auth.getSessionGeneration(), 0); assert.deepEqual(f.routes, []);
  } finally { f.restore(); }
});

test("an already signed-in account cannot be silently replaced from registration", async () => {
  const f = fixture();
  try { await f.auth.setToken("nuri-B"); assert.equal(await f.signInWithNativeGoogle(f.options()), "stale"); assert.equal(await f.auth.getToken(), "nuri-B"); assert.equal(f.providerCalls.length, 0); }
  finally { f.restore(); }
});

test("double press / second mounted button is rejected while first native chooser is in flight", async () => {
  const f = fixture(), held = deferred();
  try {
    f.sdkBarrier = held; const first = f.signInWithNativeGoogle(f.options()); await tick();
    await assert.rejects(f.signInWithNativeGoogle(f.options()), { code: "in-progress" });
    assert.equal(f.providerCalls.filter((call) => call.method === "signIn").length, 1);
    held.resolve(); await first; assert.equal(f.requests.length, 1);
  } finally { held.resolve(); f.restore(); }
});

for (const phase of ["sdk", "api", "locale"]) for (const change of ["B", "ABA", "logout", "unmount"]) test(phase + " late A after " + change + " cannot replace / route new owner", async () => {
  const f = fixture(), held = deferred();
  try {
    f[phase + "Barrier"] = held; const pending = f.signInWithNativeGoogle(f.options()); await tick();
    if (change === "B" || change === "ABA") { await f.auth.setToken("nuri-B"); if (change === "ABA") await f.auth.setToken("nuri-A"); }
    else if (change === "logout") await f.auth.clearToken({ forceLocal: true });
    else f.mounted = false;
    held.resolve(); assert.equal(await pending, "stale"); assert.deepEqual(f.routes, []);
    assert.equal(await f.auth.getToken(), change === "B" ? "nuri-B" : change === "ABA" || phase === "locale" && change === "unmount" ? "nuri-A" : null);
    if (phase === "sdk") assert.equal(f.requests.length, 0, "no token exchange after chooser lost owner");
  } finally { held.resolve(); f.restore(); }
});

for (const [fault, kind] of [["failWrite", "save"], ["failRead", "read"], ["failOnboarding", "onboarding"]]) test("actual " + fault + " is actionable and safe to retry without plaintext fallback", async () => {
  const f = fixture();
  try {
    f[fault] = true; const result = await f.signInWithNativeGoogle(f.options());
    assert.equal(result.kind, kind); assert.equal(result.identity, f.auth.getIdentityGeneration()); assert.equal(result.generation, f.auth.getSessionGeneration());
    assert.deepEqual(f.routes, []); assert.ok([...f.ordinary.keys()].every((key) => !key.endsWith("auth_token")));
    f[fault] = false; assert.equal(await f.signInWithNativeGoogle(f.options({ retryLocalFailure: true })), "signed-in"); assert.deepEqual(f.routes, ["/(tabs)"]);
  } finally { f.restore(); }
});

test("a B auth write already queued ahead of late Google A cannot be overwritten", async () => {
  const f = fixture(), held = deferred();
  try {
    f.apiBarrier = held; const pending = f.signInWithNativeGoogle(f.options()); await tick();
    const b = f.auth.setToken("nuri-B"); held.resolve(); await b; assert.equal(await pending, "stale");
    assert.equal(await f.auth.getToken(), "nuri-B"); assert.deepEqual(f.routes, []);
  } finally { held.resolve(); f.restore(); }
});

test("held Google A Keychain fault followed by queued B cannot report A local failure", async () => {
  const f = fixture(), held = deferred();
  try {
    f.failWrite = true; f.writeBarrier = held; const pending = f.signInWithNativeGoogle(f.options()); await tick();
    const b = f.auth.setToken("nuri-B"); held.resolve(); const outcome = await pending; await b;
    assert.ok(outcome === "stale" || outcome.identity !== f.auth.getIdentityGeneration() || outcome.generation !== f.auth.getSessionGeneration(), "A failure is not owned by live B and cannot be rendered");
    assert.equal(await f.auth.getToken(), "nuri-B"); assert.deepEqual(f.routes, []);
  } finally { held.resolve(); f.restore(); }
});

test("Expo plugin uses official callback scheme, preserves lab identity and fails closed without IDs", async () => {
  const plugin = require("../plugins/withNuriGoogleSignIn.js");
  const empty = { name: "NURI Native Lab", ios: { bundleIdentifier: CONFIG.bundleId }, _internal: { projectRoot: new URL("..", import.meta.url).pathname } };
  const savedIOS = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, savedWeb = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID; delete process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
  try {
    assert.equal(plugin(empty), empty);
    assert.throws(() => plugin(structuredClone(empty), { iosClientId: IOS_ID }), /real public/);
    assert.throws(() => plugin({ ...empty, ios: { bundleIdentifier: "com.ordashtech.nuri" } }, { iosClientId: IOS_ID, webClientId: WEB_ID }), /independent/);
    const configured = plugin(structuredClone(empty), { iosClientId: IOS_ID, webClientId: WEB_ID });
    const mod = await configured.mods.ios.infoPlist({ ...configured, modRawConfig: structuredClone(empty), modResults: { CFBundleURLTypes: [{ CFBundleURLSchemes: ["nuri-native-lab"] }] }, modRequest: { platform: "ios", introspect: true } });
    assert.equal(mod.modResults.GIDClientID, IOS_ID); assert.equal(mod.modResults.GIDServerClientID, WEB_ID);
    assert.deepEqual(mod.modResults.CFBundleURLTypes.flatMap((item) => item.CFBundleURLSchemes), ["nuri-native-lab", "com.googleusercontent.apps.123456789-labios"]);
    assert.equal(configured.ios.bundleIdentifier, CONFIG.bundleId);
  } finally {
    if (savedIOS === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID; else process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = savedIOS;
    if (savedWeb === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID; else process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID = savedWeb;
  }
});

test("native callbacks coexist with push/linking and both forms use the real native component", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../native/NuriAppDelegate.swift"), /#if canImport\(GoogleSignIn\)[\s\S]*GIDSignIn\.sharedInstance\.handle\(url\)/);
  assert.match(read("../native/NuriAppDelegate.swift"), /RCTLinkingManager\.application\(app, open: url/);
  assert.match(read("../plugins/withNuriNative.js"), /NuriGoogleAuthBridge\.swift/);
  assert.match(read("../native/NuriGoogleAuthBridge.swift"), /Bundle\.main/);
  for (const path of ["../app/login.tsx", "../app/register.tsx"]) assert.match(read(path), /<GoogleSignInButton disabled=\{submitting\}/);
  assert.doesNotMatch(read("../src/components/GoogleSignInButton.tsx"), /document\.|window\.|gsi\/client|createElement\("div"/);
});

function runner() {
  const slots = [], effects = [];
  let cursor = 0, pending = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) { const n = cursor++; if (!slots[n]) slots[n] = { value: typeof initial === "function" ? initial() : initial }; slots[n].set ||= (next) => { slots[n].value = typeof next === "function" ? next(slots[n].value) : next; }; return [slots[n].value, slots[n].set]; },
    useRef(initial) { const n = cursor++; return slots[n] ||= { current: initial }; },
    useCallback(fn, deps) { const n = cursor++; if (!slots[n] || !same(slots[n].deps, deps)) slots[n] = { fn, deps }; return slots[n].fn; },
    useEffect(fn, deps) { const n = cursor++; if (!effects[n] || !same(effects[n].deps, deps)) pending.push(() => { effects[n]?.cleanup?.(); effects[n] = { deps, cleanup: fn() }; }); },
    useSyncExternalStore(_subscribe, snapshot) { cursor++; return snapshot(); },
  };
  return { react, render(fn) { cursor = 0; pending = []; const tree = fn(); pending.forEach((effect) => effect()); return tree; }, unmount() { effects.forEach((effect) => effect?.cleanup?.()); } };
}

function button(f, props = {}) {
  const r = runner(), routes = [], busy = [];
  const jsx = (type, props) => ({ type, props });
  const component = load("../src/components/GoogleSignInButton.tsx", {
    react: r.react, "react/jsx-runtime": { jsx, jsxs: jsx }, "@/src/api": f,
    "@/src/useAccountState": load("../src/useAccountState.ts", { react: r.react, "./api": f }),
    "react-native": { View: "View", Text: "Text", ActivityIndicator: "Spinner", Platform: { OS: "ios" }, StyleSheet: { create: (value) => value } },
    "expo-router": { useRouter: () => ({ replace: (href) => routes.push(href) }) },
    "@/src/i18n": { useT: () => ({ t: (value) => value, locale: "en", setLocale: async () => {} }) },
    "@/src/theme": { colors: {}, type: {}, spacing: {} },
    "@/src/googleNativeAuth": f, "@/src/googleSignInSession": f,
    "@/src/nativePushRuntime": load("../src/nativePushRuntime.ts"),
  }).default;
  let tree;
  const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  return { routes, busy, render: () => { tree = r.render(() => component({ onBusyChange: (value) => busy.push(value), ...props })); return tree; },
    find: (id) => nodes(tree).find((node) => node.props?.testID === id), visible: () => JSON.stringify(tree),
    unmount: () => { f.mounted = false; r.unmount(); }, };
}

test("actual unconfigured native button explains unavailable without SDK / server activity", async () => {
  const f = fixture(), p = button(f);
  try {
    f.configuration = null; p.render(); await tick(); p.render();
    assert.ok(p.find("google-signin-unavailable")); assert.equal(p.find("google-signin-native-button"), undefined);
    assert.deepEqual(f.providerCalls, []); assert.deepEqual(f.requests, []);
  } finally { p.unmount(); f.restore(); }
});

test("actual native button double press shares email form lock and cancellation is quiet", async () => {
  const f = fixture(), held = deferred(); let locked = false;
  const p = button(f, { acquire: () => { if (locked) return false; locked = true; return true; }, release: () => { locked = false; } });
  try {
    f.cancel = true; f.sdkBarrier = held; p.render(); await tick(); p.render();
    const pending = p.find("google-signin-native-button").props.onPress(); await tick();
    await p.find("google-signin-native-button").props.onPress();
    assert.equal(locked, true); held.resolve(); await pending; p.render();
    assert.equal(locked, false); assert.deepEqual(p.busy, [true, false]); assert.equal(p.find("google-signin-error"), undefined); assert.deepEqual(p.routes, []);
    assert.equal(f.providerCalls.filter((call) => call.method === "signIn").length, 1);
  } finally { held.resolve(); p.unmount(); f.restore(); }
});

test("actual native button shows server unavailable, not a false login success", async () => {
  const f = fixture(), p = button(f);
  try {
    f.responseStatus = 503; f.responseDetail = "GOOGLE_SIGNIN_UNAVAILABLE"; p.render(); await tick(); p.render();
    await p.find("google-signin-native-button").props.onPress(); p.render();
    assert.ok(p.find("google-signin-error")); assert.match(p.visible(), /Google 登录暂时不可用/); assert.deepEqual(p.routes, []); assert.equal(await f.auth.getToken(), null);
  } finally { p.unmount(); f.restore(); }
});

for (const [fault, message] of [["failWrite", /安全保存 Google 登录凭据/], ["failRead", /读回安全保存/], ["failOnboarding", /保存登录设置/]]) test("actual Google button " + fault + " bound error disappears on B", async () => {
  const f = fixture(), p = button(f);
  try {
    f[fault] = true; p.render(); await tick(); p.render(); await p.find("google-signin-native-button").props.onPress(); p.render();
    assert.ok(p.find("google-signin-error")); assert.match(p.visible(), message); assert.deepEqual(p.routes, []);
    await f.auth.setToken("nuri-B"); p.render(); assert.equal(p.find("google-signin-error"), undefined); assert.deepEqual(p.routes, []);
  } finally { p.unmount(); f.restore(); }
});

for (const returnTo of ["https://external.invalid", "/notification-settings", "/notifications/11111111-1111-1111-1111-111111111111"]) test("actual Google navigation accepts only pending notification detail: " + returnTo, async () => {
  const f = fixture(), p = button(f, { returnTo });
  try {
    p.render(); await tick(); p.render(); await p.find("google-signin-native-button").props.onPress(); p.render();
    assert.deepEqual(p.routes, [returnTo.includes("/notifications/") ? returnTo : "/(tabs)"]);
  } finally { p.unmount(); f.restore(); }
});

test("actual Google button unmounted during chooser does not exchange token or navigate", async () => {
  const f = fixture(), p = button(f), held = deferred();
  try {
    f.sdkBarrier = held; p.render(); await tick(); p.render(); const pending = p.find("google-signin-native-button").props.onPress(); await tick();
    p.unmount(); held.resolve(); await pending; assert.equal(f.requests.length, 0); assert.deepEqual(p.routes, []);
  } finally { held.resolve(); f.restore(); }
});
