const { getDefaultConfig } = require("expo/metro-config");
const { createHash } = require("node:crypto");
const path = require("node:path");
const config = getDefaultConfig(__dirname);
// Keep Expo's version-matched cache store instead of importing a transitive
// Metro dependency from the copied web configuration (pnpm is strict).
config.maxWorkers = 2;
// Inline public flags change generated JS even when source bytes do not. A
// live Metro preview must never repopulate a Release build's fixture cache.
const publicBuildFingerprint = createHash("sha256")
  .update(JSON.stringify({
    preview: process.env.EXPO_PUBLIC_PREVIEW_MODE === "1",
    gallery: process.env.EXPO_PUBLIC_UIUX48_GALLERY === "1",
    flowPrototype: process.env.EXPO_PUBLIC_FLOW_PROTOTYPE === "1",
    channel: process.env.NURI_RELEASE_CHANNEL ?? null,
    flavor: process.env.EXPO_PUBLIC_RELEASE_FLAVOR ?? null,
    communityPrototype: process.env.EXPO_PUBLIC_COMMUNITY_PROTOTYPE ?? null,
    bundle: require("./app.json").expo.ios.bundleIdentifier,
    nativeBundle: process.env.PRODUCT_BUNDLE_IDENTIFIER ?? null,
    nativeSDK: process.env.SDK_NAME ?? null,
    backend: process.env.EXPO_PUBLIC_BACKEND_URL ?? null,
  }))
  .digest("hex");
config.cacheVersion = `nuri-public-build-${publicBuildFingerprint}`;
// Release graph exclusion, not just a hidden button or a runtime flag. The
// Native QA still requires its scoped channel. The independent web handoff
// channel enables ONLY Community's local reducer, never the API fixture mode.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "nuri-live-community") {
    const enabled = process.env.NURI_RELEASE_CHANNEL === "live-alpha"
      && process.env.EXPO_PUBLIC_RELEASE_FLAVOR === "live-alpha"
      && ["EXPO_PUBLIC_PREVIEW_MODE", "EXPO_PUBLIC_UIUX48_GALLERY", "EXPO_PUBLIC_FLOW_PROTOTYPE", "EXPO_PUBLIC_COMMUNITY_PROTOTYPE"].every(key => process.env[key] === undefined || process.env[key] === "0");
    return { type: "sourceFile", filePath: path.resolve(__dirname, enabled ? "src/uiuxfinal/CommunityFinal.tsx" : "src/uiuxfinal/CommunityUnavailable.tsx") };
  }
  if (moduleName === "nuri-ux49-flow-preview") {
    const bundle = require("./app.json").expo.ios.bundleIdentifier;
    const requested = process.env.EXPO_PUBLIC_FLOW_PROTOTYPE === "1";
    const testflight = process.env.NURI_RELEASE_CHANNEL === "testflight-prototype" && bundle === "com.ordashtech.nuri.nativelab" && process.env.EXPO_PUBLIC_PREVIEW_MODE === "0" && process.env.EXPO_PUBLIC_UIUX48_GALLERY !== "1";
    const simulatorQA = process.env.PRODUCT_BUNDLE_IDENTIFIER === "com.ordashtech.nuri.preview.qa" && /^iphonesimulator/.test(process.env.SDK_NAME ?? "");
    const isolatedQA = process.env.NURI_RELEASE_CHANNEL === "uiux49-qa" && (context.dev === true || simulatorQA) && process.env.EXPO_PUBLIC_PREVIEW_MODE === "1";
    const webLocalPrototype = platform === "web" && process.env.NURI_RELEASE_CHANNEL === "web-local-prototype" && process.env.EXPO_PUBLIC_PREVIEW_MODE === "0" && process.env.EXPO_PUBLIC_UIUX48_GALLERY !== "1";
    return { type: "sourceFile", filePath: path.resolve(__dirname, requested && (testflight || isolatedQA || webLocalPrototype) ? "src/uiux49/prototype/FlowPreview.tsx" : "src/uiux49/FlowUnavailable.tsx") };
  }
  if (moduleName === "nuri-uiux48-fixture-gallery") {
    const enabled = context.dev === true && process.env.EXPO_PUBLIC_PREVIEW_MODE === "1" && process.env.EXPO_PUBLIC_UIUX48_GALLERY === "1";
    return { type: "sourceFile", filePath: path.resolve(__dirname, enabled ? "src/dev/uiux48/Gallery.tsx" : "src/uiux48/GalleryUnavailable.tsx") };
  }
  const resolution = context.resolveRequest(context, moduleName, platform);
  // api.ts and native hooks also import the preview-mode switch. A false
  // runtime switch does not remove that module's fixture data from Hermes.
  // Substitute only this app's resolved module, never another package's
  // similarly named import, and leave main/Android/prototype channels intact.
  const liveAlphaIOS = platform === "ios"
    && process.env.NURI_RELEASE_CHANNEL === "live-alpha"
    && process.env.EXPO_PUBLIC_RELEASE_FLAVOR === "live-alpha"
    && ["EXPO_PUBLIC_PREVIEW_MODE", "EXPO_PUBLIC_UIUX48_GALLERY", "EXPO_PUBLIC_FLOW_PROTOTYPE", "EXPO_PUBLIC_COMMUNITY_PROTOTYPE"].every(key => process.env[key] === undefined || process.env[key] === "0");
  if (liveAlphaIOS && resolution.type === "sourceFile"
    && path.resolve(resolution.filePath) === path.resolve(__dirname, "src/preview-api.ts")) {
    return { type: "sourceFile", filePath: path.resolve(__dirname, "src/preview-api.unavailable.ts") };
  }
  return resolution;
};
module.exports = config;
