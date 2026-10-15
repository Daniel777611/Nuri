import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Actual presentation components and account-scoped hooks, with an entirely
// offline API/OS boundary. Real summaries and authored topic guides remain
// separate; raw source assets and purported full-video analysis stay excluded.
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
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const jsx = (type, props) => ({ type, props });
const runtime = { jsx, jsxs: jsx };
const t = (text, variables = {}) => text.replace(/\{(\w+)\}/g, (whole, key) => String(variables[key] ?? whole));
const guideModule = load("../src/nuriResourceGuide.ts");
const summaryModule = load("../src/resourceSummary.ts");
const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];

function card(concern = "睡眠") {
  const value = { id: "video-A", card_id: "dailyvideo:video-A", video_id: "ScMzIvxBSi4", concern, locale: "zh-CN",
    key_points: "检索片段提到在睡前保持简短、稳定的流程。", summary: "公开检索片段提到睡前流程，并建议观察是否适合家庭的安排。" };
  for (const key of ["title", "display_title", "thumbnail_url", "intro", "channel", "description", "transcript", "excerpt", "quote"]) {
    Object.defineProperty(value, key, { get() { throw new Error("source metadata must not be read: " + key); } });
  }
  return value;
}
function runner() {
  const slots = [], effects = [];
  let cursor = 0, pending = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      slots[index].set ||= (next) => { slots[index].value = typeof next === "function" ? next(slots[index].value) : next; };
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useCallback(fn, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { fn, deps }; return slots[index].fn; },
    useEffect(fn, deps) { const index = cursor++; if (!effects[index] || !same(effects[index].deps, deps)) pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: fn() }; }); },
    useSyncExternalStore(_subscribe, snapshot) { cursor++; return snapshot(); },
  };
  return { react, render(fn) { cursor = 0; pending = []; const tree = fn(); pending.forEach((effect) => effect()); return tree; },
    unmount() { effects.forEach((effect) => effect?.cleanup?.()); } };
}
function page(params = { id: "video-A" }) {
  const r = runner(), guideInputs = [], calls = [], external = [], routes = [], focuses = new Map();
  let generation = 1, focused = true, focusSlot = 0, tree;
  const p = { calls, external, routes, guideInputs, read: async () => ({ state: "ready", card: card() }),
    source: async (url) => { external.push(url); return true; }, chat: async () => ({ id: "created-A" }),
    summarize: async () => ({ summary: "检索片段提到固定睡前的顺序，不建议突然改变所有安排。" }),
    permission: { status: "allowed", session: 1 } };
  const api = {
    getDailyVideoById: (id) => { calls.push(["getById", id]); return p.read(); },
    getDailyVideo: () => { calls.push(["getDaily"]); return p.read(); },
    startSession: (body) => { calls.push(["startSession", body]); return p.chat(); },
    dailyVideoEvent: async (id, event) => { calls.push(["event", id, event]); },
    getDailyVideoSummary(id) { calls.push(["summary", id]); return p.summarize(); },
  };
  const auth = { getSessionGeneration: () => generation, subscribeSessionBoundary: () => () => {} };
  const screen = load("../app/daily-video.tsx", {
    react: r.react, "react/jsx-runtime": runtime,
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", ScrollView: "ScrollView",
      StyleSheet: { create: (value) => value }, useWindowDimensions: () => ({ width: 390 }) },
    "@/src/api": { api, aiConsent: { getState: () => p.permission } }, "@/src/i18n": { useT: () => ({ t }) },
    "@/src/useAIConsent": { useAIConsent: () => ({ state: p.permission }) },
    "@/src/resourceSummary": summaryModule,
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@/src/components/RequestFailureNotice": { __esModule: true, default: (props) => jsx("Notice", { ...props, testID: "failure-notice" }) },
    "@/src/components/YouTubePlayer": { isYouTubeVideoId: (id) => /^[A-Za-z0-9_-]{11}$/.test(id), openYouTubeLink: (url) => p.source(url) },
    "@/src/requestFailure": load("../src/requestFailure.ts"), "@/src/aiPermissionNavigation": load("../src/aiPermissionNavigation.ts"),
    "@/src/useAccountState": load("../src/useAccountState.ts", { react: r.react, "./api": { auth } }),
    "@/src/nuriResourceGuide": { nuriResourceGuide: (input, translate) => { guideInputs.push(input); return guideModule.nuriResourceGuide(input, translate); } },
    "@expo/vector-icons": { Ionicons: "Icon" }, "expo-linear-gradient": { LinearGradient: "Gradient" },
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
  return Object.assign(p, { unmount: r.unmount,
    changeAccount: () => { generation++; },
    changeId: (id) => { params = { id }; },
    render: () => { focusSlot = 0; tree = r.render(() => expand(screen())); return tree; },
    blur: () => { focused = false; focuses.forEach((entry) => { entry.cleanup?.(); entry.cleanup = null; }); },
    focus: () => { focused = true; focuses.forEach((entry) => { entry.cleanup = entry.fn(); }); },
    find: (id) => nodes(tree).find((node) => node.props?.testID === id),
    visible: () => JSON.stringify(tree), kinds: (type) => nodes(tree).filter((node) => node.type === type),
  });
}

test("actual video screen keeps original topic guide independent of actual source-bound summary", async () => {
  const p = page();
  try {
    p.render(); await tick(); p.render();
    const expected = guideModule.nuriResourceGuide({ concern: "睡眠" }, t);
    assert.equal(p.find("daily-video-guide-headline").props.children, expected.headline);
    assert.equal(p.find("daily-video-guide-intro").props.children, expected.intro);
    for (let index = 0; index < 3; index++) assert.ok(p.find(`daily-video-guide-action-${index}`));
    assert.equal(p.find("daily-video-guide-action-3"), undefined);
    assert.match(JSON.stringify(p.find("daily-video-guide-disclosure").props.children), /不是原文或完整视频摘要/);
    assert.ok(p.find("daily-video-nuri-guide")); assert.equal(p.kinds("WebView").length, 0); assert.equal(p.kinds("Image").length, 0);
    assert.ok(p.guideInputs.length); for (const input of p.guideInputs) assert.deepEqual(input, { concern: "睡眠" });
    assert.deepEqual(p.external, []); assert.deepEqual(p.routes, []);
    assert.deepEqual(p.calls, [["getById", "video-A"]]);
  } finally { p.unmount(); }
});

test("Home card shows its own topic headline and guide CTA, with unchanged navigation", () => {
  const guideInputs = [], selected = [];
  const component = load("../src/components/DailyVideoCard.tsx", {
    "react/jsx-runtime": runtime, "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: (value) => value } },
    "@/src/i18n": { useT: () => ({ t }) }, "expo-linear-gradient": { LinearGradient: "Gradient" }, "@expo/vector-icons": { Ionicons: "Icon" },
    "@/src/nuriResourceGuide": { nuriResourceGuide: (input, translate) => { guideInputs.push(input); return guideModule.nuriResourceGuide(input, translate); } },
    "@/src/resourceSummary": summaryModule,
  }).default;
  const ready = card("语言发展"), tree = component({ status: "ready", card: ready, width: 340, onPress: (value) => selected.push(value.id), onRetry() {} });
  const expected = guideModule.nuriResourceGuide({ concern: "语言发展" }, t);
  assert.equal(nodes(tree).find((node) => node.props?.testID === "home-daily-video-external-title").props.children, expected.headline);
  assert.match(JSON.stringify(tree), /查看摘要与导读/); assert.ok(nodes(tree).some((node) => node.type === "Gradient"));
  assert.match(JSON.stringify(tree), /检索片段提到在睡前保持简短、稳定的流程/);
  assert.match(JSON.stringify(tree), /非完整视频摘要/);
  assert.deepEqual(guideInputs, [{ concern: "语言发展" }]);
  const press = nodes(tree).find((node) => node.props?.testID === "home-daily-video-card"); press.props.onPress(); assert.deepEqual(selected, ["video-A"]);
  guideInputs.length = 0;
  for (const status of ["loading", "pending", "empty", "error", "ready"]) {
    const missing = component({ status, card: null, width: 340, onPress() {}, onRetry() {} });
    assert.equal(nodes(missing).find((node) => node.props?.testID === "home-daily-video-card"), undefined);
  }
  assert.deepEqual(guideInputs, [], "without a ready card no video-specific guide is invented");
});

async function settle(p) { for (let round = 0; round < 4; round++) { p.render(); await tick(); } p.render(); }

test("cached generated summary displays without a new model request, even when AI is denied", async () => {
  const p = page(); p.permission = { status: "not_allowed", session: 1 };
  try {
    await settle(p);
    assert.equal(p.find("daily-video-summary").props.children, card().summary);
    assert.equal(p.find("daily-video-key-points").props.children, card().key_points);
    assert.equal(p.calls.filter(([operation]) => operation === "summary").length, 0);
    assert.match(JSON.stringify(p.find("daily-video-summary-disclosure")), /未观看完整视频或获取字幕/);
    assert.ok(p.find("daily-video-nuri-guide")); assert.ok(p.find("daily-video-source"));
  } finally { p.unmount(); }
});

test("a saved cached summary never carries across account generations, including A to B to A", async () => {
  const p = page(), held = deferred();
  try {
    await settle(p); assert.equal(p.find("daily-video-summary").props.children, card().summary);
    p.read = () => held.promise;
    for (let boundary = 0; boundary < 2; boundary++) {
      p.changeAccount(); p.render();
      assert.equal(p.find("daily-video-summary"), undefined);
      assert.doesNotMatch(p.visible(), /睡前流程|简短、稳定的流程/);
    }
    held.resolve({ state: "empty" }); await settle(p);
    assert.equal(p.find("daily-video-summary"), undefined);
  } finally { held.resolve({ state: "empty" }); p.unmount(); }
});

test("changing a deep link A to B hides A while pending and exposes B read failure, not a permanent spinner", async () => {
  const p = page(), held = deferred();
  try {
    await settle(p); assert.equal(p.find("daily-video-summary").props.children, card().summary);
    p.changeId("video-B"); p.read = async () => { await held.promise; throw { status: 404 }; };
    p.render(); assert.equal(p.find("daily-video-summary"), undefined);
    assert.doesNotMatch(p.visible(), /睡前流程|简短、稳定的流程/);
    held.resolve(); await settle(p);
    assert.equal(p.find("failure-notice").props.error, "service");
    assert.equal(p.kinds("ActivityIndicator").length, 0);
    assert.equal(p.find("daily-video-summary-section"), undefined); assert.equal(p.find("daily-video-source"), undefined);
    p.read = async () => ({ state: "ready", card: { ...card("语言发展"), id: "video-B", card_id: "dailyvideo:video-B", summary: "语言发展相关的公开检索信息。" } });
    p.find("failure-notice").props.onRetry(); await settle(p);
    assert.equal(p.find("daily-video-summary").props.children, "语言发展相关的公开检索信息。");
  } finally { held.resolve(); p.unmount(); }
});

test("a backend row that does not match the requested deep link is not shown", async () => {
  const p = page({ id: "video-B" });
  try {
    await settle(p); assert.equal(p.find("daily-video-summary-section"), undefined);
    assert.ok(p.find("daily-video-load-retry")); assert.equal(p.kinds("ActivityIndicator").length, 0);
    assert.equal(p.calls.filter(([operation]) => operation === "summary").length, 0);
  } finally { p.unmount(); }
});

test("missing summary uses existing owned endpoint once and shows returned text, not a topic checklist", async () => {
  const p = page(); p.read = async () => ({ state: "ready", card: { ...card(), summary: "" } });
  try {
    await settle(p);
    assert.deepEqual(p.calls.filter(([operation]) => operation === "summary"), [["summary", "video-A"]]);
    assert.equal(p.find("daily-video-summary").props.children, (await p.summarize()).summary);
    assert.doesNotMatch(p.find("daily-video-summary").props.children, /根据你的关注点|不是原文/);
  } finally { p.unmount(); }
});

test("empty backend summary remains honest and offers a specific retry", async () => {
  const p = page(); p.read = async () => ({ state: "ready", card: { ...card(), summary: "", key_points: "" } });
  p.summarize = async () => ({ summary: "" });
  try {
    await settle(p); assert.ok(p.find("daily-video-summary-empty")); assert.equal(p.find("daily-video-summary"), undefined);
    assert.ok(p.find("daily-video-nuri-guide"));
    p.summarize = async () => ({ summary: "公开片段现在提供了可以核对的信息。" });
    p.find("daily-video-summary-retry").props.onPress(); await settle(p);
    assert.equal(p.find("daily-video-summary").props.children, "公开片段现在提供了可以核对的信息。");
    assert.equal(p.calls.filter(([operation]) => operation === "getById").length, 1);
    assert.equal(p.calls.filter(([operation]) => operation === "summary").length, 2);
  } finally { p.unmount(); }
});

test("summary service failure retries only summary while source, guide and chat remain available", async () => {
  const p = page(); p.read = async () => ({ state: "ready", card: { ...card(), summary: "" } });
  p.summarize = async () => { throw { status: 503 }; };
  try {
    await settle(p); assert.ok(p.find("daily-video-summary-error"));
    assert.equal(p.find("failure-notice").props.error, "service");
    assert.ok(p.find("daily-video-source")); assert.ok(p.find("daily-video-chat")); assert.ok(p.find("daily-video-nuri-guide"));
    p.summarize = async () => ({ summary: "公开片段提供了可核对的建议。" });
    p.find("failure-notice").props.onRetry(); await settle(p);
    assert.equal(p.find("daily-video-summary").props.children, "公开片段提供了可核对的建议。");
    assert.equal(p.calls.filter(([operation]) => operation === "getById").length, 1);
  } finally { p.unmount(); }
});

test("denied AI permission does not trigger summary generation and exposes the permission action", async () => {
  const p = page(); p.permission = { status: "not_allowed", session: 1 };
  p.read = async () => ({ state: "ready", card: { ...card(), summary: "" } });
  try {
    await settle(p); assert.equal(p.calls.filter(([operation]) => operation === "summary").length, 0);
    assert.equal(p.find("failure-notice").props.error, "permission");
    p.find("failure-notice").props.onPermission(); assert.equal(p.routes[0].pathname, "/ai-permission");
    assert.equal(p.routes[0].params.returnTo, "/daily-video?id=video-A");
    p.permission = { status: "allowed", session: 1 }; await settle(p);
    assert.equal(p.calls.filter(([operation]) => operation === "summary").length, 1); assert.ok(p.find("daily-video-summary"));
  } finally { p.unmount(); }
});

for (const change of ["account", "blur", "unmount", "permission", "route"]) test("late summary is ignored after " + change, async () => {
  const p = page(), held = deferred();
  p.read = async () => ({ state: "ready", card: { ...card(), summary: "" } }); p.summarize = () => held.promise;
  try {
    p.render(); await tick(); p.render(); await tick(); p.render();
    assert.ok(p.find("daily-video-summary-loading")); assert.equal(p.calls.filter(([operation]) => operation === "summary").length, 1);
    if (change === "account") { p.changeAccount(); p.read = async () => ({ state: "empty" }); p.render(); }
    else if (change === "permission") { p.permission = { status: "not_allowed", session: 1 }; p.render(); }
    else if (change === "route") { p.changeId("video-B"); p.read = async () => ({ state: "empty" }); p.render(); }
    else p[change]();
    held.resolve({ summary: "STALE_PRIVATE_SUMMARY" }); await tick();
    if (change !== "unmount") { p.render(); assert.doesNotMatch(p.visible(), /STALE_PRIVATE_SUMMARY/); }
    assert.deepEqual(p.routes, []);
  } finally { held.resolve({ summary: "" }); p.unmount(); }
});

test("video source and optional NURI chat preserve exact existing handoffs", async () => {
  const p = page();
  try {
    p.render(); await tick(); p.render();
    p.find("daily-video-source").props.onPress(); await tick();
    assert.deepEqual(p.external, ["https://www.youtube.com/watch?v=ScMzIvxBSi4"]);
    p.find("daily-video-chat").props.onPress(); await tick();
    assert.ok(p.calls.some(([operation, body]) => operation === "startSession" && body.card_id === "dailyvideo:video-A"));
    assert.deepEqual(p.routes, ["/chat/created-A"]);
  } finally { p.unmount(); }
});

test("missing or invalid video never receives a fabricated video guide", async () => {
  for (const result of [{ state: "empty" }, { state: "ready", card: { ...card(), video_id: "bad-id" } }]) {
    const p = page(); p.read = async () => result;
    try {
      p.render(); await tick(); p.render(); assert.equal(p.find("daily-video-nuri-guide"), undefined);
      assert.equal(p.find("daily-video-source"), undefined); assert.deepEqual(p.guideInputs, []);
    } finally { p.unmount(); }
  }
});

test("load failure retries existing read and restores guide only after valid data", async () => {
  const p = page(); p.read = async () => { throw new Error("offline"); };
  try {
    p.render(); await tick(); p.render(); assert.ok(p.find("failure-notice")); assert.deepEqual(p.guideInputs, []);
    p.read = async () => ({ state: "ready", card: card() }); p.find("failure-notice").props.onRetry();
    p.render(); await tick(); p.render(); assert.ok(p.find("daily-video-nuri-guide"));
    assert.equal(p.calls.filter(([operation]) => operation === "getById").length, 2);
  } finally { p.unmount(); }
});

for (const change of ["account", "blur", "unmount"]) test("late card cannot reveal old topic guide after " + change, async () => {
  const p = page(), held = deferred(); p.read = () => held.promise;
  try {
    p.render(); await tick();
    if (change === "account") { p.changeAccount(); p.read = async () => ({ state: "empty" }); p.render(); }
    else p[change]();
    held.resolve({ state: "ready", card: card("stale-private-topic") }); await tick();
    if (change !== "unmount") { p.render(); assert.equal(p.find("daily-video-nuri-guide"), undefined); assert.doesNotMatch(p.visible(), /stale-private-topic/); }
    assert.deepEqual(p.routes, []);
  } finally { held.resolve({ state: "empty" }); p.unmount(); }
});

test("source dispatch remains busy-safe with actionable failure/retry", async () => {
  const p = page(), held = deferred();
  let attempts = 0; p.source = async () => { attempts++; return held.promise; };
  try {
    p.render(); await tick(); p.render(); const press = p.find("daily-video-source").props.onPress;
    press(); press(); p.render(); assert.equal(attempts, 1); assert.equal(p.find("daily-video-source").props.disabled, true);
    held.resolve(false); await tick(); p.render(); assert.ok(p.find("daily-video-source-error")); assert.ok(p.find("daily-video-nuri-guide"));
    p.source = async () => true; p.find("daily-video-source").props.onPress(); await tick(); p.render();
    assert.equal(p.find("daily-video-source-error"), undefined);
  } finally { held.resolve(false); p.unmount(); }
});
