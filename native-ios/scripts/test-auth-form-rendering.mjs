import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Execute the actual screens, account-scoped hooks, field primitive and iOS
// adapter. Host views/React scheduling and services are mocked: these tests
// establish render/identity/event contracts, not on-device keyboard pixels.
const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const jsx = (type, props, key) => ({ type, props, key });
const Fragment = Symbol("Fragment");
const tick = () => new Promise(resolve => setImmediate(resolve));
function load(file, deps) {
  const code = ts.transpileModule(read(file), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => {
    if (name.startsWith("@/assets/")) return "fixture-asset";
    assert.ok(Object.hasOwn(deps, name), `Unexpected dependency in ${file}: ${name}`);
    return deps[name];
  }, module, module.exports);
  return module.exports;
}
const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];

async function fixture(kind) {
  const owners = new Map(), hosts = new Map(), calls = [], routes = [], renderCounts = new Map();
  let current, tree, dirty = false, generation = 1, identity = 1, nextID = 0, mounted = true;
  let locale = "en", night = false, blocked = false;
  const effect = (fn, deps) => {
    const owner = current, index = owner.cursor++;
    if (!same(owner.effects[index]?.deps, deps)) owner.pending.push(() => {
      owner.effects[index]?.cleanup?.(); owner.effects[index] = { deps, cleanup: fn() };
    });
  };
  const react = {
    forwardRef: fn => fn,
    useRef(initial) { const index = current.cursor++; return current.slots[index] ??= { current: initial }; },
    useId() { const index = current.cursor++; return current.slots[index] ??= `auth-native-${++nextID}`; },
    useState(initial) {
      const owner = current, index = owner.cursor++;
      const slot = owner.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      slot.set ??= next => {
        if (!mounted || !owners.has(owner.key)) return;
        const value = typeof next === "function" ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
      };
      return [slot.value, slot.set];
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useMemo(fn, deps) {
      const index = current.cursor++;
      if (!same(current.slots[index]?.deps, deps)) current.slots[index] = { deps, value: fn() };
      return current.slots[index].value;
    },
    useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore(_subscribe, getSnapshot) { current.cursor++; return getSnapshot(); },
  };
  const native = {
    ...Object.fromEntries(["ActivityIndicator", "KeyboardAvoidingView", "Pressable", "ScrollView", "Switch", "Text", "View", "InputAccessoryView"].map(name => [name, name])),
    TextInput: "NativeTextInput", Platform: { OS: "ios" },
    StyleSheet: { create: value => value, absoluteFill: {}, flatten: value => Object.assign({}, ...[value].flat(Infinity).filter(Boolean)) },
    useWindowDimensions: () => ({ width: 402, height: 874 }),
  };
  const t = text => text, recover = async () => {};
  const router = { push: route => routes.push(route), replace: route => routes.push(route) };
  const auth = {
    getSessionGeneration: () => generation, getIdentityGeneration: () => identity,
    subscribeSessionBoundary: () => () => {}, getToken: async () => null,
  };
  const api = Object.fromEntries(["login", "register"].map(name => [name, async payload => {
    calls.push([name, payload]); throw new Error("fixture offline; no network");
  }]));
  const account = load("../src/useAccountState.ts", { react, "./api": { auth } });
  const common = { react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment }, "react-native": native,
    "@/src/i18n": { useT: () => ({ t, locale, setLocale: async () => {} }), translate: (_locale, text) => text } };
  const accessory = load("../src/keyboard/NativeKeyboardAccessory.tsx", common);
  const adapter = load("../src/keyboard/NativeNuriTextInput.tsx", { ...common, "./NativeKeyboardAccessory": accessory });
  const NuriTextInput = (props, ref) => jsx(adapter.NativeNuriTextInput, { ...props, ref, scopeActive: true });
  const primitives = load("../src/uiux48/Primitives.tsx", {
    ...common, "@/src/keyboard/AppKeyboard": { NuriTextInput }, "expo-blur": { BlurView: "BlurView" }, "expo-image": { Image: "Image" },
    "expo-router": { useRouter: () => router }, "./Theme": { useNuriTheme: () => ({ mode: night ? "Night" : "Morning", night,
      ink: "ink", secondary: "secondary", composer: "composer", message: "message", keyboard: { appearance: night ? "dark" : "light" }, token: () => "tint" }) },
    "./materials": { GLASS_BLUR48: { Morning: { message: 20 }, Night: { message: 20 } }, GLASS_SHADOW48: {} },
    "./GlassLighting": { GlassLighting: "GlassLighting" },
    "@/src/uiux49/spec": { TYPE49: { Body: {}, Caption: {}, H1: {}, H2: {}, H3: {} } },
    "./inputLayout": { singleLineInputStyle: {}, multilineInputStyle: {} },
    "@/src/uiuxfinal/ButtonMaterial": { ButtonBackdrop: "ButtonBackdrop" },
  });
  const deps = { ...common, "@/src/uiux48/Primitives": primitives, "@/src/useAccountState": account,
    "@/src/api": { api, auth, apiErrorDetail: () => null, isAuthError: () => false },
    "expo-router": { useRouter: () => router, useLocalSearchParams: () => ({}) },
    "@/src/components/NativeSafeAreaView": {}, "@react-navigation/elements": { useHeaderHeight: () => 44 },
    "@expo/vector-icons": {}, "@/src/theme": { colors: {}, radius: {}, spacing: {}, type: {} },
    "@/src/authFlow": { savePendingVerification: async () => {}, authErrorMessage: () => "fixture offline" },
    "@/src/nativePushRuntime": { safeNotificationRoute: () => null },
    "@/src/components/GoogleSignInButton": { __esModule: true, default: "GoogleSignInButton" },
    "@/src/authExpiredRecovery": { useExpiredSessionRecovery: () => ({ blocked, recover }), ExpiredSessionRecoveryNotice: "RecoveryNotice" },
    "@/src/preview-api": { isPreviewMode: false }, "expo-font": { useFonts: () => [true] },
    "@/src/textFonts": { TEXT_FONTS: {} },
    "@expo-google-fonts/noto-sans-sc/400Regular": {}, "@expo-google-fonts/noto-sans-sc/900Black": {}, "expo-linear-gradient": {},
  };
  deps["@/src/uiux48/useNativeAuthDraft"] = load("../src/uiux48/useNativeAuthDraft.ts", { react, "@/src/useAccountState": account });
  const Screen = load(`../app/${kind}.tsx`, deps).default;
  function render() {
    assert.ok(mounted); dirty = false;
    const seenOwners = new Set(), seenHosts = new Set(), pending = [];
    function expand(node, path) {
      if (!node || typeof node !== "object") return node;
      if (Array.isArray(node)) return node.map((item, index) => expand(item, `${path}:${item?.key ?? index}`));
      const key = `${path}:${node.key ?? ""}`;
      if (typeof node.type === "function") {
        let owner = owners.get(key);
        if (owner && owner.type !== node.type) { owner.effects.forEach(e => e?.cleanup?.()); owners.delete(key); owner = null; }
        if (!owner) { owner = { key, type: node.type, cursor: 0, slots: [], effects: [], pending: [] }; owners.set(key, owner); }
        seenOwners.add(key); owner.cursor = 0; owner.pending = []; const previous = current; current = owner;
        renderCounts.set(node.type.name, (renderCounts.get(node.type.name) ?? 0) + 1);
        const output = node.type(node.props, node.props?.ref); current = previous;
        const result = expand(output, `${key}:output`); pending.push(...owner.pending); return result;
      }
      if (node.type === "NativeTextInput") {
        seenHosts.add(key);
        let host = hosts.get(key);
        if (!host) {
          host = { id: ++nextID, text: node.props.defaultValue ?? "", ref: null, blurCalls: 0 };
          host.handle = { blur: () => host.blurCalls++, focus() {}, isFocused: () => true };
          hosts.set(key, host);
        }
        if (node.props.value !== undefined) host.text = node.props.value;
        host.props = node.props;
        if (host.ref !== node.props.ref) { host.ref?.(null); host.ref = node.props.ref; host.ref?.(host.handle); }
        return { ...node, host };
      }
      const children = typeof node.props?.children === "function" ? node.props.children({ pressed: false }) : node.props?.children;
      return { ...node, props: { ...node.props, children: expand(children, `${key}:children`) } };
    }
    tree = expand(jsx(Screen, {}), "root");
    for (const [key, owner] of owners) if (!seenOwners.has(key)) { owner.effects.forEach(e => e?.cleanup?.()); owners.delete(key); }
    for (const [key, host] of hosts) if (!seenHosts.has(key)) { host.ref?.(null); hosts.delete(key); }
    pending.forEach(run => run()); return tree;
  }
  const f = {
    calls, routes, renderCounts, render,
    flush() { let count = 0; while (dirty) { assert.ok(count++ < 10, "Unexpected render loop"); render(); } },
    find(id) { return walk(tree).find(node => node.props?.testID === id); },
    input(name) { const node = f.find(`${kind}-${name}`); assert.equal(node?.type, "NativeTextInput"); return node; },
    type(name, value) { const input = f.input(name); input.host.text = value; input.props.onChangeText(value); f.flush(); },
    submit() { return f.find(kind === "login" ? "login-submit-btn" : "register-next-btn").props.onPress(); },
    get disabled() { return f.find(kind === "login" ? "login-submit-btn" : "register-next-btn").props.disabled; },
    async boundary() { generation++; identity++; render(); await tick(); f.flush(); },
    appearance() { night = !night; locale = "zh-TW"; render(); f.flush(); },
    block() { blocked = true; render(); },
    unmount() { owners.forEach(owner => owner.effects.forEach(e => e?.cleanup?.())); owners.clear(); hosts.forEach(host => host.ref?.(null)); mounted = false; },
  };
  render(); await tick(); f.flush(); return f;
}

for (const kind of ["login", "register"]) test(`${kind}: native typing leaves the auth material and host identity stable`, async () => {
  const f = await fixture(kind);
  try {
    const email = f.input("email"), password = f.input("password");
    const before = f.renderCounts.get("GlassSurface");
    for (const text of ["p", "pa", "par", "pare", "parent", "parent@", "parent@example.invalid"]) f.type("email", text);
    assert.equal(f.renderCounts.get("GlassSurface"), before, "An incomplete form must not repaint its glass card per email character");
    if (kind === "register") for (const text of ["n", "ni", "你好", "ㄓㄨ", "日本語", "e\u0301", "👨‍👩‍👧‍👦"]) f.type("nickname", text);
    for (const text of ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdef漢", "abcdef漢! 9"]) f.type("password", text);
    assert.equal(f.renderCounts.get("GlassSurface"), before + 1, "Only the disabled→enabled validity boundary should repaint the form");
    assert.equal(f.input("email").host, email.host); assert.equal(f.input("password").host, password.host);
    assert.equal(f.input("password").props.nativeID, password.props.nativeID);
    assert.equal(f.input("password").props.ref, password.props.ref);
    assert.equal(password.host.blurCalls, 0); assert.equal(email.host.blurCalls, 0);
    assert.equal(f.input("email").props.value, undefined); assert.equal(f.input("password").props.value, undefined);
    assert.equal(f.input("password").props.secureTextEntry, true);
    assert.equal(f.input("email").props.autoComplete, "email");
    assert.equal(kind === "login" ? f.input("password").props.textContentType : f.input("password").props.autoComplete, kind === "login" ? "password" : "new-password");
    assert.equal(f.calls.length, 0, "Typing must never authenticate or persist credentials");
  } finally { f.unmount(); }
});

for (const kind of ["login", "register"]) test(`${kind}: submission reads the latest raw native draft, not a render-old value`, async () => {
  const f = await fixture(kind);
  try {
    f.type("email", " Parent@Example.INVALID "); f.type("password", "abcdef");
    if (kind === "register") f.type("nickname", "  日本語 👨‍👩‍👧‍👦  ");
    // No render is requested between the final native event and submission.
    const final = "密碼 e\u0301 ! 123"; f.input("password").host.text = final; f.input("password").props.onChangeText(final);
    await f.submit(); f.flush();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], [kind, { ...(kind === "register" ? { nickname: "日本語 👨‍👩‍👧‍👦" } : {}), email: "parent@example.invalid", password: final, language: "en" }]);
    assert.equal(f.input("password").host.text, final, "An ordinary failed request must not reset the native draft");
    f.appearance();
    assert.equal(f.input("password").host.text, final, "Unrelated locale/theme renders must not restore defaultValue");
    assert.equal(f.input("password").props.keyboardAppearance, "dark");
    assert.equal(f.input("password").props.selection, undefined, "UIKit retains caret/marked-text ownership");
  } finally { f.unmount(); }
});

for (const kind of ["login", "register"]) test(`${kind}: deleting text updates readiness, with no stale valid render`, async () => {
  const f = await fixture(kind);
  try {
    f.type("email", "parent@example.invalid"); f.type("password", "abcdef"); assert.equal(f.disabled, false);
    f.type("password", ""); assert.equal(f.disabled, true);
    f.type("password", "abcdef"); assert.equal(f.disabled, false);
    f.type("email", ""); assert.equal(f.disabled, true);
  } finally { f.unmount(); }
});

for (const kind of ["login", "register"]) test(`${kind}: deleting the last valid input before React commits cannot submit an invalid draft`, async () => {
  const f = await fixture(kind);
  try {
    f.type("email", "parent@example.invalid"); f.type("password", "abcdef");
    const submit = f.find(kind === "login" ? "login-submit-btn" : "register-next-btn").props.onPress;
    f.input("password").props.onChangeText(""); await submit();
    assert.equal(f.calls.length, 0, "Submission must recheck live readiness, not a render-old enabled button");
    f.flush(); assert.equal(f.disabled, true);
  } finally { f.unmount(); }
});

for (const kind of ["login", "register"]) test(`${kind}: account boundaries clear native drafts and reject retired callbacks`, async () => {
  const f = await fixture(kind);
  try {
    f.type("email", "private@example.invalid"); f.type("password", "private-password");
    const old = f.input("password"), oldChange = old.props.onChangeText, oldSubmit = f.find(kind === "login" ? "login-submit-btn" : "register-next-btn").props.onPress;
    await f.boundary();
    assert.notEqual(f.input("password").host, old.host, "Only the auth generation, never a keystroke, retires the native field");
    assert.equal(f.input("email").host.text, ""); assert.equal(f.input("password").host.text, ""); assert.equal(f.disabled, true);
    oldChange("old-secret"); await oldSubmit(); f.flush();
    assert.equal(f.input("password").host.text, ""); assert.equal(f.calls.length, 0);
    const liveChange = f.input("password").props.onChangeText, liveSubmit = f.find(kind === "login" ? "login-submit-btn" : "register-next-btn").props.onPress;
    f.unmount(); liveChange("retired-secret"); await liveSubmit(); assert.equal(f.calls.length, 0);
  } finally { /* The test explicitly unmounts before exercising retired callbacks. */ }
});

test("registration still fails closed behind expired-session recovery", async () => {
  const f = await fixture("register");
  try { f.block(); assert.equal(f.find("register-email"), undefined); assert.equal(f.calls.length, 0); }
  finally { f.unmount(); }
});
