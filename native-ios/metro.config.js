const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
// Keep Expo's version-matched cache store instead of importing a transitive
// Metro dependency from the copied web configuration (pnpm is strict).
config.maxWorkers = 2;
module.exports = config;
