import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

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
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

// Execute actual Login + auth queue + native Storage + previewRequest.
// Only native Keychain/AsyncStorage are mocked; real network is forbidden.
function fixture() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No real network allowed"); };
  const secure = new Map(), ordinary = new Map(), warnings = [];
  const f = { failWrite: false, failRead: false, failOnboarding: false,
    writeBarrier: null, readBarrier: null, loginBarrier: null, ordinaryBarrier: null, writes: 0,
    restore: () => { globalThis.fetch = originalFetch; } };
  const base = load("../src/utils/storage/storage-base.ts");
  base.StorageBase.prototype.warn = (operation) => warnings.push(operation);
  const native = load("../src/utils/storage/index.ts", {
    "./storage-base": base,
    "@react-native-async-storage/async-storage": {
      getItem: async (key) => ordinary.get(key) ?? null,
      setItem: async (key, value) => {
        if (f.ordinaryBarrier) await f.ordinaryBarrier.promise;
        if (f.failOnboarding && key.endsWith("onboarding_completed")) throw new Error("fixture ordinary-write fault");
        ordinary.set(key, value);
      },
      removeItem: async (key) => { ordinary.delete(key); },
    },
    "expo-secure-store": {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
      getItemAsync: async (key, options) => {
        if (f.writes && f.readBarrier) await f.readBarrier.promise;
        if (f.writes && f.failRead) throw new Error("fixture Keychain read fault");
        return secure.get(options.keychainService + ":" + key) ?? null;
      },
      setItemAsync: async (key, value, options) => {
        if (value === '"preview-token"' && f.writeBarrier) await f.writeBarrier.promise;
        if (value === '"preview-token"' && f.failWrite) throw new Error("fixture Keychain write fault");
        secure.set(options.keychainService + ":" + key, value); f.writes++;
      },
      deleteItemAsync: async (key, options) => { secure.delete(options.keychainService + ":" + key); },
    },
  });
  const preview = load("../src/preview-api.ts");
  const client = load("../src/api.ts", {
    "./theme": { API: "https://login-storage-test.invalid/api" }, "./utils/storage": native,
    "./preview-api": { ...preview, isPreviewMode: true, previewRequest: async (path, init) => {
      if (path === "/auth/login" && f.loginBarrier) await f.loginBarrier.promise;
      return preview.previewRequest(path, init);
    } },
    "./aiConsent": load("../src/aiConsent.ts"), "./sessionBoundary": load("../src/sessionBoundary.ts"),
  });
  return Object.assign(f, client, { native, secure, ordinary, warnings });
}

function runner() {
  const slots = [], effects = [];
  let cursor = 0, pending = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: typeof initial === "function" ? initial() : initial };
      slots[n].set ||= (next) => { slots[n].value = typeof next === "function" ? next(slots[n].value) : next; };
      return [slots[n].value, slots[n].set];
    },
    useRef(initial) { const n = cursor++; return slots[n] ||= { current: initial }; },
    useCallback(fn, deps) { const n = cursor++; if (!slots[n] || !same(slots[n].deps, deps)) slots[n] = { fn, deps }; return slots[n].fn; },
    useEffect(fn, deps) { const n = cursor++; if (!effects[n] || !same(effects[n].deps, deps)) pending.push(() => { effects[n]?.cleanup?.(); effects[n] = { deps, cleanup: fn() }; }); },
    useSyncExternalStore(_subscribe, snapshot) { cursor++; return snapshot(); },
  };
  return { react, render(fn) { cursor = 0; pending = []; const tree = fn(); pending.forEach((effect) => effect()); return tree; },
    unmount() { effects.forEach((effect) => effect?.cleanup?.()); } };
}

function page(f, locale = "en") {
  const r = runner(), routes = [];
  const jsx = (type, props) => ({ type, props });
  const component = load("../app/login.tsx", {
    react: r.react, "react/jsx-runtime": { jsx, jsxs: jsx }, "@/src/api": f,
    "@/src/useAccountState": load("../src/useAccountState.ts", { react: r.react, "./api": f }),
    "react-native": { View: "View", Text: "Text", TextInput: "Input", Pressable: "Pressable", KeyboardAvoidingView: "KeyboardAvoidingView",
      ScrollView: "ScrollView", Platform: { OS: "ios" }, StyleSheet: { create: (value) => value } },
    "expo-router": { useRouter: () => ({ replace: (href) => routes.push(href), push: (href) => routes.push(href) }), useLocalSearchParams: () => ({}) },
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" }, "@react-navigation/elements": { useHeaderHeight: () => 44 },
    "@expo/vector-icons": { Ionicons: "Icon" }, "@/src/theme": { colors: {}, spacing: {}, radius: {}, type: {} },
    "@/src/authFlow": { savePendingVerification: async () => {} },
    "@/src/i18n": { useT: () => ({ locale, t: (key) => key, setLocale: async () => {} }) },
    "@/src/nativePushRuntime": { safeNotificationRoute: () => null },
  }).default;
  let tree;
  const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node)
    ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const p = { routes, unmount: r.unmount, render: () => { tree = r.render(component); return tree; },
    find: (id) => nodes(tree).find((node) => node.props?.testID === id), visible: () => JSON.stringify(tree) };
  p.fill = () => { p.find("login-email").props.onChangeText("fixture@example.invalid"); p.find("login-password").props.onChangeText("fixture-password"); p.render(); };
  p.submit = () => p.find("login-submit-btn").props.onPress();
  return p;
}

test("actual native Storage + preview Login persists secure token and navigates normally", async () => {
  const f = fixture(); let p;
  try {
    p = page(f); p.render(); p.fill(); await p.submit(); p.render();
    assert.equal(await f.auth.getToken(), "preview-token"); assert.deepEqual(p.routes, ["/(tabs)"]);
    assert.equal(p.find("login-error"), undefined);
    assert.equal(await new f.native.Storage().secureGet("auth_token", ""), "preview-token", "new storage instance sees secure persistence");
    assert.ok([...f.secure.keys()].every((key) => key.startsWith(f.native.NATIVE_SECURE_STORAGE_OPTIONS.keychainService + ":")));
  } finally { p?.unmount(); f.restore(); }
});

for (const [fault, warning, message] of [["failWrite", "secureSet", /could not be saved securely/],
  ["failRead", "secureGet", /could not read back/], ["failOnboarding", "setItem", /could not save your sign-in setup/]]) {
  test("actual " + fault + " resets form yet displays actionable local-storage error", async () => {
    const f = fixture(); let p;
    try {
      f[fault] = true; p = page(f); p.render(); p.fill(); await p.submit(); p.render();
      assert.equal(p.find("login-email").props.value, ""); assert.equal(p.find("login-password").props.value, "");
      assert.ok(p.find("login-error")); assert.match(p.visible(), message); assert.match(p.visible(), /retry/);
      assert.doesNotMatch(p.visible(), /邮箱或密码错误/); assert.deepEqual(p.routes, []); assert.ok(f.warnings.includes(warning));
      if (fault === "failWrite") assert.equal(f.secure.size, 0);
      assert.ok([...f.ordinary.keys()].every((key) => !key.endsWith("auth_token")), "no plaintext auth fallback");
      f[fault] = false; p.fill(); await p.submit(); p.render();
      assert.deepEqual(p.routes, ["/(tabs)"]); assert.equal(p.find("login-error"), undefined); assert.equal(await f.auth.getToken(), "preview-token");
    } finally { p?.unmount(); f.restore(); }
  });
}

for (const [locale, message] of [["zh-CN", "本机未能安全保存登录凭据"], ["zh-TW", "本機未能安全保存登入憑據"]]) test(locale + " local failure is explicit and retryable", async () => {
  const f = fixture(); let p;
  try {
    f.failWrite = true; p = page(f, locale); p.render(); p.fill(); await p.submit(); p.render();
    assert.ok(p.visible().includes(message)); assert.ok(p.find("login-error")); assert.deepEqual(p.routes, []);
  } finally { p?.unmount(); f.restore(); }
});

test("held A Keychain write failure followed by queued B cannot display A error or clear B", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    f.failWrite = true; f.writeBarrier = held; p = page(f); p.render(); p.fill(); const pending = p.submit(); await tick();
    const b = f.auth.setToken("fixture-B"); held.resolve(); await pending; await b; p.render();
    assert.equal(await f.auth.getToken(), "fixture-B"); assert.equal(p.find("login-error"), undefined); assert.deepEqual(p.routes, []);
  } finally { held.resolve(); p?.unmount(); f.restore(); }
});

for (const change of ["B", "ABA", "logout", "unmount"]) test("held A secure read failure after " + change + " cannot publish old error or navigate", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    f.failRead = true; f.readBarrier = held; p = page(f); p.render(); p.fill(); const pending = p.submit(); await tick();
    assert.ok(f.writes > 0, "A secure write must precede held read");
    // Unblock native reads used by auth CAS for other operations. The already
    // pending A read still waits on its captured barrier and fails when released.
    f.readBarrier = null;
    if (change === "B" || change === "ABA") { await f.auth.setToken("fixture-B"); if (change === "ABA") await f.auth.setToken("preview-token"); }
    else if (change === "logout") { f.failRead = false; await f.auth.clearToken({ forceLocal: true }); f.failRead = true; }
    else p.unmount();
    held.resolve(); await pending; p.render();
    assert.equal(p.find("login-error"), undefined); assert.deepEqual(p.routes, []);
    f.failRead = false;
    assert.equal(await f.auth.getToken(), change === "B" ? "fixture-B" : change === "logout" ? null : "preview-token");
  } finally { held.resolve(); p?.unmount(); f.restore(); }
});

test("queued B ahead of A setToken returns CAS false without a misleading save error", async () => {
  const f = fixture(), login = deferred(), queue = deferred(); let p;
  try {
    f.loginBarrier = login; p = page(f); p.render(); p.fill(); const pending = p.submit(); await tick();
    f.ordinaryBarrier = queue; const block = f.auth.setOnboarded(false); await tick(); const b = f.auth.setToken("fixture-B");
    login.resolve(); await tick(); f.ordinaryBarrier = null; queue.resolve(); await block; await b; await pending; p.render();
    assert.equal(await f.auth.getToken(), "fixture-B"); assert.equal(p.find("login-error"), undefined); assert.deepEqual(p.routes, []);
  } finally { login.resolve(); queue.resolve(); p?.unmount(); f.restore(); }
});

test("already-visible A local failure disappears immediately for B identity", async () => {
  const f = fixture(); let p;
  try {
    f.failWrite = true; p = page(f); p.render(); p.fill(); await p.submit(); p.render(); assert.ok(p.find("login-error"));
    await f.auth.setToken("fixture-B"); p.render(); assert.equal(p.find("login-error"), undefined); assert.deepEqual(p.routes, []);
  } finally { p?.unmount(); f.restore(); }
});
