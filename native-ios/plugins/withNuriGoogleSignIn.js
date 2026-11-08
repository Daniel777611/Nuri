const { withInfoPlist } = require('@expo/config-plugins');

const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const PRODUCTION_BUNDLE_ID = 'com.ordashtech.nuri.nativelab';
const BETA_BUNDLE_ID = 'com.ordashtech.nuri.beta';
const PREVIEW_BUNDLE_ID = 'com.ordashtech.nuri.earlyaccess';
const PRODUCTION_IOS_CLIENT_ID = '22059260132-gpd9u7gra897fs9p7ue6n62sa0nppfuv.apps.googleusercontent.com';
const BETA_IOS_CLIENT_ID = '22059260132-d1bj5842fjq1f4g6v097flm5ubn6fsdo.apps.googleusercontent.com';

// Public IDs only; no Firebase, client secret, backend change, or placeholder.
// Identity support does not authorize building/releasing another app.
function withNuriGoogleSignIn(config, options = {}) {
  const bundleIdentifier = options.bundleIdentifier || config.ios?.bundleIdentifier;
  if (![PRODUCTION_BUNDLE_ID, BETA_BUNDLE_ID, PREVIEW_BUNDLE_ID].includes(bundleIdentifier)
    || config.ios?.bundleIdentifier !== bundleIdentifier) {
    throw new Error('NURI Google sign-in requires an allowlisted matching independent app identity.');
  }
  const iosClientId = options.iosClientId
    || (bundleIdentifier === PRODUCTION_BUNDLE_ID ? process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID : '') || '';
  const webClientId = options.webClientId || process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
  if (!iosClientId && !webClientId && bundleIdentifier === PRODUCTION_BUNDLE_ID) return config;
  if (!CLIENT_ID.test(iosClientId) || !CLIENT_ID.test(webClientId)) {
    throw new Error('NURI Google sign-in requires real public iOS and Web OAuth client IDs; no secret is accepted.');
  }
  if (bundleIdentifier === BETA_BUNDLE_ID && iosClientId !== BETA_IOS_CLIENT_ID) throw new Error('Alpha/Beta must reuse its actual registered iOS OAuth client.');
  if (bundleIdentifier === PREVIEW_BUNDLE_ID && [PRODUCTION_IOS_CLIENT_ID, BETA_IOS_CLIENT_ID, webClientId].includes(iosClientId)) throw new Error('Preview requires its distinct registered iOS OAuth client.');
  const officialPlugin = require('@react-native-google-signin/google-signin/app.plugin.js');
  const applyOfficial = officialPlugin.default || officialPlugin;
  config = applyOfficial(config, { iosUrlScheme: iosClientId.split('.').reverse().join('.') });
  return withInfoPlist(config, (mod) => {
    mod.modResults.GIDClientID = iosClientId;
    mod.modResults.GIDServerClientID = webClientId;
    return mod;
  });
}

module.exports = withNuriGoogleSignIn;
