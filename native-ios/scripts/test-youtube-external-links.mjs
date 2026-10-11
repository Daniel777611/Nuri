import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Exercise the actual screen, Home card, API and account boundaries. Transport
// is memory-only and confined to an invalid domain; no provider is contacted.
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
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const videoCard = (owner = "A") => ({
  id: "video-" + owner, card_id: "dailyvideo:video-" + owner, video_id: "ScMzIvxBSi4", platform: "youtube",
  title: "PRIVATE_SOURCE_TITLE", display_title: "PRIVATE_DERIVED_TITLE", intro: "PRIVATE_INTRO",
  // A family's own topic may personalize NURI's authored guide; source fields may not.
  summary: "AI_SEARCH_SUMMARY_SENTENCE.", key_points: ["AI_SEARCH_POINT_SENTENCE."], channel: "PRIVATE_CHANNEL", concern: "FAMILY_SLEEP_TOPIC",
  thumbnail_url: "https://i.ytimg.com/PRIVATE_THUMBNAIL.jpg", source_url: "https://evil.invalid/PRIVATE_URL",
});

function fixture() {
  const originalFetch = globalThis.fetch, secure = new Map(), ordinary = new Map(), calls = [];
  const storage = {
    secureGet: async (key, fallback) => secure.get(key) ?? fallback,
    secureSet: async (key, value) => { secure.set(key, value); return true; },
    secureRemove: async (key) => { secure.delete(key); return true; },
    getItem: async (key, fallback) => ordinary.get(key) ?? fallback,
    setItem: async (key, value) => { ordinary.set(key, value); return true; },
    removeItem: async (key) => { ordinary.delete(key); return true; },
  };
  const boundary = load("../src/sessionBoundary.ts");
  const client = load("../src/api.ts", { "./theme": { API: "https://youtube-links-test.invalid/api" },
    "./preview-api": { isPreviewMode: false }, "./utils/storage": { storage },
    "./aiConsent": load("../src/aiConsent.ts"), "./sessionBoundary": boundary });
  const f = { ...client, boundary, calls, responder: null, restore: () => { globalThis.fetch = originalFetch; },
    login: (owner) => client.auth.setToken("account-" + owner),
    async permit() { await client.aiConsent.refresh(); await client.aiConsent.setAllowed(true, client.aiConsent.getState()); },
  };
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(url.startsWith("https://youtube-links-test.invalid/"), "real network is forbidden");
    const path = url.replace("https://youtube-links-test.invalid/api", "");
    const owner = init.headers?.Authorization?.replace("Bearer account-", "") || "none";
    calls.push({ path, owner, init });
    const custom = f.responder && await f.responder(path, init, owner);
    if (custom) return custom;
    if (path === "/auth/me") return response({ id: "user-" + owner });
    if (path.startsWith("/feed/daily-video") && !path.endsWith("/summary") && init.method !== "POST") return response({ state: "ready", card: videoCard(owner) });
    if (path.endsWith("/summary")) return response({ summary: "AI_GENERATED_SEARCH_SUMMARY_SENTENCE." });
    if (path === "/chat/sessions") return response({ id: "created-" + owner });
    if (init.method === "POST") return response({ ok: true });
    throw new Error("Unexpected request " + path);
  };
  return f;
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
const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const jsx = (type, props) => ({ type, props });
const runtime = { jsx, jsxs: jsx };
const translate = (text, variables = {}) => "localized:" + text.replace(/\{(\w+)\}/g, (_all, key) => String(variables[key] ?? key));
const i18n = { useT: () => ({ t: translate }) };
const guideHelper = load("../src/nuriResourceGuide.ts");
const summaryHelper = load("../src/resourceSummary.ts");

function page(f, params = { id: "video-A" }) {
  const r = runner(), routes = [], external = [], focuses = new Map();
  let focused = true, focusSlot = 0, tree;
  const p = { routes, external, link: async (url) => { external.push(url); } };
  const native = { View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", ScrollView: "ScrollView",
    StyleSheet: { create: (value) => value }, useWindowDimensions: () => ({ width: 390 }),
    Linking: { openURL: (url) => p.link(url) } };
  const failure = load("../src/requestFailure.ts");
  const notice = load("../src/components/RequestFailureNotice.tsx", { "react/jsx-runtime": runtime, "react-native": native,
    "@/src/i18n": i18n, "@/src/theme": { colors: {}, spacing: {}, radius: {}, type: {} }, "@/src/requestFailure": failure });
  const helpers = load("../src/components/YouTubePlayer.tsx", { react: r.react, "react/jsx-runtime": runtime,
    "react-native": native, "@/src/i18n": i18n, "react-native-webview": { WebView: "WebView" }, "expo-constants": { default: {} } });
  const screen = load("../app/daily-video.tsx", {
    react: r.react, "react/jsx-runtime": runtime, "react-native": native, "@/src/api": f,
    "@/src/i18n": i18n, "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@/src/components/RequestFailureNotice": notice, "@/src/components/YouTubePlayer": helpers,
    "@/src/nuriResourceGuide": guideHelper, "expo-linear-gradient": { LinearGradient: "Gradient" },
    "@/src/resourceSummary": summaryHelper,
    "@/src/useAIConsent": load("../src/useAIConsent.ts", { react: r.react, "./api": f }),
    "@/src/requestFailure": failure, "@/src/aiPermissionNavigation": load("../src/aiPermissionNavigation.ts"),
    "@/src/useAccountState": load("../src/useAccountState.ts", { react: r.react, "./api": f }),
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": { useLocalSearchParams: () => params, useRouter: () => ({ push: (href) => routes.push(href) }),
      useFocusEffect: (fn) => {
        const id = focusSlot++;
        r.react.useEffect(() => {
          const entry = { fn, cleanup: focused ? fn() : null }; focuses.set(id, entry);
          return () => { entry.cleanup?.(); focuses.delete(id); };
        }, [fn]);
      } },
  }).default;
  const expand = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === "function") return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  };
  Object.assign(p, { unmount: r.unmount, render: () => { focusSlot = 0; tree = r.render(() => expand(screen())); return tree; },
    blur: () => { focused = false; focuses.forEach((entry) => { entry.cleanup?.(); entry.cleanup = null; }); },
    focus: () => { focused = true; focuses.forEach((entry) => { entry.cleanup = entry.fn(); }); },
    find: (id) => nodes(tree).find((node) => node.props?.testID === id),
    kind: (type) => nodes(tree).find((node) => node.type === type), visible: () => JSON.stringify(tree),
  });
  return p;
}

test("YouTube screen reads real card, brief AI search summary and own guide, never raw source text or player", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render(); await tick(); p.render();
    assert.ok(f.calls.some((call) => call.path === "/feed/daily-video/video-A"));
    assert.equal(f.calls.filter((call) => call.path.endsWith("/summary")).length, 0);
    assert.ok(p.find("daily-video-external-title")); assert.ok(p.find("daily-video-external-notice"));
    assert.equal(p.find("daily-video-source").props.accessibilityRole, "link");
    assert.equal(p.kind("WebView"), undefined); assert.equal(p.kind("Image"), undefined);
    for (const oldId of ["daily-video-player", "daily-video-intro", "daily-video-title", "daily-video-guide-title"]) assert.equal(p.find(oldId), undefined);
    assert.equal(p.find("daily-video-summary").props.children, "AI_SEARCH_SUMMARY_SENTENCE.");
    assert.equal(p.find("daily-video-key-points").props.children, "AI_SEARCH_POINT_SENTENCE.");
    assert.match(p.find("daily-video-summary-disclosure").props.children, /未观看完整视频或获取字幕/);
    assert.doesNotMatch(p.visible(), /PRIVATE_|youtube-nocookie|i\.ytimg/);
    assert.match(p.find("daily-video-external-title").props.children, /^localized:/);
    const guide = guideHelper.nuriResourceGuide({ concern: videoCard().concern }, translate);
    assert.ok(p.find("daily-video-nuri-guide"));
    assert.equal(p.find("daily-video-guide-headline").props.children, guide.headline);
    assert.equal(p.find("daily-video-guide-intro").props.children, guide.intro);
    assert.equal(p.find("daily-video-guide-disclosure").props.children, guide.disclosure);
    guide.actions.forEach((_action, index) => assert.ok(p.find(`daily-video-guide-action-${index}`)));
    assert.match(p.visible(), /FAMILY_SLEEP_TOPIC/, "the user's own topic remains useful rather than being mistaken for copied source text");
  } finally { p?.unmount(); f.restore(); }
});

test("Home video card uses NURI-owned topic guide and art, retains owned-ID navigation", () => {
  const card = videoCard(), presses = [];
  const component = load("../src/components/DailyVideoCard.tsx", { "react/jsx-runtime": runtime,
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: (x) => x } },
    "@/src/i18n": i18n, "@/src/nuriResourceGuide": guideHelper,
    "@/src/resourceSummary": summaryHelper,
    "expo-linear-gradient": { LinearGradient: "Gradient" }, "@expo/vector-icons": { Ionicons: "Icon" } }).default;
  const tree = component({ width: 340, status: "ready", card, onPress: (value) => presses.push(value.id), onRetry() {} });
  const cardNode = nodes(tree).find((node) => node.props?.testID === "home-daily-video-card");
  assert.ok(cardNode); assert.ok(nodes(tree).some((node) => node.type === "Gradient"));
  assert.equal(nodes(tree).find((node) => node.type === "Image"), undefined);
  assert.doesNotMatch(JSON.stringify(tree), /PRIVATE_|i\.ytimg/);
  assert.equal(nodes(tree).find((node) => node.props?.testID === "home-daily-video-external-title").props.children,
    guideHelper.nuriResourceGuide({ concern: card.concern }, translate).headline);
  assert.match(JSON.stringify(tree), /FAMILY_SLEEP_TOPIC/);
  assert.equal(nodes(tree).find((node) => node.props?.testID === "home-daily-video-external-notice").props.children, "AI_SEARCH_POINT_SENTENCE.");
  assert.match(JSON.stringify(tree), /非完整视频摘要/);
  assert.match(cardNode.props.accessibilityLabel, /localized:/);
  cardNode.props.onPress(); assert.deepEqual(presses, ["video-A"]);
});

test("external open uses validated video ID, not poisoned backend URL; no auto dispatch", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f); p.render(); await tick(); p.render();
    assert.deepEqual(p.external, []);
    p.find("daily-video-source").props.onPress(); await tick(); p.render();
    assert.deepEqual(p.external, ["https://www.youtube.com/watch?v=ScMzIvxBSi4"]);
    assert.ok(f.calls.some((call) => call.path === "/feed/daily-video/video-A/events" && JSON.parse(call.init.body).event === "source_click"));
    assert.equal(p.find("daily-video-source-error"), undefined);
  } finally { p?.unmount(); f.restore(); }
});

test("invalid video ID cannot display an external action or dispatch", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? response({ state: "ready", card: { ...videoCard(), video_id: "../private" } }) : null;
    p = page(f); p.render(); await tick(); p.render();
    assert.equal(p.find("daily-video-source"), undefined); assert.ok(p.find("daily-video-load-retry")); assert.deepEqual(p.external, []);
  } finally { p?.unmount(); f.restore(); }
});

test("invalid deep-link identifier is rejected before API access", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, { id: "../private" }); p.render(); await tick(); p.render();
    assert.equal(f.calls.filter((call) => call.path.startsWith("/feed/daily-video")).length, 0);
    assert.equal(p.find("daily-video-source"), undefined); assert.deepEqual(p.external, []);
  } finally { p?.unmount(); f.restore(); }
});

test("source failure is localized, observable and retryable; repeated tap is deduplicated", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render();
    let linkCalls = 0; p.link = async (url) => { linkCalls++; p.external.push(url); if (!(await held.promise)) throw new Error("OS unavailable"); };
    const press = p.find("daily-video-source").props.onPress;
    press(); press(); p.render(); assert.equal(linkCalls, 1); assert.equal(p.find("daily-video-source").props.disabled, true);
    held.resolve(false); await tick(); p.render();
    assert.match(p.find("daily-video-source-error").props.children, /^localized:/); assert.equal(p.find("daily-video-source").props.disabled, false);
    p.link = async (url) => { p.external.push(url); }; p.find("daily-video-source").props.onPress(); await tick(); p.render();
    assert.equal(p.find("daily-video-source-error"), undefined); assert.equal(p.external.length, 2);
  } finally { held.resolve(false); p?.unmount(); f.restore(); }
});

for (const change of ["B", "logout", "ABA", "blur", "unmount"]) test("late source-open failure cannot restore old account UI after " + change, async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render();
    p.link = async () => { if (!(await held.promise)) throw new Error("late OS failure"); };
    p.find("daily-video-source").props.onPress(); await tick();
    if (change === "blur" || change === "unmount") p[change]();
    else if (change === "logout") await f.auth.clearToken({ forceLocal: true });
    else { await f.login("B"); if (change === "ABA") await f.login("A"); }
    if (change !== "unmount") p.render(); held.resolve(false); await tick();
    if (change !== "unmount") { p.render(); assert.equal(p.find("daily-video-source-error"), undefined); }
    assert.deepEqual(p.routes, []);
  } finally { held.resolve(false); p?.unmount(); f.restore(); }
});

test("old account's captured source action cannot open a link after A to B to A", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render(); const stale = p.find("daily-video-source").props.onPress;
    await f.login("B"); await f.login("A"); p.render(); stale(); await tick();
    assert.deepEqual(p.external, []);
  } finally { p?.unmount(); f.restore(); }
});

test("missing stored summary still opens source with no AI permission or summary request", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? response({ state: "ready", card: { ...videoCard(), summary: "" } }) : null;
    p = page(f); p.render(); await tick(); p.render(); await tick(); p.render();
    assert.ok(p.find("daily-video-source")); assert.ok(p.find("daily-video-summary-error"));
    p.find("daily-video-source").props.onPress(); await tick(); assert.equal(p.external.length, 1);
    assert.equal(f.calls.filter((call) => call.path.endsWith("/summary")).length, 0);
  } finally { p?.unmount(); f.restore(); }
});

for (const change of ["B", "logout", "ABA", "blur", "unmount"]) test("held old-account card cannot restore an external action after " + change, async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? { ...response(null), json: () => held.promise } : null;
    p = page(f); p.render(); await tick();
    assert.ok(f.calls.some((call) => call.path === "/feed/daily-video/video-A"));
    if (change === "blur" || change === "unmount") p[change]();
    else if (change === "logout") await f.auth.clearToken({ forceLocal: true });
    else { await f.login("B"); if (change === "ABA") await f.login("A"); }
    f.responder = () => response({}, 503); if (change !== "unmount") p.render();
    held.resolve({ state: "ready", card: videoCard() }); await tick();
    if (change !== "unmount") { p.render(); assert.equal(p.find("daily-video-source"), undefined); assert.equal(p.find("daily-video-nuri-guide"), undefined); }
    assert.deepEqual(p.external, []); assert.deepEqual(p.routes, []);
  } finally { held.resolve({ state: "empty" }); p?.unmount(); f.restore(); }
});

test("optional NURI conversation preserves consent gate, backend card handoff and retry", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render();
    p.find("daily-video-chat").props.onPress(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission")); assert.equal(f.calls.filter((call) => call.path === "/chat/sessions").length, 0);
    assert.ok(p.find("daily-video-source")); await f.permit();
    f.responder = (path) => path === "/chat/sessions" ? response({}, 503) : null;
    p.find("daily-video-chat").props.onPress(); await tick(); p.render(); assert.ok(p.find("request-failure-service"));
    f.responder = null; p.find("request-failure-action").props.onPress(); await tick();
    assert.deepEqual(p.routes, ["/chat/created-A"]);
    assert.deepEqual(JSON.parse(f.calls.find((call) => call.path === "/chat/sessions").init.body), { card_id: "dailyvideo:video-A" });
  } finally { p?.unmount(); f.restore(); }
});

for (const change of ["B", "blur", "unmount"]) test("held NURI session creation cannot navigate after " + change, async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f); p.render(); await tick(); p.render();
    f.responder = (path) => path === "/chat/sessions" ? { ...response(null), json: () => held.promise } : null;
    p.find("daily-video-chat").props.onPress(); await tick();
    assert.ok(f.calls.some((call) => call.path === "/chat/sessions"));
    if (change === "B") { await f.login("B"); p.render(); } else p[change]();
    held.resolve({ id: "stale-created-A" }); await tick(); assert.deepEqual(p.routes, []);
  } finally { held.resolve({}); p?.unmount(); f.restore(); }
});

test("current daily-card endpoint keeps AI guard while explicit stored ID stays read-only", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, {}); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission"));
    assert.equal(f.calls.filter((call) => call.path.startsWith("/feed/daily-video")).length, 0);
    p.blur(); await f.permit(); p.focus(); await tick(); p.render();
    assert.ok(p.find("daily-video-source")); assert.ok(f.calls.some((call) => call.path.startsWith("/feed/daily-video")));
    assert.equal(f.calls.filter((call) => call.path.endsWith("/summary")).length, 0);
  } finally { p?.unmount(); f.restore(); }
});

for (const [status, kind] of [[401, "session"], [503, "service"]]) test("real card load " + status + " retains accurate login/retry action", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? response({}, status) : null;
    p = page(f); p.render(); await tick(); p.render(); assert.ok(p.find("request-failure-" + kind));
    assert.equal(p.kind("ActivityIndicator"), undefined); f.responder = null;
    p.find("request-failure-action").props.onPress(); p.render(); await tick(); p.render();
    if (status === 401) assert.deepEqual(p.routes, ["/login"]); else assert.ok(p.find("daily-video-source"));
  } finally { p?.unmount(); f.restore(); }
});
