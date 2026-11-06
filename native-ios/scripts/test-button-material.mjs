import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Execute the actual shared helper. Native/browser primitives are boundaries,
// not screenshot, UIKit optical strength, CSS paint or touch acceptance.
const source = "src/uiuxfinal/ButtonMaterial.tsx";
const flatten = style => Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flatten)) : style ?? {};
const nodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const children = node => [node.props?.children].flat(Infinity).filter(Boolean);
const absoluteFill = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 };

function fixture(os = "ios") {
  const Fragment = Symbol("Fragment"), jsx = (type, props, key) => ({ type, props, key });
  const refRenders = [], imports = [];
  const deps = {
    react: { forwardRef: render => {
      function Forwarded(props, ref) { refRenders.push({ props, ref }); return render(props, ref); }
      return Forwarded;
    } },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", ActivityIndicator: "ActivityIndicator", Platform: { OS: os }, StyleSheet: { absoluteFill, flatten } },
    "expo-blur": { BlurView: "BlurView" },
  };
  const compiled = ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => {
    imports.push(name); assert.ok(name in deps, "Unexpected shared-button service or dependency: " + name); return deps[name];
  }, module, module.exports);
  const expand = (node, state) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(child => expand(child, state));
    if (node.type === Fragment) return expand(node.props?.children, state);
    if (typeof node.type === "function") return expand(node.type(node.props), state);
    const content = node.type === "Pressable" && typeof node.props?.children === "function" ? node.props.children(state) : node.props?.children;
    return { ...node, props: { ...node.props, ...(content !== undefined || Object.hasOwn(node.props ?? {}, "children") ? { children: expand(content, state) } : {}) } };
  };
  function loadOwner(path, overrides = {}) {
    const owner = { exports: {} }, ownerDeps = { ...deps, "./ButtonMaterial": module.exports, "@/src/uiuxfinal/ButtonMaterial": module.exports, ...overrides };
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function("require", "module", "exports", code)(name => { assert.ok(name in ownerDeps, "Unexpected button owner service or dependency: " + name); return ownerDeps[name]; }, owner, owner.exports);
    return owner.exports;
  }
  return { ...module.exports, imports, refRenders, loadOwner, render: (node, state = { pressed: false, hovered: false, focused: false }) => expand(node, state) };
}

test("button backdrop clips only its own radius and uses CSS20px or native40 while fill alpha cannot dim the blur group", () => {
  for (const os of ["web", "ios", "android"]) {
    const f = fixture(os), color = "rgba(235,129,131,.8)", tree = f.ButtonBackdrop({ color, opacity: .36, testID: "button-material" });
    const outer = flatten(tree.props.style), layers = children(tree), blur = layers[0], fill = layers[1];
    assert.equal(tree.type, "View"); assert.equal(tree.props.testID, "button-material"); assert.equal(tree.props.pointerEvents, "none");
    assert.equal(tree.props.accessibilityElementsHidden, true); assert.equal(tree.props.importantForAccessibility, "no-hide-descendants");
    assert.deepEqual(outer, { ...absoluteFill, borderRadius: 25, overflow: "hidden" }); assert.equal(outer.opacity, undefined);
    assert.equal(layers.length, 2); assert.equal(fill.type, "View"); assert.equal(fill.props.pointerEvents, "none"); assert.deepEqual(flatten(fill.props.style), { ...absoluteFill, backgroundColor: color, opacity: .36 });
    assert.equal(flatten(blur.props.style).opacity, undefined); assert.equal(blur.props.pointerEvents, "none");
    if (os === "web") {
      assert.equal(blur.type, "View"); assert.deepEqual(flatten(blur.props.style), { ...absoluteFill, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" });
      assert.equal(nodes(tree).some(node => node.type === "BlurView"), false);
    } else {
      assert.equal(blur.type, "BlurView"); assert.equal(blur.props.intensity, 40); assert.equal(blur.props.tint, "light"); assert.deepEqual(flatten(blur.props.style), absoluteFill);
    }
    assert.equal(nodes(tree).some(node => node.type === "Text"), false, "Foreground content must not become a blur descendant");
  }
});

test("custom per-corner radii and public blur bounds survive without changing default40 design strength", () => {
  for (const os of ["web", "ios"]) for (const [requested, bounded] of [[-30, 0], [0, 0], [40, 40], [200, 100]]) {
    const f = fixture(os), radii = { borderTopLeftRadius: 3, borderTopRightRadius: 5, borderBottomLeftRadius: 7, borderBottomRightRadius: 9 };
    const tree = f.ButtonBackdrop({ color: "#fff", radius: 17, radii, blurRadius: requested }), layers = children(tree);
    assert.deepEqual(flatten(tree.props.style), { ...absoluteFill, borderRadius: 17, overflow: "hidden", ...radii });
    if (os === "web") assert.equal(flatten(layers[0].props.style).backdropFilter, `blur(${bounded / 2}px)`); else assert.equal(layers[0].props.intensity, bounded);
    assert.equal(flatten(layers[1].props.style).opacity, 1);
  }
});

test("painted controls keep original Pressable identity, ref, geometry, shadow and accessible hit properties; only paint/alpha move", () => {
  for (const os of ["web", "ios", "android"]) for (const ref of [{ current: null }, () => {}]) {
    const f = fixture(os), label = { type: "Text", props: { children: "Continue", style: { color: "white", fontSize: 18 } } }, calls = [];
    const handlers = Object.fromEntries(["onPress", "onLongPress", "onPressIn", "onPressOut", "onPointerDown", "onFocus", "onBlur"].map(name => [name, event => calls.push([name, event])]));
    const hitSlop = { top: 5, bottom: 5, left: 10, right: 10 }, pressRetentionOffset = { top: 20, bottom: 20, left: 20, right: 20 };
    const geometry = { width: 268, maxWidth: "100%", minWidth: 44, height: 50, minHeight: 44, paddingHorizontal: 24, paddingVertical: 9, borderRadius: 25, alignSelf: "center", alignItems: "center", justifyContent: "center", boxShadow: "0px 4px 10px rgba(0,0,0,.15)", shadowColor: "#5C5662", shadowOpacity: .2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 };
    const props = { ...handlers, testID: "continue", disabled: true, accessible: true, accessibilityRole: "button", accessibilityLabel: "Continue setup", accessibilityState: { disabled: true, busy: false }, hitSlop, pressRetentionOffset, delayLongPress: 450, focusable: true, style: [geometry, { backgroundColor: "#EB8183", opacity: .6 }], children: label };
    const host = f.FrostedPressable(props, ref), state = { pressed: false, hovered: false, focused: false }, tree = f.render(host, state), material = children(tree)[0];
    assert.equal(host.type, "Pressable"); assert.equal(host.props.ref, ref); assert.equal(f.refRenders.length, 1); assert.equal(f.refRenders[0].ref, ref);
    for (const name of [...Object.keys(handlers), "testID", "disabled", "accessible", "accessibilityRole", "accessibilityLabel", "accessibilityState", "hitSlop", "pressRetentionOffset", "delayLongPress", "focusable"]) assert.equal(host.props[name], props[name], name);
    assert.equal(typeof host.props.style, "function"); assert.deepEqual(host.props.style(state), { ...geometry, backgroundColor: "transparent", opacity: 1 });
    assert.equal(flatten(host.props.style(state)).overflow, undefined, "Outer shadow must not be clipped just to clip the material");
    assert.equal(material.props.testID, "continue-material"); assert.equal(flatten(material.props.style).overflow, "hidden"); assert.equal(flatten(material.props.style).borderRadius, 25);
    assert.equal(flatten(children(material)[1].props.style).backgroundColor, "#EB8183"); assert.equal(flatten(children(material)[1].props.style).opacity, .6);
    assert.equal(children(tree)[1].type, "Text"); assert.deepEqual(children(tree)[1].props, label.props); assert.equal(nodes(material).some(node => node.type === "Text"), false); assert.deepEqual(calls, []);
    const event = { nativeEvent: { fixture: "same event" } }; for (const name of Object.keys(handlers)) host.props[name](event);
    assert.deepEqual(calls, Object.keys(handlers).map(name => [name, event]));
    // Disabled enforcement is the original native Pressable's responsibility;
    // the helper must preserve the flag and callback, not invent a second gate.
  }
});

test("style and children callbacks receive the original pressed/hovered/focused state without clipping foreground or mutating caller styles", () => {
  const f = fixture("web"), styleStates = [], childStates = [], base = { height: 44, width: 90, borderTopLeftRadius: 6, borderTopRightRadius: 8, borderBottomLeftRadius: 10, borderBottomRightRadius: 12 };
  const original = JSON.stringify(base), calls = [];
  const host = f.FrostedPressable({ testID: "stateful", blurRadius: 48, onPress: () => calls.push("press"), style: state => { styleStates.push(state); return [base, { backgroundColor: state.pressed ? "rgba(235,129,131,.7)" : "rgba(255,255,255,.5)", opacity: state.pressed ? .35 : .8, borderRadius: state.pressed ? 19 : 22, transform: [{ scale: state.pressed ? .98 : 1 }] }]; }, children: state => { childStates.push(state); return { type: "Text", props: { children: state.pressed ? "Pressed" : "Ready", style: { color: "#5C5662" } } }; } }, null);
  for (const state of [{ pressed: false, hovered: false, focused: false }, { pressed: true, hovered: false, focused: true }, { pressed: false, hovered: true, focused: true }]) {
    const outer = host.props.style(state), tree = f.render(host, state), [material, label] = children(tree);
    assert.equal(styleStates.at(-1), state); assert.equal(childStates.at(-1), state); assert.equal(childStates.filter(value => value === state).length, 1);
    assert.equal(outer.opacity, 1); assert.equal(outer.backgroundColor, "transparent"); assert.deepEqual(outer.transform, [{ scale: state.pressed ? .98 : 1 }]); assert.equal(outer.height, 44); assert.equal(outer.width, 90);
    assert.deepEqual(flatten(material.props.style), { ...absoluteFill, borderRadius: state.pressed ? 19 : 22, overflow: "hidden", borderTopLeftRadius: 6, borderTopRightRadius: 8, borderBottomLeftRadius: 10, borderBottomRightRadius: 12 });
    assert.equal(flatten(children(material)[0].props.style).backdropFilter, "blur(24px)"); assert.equal(flatten(children(material)[1].props.style).opacity, state.pressed ? .35 : .8);
    assert.equal(flatten(children(material)[1].props.style).backgroundColor, state.pressed ? "rgba(235,129,131,.7)" : "rgba(255,255,255,.5)");
    assert.equal(label.props.children, state.pressed ? "Pressed" : "Ready"); assert.equal(flatten(label.props.style).opacity, undefined); assert.equal(nodes(material).some(node => node.type === "Text"), false);
  }
  assert.equal(JSON.stringify(base), original); assert.deepEqual(calls, []); host.props.onPress(); assert.deepEqual(calls, ["press"]);
});

test("unpainted and transparent icon actions keep their original styling/alpha and gain neither blur nor background", () => {
  for (const os of ["web", "ios"]) for (const style of [undefined, null, { width: 44, height: 44, opacity: .45 }, [{ height: 44 }, { backgroundColor: "transparent", borderRadius: 22, opacity: .3 }], () => ({ backgroundColor: "transparent", width: 60, height: 60, padding: 8 })]) {
    const f = fixture(os), icon = { type: "Image", props: { source: "original-icon.svg", style: { width: 20, height: 20 } } }, state = { pressed: false, hovered: false, focused: false };
    const host = f.FrostedPressable({ testID: "icon", style, children: icon }, null), tree = f.render(host, state), resolved = flatten(typeof style === "function" ? style(state) : style);
    assert.deepEqual(host.props.style(state), resolved); assert.deepEqual(children(tree), [icon]);
    assert.equal(nodes(tree).some(node => node.props?.testID === "icon-material" || node.type === "BlurView" || flatten(node.props?.style).backdropFilter), false);
  }
});

test("real FinalButton disabled variants retain20% coral or37.5% cream fills and fully legible labels across locales", () => {
  for (const os of ["ios", "web"]) for (const locale of ["zh-CN", "zh-TW", "en"]) {
    const f = fixture(os), { FinalButton } = f.loadOwner("src/uiuxfinal/Primitives.tsx", { "@/src/i18n": { useT: () => ({ locale }) } });
    for (const secondary of [false, true]) for (const disabled of [false, true]) for (const pressed of [false, true]) {
      const calls = [], label = locale === "en" ? "Continue" : locale === "zh-TW" ? "繼續" : "继续", state = { pressed, hovered: false, focused: false };
      const tree = f.render(FinalButton({ label, secondary, disabled, testID: "final-button", onPress: () => calls.push("press") }), state), material = nodes(tree).find(node => node.props?.testID === "final-button-material"), text = nodes(tree).find(node => node.type === "Text");
      const style = flatten(tree.props.style(state)); assert.equal(style.width, 212); assert.equal(style.minHeight, 50); assert.equal(style.borderRadius, 25); assert.equal(style.opacity, 1); assert.equal(tree.props.disabled, disabled); assert.equal(tree.props.accessibilityState.disabled, disabled);
      const fill = flatten(children(material)[1].props.style), expected = secondary ? disabled ? "rgba(255,250,244,.375)" : "rgba(255,250,244,.75)" : disabled ? "rgba(235,129,131,.2)" : "#EB8183";
      assert.equal(fill.backgroundColor, expected); assert.equal(fill.opacity, pressed ? .7 : 1); assert.equal(text.props.children, label); assert.equal(flatten(text.props.style).color, secondary ? "#4A454D" : "white"); assert.equal(flatten(text.props.style).opacity, undefined); assert.equal(nodes(material).some(node => node.type === "Text"), false);
      assert.deepEqual(calls, []); if (!disabled) { tree.props.onPress(); assert.deepEqual(calls, ["press"]); }
    }
  }
});

test("real Settings buttons and selected choices move disabled alpha behind their labels without changing events or44pt targets", () => {
  for (const os of ["ios", "web"]) {
    const f = fixture(os), i18n = { useT: () => ({ locale: "en" }) }, primitives = f.loadOwner("src/uiuxfinal/Primitives.tsx", { "@/src/i18n": i18n });
    const settings = f.loadOwner("src/uiuxfinal/Settings.tsx", { "@/src/i18n": i18n, "./Primitives": primitives, "@/src/keyboard/AppKeyboard": { NuriTextInput: "Input", useAppKeyboardVisible: () => false }, "expo-image": { Image: "Image" }, "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 34 }) }, "@/src/uiux48/Primitives": { NuriIcon: "Icon" }, "@/src/uiux48/inputLayout": { singleLineInputStyle: {}, multilineInputStyle: {} } });
    for (const disabled of [false, true]) for (const selected of [false, true]) {
      const calls = [], label = "Settings choice", tree = f.render(settings.SettingsChoice({ label, selected, disabled, testID: "choice", onPress: () => calls.push("choice") })), material = nodes(tree).find(node => node.props?.testID === "choice-material"), text = nodes(tree).find(node => node.type === "Text");
      assert.equal(tree.props.disabled, disabled); assert.deepEqual(tree.props.accessibilityState, { checked: selected, disabled }); assert.equal(flatten(tree.props.style({ pressed: false })).minHeight, 44); assert.equal(flatten(tree.props.style({ pressed: false })).opacity, 1);
      const fill = flatten(children(material)[1].props.style); assert.equal(fill.backgroundColor, selected ? "#C1A0DD" : "rgba(255,248,242,.75)"); assert.equal(fill.opacity, disabled ? .45 : 1); assert.equal(text.props.children, label); assert.equal(flatten(text.props.style).opacity, undefined); assert.equal(flatten(text.props.style).color, selected ? "white" : "#4A454D"); assert.deepEqual(calls, []); if (!disabled) { tree.props.onPress(); assert.deepEqual(calls, ["choice"]); }
      const button = f.render(settings.SettingsButton({ label: "Settings action", disabled, secondary: selected, testID: "settings-action", onPress: () => calls.push("action") })), buttonMaterial = nodes(button).find(node => node.props?.testID === "settings-action-material"), buttonFill = flatten(children(buttonMaterial)[1].props.style);
      assert.equal(flatten(button.props.style({ pressed: false })).minHeight, 50); assert.equal(flatten(button.props.style({ pressed: false })).opacity, 1); assert.equal(buttonFill.backgroundColor, selected ? disabled ? "rgba(255,250,244,.375)" : "rgba(255,250,244,.75)" : disabled ? "rgba(235,129,131,.2)" : "#EB8183"); assert.equal(nodes(button).find(node => node.type === "Text").props.children, "Settings action"); assert.equal(button.props.disabled, disabled);
    }
  }
});

test("shared button helper is local presentation only and does not import permission, input, account or service owners", () => {
  const f = fixture();
  assert.deepEqual(new Set(f.imports), new Set(["react", "react/jsx-runtime", "react-native", "expo-blur"]));
  assert.doesNotMatch(readFileSync(source, "utf8"), /\b(?:fetch|XMLHttpRequest|localStorage|AsyncStorage|SecureStore|Linking|requestPermissionsAsync|onMessage)\b/);
});
