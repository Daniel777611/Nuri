import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Load actual presentation code with local data and an offline API/OS boundary.
// No network, provider, storage or production account is used by this suite.
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
const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const guideModule = load("../src/nuriResourceGuide.ts");
const externalModule = load("../src/externalContent.ts");
const summaryModule = load("../src/resourceSummary.ts");

function card(concern = "睡眠") {
  const value = { id: "post-A", card_id: "post:post-A", concern, nickname: "Test Parent", audience: "parent",
    platform: "threads", author_kind: "parent_post", basis: "conversation", source_url: "https://www.threads.net/@example/post/owned-link",
    question: "AI_SEARCH_QUESTION?", headline: "AI_SEARCH_HEADLINE.", situation: "AI_SEARCH_SITUATION.",
    takeaways: ["AI_SEARCH_POINT_ONE.", "AI_SEARCH_POINT_TWO.", "AI_SEARCH_POINT_THREE."],
    why_this: "AI_SEARCH_REASON.", caution: "AI_SEARCH_CAUTION.", summary_source: "facebook_ai_summary" };
  for (const key of ["excerpt", "body", "source_body", "transcript", "thumbnail_url", "image_url", "source_label"]) {
    Object.defineProperty(value, key, { get() { throw new Error("source content must not be read: " + key); } });
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
const native = { View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", ScrollView: "ScrollView",
  Platform: { OS: "ios" }, StyleSheet: { create: (value) => value }, useWindowDimensions: () => ({ width: 390 }) };
function postComponent(guideInputs = []) {
  return load("../src/components/DailyPostCard.tsx", {
    "react/jsx-runtime": runtime, "react-native": native, "@/src/i18n": { useT: () => ({ t }) },
    "expo-linear-gradient": { LinearGradient: "Gradient" }, "@expo/vector-icons": { Ionicons: "Icon" },
    "@/src/nuriResourceGuide": { nuriResourceGuide: (input, translate) => { guideInputs.push(input); return guideModule.nuriResourceGuide(input, translate); } },
    "@/src/resourceSummary": summaryModule, "@/src/externalContent": externalModule,
  });
}
function page(params = { id: "post-A" }) {
  const r = runner(), guideInputs = [], calls = [], external = [], routes = [], focuses = new Map();
  let generation = 1, focused = true, focusSlot = 0, tree;
  const p = { calls, external, routes, guideInputs, read: async () => ({ state: "ready", card: card() }),
    source: async (url) => { external.push(url); }, chat: async () => ({ id: "created-A" }) };
  const api = {
    getDailyPostById: (id) => { calls.push(["getById", id]); return p.read(); },
    getDailyPost: () => { calls.push(["getDaily"]); return p.read(); },
    startSession: (body) => { calls.push(["startSession", body]); return p.chat(); },
    dailyPostEvent: async (id, event) => { calls.push(["event", id, event]); },
  };
  const auth = { getSessionGeneration: () => generation, subscribeSessionBoundary: () => () => {} };
  const screen = load("../app/daily-post.tsx", {
    react: r.react, "react/jsx-runtime": runtime, "react-native": { ...native, Linking: { openURL: (url) => p.source(url) } },
    "@/src/api": { api }, "@/src/i18n": { useT: () => ({ t }) },
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@/src/components/RequestFailureNotice": { __esModule: true, default: (props) => jsx("Notice", { ...props, testID: "failure-notice" }) },
    "@/src/components/DailyPostCard": postComponent(), "@/src/externalContent": externalModule,
    "@/src/requestFailure": load("../src/requestFailure.ts"), "@/src/aiPermissionNavigation": load("../src/aiPermissionNavigation.ts"),
    "@/src/useAccountState": load("../src/useAccountState.ts", { react: r.react, "./api": { auth } }),
    "@/src/nuriResourceGuide": { nuriResourceGuide: (input, translate) => { guideInputs.push(input); return guideModule.nuriResourceGuide(input, translate); } },
    "@/src/resourceSummary": summaryModule,
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": { useLocalSearchParams: () => params, useRouter: () => ({ push: (href) => routes.push(href), replace: (href) => routes.push(href), canGoBack: () => false }),
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
  return Object.assign(p, { unmount: r.unmount, changeAccount: () => { generation++; },
    render: () => { focusSlot = 0; tree = r.render(() => expand(screen())); return tree; },
    blur: () => { focused = false; focuses.forEach((entry) => { entry.cleanup?.(); entry.cleanup = null; }); },
    focus: () => { focused = true; focuses.forEach((entry) => { entry.cleanup = entry.fn(); }); },
    find: (id) => nodes(tree).find((node) => node.props?.testID === id), visible: () => JSON.stringify(tree),
  });
}

test("actual post screen renders brief AI search preview plus distinct original guide and disclosures", async () => {
  const p = page();
  try {
    p.render(); await tick(); p.render(); const expected = guideModule.nuriResourceGuide({ concern: "睡眠" }, t);
    assert.equal(p.find("daily-post-guide-headline").props.children, expected.headline);
    assert.equal(p.find("daily-post-guide-intro").props.children, expected.intro);
    for (let index = 0; index < 3; index++) assert.ok(p.find(`daily-post-guide-action-${index}`));
    assert.equal(p.find("daily-post-guide-action-3"), undefined);
    assert.equal(p.find("daily-post-guide-disclosure").props.children, expected.disclosure);
    assert.match(expected.disclosure, /不是原文或完整视频摘要/);
    assert.equal(p.find("daily-post-summary-question").props.children, "AI_SEARCH_QUESTION?");
    assert.equal(p.find("daily-post-summary-situation").props.children, "AI_SEARCH_SITUATION.");
    assert.ok(p.find("daily-post-summary-point-0")); assert.ok(p.find("daily-post-summary-point-1"));
    assert.equal(p.find("daily-post-summary-point-2"), undefined);
    assert.match(p.find("daily-post-summary-disclosure").props.children, /部分内容.*有误.*原站核对/);
    assert.match(p.find("daily-post-summary-basis").props.children, /不是原帖逐字引用/);
    assert.match(p.visible(), /AI_SEARCH_REASON.*AI_SEARCH_CAUTION/);
    for (const input of p.guideInputs) assert.deepEqual(input, { concern: "睡眠" });
    assert.deepEqual(p.calls, [["getById", "post-A"]], "guide rendering adds no generation/summary request");
    assert.deepEqual(p.external, []); assert.deepEqual(p.routes, []);
  } finally { p.unmount(); }
});

test("actual Home post card shows the supplied AI question, not a verbatim excerpt", () => {
  const guideInputs = [], selected = [], component = postComponent(guideInputs).default;
  const tree = component({ status: "ready", card: card("语言发展"), nickname: "Parent", width: 340,
    onPress: (value) => selected.push(value.id), onRetry() {} });
  assert.equal(nodes(tree).find((node) => node.props?.testID === "home-daily-post-question").props.children, "AI_SEARCH_QUESTION?");
  assert.equal(nodes(tree).find((node) => node.props?.testID === "home-daily-post-summary-label").props.children, "AI 检索摘要");
  assert.match(JSON.stringify(tree), /查看摘要与来源/); assert.ok(nodes(tree).some((node) => node.type === "Gradient"));
  const press = nodes(tree).find((node) => node.props?.testID === "home-daily-post-card");
  assert.equal(press.props.accessibilityRole, "button"); assert.match(press.props.accessibilityLabel, /AI_SEARCH_QUESTION/);
  press.props.onPress(); assert.deepEqual(selected, ["post-A"]); assert.deepEqual(guideInputs, [], "an existing AI preview is not relabeled as the original family-topic guide");
  guideInputs.length = 0;
  for (const status of ["loading", "pending", "empty", "error", "ready"]) {
    const missing = component({ status, card: null, nickname: "Parent", width: 340, onPress() {}, onRetry() {} });
    assert.equal(nodes(missing).find((node) => node.props?.testID === "home-daily-post-card"), undefined);
  }
  assert.deepEqual(guideInputs, [], "missing card has no manufactured post guide");
});

test("Home fallback labels the original NURI guide, never a missing or unsafe-source preview as AI search summary", () => {
  const component = postComponent().default;
  for (const overrides of [
    { question: "", headline: "" },
    { question: "   ", headline: "<script>PRIVATE_SCRIPT</script> https://private.invalid/source" },
    { source_url: "http://example.com/original" },
    { source_url: "https://example.com/original?access_token=private" },
  ]) {
    const fixture = { ...card("睡眠"), ...overrides };
    const tree = component({ status: "ready", card: fixture, nickname: "Parent", width: 340, onPress() {}, onRetry() {} });
    const label = nodes(tree).find((node) => node.props?.testID === "home-daily-post-summary-label");
    assert.equal(label.props.children, "NURI 导读");
    assert.equal(nodes(tree).find((node) => node.props?.testID === "home-daily-post-question").props.children,
      guideModule.nuriResourceGuide({ concern: "睡眠" }, t).headline);
    const press = nodes(tree).find((node) => node.props?.testID === "home-daily-post-card");
    assert.match(press.props.accessibilityLabel, /NURI 导读/);
    assert.doesNotMatch(press.props.accessibilityLabel, /AI 检索摘要|AI_SEARCH_|PRIVATE_|private\.invalid/);
  }
});

test("AI summaries are restored but raw excerpt, full source body, transcript and images remain unpublished", async () => {
  const p = page(), thirdParty = "THIRD_PARTY_DO_NOT_RENDER";
  const plain = { ...card(), question: "<b>AI_ALLOWED_QUESTION?</b> https://source.example/hidden",
    situation: "AI_ALLOWED_SITUATION.", headline: "AI_ALLOWED_HEADLINE.", takeaways: ["AI_ALLOWED_POINT."],
    excerpt: thirdParty, body: thirdParty, source_body: thirdParty, transcript: thirdParty,
    thumbnail_url: "https://source.example/THIRD_PARTY_DO_NOT_RENDER.jpg", image_url: thirdParty, source_label: thirdParty };
  p.read = async () => ({ state: "ready", card: plain });
  try {
    p.render(); await tick(); p.render(); assert.doesNotMatch(p.visible(), /THIRD_PARTY_DO_NOT_RENDER|source\.example/);
    assert.equal(p.find("daily-post-summary-question").props.children, "AI_ALLOWED_QUESTION?");
    assert.equal(p.find("daily-post-summary-situation").props.children, "AI_ALLOWED_SITUATION.");
    assert.ok(p.find("daily-post-summary-point-0"));
    const home = postComponent().default({ status: "ready", card: plain, nickname: "Parent", width: 340, onPress() {}, onRetry() {} });
    assert.doesNotMatch(JSON.stringify(home), /THIRD_PARTY_DO_NOT_RENDER/);
    assert.match(JSON.stringify(home), /AI_ALLOWED_QUESTION/);
  } finally { p.unmount(); }
});

test("original-site link and NURI conversation keep existing event/session contracts", async () => {
  const p = page();
  try {
    p.render(); await tick(); p.render(); assert.equal(p.find("daily-post-source").props.accessibilityRole, "link");
    p.find("daily-post-source").props.onPress(); await tick();
    assert.deepEqual(p.external, ["https://www.threads.net/@example/post/owned-link"]);
    assert.ok(p.calls.some(([operation, id, event]) => operation === "event" && id === "post-A" && event === "source_click"));
    p.find("daily-post-chat").props.onPress(); await tick();
    assert.ok(p.calls.some(([operation, body]) => operation === "startSession" && body.card_id === "post:post-A"));
    assert.deepEqual(p.routes, ["/chat/created-A"]);
  } finally { p.unmount(); }
});

test("invalid or credential-bearing source URLs cannot be opened", async () => {
  for (const source_url of ["javascript:alert(1)", "http://example.com/post", "https://example.com/post?access_token=secret", "https://localhost/private"]) {
    const p = page(); p.read = async () => ({ state: "ready", card: { ...card(), source_url } });
    try {
      p.render(); await tick(); p.render(); p.find("daily-post-source").props.onPress(); await tick(); p.render();
      assert.deepEqual(p.external, []); assert.ok(p.find("daily-post-source-error")); assert.ok(p.find("daily-post-guide-headline"));
    } finally { p.unmount(); }
  }
});

test("missing card and load failure do not generate topic-specific post guide", async () => {
  const p = page(); p.read = async () => ({ state: "empty" });
  try {
    p.render(); await tick(); p.render(); assert.equal(p.find("daily-post-guide-headline"), undefined); assert.deepEqual(p.guideInputs, []);
    p.blur(); p.read = async () => { throw new Error("offline"); }; p.focus(); await tick(); p.render();
    assert.ok(p.find("failure-notice")); assert.equal(p.find("daily-post-guide-headline"), undefined);
    p.read = async () => ({ state: "ready", card: card() }); p.find("failure-notice").props.onRetry();
    p.render(); await tick(); p.render(); assert.ok(p.find("daily-post-guide-headline"));
  } finally { p.unmount(); }
});

for (const change of ["account", "blur", "unmount"]) test("held post body cannot restore old topic guide after " + change, async () => {
  const p = page(), held = deferred(); p.read = () => held.promise;
  try {
    p.render(); await tick();
    if (change === "account") { p.changeAccount(); p.read = async () => ({ state: "empty" }); p.render(); } else p[change]();
    held.resolve({ state: "ready", card: card("stale-private-post-topic") }); await tick();
    if (change !== "unmount") { p.render(); assert.equal(p.find("daily-post-guide-headline"), undefined); assert.doesNotMatch(p.visible(), /stale-private-post-topic/); }
    assert.deepEqual(p.routes, []);
  } finally { held.resolve({ state: "empty" }); p.unmount(); }
});

test("recommendation detail derives original guide only from topic and family stage", () => {
  const source = readFileSync(new URL("../app/detail/[id].tsx", import.meta.url), "utf8");
  assert.match(source, /nuriResourceGuide\(\{ concern: card\.topic_label \|\| card\.topic, stage: stageLabel \}, t\)/);
  const guideSection = source.slice(source.indexOf('testID="detail-nuri-guide"'), source.indexOf("{resources.length || card.research_status"));
  assert.ok(guideSection.length > 0); assert.match(guideSection, /guide\.headline/); assert.match(guideSection, /guide\.intro/);
  assert.match(guideSection, /guide\.actions\.map/); assert.match(guideSection, /guide\.disclosure/);
  assert.doesNotMatch(guideSection, /card\.(?:summary|body|description|title)|resource\.(?:summary|description|title)|image_url/);
});
