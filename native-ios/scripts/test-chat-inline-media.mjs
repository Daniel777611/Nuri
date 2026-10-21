import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { translate } from "./i18n-test-utils.mjs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
function load(path, deps, timers = {}) {
  const code = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(timers), code)(name => {
    if (name.includes("assets/")) return 1;
    assert.ok(name in deps, "unexpected import " + name);
    return deps[name];
  }, module, module.exports, ...Object.values(timers));
  return module.exports;
}
const nodes = n => !n || typeof n !== "object" ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const image = { previewUri: "fixture://thumbnail", dataUri: "data:image/jpeg;base64,/9j/AA==", width: 200, height: 100 };

// Execute the actual Chat component, account hooks, callbacks and send path.
// Only devices/transports are fixture adapters; no real account/network/audio.
function fixture(options = {}) {
  const slots = [], effects = [], intervals = new Set(), listeners = new Set(), calls = [];
  let cursor = 0, pending = [], tree, epoch = 1, now = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: typeof initial === "function" ? initial() : initial }; slots[n].set ??= next => { slots[n].value = typeof next === "function" ? next(slots[n].value) : next; }; return [slots[n].value, slots[n].set]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useCallback(fn, deps) { const n = cursor++; if (!slots[n] || !same(slots[n].deps, deps)) slots[n] = { fn, deps }; return slots[n].fn; },
    useEffect(fn, deps) { const n = cursor++; if (!effects[n] || !same(effects[n].deps, deps)) pending.push(() => { effects[n]?.cleanup?.(); effects[n] = { deps, cleanup: fn() }; }); },
    useSyncExternalStore(_subscribe, snapshot) { cursor++; return snapshot(); },
  };
  class VoiceInputError extends Error { constructor(code) { super(code); this.code = code; } }
  class ApiError extends Error {}
  const auth = { getSessionGeneration: () => epoch, subscribeSessionBoundary: () => () => {} };
  const recording = { stop: async () => { calls.push(["stop"]); return options.stop ? options.stop() : "data:audio/m4a;base64,fixture"; }, cancel: () => calls.push(["cancel"]), level: () => .2 };
  const api = {
    getMessages: async () => [],
    transcribeVoice: async (...args) => { calls.push(["transcribe", ...args]); return options.transcribe ? options.transcribe() : { text: "recognized words" }; },
    streamMessage: async (id, payload) => { calls.push(["send", id, payload]); if (options.send) return options.send(payload); return { user_message: { id: "sent", role: "user", text: payload.text }, ai_messages: [] }; },
  };
  const jsx = (type, props) => ({ type, props });
  const deps = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/src/useAccountState": load("../src/useAccountState.ts", { react, "./api": { auth } }),
    "@/src/api": { auth, api, ApiError, isStreamUnsupported: () => false },
    "@/src/i18n": { useT: () => ({ t: key => translate(options.locale ?? "en", key), locale: options.locale ?? "en" }), translate },
    "@/src/uiux48/Primitives": Object.fromEntries(["NuriKeyboardFrame", "GlassSurface", "NuriText", "NuriIcon", "IconAction", "NuriButton", "MenuRow"].map(n => [n, n])),
    "@/src/uiux48/VoiceInputBar": { VoiceInputBar: "VoiceInputBar" },
    "@/src/uiux48/Composer": { NuriComposer: "NuriComposer" },
    "@/src/uiux48/Scene": { NuriAvatar: "SceneAvatar" },
    "@/src/uiux48/Theme": { useNuriTheme: () => ({ mode: "Night", ink: "#fff" }) },
    "@/src/uiux48/chatDraft": { readChatDraft: () => options.draft ?? "existing draft", writeChatDraft() {} },
    "@/src/chatClientContext": { buildChatMessagePayload: (text, photo, locale) => ({ text, image_base64: photo, locale, client_message_id: "fixture-only-turn" }) },
    "@/src/chatImageInput": { ChatImageInputError: class extends Error {}, prepareChatImage: async asset => { calls.push(["prepare", asset]); return image; }, pickWebChatImageFile: async () => ({ uri: "fixture://web" }) },
    "@/src/chatVoiceInput": { MAX_VOICE_SECONDS: 60, VoiceInputError, isVoiceInputSupported: () => true, startVoiceRecording: async () => { calls.push(["start"]); if (options.permissionDenied) throw new VoiceInputError("permission_denied"); return options.start ? options.start(recording) : recording; } },
    "expo-image-picker": {
      CameraType: { back: "back" },
      requestCameraPermissionsAsync: async () => { calls.push(["camera-permission"]); return { granted: !options.cameraDenied }; },
      launchCameraAsync: async () => { calls.push(["camera"]); return options.picker ? options.picker() : { canceled: false, assets: [{ uri: "fixture://camera" }] }; },
      launchImageLibraryAsync: async () => { calls.push(["library"]); return options.picker ? options.picker() : { canceled: false, assets: [{ uri: "fixture://library" }] }; },
    },
    "expo-router": { useRouter: () => ({}), useLocalSearchParams: () => ({ id: "fixture-chat" }), useFocusEffect: fn => react.useEffect(fn, [fn]), Stack: { Screen: "Screen" } },
    "react-native": { View: "View", Text: "Text", TextInput: "TextInput", ScrollView: "ScrollView", Pressable: "Pressable", Modal: "Modal", ActivityIndicator: "ActivityIndicator", Platform: { OS: options.platform ?? "ios" }, AppState: { addEventListener: (_name, fn) => { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } }, Keyboard: { dismiss: () => calls.push(["keyboard-dismiss"]) }, StyleSheet: { create: x => x }, useWindowDimensions: () => ({ width: 390 }) },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 59, bottom: 34 }) },
    "@react-navigation/elements": { useHeaderHeight: () => 60 },
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@/src/components/nativeNavigation": { registerNativeNavigationGuard: () => () => {} },
    "@/src/components/Toast": { default: "Toast", __esModule: true },
    "@/src/theme": { colors: {}, radius: {}, spacing: {}, type: {} },
    "@/src/resourceSummary": { shortResourceSummary: x => x },
    "expo-image": { Image: "Image" }, "@expo/vector-icons": { Ionicons: "Ionicons" }, "expo-linear-gradient": { LinearGradient: "Gradient" }, "expo-blur": { BlurView: "Blur" }, "expo-clipboard": {},
  };
  const Component = load("../app/chat/[id].tsx", deps, { Date: class extends Date { static now() { return now; } }, setTimeout: () => 1, clearTimeout() {}, setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn) }).default;
  const f = {
    calls, recording,
    render() { cursor = 0; pending = []; tree = Component({ embedded: options.embedded ?? false }); pending.forEach(fn => fn()); return tree; },
    find: id => nodes(tree).find(n => n.props?.testID === id),
    kind: type => nodes(tree).find(n => n.type === type),
    composer: () => f.kind("NuriComposer"),
    bar: () => f.kind("VoiceInputBar"),
    async ready() { f.render(); await tick(); f.render(); },
    emit: state => listeners.forEach(fn => fn(state)),
    advance(seconds) { now += seconds * 1000; [...intervals].forEach(fn => fn()); },
    changeAccount() { epoch++; f.render(); },
    unmount() { effects.forEach(effect => effect?.cleanup?.()); },
  };
  return f;
}

for (const embedded of [false, true]) test(`${embedded ? "Home" : "Chat"}: mic starts inline; Stop returns editable recognized text without sending`, async () => {
  const f = fixture({ embedded }); try {
    await f.ready(); assert.equal(f.calls.length, 0);
    const mic = f.composer().props.onMic; mic(); mic(); await tick(); f.render();
    assert.equal(f.calls.filter(c => c[0] === "start").length, 1);
    assert.equal(f.bar().props.phase, "recording"); assert.equal(f.composer(), undefined);
    assert.equal(f.kind("Modal").props.visible, false);
    f.bar().props.onStop(); await tick(); f.render();
    assert.equal(f.composer().props.value, "existing draft recognized words");
    assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
  } finally { f.unmount(); }
});
test("direct Send transcribes once and sends the exact merged draft once; duplicate Stop/Send is inert", async () => {
  const held = deferred(), f = fixture({ transcribe: () => held.promise }); try {
    await f.ready(); f.composer().props.onMic(); await tick(); f.render();
    const bar = f.bar(); bar.props.onSend(); bar.props.onSend(); bar.props.onStop(); await tick(); f.render();
    assert.equal(f.bar().props.phase, "transcribing"); assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
    held.resolve({ text: "  dictated question  " }); await tick(); await tick(); f.render();
    assert.equal(f.calls.filter(c => c[0] === "transcribe").length, 1);
    const sent = f.calls.filter(c => c[0] === "send"); assert.equal(sent.length, 1); assert.equal(sent[0][2].text, "existing draft dictated question"); assert.equal(f.composer().props.value, "");
  } finally { held.resolve({ text: "" }); f.unmount(); }
});
for (const result of ["empty", "failure"]) test(`transcription ${result} keeps the original draft, stays inline and never sends`, async () => {
  const f = fixture({ transcribe: async () => { if (result === "failure") throw Error("fixture offline"); return { text: " " }; } }); try {
    await f.ready(); f.composer().props.onMic(); await tick(); f.render(); f.bar().props.onSend(); await tick(); f.render();
    assert.equal(f.composer().props.value, "existing draft"); assert.ok(f.find("chat-media-error")); assert.equal(f.kind("Modal").props.visible, false); assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
  } finally { f.unmount(); }
});
for (const stage of ["recording", "transcribing"]) test(`Cancel during ${stage} preserves the draft and suppresses any late recognized send`, async () => {
  const held = deferred(), f = fixture({ transcribe: () => held.promise }); try {
    await f.ready(); f.composer().props.onMic(); await tick(); f.render();
    if (stage === "transcribing") { f.bar().props.onSend(); await tick(); f.render(); }
    f.bar().props.onCancel(); held.resolve({ text: "must not be sent" }); await tick(); f.render();
    assert.equal(f.composer().props.value, "existing draft"); assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
  } finally { held.resolve({ text: "" }); f.unmount(); }
});
for (const transition of ["account", "background"]) test(`${transition} change suppresses a pending transcript and send`, async () => {
  const held = deferred(), f = fixture({ transcribe: () => held.promise }); try {
    await f.ready(); f.composer().props.onMic(); await tick(); f.render(); f.bar().props.onSend(); await tick();
    if (transition === "account") f.changeAccount(); else f.emit("background");
    held.resolve({ text: "late private draft" }); await tick(); f.render();
    assert.equal(f.calls.filter(c => c[0] === "send").length, 0); assert.doesNotMatch(JSON.stringify(treeWithoutFunctions(f.render())), /late private draft/);
  } finally { held.resolve({ text: "" }); f.unmount(); }
});
function treeWithoutFunctions(tree) { return JSON.parse(JSON.stringify(tree)); }
test("first microphone denial returns to the same draft with an inline error, not another permission page", async () => {
  const f = fixture({ permissionDenied: true }); try { await f.ready(); f.composer().props.onMic(); await tick(); f.render(); assert.equal(f.composer().props.value, "existing draft"); assert.ok(f.find("chat-media-error")); assert.equal(f.kind("Modal").props.visible, false); } finally { f.unmount(); }
});
test("60-second cap stops into the draft, never automatically sends", async () => {
  const f = fixture(); try { await f.ready(); f.composer().props.onMic(); await tick(); f.render(); f.advance(60); await tick(); f.render(); assert.equal(f.composer().props.value, "existing draft recognized words"); assert.equal(f.calls.filter(c => c[0] === "send").length, 0); } finally { f.unmount(); }
});
test("Cancel before OS permission resolves releases a late recorder and never transcribes", async () => {
  const held = deferred(), f = fixture({ start: () => held.promise }); try {
    await f.ready(); f.composer().props.onMic(); f.render(); assert.equal(f.bar().props.phase, "starting"); f.bar().props.onCancel(); held.resolve(f.recording); await tick(); f.render(); assert.equal(f.composer().props.value, "existing draft"); assert.equal(f.calls.filter(c => c[0] === "cancel").length, 1); assert.equal(f.calls.filter(c => c[0] === "transcribe").length, 0);
  } finally { held.resolve(f.recording); f.unmount(); }
});
test("a failed voice-send restores the complete recognized draft and existing selected image", async () => {
  const f = fixture({ send: async () => { throw Error("fixture offline"); } }); try {
    await f.ready(); f.composer().props.onAttach(); f.render(); f.find("chat-image-library").props.onPress(); f.render(); f.kind("Modal").props.onDismiss(); await tick(); f.render();
    f.composer().props.onMic(); await tick(); f.render(); f.bar().props.onSend(); await tick(); await tick(); f.render();
    assert.equal(f.composer().props.value, "existing draft recognized words"); assert.equal(f.composer().props.hasAttachment, true); assert.ok(f.find("chat-image-preview")); assert.equal(f.calls.filter(c => c[0] === "send")[0][2].image_base64, image.dataUri);
  } finally { f.unmount(); }
});
test("Canceling a replacement photo preserves the already-selected image and text", async () => {
  let picks = 0;
  const f = fixture({ picker: async () => ++picks === 1 ? { canceled: false, assets: [{ uri: "fixture://first" }] } : { canceled: true, assets: null } }); try {
    await f.ready();
    for (let i = 0; i < 2; i++) { f.composer().props.onAttach(); f.render(); f.find("chat-image-library").props.onPress(); f.render(); f.kind("Modal").props.onDismiss(); await tick(); f.render(); }
    assert.equal(f.composer().props.value, "existing draft"); assert.equal(f.composer().props.hasAttachment, true); assert.equal(f.calls.filter(c => c[0] === "prepare").length, 1); assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
  } finally { f.unmount(); }
});
test("a photo selected by a previous account cannot appear or send after an account switch", async () => {
  const held = deferred(), f = fixture({ picker: () => held.promise }); try {
    await f.ready(); f.composer().props.onAttach(); f.render(); f.find("chat-image-library").props.onPress(); f.render(); f.kind("Modal").props.onDismiss(); await tick(); f.changeAccount(); held.resolve({ canceled: false, assets: [{ uri: "fixture://old-owner" }] }); await tick(); f.render(); assert.equal(f.composer().props.hasAttachment, false); assert.equal(f.calls.filter(c => c[0] === "prepare").length, 0);
  } finally { held.resolve({ canceled: true }); f.unmount(); }
});
for (const source of ["camera", "library"]) test(`${source}: one chooser action → system picker → inline thumbnail, no review page or automatic upload`, async () => {
  const f = fixture(); try {
    await f.ready(); f.composer().props.onAttach(); f.render(); assert.equal(f.kind("Modal").props.visible, true);
    const action = f.find("chat-image-" + source).props.onPress; action(); action(); f.render(); assert.equal(f.kind("Modal").props.visible, false); assert.equal(f.calls.filter(c => c[0] === source).length, 0);
    f.kind("Modal").props.onDismiss(); f.kind("Modal").props.onDismiss(); await tick(); f.render();
    assert.equal(f.calls.filter(c => c[0] === source).length, 1); assert.ok(f.find("chat-image-preview")); assert.equal(f.composer().props.hasAttachment, true); assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
    f.composer().props.onSend(); await tick(); f.render(); assert.equal(f.calls.filter(c => c[0] === "send")[0][2].image_base64, image.dataUri);
  } finally { f.unmount(); }
});
test("camera cancellation/denial keeps text and previous attachment without a fake success", async () => {
  for (const options of [{ picker: async () => ({ canceled: true, assets: null }) }, { cameraDenied: true }]) {
    const f = fixture(options); try { await f.ready(); f.composer().props.onAttach(); f.render(); f.find("chat-image-camera").props.onPress(); f.render(); f.kind("Modal").props.onDismiss(); await tick(); f.render(); assert.equal(f.composer().props.value, "existing draft"); assert.equal(f.composer().props.hasAttachment, false); assert.equal(f.calls.filter(c => c[0] === "send").length, 0); } finally { f.unmount(); }
  }
});
test("inline recording bar has Stop/Send/Cancel in all three languages and never invokes callbacks during rendering", () => {
  const jsx = (type, props) => ({ type, props });
  for (const locale of ["zh-CN", "zh-TW", "en"]) {
    const calls = [];
    const Bar = load("../src/uiux48/VoiceInputBar.tsx", { "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": { ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", View: "View" }, "@/src/i18n": { useT: () => ({ locale, t: key => translate(locale, key) }) }, "@/src/components/VoiceWaveform": { default: "Waveform", __esModule: true }, "./Theme": { useNuriTheme: () => ({ ink: "#fff" }) }, "./Primitives": { GlassSurface: "Glass", IconAction: "IconAction", NuriText: "Text" } }).VoiceInputBar;
    const all = nodes(Bar({ phase: "recording", seconds: 9, metered: true, level: () => .2, onCancel: () => calls.push("cancel"), onStop: () => calls.push("stop"), onSend: () => calls.push("send") }));
    assert.deepEqual(calls, []); assert.equal(all.find(n => n.props?.testID === "chat-voice-timer").props.children.join(""), "0:09");
    for (const id of ["cancel", "stop", "send"]) { const control = all.find(n => n.props?.testID === "chat-voice-" + id); assert.ok(control); control.props.onPress(); }
    assert.deepEqual(calls, ["cancel", "stop", "send"]);
  }
});
