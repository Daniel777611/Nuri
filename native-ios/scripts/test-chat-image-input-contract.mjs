import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const chat = read("../app/chat/[id].tsx");
const imageInput = read("../src/chatImageInput.ts");
const appConfig = JSON.parse(read("../app.json"));

assert.match(chat, /requestCameraPermissionsAsync\(\)/, "camera use must request permission");
assert.match(chat, /requestMediaLibraryPermissionsAsync\(\)/, "photo library use must request permission");
assert.match(chat, /launchCameraAsync\(/, "the action menu must support taking a photo");
assert.match(chat, /launchImageLibraryAsync\(/, "the action menu must support choosing a photo");
assert.match(chat, /Do not force capture=environment/, "web camera entry must avoid forced PWA capture");
assert.match(chat, /onDismiss=\{flushNativePicker\}/, "native camera must wait for the modal to close");
assert.match(chat, /getPendingResultAsync\(\)/, "Android camera results must survive activity recreation");
assert.match(chat, /pickWebChatImageFile\(\)/, "web must own the raw file picker instead of Expo metadata decoding");
assert.match(
  chat,
  /if \(Platform\.OS === "web"\)[\s\S]*?void openSafeWebPicker\(\);[\s\S]*?setImageMenuVisible\(true\);/,
  "the plus button must open the system picker directly on web and reserve the NURI menu for native builds",
);
assert.match(chat, /onPress=\{openImageInput\}/, "the plus button must use the direct picker dispatcher");
assert.match(chat, /prepareChatImage\(asset\)/, "selected photos must be resized and compressed");
assert.match(chat, /setPendingImage\(prepared\)/, "a prepared photo must enter send-preview state");
assert.match(chat, /testID="chat-image-preview"/, "the chosen photo must be visible before send");
assert.match(chat, /testID="chat-image-remove"/, "the chosen photo must be removable before send");
assert.match(chat, /selectedImage\?\.dataUri/, "the send payload must use the prepared data URI");
assert.match(chat, /Platform\.OS === "web"/, "web must have an explicit picker behavior");
assert.match(chat, /AI 服务（OpenAI）分析/, "the picker must disclose that AI processes the photo");

assert.match(imageInput, /CHAT_IMAGE_MAX_SOURCE_BYTES/, "source files need a hard size limit");
assert.match(imageInput, /CHAT_IMAGE_MAX_SOURCE_PIXELS/, "camera photos need a decoded-pixel limit");
assert.match(imageInput, /CHAT_IMAGE_MAX_DATA_URI_CHARS/, "encoded requests need a hard size limit");
assert.match(imageInput, /createImageBitmap/, "web photos must use bounded decode-time resizing");
assert.match(imageInput, /readEncodedImageDimensions/, "web must inspect encoded dimensions before image decode");
assert.match(imageInput, /input\.type = "file"/, "web must use a browser-owned raw file input");
assert.doesNotMatch(imageInput, /input\.capture/, "the PWA picker must never force a camera process transition");
assert.match(imageInput, /SaveFormat\.JPEG/, "chat photos must use a predictable MIME type");
assert.match(imageInput, /data:image\/jpeg;base64,/, "the API must receive a complete data URI");
assert.match(imageInput, /resizeNativeImage\(image, image\.width, image\.height, 1200\)/, "native retry must resize the bounded reference, not decode the source again");
assert.match(imageInput, /ImageManipulator\.ImageManipulator\.manipulate\(source\)/, "native must use the current contextual Expo API");
assert.match(imageInput, /generatedFiles\) deleteGeneratedImage/, "all generated native JPEGs need final cleanup");

function imageFixture(options = {}) {
  const calls = [];
  const files = new Set();
  const deleted = [];
  const released = [];
  const platform = { OS: options.platform ?? "ios" };
  let saves = 0;
  const manipulator = {
    SaveFormat: { JPEG: "jpeg" },
    ImageManipulator: {
      manipulate(source) {
        const contextId = calls.filter((call) => call.kind === "source").length + 1;
        calls.push({ kind: "source", source, contextId });
        let target;
        return {
          resize(size) { target = size; calls.push({ kind: "resize", size, contextId }); },
          async renderAsync() {
            if (options.renderError) throw new Error("native decode failed");
            const image = {
              width: options.renderWidth ?? target.width,
              height: options.renderHeight ?? target.height,
              release() { released.push("image" + contextId); },
              async saveAsync(saveOptions) {
                saves++;
                calls.push({ kind: "save", saveOptions, contextId });
                if (options.saveError) throw new Error("native JPEG save failed");
                const uri = options.outputUri ?? "file:///cache/ImageManipulator/" + saves + ".jpg";
                files.add(uri);
                const oversized = options.alwaysOversized || (options.firstOversized && saves === 1);
                return {
                  uri, width: options.outputWidth ?? image.width, height: image.height,
                  base64: options.base64 ?? (oversized ? "/9j/" + "A".repeat(3 * 1024 * 1024) : "/9j/AA=="),
                };
              },
            };
            return image;
          },
          release() { released.push("context" + contextId); },
        };
      },
    },
  };
  class File {
    constructor(uri) { this.uri = uri; }
    get exists() { return files.has(this.uri); }
    delete() { deleted.push(this.uri); files.delete(this.uri); }
  }
  const deps = {
    "expo-image-manipulator": manipulator,
    "expo-file-system": { File, Paths: { cache: { uri: "file:///cache/" } } },
    "react-native": { Platform: platform },
  };
  const compiled = ts.transpileModule(imageInput, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(name in deps, "unexpected dependency " + name);
    return deps[name];
  }, loaded, loaded.exports);
  return { prepare: loaded.exports.prepareChatImage, calls, files, deleted, released };
}

const photo = { uri: "file:///picker/original.heic", type: "image", width: 8064, height: 6048, fileSize: 8 * 1024 * 1024 };
for (const dimensions of [[5712, 4284], [8064, 6048], [6048, 8064]]) {
  const fixture = imageFixture();
  const result = await fixture.prepare({ ...photo, width: dimensions[0], height: dimensions[1] });
  assert.equal(Math.max(result.width, result.height), 1600, "24/48 MP native photos must resize before JPEG save");
  assert.equal(result.previewUri, result.dataUri, "preview must survive deleting temporary JPEGs");
  assert.ok(result.dataUri.startsWith("data:image/jpeg;base64,/9j/"));
  assert.equal(fixture.calls.filter((call) => call.kind === "source").length, 1);
  assert.equal(fixture.calls.find((call) => call.kind === "save").saveOptions.format, "jpeg");
  assert.deepEqual(fixture.released, ["context1", "image1"]);
  assert.equal(fixture.files.size, 0, "successful preparation must not retain cache JPEGs");
  assert.ok(!fixture.deleted.includes(photo.uri), "picker originals are never deleted");
}

for (const dimensions of [[10001, 1], [10000, 5001], [100000, 100000], [Infinity, 100], [NaN, 100], [0, 100], [-1, 100], [1.5, 100]]) {
  const fixture = imageFixture();
  await assert.rejects(fixture.prepare({ ...photo, width: dimensions[0], height: dimensions[1] }), (error) => error.name === "ChatImageInputError");
  assert.equal(fixture.calls.length, 0, "extreme/invalid native dimensions must fail before native allocation");
}

{
  const fixture = imageFixture({ platform: "web" });
  await assert.rejects(fixture.prepare(photo), (error) => error.code === "too_large");
  assert.equal(fixture.calls.length, 0, "web must keep its original 16 MP pre-decode guard");
}

{
  const fixture = imageFixture({ firstOversized: true });
  const result = await fixture.prepare(photo);
  assert.equal(Math.max(result.width, result.height), 1200);
  const sources = fixture.calls.filter((call) => call.kind === "source");
  assert.equal(sources.length, 2);
  assert.equal(sources[0].source, photo.uri);
  assert.equal(typeof sources[1].source, "object", "retry must reuse the 1600px ImageRef");
  assert.equal(fixture.calls.filter((call) => call.kind === "save")[1].saveOptions.compress, 0.55);
  assert.equal(fixture.deleted.length, 2, "both first-pass and retry JPEGs must be removed");
  assert.equal(fixture.files.size, 0);
}

for (const options of [{ alwaysOversized: true }, { base64: "" }, { base64: "/9j/!!!!" }, { outputWidth: 1601 }, { renderWidth: 1601 }, { renderError: true }, { saveError: true }]) {
  const fixture = imageFixture(options);
  await assert.rejects(fixture.prepare(photo), (error) => error.name === "ChatImageInputError");
  assert.equal(fixture.files.size, 0, "failed preparation must still remove its generated JPEGs");
  assert.ok(fixture.released.some((item) => item.startsWith("context")), "native context must release on failure");
}

{
  const fixture = imageFixture({ outputUri: photo.uri });
  await fixture.prepare(photo);
  assert.ok(!fixture.deleted.includes(photo.uri), "even an unexpected native result cannot delete the source");
}

{
  const fixture = imageFixture();
  await Promise.all([fixture.prepare(photo), fixture.prepare(photo)]);
  const secondSource = fixture.calls.findIndex((call) => call.kind === "source" && call.contextId === 2);
  const firstSave = fixture.calls.findIndex((call) => call.kind === "save" && call.contextId === 1);
  assert.ok(secondSource > firstSave, "full-resolution native decode must be serialized");
  assert.equal(fixture.files.size, 0);
}

const pickerPlugin = appConfig.expo.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-image-picker",
);
assert.ok(pickerPlugin, "native builds must configure the image-picker plugin");
assert.ok(pickerPlugin[1].photosPermission, "iOS needs a user-facing photo permission reason");
assert.ok(pickerPlugin[1].cameraPermission, "iOS needs a user-facing camera permission reason");
assert.equal(pickerPlugin[1].microphonePermission, false, "image-only chat must not request microphone access");

console.log("chat image-input contracts passed");
