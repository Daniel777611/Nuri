const { resolveReleaseProfile, liveAlphaBackendMode } = require('./profiles.cjs');
const productionGoogle = require('../app.json').expo.plugins.find(p => Array.isArray(p) && p[0] === './plugins/withNuriGoogleSignIn')[1];
const clients = Object.freeze({
  'live-alpha': '22059260132-d1bj5842fjq1f4g6v097flm5ubn6fsdo.apps.googleusercontent.com',
  'early-access': '22059260132-mn5m08856rb2k198lsrsl3t1kjrnchr7.apps.googleusercontent.com',
  'app-store': '22059260132-gpd9u7gra897fs9p7ue6n62sa0nppfuv.apps.googleusercontent.com',
});
function liveAlphaGoogleConfiguration(env = process.env) {
  const profile = resolveReleaseProfile(env);
  if (!profile) throw new Error('Select the exact release profile first.');
  const iosClientId = clients[profile.flavor];
  if (profile.flavor === 'live-alpha' && env.NURI_BETA_GOOGLE_IOS_CLIENT_ID !== iosClientId
    || profile.flavor === 'early-access' && env.NURI_EARLY_ACCESS_GOOGLE_IOS_CLIENT_ID !== iosClientId) {
    throw new Error('The selected product requires its existing registered Google client.');
  }
  return { ...productionGoogle, iosClientId, bundleIdentifier: profile.bundleIdentifier };
}
function nativeMetadata(base, profile, env = process.env) {
  if (resolveReleaseProfile(env) !== profile) throw new Error('Use the selected release profile.');
  const google = liveAlphaGoogleConfiguration(env);
  const { NSAllowsLocalNetworking: _local, ...ats } = base.NSAppTransportSecurity || {};
  return {
    ...base, CFBundleIdentifier: profile.bundleIdentifier, CFBundleDisplayName: profile.displayName,
    CFBundleVersion: profile.buildNumber, CFBundleShortVersionString: profile.version,
    CFBundleURLTypes: [{ CFBundleURLSchemes: [profile.scheme, profile.bundleIdentifier] },
      { CFBundleURLSchemes: [google.iosClientId.split('.').reverse().join('.')] }],
    GIDClientID: google.iosClientId, GIDServerClientID: google.webClientId,
    NSUserActivityTypes: [profile.bundleIdentifier + '.expo.index_route'],
    NuriReleaseFlavor: profile.flavor, NuriReleaseChannel: profile.channel,
    NuriCommunityMode: profile.communityMode, NuriAPNSEnvironment: 'production',
    ...(profile.flavor === 'live-alpha' ? {
      NSLocationWhenInUseUsageDescription: 'Nuri uses your approximate area to find nearby activities for your family.',
    } : {}),
    NSAppTransportSecurity: { ...ats, NSAllowsArbitraryLoads: false,
      ...(liveAlphaBackendMode(env) === 'simulator-local-router' ? { NSAllowsLocalNetworking: true } : {}) },
  };
}
module.exports = { nativeMetadata, liveAlphaGoogleConfiguration };
