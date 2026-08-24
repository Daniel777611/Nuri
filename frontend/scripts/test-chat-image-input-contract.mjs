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
assert.match(imageInput, /compress\(asset, 1200, 0\.55\)/, "oversized first-pass output needs a bounded retry");

const pickerPlugin = appConfig.expo.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === "expo-image-picker",
);
assert.ok(pickerPlugin, "native builds must configure the image-picker plugin");
assert.ok(pickerPlugin[1].photosPermission, "iOS needs a user-facing photo permission reason");
assert.ok(pickerPlugin[1].cameraPermission, "iOS needs a user-facing camera permission reason");
assert.equal(pickerPlugin[1].microphonePermission, false, "image-only chat must not request microphone access");

console.log("chat image-input contracts passed");
