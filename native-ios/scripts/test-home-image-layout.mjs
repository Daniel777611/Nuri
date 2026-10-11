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
function loadComponent(path) {
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)((name) => {
    if (name === "@/src/externalContent") return loadHelper("../src/externalContent.ts");
    if (name === "@/src/nuriResourceGuide") return loadHelper("../src/nuriResourceGuide.ts");
    if (name === "@/src/resourceSummary") return loadHelper("../src/resourceSummary.ts");
    assert.ok(name in mocks, "unexpected component dependency " + name);
    return mocks[name];
  }, module, module.exports);
  return module.exports.default;
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
  "@/src/i18n": { useT: () => ({ t: (text, variables = {}) => text.replace(/\{(\w+)\}/g, (_all, key) => String(variables[key] ?? key)), locale: "zh-CN" }) },
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

for (const kind of ["post", "video"]) test(`ready ${kind} card preserves geometry and AI preview without loading source images or verbatim text`, () => {
  const Component = loadComponent(`../src/components/Daily${kind === "post" ? "Post" : "Video"}Card.tsx`);
  const thirdPartyText = "THIRD_PARTY_COPY_MUST_STAY_AT_SOURCE";
  const card = {
    id: "source-card", card_id: "source-context", platform: kind === "post" ? "facebook" : "youtube",
    nickname: "Demo Parent", audience: "parent", author_kind: "parent", source_url: "https://example.com/original",
    question: "AI_SEARCH_QUESTION?", headline: "AI_SEARCH_HEADLINE.", excerpt: thirdPartyText,
    takeaways: ["AI_SEARCH_POINT."], title: thirdPartyText, display_title: thirdPartyText,
    summary: "AI_SEARCH_SUMMARY.", channel: thirdPartyText, thumbnail_url: "https://example.com/unverified.jpg",
    concern: "FAMILY_SLEEP_TOPIC", basis: "profile",
  };
  const tree = Component({ width: 330, nickname: "Demo Parent", status: "ready", card, onPress() {}, onRetry() {} });
  const rendered = nodes(tree);
  assert.ok(rendered.some((node) => node.type === "Pressable"), "source card must still be actionable");
  if (kind === "post") {
    assert.ok(rendered.some((node) => flatten(node.props?.style).height === 236), "the post card retains its established geometry");
  } else {
    assert.ok(rendered.some((node) => {
      const style = flatten(node.props?.style);
      return style.minHeight === 264 && style.height === undefined;
    }), "the video card allows its supplied AI preview to grow without a fixed-height crop");
    assert.equal(rendered.find((node) => node.props?.testID === "home-daily-video-external-title").props.numberOfLines, 2);
    assert.equal(rendered.find((node) => node.props?.testID === "home-daily-video-external-notice").props.numberOfLines, 2);
  }
  assert.ok(rendered.every((node) => node.type !== "Image"), "source thumbnails must not be independently downloaded");
  assert.doesNotMatch(JSON.stringify(tree), new RegExp(thirdPartyText), "source titles and excerpts must not leak through visible or accessibility copy");
  const guide = loadHelper("../src/nuriResourceGuide.ts").nuriResourceGuide({ concern: card.concern });
  const headlineID = kind === "post" ? "home-daily-post-question" : "home-daily-video-external-title";
  assert.equal(rendered.find((node) => node.props?.testID === headlineID).props.children, kind === "post" ? "AI_SEARCH_QUESTION?" : guide.headline,
    "daily card can use the supplied AI question, not a verbatim excerpt or video source title");
  if (kind === "video") {
    assert.equal(rendered.find((node) => node.props?.testID === "home-daily-video-external-notice").props.children, "AI_SEARCH_SUMMARY.");
    assert.match(JSON.stringify(tree), /FAMILY_SLEEP_TOPIC/);
  }
});

test("three-line post preview keeps its summary label inside the existing footer, without adding a 26px vertical row", () => {
  const Component = loadComponent("../src/components/DailyPostCard.tsx");
  const card = { id: "layout-post", platform: "threads", nickname: "Demo Parent", audience: "parent", basis: "profile",
    author_kind: "parent_post", source_url: "https://example.com/original", concern: "睡眠",
    question: "孩子在一个新的环境中如何慢慢建立起日常的生活节奏？".repeat(3), headline: "AI_SEARCH_HEADLINE." };
  const tree = Component({ width: 280, nickname: "Demo Parent", status: "ready", card, onPress() {}, onRetry() {} });
  const rendered = nodes(tree);
  const frame = rendered.find((node) => node.type === "Gradient"), frameStyle = flatten(frame.props.style);
  const question = rendered.find((node) => node.props?.testID === "home-daily-post-question");
  const label = rendered.find((node) => node.props?.testID === "home-daily-post-summary-label");
  const footer = rendered.find((node) => flatten(node.props?.style).minHeight === 55 && flatten(node.props?.style).flexDirection === "row");
  assert.ok(footer && nodes(footer).includes(label), "the label shares the already reserved footer height");
  assert.equal(frame.props.children.includes(label), false, "the label must not be an extra card-level vertical row");
  assert.equal(flatten(label.props.style).marginTop, undefined, "the old 8px extra row gap must not return");
  assert.equal(frameStyle.height, 236); assert.equal(question.props.numberOfLines, 3);
  const cta = nodes(footer).find((node) => node.type === "Text" && node.props.children === "查看摘要与来源");
  assert.equal(flatten(cta.props.style).flex, undefined, "a flex-filling CTA must not stretch its footer text stack");
  const footerTextHeight = flatten(label.props.style).lineHeight + (flatten(label.props.style).marginBottom || 0) + flatten(cta.props.style).lineHeight;
  assert.ok(footerTextHeight <= flatten(footer.props.style).minHeight);
  const tag = rendered.find((node) => flatten(node.props?.style).height === 32);
  const requiredHeight = frameStyle.paddingTop + flatten(tag.props.style).height
    + flatten(question.props.style).marginTop + question.props.numberOfLines * flatten(question.props.style).lineHeight
    + flatten(footer.props.style).minHeight + frameStyle.paddingBottom + 2 * frameStyle.borderWidth;
  assert.ok(requiredHeight <= frameStyle.height,
    `the three-line baseline content (${requiredHeight}px) must fit the ${frameStyle.height}px card without a separate label row`);
});

test("source-image removal does not remove user chat photos or camera/gallery input", () => {
  const chat = readFileSync(new URL("../app/chat/[id].tsx", import.meta.url), "utf8");
  assert.match(chat, /source=\{\{ uri: msg\.image_base64 \}\}/, "user-supplied chat images must remain");
  assert.match(chat, /source=\{\{ uri: pendingImage\.previewUri \}\}/, "the user's selected-photo preview must remain");
  assert.match(chat, /ImagePicker\.launchCameraAsync/, "camera capture must remain");
  assert.match(chat, /ImagePicker\.launchImageLibraryAsync/, "photo library selection must remain");
});
