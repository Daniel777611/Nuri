// One shared source, three existing registered products. Community is Alpha-only.
const { assertReleasePolicy } = require('./release-policy.cjs');
const ALPHA_TESTING_ORIGIN = 'https://nuri-git-testing-backend-alpha-ordashtech.vercel.app';
const BETA_TESTING_ORIGIN = 'https://nuri-git-testing-backend-beta-ordashtech.vercel.app';
const PRODUCTION_ORIGIN = 'https://nurifam.app';
const PROTOTYPE_FLAGS = Object.freeze(['EXPO_PUBLIC_PREVIEW_MODE', 'EXPO_PUBLIC_UIUX48_GALLERY',
  'EXPO_PUBLIC_FLOW_PROTOTYPE', 'EXPO_PUBLIC_COMMUNITY_PROTOTYPE']);
const PROFILES = Object.freeze({
  'live-alpha': Object.freeze({ flavor: 'live-alpha', channel: 'live-alpha',
    bundleIdentifier: 'com.ordashtech.nuri.beta', appStoreId: '6831012896',
    displayName: 'Nuri Alpha', scheme: 'nuri-beta', slug: 'nuri-beta', version: '0.4.0',
    buildNumber: '1096', communityEnabled: true, communityMode: 'live-api-v1', origin: ALPHA_TESTING_ORIGIN }),
  'early-access': Object.freeze({ flavor: 'early-access', channel: 'testflight-external',
    bundleIdentifier: 'com.ordashtech.nuri.earlyaccess', appStoreId: '6831131920',
    displayName: 'Nuri Preview', scheme: 'nuri-early-access', slug: 'nuri-early-access', version: '0.3.0',
    buildNumber: '1091', communityEnabled: false, communityMode: 'disabled', origin: BETA_TESTING_ORIGIN }),
  'app-store': Object.freeze({ flavor: 'app-store', channel: 'app-store',
    bundleIdentifier: 'com.ordashtech.nuri.nativelab', appStoreId: '6818022351',
    displayName: 'Nuri', scheme: 'nuri-native-lab', slug: 'nuri-native-lab', version: '0.3.9',
    buildNumber: '1092', communityEnabled: false, communityMode: 'disabled', origin: PRODUCTION_ORIGIN }),
});
assertReleasePolicy(PROFILES);
const LIVE_ALPHA = PROFILES['live-alpha'];

function liveAlphaBackendMode(env = process.env) {
  const flavor = env.EXPO_PUBLIC_RELEASE_FLAVOR;
  const localDebug = flavor === 'live-alpha' && env.CONFIGURATION === 'Debug'
    && /^iphonesimulator/.test(env.SDK_NAME || '') && env.NURI_LOCAL_COMMUNITY_DEBUG === '1'
    && env.EXPO_PUBLIC_BACKEND_URL === 'http://127.0.0.1:8765';
  if (localDebug) return 'simulator-local-router';
  if (env.NURI_LOCAL_COMMUNITY_DEBUG !== undefined && env.NURI_LOCAL_COMMUNITY_DEBUG !== '0') {
    throw new Error('Local debugging requires the isolated Alpha Debug simulator.');
  }
  const profile = PROFILES[flavor];
  if (!profile || env.EXPO_PUBLIC_BACKEND_URL !== profile.origin) throw new Error('The selected product requires its exact API origin.');
  return flavor === 'live-alpha' ? 'alpha-testing' : flavor === 'early-access' ? 'beta-testing' : 'production';
}

function resolveReleaseProfile(env = process.env) {
  const flavor = env.EXPO_PUBLIC_RELEASE_FLAVOR;
  if (!flavor) return null;
  const profile = PROFILES[flavor];
  if (!profile || env.NURI_RELEASE_CHANNEL !== profile.channel) throw new Error('The release flavor and channel must identify one existing product.');
  if (PROTOTYPE_FLAGS.some(key => env[key] !== undefined && env[key] !== '0')) throw new Error('Release builds require prototype and fixture flags disabled.');
  liveAlphaBackendMode(env);
  for (const key of ['PRODUCT_BUNDLE_IDENTIFIER', 'NURI_APP_BUNDLE_IDENTIFIER']) {
    if (env[key] !== undefined && env[key] !== profile.bundleIdentifier) throw new Error('The app bundle does not match the selected product.');
  }
  for (const [key, expected] of [['NURI_BUILD_NUMBER', profile.buildNumber], ['NURI_APP_BUILD_NUMBER', profile.buildNumber],
    ['NURI_MARKETING_VERSION', profile.version], ['NURI_APP_MARKETING_VERSION', profile.version]]) {
    if (env[key] !== undefined && env[key] !== expected) throw new Error('The version and build must match this release candidate.');
  }
  return profile;
}

function assertLiveAlphaProfile(profile) {
  if (profile !== LIVE_ALPHA && (!profile || Object.keys(LIVE_ALPHA).some(key => profile[key] !== LIVE_ALPHA[key]))) {
    throw new Error('Expected the current Alpha profile.');
  }
  return profile;
}
module.exports = { PROFILES, LIVE_ALPHA, ALPHA_TESTING_ORIGIN, BETA_TESTING_ORIGIN, PRODUCTION_ORIGIN,
  PROTOTYPE_FLAGS, resolveReleaseProfile, assertLiveAlphaProfile, liveAlphaBackendMode };
