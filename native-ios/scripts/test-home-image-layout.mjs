import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Render the actual Home component with inert effects: no auth, AI or network
// operation is performed. Verify styles against the bundled PNG's IHDR size.
const source = readFileSync(new URL("../app/(tabs)/index.tsx", import.meta.url), "utf8");
const png = readFileSync(new URL("../assets/images/homepage/figma-mascot.png", import.meta.url));
assert.equal(png.subarray(1, 4).toString(), "PNG");
const assetWidth = png.readUInt32BE(16), assetHeight = png.readUInt32BE(20);
const aspect = assetWidth / assetHeight;
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function loadHelper(path) {
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)((name) => { throw new Error(`unexpected helper dependency ${name}`); }, module, module.exports);
  return module.exports;
}
const jsx = (type, props) => ({ type, props });
let viewportWidth = 390;
const mocks = {
  react: { useCallback: (fn) => fn, useEffect: () => {}, useRef: (value) => ({ current: value }) },
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "@/src/useAccountState": { useAccountState: (value) => [typeof value === "function" ? value() : value, () => {}], useAccountScope: () => ({ generation: 0, capture: () => 0, current: () => true }) },
  "react-native": { View: "View", Text: "Text", ScrollView: "ScrollView", Pressable: "Pressable", Image: "Image", Platform: { OS: "ios" }, StyleSheet: { create: (styles) => styles, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: viewportWidth }) },
  "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 24, bottom: 34 }) },
  "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
  "expo-linear-gradient": { LinearGradient: "Gradient" }, "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-router": { useFocusEffect: () => {}, useRouter: () => ({ push() {}, replace() {} }) },
  "@react-navigation/native": { useIsFocused: () => true }, "@/src/api": { api: {} },
  "@/src/components/Toast": { __esModule: true, default: "Toast" },
  "@/src/components/DailyPostCard": { __esModule: true, default: "DailyPostCard" },
  "@/src/components/DailyVideoCard": { __esModule: true, default: "DailyVideoCard" },
  "@/src/components/RequestFailureNotice": { __esModule: true, default: "RequestFailureNotice" },
  "@/src/i18n": { useT: () => ({ t: (text) => text, locale: "zh-CN" }) },
  "@/src/aiPermissionNavigation": loadHelper("../src/aiPermissionNavigation.ts"),
  "@/src/requestFailure": loadHelper("../src/requestFailure.ts"),
};
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)((name) => {
  if (name.startsWith("@/assets/")) return name;
  assert.ok(name in mocks, "unexpected dependency " + name);
  return mocks[name];
}, loaded, loaded.exports);
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const flatten = (style) => Object.assign({}, ...(Array.isArray(style) ? style.filter(Boolean) : [style]));

for (const width of [280, 320, 375, 390, 402, 430, 768]) test("Home preserves mascot pixels and card margins at viewport " + width, () => {
  viewportWidth = width;
  const tree = loaded.exports.default(), rendered = nodes(tree);
  const phone = Math.min(width, 402);
  assert.equal(tree.props.edges[0], "top");
  const canvas = rendered.find((node) => node.type === "View" && flatten(node.props?.style).width === phone);
  assert.ok(canvas, "phone canvas tracks its capped viewport width");
  const image = rendered.find((node) => node.props?.testID === "home-mascot-image");
  const crop = rendered.find((node) => node.props?.testID === "home-mascot-crop");
  const stage = rendered.find((node) => node.props?.testID === "home-nuri-card");
  const card = rendered.find((node) => node.type === "DailyPostCard");
  assert.equal(image.props.resizeMode, "contain");
  assert.equal(image.props.style.width, "100%");
  assert.equal(image.props.style.aspectRatio, aspect, "source pixels, not card dimensions, own the ratio");
  assert.equal(image.props.style.height, undefined, "do not force the second image axis");
  assert.ok(Object.hasOwn(image.props.style, "height"), "explicitly unset RN Image's intrinsic source pixel height");
  assert.equal(flatten([{ width: assetWidth, height: assetHeight }, image.props.style]).height, undefined);
  assert.equal(crop.props.style.bottom, undefined, "the crop must not force image height");
  assert.equal(crop.props.pointerEvents, "none", "decoration cannot intercept card taps");
  const stageStyle = stage.props.style({ pressed: false })[0];
  assert.equal(stageStyle.marginHorizontal, 16);
  const stageWidth = phone - 2 * stageStyle.marginHorizontal;
  const renderedWidth = stageWidth * 0.5 - crop.props.style.right;
  const renderedHeight = renderedWidth / image.props.style.aspectRatio;
  assert.ok(renderedWidth > 0 && renderedHeight > 0);
  assert.ok(Math.abs(renderedWidth / renderedHeight - aspect) < 1e-12);
  assert.equal(card.props.width, Math.max(0, phone - 60));
  assert.ok(card.props.width + 17 <= phone, "daily card must fit its viewport and left inset");
  const nav = rendered.find((node) => node.props?.testID === "home-bottom-navigation");
  assert.equal(flatten(nav.props.style).paddingBottom, 34, "native bottom safe area is preserved");
  assert.ok(rendered.filter((node) => node.type === "Image").every((node) => node.props.resizeMode !== "stretch"));
});
test("viewport changes recompute width without introducing a fixed mascot height", () => {
  viewportWidth = 320; const narrow = nodes(loaded.exports.default()).find((node) => node.type === "DailyPostCard");
  viewportWidth = 430; const wide = nodes(loaded.exports.default()).find((node) => node.type === "DailyPostCard");
  assert.equal(narrow.props.width, 260); assert.equal(wide.props.width, 342);
});
