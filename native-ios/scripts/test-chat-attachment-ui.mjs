import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const base = "src/uiux48/", read = path => readFileSync(path, "utf8");
const jsx = (type, props) => ({ type, props });
const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const expand = node => !node || typeof node !== "object" ? node : Array.isArray(node) ? node.map(expand) : typeof node.type === "function" ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props?.children) } };
const flat = style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
const find = (tree, id) => walk(tree).find(node => node.props?.testID === id);
function fixture(locale = "zh-CN", platform = "web") {
  const deps = {
    "./ButtonMaterial": { FrostedPressable: "Pressable", ButtonBackdrop: "ButtonBackdrop" },
    "@/src/uiuxfinal/ButtonMaterial": { FrostedPressable: "Pressable", ButtonBackdrop: "ButtonBackdrop" },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", Platform: { OS: platform }, StyleSheet: { create: x => x, flatten: flat, absoluteFill: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 } } },
    "expo-image": { Image: "Image" }, "expo-blur": { BlurView: "BlurView" },
    "@/src/i18n": { useT: () => ({ locale }) },
  };
  function load(path) {
    const module = { exports: {} }, source = ts.transpileModule(read(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function("require", "module", "exports", source)(name => {
      if (name.startsWith("@/assets/")) return name;
      if (name === "@/src/uiuxfinal/Primitives") return load("src/uiuxfinal/Primitives.tsx");
      assert.ok(name in deps, "Unexpected runtime dependency " + name);
      return deps[name];
    }, module, module.exports);
    return module.exports;
  }
  return { menu: load(base + "ChatAttachmentMenu.tsx"), tray: load(base + "ChatAttachmentTray.tsx") };
}
const photo = Object.freeze({ id: "photo1", kind: "image", uri: "file:///user-selected-photo.heic", image: Object.freeze({ previewUri: "file:///prepared-photo.jpg", dataUri: "data:image/jpeg;base64,fixture", width: 300, height: 400 }) });
const video = Object.freeze({ id: "video1", kind: "video", uri: "file:///user-selected-video.mov", previewSource: Object.freeze({ uri: "file:///real-video-thumbnail.jpg" }), durationMs: 12_900 });

test("menu is a60×104 cream64% material body above the measured plus, with no Modal or clipped outer shadow", () => {
  const { menu } = fixture(), calls = [], tree = expand(menu.ChatAttachmentMenu({ anchor: { x: 24, y: 772, width: 60, height: 60 }, onCamera: () => calls.push("camera"), onLibrary: () => calls.push("library"), onDismiss: () => calls.push("dismiss") }));
  assert.deepEqual(tree.props.style, { position: "absolute", left: 24, top: 656 });
  const surface = walk(tree).find(node => flat(node.props?.style).width === 60 && flat(node.props?.style).height === 104), style = flat(surface.props.style);
  assert.equal(style.borderRadius, 24);assert.equal(style.boxShadow, "0px 1px 15px rgba(92,86,98,.18)");assert.equal(style.overflow, undefined);
  assert.ok(walk(tree).some(node => flat(node.props?.style).backdropFilter === "blur(20px)"));assert.ok(walk(tree).some(node => flat(node.props?.style).backgroundColor === "rgba(255,250,242,.64)"));
  assert.ok(walk(tree).some(node => { const style = flat(node.props?.style);return style.padding === 8 && style.height === 104; }));
  assert.ok(!walk(tree).some(node => /Modal|Keyboard/.test(String(node.type))));assert.deepEqual(calls, []);
  assert.deepEqual(menu.chatAttachmentMenuPosition({ x: 40, y: 400, width: 44, height: 44 }), { position: "absolute", left: 32, top: 284 });
  assert.deepEqual(menu.chatAttachmentMenuPosition(), { position: "absolute", left: 0, bottom: 12 });assert.deepEqual(menu.chatAttachmentMenuPosition({ x: NaN, y: 400, width: 44, height: 44 }), { position: "absolute", left: 0, bottom: 12 });
});
test("menu actions use original20pt icons in separate44pt targets and dispatch only explicit controlled callbacks", () => {
  for (const locale of ["zh-CN", "zh-TW", "en"]) {
    const { menu } = fixture(locale), calls = [], tree = expand(menu.ChatAttachmentMenu({ onCamera: () => calls.push("camera"), onLibrary: () => calls.push("library"), onDismiss: () => calls.push("dismiss"), testID: "media" }));
    for (const [name, suffix] of [["camera", "camera"], ["library", "album"]]) {
      const button = find(tree, "media-" + name), icon = walk(button).find(node => node.type === "Image");assert.equal(button.props.accessibilityRole, "button");assert.equal(button.props.style.width, 44);assert.equal(button.props.style.height, 44);assert.deepEqual(icon.props.style, { width: 20, height: 20 });assert.ok(icon.props.source.endsWith("chat-attachment-" + suffix + "-20.svg"));assert.equal(icon.props.accessible, false);button.props.onPress();
    }
    assert.deepEqual(calls, ["camera", "library"]);tree.props.onAccessibilityEscape();assert.deepEqual(calls, ["camera", "library", "dismiss"]);
  }
});
test("tray keeps72pt real-media covers,12pt spacing and horizontal overflow without owning composer or editor geometry", () => {
  const { tray } = fixture(), attachments = Object.freeze([photo, video]), calls = [], tree = expand(tray.ChatAttachmentTray({ attachments, onRemove: id => calls.push(id), onPreview: value => calls.push(value) }));
  assert.equal(tree.type, "ScrollView");assert.equal(tree.props.horizontal, true);assert.equal(tree.props.showsHorizontalScrollIndicator, false);assert.deepEqual(tree.props.contentContainerStyle, { height: 72, gap: 12, alignItems: "flex-start" });
  const p = find(tree, "chat-attachment-tray-thumbnail-photo1"), v = find(tree, "chat-attachment-tray-thumbnail-video1");assert.deepEqual(p.props.source, { uri: "file:///prepared-photo.jpg" });assert.equal(v.props.source, video.previewSource);
  for (const image of [p, v]) { assert.deepEqual(image.props.style, { width: 72, height: 72, borderRadius: 12 });assert.equal(image.props.contentFit, "cover");assert.equal(image.props.cachePolicy, "memory"); }
  for (const attachment of attachments) { const item = find(tree, "chat-attachment-tray-item-" + attachment.id), style = item.props.style;assert.equal(style.width, 72);assert.equal(style.height, 72);assert.equal(style.borderRadius, 12);assert.equal(style.flexShrink, 0); }
  assert.equal(tray.ChatAttachmentTray({ attachments: [], onRemove: () => {}, onPreview: () => {} }), null);assert.deepEqual(calls, []);
});
test("remove preserves24pt visual and uses only safe upward/rightward hit extension rather than covering video play", () => {
  const { tray } = fixture(), calls = [], tree = expand(tray.ChatAttachmentTray({ attachments: [video], onRemove: id => calls.push(["remove", id]), onPreview: value => calls.push(["preview", value]) }));
  const remove = find(tree, "chat-attachment-tray-remove-video1"), preview = find(tree, "chat-attachment-tray-preview-video1"), item = find(tree, "chat-attachment-tray-item-video1");
  assert.deepEqual(remove.props.style, { position: "absolute", top: 4, right: 4, width: 24, height: 24 });assert.deepEqual(remove.props.hitSlop, { top: 4, right: 4, bottom: 0, left: 0 });assert.ok(item.props.children.includes(remove));assert.ok(!walk(preview).includes(remove));
  const surface = walk(remove).find(node => node.type === "View" && flat(node.props?.style).width === 24), icon = walk(remove).find(node => node.type === "Image");assert.equal(flat(surface.props.style).height, 24);assert.equal(flat(surface.props.style).borderRadius, 12);assert.equal(flat(surface.props.style).top, undefined);assert.deepEqual(icon.props.style, { width: 20, height: 20 });assert.ok(icon.props.source.endsWith("chat-attachment-remove-20.svg"));
  // Derive native sibling hit regions from the actual rendered props, including
  // hitSlop clipped to the72pt parent. The last sibling wins only in that region.
  const r = remove.props.style, h = remove.props.hitSlop, left = 72 - r.right - r.width;
  const region = { left: Math.max(0, left - h.left), top: Math.max(0, r.top - h.top), right: Math.min(72, left + r.width + h.right), bottom: Math.min(72, r.top + r.height + h.bottom) };
  assert.deepEqual(region, { left: 44, top: 0, right: 72, bottom: 28 });
  const hit = (x, y) => x >= region.left && x < region.right && y >= region.top && y < region.bottom ? remove : preview;
  assert.equal(hit(36,32), preview, "Figma play center must preview, never delete");assert.equal(hit(56,16), remove, "X center must remove");
  hit(36,32).props.onPress();assert.deepEqual(calls, [["preview", video]]);hit(56,16).props.onPress();assert.deepEqual(calls, [["preview", video], ["remove", "video1"]]);
  assert.equal(hit(40,32), preview);assert.equal(hit(56,40), preview);
});
test("the full72pt preview also exposes a dedicated accessible remove action without triggering preview", () => {
  for (const locale of ["zh-CN","zh-TW","en"]) {
    const { tray } = fixture(locale), calls = [], tree = expand(tray.ChatAttachmentTray({ attachments:[photo], onRemove:id=>calls.push(["remove",id]), onPreview:value=>calls.push(["preview",value]) })), preview = find(tree,"chat-attachment-tray-preview-photo1");
    assert.equal(preview.props.style.width,72);assert.equal(preview.props.style.height,72);assert.equal(preview.props.accessibilityActions[0].name,"remove");assert.ok(preview.props.accessibilityActions[0].label);
    preview.props.onAccessibilityAction({nativeEvent:{actionName:"remove"}});assert.deepEqual(calls,[["remove","photo1"]]);preview.props.onAccessibilityAction({nativeEvent:{actionName:"unrecognised"}});assert.equal(calls.length,1);
    const disabled = expand(tray.ChatAttachmentTray({ attachments:[photo], disabled:true, onRemove:()=>calls.push("bad"), onPreview:()=>calls.push("bad") }));find(disabled,"chat-attachment-tray-preview-photo1").props.onAccessibilityAction({nativeEvent:{actionName:"remove"}});assert.equal(calls.length,1);
  }
});
test("video play and real duration retain the30pt/20pt and42×18 design slots without fabricating missing metadata", () => {
  const { tray } = fixture(), tree = expand(tray.ChatAttachmentTray({ attachments: [video], onRemove: () => {}, onPreview: () => {} })), play = find(tree, "chat-attachment-tray-play-video1"), duration = find(tree, "chat-attachment-tray-duration-video1");
  assert.deepEqual(play.props.style, { position: "absolute", left: 21, top: 17, width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" });
  const material = find(tree, "chat-attachment-tray-play-material-video1");assert.equal(material.type, "ButtonBackdrop");assert.equal(material.props.color, "rgba(227,214,237,.96)");assert.equal(material.props.radius, 15);assert.equal(material.props.blurRadius, 40);assert.equal(walk(material).some(node => node.type === "Image"), false);
  const icon = walk(play).find(node => node.type === "Image");assert.deepEqual(icon.props.style, { width: 20, height: 20 });assert.ok(icon.props.source.endsWith("chat-attachment-play-20.svg"));
  const style = flat(duration.props.style);assert.equal(style.width, 42);assert.equal(style.height, 18);assert.equal(style.top, 50);assert.equal(style.right, 4);assert.equal(style.borderRadius, 6);const text = walk(duration).find(node => node.type === "Text");assert.equal(text.props.children, "0:12");assert.equal(flat(text.props.style).width, 22);assert.equal(flat(text.props.style).lineHeight, 14);
  for (const [input, output] of [[undefined, "--:--"], [NaN, "--:--"], [Infinity, "--:--"], [-1, "--:--"], [0, "0:00"], [12599, "0:12"], [60000, "1:00"], [3600000, "60:00"]]) assert.equal(tray.formatChatAttachmentDuration(input), output);
  const missing = expand(tray.ChatAttachmentTray({ attachments: [{ id: "missing", kind: "video", uri: "file:///not-an-image.mov" }], onRemove: () => {}, onPreview: () => {} }));assert.equal(find(missing, "chat-attachment-tray-thumbnail-missing"), undefined);assert.ok(walk(missing).some(node => node.type === "Text" && node.props.children === "--:--"));
});
test("disabled actions, stable IDs and all locales preserve controlled media without requests or persistence", () => {
  for (const locale of ["zh-CN", "zh-TW", "en"]) { const { tray } = fixture(locale), calls = [], tree = expand(tray.ChatAttachmentTray({ attachments: [photo, video], onRemove: () => calls.push("remove"), onPreview: () => calls.push("preview"), disabled: true }));for (const id of ["photo1", "video1"]) for (const action of ["preview", "remove"]) { const button = find(tree, `chat-attachment-tray-${action}-${id}`);assert.equal(button.props.disabled, true);assert.equal(button.props.accessibilityState.disabled, true);assert.equal(button.props.accessibilityRole, "button");assert.ok(button.props.accessibilityLabel.length);button.props.onPress(); }assert.deepEqual(calls, []); }
  for (const name of ["ChatAttachmentMenu.tsx", "ChatAttachmentTray.tsx"]) { const source = read(base + name);assert.doesNotMatch(source, /\bfetch\(|\basync\b|ImagePicker|expo-video|expo-file-system|AsyncStorage|https:\/\/www\.figma\.com|AttachmentImageSelected|Living.room|upload\(/); }
});
test("the four static artwork files are nonempty exact20pt exports and every runtime callsite retains that geometry", () => {
  for (const name of ["camera", "album", "remove", "play"]) { const file = `assets/final-flow-20261101/chat-attachment-${name}-20.svg`, source = read(file), root = source.match(/^<svg[^>]*>/)?.[0];assert.ok(statSync(file).size > 0);assert.ok(root.includes('width="20"') && root.includes('height="20"') && root.includes('viewBox="0 0 20 20"')); }
  const { menu, tray } = fixture("zh-CN", "ios"), tree = expand(menu.ChatAttachmentMenu({ onCamera: () => {}, onLibrary: () => {}, onDismiss: () => {} }));assert.ok(walk(tree).some(node => node.type === "BlurView" && node.props.intensity === 40));
  const t = expand(tray.ChatAttachmentTray({ attachments: [video], onRemove: () => {}, onPreview: () => {} }));for (const icon of walk(t).filter(node => node.type === "Image" && typeof node.props.source === "string")) assert.deepEqual(icon.props.style, { width: 20, height: 20 });
});
