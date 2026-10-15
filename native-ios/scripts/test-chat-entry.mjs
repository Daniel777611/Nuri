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

// Run the real API/AI gate/state hook with memory-only storage. Transport is
// restricted to an invalid domain and cannot contact production or OpenAI.
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
  const client = load("../src/api.ts", {
    "./theme": { API: "https://chat-entry-test.invalid/api" }, "./preview-api": { isPreviewMode: false },
    "./utils/storage": { storage }, "./aiConsent": load("../src/aiConsent.ts"),
    "./sessionBoundary": load("../src/sessionBoundary.ts"),
  });
  const f = { ...client, calls, responder: null, history: true,
    restore: () => { globalThis.fetch = originalFetch; },
    login: (owner) => client.auth.setToken("account-" + owner),
    async permit() { await client.aiConsent.refresh(); await client.aiConsent.setAllowed(true, client.aiConsent.getState()); },
  };
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(url.startsWith("https://chat-entry-test.invalid/"), "real network is forbidden");
    const path = url.replace("https://chat-entry-test.invalid/api", "");
    const owner = init.headers?.Authorization?.replace("Bearer account-", "") || "none";
    calls.push({ path, owner, init });
    const custom = f.responder && await f.responder(path, init, owner);
    if (custom) return custom;
    if (path === "/auth/me") return response({ id: "user-" + owner });
    if (path === "/chat/main/preview") return response({ has_conversation: f.history, session_id: f.history ? "existing-" + owner : null });
    if (path === "/chat/sessions" && init.method === "POST") return response({ id: "created-" + owner });
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
  return { react, render(fn) { cursor = 0; pending = []; const value = fn(); pending.forEach((effect) => effect()); return value; },
    unmount() { effects.forEach((effect) => effect?.cleanup?.()); } };
}

function page(f) {
  const r = runner(), routes = [];
  let focused = true, callback = null, cleanup = null, tree;
  const jsx = (type, props) => ({ type, props });
  const native = { View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", StyleSheet: { create: (value) => value } };
  const failure = load("../src/requestFailure.ts");
  const notice = load("../src/components/RequestFailureNotice.tsx", { "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": native, "@/src/i18n": { useT: () => ({ locale: "en" }) }, "@/src/theme": { colors: {} }, "@/src/requestFailure": failure });
  const component = load("../app/(tabs)/chats.tsx", {
    react: r.react, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": native,
    "@/src/api": f, "@/src/theme": { colors: {} }, "@/src/requestFailure": failure,
    "@/src/aiPermissionNavigation": load("../src/aiPermissionNavigation.ts"), "@/src/components/RequestFailureNotice": notice,
    "@/src/useAccountState": load("../src/useAccountState.ts", { react: r.react, "./api": f }),
    "expo-router": { Redirect: "Redirect", useRouter: () => ({ push: (href) => routes.push(href) }),
      useFocusEffect: (fn) => r.react.useEffect(() => {
        callback = fn;
        if (focused) cleanup = fn();
        return () => { cleanup?.(); cleanup = null; };
      }, [fn]) },
  }).default;
  function expand(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === "function") return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  }
  const nodes = (node) => !node || typeof node !== "object" ? [] : Array.isArray(node)
    ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  return { routes, unmount: r.unmount,
    render: () => { tree = r.render(() => expand(component())); return tree; },
    blur: () => { focused = false; cleanup?.(); cleanup = null; },
    focus: () => { focused = true; cleanup = callback?.(); },
    find: (id) => nodes(tree).find((node) => node.props?.testID === id),
    redirect: () => nodes(tree).find((node) => node.type === "Redirect")?.props.href,
    visible: () => JSON.stringify(tree),
  };
}

test("existing preview history redirects without POST or AI permission", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f); p.render(); await tick(); p.render();
    assert.equal(p.redirect(), "/chat/existing-A");
    assert.deepEqual(f.calls.map(({ path }) => path), ["/chat/main/preview"]);
    assert.equal(f.aiConsent.getState().status, "unknown");
  } finally { p?.unmount(); f.restore(); }
});

test("no history rejects automatic creation before POST and shows permission instead of endless spinner", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.history = false; p = page(f); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission")); assert.equal(p.find("chat-entry-loading"), undefined);
    assert.equal(p.redirect(), undefined); assert.equal(f.calls.filter((call) => call.init.method === "POST").length, 0);
    p.find("request-failure-action").props.onPress();
    assert.deepEqual(p.routes, [{ pathname: "/ai-permission", params: { returnTo: "/(tabs)/chats" } }]);
  } finally { p?.unmount(); f.restore(); }
});

test("returning from permission refocuses, creates only after grant, then redirects", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.history = false; p = page(f); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-permission")); p.blur(); await f.permit(); p.focus(); await tick(); p.render();
    assert.equal(p.redirect(), "/chat/created-A");
    assert.equal(f.calls.filter((call) => call.path === "/chat/main/preview").length, 2);
    assert.equal(f.calls.filter((call) => call.path === "/chat/sessions" && call.init.method === "POST").length, 1);
  } finally { p?.unmount(); f.restore(); }
});

for (const [status, kind] of [[401, "session"], [503, "service"]]) test("preview " + status + " has distinct actionable failure and preserves auth", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); f.responder = (path) => path === "/chat/main/preview" ? response({ detail: "private detail" }, status) : null;
    p = page(f); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-" + kind)); assert.equal(p.find("chat-entry-loading"), undefined);
    assert.doesNotMatch(p.visible(), /private detail/); assert.equal(await f.auth.getToken(), "account-A");
    f.responder = null; p.find("request-failure-action").props.onPress(); await tick(); p.render();
    if (status === 401) assert.deepEqual(p.routes, ["/login"]);
    else { assert.equal(p.redirect(), "/chat/existing-A"); assert.deepEqual(p.routes, []); }
  } finally { p?.unmount(); f.restore(); }
});

for (const [status, kind] of [[401, "session"], [503, "service"]]) test("permitted POST " + status + " terminates spinner with correct failure", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit(); f.history = false;
    f.responder = (path) => path === "/chat/sessions" ? response({ detail: "private creation failure" }, status) : null;
    p = page(f); p.render(); await tick(); p.render();
    assert.ok(p.find("request-failure-" + kind)); assert.equal(p.find("chat-entry-loading"), undefined);
    assert.equal(f.calls.filter((call) => call.init.method === "POST").length, 1);
    assert.equal(await f.auth.getToken(), "account-A");
    if (status === 503) { f.responder = null; p.find("request-failure-action").props.onPress(); await tick(); p.render(); assert.equal(p.redirect(), "/chat/created-A"); }
  } finally { p?.unmount(); f.restore(); }
});

for (const stage of ["preview", "creation"]) test("blur invalidates late " + stage + " result and refocus accepts only the new request", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); if (stage === "creation") { await f.permit(); f.history = false; }
    const path = stage === "preview" ? "/chat/main/preview" : "/chat/sessions";
    f.responder = (route) => route === path ? { ...response(null), json: () => held.promise } : null;
    p = page(f); p.render(); await tick(); assert.ok(f.calls.some((call) => call.path === path), "barrier must be reached");
    p.blur(); held.resolve(stage === "preview" ? { has_conversation: true, session_id: "late-blurred-A" } : { id: "late-blurred-A" });
    await tick(); p.render(); assert.equal(p.redirect(), undefined);
    f.responder = null; p.focus(); await tick(); p.render(); assert.equal(p.redirect(), stage === "preview" ? "/chat/existing-A" : "/chat/created-A");
  } finally { held.resolve({}); p?.unmount(); f.restore(); }
});

for (const change of ["B", "logout", "ABA"]) test("account generation A → " + change + " suppresses old preview redirect", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); f.responder = (path, _init, owner) => owner === "A" && path === "/chat/main/preview"
      ? { ...response(null), json: () => held.promise } : path === "/chat/main/preview" ? response({ detail: "offline" }, 503) : null;
    p = page(f); p.render(); await tick(); assert.equal(f.calls[0].owner, "A");
    if (change === "logout") await f.auth.clearToken({ forceLocal: true });
    else { await f.login("B"); if (change === "ABA") await f.login("A"); }
    f.responder = (path) => path === "/chat/main/preview" ? response({ detail: "new owner offline" }, 503) : null;
    p.render(); held.resolve({ has_conversation: true, session_id: "private-old-A" }); await tick(); p.render();
    assert.equal(p.redirect(), undefined); assert.doesNotMatch(p.visible(), /private-old-A/);
    assert.ok(p.find("request-failure-service")); assert.deepEqual(p.routes, []);
  } finally { held.resolve({}); p?.unmount(); f.restore(); }
});

test("permitted POST held for A cannot redirect B after it completes", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); await f.permit(); f.history = false;
    f.responder = (path, _init, owner) => owner === "A" && path === "/chat/sessions"
      ? { ...response(null), json: () => held.promise } : owner === "B" && path === "/chat/main/preview" ? response({ detail: "offline" }, 503) : null;
    p = page(f); p.render(); await tick(); assert.ok(f.calls.some((call) => call.path === "/chat/sessions" && call.owner === "A"));
    await f.login("B"); p.render(); held.resolve({ id: "private-created-A" }); await tick(); p.render();
    assert.equal(p.redirect(), undefined); assert.ok(p.find("request-failure-service"));
    assert.doesNotMatch(p.visible(), /private-created-A/); assert.equal(await f.auth.getToken(), "account-B");
  } finally { held.resolve({}); p?.unmount(); f.restore(); }
});

for (const cleanup of ["blur", "unmount"]) test("late transport error after " + cleanup + " cannot install failure or redirect", async () => {
  const f = fixture(), held = deferred(); let p;
  try {
    await f.login("A"); f.responder = () => held.promise; p = page(f); p.render(); await tick();
    assert.equal(f.calls.length, 1); p[cleanup](); held.reject(new Error("late private error")); await tick(); p.render();
    assert.equal(p.redirect(), undefined); assert.equal(p.find("request-failure-connection"), undefined);
    assert.deepEqual(p.routes, []);
  } finally { p?.unmount(); f.restore(); }
});
