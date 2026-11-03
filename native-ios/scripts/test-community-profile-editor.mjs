import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const path = "src/uiuxfinal/CommunityProfileEditor.tsx";
const jsx = (type, props) => ({ type, props });
const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const expand = node => !node || typeof node !== "object" ? node : Array.isArray(node) ? node.map(expand) : typeof node.type === "function" ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props?.children) } };
const find = (tree, id) => walk(tree).find(node => node.props?.testID === id);

function fixture(locale = "zh-CN") {
  let cursor = 0;
  const state = [];
  const dependencies = {
    react: { useState(initial) { const slot = cursor++; if (!(slot in state)) state[slot] = initial; return [state[slot], value => state[slot] = value]; } },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Pressable: "Pressable", TextInput: "Input" },
    "expo-image": { Image: "Image" },
    "@/src/i18n": { useT: () => ({ locale }), translate: (_locale, value) => value },
    "./Primitives": { FinalText: "Text", FINAL_COLOR: { ink: "#4A454D", secondary: "#706A74", selected: "#C1A0DD", base: "#FFFAF2" } },
  };
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "module", "exports", source)(name => {
    if (name.startsWith("@/assets/")) return name;
    assert.ok(name in dependencies, `Unexpected dependency ${name}; this fixture has no service transport`);
    return dependencies[name];
  }, module, module.exports);
  const calls = [];
  const props = { displayName: "Nina", city: "Savannah, GA, 31401", about: "我知道托育附近一家不错的小餐馆。", onAboutChange: value => calls.push(["about", value]), selectedIntents: [1, 4], onToggleIntent: index => calls.push(["intent", index]) };
  return { props, calls, render(overrides = {}) { cursor = 0; return expand(module.exports.CommunityProfileEditor({ ...props, ...overrides })); } };
}

test("editor is a controlled card body with the measured Figma insets, not a second page or save owner", () => {
  const f = fixture(), tree = f.render();
  assert.deepEqual(tree.props.style, { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 19, gap: 16 });
  assert.equal(tree.props.style.height, undefined);
  assert.equal(walk(tree).some(node => /Scroll|Surface|Save|Keyboard|SafeArea/.test(String(node.type))), false);
  assert.deepEqual(f.calls, []);
  assert.equal(find(tree, "final-profile-editing-status").props.children, "编辑中");
});

test("identity and original 104pt portrait remain visible during inline editing", () => {
  const tree = fixture().render(), portrait = find(tree, "final-profile-editor-portrait"), images = walk(portrait).filter(node => node.type === "Image");
  assert.deepEqual(portrait.props.style, { width: 104, height: 104, flexShrink: 0 });
  assert.equal(images[0].props.source, "@/assets/final-flow-20261101/community-profile-background.svg");
  assert.deepEqual(images[0].props.style, { width: 104, height: 104 });
  assert.equal(images[1].props.source, "@/assets/final-flow-20261101/community-profile-head.png");
  assert.deepEqual(images[1].props.style, { position: "absolute", left: 10.4, top: 32.0667, width: 82.3333, height: 71.9333 });
  for (const text of ["Nina", "Savannah, GA, 31401", "我的生活", "我的小孩", "生活节奏", "正在经历学龄前阶段", "喜欢安静的周末活动"]) assert.ok(walk(tree).some(node => node.props?.children === text), text);
});

test("caller-supplied original portrait is reused without an additional fallback or upload interaction", () => {
  const avatar = jsx("CallerOriginalPortrait", { size: 104 }), tree = fixture().render({ avatar }), portrait = find(tree, "final-profile-editor-portrait");
  assert.equal(portrait.props.children.type, "CallerOriginalPortrait");
  assert.equal(portrait.props.children.props.size, 104);
  assert.equal(walk(portrait).some(node => node.type === "Image" || node.type === "Pressable"), false);
});

test("six chips retain design order and reducer indices, with only controlled selection and bounded 44pt targets", () => {
  const f = fixture(), tree = f.render(), group = find(tree, "final-profile-editor-intents"), chips = walk(group).filter(node => node.type === "Pressable");
  assert.deepEqual(chips.map(node => node.props.testID), [1, 4, 5, 0, 2, 3].map(index => `final-profile-intent-${index}`));
  assert.deepEqual(chips.map(node => node.props.style.width), [123.333, 88, 88, 123.333, 88, 86]);
  assert.deepEqual(chips.filter(node => node.props.accessibilityState.checked).map(node => node.props.testID), ["final-profile-intent-1", "final-profile-intent-4"]);
  assert.equal(group.props.style.gap, 8);
  assert.equal(group.props.style.paddingVertical, 4);
  for (const chip of chips) {
    assert.equal(chip.props.accessibilityRole, "checkbox");
    assert.equal(chip.props.style.minHeight, 36);
    assert.equal(chip.props.style.borderRadius, 18);
    assert.deepEqual(chip.props.hitSlop, { top: 4, bottom: 4 });
    assert.equal(chip.props.style.minHeight + chip.props.hitSlop.top + chip.props.hitSlop.bottom, 44);
    chip.props.onPress();
  }
  assert.deepEqual(f.calls, [1, 4, 5, 0, 2, 3].map(index => ["intent", index]));
  assert.equal(walk(f.render({ selectedIntents: [] })).filter(node => node.type === "Pressable").some(node => node.props.accessibilityState.checked), false, "The component must never privately seed example selection");
});

test("44pt about editor preserves supplied text, multiline/Chinese composition and content growth", () => {
  const f = fixture();
  let input = find(f.render(), "final-profile-about");
  assert.equal(input.props.value, f.props.about);
  assert.equal(input.props.onChangeText, f.props.onAboutChange);
  assert.equal(input.props.multiline, true);
  assert.equal(input.props.style.height, 44);
  assert.equal(input.props.style.fontSize, 14);
  assert.equal(input.props.style.lineHeight, 20);
  assert.equal(input.props.style.textAlignVertical, "top");
  assert.notEqual(input.props.scrollEnabled, false);
  input.props.onChangeText("  中文拼音 composition\n保留第二行  ");
  assert.deepEqual(f.calls, [["about", "  中文拼音 composition\n保留第二行  "]]);
  for (const [height, expected] of [[96.2, 97], [500, 164], [20, 44]]) {
    input.props.onContentSizeChange({ nativeEvent: { contentSize: { height } } });
    input = find(f.render(), "final-profile-about");
    assert.equal(input.props.style.height, expected);
  }
});

test("all supported languages retain editable data and scalable, wrapping controls without clipped text", () => {
  for (const locale of ["zh-CN", "zh-TW", "en"]) {
    const f = fixture(locale), tree = f.render({ displayName: "Original 姓名", city: "Original city", about: "Original\n原文", selectedIntents: [2] });
    assert.equal(find(tree, "final-profile-about").props.value, "Original\n原文");
    for (const node of walk(tree).filter(node => node.type === "Text" || node.type === "Input")) {
      assert.notEqual(node.props.allowFontScaling, false);
      assert.equal(node.props.numberOfLines, undefined);
    }
    for (const chip of walk(find(tree, "final-profile-editor-intents")).filter(node => node.type === "Pressable")) assert.equal(chip.props.style.height, undefined);
    assert.deepEqual(f.calls, []);
  }
});

test("portrait source assets stay nonempty with their original 104pt / 2x export dimensions", () => {
  const svgPath = "assets/final-flow-20261101/community-profile-background.svg", pngPath = "assets/final-flow-20261101/community-profile-head.png";
  assert.ok(statSync(svgPath).size > 0);
  assert.ok(statSync(pngPath).size > 0);
  const root = readFileSync(svgPath, "utf8").match(/<svg\b[^>]*>/)?.[0];
  assert.match(root, /width="104"/);
  assert.match(root, /height="104"/);
  const png = readFileSync(pngPath);
  assert.equal(png.readUInt32BE(16), 165);
  assert.equal(png.readUInt32BE(20), 144);
});

test("editor source cannot perform account, consent, invitation or network operations", () => {
  const source = readFileSync(path, "utf8");
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest)\b|from\s+["'][^"']*(?:api|auth|storage|consent|nativePush)|https?:\/\//i);
  assert.doesNotMatch(source, /onSave|useSafeAreaInsets|KeyboardAvoidingView|ScrollView/);
});
