const { AndroidConfig, withAndroidManifest, withAppBuildGradle, withStringsXml } = require('@expo/config-plugins');

// Android-only settings for the Google Play app. iOS keeps its own project, so
// nothing here may touch it: the shared Expo name stays "NURI Native Lab" (it
// names the Xcode project), and only Android's launcher label changes.

/** backend/push_fcm.py sends this as the FCM click_action. A notification
 *  tapped while the app is in the background launches the activity that
 *  declares it, so MainActivity has to. */
const OPEN_NOTIFICATION = 'com.ordashtech.nuri.OPEN_NOTIFICATION';

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
