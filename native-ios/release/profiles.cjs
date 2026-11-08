// Only the existing Alpha app may be released from this Community-connected
// branch. The unselected main configuration remains unchanged.
const LIVE_ALPHA = Object.freeze({
  flavor: 'live-alpha', channel: 'live-alpha',
  bundleIdentifier: 'com.ordashtech.nuri.beta', appStoreId: '6831012896',
  displayName: 'Nuri Alpha', scheme: 'nuri-beta', slug: 'nuri-beta',
  version: '0.4.0', buildNumber: '1058', communityEnabled: true,
  communityMode: 'live-api-v1',
});
const PROFILES = Object.freeze({ 'live-alpha': LIVE_ALPHA });
const PROTOTYPE_FLAGS = Object.freeze(['EXPO_PUBLIC_PREVIEW_MODE', 'EXPO_PUBLIC_UIUX48_GALLERY',
  'EXPO_PUBLIC_FLOW_PROTOTYPE', 'EXPO_PUBLIC_COMMUNITY_PROTOTYPE']);

function liveAlphaBackendMode(env = process.env) {
  const url = env.EXPO_PUBLIC_BACKEND_URL;
  const localDebug = env.CONFIGURATION === 'Debug' && /^iphonesimulator/.test(env.SDK_NAME || '')
    && env.NURI_LOCAL_COMMUNITY_DEBUG === '1' && url === 'http://127.0.0.1:8765';
  if (localDebug) return 'simulator-local-router';
  if (env.NURI_LOCAL_COMMUNITY_DEBUG !== undefined && env.NURI_LOCAL_COMMUNITY_DEBUG !== '0') throw new Error('Local Community debugging requires exact Debug/simulator/localhost scope.');
  if (url !== undefined && url !== '' && url !== 'https://nurifam.app') throw new Error('Live Alpha release uses only https://nurifam.app/api.');
  return 'production';
}

function assertLiveAlphaProfile(profile) {
  if (!profile || Object.entries(LIVE_ALPHA).some(([key, value]) => key !== 'buildNumber' && profile[key] !== value)) {
    throw new Error('Only the exact existing live Alpha identity is supported.');
  }
  if (typeof profile.buildNumber !== 'string' || !/^[1-9]\d*$/.test(profile.buildNumber) || !Number.isSafeInteger(Number(profile.buildNumber))
    || Number(profile.buildNumber) < 1058 || Number(profile.buildNumber) % 2 !== 0) {
    throw new Error('Live Alpha requires an even safe build number of at least 1058.');
  }
  return profile;
}

function resolveReleaseProfile(env = process.env) {
  const flavor = env.EXPO_PUBLIC_RELEASE_FLAVOR;
  if (!flavor) return null; // Preserve main's app.json/native defaults.
  if (flavor !== LIVE_ALPHA.flavor) throw new Error('This branch releases only live-alpha, never a legacy/prototype or another app.');
  if (env.NURI_RELEASE_CHANNEL !== LIVE_ALPHA.channel) throw new Error('Live Alpha requires its explicit live-alpha channel.');
  if (PROTOTYPE_FLAGS.some(key => env[key] !== undefined && env[key] !== '0')) {
    throw new Error('Live Alpha requires every preview, gallery, flow and Community prototype flag disabled.');
  }
  liveAlphaBackendMode(env);
  if (env.PRODUCT_BUNDLE_IDENTIFIER !== undefined && env.PRODUCT_BUNDLE_IDENTIFIER !== LIVE_ALPHA.bundleIdentifier) throw new Error('Native bundle identifier does not match live Alpha.');
  if (env.NURI_APP_BUNDLE_IDENTIFIER !== undefined && env.NURI_APP_BUNDLE_IDENTIFIER !== LIVE_ALPHA.bundleIdentifier) throw new Error('Custom app bundle identifier does not match live Alpha.');
  const profile = assertLiveAlphaProfile({ ...LIVE_ALPHA, buildNumber: env.NURI_BUILD_NUMBER ?? LIVE_ALPHA.buildNumber,
    version: env.NURI_MARKETING_VERSION ?? LIVE_ALPHA.version });
  for (const [key, value] of [['NURI_APP_BUILD_NUMBER', profile.buildNumber], ['NURI_APP_MARKETING_VERSION', profile.version]]) {
    if (env[key] !== undefined && env[key] !== value) throw new Error('Custom app build/version does not match live Alpha.');
  }
  return profile;
}

module.exports = { PROFILES, LIVE_ALPHA, PROTOTYPE_FLAGS, assertLiveAlphaProfile, resolveReleaseProfile, liveAlphaBackendMode };
