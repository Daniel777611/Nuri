import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Actual header/helper, with memory-only navigation. No transport or account.
const jsx = (type, props) => ({ type, props });
const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node)
  ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function load(path, dependencies = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function("require", "module", "exports", code)(name => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const chat = { name: "chat/[id]", params: { id: "session-current" } };
const stack = (...routes) => ({ type: "stack", index: routes.length - 1, routes });
function header({ path = "/chat/session-current", state, params = {}, canGoBack = true, consent = "allowed" } = {}) {
  const navigation = load("../src/components/nativeNavigation.ts");
  const calls = [];
  const Component = load("../src/components/NativePageControls.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: value => value } },
    "expo-router": {
      useRouter: () => ({ canGoBack: () => canGoBack, back: () => calls.push(["back"]),
        dismissTo: route => calls.push(["dismissTo", route]), push: route => calls.push(["push", route]) }),
      usePathname: () => path, useGlobalSearchParams: () => params, useRootNavigationState: () => state,
    },
    "@expo/vector-icons": {}, "@/src/theme": { colors: {} },
    "@/src/i18n": { useT: () => ({ locale: "en", t: value => value }), translate: (_locale, value) => value },
    "@/src/useAIConsent": { useAIConsent: () => ({ state: { status: consent, failure: "session" } }) },
    "@/src/aiConsentCopy": { aiConsentCopy: () => ({}) }, "@/src/aiPermissionNavigation": {},
    "@/src/requestFailure": { requestFailureCopy: () => ({ detail: "Session expired" }) },
    "./nativeNavigation": navigation,
    "@/src/liveCommunityGate": load("../src/liveCommunityGate.ts"),
    "@/src/uiux48/Primitives": { IconAction: "IconAction", NuriText: "Text" },
    "@/src/uiux48/Scene": { NuriAvatar: "Avatar" },
    "@/src/uiuxfinal/UserAvatar": { CurrentUserAvatarAction: "Profile" },
    "@/src/uiuxfinal/Primitives": { FinalText: "Text" },
    "@/src/uiuxfinal/ButtonMaterial": { FrostedPressable: "Pressable" },
  }).default;
  function expand(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === "function") return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  }
  const tree = expand(Component());
  return { navigation, calls, tree, pressBack: () => walk(tree).find(node => node.props?.testID === "native-header-back").props.onPress() };
}

for (const flavor of ["app-store", "early-access", "alpha", "live-alpha"]) {
  test(`${flavor}: actual chat Back with a stale Welcome/login stack dismisses to authenticated Home`, () => {
    const original = process.env.EXPO_PUBLIC_RELEASE_FLAVOR;
    process.env.EXPO_PUBLIC_RELEASE_FLAVOR = flavor;
    try {
      for (const previous of ["welcome", "login", "register", "index", "(tabs)", "chats"]) {
        const f = header({ state: stack({ name: previous }, chat) });
        f.pressBack();
        assert.deepEqual(f.calls, [["dismissTo", "/(tabs)"]], previous);
      }
      const direct = header({ state: stack(chat), canGoBack: false });
      direct.pressBack();
      assert.deepEqual(direct.calls, [["dismissTo", "/(tabs)"]]);
    } finally {
      if (original === undefined) delete process.env.EXPO_PUBLIC_RELEASE_FLAVOR;
      else process.env.EXPO_PUBLIC_RELEASE_FLAVOR = original;
    }
  });
}

test("explicit post/video/saved contexts keep guarded Back and their original params", () => {
  for (const previous of [
    { name: "daily-post", params: { id: "post-1", uiState: "takeaway", point: "0" } },
    { name: "daily-video", params: { id: "video-1" } },
    { name: "daily-post" }, { name: "daily-video" },
    { name: "detail/[id]", params: { id: "detail-1" } },
    { name: "saved/[id]", params: { id: "saved-1", uiState: "choose" } },
  ]) {
    const state = stack({ name: "welcome" }, previous, chat), before = JSON.stringify(state);
    const f = header({ state });
    f.pressBack();
    assert.deepEqual(f.calls, [["back"]]);
    assert.equal(JSON.stringify(state), before, "do not rewrite reading context or query params");
  }
});

test("both safe-source Back and Home go through the actual navigation guard before the router", () => {
  for (const [previous, expected] of [[{ name: "welcome" }, "home"], [{ name: "daily-post", params: { id: "post" } }, "back"]]) {
    const f = header({ state: stack(previous, chat) }), pending = [];
    const release = f.navigation.registerNativeNavigationGuard("/chat/session-current", action => pending.push(action));
    try {
      f.pressBack();
      assert.deepEqual(pending, [expected]);
      assert.deepEqual(f.calls, [], "recording/saving guard exclusively owns when navigation completes");
    } finally { release(); }
  }
});

test("missing, malformed, stale, nested-tab and unsafe source state fall back to Home", () => {
  const navigation = load("../src/components/nativeNavigation.ts");
  const invalid = [undefined, null, {}, [], { type: "stack", index: -1, routes: [chat] },
    { type: "stack", index: 0.5, routes: [chat] }, stack({ name: "https://outside.invalid" }, chat),
    stack({ name: "daily-post", params: { id: ["post"] } }, chat),
    stack({ name: "daily-video", params: { id: "../post" } }, chat),
    stack({ name: "detail/[id]" }, chat),
    stack({ name: "daily-post" }, { ...chat, params: { id: "old-session" } }),
    { type: "tab", index: 1, routes: [{ name: "daily-post" }, chat] }];
  const cycle = { type: "stack", index: 0, routes: [] };
  cycle.routes.push({ name: "cycle", state: cycle });
  invalid.push(cycle);
  for (const state of invalid) assert.equal(navigation.chatHeaderBackAction("/chat/session-current", state), "home");
  assert.equal(navigation.chatHeaderBackAction("/chats", stack({ name: "daily-post" }, chat)), "home");
  assert.equal(navigation.chatHeaderBackAction("/chat/session-current", stack({ name: "nested", state: stack({ name: "daily-video" }, chat) })), "back");
});

test("chat entry Back is Home; login and deleted-account fallbacks remain signed-out routes", () => {
  const entry = header({ path: "/chats", state: stack({ name: "welcome" }, { name: "chats" }) });
  entry.pressBack(); assert.deepEqual(entry.calls, [["dismissTo", "/(tabs)"]]);
  for (const [path, params, target] of [["/login", {}, "/"], ["/account-deletion", { uiState: "deleted" }, "/"], ["/profile", {}, "/(tabs)"]]) {
    const f = header({ path, params, canGoBack: false });
    f.pressBack(); assert.deepEqual(f.calls, [["dismissTo", target]]);
  }
});

test("a session-error banner is preserved rather than being treated as permission to sign out", () => {
  const f = header({ state: stack({ name: "welcome" }, chat), consent: "error" });
  assert.ok(walk(f.tree).some(node => node.props?.testID === "native-ai-permission-blocked"));
  f.pressBack(); assert.deepEqual(f.calls, [["dismissTo", "/(tabs)"]]);
});

test("live Community's parent conversation owns its header; simplified onboarding never stacks an obsolete header", () => {
  const keys = ["EXPO_PUBLIC_RELEASE_FLAVOR", "EXPO_PUBLIC_PREVIEW_MODE", "EXPO_PUBLIC_UIUX48_GALLERY", "EXPO_PUBLIC_FLOW_PROTOTYPE", "EXPO_PUBLIC_COMMUNITY_PROTOTYPE"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.EXPO_PUBLIC_RELEASE_FLAVOR = "live-alpha";
    for (const params of [{ communityHeader: "parent-chat" }, { communityHeader: "feedback" }, { uiState: "chat" }]) {
      assert.equal(header({ path: "/community", params }).tree, null);
    }
    assert.ok(walk(header({ path: "/community", params: { communityHeader: "regular", flowTitle: "Live title" } }).tree).some(node => node.props?.testID === "native-page-controls"));
    assert.equal(header({ path: "/onboarding", params: { uiState: "setupConcerns" } }).tree, null);
  } finally { for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});
