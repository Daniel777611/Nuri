import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { translate } from "./i18n-test-utils.mjs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
// Cache syntax work, never module exports: every fixture still owns fresh
// callbacks, account scope, hook state, devices and transport adapters.
const compiledSources = new Map();
function load(path, deps, timers = {}) {
  deps={...deps,"@/src/uiuxfinal/ButtonMaterial":{FrostedPressable:deps["react-native"]?.Pressable??"Pressable",ButtonBackdrop:"ButtonBackdrop"}};
  if(!compiledSources.has(path))compiledSources.set(path,ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText);
  const code = compiledSources.get(path);
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(timers), code)(name => {
    if(name==="@/src/keyboard/AppKeyboard")return {NuriTextInput:deps["react-native"]?.TextInput??"TextInput",useAppKeyboardVisible:()=>false,useAppKeyboard:()=>({visible:false,height:0,activeHostId:null,dismiss:()=>{}}),AppKeyboardScope:({children})=>children,AppKeyboardHost:"AppKeyboardHost"};
    if (name.includes("assets/")) return 1;
    if (name === "@/src/uiuxfinal/Primitives") return { FinalChatBubble:"ChatBubble",FinalText:"Text",FinalSurface:"Surface" };
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
  const slots = [], effects = [], intervals = new Set(), listeners = new Set(), focusCleanups = new Set(), calls = [], keyboardListeners = new Map(), stateUpdates = [], timeouts = new Map();
  let cursor = 0, pending = [], tree, epoch = 1, now = 0, timeoutId = 0, chatId = "fixture-chat", payloadId = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const n = cursor++; slots[n] ??= { value: typeof initial === "function" ? initial() : initial }; slots[n].set ??= next => { const apply = () => { slots[n].value = typeof next === "function" ? next(slots[n].value) : next; }; if (options.deferStateUpdates) stateUpdates.push(apply); else apply(); }; return [slots[n].value, slots[n].set]; },
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
    streamMessage: async (id, payload, onDelta) => { calls.push(["send", id, payload]); if (options.send) return options.send(payload,onDelta); return { user_message: { id: "sent", role: "user", text: payload.text }, ai_messages: [] }; },
  };
  const jsx = (type, props) => ({ type, props });
  const keyboard = { dismiss: () => calls.push(["keyboard-dismiss"]), isVisible: () => false, addListener: (name, fn) => { if (!keyboardListeners.has(name)) keyboardListeners.set(name, new Set()); const group = keyboardListeners.get(name); group.add(fn); return { remove: () => { group.delete(fn); if (!group.size) keyboardListeners.delete(name); } }; } };
  const safeArea = { useSafeAreaInsets: () => ({ top: 59, bottom: options.safeBottom ?? 34 }) };
  const router = {};
  const deps = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/src/useAccountState": load("../src/useAccountState.ts", { react, "./api": { auth } }),
    "@/src/api": { auth, api, ApiError, isStreamUnsupported: () => false },
    "@/src/i18n": { useT: () => ({ t: key => translate(options.locale ?? "en", key), locale: options.locale ?? "en" }), translate },
    "@/src/uiux48/Primitives": Object.fromEntries(["NuriKeyboardFrame", "GlassSurface", "NuriText", "NuriIcon", "IconAction", "NuriButton", "MenuRow"].map(n => [n, n])),
    "@/src/uiux48/VoiceInputBar": { VoiceInputBar: "VoiceInputBar" },
    "@/src/uiux48/Composer": { NuriComposer: "NuriComposer" },
    "@/src/uiux48/ChatAttachmentMenu": { ChatAttachmentMenu: "ChatAttachmentMenu" },
    "@/src/uiux48/ChatAttachmentPreview": { ChatAttachmentPreview: "ChatAttachmentPreview" },
    "@/src/chatMediaInput": {
      CHAT_MAX_ATTACHMENTS:6,
      prepareChatAttachment:async asset=>{calls.push(["prepare",asset]);if(options.prepare)return options.prepare(asset);return {id:asset.uri,kind:asset.type==="video"?"video":"image",uri:asset.uri,...(asset.type==="video"?{durationMs:12_000}:{image})};},
      releaseChatAttachment:item=>calls.push(["release",item.id]),
      releaseChatPickerAssets:assets=>calls.push(["release-picker",assets.map(asset=>asset.uri)]),
      pickWebChatMediaFiles:async(...args)=>{calls.push(["web-picker",...args]);return options.webPicker?options.webPicker(...args):[{uri:"fixture://web"}];},
    },
    "@/src/uiux48/useComposerDock": load("../src/uiux48/useComposerDock.ts", { react, "react-native": { Keyboard: keyboard }, "react-native-safe-area-context": safeArea, "./composerLayout": load("../src/uiux48/composerLayout.ts", {}) }),
    "@/src/uiux48/Scene": { NuriAvatar: "SceneAvatar" },
    "@/src/uiux48/Theme": { useNuriTheme: () => ({ mode: "Night", ink: "#fff" }) },
    "@/src/uiux48/chatDraft": { readChatDraft: () => options.draft ?? "existing draft", writeChatDraft() {} },
    "@/src/chatClientContext": { buildChatMessagePayload: (text, photo, locale) => ({ text, image_base64: photo, locale, client_message_id: "fixture-only-turn-"+(++payloadId) }) },
    "@/src/chatImageInput": { ChatImageInputError: class extends Error {} },
    "@/src/chatVoiceInput": { MAX_VOICE_SECONDS: 60, VoiceInputError, isVoiceInputSupported: () => true, startVoiceRecording: async () => { calls.push(["start"]); if (options.permissionDenied) throw new VoiceInputError("permission_denied"); return options.start ? options.start(recording) : recording; } },
    "expo-image-picker": {
      CameraType: { back: "back" },
      requestCameraPermissionsAsync: async () => { calls.push(["camera-permission"]); return { granted: !options.cameraDenied }; },
      launchCameraAsync: async config => { calls.push(["camera",config]); return options.picker ? options.picker() : { canceled: false, assets: [{ uri: "fixture://camera" }] }; },
      launchImageLibraryAsync: async config => { calls.push(["library",config]); return options.picker ? options.picker() : { canceled: false, assets: [{ uri: "fixture://library" }] }; },
      getPendingResultAsync: async () => options.pendingResult ?? null,
    },
    "expo-router": { useRouter: () => router, useLocalSearchParams: () => ({ id: chatId }), useFocusEffect: fn => react.useEffect(() => { const cleanup=fn();if(cleanup)focusCleanups.add(cleanup);return()=>{focusCleanups.delete(cleanup);cleanup?.();}; }, [fn]), Stack: { Screen: "Screen" } },
    "react-native": { View: "View", Text: "Text", TextInput: "TextInput", ScrollView: "ScrollView", Pressable: "Pressable", Modal: "Modal", ActivityIndicator: "ActivityIndicator", Platform: { OS: options.platform ?? "ios" }, AppState: { addEventListener: (_name, fn) => { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } }, Keyboard: keyboard, StyleSheet: { create: x => x }, useWindowDimensions: () => options.dimensions ?? ({ width: 390, height: 844, fontScale: 1 }) },
    "react-native-safe-area-context": safeArea,
    "@react-navigation/elements": { useHeaderHeight: () => 60 },
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@/src/components/nativeNavigation": { registerNativeNavigationGuard: () => () => {} },
    "@/src/components/Toast": { default: "Toast", __esModule: true },
    "@/src/theme": { colors: {}, radius: {}, spacing: {}, type: {} },
    "@/src/resourceSummary": { shortResourceSummary: x => x },
    "expo-image": { Image: "Image" }, "@expo/vector-icons": { Ionicons: "Ionicons" }, "expo-linear-gradient": { LinearGradient: "Gradient" }, "expo-blur": { BlurView: "Blur" }, "expo-clipboard": {},
  };
  const Component = load("../app/chat/[id].tsx", deps, { Date: class extends Date { static now() { return now; } }, setTimeout: (fn,delay) => { const id=++timeoutId;timeouts.set(id,{fn,delay});return id; }, clearTimeout: id => timeouts.delete(id), setInterval: fn => { intervals.add(fn); return fn; }, clearInterval: fn => intervals.delete(fn) }).default;
  const f = {
    calls, recording,
    render() { while(stateUpdates.length)stateUpdates.shift()();cursor = 0; pending = []; tree = Component({ embedded: options.embedded ?? false }); pending.forEach(fn => fn()); return tree; },
    find: id => nodes(tree).find(n => n.props?.testID === id),
    kind: type => nodes(tree).find(n => n.type === type),
    composer: () => f.kind("NuriComposer"),
    menu:()=>f.kind("ChatAttachmentMenu"),
    bar: () => f.kind("VoiceInputBar"),
    async ready() { f.render(); await tick(); f.render(); },
    emit: state => listeners.forEach(fn => fn(state)),
    emitKeyboard: name => [...(keyboardListeners.get(name)??[])].forEach(fn=>fn()),
    keyboardListenerCount: () => [...keyboardListeners.values()].reduce((count,group)=>count+group.size,0),
    advance(seconds) { now += seconds * 1000; [...intervals].forEach(fn => fn()); },
    changeAccount() { epoch++; f.render(); },
    changeChat(id="fixture-other-chat") { chatId=id;f.render(); },
    blur() { [...focusCleanups].forEach(cleanup=>cleanup()); },
    timeoutCount: delay => [...timeouts.values()].filter(timer=>delay===undefined||timer.delay===delay).length,
    flushTimers(delay) { const active=[...timeouts].filter(([,timer])=>delay===undefined||timer.delay===delay);active.forEach(([id])=>timeouts.delete(id));active.forEach(([,timer])=>timer.fn()); },
    unmount() { effects.forEach(effect => effect?.cleanup?.()); },
  };
  return f;
}

async function chooseMedia(f,source="library") {
  f.composer().props.onAttach();f.render();
  f.menu().props[source==="camera"?"onCamera":"onLibrary"]();f.render();
  f.kind("Modal").props.onDismiss();await tick();await tick();f.render();
}
const selected = f => f.composer().props.attachments;
const picked = (...kinds) => kinds.map((kind,index)=>({uri:`fixture://${kind}-${index}`,type:kind}));
const preparedAttachment = asset => ({id:asset.uri,kind:asset.type==="video"?"video":"image",uri:asset.uri,...(asset.type==="video"?{durationMs:12_000}:{image})});
function observeVerticalScroll(f) {
 const frames=[];
 f.find("chat-scroll").props.ref.current={scrollTo:frame=>frames.push({...frame}),scrollToEnd:()=>assert.fail("Native scrollToEnd may select the horizontal axis; the controller must use explicit vertical coordinates")};
 return frames;
}
function assertChatWidthBounds(f) {
 const content=f.find("chat-content");assert.ok(content,"chat root width boundary contract must remain explicit");
 for(const [name,style] of [["content",content.props.style],["scroll",f.find("chat-scroll").props.style],["scroll content",f.find("chat-scroll").props.contentContainerStyle],["dock",f.find("chat-composer-dock").props.style]]){
  assert.equal(style.width,"100%",name+" must stay within its parent width");assert.equal(style.minWidth,0,name+" must allow shrinking");assert.equal(style.maxWidth,"100%",name+" must not adopt intrinsic overflow width");
 }
 assert.equal(f.find("chat-composer-dock").props.style.alignSelf,"stretch");
 assert.equal(f.find("chat-scroll").props.horizontal,false);assert.equal(f.find("chat-scroll").props.directionalLockEnabled,true);assert.equal(f.find("chat-scroll").props.alwaysBounceHorizontal,false);
}

test("page dock owns safe area once, removes it above keyboard and cleans every listener",async()=>{
 for(const safeBottom of [0,21,34])for(const embedded of [false,true]){
  const f=fixture({safeBottom,embedded});await f.ready();
  assert.equal(f.find("chat-composer-dock").props.style.paddingBottom,embedded?0:Math.max(27,safeBottom+12));
  assert.equal(f.keyboardListenerCount(),embedded?0:4);
  const root=f.render(),content=embedded?root:root.props.children;content.props.onLayout({nativeEvent:{layout:{height:200}}});f.render();
  assert.equal(f.composer().props.availableHeight,200);
  for(const name of ["keyboardWillShow","keyboardDidShow"]){f.emitKeyboard(name);f.render();assert.equal(f.find("chat-composer-dock").props.style.paddingBottom,embedded?0:12);}
  f.emitKeyboard("keyboardDidHide");f.render();assert.equal(f.find("chat-composer-dock").props.style.paddingBottom,embedded?0:Math.max(27,safeBottom+12));
  assert.deepEqual(f.calls,[]);f.unmount();assert.equal(f.keyboardListenerCount(),0);
 }
});
for (const embedded of [false, true]) test(`${embedded ? "Home" : "Chat"}: mic starts inline; Stop returns editable recognized text without sending`, async () => {
  const f = fixture({ embedded }); try {
    await f.ready(); assert.equal(f.calls.length, 0);
    const mic = f.composer().props.onMic; mic(); mic(); await tick(); f.render();
    assert.equal(f.calls.filter(c => c[0] === "start").length, 1);
    assert.equal(f.bar().props.phase, "recording"); assert.equal(f.composer(), undefined);
    assert.equal(f.find("chat-composer-dock").props.style.paddingBottom,embedded?0:114,"Standalone voice capsule follows the Figma114pt bottom offset; embedded Home keeps its own layout");
    assert.equal(f.kind("Modal").props.visible, false);
    f.bar().props.onStop(); await tick(); f.render();
    assert.equal(f.composer().props.value, "existing draft recognized words");
    assert.equal(f.find("chat-composer-dock").props.style.paddingBottom,embedded?0:46);
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
    await f.ready(); await chooseMedia(f);
    f.composer().props.onMic(); await tick(); f.render(); f.bar().props.onSend(); await tick(); await tick(); f.render();
    assert.equal(f.composer().props.value, "existing draft recognized words"); assert.equal(f.composer().props.hasAttachment, true); assert.deepEqual(f.composer().props.attachments.map(item=>item.id),["fixture://library"]); assert.equal(f.find("chat-image-preview"),undefined); assert.equal(f.calls.filter(c => c[0] === "send")[0][2].image_base64, image.dataUri);
  } finally { f.unmount(); }
});
test("Canceling a replacement photo preserves the already-selected image and text", async () => {
  let picks = 0;
  const f = fixture({ picker: async () => ++picks === 1 ? { canceled: false, assets: [{ uri: "fixture://first" }] } : { canceled: true, assets: null } }); try {
    await f.ready();
    for (let i = 0; i < 2; i++) await chooseMedia(f);
    assert.equal(f.composer().props.value, "existing draft"); assert.equal(f.composer().props.hasAttachment, true); assert.deepEqual(f.composer().props.attachments.map(item=>item.id),["fixture://first"]); assert.equal(f.calls.filter(c => c[0] === "prepare").length, 1); assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
  } finally { f.unmount(); }
});
test("a photo selected by a previous account cannot appear or send after an account switch", async () => {
  const held = deferred(), f = fixture({ picker: () => held.promise }); try {
    await f.ready(); await chooseMedia(f); f.changeAccount(); held.resolve({ canceled: false, assets: [{ uri: "fixture://old-owner" }] }); await tick(); f.render(); assert.equal(f.composer().props.hasAttachment, false); assert.equal(f.calls.filter(c => c[0] === "prepare").length, 0);assert.deepEqual(f.calls.filter(c=>c[0]==="release-picker").map(c=>c[1]),[["fixture://old-owner"]]);
  } finally { held.resolve({ canceled: true }); f.unmount(); }
});
for (const source of ["camera", "library"]) test(`${source}: one chooser action → system picker → inline thumbnail, no review page or automatic upload`, async () => {
  const f = fixture(); try {
    await f.ready(); f.composer().props.onAttach(); f.render(); assert.equal(f.kind("Modal").props.visible, true);
    const action = f.menu().props[source==="camera"?"onCamera":"onLibrary"]; action(); action(); f.render(); assert.equal(f.kind("Modal").props.visible, false); assert.equal(f.calls.filter(c => c[0] === source).length, 0);
    f.kind("Modal").props.onDismiss(); f.kind("Modal").props.onDismiss(); await tick(); f.render();
    assert.equal(f.calls.filter(c => c[0] === source).length, 1); assert.deepEqual(f.composer().props.attachments.map(item=>item.id),["fixture://"+source]); assert.equal(f.find("chat-image-preview"),undefined,"attachments belong inside the shared composer, not an external legacy preview"); assert.equal(f.composer().props.hasAttachment, true); assert.equal(f.calls.filter(c => c[0] === "send").length, 0);
    f.composer().props.onSend(); await tick(); f.render(); assert.equal(f.calls.filter(c => c[0] === "send")[0][2].image_base64, image.dataUri);
  } finally { f.unmount(); }
});
test("camera cancellation/denial keeps text and previous attachment without a fake success", async () => {
  for (const options of [{ picker: async () => ({ canceled: true, assets: null }) }, { cameraDenied: true }]) {
    const f = fixture(options); try { await f.ready(); await chooseMedia(f,"camera"); assert.equal(f.composer().props.value, "existing draft"); assert.equal(f.composer().props.hasAttachment, false); assert.deepEqual(f.composer().props.attachments,[]); assert.equal(f.calls.filter(c => c[0] === "send").length, 0); } finally { f.unmount(); }
  }
});
for(const deferStateUpdates of [false,true])test(`mixed media preserves every selection in order with ${deferStateUpdates?"deferred React":"immediate fixture"} state updates`,async()=>{
 const assets=picked("image","video","image"),f=fixture({deferStateUpdates,picker:async()=>({canceled:false,assets})});try{
  await f.ready();await chooseMedia(f);
  assert.deepEqual(selected(f).map(item=>[item.id,item.kind]),assets.map(asset=>[asset.uri,asset.type]));
  assert.equal(f.composer().props.value,"existing draft");assert.equal(f.composer().props.hasAttachment,true);assert.equal(f.find("chat-image-preview"),undefined);
  assert.deepEqual(f.calls.filter(c=>c[0]==="prepare").map(c=>c[1]),assets);assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
  const config=f.calls.find(c=>c[0]==="library")[1];assert.deepEqual(config.mediaTypes,["images","videos"]);assert.equal(config.allowsMultipleSelection,true);assert.equal(config.orderedSelection,true);assert.equal(config.selectionLimit,6);assert.equal(config.base64,false);
 }finally{f.unmount();}
});
test("controller serializes preparation and commits the whole mixed batch only after the final item is ready",async()=>{
 const assets=picked("image","video","image"),held=assets.map(()=>deferred());let active=0,peak=0;
 const f=fixture({picker:async()=>({canceled:false,assets}),prepare:async asset=>{active++;peak=Math.max(peak,active);const value=await held[assets.indexOf(asset)].promise;active--;return value;}});try{
  await f.ready();await chooseMedia(f);assert.deepEqual(f.calls.filter(c=>c[0]==="prepare").map(c=>c[1].uri),[assets[0].uri]);assert.deepEqual(selected(f),[]);assert.equal(f.composer().props.busy,true);
  for(let index=0;index<assets.length;index++){held[index].resolve(preparedAttachment(assets[index]));await tick();f.render();assert.equal(f.calls.filter(c=>c[0]==="prepare").length,Math.min(index+2,3));if(index<2)assert.deepEqual(selected(f),[]);}
  assert.equal(peak,1);assert.equal(f.composer().props.busy,false);assert.deepEqual(selected(f).map(item=>item.id),assets.map(asset=>asset.uri));assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
 }finally{held.forEach((item,index)=>item.resolve(preparedAttachment(assets[index])));f.unmount();}
});
test("preview and independent removal preserve every other item and the text draft",async()=>{
 const assets=picked("image","video","image"),f=fixture({picker:async()=>({canceled:false,assets})});try{
  await f.ready();await chooseMedia(f);const middle=selected(f)[1];f.composer().props.onPreviewAttachment(middle);f.render();assert.equal(f.kind("ChatAttachmentPreview").props.attachment,middle);assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
  f.kind("ChatAttachmentPreview").props.onClose();f.render();assert.equal(f.kind("ChatAttachmentPreview").props.attachment,null);assert.equal(selected(f).length,3);
  f.composer().props.onPreviewAttachment(middle);f.render();const remove=f.composer().props.onRemoveAttachment;remove(middle.id);remove(middle.id);f.render();assert.equal(f.kind("ChatAttachmentPreview").props.attachment,null);assert.deepEqual(selected(f).map(item=>item.id),[assets[0].uri,assets[2].uri]);assert.equal(f.composer().props.value,"existing draft");assert.deepEqual(f.calls.filter(c=>c[0]==="release"),[["release",middle.id]]);
  for(const item of selected(f))f.composer().props.onRemoveAttachment(item.id);f.render();assert.deepEqual(selected(f),[]);assert.equal(f.composer().props.hasAttachment,false);assert.equal(f.composer().props.value,"existing draft");
 }finally{f.unmount();}
});
test("later selection appends in order and respects the remaining six-item draft capacity",async()=>{
 const first=picked("image","image","video","image"),next=picked("video","image","image").map(asset=>({...asset,uri:asset.uri+"-next"}));let picks=0;
 const f=fixture({picker:async()=>({canceled:false,assets:++picks===1?first:next})});try{
  await f.ready();await chooseMedia(f);await chooseMedia(f);assert.deepEqual(selected(f).map(item=>item.id),[...first,...next.slice(0,2)].map(asset=>asset.uri));assert.equal(f.calls.filter(c=>c[0]==="library")[1][1].selectionLimit,2);assert.equal(f.calls.filter(c=>c[0]==="prepare").length,6);
  f.composer().props.onAttach();f.render();assert.equal(f.kind("Modal").props.visible,false);assert.equal(f.calls.filter(c=>c[0]==="library").length,2);assert.equal(f.composer().props.value,"existing draft");assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
 }finally{f.unmount();}
});
for(const transition of ["account","chat","chat-return","blur","unmount"])test(`a ${transition} boundary releases late preparation without moving private media into the current draft`,async()=>{
 const assets=picked("image","video"),held=deferred(),f=fixture({picker:async()=>({canceled:false,assets}),prepare:()=>held.promise});try{
  await f.ready();await chooseMedia(f);assert.equal(f.composer().props.busy,true);
  if(transition==="account")f.changeAccount();else if(transition==="chat")f.changeChat();else if(transition==="chat-return"){f.changeChat();f.changeChat("fixture-chat");}else if(transition==="blur")f.blur();else f.unmount();
  held.resolve(preparedAttachment(assets[0]));await tick();await tick();if(transition!=="unmount")f.render();
  assert.deepEqual(f.calls.filter(c=>c[0]==="release"),[["release",assets[0].uri]]);assert.deepEqual(f.calls.filter(c=>c[0]==="release-picker").map(c=>c[1]),[assets.map(asset=>asset.uri)]);assert.equal(f.calls.filter(c=>c[0]==="prepare").length,1);assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
  if(transition!=="unmount"){assert.deepEqual(selected(f),[]);assert.equal(f.composer().props.busy,false,"a new owner/route or discarded batch must not inherit a permanent processing lock");assert.equal(f.kind("ChatAttachmentPreview").props.attachment,null);}
 }finally{held.resolve(preparedAttachment(assets[0]));if(transition!=="unmount")f.unmount();}
});
test("a failed mixed-media preparation releases only the incomplete batch and keeps the prior draft",async()=>{
 const existing={uri:"fixture://existing",type:"image"},batch=picked("image","video");let picks=0;
 const f=fixture({picker:async()=>({canceled:false,assets:++picks===1?[existing]:batch}),prepare:async asset=>{if(asset===batch[1])throw Error("fixture decode failed");return preparedAttachment(asset);}});try{
  await f.ready();await chooseMedia(f);await chooseMedia(f);assert.deepEqual(selected(f).map(item=>item.id),[existing.uri]);assert.equal(f.composer().props.value,"existing draft");assert.equal(f.composer().props.busy,false);assert.deepEqual(f.calls.filter(c=>c[0]==="release"),[["release",batch[0].uri]]);assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
 }finally{f.unmount();}
});
test("typing during delayed selection is retained when the batch becomes ready",async()=>{
 const assets=picked("image","video"),held=deferred(),f=fixture({picker:()=>held.promise});try{
  await f.ready();await chooseMedia(f);f.composer().props.onChangeText("当前中文输入 draft 👨‍👩‍👧");f.render();held.resolve({canceled:false,assets});await tick();f.render();assert.equal(f.composer().props.value,"当前中文输入 draft 👨‍👩‍👧");assert.deepEqual(selected(f).map(item=>item.id),assets.map(asset=>asset.uri));assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
 }finally{held.resolve({canceled:true});f.unmount();}
});
test("stopping voice with a mixed-media draft adds editable text and keeps all attachments without sending",async()=>{
 const assets=picked("image","video"),f=fixture({picker:async()=>({canceled:false,assets})});try{
  await f.ready();await chooseMedia(f);const before=selected(f);f.composer().props.onMic();await tick();f.render();f.bar().props.onStop();await tick();f.render();assert.equal(f.composer().props.value,"existing draft recognized words");assert.deepEqual(selected(f),before);assert.equal(f.calls.filter(c=>c[0]==="send").length,0);assert.equal(f.calls.filter(c=>c[0]==="release").length,0);
 }finally{f.unmount();}
});
for(const transition of ["account","chat","unmount"])test(`${transition} change closes an open preview and releases committed draft resources once`,async()=>{
 const assets=picked("image","video"),f=fixture({picker:async()=>({canceled:false,assets})});try{
  await f.ready();await chooseMedia(f);f.composer().props.onPreviewAttachment(selected(f)[1]);f.render();assert.ok(f.kind("ChatAttachmentPreview").props.attachment);
  if(transition==="account")f.changeAccount();else if(transition==="chat")f.changeChat();else f.unmount();
  if(transition!=="unmount"){f.render();assert.deepEqual(selected(f),[]);assert.equal(f.kind("ChatAttachmentPreview").props.attachment,null);f.unmount();}
  assert.deepEqual(f.calls.filter(c=>c[0]==="release").map(c=>c[1]),assets.map(asset=>asset.uri));assert.equal(f.calls.filter(c=>c[0]==="send").length,0);
 }finally{if(transition!=="unmount")f.unmount();}
});
test("camera denial when a photo is already selected leaves that photo and draft untouched",async()=>{
 const f=fixture({cameraDenied:true});try{await f.ready();await chooseMedia(f);const before=selected(f);await chooseMedia(f,"camera");assert.deepEqual(selected(f),before);assert.equal(f.composer().props.value,"existing draft");assert.equal(f.calls.filter(c=>c[0]==="camera-permission").length,1);assert.equal(f.calls.filter(c=>c[0]==="camera").length,0);assert.equal(f.calls.filter(c=>c[0]==="send").length,0);}finally{f.unmount();}
});
test("a single selected image can send with empty text using the existing real image payload",async()=>{
 const f=fixture({draft:""});try{await f.ready();await chooseMedia(f);f.composer().props.onSend();await tick();f.render();const sends=f.calls.filter(c=>c[0]==="send");assert.equal(sends.length,1);assert.equal(sends[0][2].text,"");assert.equal(sends[0][2].image_base64,image.dataUri);assert.deepEqual(selected(f),[]);}finally{f.unmount();}
});
test("one-image send retry keeps the entire failed draft and exact durable payload, then releases only on success",async()=>{
 let attempts=0;const f=fixture({send:async payload=>{if(++attempts===1)throw Error("fixture offline");return{user_message:{id:"sent",role:"user",text:payload.text},ai_messages:[]};}});try{
  await f.ready();await chooseMedia(f);const attachment=selected(f)[0];f.composer().props.onSend();await tick();await tick();f.render();assert.equal(f.composer().props.value,"existing draft");assert.deepEqual(selected(f),[attachment]);assert.equal(f.calls.filter(c=>c[0]==="release").length,0);
  const resend=f.composer().props.onSend;resend();resend();await tick();f.render();const sends=f.calls.filter(c=>c[0]==="send");assert.equal(sends.length,2);assert.equal(sends[0][2],sends[1][2],"unchanged retry reuses the identical payload/idempotency key");assert.equal(sends[1][2].image_base64,image.dataUri);assert.equal(f.composer().props.value,"");assert.deepEqual(selected(f),[]);assert.deepEqual(f.calls.filter(c=>c[0]==="release"),[["release",attachment.id]]);
 }finally{f.unmount();}
});
for(const embedded of [false,true])for(const locale of ["zh-CN","en"])test(`${embedded?"embedded":"standalone"} ${locale}: photo plus text, long streamed reply and a second text turn retain bounded parent layout and usable send state`,async()=>{
 const held=deferred(),longReply=(locale==="en"?"A long reply **Heading** ":"很长的育儿回复 **标题** ")+"https://example.invalid/"+"a".repeat(1400)+"\n"+(locale==="en"?"Further details. ":"后续详细说明。").repeat(300);
 let firstDelta,turn=0;
 const firstText=locale==="en"?"Please look at this photo":"请看看这张照片",secondText=locale==="en"?"A second text question":"第二条纯文字问题";
 const f=fixture({embedded,locale,send:async(payload,onDelta)=>{if(++turn===1){firstDelta=onDelta;return held.promise;}return{user_message:{id:"second-user",role:"user",text:payload.text},ai_messages:[{id:"second-ai",role:"ai",text:"fixture second answer"}]};}});try{
  await f.ready();const frames=observeVerticalScroll(f);assertChatWidthBounds(f);f.find("chat-scroll").props.onLayout({nativeEvent:{layout:{width:390,height:300}}});f.find("chat-scroll").props.onContentSizeChange(390,480);
  await chooseMedia(f);f.composer().props.onChangeText(firstText);f.render();assert.equal(selected(f).length,1);f.composer().props.onSend();f.render();assert.equal(f.composer().props.busy,true);assert.equal(f.composer().props.value,"");assert.deepEqual(selected(f),[]);assert.equal(f.composer().props.hasAttachment,false);assertChatWidthBounds(f);
  assert.equal(typeof firstDelta,"function");firstDelta(longReply.slice(0,700));f.render();firstDelta(longReply.slice(700));f.render();assert.ok(nodes(f.render()).some(node=>node.props?.msg?.id==="__streaming__"&&node.props.msg.text===longReply));
  // Width deliberately exceeds the viewport: callbacks must never turn it
  // into an x offset while the media panel has collapsed during streaming.
  f.find("chat-scroll").props.onContentSizeChange(6000,1800);assert.deepEqual(frames.at(-1),{x:0,y:1500,animated:false});assert.equal(f.timeoutCount(100),1);f.flushTimers(100);assert.deepEqual(frames.at(-1),{x:0,y:1500,animated:true});assertChatWidthBounds(f);
  held.resolve({user_message:{id:"first-user",role:"user",text:firstText,image_base64:image.dataUri},ai_messages:[{id:"first-ai",role:"ai",text:longReply}]});await tick();await tick();f.render();assert.equal(f.composer().props.busy,false);assert.equal(f.composer().props.disabled,false);assert.deepEqual(selected(f),[]);assert.ok(nodes(f.render()).some(node=>node.props?.msg?.id==="first-ai"&&node.props.msg.text===longReply));
  f.emitKeyboard("keyboardWillShow");f.render();f.find("chat-scroll").props.onLayout({nativeEvent:{layout:{width:390,height:220}}});assert.deepEqual(frames.at(-1),{x:0,y:1580,animated:false});f.composer().props.onChangeText(secondText);f.render();assert.equal(f.composer().props.value,secondText);assertChatWidthBounds(f);f.composer().props.onSend();await tick();await tick();f.render();
  const sends=f.calls.filter(call=>call[0]==="send");assert.equal(sends.length,2);assert.equal(sends[0][2].text,firstText);assert.equal(sends[0][2].image_base64,image.dataUri);assert.equal(sends[1][2].text,secondText);assert.equal(sends[1][2].image_base64,null);assert.notEqual(sends[0][2].client_message_id,sends[1][2].client_message_id);assert.equal(f.composer().props.busy,false);assert.equal(f.composer().props.value,"");assert.deepEqual(selected(f),[]);assert.deepEqual(f.calls.filter(call=>call[0]==="release"),[["release","fixture://library"]]);assertChatWidthBounds(f);
  f.emitKeyboard("keyboardDidHide");f.render();assert.ok(frames.every(frame=>frame.x===0&&frame.y>=0));
 }finally{held.resolve({user_message:{id:"cleanup",role:"user",text:""},ai_messages:[]});f.unmount();assert.equal(f.timeoutCount(100),0);}
});
test("chat parent width contracts remain bounded at narrow, reference and rotated viewport sizes",async()=>{
 for(const embedded of [false,true])for(const width of [320,390,402,844]){
  const f=fixture({embedded,dimensions:{width,height:844,fontScale:1}});try{await f.ready();assertChatWidthBounds(f);assert.equal(f.find("chat-composer-dock").props.style.paddingHorizontal,embedded?0:24);}finally{f.unmount();}
 }
});
for(const embedded of [false,true])test(`${embedded?"embedded":"standalone"} scroll geometry ignores overflow width, reacts to resize/streaming and cleans coalesced delayed scrolls`,async()=>{
 const held=deferred();let delta;
 const f=fixture({embedded,send:async(_payload,onDelta)=>{delta=onDelta;return held.promise;}});try{
  await f.ready();const frames=observeVerticalScroll(f),scroll=()=>f.find("chat-scroll");assert.equal(f.timeoutCount(100),1);
  scroll().props.onLayout({nativeEvent:{layout:{width:320,height:400}}});assert.deepEqual(frames.at(-1),{x:0,y:0,animated:false});scroll().props.onContentSizeChange(12000,1000);assert.deepEqual(frames.at(-1),{x:0,y:600,animated:false});f.flushTimers(100);assert.deepEqual(frames.at(-1),{x:0,y:600,animated:true});
  scroll().props.onLayout({nativeEvent:{layout:{width:844,height:600}}});assert.deepEqual(frames.at(-1),{x:0,y:400,animated:false});scroll().props.onContentSizeChange(12000,200);assert.deepEqual(frames.at(-1),{x:0,y:0,animated:false});scroll().props.onContentSizeChange(12000,800);assert.deepEqual(frames.at(-1),{x:0,y:200,animated:false});
  f.composer().props.onSend();f.render();assert.equal(f.timeoutCount(100),1);delta("first streamed fragment");f.render();assert.equal(f.timeoutCount(100),1,"a new stream render must cancel the preceding delayed scroll");delta(" second fragment");f.render();assert.equal(f.timeoutCount(100),1);const before=frames.length;f.flushTimers(100);assert.equal(frames.length,before+1);assert.deepEqual(frames.at(-1),{x:0,y:200,animated:true});
  delta(" final pending fragment");f.render();assert.equal(f.timeoutCount(100),1);const countBeforeUnmount=frames.length;f.unmount();assert.equal(f.timeoutCount(100),0);f.flushTimers(100);held.resolve({user_message:{id:"late-user",role:"user",text:"existing draft"},ai_messages:[]});await tick();f.flushTimers(100);assert.equal(frames.length,countBeforeUnmount,"unmount and late transport completion must never scroll an old native ref");
 }finally{held.resolve({user_message:{id:"cleanup",role:"user",text:""},ai_messages:[]});f.unmount();}
});
for(const transition of ["account","chat","chat-return","unmount"])for(const outcome of ["success","failure"])test(`${transition} during image send: late ${outcome} cannot restore drafts, cross chats or release twice`,async()=>{
 const held=deferred(),f=fixture({send:()=>held.promise});try{
  await f.ready();await chooseMedia(f);const attachment=selected(f)[0];f.composer().props.onSend();await tick();f.render();assert.equal(f.calls.filter(c=>c[0]==="send").length,1);
  if(transition==="account")f.changeAccount();else if(transition==="chat")f.changeChat();else if(transition==="chat-return"){f.changeChat();f.changeChat("fixture-chat");}else f.unmount();
  if(transition!=="unmount"){await tick();f.render();f.composer().props.onChangeText("new owner draft");f.render();}
  if(outcome==="success")held.resolve({user_message:{id:"old-private-reply",role:"user",text:"old private result must not cross routes"},ai_messages:[]});else held.reject(Error("old request failed"));
  await tick();await tick();if(transition!=="unmount"){f.render();assert.equal(f.composer().props.value,"new owner draft");assert.deepEqual(selected(f),[]);assert.doesNotMatch(JSON.stringify(treeWithoutFunctions(f.render())),/old private result must not cross routes|old-private-reply/);assert.equal(f.composer().props.busy,false);}
  assert.deepEqual(f.calls.filter(c=>c[0]==="release"),[["release",attachment.id]],"the old draft resource must not be released a second time by a late response");
 }finally{held.resolve({user_message:{id:"cleanup",role:"user",text:""},ai_messages:[]});if(transition!=="unmount")f.unmount();}
});
for(const transition of ["account","chat","chat-return","blur","unmount"])test(`a raw picker result arriving after ${transition} is discarded before any media decoding`,async()=>{
 const held=deferred(),assets=picked("image","video"),f=fixture({picker:()=>held.promise});try{
  await f.ready();await chooseMedia(f);assert.equal(f.calls.filter(c=>c[0]==="prepare").length,0);
  if(transition==="account")f.changeAccount();else if(transition==="chat")f.changeChat();else if(transition==="chat-return"){f.changeChat();f.changeChat("fixture-chat");}else if(transition==="blur")f.blur();else f.unmount();
  held.resolve({canceled:false,assets});await tick();await tick();if(transition!=="unmount")f.render();assert.equal(f.calls.filter(c=>c[0]==="prepare").length,0,"an old route's raw selection must not enter a new route's preparer");assert.deepEqual(f.calls.filter(c=>c[0]==="release-picker").map(c=>c[1]),[assets.map(asset=>asset.uri)]);if(transition!=="unmount")assert.deepEqual(selected(f),[]);
 }finally{held.resolve({canceled:true});if(transition!=="unmount")f.unmount();}
});
for(const embedded of [false,true])test(`native ${embedded?"embedded":"page"} popover adds only its visible keyboard subscription and dismissing it does not launch a picker`,async()=>{
 const f=fixture({embedded});try{await f.ready();const baseline=embedded?0:4;assert.equal(f.keyboardListenerCount(),baseline);f.composer().props.onAttach();f.render();assert.equal(f.keyboardListenerCount(),baseline+1);f.menu().props.onDismiss();f.render();f.kind("Modal").props.onDismiss();await tick();f.render();assert.equal(f.keyboardListenerCount(),baseline);assert.equal(f.calls.filter(c=>["camera","library","prepare","send"].includes(c[0])).length,0);assert.equal(f.composer().props.value,"existing draft");}finally{f.unmount();assert.equal(f.keyboardListenerCount(),0);}
});
for(const kinds of [["image","image"],["video"],["image","video"]])test(`${kinds.join("+")}: the honest test-build limit retains the complete unsent draft in all three languages`,async()=>{
 for(const [locale,expected] of Object.entries({
  "en":"This test build can send one photo at a time. Multiple photos and videos remain in your draft and have not been sent.",
  "zh-TW":"此測試版暫時只能傳送一張照片。多張照片和影片已保留在草稿中，尚未傳送。",
  "zh-CN":"此测试版暂时只能发送一张照片。多张照片和视频已保留在草稿中，尚未发送。",
 })){
  const assets=picked(...kinds),f=fixture({locale,picker:async()=>({canceled:false,assets})});try{
   await f.ready();await chooseMedia(f);const before=structuredClone(selected(f));const send=f.composer().props.onSend;send();send();await tick();f.render();
   assert.equal(f.calls.filter(c=>c[0]==="send").length,0);assert.deepEqual(selected(f),before);assert.equal(f.composer().props.value,"existing draft");assert.equal(f.composer().props.busy,false);
   const error=f.find("chat-media-error");assert.ok(error);assert.equal(nodes(error).filter(node=>typeof node.props?.children==="string").map(node=>node.props.children).join(""),expected);
   assert.doesNotMatch(JSON.stringify(treeWithoutFunctions(error)),/being verified|unsupported|not supported|正在核对网页版/i);assert.equal(f.calls.filter(c=>c[0]==="release").length,0);
   assert.equal(nodes(f.render()).filter(node=>node.props?.msg?.id?.startsWith("tmp-")).length,0,"a retained unsent media draft must not create an optimistic sent bubble");
  }finally{f.unmount();}
 }
});
for(const source of ["camera","library"])test(`web ${source}: plus opens the icon popover, only the user's menu action invokes the raw chooser`,async()=>{
 const assets=picked("image"),f=fixture({platform:"web",webPicker:async()=>assets});try{
  await f.ready();f.composer().props.onAttach({x:24,y:600,width:60,height:60});f.render();assert.equal(f.kind("Modal").props.visible,true);assert.deepEqual(f.menu().props.anchor,{x:24,y:600,width:60,height:60});assert.equal(f.calls.filter(c=>c[0]==="web-picker").length,0);
  const action=f.menu().props[source==="camera"?"onCamera":"onLibrary"];action();action();assert.deepEqual(f.calls.filter(c=>c[0]==="web-picker"),[["web-picker",source,6]],"browser picker must be called in the icon press stack, once");await tick();f.render();assert.equal(f.kind("Modal").props.visible,false);assert.deepEqual(selected(f).map(item=>item.id),assets.map(asset=>asset.uri));assert.equal(f.calls.filter(c=>["camera","library","camera-permission","send"].includes(c[0])).length,0);
 }finally{f.unmount();}
});
test("Android delayed Modal fallback and onDismiss cannot open two pickers",async()=>{
 const f=fixture({platform:"android"});try{await f.ready();f.composer().props.onAttach();f.render();f.menu().props.onLibrary();f.render();assert.equal(f.calls.filter(c=>c[0]==="library").length,0);f.flushTimers();f.kind("Modal").props.onDismiss();await tick();f.render();assert.equal(f.calls.filter(c=>c[0]==="library").length,1);assert.equal(selected(f).length,1);}finally{f.unmount();}
});
test("inline recording bar has Stop/Send/Cancel in all three languages and never invokes callbacks during rendering", () => {
  const jsx = (type, props) => ({ type, props });
  for (const locale of ["zh-CN", "zh-TW", "en"]) {
    const calls = [];
    const Bar = load("../src/uiux48/VoiceInputBar.tsx", {react:{}, "expo-image":{Image:"Image"}, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": { ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", View: "View" }, "@/src/i18n": { useT: () => ({ locale, t: key => translate(locale, key) }) }, "@/src/components/VoiceWaveform": { default: "Waveform", __esModule: true }, "./Theme": { useNuriTheme: () => ({ ink: "#fff" }) }, "./Primitives": { GlassSurface: "Glass", IconAction: "IconAction", NuriText: "Text" } }).VoiceInputBar;
    const all = nodes(Bar({ phase: "recording", seconds: 9, metered: true, level: () => .2, onCancel: () => calls.push("cancel"), onStop: () => calls.push("stop"), onSend: () => calls.push("send") }));
    assert.deepEqual(calls, []); assert.match(all.find(n => n.props?.testID === "chat-voice-cancel").props.accessibilityLabel,/0:09/);
    for (const id of ["cancel", "stop", "send"]) { const control = all.find(n => n.props?.testID === "chat-voice-" + id); assert.ok(control); if(id==="cancel")control.props.onLongPress();else control.props.onPress(); }
    assert.deepEqual(calls, ["cancel", "stop", "send"]);
  }
});
