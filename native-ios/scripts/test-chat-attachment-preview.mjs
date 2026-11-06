import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const path = "src/uiux48/ChatAttachmentPreview.tsx", read = file => readFileSync(file, "utf8");
const jsx = (type, props, key) => ({ type, props, key });
const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function fixture(locale = "en") {
  let slots = [], effects = new Map(), cursor = 0, pending = [], mounted, attachment = null, tree, playerID = 0;
  const log = [], players = [], appListeners = new Set();
  const react = {
    useState(initial) { const slot = cursor++;if (!(slot in slots)) slots[slot] = initial;return [slots[slot], value => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }]; },
    useRef(initial) { const slot = cursor++;return slots[slot] ??= { current: initial }; },
    useEffect(callback, deps) { const slot = cursor++, old = effects.get(slot);if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) pending.push(() => { old?.cleanup?.();effects.set(slot, { deps, cleanup: callback() }); }); },
  };
  function useVideoPlayer(source, setup) {
    const ref = react.useRef(null);
    if (!ref.current) {
      const listeners = new Map(), id = ++playerID;
      const player = { id, source, released: false, loop: true, staysActiveInBackground: true, showNowPlayingNotification: true, allowsExternalPlayback: true,
        play() { if (this.released) throw new Error("released");log.push(["play", id]);this.emit("playingChange", { isPlaying: true }); },
        pause() { if (this.released) { log.push(["pause-after-release", id]);throw new Error("released"); }log.push(["pause", id]); },
        release() { assert.equal(this.released, false, "No double-release");this.released = true;listeners.clear();log.push(["release", id]); },
        addListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set());listeners.get(name).add(callback);return { remove: () => { listeners.get(name)?.delete(callback); } }; },
        emit(name, event) { for (const listener of listeners.get(name) ?? []) listener(event); },
      };
      log.push(["create", id]);setup(player);players.push(player);ref.current = player;
    }
    const player = ref.current;
    // Mirror the installed hook's useReleasingSharedObject auto-cleanup.
    react.useEffect(() => () => player.release(), []);
    return player;
  }
  const deps = {
    "@/src/uiuxfinal/ButtonMaterial": { FrostedPressable: "Pressable", ButtonBackdrop: "ButtonBackdrop" },
    react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Modal: "Modal", Pressable: "Pressable", AppState: { addEventListener: (_name, callback) => { appListeners.add(callback);return { remove: () => appListeners.delete(callback) }; } } },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" }, "expo-image": { Image: "Image" }, "expo-video": { VideoView: "VideoView", useVideoPlayer },
    "@/src/i18n": { useT: () => ({ locale }) }, "@/src/uiuxfinal/Primitives": { FinalText: "Text" },
  };
  const module = { exports: {} }, code = ts.transpileModule(read(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "module", "exports", code)(name => { if (name.startsWith("@/assets/")) return name;assert.ok(name in deps, "Unexpected service/transport dependency " + name);return deps[name]; }, module, module.exports);
  const expand = node => !node || typeof node !== "object" ? node : Array.isArray(node) ? node.map(expand) : typeof node.type === "function" ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  const unmount = () => { for (const effect of effects.values()) effect.cleanup?.();effects = new Map();slots = [];mounted = undefined; };
  return {
    log, players,
    render(next = attachment) { attachment = next;const element = module.exports.ChatAttachmentPreview({ attachment, onClose: () => log.push(["close"]) });if (!element) { if (mounted) unmount();tree = null;return tree; }if (mounted && (mounted.type !== element.type || mounted.key !== element.key)) unmount();mounted = element;cursor = 0;pending = [];tree = expand(element);pending.forEach(effect => effect());return tree; },
    find: id => walk(tree).find(node => node.props?.testID === id), modal: () => walk(tree).find(node => node.type === "Modal"), get player() { return players.at(-1); },
    background(next) { for (const callback of appListeners) callback(next); }, get appListenerCount() { return appListeners.size; }, unmount,
  };
}
const photo = Object.freeze({ id: "photo", kind: "image", uri: "file:///selected.heic", image: Object.freeze({ previewUri: "file:///bounded-private-preview.jpg", dataUri: "data:image/jpeg;base64,private", width: 400, height: 600 }) });
const video = Object.freeze({ id: "video", kind: "video", uri: "file:///private-video.mov" });

test("null has no Modal/player and an image uses its bounded dynamic URI with contain/memory-only preview", () => {
  const f = fixture();assert.equal(f.render(null), null);assert.equal(f.players.length, 0);f.render(photo);const image = f.find("chat-attachment-preview-image");assert.deepEqual(image.props.source, { uri: photo.image.previewUri });assert.equal(image.props.contentFit, "contain");assert.equal(image.props.cachePolicy, "memory");assert.deepEqual(image.props.style, { width: "100%", height: "100%" });assert.equal(f.players.length, 0);
  f.render({ ...photo, id: "other", uri: "file:///other.png", image: undefined });assert.deepEqual(f.find("chat-attachment-preview-image").props.source, { uri: "file:///other.png" });assert.equal(f.players.length, 0);
});
test("all preview kinds have full-screen black safe-area and accessible44pt close; the image error does not expose private paths", () => {
  for (const locale of ["zh-CN", "zh-TW", "en"]) { const f = fixture(locale), tree = f.render(photo), safe = f.find("chat-attachment-preview"), close = f.find("chat-attachment-preview-close");assert.equal(f.modal().props.presentationStyle, "fullScreen");assert.equal(safe.props.style.backgroundColor, "black");assert.deepEqual(safe.props.edges, ["top", "bottom", "left", "right"]);assert.equal(close.props.style.width, 44);assert.equal(close.props.style.height, 44);assert.equal(close.props.accessibilityRole, "button");assert.ok(close.props.accessibilityLabel);close.props.onPress();assert.deepEqual(f.log, [["close"]]);assert.equal(f.modal().props.onDismiss, undefined);
    f.find("chat-attachment-preview-image").props.onError({ message: "private file:///secret.heic" });const failed = f.render();assert.equal(f.find("chat-attachment-preview-image"), undefined);assert.ok(walk(failed).some(node => node.type === "Text" && /could not|无法|無法/.test(String(node.props.children))));assert.doesNotMatch(JSON.stringify(f.log), /secret|data:image|bounded-private/);assert.ok(tree);
  }
});
test("video is paused on creation, never autoplayed and starts only through an explicit play or native-control event", () => {
  const f = fixture();f.render(video);assert.deepEqual(f.log, [["create", 1], ["pause", 1]]);assert.deepEqual(f.player.source, { uri: video.uri, useCaching: false });for (const key of ["loop", "staysActiveInBackground", "showNowPlayingNotification", "allowsExternalPlayback"]) assert.equal(f.player[key], false);
  const view = f.find("chat-attachment-preview-video");assert.equal(view.props.nativeControls, true);assert.equal(view.props.contentFit, "contain");assert.deepEqual(view.props.fullscreenOptions, { enable: false });assert.equal(view.props.allowsPictureInPicture, false);assert.equal(view.props.startsPictureInPictureAutomatically, false);assert.equal(view.props.playsInline, true);
  f.find("chat-attachment-preview-play").props.onPress();f.render();assert.ok(f.log.some(event => event[0] === "play"));assert.equal(f.find("chat-attachment-preview-play"), undefined);f.player.emit("playingChange", { isPlaying: false });f.render();assert.ok(f.find("chat-attachment-preview-play"));
});
test("close/back/escape pauses before the parent callback and native dismiss cannot close a newer controlled preview", () => {
  for (const action of ["button", "back", "escape"]) { const f = fixture();f.render(video);f.find("chat-attachment-preview-play").props.onPress();f.render();const before = f.log.length;if (action === "button") f.find("chat-attachment-preview-close").props.onPress();if (action === "back") f.modal().props.onRequestClose();if (action === "escape") f.find("chat-attachment-preview").props.onAccessibilityEscape();assert.deepEqual(f.log.slice(before), [["pause", 1], ["close"]]);const dismiss = f.modal().props.onDismiss;f.render(null);assert.equal(f.player.released, true);assert.equal(f.appListenerCount, 0);assert.doesNotThrow(dismiss);assert.equal(f.log.filter(event => event[0] === "close").length, 1); }
});
test("backgrounding pauses without automatic resume, and source/kind/account changes safely pause then auto-release", () => {
  const f = fixture();f.render(video);f.find("chat-attachment-preview-play").props.onPress();f.render();f.background("inactive");f.render();assert.ok(f.find("chat-attachment-preview-play"));const playCount = f.log.filter(event => event[0] === "play").length;f.background("active");f.render();assert.equal(f.log.filter(event => event[0] === "play").length, playCount);
  f.render({ ...video, uri: "file:///replacement.mov" });assert.equal(f.players.length, 2);assert.equal(f.players[0].released, true);const release = f.log.findIndex(event => event[0] === "release" && event[1] === 1);assert.deepEqual(f.log[release - 1], ["pause", 1]);assert.equal(f.player.source.uri, "file:///replacement.mov");assert.equal(f.log.filter(event => event[0] === "play").length, playCount);
  f.render(photo);assert.equal(f.players[1].released, true);assert.equal(f.appListenerCount, 0);f.render(null);f.render({ ...video, id: "other-account" });assert.equal(f.players.length, 3);assert.equal(f.log.filter(event => event[0] === "play").length, playCount);f.unmount();assert.equal(f.players[2].released, true);assert.equal(f.appListenerCount, 0);
});
test("status/play failures stay local, do not leak errors/URI and leave a working close action", () => {
  const f = fixture();f.render(video);f.player.emit("statusChange", { status: "error", error: { message: "file:///secret.mov" } });let tree = f.render();assert.ok(walk(tree).some(node => node.type === "Text" && node.props.children === "This video could not be played."));assert.ok(f.find("chat-attachment-preview-close"));f.player.play = () => { throw new Error("private error file:///secret.mov"); };assert.doesNotThrow(() => f.find("chat-attachment-preview-play").props.onPress());tree = f.render();assert.doesNotMatch(JSON.stringify(f.log), /secret|private error/);assert.ok(walk(tree).some(node => node.props?.children === "This video could not be played."));f.render(null);
});
test("implementation uses installed3.0.16 auto-releasing hook and no transport, persistence, byte logs or manual double-release", () => {
  assert.equal(JSON.parse(read("node_modules/expo-video/package.json")).version, "3.0.16");const localHook = read("node_modules/expo-video/src/VideoPlayer.tsx");assert.match(localHook, /useReleasingSharedObject/);assert.match(localHook, /automatically cleaned up when the component is unmounted/);
  const source = read(path);assert.match(source, /useVideoPlayer\(\{ uri: attachment\.uri, useCaching: false \}/);assert.doesNotMatch(source, /\.release\(|createVideoPlayer|allowsFullscreen|\bfetch\(|console\.|AsyncStorage|FileSystem|writeFile|dataUri|replace\(/);
  // Lifecycle contract tests use fakes; they do not certify native decoding,
  // playback, audio routing, system controls or visual acceptance on a device.
});
