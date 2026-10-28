const { AndroidConfig, withAndroidManifest, withAppBuildGradle, withStringsXml } = require('@expo/config-plugins');

// Android-only settings for the Google Play app. iOS keeps its own project, so
// nothing here may touch it: the shared Expo name stays "NURI Native Lab" (it
// names the Xcode project), and only Android's launcher label changes.

/** backend/push_fcm.py sends this as the FCM click_action. A notification
 *  tapped while the app is in the background launches the activity that
 *  declares it, so MainActivity has to. */
const OPEN_NOTIFICATION = 'com.ordashtech.nuri.OPEN_NOTIFICATION';

/** Google Play takes builds signed with the upload key. The key never enters
 *  the repository: NURI_UPLOAD_PROPERTIES names a properties file holding
 *  storeFile, storePassword, keyAlias and keyPassword. Without it a release
 *  build stays debug-signed, which is fine for a phone and refused by Play. */
function withUploadSigning(gradle) {
  if (gradle.includes('nuriUploadProperties')) return gradle;
  const loader = [
    'def nuriUploadProperties() {',
    "    def path = System.getenv('NURI_UPLOAD_PROPERTIES')",
    '    if (!path || !new File(path).exists()) return null',
    '    def props = new Properties()',
    '    new File(path).withInputStream { props.load(it) }',
    '    return props',
    '}',
    '',
  ].join('\n');
  const release = [
    'signingConfigs {',
    '        release {',
    '            def upload = nuriUploadProperties()',
    '            if (upload != null) {',
    "                storeFile file(upload['storeFile'])",
    "                storePassword upload['storePassword']",
    "                keyAlias upload['keyAlias']",
    "                keyPassword upload['keyPassword']",
    '            }',
    '        }',
  ].join('\n');
  return gradle
    .replace(/android\s*\{/, (m) => `${loader}${m}`)
    .replace(/signingConfigs\s*\{/, release)
    .replace(
      /(\/\/ Caution! In production[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/,
      '$1signingConfig nuriUploadProperties() != null ? signingConfigs.release : signingConfigs.debug',
    );
}

/** expo-image-picker's `microphonePermission: false` (it never records)
 *  marks RECORD_AUDIO for removal, which also takes it from expo-audio's voice
 *  input. Android keeps it; the image picker still never asks for it. */
function keepRecordAudio(manifest) {
  const name = 'android.permission.RECORD_AUDIO';
  const kept = (manifest['uses-permission'] ?? []).filter((p) => p.$['android:name'] !== name);
  manifest['uses-permission'] = [...kept, { $: { 'android:name': name } }];
  return manifest;
}

module.exports = function withNuriAndroid(config) {
  // app.json `locales` holds iOS InfoPlist strings (NS…UsageDescription and
  // the like). Expo copies them into Android's values-b+<lang> resources too,
  // where they mean nothing, and release lint fails on them as translations
  // with no default. They stay for iOS; Android's lint just ignores them.
  config = withAppBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes("disable 'ExtraTranslation'")) {
      mod.modResults.contents = mod.modResults.contents.replace(
        /android\s*\{/,
        "android {\n    lint {\n        disable 'ExtraTranslation'\n    }",
      );
    }
    mod.modResults.contents = withUploadSigning(mod.modResults.contents);
    return mod;
  });
  config = withStringsXml(config, (mod) => {
    mod.modResults = AndroidConfig.Strings.setStringItem(
      [{ $: { name: 'app_name', translatable: 'false' }, _: 'Nuri' }],
      mod.modResults,
    );
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    keepRecordAudio(mod.modResults.manifest);
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(mod.modResults);
    const filters = (activity['intent-filter'] ??= []);
    const declared = filters.some((filter) => (filter.action ?? []).some((a) => a.$['android:name'] === OPEN_NOTIFICATION));
    if (!declared) {
      filters.push({
        action: [{ $: { 'android:name': OPEN_NOTIFICATION } }],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
      });
    }
    return mod;
  });
};
