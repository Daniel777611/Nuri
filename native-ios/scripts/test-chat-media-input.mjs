import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/chatMediaInput.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class ChatImageInputError extends Error { constructor(code) { super(code); this.code = code; } }
const image = { previewUri: "data:image/jpeg;base64,/9j/AA==", dataUri: "data:image/jpeg;base64,/9j/AA==", width: 1600, height: 900 };
const video = extra => ({ uri: "file:///picker/clip.mov", type: "video", width: 1920, height: 1080, fileSize: 1_000_000, duration: 12_500, fileName: "clip.mov", mimeType: "video/quicktime", ...extra });
const photo = extra => ({ uri: "file:///picker/photo.heic", type: "image", width: 4032, height: 3024, fileSize: 2_000_000, mimeType: "image/heic", ...extra });

function fixture(options = {}) {
  const calls = [], players = [], refs = [], inputs = [], videos = [], canvases = [], created = [], revoked = [], timers = new Map();
  let nextTimer = 0;
  const url = { createObjectURL(file) { const uri = `blob:owned-${created.length + 1}`; created.push({ uri, file }); return uri; }, revokeObjectURL(uri) { revoked.push(uri); } };
  class Events {
    listeners = new Map();
    addEventListener(name, fn, options) { const list = this.listeners.get(name) ?? []; list.push({ fn, once: options?.once }); this.listeners.set(name, list); }
    removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(x => x.fn !== fn)); }
    emit(name) { for (const entry of [...this.listeners.get(name) ?? []]) { if (entry.once) this.removeEventListener(name, entry.fn); entry.fn(); } }
    listenerCount() { return [...this.listeners.values()].reduce((n, rows) => n + rows.length, 0); }
  }
  const document = {
    body: { appendChild(input) { input.appended = true; } },
    createElement(tag) {
      if (tag === "input") { const input = new Events(); input.style = {}; input.click = () => { calls.push(["input-click"]); if (options.clickError) throw Error("chooser denied"); }; input.remove = () => input.removed = true; inputs.push(input); return input; }
      if (tag === "video") {
        const element = new Events(); Object.assign(element, { src: "", readyState: 0, currentTime: 0, duration: options.webDuration ?? 12.5, videoWidth: options.webWidth ?? 1920, videoHeight: options.webHeight ?? 1080 });
        element.load = () => { calls.push(["video-load", element.src]); if (element.src && !options.webHold) queueMicrotask(() => { element.readyState = 2; element.emit(options.webDecodeError ? "error" : "loadedmetadata"); element.emit("loadeddata"); }); };
        element.pause = () => calls.push(["video-pause"]); element.play = () => { throw Error("preview must never play audio/video"); }; element.removeAttribute = name => { if (name === "src") element.src = ""; };
        videos.push(element); return element;
      }
      if (tag === "canvas") { const canvas = { width: 0, height: 0, getContext: () => options.noCanvas ? null : { drawImage(_video, x, y, width, height) { calls.push(["draw", x, y, width, height]); } }, toDataURL: () => options.badCover ? "data:bad" : "data:image/jpeg;base64,/9j/AA==" }; canvases.push(canvas); return canvas; }
      throw Error("Unexpected DOM allocation: " + tag);
    },
  };
  const ref = (extra = {}) => { const item = { width: 320, height: 180, released: 0, release() { this.released++; }, ...extra }; refs.push(item); return item; };
  const createVideoPlayer = initial => {
    calls.push(["player-create", initial]);
    const player = {
      listeners: new Map(), released: 0, duration: options.nativeDuration ?? 12.5, availableVideoTracks: options.tracks ?? [{ size: { width: 1920, height: 1080 } }],
      addListener(name, fn) { this.listeners.set(name, fn); return { remove: () => this.listeners.delete(name) }; },
      async replaceAsync(source) { calls.push(["replace", source]); if (options.replace) await options.replace(); if (options.failAt === "replace") throw Error("decoder failed"); if (options.failAt === "status") this.listeners.get("statusChange")?.({ status: "error" }); this.listeners.get("sourceLoad")?.({ duration: this.duration, availableVideoTracks: this.availableVideoTracks }); },
      async generateThumbnailsAsync(time, config) { calls.push(["thumbnail", time, config]); if (options.thumbnails) return options.thumbnails(); if (options.failAt === "thumbnail") throw Error("thumbnail failed"); return [ref(options.thumbnail), ...(options.extraThumbnail ? [ref()] : [])]; },
      play() { throw Error("native preview must never play"); },
      release() { this.released++; },
    }; players.push(player); return player;
  };
  class File { constructor(uri) { calls.push(["file-stat", uri]); } get exists() { return options.fileExists ?? true; } get size() { return options.fileSize ?? 1_000_000; } delete() { throw Error("never delete picker originals"); } }
  const deps = {
    "expo-file-system": { File }, "expo-video": { createVideoPlayer }, "react-native": { Platform: { OS: options.platform ?? "ios" } },
    "./chatImageInput": {
      ChatImageInputError,
      async prepareChatImage(asset) { calls.push(["prepare-image", asset]); try { return options.imagePrepare ? await options.imagePrepare(asset) : image; } finally { if (options.platform === "web" && asset.uri.startsWith("blob:")) url.revokeObjectURL(asset.uri); } },
      async webAssetFromFile(file) { calls.push(["web-image-header", file]); if (options.webImagePick) return options.webImagePick(file, url); return { uri: url.createObjectURL(file), type: "image", width: 1200, height: 900, fileSize: file.size, fileName: file.name, mimeType: file.type, file }; },
    },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "setTimeout", "clearTimeout", "URL", "document", compiled)(name => { assert.ok(name in deps, "Unexpected dependency: " + name); return deps[name]; }, module, module.exports,
    (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, id => timers.delete(id), url, options.platform === "web" ? document : undefined);
  return { media: module.exports, calls, players, refs, ref, inputs, videos, canvases, created, revoked, timers,
    timeout() { for (const { fn } of [...timers.values()]) fn(); },
    choose(files, remaining = 6, which = "library") { const promise = module.exports.pickWebChatMediaFiles(which, remaining); const input = inputs.at(-1); input.files = files; input.emit("change"); return promise; },
  };
}
const rejectCode = code => error => error instanceof ChatImageInputError && error.code === code;
const webFile = (type = "video/mp4", extra = {}) => ({ type, size: 200_000, name: type.startsWith("video/") ? "clip.mp4" : "photo.jpg", arrayBuffer() { throw Error("raw video bytes must not be read into JS"); }, ...extra });

test("image draft reuses the exact bounded JPEG preparer without creating a video player or backend call", async () => {
  const f = fixture(), asset = photo();
  const a = await f.media.prepareChatAttachment(asset), b = await f.media.prepareChatAttachment(asset);
  assert.equal(a.kind, "image"); assert.equal(a.image, image); assert.equal(a.previewSource.uri, image.previewUri); assert.equal(a.uri, image.previewUri); assert.notEqual(a.id, b.id);
  assert.equal(f.calls.filter(x => x[0] === "prepare-image").length, 2); assert.equal(f.players.length, 0);
  f.media.releaseChatAttachment(a); f.media.releaseChatAttachment(a); assert.deepEqual(f.revoked, []);
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|FormData|localStorage|AsyncStorage|console)\b/);
});

test("native video uses real source metadata and original first-frame SharedRef; player releases before returning but cover survives until removal", async () => {
  const f = fixture({ extraThumbnail: true }), a = await f.media.prepareChatAttachment(video());
  assert.equal(a.kind, "video"); assert.equal(a.durationMs, 12500); assert.equal(a.previewSource, f.refs[0]); assert.equal(a.width, 1920); assert.equal(a.height, 1080);
  assert.deepEqual(f.calls.find(x => x[0] === "player-create"), ["player-create", null]);
  assert.deepEqual(f.calls.find(x => x[0] === "thumbnail"), ["thumbnail", 0, { maxWidth: 320, maxHeight: 320 }]);
  assert.equal(f.players[0].muted, true); assert.equal(f.players[0].volume, 0); assert.equal(f.players[0].staysActiveInBackground, false); assert.equal(f.players[0].allowsExternalPlayback, false);
  assert.equal(f.players[0].released, 1); assert.equal(f.players[0].listeners.size, 0); assert.equal(f.refs[0].released, 0); assert.equal(f.refs[1].released, 1); assert.equal(f.timers.size, 0);
  f.media.releaseChatPickerAssets([video()]); assert.equal(f.refs[0].released, 0);
  f.media.releaseChatAttachment(a); f.media.releaseChatAttachment(a); assert.equal(f.refs[0].released, 1); assert.deepEqual(f.revoked, []);
});

test("known local draft resource limits fail before creating a native player and do not declare a server limit", async () => {
  for (const [asset, code] of [
    [video({ fileSize: 100 * 1024 * 1024 + 1 }), "too_large"], [video({ duration: 120001 }), "too_large"],
    [video({ width: 4097 }), "too_large"], [video({ width: 4096, height: 4096 }), "too_large"],
    [video({ fileSize: -1 }), "processing_failed"], [video({ width: NaN }), "processing_failed"],
    [video({ uri: "https://private.invalid/a.mp4" }), "unsupported"], [video({ mimeType: "image/png" }), "unsupported"],
    [video({ type: "pairedVideo" }), "unsupported"],
  ]) { const f = fixture(); await assert.rejects(f.media.prepareChatAttachment(asset), rejectCode(code)); assert.equal(f.players.length, 0); }
  assert.match(source, /Local draft\/decode resource bounds/);
  const f = fixture(); assert.equal(f.media.CHAT_MAX_ATTACHMENTS, 6); await f.media.prepareChatAttachment(video({ duration: 120000, fileSize: 100 * 1024 * 1024 }));
});

test("missing native file size uses metadata only; an unverifiable source is rejected without decoding or deleting it", async () => {
  const f = fixture(), a = await f.media.prepareChatAttachment(video({ fileSize: undefined })); assert.equal(a.kind, "video"); assert.equal(f.calls.filter(x => x[0] === "file-stat").length, 1);
  const g = fixture({ fileExists: false }); await assert.rejects(g.media.prepareChatAttachment(video({ fileSize: undefined })), rejectCode("processing_failed")); assert.equal(g.players.length, 0);
  const oversized = fixture({ fileSize: 100 * 1024 * 1024 + 1 }); await assert.rejects(oversized.media.prepareChatAttachment(video({ fileSize: 1 })), rejectCode("too_large")); assert.equal(oversized.players.length, 0, "Picker metadata cannot hide the actual local file's larger size");
});

test("actual native duration and track dimensions override misleading picker metadata before thumbnail generation", async () => {
  for (const options of [{ nativeDuration: 121 }, { tracks: [{ size: { width: 8000, height: 1000 } }] }]) {
    const f = fixture(options); await assert.rejects(f.media.prepareChatAttachment(video()), rejectCode("too_large")); assert.equal(f.calls.some(x => x[0] === "thumbnail"), false); assert.equal(f.players[0].released, 1); assert.equal(f.players[0].listeners.size, 0);
  }
  const f = fixture({ tracks: [] }); await assert.rejects(f.media.prepareChatAttachment(video()), rejectCode("unsupported")); assert.equal(f.players[0].released, 1);
});

test("native load, status, thumbnail and malformed-cover failures release all owned references and leave the queue usable", async () => {
  for (const options of [{ failAt: "replace" }, { failAt: "status" }, { failAt: "thumbnail" }, { thumbnail: { width: 321 } }, { thumbnail: { height: 0 } }]) {
    const f = fixture(options); await assert.rejects(f.media.prepareChatAttachment(video()), rejectCode("processing_failed")); assert.equal(f.players[0].released, 1); assert.equal(f.players[0].listeners.size, 0); assert.equal(f.timers.size, 0); for (const ref of f.refs) assert.equal(ref.released, 1);
  }
});

test("native replacement timeout releases player/listeners and a late load cannot generate a cover", async () => {
  const held = deferred(), f = fixture({ replace: () => held.promise }), pending = f.media.prepareChatAttachment(video());
  await tick(); const rejected = assert.rejects(pending, rejectCode("processing_failed")); assert.equal([...f.timers.values()][0].ms, 15000); f.timeout(); await rejected;
  assert.equal(f.players[0].released, 1); assert.equal(f.players[0].listeners.size, 0); assert.equal(f.timers.size, 0);
  held.resolve(); await tick(); assert.equal(f.calls.some(x => x[0] === "thumbnail"), false);
});

test("late native thumbnail after timeout releases its SharedRef and never returns a dead preview", async () => {
  const held = deferred(), f = fixture({ thumbnails: () => held.promise }), pending = f.media.prepareChatAttachment(video()); await tick();
  const rejected = assert.rejects(pending, rejectCode("processing_failed")); f.timeout(); await rejected;
  const late = f.ref(); held.resolve([late]); await tick(); assert.equal(late.released, 1); assert.equal(f.players[0].released, 1);
});

test("discarding an in-flight native picker result releases the late cover without returning it to another account or screen", async () => {
  const held = deferred(), f = fixture({ thumbnails: () => held.promise }), asset = video(), pending = f.media.prepareChatAttachment(asset);
  await tick(); assert.equal(f.calls.some(x => x[0] === "thumbnail"), true);
  f.media.releaseChatPickerAssets([asset]); const rejected = assert.rejects(pending, rejectCode("processing_failed"));
  const late = f.ref(); held.resolve([late]); await rejected;
  assert.equal(late.released, 1); assert.equal(f.players[0].released, 1); assert.equal(f.players[0].listeners.size, 0); assert.equal(f.timers.size, 0); assert.deepEqual(f.revoked, []);
});

test("photo/video decoding is serialized and releasing a queued picker result prevents later preparation", async () => {
  const held = deferred(), f = fixture({ imagePrepare: () => held.promise }), first = f.media.prepareChatAttachment(photo()), asset = video(), second = f.media.prepareChatAttachment(asset);
  await tick(); assert.equal(f.players.length, 0); f.media.releaseChatPickerAssets([asset]); const rejected = assert.rejects(second, rejectCode("processing_failed")); held.resolve(image); await first; await rejected; assert.equal(f.players.length, 0);
  const g = fixture({ replace: () => held.promise }); const a = g.media.prepareChatAttachment(video()), b = g.media.prepareChatAttachment(video({ uri: "file:///picker/second.mov" })); await Promise.all([a, b]); assert.equal(g.players.length, 2);
});

test("web library chooser returns ordered raw image/video assets, respects remaining slots and never forces a camera process", async () => {
  const f = fixture({ platform: "web" }), files = [webFile("image/jpeg"), webFile()], assets = await f.choose(files, 2);
  assert.equal(f.inputs[0].accept, "image/*,video/*"); assert.equal(f.inputs[0].multiple, true); assert.equal(f.inputs[0].capture, undefined); assert.equal(f.inputs[0].removed, true);
  assert.deepEqual(assets.map(a => a.kind ?? a.type), ["image", "video"]); assert.equal(assets[1].file, files[1]); assert.equal(f.calls.filter(x => x[0] === "web-image-header").length, 1); assert.equal(f.videos.length, 0);
  f.media.releaseChatPickerAssets(assets); f.media.releaseChatPickerAssets(assets); assert.deepEqual(f.revoked.sort(), f.created.map(x => x.uri).sort());
  const g = fixture({ platform: "web" }); await g.choose([webFile("image/jpeg")], 6, "camera"); assert.equal(g.inputs[0].accept, "image/*,video/*"); assert.equal(g.inputs[0].multiple, false); assert.equal(g.inputs[0].capture, undefined);
});

test("web camera entry accepts one real video while preserving the safe browser-owned chooser", async () => {
  const f = fixture({ platform: "web" }), assets = await f.choose([webFile()], 6, "camera"), a = await f.media.prepareChatAttachment(assets[0]);
  assert.equal(f.inputs[0].multiple, false); assert.equal(f.inputs[0].capture, undefined); assert.equal(a.kind, "video"); assert.equal(a.durationMs, 12500); f.media.releaseChatAttachment(a);
  await assert.rejects(f.choose([webFile(), webFile()], 6, "camera"), rejectCode("too_large"));
});

test("web cancel is empty, excess selection and oversized video allocate no URLs, unknown original URLs are never revoked", async () => {
  const f = fixture({ platform: "web" }), pending = f.media.pickWebChatMediaFiles("library", 6); f.inputs[0].emit("cancel"); assert.deepEqual(await pending, []); assert.equal(f.inputs[0].removed, true);
  await assert.rejects(f.media.pickWebChatMediaFiles("library", 0), rejectCode("too_large")); assert.equal(f.inputs.length, 1);
  await assert.rejects(f.choose([webFile(), webFile()], 1), rejectCode("too_large"));
  await assert.rejects(f.choose([webFile("video/mp4", { size: 100 * 1024 * 1024 + 1 })]), rejectCode("too_large")); assert.equal(f.created.length, 0);
  f.media.releaseChatPickerAssets([video({ uri: "blob:external-original" })]); f.media.releaseChatAttachment({ id: "not-ours", kind: "video", uri: "file:///picker/original.mov" }); assert.deepEqual(f.revoked, []);
});

test("web local video uses metadata plus a bounded real first-frame canvas without play or raw-byte reads; owned URL transfers to draft", async () => {
  const f = fixture({ platform: "web" }), assets = await f.choose([webFile()]), a = await f.media.prepareChatAttachment(assets[0]);
  assert.equal(a.kind, "video"); assert.equal(a.durationMs, 12500); assert.equal(a.width, 1920); assert.equal(a.previewSource.uri, "data:image/jpeg;base64,/9j/AA==");
  assert.deepEqual(f.calls.find(x => x[0] === "draw"), ["draw", 0, 0, 320, 180]); assert.equal(f.videos[0].muted, true); assert.equal(f.videos[0].volume, 0); assert.equal(f.videos[0].autoplay, false); assert.equal(f.videos[0].preload, "metadata");
  assert.equal(f.videos[0].src, ""); assert.equal(f.videos[0].listenerCount(), 0); assert.equal(f.canvases[0].width, 1); assert.equal(f.timers.size, 0);
  f.media.releaseChatPickerAssets(assets); assert.deepEqual(f.revoked, [], "Picker finally must not revoke a successful draft's local video URL");
  f.media.releaseChatAttachment(a); f.media.releaseChatAttachment(a); assert.deepEqual(f.revoked, [assets[0].uri]);
});

test("a scoped provider's generic MIME still requires actual video metadata and a real cover", async () => {
  const f = fixture({ platform: "web" }), assets = await f.choose([webFile("application/octet-stream", { name: "clip.mov" })]), a = await f.media.prepareChatAttachment(assets[0]);
  assert.equal(a.kind, "video"); assert.equal(a.durationMs, 12500); assert.equal(f.calls.filter(x => x[0] === "draw").length, 1); assert.equal(f.calls.some(x => x[0] === "web-image-header"), false); f.media.releaseChatAttachment(a);
});

test("web image preparation keeps the existing helper's blob cleanup and bounded dataURI preview", async () => {
  const f = fixture({ platform: "web" }), assets = await f.choose([webFile("image/jpeg")]), a = await f.media.prepareChatAttachment(assets[0]);
  assert.equal(a.image, image); f.media.releaseChatPickerAssets(assets); f.media.releaseChatAttachment(a); assert.deepEqual(f.revoked, [assets[0].uri]); assert.equal(f.videos.length, 0);
});

test("web video timeout, bad metadata and canvas failures detach the decoder and release only owned URL", async () => {
  for (const options of [{ webDuration: 121 }, { webWidth: 5000 }, { noCanvas: true }, { badCover: true }, { webDecodeError: true }]) {
    const f = fixture({ platform: "web", ...options }), assets = await f.choose([webFile()]); await assert.rejects(f.media.prepareChatAttachment(assets[0]), rejectCode(options.webDuration || options.webWidth ? "too_large" : "processing_failed")); assert.equal(f.videos[0].src, ""); assert.equal(f.videos[0].listenerCount(), 0); assert.deepEqual(f.revoked, [assets[0].uri]);
  }
  const f = fixture({ platform: "web", webHold: true }), assets = await f.choose([webFile()]), pending = f.media.prepareChatAttachment(assets[0]); await tick(); const rejected = assert.rejects(pending, rejectCode("processing_failed")); f.timeout(); await rejected; assert.equal(f.videos[0].listenerCount(), 0); assert.equal(f.videos[0].src, ""); assert.deepEqual(f.revoked, [assets[0].uri]); f.videos[0].emit("loadeddata"); assert.equal(f.calls.some(x => x[0] === "draw"), false);
});

test("cancel during web header inspection releases earlier and late owned URLs instead of resurrecting a selection", async () => {
  const held = deferred(), f = fixture({ platform: "web", webImagePick: async (file, url) => { await held.promise; return { uri: url.createObjectURL(file), type: "image", width: 100, height: 100, file }; } });
  const pending = f.choose([webFile(), webFile("image/jpeg")]); await tick(); assert.equal(f.created.length, 1); f.inputs[0].emit("cancel"); assert.deepEqual(await pending, []); assert.deepEqual(f.revoked, [f.created[0].uri]); held.resolve(); await tick(); assert.deepEqual(f.revoked.sort(), f.created.map(x => x.uri).sort());
});
