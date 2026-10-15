const { withInfoPlist } = require('@expo/config-plugins');

const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

// Public IDs only; no Firebase, client secret, backend change, or placeholder.
// Root owns app.json and enables this plugin when building the native lab.
function withNuriGoogleSignIn(config, options = {}) {
  const iosClientId = options.iosClientId || process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '';
  const webClientId = options.webClientId || process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
  if (!iosClientId && !webClientId) return config;
  if (!CLIENT_ID.test(iosClientId) || !CLIENT_ID.test(webClientId)) {
    throw new Error('NURI Google sign-in requires real public iOS and Web OAuth client IDs; no secret is accepted.');
  }
  if (config.ios?.bundleIdentifier !== 'com.ordashtech.nuri.nativelab') {
    throw new Error('NURI Google sign-in is scoped to the independent Native Lab bundle.');
  }
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
