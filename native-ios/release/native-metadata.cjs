const { assertLiveAlphaProfile, resolveReleaseProfile, liveAlphaBackendMode } = require('./profiles.cjs');
const BETA_IOS_CLIENT_ID = '22059260132-d1bj5842fjq1f4g6v097flm5ubn6fsdo.apps.googleusercontent.com';
const productionGoogle = require('../app.json').expo.plugins.find(p => Array.isArray(p) && p[0] === './plugins/withNuriGoogleSignIn')[1];

function liveAlphaGoogleConfiguration(env = process.env) {
  if (env.NURI_BETA_GOOGLE_IOS_CLIENT_ID !== BETA_IOS_CLIENT_ID) throw new Error('Live Alpha must reuse its actual registered Beta iOS OAuth client.');
  return { ...productionGoogle, iosClientId: BETA_IOS_CLIENT_ID, bundleIdentifier: 'com.ordashtech.nuri.beta' };
}

// Stage app-only Info.plist values; do not mutate the main project's base plist
// or reuse another app's profile, callback or APNs topic.
function nativeMetadata(base, profile, env = process.env) {
  assertLiveAlphaProfile(profile);
  const selected = resolveReleaseProfile(env);
  if (!selected || selected.buildNumber !== profile.buildNumber) throw new Error('Metadata requires the selected matching live Alpha profile.');
  const google = liveAlphaGoogleConfiguration(env);
  const { NSAllowsLocalNetworking: _local, ...ats } = base.NSAppTransportSecurity || {};
  return {
    ...base,
    CFBundleIdentifier: profile.bundleIdentifier, CFBundleDisplayName: profile.displayName,
    CFBundleShortVersionString: profile.version, CFBundleVersion: profile.buildNumber,
    CFBundleURLTypes: [{ CFBundleURLSchemes: [profile.scheme, profile.bundleIdentifier] },
      { CFBundleURLSchemes: [google.iosClientId.split('.').reverse().join('.')] }],
    GIDClientID: google.iosClientId, GIDServerClientID: google.webClientId,
    NSUserActivityTypes: [profile.bundleIdentifier + '.expo.index_route'],
    NuriReleaseFlavor: profile.flavor, NuriReleaseChannel: profile.channel,
    NuriCommunityMode: profile.communityMode, NuriAPNSEnvironment: 'production',
    NSAppTransportSecurity: { ...ats, NSAllowsArbitraryLoads: false,
      ...(liveAlphaBackendMode(env) === 'simulator-local-router' ? { NSAllowsLocalNetworking: true } : {}) },
  };
}

module.exports = { nativeMetadata, liveAlphaGoogleConfiguration };
