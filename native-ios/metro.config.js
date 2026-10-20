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
    backend: process.env.EXPO_PUBLIC_BACKEND_URL ?? null,
  }))
  .digest("hex");
config.cacheVersion = `nuri-public-build-${publicBuildFingerprint}`;
// Release graph exclusion, not just a hidden button or a runtime flag. The
// resolver's dev bit is supplied by Metro; an env flag alone cannot enable it.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "nuri-uiux48-fixture-gallery") {
    const enabled = context.dev === true && process.env.EXPO_PUBLIC_PREVIEW_MODE === "1" && process.env.EXPO_PUBLIC_UIUX48_GALLERY === "1";
    return { type: "sourceFile", filePath: path.resolve(__dirname, enabled ? "src/dev/uiux48/Gallery.tsx" : "src/uiux48/GalleryUnavailable.tsx") };
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
