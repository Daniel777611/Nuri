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
test("stored video is readable without AI permission; controlled in-app player stops on background/blur", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    assert.ok(p.find("daily-video-webview")); assert.ok(p.find("daily-video-summary"));
    assert.equal(f.calls.filter((call) => call.path.endsWith("/summary") || call.path === "/chat/sessions").length, 0);
    const player = p.find("daily-video-webview");
    assert.equal(player.props.source.uri, "https://www.youtube-nocookie.com/embed/ScMzIvxBSi4?playsinline=1&rel=0&autoplay=0");
    assert.deepEqual(player.props.source.headers, { Referer: "https://com.ordashtech.nuri.nativelab" });
    assert.equal(player.props.sharedCookiesEnabled, false); assert.equal(player.props.incognito, true);
    assert.deepEqual(player.props.originWhitelist, ["*"], "custom policy must run before WebView's automatic external-Linking fallback");
    assert.equal(player.props.allowsInlineMediaPlayback, true); assert.equal(player.props.mediaPlaybackRequiresUserAction, true);
    assert.equal(player.props.onShouldStartLoadWithRequest({ url: "https://evil.invalid/?token=A" }), false);
    assert.equal(player.props.onShouldStartLoadWithRequest({ url: "nuri://login" }), false);
    assert.equal(player.props.onShouldStartLoadWithRequest({ url: player.props.source.uri }), true);
    assert.doesNotMatch(JSON.stringify(player.props.source), /Bearer|account-A/);
    p.appState("background"); p.render(); assert.equal(p.find("daily-video-webview"), undefined);
    p.appState("active"); p.render(); assert.ok(p.find("daily-video-webview"));
    p.blur(); p.render(); assert.equal(p.find("daily-video-webview"), undefined);
  } finally { p?.unmount(); f.restore(); }
});
test("missing summary needs consent, retains player, grant/refocus retries real summary", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? response({ state: "ready", card: { ...videoCard("A"), summary: "" } }) : null;
    p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission")); assert.ok(p.find("daily-video-webview"));
    assert.equal(f.calls.filter((call) => call.path.endsWith("/summary")).length, 0);
    p.find("request-failure-action").props.onPress(); assert.deepEqual(p.routes, [{ pathname: "/ai-permission", params: { returnTo: "/daily-video" } }]);
    p.blur(); await f.permit(); p.focus(); await tick(); p.render();
    assert.match(p.find("daily-video-summary").props.children, /summary from title and description/);
  } finally { p?.unmount(); f.restore(); }
});
for (const [status, failure] of [[401, "session"], [503, "service"]]) test("video load " + status + " selects accurate action, not permanent spinner", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/feed/daily-video/video-A" ? response({}, status) : null;
    p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-" + failure)); assert.equal(p.kind("ActivityIndicator"), undefined);
    f.responder = null; p.find("request-failure-action").props.onPress(); p.render(); await tick(); p.render();
    if (status === 401) assert.deepEqual(p.routes, ["/login"]); else assert.ok(p.find("daily-video-title"));
  } finally { p?.unmount(); f.restore(); }
});
test("video chat denial retains card; service retry repeats original POST", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    p.find("daily-video-chat").props.onPress(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission")); assert.ok(p.find("daily-video-title"));
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
    if (change !== "unmount") p.render(); assert.doesNotMatch(p.visible(), /stale-private-video/); assert.deepEqual(p.routes, []);
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
    new Function("require", "module", "exports", "useT", "useRouter", "useAccountScope", "View", "Text", "Pressable", "Image", "Ionicons", "NuriAvatar", "RichText", "StyleSheet", "colors", "spacing", "radius", "type", "Platform", code)(
      () => ({ jsx, jsxs: jsx }), module, module.exports, () => ({ t: (value) => value }), () => ({ push: (href) => routes.push(href) }), scope.useAccountScope,
      "View", "Text", "Pressable", "Image", "Icon", "Avatar", "RichText", { create: (value) => value }, {}, {}, {}, {}, { OS: "ios" });
    const tree = r.render(() => module.exports({ msg: { id: "marker", role: "ai", text: "", transition: { kind: "card_opened", video: { id: "video-A", title: "Stored video", thumbnail_url: "https://i.ytimg.com/vi/ScMzIvxBSi4/hqdefault.jpg", channel: "Fixture channel" } } } }));
    const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
    const card = nodes(tree).find((node) => node.props?.testID === "chat-daily-video-card"); assert.ok(card);
    assert.equal(nodes(tree).some((node) => node.props?.testID === "chat-card-divider"), false);
    card.props.onPress(); assert.deepEqual(routes, [{ pathname: "/daily-video", params: { id: "video-A" } }]);
    await f.login("B"); card.props.onPress(); assert.equal(routes.length, 1);
    const thumbnail = nodes(tree).find((node) => node.type === "Image"); assert.equal(thumbnail.props.contentFit, "cover");
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

test("WK process termination shows visible manual retry and never auto-reloads in a loop", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "video", { id: "video-A" }); p.render(); await tick(); p.render();
    p.find("daily-video-webview").props.onContentProcessDidTerminate({ nativeEvent: {} }); p.render();
    assert.ok(p.find("daily-video-player-retry")); assert.equal(p.find("daily-video-webview"), undefined);
    p.render(); assert.ok(p.find("daily-video-player-retry")); assert.equal(p.find("daily-video-webview"), undefined);
    p.find("daily-video-player-retry").props.onPress(); p.render(); assert.ok(p.find("daily-video-webview"));
    assert.equal(p.find("daily-video-player-retry"), undefined);
  } finally { p?.unmount(); f.restore(); }
});
