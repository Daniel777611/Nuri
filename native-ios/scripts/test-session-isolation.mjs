import {translate as _translateForI18nFixture} from './i18n-test-utils.mjs';
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function load(path, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    if (name.startsWith("@/assets/") || name.endsWith(".png")) return "fixture-image";
    assert.ok(name in dependencies, "unexpected dependency " + name);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });

function fixture(nativeXHR = false) {
  const originalFetch = globalThis.fetch;
  const secure = new Map(), ordinary = new Map(), calls = [];
  let ordinaryBarrier = null, removeFails = false;
  const storage = {
    secureGet: async (key, fallback) => secure.get(key) ?? fallback,
    secureSet: async (key, value) => { secure.set(key, value); return true; },
    secureRemove: async (key) => { if (removeFails) return false; secure.delete(key); return true; },
    getItem: async (key, fallback) => ordinary.get(key) ?? fallback,
    setItem: async (key, value) => { if (ordinaryBarrier) await ordinaryBarrier.promise; ordinary.set(key, value); return true; },
    removeItem: async (key) => { ordinary.delete(key); return true; },
  };
  const boundary = load("../src/sessionBoundary.ts");
  const originalResponse = globalThis.Response;
  if (nativeXHR) globalThis.Response = class { constructor() { throw new Error("native streaming capability"); } };
  const client = load("../src/api.ts", { "./theme": { API: "https://session-test.invalid/api" }, "./preview-api": { isPreviewMode: false }, "./utils/storage": { storage }, "./aiConsent": load("../src/aiConsent.ts"), "./sessionBoundary": boundary });
  globalThis.Response = originalResponse;
  const f = { ...client, boundary, secure, ordinary, calls, responder: null,
    ordinaryBarrier: (value) => { ordinaryBarrier = value; }, failRemove: (value) => { removeFails = value; },
    restore: () => { globalThis.fetch = originalFetch; },
    async login(owner) { await client.auth.setToken("account-" + owner); },
    async permit() { await client.aiConsent.refresh(); await client.aiConsent.setAllowed(true, client.aiConsent.getState()); },
  };
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(url.startsWith("https://session-test.invalid/"), "no real host is allowed");
    const path = url.replace("https://session-test.invalid/api", "");
    const owner = init.headers?.Authorization?.replace("Bearer account-", "") || "none";
    calls.push({ path, owner, init });
    const custom = f.responder && await f.responder(path, init, owner);
    if (custom) return custom;
    if (path === "/auth/me") return response({ id: "user-" + owner, nickname: owner + "-private-parent", onboarding_completed: true });
    if (path === "/children") return response([{ id: "child-" + owner, nickname: owner + "-private-child", birth_date: "2022-01-01" }]);
    if (path === "/favorites") return response([{ id: "favorite-" + owner, title: owner + "-private-favorite" }]);
    if (path === "/privacy") return response({ daily_push: true, allow_history_training: true, allow_external_content_research: false, language: "en" });
    if (path === "/notifications/preferences") return response({enabled:true,reminders_enabled:true,chat_enabled:true,care_enabled:true,quiet_hours_start:"22:00",quiet_hours_end:"08:00",time_zone:"UTC",max_per_day:4,show_preview:false});
    if (path.startsWith("/tasks")) return response([{ id: "task-" + owner, title: owner + "-private-task", created_at: "2030-01-01", completed_count: 0, total_count: 1, task_type: "care" }]);
    if (path === "/chat/main/preview") return response({ has_conversation: true, session_id: "chat-" + owner, last_user_message: { text: owner + "-private-message" }, memory_preview: { text: owner + "-private-memory" } });
    if (path.startsWith("/feed/daily-post")) return response({ state: "ready", card: { id: "daily-" + owner, headline: owner + "-private-daily", excerpt: "post", source_url: "https://source.invalid/post", basis: "conversation" } });
    if (path === "/chat/sessions") return response({ id: "chat-" + owner });
    if (path === "/billing/status") return response({ entitled: true, enabled: true, plans: [], has_customer: true, subscription: null });
    return response({ ok: true, active: true, account_deleted: true });
  };
  return f;
}

// Execute the actual hooks and component callbacks. Effects/closures persist
// across renders, and queued React updater execution can be deliberately held.
function runner() {
  const slots = [], effects = [], updates = [];
  let cursor = 0, pending = [], holdUpdates = false;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const n = cursor++;
      if (!slots[n]) slots[n] = { value: typeof initial === "function" ? initial() : initial };
      slots[n].set ||= (next) => { const apply = () => { slots[n].value = typeof next === "function" ? next(slots[n].value) : next; }; if (holdUpdates) updates.push(apply); else apply(); };
      return [slots[n].value, slots[n].set];
    },
    useRef(initial) { const n = cursor++; return slots[n] ||= { current: initial }; },
    useCallback(fn, deps) { const n = cursor++; if (!slots[n] || !same(slots[n].deps, deps)) slots[n] = { fn, deps }; return slots[n].fn; },
    useEffect(fn, deps) { const n = cursor++; if (!effects[n] || !same(effects[n].deps, deps)) pending.push(() => { effects[n]?.cleanup?.(); effects[n] = { deps, cleanup: fn() }; }); },
    useSyncExternalStore(_subscribe, snapshot) { cursor++; return snapshot(); },
  };
  return { react, render(fn) { cursor = 0; pending = []; const value = fn(); pending.forEach((run) => run()); return value; }, unmount() { effects.forEach((effect) => effect?.cleanup?.()); }, hold(value) { holdUpdates = value; }, flush() { updates.splice(0).forEach((apply) => apply()); } };
}
function page(path, f, options = {}) {
  const r = runner(), routes = [], localeWrites = [];
  let pageLocale=options.locale??"en";
  const t = (key) => key;
  const setLocale = async (value) => { localeWrites.push(value); if (options.localeBarrier) await options.localeBarrier.promise; if(options.failLocale===value)throw Error("fixture storage failed");pageLocale=value; };
  const router = { push: (value) => routes.push(value), replace: (value) => routes.push(value), dismissTo: (value) => routes.push(value), back: () => routes.push("back"), canGoBack: () => false };
  const jsx = (type, props) => ({ type, props });
  const hooks = load("../src/useAccountState.ts", { react: r.react, "./api": f });
  const dep = {
    react: r.react, "react/jsx-runtime": { jsx, jsxs: jsx }, "@/src/useAccountState": hooks,
    "@/src/api": f, "@/src/sessionBoundary": f.boundary,
    "@/src/requestFailure": load("../src/requestFailure.ts"),
    "@/src/collectionActions": load("../src/collectionActions.ts"),
    "@/src/aiPermissionNavigation": load("../src/aiPermissionNavigation.ts"),
    "@/src/theme": { colors: {}, radius: {}, spacing: {}, type: {} },
    "expo-router": { useRouter: () => router, useLocalSearchParams: () => options.params || {}, useFocusEffect: (fn) => r.react.useEffect(fn, [fn]), Redirect: "Redirect", Stack: { Screen: "Screen" } },
    "react-native": { View: "View", Text: "Text", Image: "Image", TextInput: "Input", Pressable: "Pressable", Switch: "Switch", ScrollView: "ScrollView", KeyboardAvoidingView: "KeyboardAvoidingView", ActivityIndicator: "ActivityIndicator", FlatList: "FlatList", Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove() {} }) }, Linking: { openURL: async () => {} }, StyleSheet: { create: (value) => value, absoluteFill: {} }, useWindowDimensions: () => ({ width: 402 }) },
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@expo/vector-icons": { Ionicons: "Icon" }, "expo-linear-gradient": { LinearGradient: "Gradient" }, "expo-blur": { BlurView: "Blur" },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0, top: 0 }) },
    "@react-navigation/native": { useIsFocused: () => true }, "@react-navigation/elements": { useHeaderHeight: () => 44 },
    "@/src/i18n": {translate:_translateForI18nFixture, useT: () => ({ t:options.realI18n?(key,vars)=>_translateForI18nFixture(pageLocale,key,vars):t, locale: pageLocale, setLocale }), LOCALES: ["en", "zh-CN", "zh-TW"], LOCALE_LABELS: { en: "English", "zh-CN": "简体中文", "zh-TW":"繁體中文" } },
    "@/src/nativeShell": { usePurchaseAllowed: () => false, isNativeShell: () => true, useOnReturnToApp: () => {} },
    "@/src/nativePush": { getReminderSettings: async () => ({ enabled: false, intervalSeconds: 30 }), MAX_LOCAL_REMINDER_INTERVAL_SECONDS: 31536000, openNotificationSettings: async () => {}, requestNotificationPermission: async () => {}, setReminderSettings: async () => {} },
    "@/src/child-age": load("../src/child-age.ts"), "@/src/taskMeta": load("../src/taskMeta.ts"),
    "@/src/components/notificationCopy": load("../src/components/notificationCopy.ts"), "@/src/components/reminderInterval": load("../src/components/reminderInterval.ts"),
    "@/src/authFlow": { savePendingVerification: async () => {}, cleanCode: (value) => value, useCountdown: () => 0, authErrorMessage: () => "error" },
    "@/src/nativePushRuntime": { safeNotificationRoute: () => null },
    // Presentation-only UIUX48 components remain shallow in this callback/
    // ownership harness. All existing session assertions execute unchanged.
    "@/src/uiux48/Primitives": Object.fromEntries(["AuthFrame","NuriKeyboardFrame","FormTabs","NuriField","NuriText","NuriButton","ChoiceChip","GlassSurface","IconAction","NuriIcon","CenteredCard","CardList","MenuRow","ToggleRow","InlineState"].map(name=>[name,name])),
    "@/src/uiux48/Theme": { useNuriTheme:()=>({mode:"Morning",ink:"#3D3340",secondary:"#5D5060",token:()=>""}) },
    "@/src/uiux48/Scene": { NuriAvatar:"NuriAvatar" },
    "@/src/uiux48/Composer": { NuriComposer:"NuriComposer" },
    "@/src/uiux48/StateCard": {StateCard:"StateCard"},
    "@/src/uiux48/MediaPanel": {MediaPanel:"MediaPanel"},
    "@/src/uiux48/chatDraft": load("../src/uiux48/chatDraft.ts",{"@/src/api":f}),
    "@/src/components/nativeNavigation":{requestGuardedNativeNavigation:()=>false},
    "@/src/nuriResourceGuide":load("../src/nuriResourceGuide.ts"),
    "@/src/resourceSummary":load("../src/resourceSummary.ts"),
    "../chat/[id]": {default:"ChatConversation",__esModule:true},
  };
  for (const name of ["Toast", "CheckinSheet", "ConfirmDialog", "TaskCard", "DailyPostCard", "DailyVideoCard", "RequestFailureNotice", "GoogleSignInButton"]) dep["@/src/components/" + name] = { default: name, __esModule: true };
  const component = load(path, dep)[options.exportName ?? (path.endsWith("/tasks.tsx") ? "LegacyTasks" : "default")];
  let tree;
  function expand(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === "function") return expand(node.type(node.props));
    if (node.type === "FlatList") return { ...node, props: { ...node.props, children: node.props.data.map((item, index) => expand(node.props.renderItem({ item, index }))) } };
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  }
  const render = () => { tree = r.render(() => expand(component())); return tree; };
  const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap((child) => nodes(child)) : [node, ...nodes(node.props?.children)];
  return { ...r, routes, localeWrites, hooks, render, nodes: () => nodes(tree), find: (id) => nodes(tree).find((node) => node.props?.testID === id), kind: (type) => nodes(tree).find((node) => node.type === type), visible: () => JSON.stringify(tree) };
}

test("actual language screen exposes all three choices and persists zh-TW through the existing privacy API",async()=>{
 const f=fixture();let p;
 try{
  await f.login("A");await f.permit();p=page("../app/(tabs)/profile.tsx",f,{params:{section:"language"},realI18n:true});
  p.render();await tick();await tick();p.render();
  for(const locale of ["zh-CN","zh-TW","en"])assert.ok(p.find("profile-language-"+locale));
  assert.equal(p.find("profile-language-zh-TW").props.label,"繁體中文");
  const before=f.calls.filter(c=>c.path==="/privacy"&&c.init.method&&c.init.method!=="GET").length;
  assert.equal(before,0,"Rendering the language page must not mutate preferences");
  await p.find("profile-language-zh-TW").props.onPress();await tick();p.render();
  const calls=f.calls.filter(c=>c.path==="/privacy"&&c.init.method&&c.init.method!=="GET");
  assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].init.body).language,"zh-TW");
  assert.deepEqual(p.localeWrites,["zh-TW"]);assert.equal(p.find("profile-saved-card").props.message,"變更已儲存。");
 }finally{p?.unmount();f.restore();}
});
test("failed Traditional preference/local-storage saves never show success or leave the language mutation locked",async()=>{
 for(const failure of ["server","storage"]){const f=fixture();let p;try{
  await f.login("A");await f.permit();if(failure==="server")f.responder=(path,init)=>path==="/privacy"&&init.method?response({detail:"fixture offline"},503):null;
  p=page("../app/(tabs)/profile.tsx",f,{params:{section:"language"},realI18n:true,failLocale:failure==="storage"?"zh-TW":undefined});
  p.render();await tick();await tick();p.render();await p.find("profile-language-zh-TW").props.onPress();await tick();p.render();
  assert.equal(p.find("profile-saved-card"),undefined);assert.ok(p.find("profile-action-result"));
  if(failure==="storage")assert.equal(f.calls.filter(c=>c.path==="/privacy"&&c.init.method).length,0);
  assert.deepEqual(p.localeWrites,["zh-TW","en"]);
  await p.find("profile-language-zh-CN").props.onPress();await tick();assert.ok(p.localeWrites.includes("zh-CN"));
 }finally{p?.unmount();f.restore();}}
});
test("language is available without AI permission, with no cloud write or false sync receipt",async()=>{
 const f=fixture();let p;
 try{
  await f.login("A");p=page("../app/(tabs)/profile.tsx",f,{params:{section:"language"},realI18n:true});
  p.render();await tick();await tick();p.render();
  await p.find("profile-language-zh-TW").props.onPress();await tick();p.render();
  assert.deepEqual(p.localeWrites,["zh-TW"]);
  assert.equal(p.find("profile-saved-card"),undefined);
  assert.ok(p.find("profile-language-local-card"));
  assert.match(p.find("profile-language-local-card").props.message,/雲端語言尚未同步/);
  assert.equal(f.calls.filter(c=>c.path==="/privacy"&&c.init.method&&c.init.method!=="GET").length,0);
  assert.notEqual(f.aiConsent.getState().status,"allowed");
 }finally{p?.unmount();f.restore();}
});
for (const change of ["B", "logout", "ABA"]) {
  test("actual API parsed JSON held for A → " + change + " is not an auth error or data result", async () => {
    const f = fixture();
    try {
      await f.login("A"); const body = deferred();
      f.responder = (path) => path === "/children" ? { ...response(null), json: () => body.promise } : null;
      const pending = f.api.listChildren(); const rejected = assert.rejects(pending, (error) => error.sessionChanged && !f.isAuthError(error)); await tick();
      if (change === "logout") await f.auth.clearToken({ forceLocal: true }); else { await f.login("B"); if (change === "ABA") await f.login("A"); }
      body.resolve([{ nickname: "old-A" }]); await rejected;
    } finally { f.restore(); }
  });
}
for (const failure of ["401 body", "transport"]) test("late A " + failure + " cannot reject B as expired", async () => {
  const f = fixture();
  try {
    await f.login("A"); const barrier = deferred();
    f.responder = (path) => path === "/children" ? failure === "transport" ? barrier.promise : { ...response(null, 401), text: () => barrier.promise } : null;
    const rejected = assert.rejects(f.api.listChildren(), (error) => error.sessionChanged && !f.isAuthError(error)); await tick(); await f.login("B");
    if (failure === "transport") barrier.reject(new Error("offline"));
    else barrier.resolve('{"detail":"expired"}');
    await rejected;
    assert.equal(await f.auth.getToken(), "account-B");
  } finally { f.restore(); }
});
test("actual auth queue refuses late login, ABA logout and onboarding writes", async () => {
  const f = fixture();
  try {
    await f.login("A"); const ticket = f.auth.getSessionGeneration(), barrier = deferred(); f.ordinaryBarrier(barrier);
    const block = f.auth.setOnboarded(false); await tick();
    const newer = f.auth.setToken("account-B"); const late = f.auth.setToken("account-A", { expectedGeneration: ticket });
    f.ordinaryBarrier(null); barrier.resolve(); await block; assert.equal(await newer, true); assert.equal(await late, false);
    await f.login("A");
    assert.equal(await f.auth.clearToken({ forceLocal: true, expectedToken: "account-A", expectedGeneration: ticket }), false);
    assert.equal(await f.auth.setOnboarded(true, { expectedToken: "account-A", expectedGeneration: ticket }), false);
    assert.equal(await f.auth.getToken(), "account-A");
  } finally { f.restore(); }
});
test("captured-owner push and confirmed account delete keep A ownership under B", async () => {
  const f = fixture();
  try {
    await f.login("B");
    await f.api.registerPushDevice({ installation_id: "test", token: "device" }, "account-A");
    await f.api.deleteAccount("fixture", "account-A");
    assert.equal(f.calls.at(-1).owner, "A"); assert.equal(f.calls.at(-2).owner, "A"); assert.equal(await f.auth.getToken(), "account-B");
  } finally { f.restore(); }
});
test("actual state hook clears on every epoch, rejects saved setters, queued updaters and unmount", async () => {
  const f = fixture(), r = runner();
  try {
    await f.login("A"); const hooks = load("../src/useAccountState.ts", { react: r.react, "./api": f });
    const render = () => r.render(() => hooks.useAccountState("safe"));
    let [value, writeA] = render(); assert.equal(value, "safe"); writeA("private-A"); assert.equal(render()[0], "private-A");
    r.hold(true); writeA(() => "queued-private-A"); await f.login("B"); r.flush(); r.hold(false);
    assert.equal(render()[0], "safe"); writeA("late-A"); assert.equal(render()[0], "safe");
    await f.login("A"); assert.equal(render()[0], "safe"); const write = render()[1]; r.unmount(); write("unmounted"); assert.equal(render()[0], "safe");
  } finally { f.restore(); }
});
for (const name of ["profile", "index"]) test("actual " + name + " clears visible A data immediately; B failures/late A/ABA cannot restore it", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); p = page("../app/(tabs)/" + name + ".tsx", f); p.render(); await tick(); p.render();
    assert.match(p.visible(), /A-private-/);
    // Keep the same mounted instance: cached A data must vanish before B loads.
    await f.login("B"); p.render(); assert.doesNotMatch(p.visible(), /A-private-/);
    await f.login("A"); await f.permit(); p.render(); await tick(); p.render();
    const late = deferred(); f.responder = (path, _init, owner) => owner === "A" && path !== "/auth/me" ? late.promise : owner === "B" ? response({ detail: "offline" }, 503) : null;
    // Refocus/mount starts real A requests, then replace while bodies are held.
    p.unmount(); p = page("../app/(tabs)/" + name + ".tsx", f); p.render(); await tick();
    await f.login("B"); p.render(); assert.doesNotMatch(p.visible(), /A-private-/); await tick(); p.render();
    late.resolve(response([{ nickname: "A-private-late", title: "A-private-late" }])); await tick(); p.render(); assert.doesNotMatch(p.visible(), /A-private-/);
    const oldHandler = p.find("home-nuri-card")?.props.onPress || p.find("profile-logout-btn")?.props.onPress;
    await f.login("A"); p.render(); if (oldHandler) await oldHandler(); assert.deepEqual(p.routes, []);
  } finally { p?.unmount(); f.restore(); }
});
test("deprecated Tasks route redirects to Home without loading or mutating tasks",async()=>{
 const f=fixture();let p;
 try{await f.login("A");p=page("../app/(tabs)/tasks.tsx",f,{exportName:"default"});p.render();assert.equal(p.kind("Redirect").props.href,"/(tabs)");assert.equal(f.calls.length,0);}
 finally{p?.unmount();f.restore();}
});
test("actual Profile language barrier cannot PUT A preferences with B JWT", async () => {
  const f = fixture(), barrier = deferred(); let p;
  try {
    await f.login("A"); await f.permit(); p = page("../app/(tabs)/profile.tsx", f, { localeBarrier: barrier, params:{section:"language"} }); p.render(); await tick(); p.render();
    const pending = p.find("profile-language-zh-CN").props.onPress(); await tick(); await f.login("B"); p.render(); barrier.resolve(); await pending; await tick();
    assert.equal(f.calls.filter((call) => call.path === "/privacy" && call.init.method === "PUT").length, 0);
  } finally { p?.unmount(); f.restore(); }
});
test("actual Profile wipe late A outcome never clears B or navigates login", async () => {
  const f = fixture(), barrier = deferred(); let p;
  try {
    await f.login("A"); p = page("../app/(tabs)/profile.tsx", f); p.render(); await tick(); p.render();
    f.responder = (path) => path === "/privacy/wipe" ? barrier.promise : null;
    const pending = p.kind("ConfirmDialog").props.onConfirm(); await tick(); await f.login("B"); p.render(); barrier.resolve(response({ ok: true })); await pending;
    assert.equal(await f.auth.getToken(), "account-B"); assert.deepEqual(p.routes, []);
  } finally { p?.unmount(); f.restore(); }
});
test("actual Profile cloud-data removal is event-only and confirmed success exposes cleared choices without silent sign-out", async () => {
  const f=fixture();let p;
  try{
    await f.login("A");p=page("../app/(tabs)/profile.tsx",f,{params:{section:"privacy"}});p.render();await tick();p.render();
    assert.equal(f.calls.filter(c=>c.path==="/privacy/wipe").length,0);
    f.responder=path=>path==="/privacy/wipe"?response({ok:true}):null;
    const pending=p.kind("ConfirmDialog").props.onConfirm();await pending;p.render();
    assert.equal(f.calls.filter(c=>c.path==="/privacy/wipe").length,1);assert.ok(p.find("profile-cleared-card"));assert.equal(await f.auth.getToken(),"account-A");assert.deepEqual(p.routes,[]);
  }finally{p?.unmount();f.restore();}
});
test("actual Profile rejects an unconfirmed cloud-data response instead of showing cleared", async () => {
  const f=fixture();let p;
  try{await f.login("A");p=page("../app/(tabs)/profile.tsx",f,{params:{section:"privacy"}});p.render();await tick();p.render();f.responder=path=>path==="/privacy/wipe"?response({}):null;await p.kind("ConfirmDialog").props.onConfirm();p.render();assert.equal(p.find("profile-cleared-card"),undefined);assert.equal(await f.auth.getToken(),"account-A");assert.deepEqual(p.routes,[]);}finally{p?.unmount();f.restore();}
});
test("actual Profile strict logout failure restores A and real Keychain retry survives epoch changes", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.ordinary.set(f.PUSH_INSTALLATION_KEY, "installation");
    f.responder = (path) => path.startsWith("/mobile/push-devices") ? response({}, 503) : null;
    p = page("../app/(tabs)/profile.tsx", f, {params:{section:"account"}}); p.render(); await tick(); p.render();
    p.find("profile-logout-btn").props.onPress(); await tick(); p.render(); await tick(); p.render();
    assert.equal(await f.auth.getToken(),"account-A","opening confirmation does not sign out");p.find("profile-logout-card").props.primary.onPress();await tick();p.render();await tick();p.render();
    assert.equal(await f.auth.getToken(), "account-A"); assert.ok(p.find("profile-logout-card").props.error); assert.ok(p.find("profile-force-local-logout"));
    f.failRemove(true); p.find("profile-force-local-logout").props.onPress(); await tick(); p.render(); await tick(); p.render();
    assert.equal(await f.auth.getToken(), null); assert.ok(p.find("profile-logout-card").props.error);
    f.failRemove(false); p.find("profile-logout-card").props.primary.onPress(); await tick(); p.render(); await tick();
    assert.deepEqual(p.routes, ["/login"]);
  } finally { p?.unmount(); f.restore(); }
});
test("actual Home late canonical-session result cannot navigate B or an unmounted screen", async () => {
  for (const unmount of [false, true]) {
    const f = fixture(), barrier = deferred(); let p;
    try {
      await f.login("A"); await f.permit(); p = page("../app/(tabs)/index.tsx", f); p.render(); await tick(); p.render();
      f.responder = (path) => path === "/chat/main/preview" ? response({ has_conversation: false, session_id: null })
        : path === "/chat/sessions" ? barrier.promise : null;
      const pending = p.find("home-nuri-action").props.onPress(); await tick();
      assert.ok(f.calls.some((call) => call.path === "/chat/sessions" && call.init.method === "POST"), "canonical creation must reach the held request");
      if (unmount) p.unmount(); else { await f.login("B"); p.render(); }
      barrier.resolve(response({ id: "A-private-chat" })); await pending; assert.deepEqual(p.routes, []);
    } finally { p?.unmount(); f.restore(); }
  }
});
test("retired task list/detail cannot display cached A data or send requests across A/B/ABA", async () => {
  for(const path of ["../app/(tabs)/tasks.tsx","../app/task/[id].tsx"]){
    const f=fixture();let p;
    try{
      await f.login("A");p=page(path,f,{exportName:"default"});
      for(const owner of ["A","B","A"]){await f.login(owner);p.render();await tick();p.render();assert.equal(p.kind("Redirect").props.href,"/(tabs)");assert.equal(p.kind("TaskCard"),undefined);assert.equal(p.kind("CheckinSheet"),undefined);assert.doesNotMatch(p.visible(),/private-/);assert.equal(f.calls.length,0);}
    }finally{p?.unmount();f.restore();}
  }
});
test("actual notification preference two-step operation never sends the second write under B", async () => {
  const f = fixture(), barrier = deferred(); let p;
  try {
    await f.login("A"); p = page("../app/notification-settings.tsx", f); p.render(); await tick(); p.render();
    f.responder = (path, _init, owner) => path === "/privacy" ? owner === "A" ? barrier.promise : response({}, 503) : null;
    p.find("remote-daily-push-toggle").props.onChange(false); p.render();
    const pending=p.find("notification-settings-save").props.onPress();
    await tick(); await f.login("B"); p.render(); barrier.resolve(response({ daily_push: true })); await pending; await tick(); p.render();
    assert.equal(f.calls.filter((call) => call.init.method === "PUT").length, 0); assert.equal(p.find("remote-daily-push-toggle").props.value, false);
  } finally { p?.unmount(); f.restore(); }
});
test("notification save shows an explicit shared success card only after confirmed preferences",async()=>{
 const f=fixture();let p;
 try{await f.login("A");p=page("../app/notification-settings.tsx",f);p.render();await tick();p.render();
  assert.equal(p.find("notification-settings-saved"),undefined);
  p.find("notification-settings-save").props.onPress();await tick();p.render();
  assert.equal(p.find("notification-settings-saved").props.title,"Settings saved");
  assert.match(p.find("notification-settings-saved").props.note,/does not mean a test reminder was sent/);
  p.find("notification-settings-saved").props.primary.onPress();p.render();assert.ok(p.find("notification-settings-save"));
 }finally{p?.unmount();f.restore();}
});
for(const outcome of ["empty","conflict","offline"])test("notification "+outcome+" save retains form and never shows saved",async()=>{
 const f=fixture();let p;
 try{await f.login("A");p=page("../app/notification-settings.tsx",f);p.render();await tick();p.render();
  p.find("quiet-hours-start").props.onChangeText("21:15");p.render();
  f.responder=(path,init)=>path==="/notifications/preferences"&&init.method==="PATCH"?response(outcome==="conflict"?{...JSON.parse(init.body),quiet_hours_start:"22:00"}:{},outcome==="offline"?503:200):null;
  p.find("notification-settings-save").props.onPress();await tick();p.render();
  assert.equal(p.find("notification-settings-saved"),undefined);assert.equal(p.find("quiet-hours-start").props.value,"21:15");assert.match(p.find("notification-settings-result").props.children,/not fully confirmed/);
 }finally{p?.unmount();f.restore();}
});
test("notification delayed save cannot show success in a replacement account",async()=>{
 const f=fixture(),barrier=deferred();let p;
 try{await f.login("A");p=page("../app/notification-settings.tsx",f);p.render();await tick();p.render();
  f.responder=(path,init)=>path==="/notifications/preferences"&&init.method==="PATCH"?barrier.promise:null;
  p.find("notification-settings-save").props.onPress();await tick();const body=JSON.parse(f.calls.at(-1).init.body);
  await f.login("B");p.render();barrier.resolve(response(body));await tick();p.render();assert.equal(p.find("notification-settings-saved"),undefined);
 }finally{p?.unmount();f.restore();}
});
test("actual login callback cannot overwrite queued B or navigate after unmount; normal login still works", async () => {
  for (const scenario of ["queued B", "unmount", "normal"]) {
    const f = fixture(), barrier = deferred(), queue = deferred(); let p;
    try {
      p = page("../app/login.tsx", f); p.render(); p.find("login-email").props.onChangeText("fixture@example.invalid"); p.find("login-password").props.onChangeText("fixture"); p.render();
      f.responder = (path) => path === "/auth/login" ? { ...response(null), json: () => barrier.promise } : null;
      const pending = p.find("login-submit-btn").props.onPress(); await tick();
      let block, newer;
      if (scenario === "queued B") { f.ordinaryBarrier(queue); block = f.auth.setOnboarded(false); await tick(); newer = f.auth.setToken("account-B"); }
      if (scenario === "unmount") p.unmount();
      barrier.resolve({ access_token: "account-A", user: { onboarding_completed: true } }); await tick();
      if (block) { f.ordinaryBarrier(null); queue.resolve(); await block; await newer; }
      await pending;
      assert.equal(await f.auth.getToken(), scenario === "queued B" ? "account-B" : scenario === "normal" ? "account-A" : null);
      assert.deepEqual(p.routes, scenario === "normal" ? ["/(tabs)"] : []);
    } finally { p?.unmount(); f.restore(); }
  }
});

test("actual expired-recovery failure belongs to A identity, retains A retry and disappears for B", async () => {
  const f = fixture(), r = runner();
  try {
    await f.login("A"); f.failRemove(true);
    const jsx = (type, props) => ({ type, props });
    const helper = load("../src/authExpiredRecovery.tsx", { react: r.react, "react/jsx-runtime": { jsx, jsxs: jsx }, "./api": f,
      "react-native": { StyleSheet: { create: (value) => value } }, "./components/NativeSafeAreaView": {}, "./i18n": {}, "./nativePush": {} });
    const render = () => r.render(() => helper.useExpiredSessionRecovery());
    const savedA = render(); await savedA.recover({ status: 401 }, "account-A"); assert.equal(render().failureCode, "LOCAL_SIGNOUT_FAILED");
    await render().recover(); assert.equal(render().blocked, true, "same identity keeps a real retry");
    await f.login("B"); assert.equal(render().blocked, false); await savedA.recover(); assert.equal(await f.auth.getToken(), "account-B");
  } finally { r.unmount(); f.restore(); }
});
for (const transport of ["fetch", "XHR"]) test("actual " + transport + " stream rejects stale chunks/final without fallback or 401", async () => {
  const f = fixture(transport === "XHR"), barrier = deferred(), chunks = [];
  const originalXHR = globalThis.XMLHttpRequest; let xhr;
  const delta = 'data: {"type":"delta","text":"before"}\n\n';
  const late = 'data: {"type":"delta","text":"old-A"}\n\ndata: {"type":"done","user_message":{"text":"old-A"},"ai_messages":[]}\n\n';
  try {
    await f.login("A"); await f.permit();
    if (transport === "XHR") globalThis.XMLHttpRequest = class {
      constructor() { xhr = this; this.responseText = ""; this.status = 200; }
      open() {} setRequestHeader() {} send() {} abort() { this.aborted = true; } getResponseHeader() { return "text/event-stream"; }
    };
    else {
      let reads = 0;
      f.responder = (path) => path.includes("/messages/stream") ? { ok: true, status: 200, headers: { get: () => "text/event-stream" }, body: { getReader: () => ({ read: async () => ++reads === 1 ? { value: new TextEncoder().encode(delta), done: false } : reads === 2 ? barrier.promise : { done: true } }) } } : null;
    }
    const pending = f.api.streamMessage("fixture", { text: "fixture" }, (chunk) => chunks.push(chunk));
    const rejected = assert.rejects(pending, (error) => error.sessionChanged && !f.isAuthError(error) && !f.isStreamUnsupported(error));
    await tick();
    if (xhr) { xhr.responseText = delta; xhr.onprogress(); }
    assert.deepEqual(chunks, ["before"]);
    await f.login("B");
    if (xhr) { assert.equal(xhr.aborted, true); xhr.responseText += late; xhr.onprogress(); xhr.onload(); }
    else barrier.resolve({ value: new TextEncoder().encode(late), done: false });
    await rejected; assert.deepEqual(chunks, ["before"]);
  } finally { globalThis.XMLHttpRequest = originalXHR; f.restore(); }
});
