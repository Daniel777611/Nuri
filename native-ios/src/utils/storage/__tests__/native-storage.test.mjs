import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function load(relative, dependencies = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const result = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(name in dependencies, "unexpected dependency " + name);
    return dependencies[name];
  }, result, result.exports);
  return result.exports;
}

function fixture() {
  const ordinary = new Map([
    ["onboarding_completed", "true"], ["ui_language", '"original-language"'],
    ["nuri.push.installation_id", '"original-installation"'],
  ]);
  const secure = new Map([["app:auth_token", '"original-session"']]);
  const calls = [];
  const failures = new Set();
  const fail = (operation) => { if (failures.has(operation)) throw new Error("simulated " + operation); };
  const asyncStorage = {
    getItem: async (key) => { calls.push(["get", key]); fail("get"); return ordinary.get(key) ?? null; },
    setItem: async (key, value) => { calls.push(["set", key]); fail("set"); ordinary.set(key, value); },
    removeItem: async (key) => { calls.push(["remove", key]); fail("remove"); ordinary.delete(key); },
  };
  const secureStore = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
    getItemAsync: async (key, options) => { calls.push(["secureGet", key, options]); fail("secureGet"); return secure.get(options.keychainService + ":" + key) ?? null; },
    setItemAsync: async (key, value, options) => { calls.push(["secureSet", key, options]); fail("secureSet"); secure.set(options.keychainService + ":" + key, value); },
    deleteItemAsync: async (key, options) => { calls.push(["secureRemove", key, options]); fail("secureRemove"); secure.delete(options.keychainService + ":" + key); },
  };
  const base = load("../storage-base.ts");
  base.StorageBase.prototype.warn = () => {};
  const native = load("../index.ts", {
    "@react-native-async-storage/async-storage": asyncStorage,
    "expo-secure-store": secureStore,
    "./storage-base": base,
  });
  const web = load("../index.web.ts", {
    "@react-native-async-storage/async-storage": asyncStorage,
    "./storage-base": base,
  });
  const assertOriginalUntouched = () => {
    assert.equal(secure.get("app:auth_token"), '"original-session"');
    assert.equal(ordinary.get("onboarding_completed"), "true");
    assert.equal(ordinary.get("ui_language"), '"original-language"');
    assert.equal(ordinary.get("nuri.push.installation_id"), '"original-installation"');
  };
  return { native, web, ordinary, secure, calls, failures, assertOriginalUntouched };
}

test("a lab install never inherits an original session or unprefixed defaults", async () => {
  const f = fixture();
  assert.equal(await f.native.storage.secureGet("auth_token", ""), "");
  assert.equal(await f.native.storage.getItem("onboarding_completed", false), false);
  assert.equal(await f.native.storage.getItem("ui_language", "zh-CN"), "zh-CN");
  assert.equal(await f.native.storage.getItem("nuri.push.installation_id", null), null);
  assert.ok(f.calls.every((call) => call[1].startsWith(f.native.NATIVE_STORAGE_NAMESPACE)));
  f.assertOriginalUntouched();
});

test("native values round-trip and lab removal never touches original keys", async () => {
  const f = fixture();
  for (const [index, value] of ["lab-session", 42, true, null].entries()) {
    const key = "roundtrip." + index;
    assert.equal(await f.native.storage.setItem(key, value), true);
    assert.equal(await f.native.storage.getItem(key, "fallback"), value);
    assert.equal(await f.native.storage.secureSet(key, value), true);
    assert.equal(await f.native.storage.secureGet(key, "fallback"), value);
    assert.equal(await f.native.storage.removeItem(key), true);
    assert.equal(await f.native.storage.secureRemove(key), true);
    assert.equal(await f.native.storage.getItem(key, "fallback"), "fallback");
    assert.equal(await f.native.storage.secureGet(key, "fallback"), "fallback");
  }
  f.assertOriginalUntouched();
});

test("all secure reads, writes, and deletes use one private lab service", async () => {
  const f = fixture();
  await f.native.storage.secureSet("auth_token", "lab-session");
  await f.native.storage.secureGet("auth_token", "");
  await f.native.storage.secureRemove("auth_token");
  for (const [operation, key, options] of f.calls) {
    assert.ok(operation.startsWith("secure"));
    assert.equal(key, f.native.NATIVE_STORAGE_NAMESPACE + "auth_token");
    assert.equal(options, f.native.NATIVE_SECURE_STORAGE_OPTIONS);
    assert.equal(options.keychainService, "com.ordashtech.nuri.nativelab.credentials.v1");
    assert.equal(options.keychainAccessible, 7);
    assert.ok(!Object.hasOwn(options, "accessGroup"), "do not request a shared original-app access group");
  }
  assert.ok(Object.isFrozen(f.native.NATIVE_SECURE_STORAGE_OPTIONS));
  f.assertOriginalUntouched();
});

test("lab data persists in a new Storage instance but has no default-service fallback", async () => {
  const f = fixture();
  await f.native.storage.secureSet("auth_token", "lab-session");
  await f.native.storage.setItem("ui_language", "en");
  const next = new f.native.Storage();
  assert.equal(await next.secureGet("auth_token", ""), "lab-session");
  assert.equal(await next.getItem("ui_language", ""), "en");
  await next.secureRemove("auth_token");
  // Even a same-account key in the old/default service must remain invisible.
  f.secure.set("app:" + f.native.NATIVE_STORAGE_NAMESPACE + "auth_token", '"not-lab-service"');
  assert.equal(await next.secureGet("auth_token", ""), "");
  f.assertOriginalUntouched();
});

test("failed operations preserve fallback/boolean contracts and original data", async () => {
  const f = fixture();
  for (const operation of ["get", "set", "remove", "secureGet", "secureSet", "secureRemove"]) {
    f.failures.add(operation);
    const result = operation === "get" ? await f.native.storage.getItem("auth_token", "fallback")
      : operation === "set" ? await f.native.storage.setItem("auth_token", "lab")
      : operation === "remove" ? await f.native.storage.removeItem("auth_token")
      : operation === "secureGet" ? await f.native.storage.secureGet("auth_token", "fallback")
      : operation === "secureSet" ? await f.native.storage.secureSet("auth_token", "lab")
      : await f.native.storage.secureRemove("auth_token");
    assert.equal(result, operation.endsWith("Get") || operation === "get" ? "fallback" : false);
    f.failures.delete(operation);
  }
  f.assertOriginalUntouched();
});

test("web storage retains its existing unprefixed semantics independently", async () => {
  const f = fixture();
  assert.equal(await f.web.storage.getItem("ui_language", ""), "original-language");
  await f.native.storage.setItem("ui_language", "en");
  await f.native.storage.removeItem("ui_language");
  assert.equal(await f.web.storage.getItem("ui_language", ""), "original-language");
  f.assertOriginalUntouched();
});

function authFixture(f) {
  return load("../../../api.ts", {
    "./theme": { API: "https://nuri.invalid/api" },
    "./preview-api": { isPreviewMode: false },
    "./utils/storage": { storage: f.native.storage },
    "./aiConsent": load("../../../aiConsent.ts"),
    "./sessionBoundary": load("../../../sessionBoundary.ts"),
  }).auth;
}

test("actual auth logout clears only lab token/onboarding, not original app data", async () => {
  const f = fixture();
  const auth = authFixture(f);
  await auth.setToken("lab-A");
  await auth.setOnboarded(true, { expectedToken: "lab-A" });
  assert.equal(await auth.getToken(), "lab-A");
  assert.equal(await auth.clearToken({ forceLocal: true, expectedToken: "lab-A" }), true);
  assert.equal(await f.native.storage.secureGet("auth_token", ""), "");
  assert.equal(await f.native.storage.getItem("onboarding_completed", false), false);
  f.assertOriginalUntouched();
});

test("actual auth CAS still refuses to clear a newer lab session", async () => {
  const f = fixture();
  const auth = authFixture(f);
  await auth.setToken("lab-A");
  const replace = auth.setToken("lab-B");
  const staleCleanup = auth.clearToken({ forceLocal: true, expectedToken: "lab-A" });
  await replace;
  assert.equal(await staleCleanup, false);
  assert.equal(await auth.getToken(), "lab-B");
  f.assertOriginalUntouched();
});

test("actual auth Keychain tombstone retry deletes only the original rejected lab session", async () => {
  const f = fixture();
  const auth = authFixture(f);
  await auth.setToken("lab-A");
  f.failures.add("secureRemove");
  await assert.rejects(auth.clearToken({ forceLocal: true, expectedToken: "lab-A" }), (error) => error.code === "LOCAL_SIGNOUT_FAILED");
  assert.equal(await auth.getToken(), null);
  assert.equal(await f.native.storage.secureGet("auth_token", ""), "lab-A");
  f.assertOriginalUntouched();
  f.failures.delete("secureRemove");
  assert.equal(await auth.clearToken({ forceLocal: true, expectedToken: "lab-A" }), true);
  f.assertOriginalUntouched();
});
