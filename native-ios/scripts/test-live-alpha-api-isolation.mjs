import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFileSync(path.join(root, file), "utf8");
const originalModule = path.join(root, "src/preview-api.ts");
const unavailableModule = path.join(root, "src/preview-api.unavailable.ts");
const flags = ["EXPO_PUBLIC_PREVIEW_MODE", "EXPO_PUBLIC_UIUX48_GALLERY", "EXPO_PUBLIC_FLOW_PROTOTYPE", "EXPO_PUBLIC_COMMUNITY_PROTOTYPE"];
const live = { NURI_RELEASE_CHANNEL: "live-alpha", EXPO_PUBLIC_RELEASE_FLAVOR: "live-alpha", ...Object.fromEntries(flags.map(key => [key, "0"])) };

function metro(env) {
  const module = { exports: {} };
  new Function("require", "module", "exports", "__dirname", "process", read("metro.config.js"))(name => {
    if (name === "expo/metro-config") return { getDefaultConfig: () => ({ resolver: {} }) };
    if (name === "node:crypto") return { createHash };
    if (name === "node:path") return path;
    if (name === "./app.json") return JSON.parse(read("app.json"));
    throw Error("Unexpected Metro dependency: " + name);
  }, module, module.exports, root, { env });
  return module.exports;
}
function resolve(env, platform = "ios", resolved = originalModule, requested = "./preview-api") {
  const calls = [], resolution = { type: "sourceFile", filePath: resolved };
  const context = { originModulePath: path.join(root, "src/api.ts"), resolveRequest: (...args) => { calls.push(args); return resolution; } };
  const result = metro(env).resolver.resolveRequest(context, requested, platform);
  assert.equal(calls.length, 1, "Metro's normal alias/platform resolver still runs once");
  assert.deepEqual(calls[0], [context, requested, platform]);
  return { result, resolution };
}
function load(file, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => {
    assert.ok(Object.hasOwn(dependencies, name), "Unexpected module dependency: " + name);
    return dependencies[name];
  }, module, module.exports, ...Object.values(globals));
  return module.exports;
}

test("live Alpha iOS replaces the resolved preview module for relative, alias, and absolute imports", () => {
  for (const requested of ["./preview-api", "@/src/preview-api", originalModule]) {
    assert.equal(resolve(live, "ios", originalModule, requested).result.filePath, unavailableModule);
  }
  assert.equal(resolve({ NURI_RELEASE_CHANNEL: "live-alpha", EXPO_PUBLIC_RELEASE_FLAVOR: "live-alpha" }).result.filePath, unavailableModule);
  assert.equal(resolve({ ...live, EXPO_PUBLIC_BACKEND_URL: "http://127.0.0.1:8765", NURI_LOCAL_COMMUNITY_DEBUG: "1" }).result.filePath, unavailableModule, "isolated local API validation also uses the real transport");
});

test("main, Android, web, and all prototype channels keep their original preview module", () => {
  const cases = [
    [{}, "ios"], [live, "android"], [live, "web"],
    [{ ...live, NURI_RELEASE_CHANNEL: undefined }, "ios"],
    [{ ...live, EXPO_PUBLIC_RELEASE_FLAVOR: undefined }, "ios"],
    ...["app-store", "alpha", "beta", "early-access", "testflight-prototype", "uiux49-qa", "web-local-prototype"].map(channel => [{ ...live, NURI_RELEASE_CHANNEL: channel, EXPO_PUBLIC_PREVIEW_MODE: "1" }, "ios"]),
    ...flags.flatMap(key => ["1", "true", "false", "", "invalid"].map(value => [{ ...live, [key]: value }, "ios"])),
  ];
  for (const [env, platform] of cases) {
    const { result, resolution } = resolve(env, platform);
    assert.equal(result, resolution, JSON.stringify({ env, platform }));
  }
});

test("unrelated source files and non-source resolutions are never redirected by an import's name", () => {
  for (const file of [path.join(root, "node_modules/example/preview-api.ts"), path.join(root, "src/api.ts"), unavailableModule]) {
    const { result, resolution } = resolve(live, "ios", file);
    assert.equal(result, resolution);
  }
  for (const resolution of [{ type: "empty" }, { type: "assetFiles", filePaths: [originalModule] }]) {
    const result = metro(live).resolver.resolveRequest({ resolveRequest: () => resolution }, "./preview-api", "ios");
    assert.equal(result, resolution);
  }
});

test("the live adapter is data-free, has no runtime imports or storage access, and fails closed if called", async () => {
  const adapter = load("src/preview-api.unavailable.ts", {}, {
    process: { get env() { throw Error("Environment access forbidden"); } },
    sessionStorage: new Proxy({}, { get() { throw Error("Storage access forbidden"); } }),
    fetch() { throw Error("Network access forbidden"); },
  });
  assert.deepEqual(Object.keys(adapter).sort(), ["isPreviewMode", "previewRequest"]);
  assert.equal(adapter.isPreviewMode, false);
  await assert.rejects(adapter.previewRequest("/auth/me"), /Sample responses are unavailable/);
  await assert.rejects(adapter.previewRequest("/auth/login", { method: "POST", body: "{}" }), /Sample responses are unavailable/);
  const source = ts.createSourceFile("adapter.ts", read("src/preview-api.unavailable.ts"), ts.ScriptTarget.Latest, true);
  assert.equal(source.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node)), false);
  for (const marker of ["preview-parent", "nuri.preview.billing", "preview-session"]) assert.ok(!read("src/preview-api.unavailable.ts").includes(marker));
  assert.ok(read("src/preview-api.ts").includes("preview-parent"), "the original prototype fixtures remain available to their original channels");
});

test("the actual apiRequest with the resolved live adapter still uses authenticated, uncached real transport", async () => {
  const values = new Map(), calls = [];
  const storage = { secureGet: async (key, fallback) => values.get(key) ?? fallback,
    secureSet: async (key, value) => { values.set(key, value); return true; }, secureRemove: async key => { values.delete(key); return true; },
    getItem: async (key, fallback) => values.get(key) ?? fallback, setItem: async (key, value) => { values.set(key, value); return true; }, removeItem: async key => { values.delete(key); return true; } };
  const adapterPath = path.relative(root, resolve(live).result.filePath);
  const client = load("src/api.ts", {
    "./theme": { API: "https://local-transport.invalid/api" }, "./preview-api": load(adapterPath),
    "./utils/storage": { storage }, "./aiConsent": load("src/aiConsent.ts"), "./sessionBoundary": load("src/sessionBoundary.ts"),
  }, { fetch: async (url, init) => {
    assert.ok(url.startsWith("https://local-transport.invalid/api/"), "No real network permitted");
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ id: "synthetic-local-account" }), text: async () => "" };
  } });
  await client.auth.setToken("synthetic-local-token");
  calls.length = 0;
  assert.deepEqual(await client.apiRequest("/community/v1/me/profile"), { id: "synthetic-local-account" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://local-transport.invalid/api/community/v1/me/profile");
  assert.equal(calls[0].init.headers.Authorization, "Bearer synthetic-local-token");
  assert.equal(calls[0].init.cache, "no-store");
});

test("live adapter resolution is isolated from preview cache identities", () => {
  const version = metro(live).cacheVersion;
  assert.notEqual(version, metro({}).cacheVersion);
  for (const key of flags) assert.notEqual(version, metro({ ...live, [key]: "1" }).cacheVersion);
  assert.notEqual(version, metro({ ...live, NURI_RELEASE_CHANNEL: "testflight-prototype" }).cacheVersion);
});
