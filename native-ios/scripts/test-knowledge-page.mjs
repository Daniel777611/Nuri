import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function load(path, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    assert.ok(name in dependencies, "unexpected dependency " + name);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (value, status = 200) => ({ ok: status < 400, status,
  json: async () => value, text: async () => JSON.stringify(value) });
const card = (id, title = id) => ({ id, title, summary: "Existing catalog summary", type_label: "Knowledge" });

// Actual API/hook modules with only in-memory storage and an invalid-domain
// transport. No production service, AI provider or customer data is contacted.
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
  const boundary = load("../src/sessionBoundary.ts");
  const consent = load("../src/aiConsent.ts");
  const client = load("../src/api.ts", { "./theme": { API: "https://knowledge-test.invalid/api" },
    "./preview-api": { isPreviewMode: false }, "./utils/storage": { storage },
    "./aiConsent": consent, "./sessionBoundary": boundary });
  const f = { ...client, consent, calls, responder: null,
    restore: () => { globalThis.fetch = originalFetch; },
    login: (owner) => client.auth.setToken("account-" + owner),
  };
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(url.startsWith("https://knowledge-test.invalid/"), "real network is forbidden");
    const path = url.replace("https://knowledge-test.invalid/api", "");
    const owner = init.headers?.Authorization?.replace("Bearer account-", "") || "none";
    calls.push({ path, owner, init });
    const custom = f.responder && await f.responder(path, init, owner);
    if (custom) return custom;
    if (path.startsWith("/feed/search?")) return response([card("card-" + owner, owner + " catalog card")]);
    throw new Error("Unexpected request " + path);
  };
  return f;
}

// Keep effects and saved closures across renders, and explicitly rerender
// after external-store changes, matching the isolation regression harness.
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
  return { react,
    render(fn) { cursor = 0; pending = []; const tree = fn(); pending.forEach((effect) => effect()); return tree; },
    unmount() { effects.forEach((effect) => effect?.cleanup?.()); },
  };
}

function page(f, locale = "en") {
  const r = runner(), routes = [];
  const jsx = (type, props) => ({ type, props });
  const native = { View: "View", Text: "Text", TextInput: "Input", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator",
    FlatList: "FlatList", StyleSheet: { create: (value) => value } };
  const i18n = { useT: () => ({ locale, t: (key) => key }) };
  const theme = { colors: {} };
  const failure = load("../src/requestFailure.ts");
  const notice = load("../src/components/RequestFailureNotice.tsx", { "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": native, "@/src/i18n": i18n, "@/src/theme": theme, "@/src/requestFailure": failure });
  const component = load("../app/knowledge.tsx", {
    react: r.react, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": native,
    "expo-router": { useRouter: () => ({ push: (href) => routes.push(href), replace: (href) => routes.push(href) }),
      useFocusEffect: (fn) => r.react.useEffect(fn, [fn]) },
    "@expo/vector-icons": { Ionicons: "Icon" }, "@/src/api": f,
    "@/src/aiPermissionNavigation": load("../src/aiPermissionNavigation.ts"),
    "@/src/cardText": load("../src/cardText.ts"),
    "@/src/resourceSummary": load("../src/resourceSummary.ts"),
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@/src/components/RequestFailureNotice": notice, "@/src/i18n": i18n,
    "@/src/requestFailure": failure, "@/src/theme": theme,
    "@/src/useAccountState": load("../src/useAccountState.ts", { react: r.react, "./api": f }),
  }).default;
  let tree;
  function expand(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === "function") return expand(node.type(node.props));
    if (node.type === "FlatList") return { ...node, props: { ...node.props, children: expand([
      node.props.ListHeaderComponent,
      ...(node.props.data.length ? node.props.data.map((item, index) => node.props.renderItem({ item, index })) : [node.props.ListEmptyComponent]),
    ]) } };
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  }
  const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node)
    ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  return { routes, unmount: r.unmount,
    render: () => { tree = r.render(() => expand(component())); return tree; },
    find: (id) => nodes(tree).find((node) => node.props?.testID === id),
    visible: () => JSON.stringify(tree),
  };
}

test("actual page reads the full existing catalog without AI permission or generation", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); assert.ok(p.find("knowledge-loading"));
    await tick(); p.render();
    assert.equal(f.aiConsent.getState().status, "unknown");
    assert.deepEqual(f.calls.map(({ path, init }) => [path, init.method || "GET"]), [["/feed/search?q=", "GET"]]);
    assert.ok(p.find("knowledge-card-card-A")); assert.equal(p.find("knowledge-loading"), undefined);
    assert.equal(p.find("knowledge-summary-card-A").props.children, "Existing catalog summary",
      "the saved brief AI catalog summary is useful content, not the full source body");
    assert.equal(p.find("knowledge-summary-card-A").props.numberOfLines, 3);
    p.find("knowledge-card-card-A").props.onPress();
    assert.deepEqual(p.routes, [{ pathname: "/detail/[id]", params: { id: "card-A" } }]);
  } finally { p?.unmount(); f.restore(); }
});

for (const [locale, cap, firstSentence] of [["en", 600, "A brief AI search overview. "],
  ["zh-CN", 220, "简短的 AI 检索概览。"]]) test("actual " + locale + " catalog renders a bounded saved AI summary, not raw source content", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A");
    f.responder = () => response([{ ...card("short-summary"),
      summary: `<p>${firstSentence}</p><p>${"x".repeat(cap + 50)}</p><script>PRIVATE_SCRIPT_BODY</script> https://private.invalid/source`,
      body: "PRIVATE_FULL_SOURCE_BODY", excerpt: "PRIVATE_RAW_SOURCE_EXCERPT",
      transcript: "PRIVATE_VIDEO_TRANSCRIPT", image_url: "https://private.invalid/source-image.jpg",
    }]);
    p = page(f, locale); p.render(); await tick(); p.render();
    assert.equal(p.find("knowledge-summary-short-summary").props.children, firstSentence.trim());
    assert.ok(p.find("knowledge-summary-short-summary").props.children.length <= cap);
    // FlatList's input data is not visible copy. Check the actually rendered
    // row (including accessibility and image props), not its retained dataset.
    assert.doesNotMatch(JSON.stringify(p.find("knowledge-card-short-summary")), /PRIVATE_|private\.invalid|<p>|<script>|source-image/);
    assert.equal(f.calls.length, 1, "reading saved brief copy does not generate new content");
    assert.equal(f.aiConsent.getState().status, "unknown");
  } finally { p?.unmount(); f.restore(); }
});

test("actual submitted search is encoded, server-backed, and show-all reads the catalog", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render();
    f.responder = (path) => path.includes(encodeURIComponent("sleep & 玩")) ? response([card("matched", "Existing search match")]) : null;
    p.find("knowledge-search-input").props.onChangeText(" sleep & 玩 "); p.render();
    p.find("knowledge-search-submit").props.onPress(); await tick(); p.render();
    assert.equal(f.calls.at(-1).path, "/feed/search?q=sleep%20%26%20%E7%8E%A9");
    assert.ok(p.find("knowledge-card-matched")); assert.equal(p.find("knowledge-card-card-A"), undefined);
    p.find("knowledge-show-all").props.onPress(); await tick(); p.render();
    assert.equal(f.calls.at(-1).path, "/feed/search?q="); assert.equal(p.find("knowledge-search-input").props.value, "");
  } finally { p?.unmount(); f.restore(); }
});

for (const search of ["", "missing"]) test("real empty " + (search || "catalog") + " stops loading without fabricated cards", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = () => response([]); p = page(f); p.render(); await tick(); p.render();
    if (search) { p.find("knowledge-search-input").props.onChangeText(search); p.render(); p.find("knowledge-search-input").props.onSubmitEditing(); await tick(); p.render(); }
    assert.ok(p.find("knowledge-empty")); assert.equal(p.find("knowledge-loading"), undefined);
    assert.match(p.visible(), search ? /No matching cards/ : /No cards are available/);
    assert.doesNotMatch(p.visible(), /knowledge-card-card-/);
  } finally { p?.unmount(); f.restore(); }
});

for (const [kind, outcome] of [
  ["service", () => response({ detail: "private server detail must not be rendered" }, 503)],
  ["connection", () => { throw new Error("private transport detail must not be rendered"); }],
  ["timeout", () => { throw Object.assign(new Error("private timeout detail"), { name: "AbortError" }); }],
]) test("actual " + kind + " error finishes loading and retry calls the real API", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = outcome; p = page(f); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-" + kind)); assert.equal(p.find("knowledge-loading"), undefined);
    assert.doesNotMatch(p.visible(), /private .* detail/);
    f.responder = null; p.find("request-failure-action").props.onPress(); await tick(); p.render();
    assert.ok(p.find("knowledge-card-card-A")); assert.equal(f.calls.length, 2);
  } finally { p?.unmount(); f.restore(); }
});

test("actual 401 offers login without silently clearing the current credential", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = () => response({ detail: "expired" }, 401);
    p = page(f); p.render(); await tick(); p.render(); assert.ok(p.find("request-failure-session"));
    p.find("request-failure-action").props.onPress(); assert.deepEqual(p.routes, ["/login"]);
    assert.equal(await f.auth.getToken(), "account-A");
  } finally { p?.unmount(); f.restore(); }
});

test("permission failure offers the real app-local permission route instead of connection retry", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A");
    // Read-only catalog is normally allowed. Execute the page's explicit
    // contract for an AI gate rejection without any real provider invocation.
    f.api.searchCards = async () => { throw new f.consent.AIConsentError("AI_CONSENT_REQUIRED"); };
    p = page(f); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission")); assert.equal(p.find("request-failure-connection"), undefined);
    p.find("request-failure-action").props.onPress();
    assert.deepEqual(p.routes, [{ pathname: "/ai-permission", params: { returnTo: "/knowledge" } }]);
  } finally { p?.unmount(); f.restore(); }
});

test("malformed payload and unsafe card IDs produce no invented or external-link cards", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = () => response({ cards: [card("not-the-api-contract")] });
    p = page(f); p.render(); await tick(); p.render(); assert.ok(p.find("request-failure-connection"));
    f.responder = () => response([card("https://outside.invalid"), card("safe-card"), card("safe-card")]);
    p.find("request-failure-action").props.onPress(); await tick(); p.render();
    assert.ok(p.find("knowledge-card-safe-card")); assert.doesNotMatch(p.visible(), /https:\/\/outside/);
    assert.equal(p.find("knowledge-card-list").props.data.length, 1);
  } finally { p?.unmount(); f.restore(); }
});

for (const change of ["B", "logout", "ABA"]) test("actual catalog and saved navigation are isolated for A → " + change, async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render();
    const oldOpen = p.find("knowledge-card-card-A").props.onPress;
    f.responder = (path, _init, owner) => owner === "A" && path.endsWith("q=held")
      ? { ...response(null), json: () => held.promise } : response([], 200);
    p.find("knowledge-search-input").props.onChangeText("held"); p.render();
    p.find("knowledge-search-submit").props.onPress(); await tick();
    assert.ok(f.calls.some((call) => call.owner === "A" && call.path.endsWith("q=held")), "A body barrier must be reached");
    if (change === "logout") await f.auth.clearToken({ forceLocal: true });
    else { await f.login("B"); if (change === "ABA") await f.login("A"); }
    p.render(); assert.doesNotMatch(p.visible(), /A catalog card/);
    oldOpen(); assert.deepEqual(p.routes, []);
    held.resolve([card("late-A", "private late A result")]); await tick(); p.render();
    assert.doesNotMatch(p.visible(), /private late A result/); assert.ok(p.find("knowledge-empty"));
  } finally { held.resolve([]); p?.unmount(); f.restore(); }
});

test("latest submitted query wins when earlier JSON finishes late", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render();
    f.responder = (path) => path.endsWith("q=first") ? { ...response(null), json: () => held.promise }
      : path.endsWith("q=second") ? response([card("second-result")]) : null;
    p.find("knowledge-search-input").props.onChangeText("first"); p.render();
    p.find("knowledge-search-submit").props.onPress(); await tick();
    assert.ok(f.calls.some((call) => call.path.endsWith("q=first")));
    p.find("knowledge-search-input").props.onChangeText("second"); p.render();
    p.find("knowledge-search-submit").props.onPress(); await tick(); p.render();
    held.resolve([card("first-result")]); await tick(); p.render();
    assert.ok(p.find("knowledge-card-second-result")); assert.equal(p.find("knowledge-card-first-result"), undefined);
  } finally { held.resolve([]); p?.unmount(); f.restore(); }
});

test("late request completion and saved submit after unmount cause no writes, requests or navigation", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); f.responder = () => ({ ...response(null), json: () => held.promise });
    p = page(f); p.render(); await tick(); const submit = p.find("knowledge-search-submit").props.onPress;
    assert.equal(f.calls.length, 1); p.unmount(); submit(); held.resolve([card("unmounted-result")]); await tick();
    p.render(); assert.equal(f.calls.length, 1); assert.equal(p.find("knowledge-card-unmounted-result"), undefined);
    assert.deepEqual(p.routes, []);
  } finally { held.resolve([]); p?.unmount(); f.restore(); }
});

for (const [locale, title, placeholder] of [["en", "Knowledge library", "Search titles"],
  ["zh-CN", "知识图书馆", "搜索标题"], ["zh-TW", "知識圖書館", "搜尋標題"]]) test("actual " + locale + " copy and localized card text render", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = () => response([{ ...card("localized"), text_i18n: { [locale]: { title: "Localized fixture title" } } }]);
    p = page(f, locale); p.render(); await tick(); p.render();
    assert.ok(p.visible().includes(title)); assert.ok(p.find("knowledge-search-input").props.placeholder.includes(placeholder));
    assert.match(p.visible(), /Localized fixture title/);
  } finally { p?.unmount(); f.restore(); }
});
