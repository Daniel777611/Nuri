import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fixture, page, load, videoCard, runner } from "./test-daily-home-failure.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

// Only the Home polling interval is virtual. API timeouts retain their real
// implementation; firing a poll executes the actual component's async callback.
function pollClock() {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout, queue = new Map();
  let sequence = 0;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms !== 5000) return set(fn, ms, ...args);
    const id = --sequence; queue.set(id, () => fn(...args)); return id;
  };
  globalThis.clearTimeout = (id) => { if (queue.has(id)) queue.delete(id); else clear(id); };
  return { count: () => queue.size,
    async fire() { const next = queue.entries().next().value; assert.ok(next, "a real poll must have been scheduled"); queue.delete(next[0]); await next[1](); },
    restore() { queue.clear(); globalThis.setTimeout = set; globalThis.clearTimeout = clear; },
  };
}

test("actual Home independently shows post and video, routes owned video ID", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f, "home"); p.render(); await tick(); p.render();
    assert.ok(p.find("home-daily-post-card")); assert.ok(p.find("home-daily-video-card"));
    p.find("home-daily-video-card").props.onPress();
    assert.deepEqual(p.routes, [{ pathname: "/daily-video", params: { id: "video-A" } }]);
    await tick(); assert.ok(f.calls.some((call) => call.path === "/feed/daily-video/video-A/events" && JSON.parse(call.init.body).event === "open"));
  } finally { p?.unmount(); f.restore(); }
});
test("Home post failure does not suppress the ready video", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); f.responder = (path) => path.startsWith("/feed/daily-post") ? response({}, 503) : null;
    p = page(f, "home"); p.render(); await tick(); p.render();
    assert.ok(p.find("home-daily-post-empty")); assert.ok(p.find("home-daily-video-card"));
  } finally { p?.unmount(); f.restore(); }
});
test("Home video permission CTA and grant/refocus recovery", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "home"); p.render(); await tick(); p.render();
    assert.ok(p.find("home-daily-video-empty")); p.find("home-daily-video-empty").props.onPress();
    assert.deepEqual(p.routes, [{ pathname: "/ai-permission", params: { returnTo: "/(tabs)" } }]);
    assert.equal(f.calls.filter((call) => call.path.startsWith("/feed/daily-video")).length, 0);
    p.blur(); await f.permit(); p.focus(); await tick(); p.render(); assert.ok(p.find("home-daily-video-card"));
  } finally { p?.unmount(); f.restore(); }
});
test("stored AI video summary and source link are readable without generation permission or embedded playback", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render(); await tick(); p.render();
    assert.ok(p.find("daily-video-external-title")); assert.ok(p.find("daily-video-source"));
    assert.equal(p.find("daily-video-source").props.accessibilityRole, "link");
    assert.equal(p.find("daily-video-webview"), undefined); assert.equal(p.find("daily-video-summary").props.children, "Saved description summary");
    assert.equal(p.kind("WebView"), undefined);
    const guide = load("../src/nuriResourceGuide.ts").nuriResourceGuide({ concern: videoCard("A").concern });
    assert.equal(p.find("daily-video-guide-headline").props.children, guide.headline);
    assert.equal(p.find("daily-video-guide-intro").props.children, guide.intro);
    assert.equal(p.find("daily-video-guide-disclosure").props.children, guide.disclosure);
    assert.match(p.visible(), /Fixture sleep/, "own family topic is allowed in NURI's original reading prompts");
    assert.match(p.find("daily-video-summary-disclosure").props.children, /未观看完整视频或获取字幕/);
    assert.doesNotMatch(p.visible(), /Fixture pediatrician|A video title|A private video|ytimg\.com|youtube-nocookie/);
    assert.equal(f.calls.filter((call) => call.path.endsWith("/summary") || call.path === "/chat/sessions").length, 0);
    assert.deepEqual(p.external, [], "reading the card must never automatically launch an external site");
    p.appState("background"); p.render(); assert.equal(p.kind("WebView"), undefined);
    p.appState("active"); p.render(); assert.equal(p.kind("WebView"), undefined);
  } finally { p?.unmount(); f.restore(); }
});
test("missing AI summary waits for permission and grant/refocus uses only existing summary endpoint", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? response({ state: "ready", card: { ...videoCard("A"), summary: "" } }) : null;
    p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render(); await tick(); p.render();
    assert.ok(p.find("daily-video-summary-error")); assert.ok(p.find("request-failure-permission")); assert.ok(p.find("daily-video-source"));
    assert.equal(f.calls.filter((call) => call.path.endsWith("/summary")).length, 0);
    p.blur(); await f.permit(); p.focus(); await tick(); p.render(); await tick(); p.render();
    assert.ok(p.find("daily-video-source")); assert.equal(p.find("daily-video-summary").props.children, "A generated AI search summary.");
    assert.equal(f.calls.filter((call) => call.path.endsWith("/summary")).length, 1);
    assert.deepEqual(p.routes, []);
  } finally { p?.unmount(); f.restore(); }
});
for (const [status, failure] of [[401, "session"], [503, "service"]]) test("video load " + status + " selects accurate action, not permanent spinner", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? response({}, status) : null;
    p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-" + failure)); assert.equal(p.kind("ActivityIndicator"), undefined);
    f.responder = null; p.find("request-failure-action").props.onPress(); p.render(); await tick(); p.render();
    if (status === 401) assert.deepEqual(p.routes, ["/login"]); else assert.ok(p.find("daily-video-external-title"));
  } finally { p?.unmount(); f.restore(); }
});
test("video chat denial retains card; service retry repeats original POST", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    p.find("daily-video-chat").props.onPress(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission")); assert.ok(p.find("daily-video-external-title"));
    await f.permit(); f.responder = (path) => path === "/chat/sessions" ? response({}, 503) : null;
    p.find("daily-video-chat").props.onPress(); await tick(); p.render(); assert.ok(p.find("request-failure-service"));
    const before = f.calls.filter((call) => call.path === "/chat/sessions").length;
    f.responder = null; p.find("request-failure-action").props.onPress(); await tick(); p.render();
    assert.equal(f.calls.filter((call) => call.path === "/chat/sessions").length, before + 1);
    assert.deepEqual(p.routes, ["/chat/created-A"]);
    assert.deepEqual(JSON.parse(f.calls.find((call) => call.path === "/chat/sessions").init.body), { card_id: "dailyvideo:video-A" });
  } finally { p?.unmount(); f.restore(); }
});
for (const change of ["B", "logout", "ABA", "blur", "unmount"]) test("held video A body cannot restore UI after " + change, async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? { ...response(null), json: () => held.promise } : null;
    p = page(f, "video", { id: "video-A" }); p.render(); await tick();
    assert.ok(f.calls.some((call) => call.path === "/feed/daily-video/video-A"), "actual body barrier reached");
    if (change === "blur") p.blur(); else if (change === "unmount") p.unmount(); else if (change === "logout") await f.auth.clearToken({ forceLocal: true });
    else { await f.login("B"); if (change === "ABA") await f.login("A"); }
    f.responder = () => response({}, 503); if (change !== "unmount") p.render();
    held.resolve({ state: "ready", card: { ...videoCard("A"), title: "stale-private-video", display_title: "stale-private-video" } }); await tick();
    if (change !== "unmount") p.render();
    assert.equal(p.find("daily-video-external-title"), undefined, "the generic link UI must not hide a stale-card restoration");
    assert.equal(p.find("daily-video-source"), undefined);
    assert.equal(p.find("daily-video-nuri-guide"), undefined, "a late account A result must not restore the topic guide either");
    assert.doesNotMatch(p.visible(), /stale-private-video/); assert.deepEqual(p.routes, []);
  } finally { p?.unmount(); f.restore(); }
});
test("explicit source uses validated video ID, ignores poisoned source URL", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? response({ state: "ready", card: { ...videoCard("A"), source_url: "https://evil.invalid" } }) : null;
    p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    p.find("daily-video-source").props.onPress(); await tick(); assert.deepEqual(p.external, ["https://www.youtube.com/watch?v=ScMzIvxBSi4"]);
  } finally { p?.unmount(); f.restore(); }
});
test("explicit YouTube source launch records its source event and never dispatches account credentials", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    p.find("daily-video-source").props.onPress(); await tick(); p.render();
    assert.deepEqual(p.external, ["https://www.youtube.com/watch?v=ScMzIvxBSi4"]);
    assert.doesNotMatch(JSON.stringify(p.external), /Bearer|account-A|token|authorization/i);
    assert.ok(f.calls.some((call) => call.path === "/feed/daily-video/video-A/events" && JSON.parse(call.init.body).event === "source_click"));
    assert.equal(p.kind("WebView"), undefined); assert.ok(p.find("daily-video-summary-section"));
  } finally { p?.unmount(); f.restore(); }
});
test("actual Home and video screens restore brief AI summaries, never video titles, thumbnails or channel", async () => {
  const f = fixture(); let home, video;
  try {
    await f.login("A"); await f.permit(); home = page(f, "home"); home.render(); await tick(); home.render();
    const guide = load("../src/nuriResourceGuide.ts").nuriResourceGuide({ concern: videoCard("A").concern });
    assert.equal(home.find("home-daily-video-external-title").props.children, guide.headline);
    assert.ok(home.find("home-daily-video-external-notice"));
    assert.equal(home.find("home-daily-video-thumbnail"), undefined); assert.equal(home.find("home-daily-video-title"), undefined);
    assert.equal(home.find("home-daily-video-external-notice").props.children, "Saved description summary");
    assert.doesNotMatch(home.visible(), /A video title|A private video|Fixture pediatrician|i\.ytimg\.com/);
    video = page(f, "video", { id: "video-A" }); video.render(); await tick(); video.render(); await tick(); video.render();
    assert.equal(video.find("daily-video-external-title").props.children, "YouTube 育儿资源链接");
    assert.ok(video.find("daily-video-external-notice"));
    assert.equal(video.find("daily-video-title"), undefined); assert.equal(video.find("daily-video-guide-title"), undefined);
    assert.equal(video.find("daily-video-guide-headline").props.children, guide.headline);
    assert.equal(video.find("daily-video-guide-disclosure").props.children, guide.disclosure);
    guide.actions.forEach((_action, index) => assert.ok(video.find(`daily-video-guide-action-${index}`)));
    assert.equal(video.find("daily-video-summary").props.children, "Saved description summary"); assert.equal(video.find("daily-video-webview"), undefined);
    assert.doesNotMatch(video.visible(), /A video title|A private video|Fixture pediatrician|i\.ytimg\.com/);
  } finally { home?.unmount(); video?.unmount(); f.restore(); }
});
test("Home ready checkin opens server session, never ordinary session POST", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); f.responder = (path) => path === "/chat/main/checkin" ? response({ state: "ready", id: "check-A", topic: "Sleep", line: "How was bedtime?", opened: false })
      : path === "/chat/main/checkin/check-A/open" ? response({ session_id: "checkin-session-A" }) : null;
    p = page(f, "home"); p.render(); await tick(); p.render();
    assert.equal(p.find("home-nuri-memo").props.children, "How was bedtime?"); assert.equal(p.find("home-nuri-action-label").props.children, "回复NURI");
    await p.find("home-nuri-card").props.onPress(); assert.deepEqual(p.routes, ["/chat/checkin-session-A"]);
    assert.equal(f.calls.filter((call) => call.path === "/chat/sessions").length, 0);
  } finally { p?.unmount(); f.restore(); }
});
test("failed checkin open never silently creates another chat; retry repeats open", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); let fail = true;
    f.responder = (path) => path === "/chat/main/checkin" ? response({ state: "ready", id: "check-A", line: "Follow up" })
      : path === "/chat/main/checkin/check-A/open" ? response(fail ? {} : { session_id: "checkin-session-A" }, fail ? 503 : 200) : null;
    p = page(f, "home"); p.render(); await tick(); p.render(); await p.find("home-nuri-card").props.onPress(); p.render();
    assert.equal(p.find("home-nuri-action-label").props.children, "Retry"); assert.deepEqual(p.routes, []);
    assert.equal(f.calls.filter((call) => call.path === "/chat/sessions").length, 0);
    fail = false; await p.find("home-nuri-card").props.onPress(); assert.deepEqual(p.routes, ["/chat/checkin-session-A"]);
  } finally { p?.unmount(); f.restore(); }
});
test("pure existing chat stays readable when optional AI checkin is refused", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "home"); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission")); await p.find("home-nuri-card").props.onPress();
    assert.deepEqual(p.routes, ["/chat/existing-A"]); assert.equal(f.calls.filter((call) => call.path === "/chat/sessions").length, 0);
  } finally { p?.unmount(); f.restore(); }
});
test("actual player validators reject schemes, hosts, credentials, IDs and invalid app identity", () => {
  const r = runner(), jsx = (type, props) => ({ type, props });
  const player = load("../src/components/YouTubePlayer.tsx", { react: r.react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { StyleSheet: { create: (x) => x } }, "expo-constants": { default: {} }, "react-native-webview": {}, "@/src/i18n": {} });
  assert.equal(player.youtubeEmbedUrl("../private"), null);
  for (const url of ["http://www.youtube-nocookie.com/embed/ScMzIvxBSi4", "https://www.youtube-nocookie.com.evil.invalid/embed/ScMzIvxBSi4", "https://user:password@www.youtube-nocookie.com/embed/ScMzIvxBSi4", "https://www.youtube-nocookie.com/watch?v=ScMzIvxBSi4", "javascript:alert(1)", "https://www.youtube-nocookie.com/embed/anotherID00", "https://www.youtube-nocookie.com:444/embed/ScMzIvxBSi4"]) assert.equal(player.allowYouTubeNavigation(url, "ScMzIvxBSi4"), false);
  assert.equal(player.youtubeAppReferer("COM.OrdashTech.Nuri.NativeLab"), "https://com.ordashtech.nuri.nativelab");
  assert.equal(player.youtubeAppReferer(undefined), null); assert.equal(player.youtubeAppReferer("https://evil.invalid"), null);
  for (const url of ["http://www.youtube.com/watch?v=ScMzIvxBSi4", "javascript:alert(1)", "file:///private/secret", "data:text/html,hi", "nuri://login", "youtube://watch?v=ScMzIvxBSi4", "https://user:password@www.youtube.com/watch?v=ScMzIvxBSi4", "https://www.youtube.com:444/watch?v=ScMzIvxBSi4", "https://www.youtube.com\\@evil.invalid", "https://localhost/private", "https://host.local/private", "https://sub.localhost/private", "https://host.internal/private", "https://127.0.0.1/private", "https://127.1/private", "https://0x7f000001/private", "https://10.0.0.1/private", "https://169.254.169.254/private", "https://8.8.8.8/private", "https://[::1]/private", "https://[::ffff:127.0.0.1]/private", "https://www.youtube.com/\nwatch"]) assert.equal(player.youtubeExternalUrl(url), null);
  assert.equal(player.isYouTubeServiceUrl("https://www.youtube.com.evil.invalid/watch"), false);
  assert.equal(player.isYouTubeServiceUrl("https://www.youtube.com/watch?v=ScMzIvxBSi4"), true);
  assert.equal(player.isYouTubeServiceUrl("https://policies.google.com/privacy"), true);
  assert.equal(player.youtubeExternalUrl("https://www.youtube-nocookie.com/embed/BaW_jenozKc"), "https://www.youtube.com/watch?v=BaW_jenozKc");
});

test("link dispatch failure is observable and retryable without marking video playback failed", async () => {
  const r = runner(), jsx = (type, props) => ({ type, props }), calls = [];
  let rejectLink = true, tree;
  const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const player = load("../src/components/YouTubePlayer.tsx", { react: r.react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: (x) => x },
      AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
      Linking: { openURL: async (url) => { calls.push(url); if (rejectLink) throw new Error("OS unavailable"); } } },
    "expo-constants": { __esModule: true, default: { expoConfig: { ios: { bundleIdentifier: "com.ordashtech.nuri.nativelab" } } } },
    "react-native-webview": { WebView: "WebView" }, "@/src/i18n": { useT: () => ({ t: (text) => text }) } });
  const render = () => tree = r.render(() => player.default({ videoId: "ScMzIvxBSi4", width: 350, active: true }));
  const find = (id) => nodes(tree).find((node) => node.props?.testID === id);
  try {
    render(); const view = find("daily-video-webview");
    view.props.onOpenWindow({ nativeEvent: { targetUrl: "https://www.youtube.com/watch?v=BaW_jenozKc" } });
    await tick(); render(); assert.ok(find("daily-video-link-retry")); assert.ok(find("daily-video-webview"));
    assert.equal(find("daily-video-player-retry"), undefined);
    rejectLink = false; find("daily-video-link-retry").props.onPress(); await tick(); render();
    assert.equal(find("daily-video-link-retry"), undefined); assert.equal(calls.length, 2);
    assert.equal(await player.openYouTubeLink("javascript:alert(1)"), false); assert.equal(calls.length, 2);
  } finally { r.unmount(); }
});

for (const change of ["blur", "background", "unmount", "video change"]) test("held link dispatch cannot restore failure after " + change, async () => {
  const r = runner(), jsx = (type, props) => ({ type, props }), calls = [], held = deferred();
  const listeners = new Set(); let tree, active = true, videoId = "ScMzIvxBSi4";
  const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const player = load("../src/components/YouTubePlayer.tsx", { react: r.react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: (x) => x },
      AppState: { currentState: "active", addEventListener: (_event, listener) => { listeners.add(listener); return { remove: () => listeners.delete(listener) }; } },
      Linking: { openURL: async (url) => { calls.push(url); if (!(await held.promise)) throw new Error("late OS failure"); } } },
    "expo-constants": { __esModule: true, default: { expoConfig: { ios: { bundleIdentifier: "com.ordashtech.nuri.nativelab" } } } },
    "react-native-webview": { WebView: "WebView" }, "@/src/i18n": { useT: () => ({ t: (text) => text }) } });
  const render = () => tree = r.render(() => player.default({ videoId, width: 350, active }));
  const find = (id) => nodes(tree).find((node) => node.props?.testID === id);
  try {
    render(); const view = find("daily-video-webview"), url = "https://www.youtube.com/watch?v=BaW_jenozKc";
    view.props.onShouldStartLoadWithRequest({ url, navigationType: "click", isTopFrame: true });
    view.props.onOpenWindow({ nativeEvent: { targetUrl: url } });
    assert.equal(calls.length, 1, "duplicate native callbacks dispatch only once while pending");
    if (change === "blur") { active = false; render(); }
    else if (change === "background") { listeners.forEach((listener) => listener("background")); render(); }
    else if (change === "video change") { videoId = "BaW_jenozKc"; render(); }
    else r.unmount();
    view.props.onOpenWindow({ nativeEvent: { targetUrl: "https://www.youtube.com/@YouTube" } });
    assert.equal(calls.length, 1, "a saved callback from a hidden or replaced player cannot dispatch");
    held.resolve(false); await tick();
    if (change !== "unmount") { render(); assert.equal(find("daily-video-link-retry"), undefined); }
    if (change === "video change") assert.ok(find("daily-video-webview").props.source.uri.includes(videoId));
  } finally { held.resolve(false); r.unmount(); }
});

for (const change of ["B", "blur"]) test("video chat held POST cannot navigate after " + change, async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); await f.permit(); p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    f.responder = (path) => path === "/chat/sessions" ? { ...response(null), json: () => held.promise } : null;
    p.find("daily-video-chat").props.onPress(); await tick(); assert.ok(f.calls.some((call) => call.path === "/chat/sessions"));
    if (change === "B") await f.login("B"); else p.blur();
    held.resolve({ id: "late-A-session" }); await tick(); p.render(); assert.deepEqual(p.routes, []);
  } finally { p?.unmount(); f.restore(); }
});

test("held Home checkin body cannot restore an A topic under B or after blur", async () => {
  for (const change of ["B", "blur"]) {
    const f = fixture(), held = deferred(); let p;
    try {
      await f.login("A"); await f.permit(); f.responder = (path) => path === "/chat/main/checkin" ? { ...response(null), json: () => held.promise } : null;
      p = page(f, "home"); p.render(); await tick(); assert.ok(f.calls.some((call) => call.path === "/chat/main/checkin"));
      if (change === "B") await f.login("B"); else p.blur();
      f.responder = () => response({}, 503); p.render(); held.resolve({ state: "ready", id: "old-checkin", topic: "private-old-topic", line: "private-old-topic" });
      await tick(); p.render(); assert.doesNotMatch(p.visible(), /private-old-topic/); assert.deepEqual(p.routes, []);
    } finally { p?.unmount(); f.restore(); }
  }
});

test("actual MessageBubble renders video transition, routes its card, and rejects a saved A tap under B", async () => {
  const f = fixture(), r = runner(), routes = [], jsx = (type, props) => ({ type, props });
  try {
    await f.login("A");
    const source = readFileSync(new URL("../app/chat/[id].tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "MessageBubble");
    const styles = ast.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === "styles"));
    assert.ok(component && styles, "execute the actual component and styles, not a rewritten callback");
    const code = ts.transpileModule(`${component.getText(ast)}\n${styles.getText(ast)}\nmodule.exports = MessageBubble;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const scope = load("../src/useAccountState.ts", { react: r.react, "./api": f });
    const module = { exports: {} };
    new Function("require", "module", "exports", "useT", "useRouter", "useAccountScope", "View", "Text", "Pressable", "Image", "Ionicons", "NuriAvatar", "RichText", "StyleSheet", "colors", "spacing", "radius", "type", "Platform", "shortResourceSummary", code)(
      () => ({ jsx, jsxs: jsx }), module, module.exports, () => ({ t: (value) => value }), () => ({ push: (href) => routes.push(href) }), scope.useAccountScope,
      "View", "Text", "Pressable", "Image", "Icon", "Avatar", "RichText", { create: (value) => value }, {}, {}, {}, {}, { OS: "ios" },
      load("../src/resourceSummary.ts").shortResourceSummary);
    const tree = r.render(() => module.exports({ msg: { id: "marker", role: "ai", text: "PRIVATE_RAW_TRANSITION_TEXT", transition: { kind: "card_opened", video: { id: "video-A", title: "Stored video", thumbnail_url: "https://i.ytimg.com/vi/ScMzIvxBSi4/hqdefault.jpg", channel: "Fixture channel", key_points: ["AI_SEARCH_VIDEO_POINT."], summary: "AI_SEARCH_VIDEO_SUMMARY.", transcript: "PRIVATE_SOURCE_TRANSCRIPT" } } } }));
    const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
    const card = nodes(tree).find((node) => node.props?.testID === "chat-daily-video-card"); assert.ok(card);
    assert.equal(nodes(tree).some((node) => node.props?.testID === "chat-card-divider"), false);
    card.props.onPress(); assert.deepEqual(routes, [{ pathname: "/daily-video", params: { id: "video-A" } }]);
    const summaryFallbackTree = r.render(() => module.exports({ msg: { id: "video-fallback", role: "ai", text: "PRIVATE_RAW_TRANSITION_TEXT", transition: { kind: "card_opened", video: {
      id: "video-A", key_points: [], summary: "AI_CACHED_SUMMARY_WITHOUT_POINTS.", title: "PRIVATE_SOURCE_TITLE", thumbnail_url: "https://private.invalid/thumbnail.jpg",
    } } } }));
    assert.equal(nodes(summaryFallbackTree).find((node) => node.props?.testID === "chat-daily-video-summary").props.children, "AI_CACHED_SUMMARY_WITHOUT_POINTS.",
      "an empty saved key_points array must not hide the usable saved summary");
    assert.doesNotMatch(JSON.stringify(summaryFallbackTree), /PRIVATE_|private\.invalid/);
    const postTree = r.render(() => module.exports({ msg: { id: "post-marker", role: "ai", text: "PRIVATE_RAW_POST_TRANSITION_TEXT", transition: { kind: "card_opened", post: {
      id: "post-A", headline: "AI_SEARCH_POST_HEADLINE.", takeaways: ["AI_SEARCH_POST_POINT_ONE.", "AI_SEARCH_POST_POINT_TWO.", "UNSELECTED_THIRD_POINT."],
      excerpt: "PRIVATE_SOURCE_EXCERPT", body: "PRIVATE_SOURCE_BODY", image_url: "https://private.invalid/image.jpg",
    } } } }));
    assert.ok(nodes(postTree).find((node) => node.props?.testID === "chat-daily-post-card"));
    assert.equal(nodes(postTree).find((node) => node.props?.testID === "chat-daily-post-summary").props.children, "AI_SEARCH_POST_POINT_ONE.\nAI_SEARCH_POST_POINT_TWO.");
    assert.match(JSON.stringify(postTree), /AI_SEARCH_POST_HEADLINE/);
    assert.doesNotMatch(JSON.stringify(postTree), /PRIVATE_|private\.invalid|UNSELECTED_THIRD_POINT/);
    const ownTree = r.render(() => module.exports({ msg: { id: "my-photo", role: "user", text: "OWN_FAMILY_MESSAGE", image_base64: "data:image/png;base64,OWN_IMAGE" } }));
    assert.match(JSON.stringify(ownTree), /OWN_FAMILY_MESSAGE/);
    assert.equal(nodes(ownTree).find((node) => node.type === "Image").props.source.uri, "data:image/png;base64,OWN_IMAGE",
      "resource preview boundaries do not suppress a user's own photo and message");
    await f.login("B"); card.props.onPress(); assert.equal(routes.length, 1);
    const thumbnail = nodes(tree).find((node) => node.props?.testID === "chat-daily-video-thumbnail");
    assert.equal(thumbnail, undefined, "chat does not copy the video's thumbnail");
    assert.ok(JSON.stringify(nodes(tree).find((node) => node.props?.testID === "chat-daily-video-source").props.children).includes("YouTube"));
    assert.equal(nodes(tree).find((node) => node.props?.testID === "chat-daily-video-guide-label"), undefined);
    assert.equal(nodes(tree).find((node) => node.props?.testID === "chat-daily-video-summary").props.children, "AI_SEARCH_VIDEO_POINT.");
    assert.doesNotMatch(JSON.stringify(tree), /Stored video|Fixture channel|ytimg\.com|PRIVATE_/);
    assert.equal(nodes(tree).some((node) => node.type === "Icon" && node.props.name === "play"), false);
  } finally { r.unmount(); f.restore(); }
});

for (const kind of ["post", "video"]) test("Home " + kind + " repeated pending polls are bounded at 12 and stop after settled results", async () => {
  const f = fixture(), clock = pollClock(); let p;
  try {
    await f.login("A"); await f.permit(); const prefix = "/feed/daily-" + kind;
    f.responder = (path, init) => path.startsWith(prefix) && init.method !== "POST" ? response({ state: "pending", card: null }) : null;
    p = page(f, "home"); p.render(); await tick(); p.render();
    assert.equal(clock.count(), 1);
    for (let poll = 0; poll < 12; poll++) { await clock.fire(); await tick(); p.render(); }
    p.render(); // Commit the terminal state set by the limit-checking effect.
    assert.equal(f.calls.filter((call) => call.path.startsWith(prefix)).length, 13, "initial read plus exactly 12 retries");
    assert.equal(clock.count(), 0, "limit cannot leave another scheduled timer");
    assert.ok(p.find("home-daily-" + kind + "-empty")); assert.equal(p.find("home-daily-" + kind + "-loading"), undefined);
    p.render(); assert.equal(clock.count(), 0);
  } finally { p?.unmount(); clock.restore(); f.restore(); }
});

test("video pending → pending → ready advances the actual timer cycle and stops polling", async () => {
  const f = fixture(), clock = pollClock(); let p, reads = 0;
  try {
    await f.login("A"); await f.permit();
    f.responder = (path, init) => path.startsWith("/feed/daily-video") && init.method !== "POST"
      ? response(++reads < 3 ? { state: "pending", card: null } : { state: "ready", card: videoCard("A") }) : null;
    p = page(f, "home"); p.render(); await tick(); p.render();
    await clock.fire(); await tick(); p.render(); assert.equal(reads, 2); assert.equal(clock.count(), 1);
    await clock.fire(); await tick(); p.render(); assert.equal(reads, 3); assert.equal(clock.count(), 0); assert.ok(p.find("home-daily-video-card"));
  } finally { p?.unmount(); clock.restore(); f.restore(); }
});

test("an in-flight pending poll finishing after blur cannot re-arm its timer", async () => {
  const f = fixture(), clock = pollClock(), held = deferred(); let p, reads = 0;
  try {
    await f.login("A"); await f.permit();
    f.responder = (path) => path.startsWith("/feed/daily-video") ? (++reads === 1 ? response({ state: "pending", card: null }) : { ...response(null), json: () => held.promise }) : null;
    p = page(f, "home"); p.render(); await tick(); p.render(); const pending = clock.fire(); await tick();
    assert.equal(reads, 2); p.blur(); held.resolve({ state: "pending", card: null }); await pending; p.render();
    assert.equal(clock.count(), 0); assert.equal(reads, 2);
  } finally { held.resolve({}); p?.unmount(); clock.restore(); f.restore(); }
});

test("external YouTube launch failure is visible and retryable without a player or extra content fetch", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    const reads = f.calls.filter((call) => call.path === "/feed/daily-video/video-A").length;
    f.externalOpen = async () => { throw new Error("OS cannot open YouTube"); };
    p.find("daily-video-source").props.onPress(); await tick(); p.render();
    assert.ok(p.find("daily-video-source-error")); assert.ok(p.find("daily-video-external-title"));
    assert.equal(p.find("daily-video-source").props.disabled, false);
    assert.equal(p.kind("WebView"), undefined); assert.equal(p.find("daily-video-player-retry"), undefined);
    f.externalOpen = null; p.find("daily-video-source").props.onPress(); await tick(); p.render();
    assert.equal(p.find("daily-video-source-error"), undefined); assert.equal(p.external.length, 2);
    assert.equal(f.calls.filter((call) => call.path === "/feed/daily-video/video-A").length, reads);
    assert.equal(f.calls.filter((call) => call.path.endsWith("/summary")).length, 0);
  } finally { p?.unmount(); f.restore(); }
});

for (const change of ["B", "blur", "unmount"]) test("held source launch cannot restore failure or dispatch a saved callback after " + change, async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    f.externalOpen = async () => { if (!(await held.promise)) throw new Error("late OS failure"); };
    const action = p.find("daily-video-source").props.onPress;
    action(); action(); await tick(); p.render();
    assert.equal(p.external.length, 1, "sourceBusy guards duplicate presses even before rerender");
    assert.equal(p.find("daily-video-source").props.disabled, true);
    if (change === "B") { await f.login("B"); p.render(); } else p[change]();
    action(); assert.equal(p.external.length, 1, "old callback must not dispatch for another account or hidden page");
    held.resolve(false); await tick();
    if (change !== "unmount") p.render();
    assert.equal(p.find("daily-video-source-error"), undefined);
  } finally { held.resolve(false); p?.unmount(); f.restore(); }
});

for (const video_id of ["../private", "javascript:alert(1)", "ScMzIvxBSi4?token=secret", "", "not-an-id"]) test("link screen rejects backend video ID " + JSON.stringify(video_id), async () => {
  const f = fixture(); let p;
  try {
    await f.login("A");
    f.responder = (path) => path === "/feed/daily-video/video-A" ? response({ state: "ready", card: { ...videoCard("A"), video_id } }) : null;
    p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    assert.equal(p.find("daily-video-source"), undefined); assert.ok(p.find("daily-video-load-retry"));
    assert.deepEqual(p.external, []); assert.equal(p.kind("WebView"), undefined);
  } finally { p?.unmount(); f.restore(); }
});
