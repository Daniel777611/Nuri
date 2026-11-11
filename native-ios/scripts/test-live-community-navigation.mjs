import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const jsx = (type, props) => ({ type, props });
function load(path, dependencies = {}) {
  const code = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => {
    if (name.startsWith("@/assets/")) return name;
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected navigation dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const gate = load("../src/liveCommunityGate.ts");
const flags = ["EXPO_PUBLIC_PREVIEW_MODE", "EXPO_PUBLIC_UIUX48_GALLERY", "EXPO_PUBLIC_FLOW_PROTOTYPE", "EXPO_PUBLIC_COMMUNITY_PROTOTYPE"];
function withEnvironment(flavor, changes, work) {
  const keys = ["EXPO_PUBLIC_RELEASE_FLAVOR", "NURI_RELEASE_CHANNEL", ...flags];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  if (flavor !== undefined) process.env.EXPO_PUBLIC_RELEASE_FLAVOR = flavor;
  Object.assign(process.env, changes);
  try { return work(); } finally {
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
}
const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function shell({ path = "/", params = {}, keyboard = false } = {}) {
  const calls = [], guarded = [];
  const Component = load("../src/uiux48/Shell.tsx", {
    react: { useRef: value => ({ current: value }), useState: value => [typeof value === "boolean" ? keyboard : value, () => {}], useEffect() {} },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Keyboard: {}, Platform: { OS: "ios" }, View: "View", Text: "Text", StyleSheet: { create: value => value, absoluteFill: {} } },
    "expo-router": { usePathname: () => path, useSegments: () => path === "/" ? ["(tabs)"] : [], useGlobalSearchParams: () => params, useRouter: () => ({ navigate: route => calls.push(route) }) },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView", useSafeAreaInsets: () => ({ bottom: 34 }) },
    "expo-status-bar": { StatusBar: "StatusBar" }, "expo-image": { Image: "Image" }, "expo-linear-gradient": { LinearGradient: "Gradient" }, "expo-blur": { BlurView: "BlurView" },
    "@/src/i18n": { useT: () => ({ locale: "en" }), translate: (_locale, text) => text },
    "@/src/components/NativePageControls": { __esModule: true, default: "NativePageControls" },
    "@/src/components/nativeNavigation": { requestGuardedNativeNavigation: (_path, action) => { guarded.push(action); return false; } },
    "./Scene": { NuriScene: "Scene" }, "./Theme": { useNuriTheme: () => ({ night: false, mode: "Morning", keyboard: { surface: "surface" } }) }, "./Primitives": { NuriIcon: "Icon" },
    "@/src/uiuxfinal/Primitives": { FINAL_COLOR: {}, FinalSurface: "FinalSurface" }, "@/src/uiuxfinal/ButtonMaterial": { FrostedPressable: "Pressable" },
    "@/src/uiuxfinal/ChatBackdrop": { FinalChatBackdrop: "ChatBackdrop" }, "@/src/uiuxfinal/ReadingBackdrop": { FinalReadingBackdrop: "ReadingBackdrop" },
    "./keyboard": { keyboardPanelTop: () => null }, "@/src/keyboard/AppKeyboard": { AppKeyboardHost: "AppKeyboardHost", useAppKeyboardVisible: () => false },
    "@/src/liveCommunityGate": gate,
  });
  const expand = node => !node || typeof node !== "object" ? node : Array.isArray(node) ? node.map(expand) : typeof node.type === "function" ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  return { tree: expand(Component.NuriShell({ children: jsx("Body", {}) })), calls, guarded };
}

test("live UI only uses the dedicated public flavor and disabled prototype flags, never a Node-only channel", () => {
  withEnvironment("live-alpha", {}, () => assert.equal(gate.isLiveCommunityEnabled(), true));
  withEnvironment("live-alpha", Object.fromEntries(flags.map(key => [key, "0"])), () => assert.equal(gate.isLiveCommunityEnabled(), true));
  for (const flavor of [undefined, "alpha", "beta", "early-access", "app-store", "unknown"]) withEnvironment(flavor, { NURI_RELEASE_CHANNEL: "live-alpha" }, () => assert.equal(gate.isLiveCommunityEnabled(), false));
  for (const key of flags) for (const value of ["1", "true", "false", "invalid", ""]) withEnvironment("live-alpha", { [key]: value }, () => assert.equal(gate.isLiveCommunityEnabled(), false, `${key}=${value}`));
  assert.doesNotMatch(read("../src/liveCommunityGate.ts"), /process\.env\.NURI_RELEASE_CHANNEL|process\.env\[/);
});

test("actual shell exposes Community navigation only for live Alpha, preserving other channels' Home/chat", () => {
  for (const flavor of [undefined, "app-store", "early-access", "alpha", "beta", "live-alpha"]) withEnvironment(flavor, {}, () => {
    const f = shell(), nodes = walk(f.tree), tabs = nodes.filter(node => node.props?.accessibilityRole === "tab");
    assert.deepEqual(tabs.map(node => node.props.testID), ["nuri-tab-home", "nuri-tab-chat", ...(flavor === "live-alpha" ? ["nuri-tab-community"] : [])]);
    assert.equal(nodes.find(node => node.type === "FinalSurface").props.bordered, true, "main's ordinary navigation material remains unchanged");
    if (flavor === "live-alpha") { tabs.at(-1).props.onPress(); assert.deepEqual(f.guarded, ["community"]); assert.deepEqual(f.calls, ["/community"]); }
  });
});

test("actual live Community chrome retains main's parent-header and settings/backdrop params", () => withEnvironment("live-alpha", {}, () => {
  const root = shell({ path: "/community" });
  assert.ok(walk(root.tree).find(node => node.props?.testID === "community-approved-background"));
  assert.equal(walk(root.tree).find(node => node.type === "FinalSurface").props.bordered, false);
  const chat = shell({ path: "/community", params: { communityHeader: "parent-chat", communityBackdrop: "plain", communityHideTabs: "1" } });
  assert.ok(walk(chat.tree).find(node => node.type === "ChatBackdrop" && node.props.scene === "parent"));
  assert.equal(walk(chat.tree).find(node => node.props?.testID === "nuri-tab-bar"), undefined);
}));

test("actual onboarding shell keeps its approved backdrop and removes bottom safe padding while keyboard is visible", () => {
  for (const keyboard of [false, true]) {
    const f = shell({ path: "/onboarding", keyboard });
    assert.ok(walk(f.tree).find(node => node.props?.testID === "onboarding-approved-background"));
    const body = walk(f.tree).find(node => node.type === "SafeAreaView" && walk(node.props.children).some(child => child.type === "Body"));
    assert.deepEqual(body.props.edges, keyboard ? [] : ["bottom"]);
  }
});
