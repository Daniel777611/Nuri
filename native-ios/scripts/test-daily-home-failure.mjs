import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

export function load(path, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    if (name.startsWith("@/assets/")) return "fixture-image";
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
const dailyCard = (owner) => ({ id: "daily-" + owner, card_id: "source-" + owner, nickname: owner,
  headline: owner + " private daily headline", concern: "fixture concern", basis: "conversation", audience: "parent",
  platform: "facebook", author_kind: "parent_post", takeaways: ["Existing parent practice"], excerpt: "Existing excerpt",
  excerpt_lang: "en", source_label: "Fixture source", source_url: "https://source.invalid/" + owner });
const readyDetail = () => ({ id: "stored-card", title: "Stored guide", summary: "Stored summary", body: "Stored body",
  type: "tip", content_category: "authority", resource_readiness: "ready", resource_pair_complete: true, resources: [
    { id: "stored-article", kind: "article", title: "Stored article", publisher: "Fixture publisher", content_category: "authority", url: "https://resource.invalid/article", language: "English" },
    { id: "stored-video", kind: "video", title: "Stored video", publisher: "Fixture publisher", content_category: "authority", url: "https://resource.invalid/video", language: "English" },
  ] });

// Actual modules, memory-only storage, and invalid-domain transport. No
// production request or third-party AI provider is invoked by these tests.
export function fixture() {
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
  const client = load("../src/api.ts", { "./theme": { API: "https://daily-home-test.invalid/api" },
    "./preview-api": { isPreviewMode: false }, "./utils/storage": { storage },
    "./aiConsent": load("../src/aiConsent.ts"), "./sessionBoundary": boundary });
  const f = { ...client, boundary, calls, responder: null,
    restore: () => { globalThis.fetch = originalFetch; }, login: (owner) => client.auth.setToken("account-" + owner),
    async permit() { await client.aiConsent.refresh(); await client.aiConsent.setAllowed(true, client.aiConsent.getState()); },
  };
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(url.startsWith("https://daily-home-test.invalid/"), "real network is forbidden");
    const path = url.replace("https://daily-home-test.invalid/api", "");
    const owner = init.headers?.Authorization?.replace("Bearer account-", "") || "none";
    calls.push({ path, owner, init });
    const custom = f.responder && await f.responder(path, init, owner);
    if (custom) return custom;
    if (path === "/auth/me") return response({ id: "user-" + owner, nickname: owner });
    if (path.startsWith("/feed/daily-post") && init.method !== "POST") return response({ state: "ready", card: dailyCard(owner) });
    if (path.startsWith("/feed/daily-video") && !path.endsWith("/summary") && init.method !== "POST") return response({ state: "ready", card: videoCard(owner) });
    if (path.endsWith("/summary")) return response({ summary: owner + " summary from title and description" });
    if (path === "/chat/main/checkin") return response({ state: "none" });
    if (path === "/chat/main/preview") return response({ has_conversation: true, session_id: "existing-" + owner, last_user_message: { text: owner + " private preview" } });
    if (path === "/chat/sessions") return response({ id: "created-" + owner });
    if (path === "/favorites") return response([]);
    if (path.startsWith("/feed/stored-card/detail")) return response(readyDetail());
    if (path === "/feed/research/prepare") return response({ items: [] });
    if (init.method === "POST") return response({ ok: true });
    throw new Error("Unexpected request " + path);
  };
  return f;
}

export function runner() {
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

export function page(f, kind = "daily", params = {}) {
  const r = runner(), routes = [], external = [], focuses = new Map();
  let focused = true, focusSlot = 0, tree;
  const jsx = (type, props) => ({ type, props });
  const animation = { start: () => {} };
  const appStateListeners = new Set();
  const native = { View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", ImageBackground: "ImageBackground",
    ScrollView: "ScrollView", Image: "Image", Modal: "Modal", Platform: { OS: "ios" },
    Linking: { openURL: async (url) => external.push(url) }, StyleSheet: { create: (value) => value, absoluteFill: {} },
    AppState: { currentState: "active", addEventListener: (_event, callback) => { appStateListeners.add(callback); return { remove: () => appStateListeners.delete(callback) }; } }, useWindowDimensions: () => ({ width: 390 }),
    Share: { share: async () => ({ action: "shared" }), sharedAction: "shared" },
    Animated: { Value: class {}, View: "AnimatedView", sequence: () => animation, timing: () => animation, delay: () => animation } };
  const i18n = { useT: () => ({ locale: "en", t: (text, variables = {}) => text.replace(/\{(\w+)\}/g, (_all, key) => String(variables[key] ?? key)) }) };
  const theme = { colors: {}, spacing: {}, radius: {}, type: {} };
  const failure = load("../src/requestFailure.ts");
  const runtime = { jsx, jsxs: jsx };
  const notice = load("../src/components/RequestFailureNotice.tsx", { "react/jsx-runtime": runtime, "react-native": native,
    "@/src/i18n": i18n, "@/src/theme": theme, "@/src/requestFailure": failure });
  const daily = load("../src/components/DailyPostCard.tsx", { "react/jsx-runtime": runtime, "react-native": native,
    "@/src/i18n": i18n, "expo-linear-gradient": { LinearGradient: "Gradient" }, "@expo/vector-icons": { Ionicons: "Icon" } });
  const video = load("../src/components/DailyVideoCard.tsx", { "react/jsx-runtime": runtime, "react-native": native,
    "@/src/i18n": i18n, "expo-linear-gradient": { LinearGradient: "Gradient" }, "@expo/vector-icons": { Ionicons: "Icon" } });
  const player = load("../src/components/YouTubePlayer.tsx", { react: r.react, "react/jsx-runtime": runtime, "react-native": native,
    "@/src/i18n": i18n, "react-native-webview": { WebView: "WebView" }, "expo-constants": { __esModule: true, default: { expoConfig: { ios: { bundleIdentifier: "com.ordashtech.nuri.nativelab" } } } } });
  const handoffs = load("../src/recommendationDetailHandoff.ts", { "./sessionBoundary": f.boundary });
  const dependencies = {
    react: r.react, "react/jsx-runtime": runtime, "react-native": native,
    "@/src/api": f, "@/src/theme": theme, "@/src/i18n": i18n,
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@/src/components/RequestFailureNotice": notice, "@/src/components/DailyPostCard": daily,
    "@/src/components/DailyVideoCard": video, "@/src/components/YouTubePlayer": player,
    "@/src/components/Toast": { __esModule: true, default: "Toast" },
    "@/src/requestFailure": failure, "@/src/aiPermissionNavigation": load("../src/aiPermissionNavigation.ts"),
    "@/src/useAccountState": load("../src/useAccountState.ts", { react: r.react, "./api": f }),
    "@expo/vector-icons": { Ionicons: "Icon" }, "expo-linear-gradient": { LinearGradient: "Gradient" },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 34 }) },
    "@react-navigation/native": { useIsFocused: () => focused }, "expo-image": { Image: "ExpoImage" },
    "expo-web-browser": { openBrowserAsync: async (url) => external.push(url) }, "expo-clipboard": { setStringAsync: async () => true },
    "@/src/components/taskCardExport": { firstShareableResource: (resources) => resources?.find((resource) => /^https:\/\//.test(resource.url)) },
    "@/src/feedPreparation": load("../src/feedPreparation.ts", { "./api": f, "./sessionBoundary": f.boundary }),
    "@/src/recommendationDetailHandoff": handoffs,
    "@/src/recommendationPresentation": load("../src/recommendationPresentation.ts"),
    "@/src/cardText": load("../src/cardText.ts"),
    "expo-router": { useLocalSearchParams: () => params,
      useRouter: () => ({ push: (href) => routes.push(href), replace: (href) => routes.push(href), canGoBack: () => false }),
      useFocusEffect: (fn) => {
        const id = focusSlot++;
        r.react.useEffect(() => {
          const entry = { fn, cleanup: focused ? fn() : null };
          focuses.set(id, entry);
          return () => { entry.cleanup?.(); entry.cleanup = null; focuses.delete(id); };
        }, [fn]);
      } },
  };
  const path = kind === "home" ? "../app/(tabs)/index.tsx" : kind === "detail" ? "../app/detail/[id].tsx" : kind === "video" ? "../app/daily-video.tsx" : "../app/daily-post.tsx";
  const component = load(path, dependencies).default;
  function expand(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === "function") return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  }
  const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node)
    ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  return { routes, external, handoffs, unmount: r.unmount,
    appState: (state) => { native.AppState.currentState = state; appStateListeners.forEach((callback) => callback(state)); },
    render: () => { focusSlot = 0; tree = r.render(() => expand(component())); return tree; },
    blur: () => { focused = false; focuses.forEach((entry) => { entry.cleanup?.(); entry.cleanup = null; }); },
    focus: () => { focused = true; focuses.forEach((entry) => { entry.cleanup = entry.fn(); }); },
    find: (id) => nodes(tree).find((node) => node.props?.testID === id),
    kind: (type) => nodes(tree).find((node) => node.type === type), visible: () => JSON.stringify(tree),
  };
}

export const videoCard = (owner) => ({ id: "video-" + owner, card_id: "dailyvideo:video-" + owner, day: "2026-10-05", platform: "youtube", video_id: "ScMzIvxBSi4",
  source_url: "https://www.youtube.com/watch?v=ScMzIvxBSi4", thumbnail_url: "https://i.ytimg.com/vi/ScMzIvxBSi4/hqdefault.jpg",
  title: owner + " video title", display_title: owner + " private video", channel: "Fixture pediatrician", speaker_kind: "pediatrician", video_lang: "en",
  summary: "Saved description summary", concern: "Fixture sleep", basis: "conversation", locale: "en", nickname: owner, intro: owner + " intro" });

test("daily-post denied permission offers CTA, then grant/refocus loads without permanent spinner", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission")); assert.equal(p.kind("ActivityIndicator"), undefined);
    assert.equal(f.calls.filter((call) => call.path.startsWith("/feed/daily-post")).length, 0);
    p.find("request-failure-action").props.onPress(); assert.deepEqual(p.routes, [{ pathname: "/ai-permission", params: { returnTo: "/daily-post" } }]);
    p.blur(); await f.permit(); p.focus(); await tick(); p.render();
    assert.ok(p.find("daily-post-headline")); assert.equal(p.find("request-failure-permission"), undefined);
    assert.ok(f.calls.some((call) => call.path.startsWith("/feed/daily-post")));
  } finally { p?.unmount(); f.restore(); }
});

for (const [status, kind] of [[401, "session"], [503, "service"]]) test("daily-post GET " + status + " selects real login/retry action and preserves token", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); f.responder = (path) => path.startsWith("/feed/daily-post") ? response({ detail: "private failure" }, status) : null;
    p = page(f); p.render(); await tick(); p.render(); assert.ok(p.find("request-failure-" + kind));
    assert.equal(p.kind("ActivityIndicator"), undefined); assert.equal(await f.auth.getToken(), "account-A");
    f.responder = null; p.find("request-failure-action").props.onPress(); p.render(); await tick(); p.render();
    if (status === 401) assert.deepEqual(p.routes, ["/login"]);
    else assert.ok(p.find("daily-post-headline"));
    assert.doesNotMatch(p.visible(), /private failure/);
  } finally { p?.unmount(); f.restore(); }
});

test("daily-post chat permission failure keeps the saved card and routes to permission", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f); p.render(); await tick(); p.render();
    await f.aiConsent.setAllowed(false, f.aiConsent.getState()); await p.find("daily-post-chat").props.onPress(); p.render();
    assert.ok(p.find("request-failure-permission")); assert.ok(p.find("daily-post-headline"));
    assert.equal(p.find("daily-post-chat").props.disabled, false);
    assert.equal(f.calls.filter((call) => call.path === "/chat/sessions").length, 0);
    p.find("request-failure-action").props.onPress(); assert.deepEqual(p.routes, [{ pathname: "/ai-permission", params: { returnTo: "/daily-post" } }]);
  } finally { p?.unmount(); f.restore(); }
});

test("daily-post chat service retry repeats the failed chat action, not just the card GET", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f); p.render(); await tick(); p.render();
    f.responder = (path) => path === "/chat/sessions" ? response({ detail: "busy" }, 503) : null;
    await p.find("daily-post-chat").props.onPress(); p.render(); assert.ok(p.find("request-failure-service"));
    assert.ok(p.find("daily-post-headline")); const before = f.calls.filter((call) => call.path === "/chat/sessions").length;
    f.responder = null; p.find("request-failure-action").props.onPress(); p.render(); await tick(); p.render();
    assert.equal(f.calls.filter((call) => call.path === "/chat/sessions").length, before + 1);
    assert.deepEqual(p.routes, ["/chat/created-A"]);
  } finally { p?.unmount(); f.restore(); }
});

test("daily-post chat failure followed by refocus GET failure retries the GET, not the old chat action", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f); p.render(); await tick(); p.render();
    f.responder = (path) => path === "/chat/sessions" ? response({}, 503) : null;
    await p.find("daily-post-chat").props.onPress(); p.render(); assert.ok(p.find("request-failure-service"));
    f.responder = (path) => path.startsWith("/feed/daily-post") ? response({}, 503) : null;
    p.blur(); p.focus(); await tick(); p.render(); assert.ok(p.find("request-failure-service"));
    const chats = f.calls.filter((call) => call.path === "/chat/sessions").length;
    const reads = f.calls.filter((call) => call.path.startsWith("/feed/daily-post")).length;
    f.responder = null; p.find("request-failure-action").props.onPress(); p.render(); await tick(); p.render();
    assert.equal(f.calls.filter((call) => call.path === "/chat/sessions").length, chats);
    assert.equal(f.calls.filter((call) => call.path.startsWith("/feed/daily-post")).length, reads + 1);
    assert.ok(p.find("daily-post-headline")); assert.deepEqual(p.routes, []);
  } finally { p?.unmount(); f.restore(); }
});

for (const change of ["B", "logout", "ABA"]) test("daily-post held response for A → " + change + " cannot restore old card", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); await f.permit(); f.responder = (path) => path.startsWith("/feed/daily-post") ? { ...response(null), json: () => held.promise } : null;
    p = page(f); p.render(); await tick(); assert.ok(f.calls.some((call) => call.path.startsWith("/feed/daily-post")), "A body barrier reached");
    if (change === "logout") await f.auth.clearToken({ forceLocal: true });
    else { await f.login("B"); if (change === "ABA") await f.login("A"); }
    f.responder = (path) => path.startsWith("/feed/daily-post") ? response({ detail: "offline" }, 503) : null;
    p.render(); held.resolve({ state: "ready", card: dailyCard("private-old-A") }); await tick(); p.render();
    assert.doesNotMatch(p.visible(), /private-old-A/); assert.equal(p.find("daily-post-headline"), undefined); assert.deepEqual(p.routes, []);
  } finally { held.resolve({ state: "empty" }); p?.unmount(); f.restore(); }
});

test("daily-post GET result after blur is ignored, while refocus accepts a fresh read", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); await f.permit(); f.responder = (path) => path.startsWith("/feed/daily-post") ? { ...response(null), json: () => held.promise } : null;
    p = page(f); p.render(); await tick(); p.blur(); held.resolve({ state: "ready", card: dailyCard("blurred-A") }); await tick(); p.render();
    assert.equal(p.find("daily-post-headline"), undefined); f.responder = null; p.focus(); await tick(); p.render();
    assert.ok(p.find("daily-post-headline")); assert.doesNotMatch(p.visible(), /blurred-A/);
  } finally { held.resolve({ state: "empty" }); p?.unmount(); f.restore(); }
});

for (const cleanup of ["blur", "unmount", "B"]) test("daily chat late response after " + cleanup + " cannot navigate", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f); p.render(); await tick(); p.render();
    f.responder = (path) => path === "/chat/sessions" ? { ...response(null), json: () => held.promise } : null;
    const pending = p.find("daily-post-chat").props.onPress(); await tick(); assert.ok(f.calls.some((call) => call.path === "/chat/sessions"));
    if (cleanup === "B") { await f.login("B"); p.render(); } else p[cleanup]();
    held.resolve({ id: "old-A" }); await pending; assert.deepEqual(p.routes, []);
  } finally { held.resolve({}); p?.unmount(); f.restore(); }
});

test("Home renders daily permission CTA rather than a service outage and refocus recovers", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "home"); p.render(); await tick(); p.render();
    assert.ok(p.find("home-daily-post-empty")); assert.match(p.visible(), /AI permission is needed/);
    assert.doesNotMatch(p.visible(), /Unable to connect|service could not complete/);
    p.find("home-daily-post-empty").props.onPress(); assert.deepEqual(p.routes, [{ pathname: "/ai-permission", params: { returnTo: "/(tabs)" } }]);
    p.blur(); await f.permit(); p.focus(); await tick(); p.render(); assert.ok(p.find("home-daily-post-card"));
  } finally { p?.unmount(); f.restore(); }
});

for (const stage of ["preview", "creation"]) test("Home tap's held " + stage + " response after blur cannot push a hidden page", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f, "home"); p.render(); await tick(); p.render();
    let barrierReached = false;
    const heldBody = () => { barrierReached = true; return held.promise; };
    f.responder = (path) => path === "/chat/main/preview"
      ? stage === "preview" ? { ...response(null), json: heldBody } : response({ has_conversation: false, session_id: null })
      : stage === "creation" && path === "/chat/sessions" ? { ...response(null), json: heldBody } : null;
    const pending = p.find("home-nuri-card").props.onPress(); await tick();
    assert.equal(barrierReached, true, "tap must reach the held response body before blur");
    p.blur(); held.resolve(stage === "preview" ? { has_conversation: true, session_id: "old-blurred-A" } : { id: "old-blurred-A" });
    await pending; assert.deepEqual(p.routes, []);
  } finally { held.resolve({}); p?.unmount(); f.restore(); }
});

for (const [status, kind] of [[401, "session"], [503, "service"]]) test("Home warm preview " + status + " displays error first and executes its labelled CTA", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f, "home"); p.render(); await tick(); p.render();
    assert.equal(p.find("home-nuri-action-label").props.children, "继续对话");
    f.responder = (path) => path === "/chat/main/preview" ? response({ detail: "private failure" }, status) : null;
    p.blur(); p.focus(); await tick(); p.render();
    const words = load("../src/requestFailure.ts").requestFailureCopy("en", kind);
    assert.equal(p.find("home-nuri-memo").props.children, words.title);
    assert.equal(p.find("home-nuri-action-label").props.children, words.action);
    const before = f.calls.filter((call) => call.path === "/chat/main/preview").length;
    f.responder = null; await p.find("home-nuri-card").props.onPress(); await tick(); p.render();
    if (status === 401) { assert.deepEqual(p.routes, ["/login"]); assert.equal(f.calls.filter((call) => call.path === "/chat/main/preview").length, before); }
    else {
      // Retry continues the user's original open-chat action with a fresh
      // server-owned canonical session, not the warm cached session ID.
      assert.deepEqual(p.routes, ["/chat/existing-A"]);
      assert.equal(f.calls.filter((call) => call.path === "/chat/main/preview").length, before + 1);
      assert.equal(f.calls.filter((call) => call.path === "/chat/sessions" && call.init.method === "POST").length, 0);
    }
  } finally { p?.unmount(); f.restore(); }
});

test("ready detail resources survive warm service failure instead of being replaced with an empty pair", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); const params = { id: "stored-card", handoff_key: "handoff" };
    p = page(f, "detail", params); params.handoff_key = p.handoffs.storeRecommendationDetailHandoff(readyDetail(), [{ card_id: "stored-card", recommendation_id: "rec" }]);
    p.render(); await tick(); p.render(); assert.ok(p.find("detail-resource-stored-article")); assert.ok(p.find("detail-resource-stored-video"));
    f.responder = (path) => path.startsWith("/feed/stored-card/detail") ? response({ detail: "busy" }, 503) : null;
    p.blur(); p.focus(); await tick(); p.render();
    assert.ok(p.find("request-failure-service")); assert.ok(p.find("detail-resource-stored-article")); assert.ok(p.find("detail-resource-stored-video"));
    assert.equal(f.calls.filter((call) => call.path === "/feed/research/prepare").length, 0);
  } finally { p?.unmount(); f.restore(); }
});

test("detail 404 body completing after blur must not start AI preparation", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); await f.permit(); const params = { id: "stored-card" }; p = page(f, "detail", params);
    params.handoff_key = p.handoffs.storeRecommendationDetailHandoff(readyDetail(), [{ card_id: "stored-card", recommendation_id: "rec" }]);
    f.responder = (path) => path.startsWith("/feed/stored-card/detail") ? { ...response(null, 404), text: () => held.promise } : null;
    p.render(); await tick(); assert.ok(f.calls.some((call) => call.path.startsWith("/feed/stored-card/detail")));
    p.blur(); held.resolve('{"detail":"not prepared"}'); await tick(); p.render();
    assert.equal(f.calls.filter((call) => call.path === "/feed/research/prepare").length, 0);
  } finally { held.resolve('{}'); p?.unmount(); f.restore(); }
});
