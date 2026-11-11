const { resolveReleaseProfile, liveAlphaBackendMode } = require('./release/profiles.cjs');
const { liveAlphaGoogleConfiguration } = require('./release/native-metadata.cjs');

module.exports = ({ config }) => {
  const env = { ...process.env };
  // EXConstants evaluates app config in its own static Pod. No other target
  // may replace its real bundle identity with an app-owned override.
  const constantsPod = env.EXPO_PUBLIC_RELEASE_FLAVOR === 'live-alpha' && env.PROJECT_NAME === 'Pods'
    && env.TARGET_NAME === 'EXConstants' && env.PRODUCT_TYPE === 'com.apple.product-type.library.static'
    && env.PRODUCT_BUNDLE_IDENTIFIER === 'org.cocoapods.EXConstants';
  if (constantsPod) {
    if (!env.NURI_APP_BUNDLE_IDENTIFIER) throw new Error('EXConstants requires the explicit app bundle identifier.');
    env.PRODUCT_BUNDLE_IDENTIFIER = env.NURI_APP_BUNDLE_IDENTIFIER;
  }
  const profile = resolveReleaseProfile(env);
  if (!profile) return config;
  const google = liveAlphaGoogleConfiguration(env);
  const { NSAllowsLocalNetworking: _local, ...ats } = config.ios.infoPlist?.NSAppTransportSecurity || {};
  return {
    ...config, name: profile.displayName, slug: profile.slug, scheme: profile.scheme, version: profile.version,
    ios: { ...config.ios, bundleIdentifier: profile.bundleIdentifier, buildNumber: profile.buildNumber,
      infoPlist: { ...config.ios.infoPlist, CFBundleDisplayName: profile.displayName,
        NuriReleaseFlavor: profile.flavor, NuriReleaseChannel: profile.channel, NuriCommunityMode: profile.communityMode,
        NSAppTransportSecurity: { ...ats, NSAllowsArbitraryLoads: false,
          ...(liveAlphaBackendMode(env) === 'simulator-local-router' ? { NSAllowsLocalNetworking: true } : {}) } } },
    plugins: config.plugins.map(p => Array.isArray(p) && p[0] === './plugins/withNuriGoogleSignIn' ? [p[0], google] : p),
    extra: { ...config.extra, releaseFlavor: profile.flavor, releaseChannel: profile.channel,
      communityEnabled: true, communityMode: profile.communityMode },
  };
};
