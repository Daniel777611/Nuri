import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
assert.match(chat, /prepareChatImage\(asset\)/, "selected photos must be resized and compressed");
assert.match(chat, /setPendingImage\(prepared\)/, "a prepared photo must enter send-preview state");
assert.match(chat, /testID="chat-image-preview"/, "the chosen photo must be visible before send");
assert.match(chat, /testID="chat-image-remove"/, "the chosen photo must be removable before send");
assert.match(chat, /selectedImage\?\.dataUri/, "the send payload must use the prepared data URI");
assert.match(chat, /Platform\.OS === "web"/, "web must have an explicit picker behavior");
assert.match(chat, /AI 服务（OpenAI）分析/, "the picker must disclose that AI processes the photo");

assert.match(imageInput, /CHAT_IMAGE_MAX_SOURCE_BYTES/, "source files need a hard size limit");
assert.match(imageInput, /CHAT_IMAGE_MAX_DATA_URI_CHARS/, "encoded requests need a hard size limit");
assert.match(imageInput, /SaveFormat\.JPEG/, "chat photos must use a predictable MIME type");
assert.match(imageInput, /data:image\/jpeg;base64,/, "the API must receive a complete data URI");
assert.match(imageInput, /compress\(asset, 1200, 0\.55\)/, "oversized first-pass output needs a bounded retry");

const pickerPlugin = appConfig.expo.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-image-picker",
);
assert.ok(pickerPlugin, "native builds must configure the image-picker plugin");
assert.ok(pickerPlugin[1].photosPermission, "iOS needs a user-facing photo permission reason");
assert.ok(pickerPlugin[1].cameraPermission, "iOS needs a user-facing camera permission reason");
assert.equal(pickerPlugin[1].microphonePermission, false, "image-only chat must not request microphone access");

console.log("chat image-input contracts passed");
