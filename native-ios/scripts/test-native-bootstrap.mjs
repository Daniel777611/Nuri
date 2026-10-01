import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const delegate = read('../native/NuriAppDelegate.swift');
assert.ok(delegate.includes('class AppDelegate: ExpoAppDelegate'));
const bind = delegate.indexOf('bindReactNativeFactory(factory)');
const start = delegate.indexOf('factory.startReactNative(');
assert.ok(bind > 0 && bind < start, 'Expo SDK 54 must bind its factory before creating the root view');
assert.equal(read('../ios/NURINativeLab/AppDelegate.swift'), delegate, 'generated delegate must match the source plugin');
const config = JSON.parse(read('../app.json')).expo;
assert.equal(config.ios.bundleIdentifier, 'com.ordashtech.nuri.nativelab');
assert.equal(config.scheme, 'nuri-native-lab');
assert.equal(config.version, '0.3.0');
assert.equal(config.ios.buildNumber, '1002');
assert.equal(config.ios.entitlements['aps-environment'], 'production');
assert.equal(config.ios.infoPlist.NuriAPNSEnvironment, 'production');
assert.match(read('../ExportOptions-InternalOnly.plist'), /<key>testFlightInternalTestingOnly<\/key>\s*<true\s*\/>/);
assert.match(read('../ExportOptions-InternalOnly.plist'), /<key>distributionBundleIdentifier<\/key><string>com\.ordashtech\.nuri\.nativelab<\/string>/);
assert.match(read('../ExportOptions-InternalOnly.plist'), /NURI Native Lab App Store Connect/);
const externalExport = read('../ExportOptions-ExternalTestFlight.plist');
assert.match(externalExport, /<key>testFlightInternalTestingOnly<\/key>\s*<false\s*\/>/, 'current release route must permit Beta App Review');
assert.match(externalExport, /<key>distributionBundleIdentifier<\/key><string>com\.ordashtech\.nuri\.nativelab<\/string>/, 'external release must still use the separate lab identity');
assert.match(externalExport, /<key>com\.ordashtech\.nuri\.nativelab<\/key><string>NURI Native Lab App Store Connect<\/string>/);
assert.match(externalExport, /<key>method<\/key><string>app-store-connect<\/string>/);
const project = read('../ios/NURINativeLab.xcodeproj/project.pbxproj');
assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = "?com\.ordashtech\.nuri\.nativelab"?;/);
assert.ok(!/PRODUCT_BUNDLE_IDENTIFIER = com\.ordashtech\.nuri;/.test(project));
const plist = read('../ios/NURINativeLab/Info.plist');
assert.match(plist, /<string>nuri-native-lab<\/string>/);
assert.ok(!/<string>nuri<\/string>/.test(plist), 'old app URL scheme must not be claimed');
// Both plugins write the same iOS purpose key; their order must not change its meaning.
const photoPurpose = '允许 NURI 在你主动选择聊天图片或保存任务卡时使用相册。';
const mediaLibrary = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-media-library')?.[1];
const imagePicker = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker')?.[1];
assert.equal(mediaLibrary?.photosPermission, photoPurpose);
assert.equal(imagePicker?.photosPermission, photoPurpose);
const plistString = (key) => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
assert.equal(plistString('NSPhotoLibraryUsageDescription'), photoPurpose, 'generated photo purpose must match both source plugins');
assert.equal(plistString('NSPhotoLibraryAddUsageDescription'), mediaLibrary.savePhotosPermission, 'generated save purpose must match its source plugin');

const notice = '这些信息用于个性化 AI 建议。使用 AI 功能时，相关信息可能由第三方 AI 服务处理；详情请参阅隐私政策。';
const onboarding = read('../app/onboarding.tsx');
assert.ok(onboarding.includes(`subtitle="${notice}"`), 'ChildPage must render the accurate AI-processing notice');
const dictionary = (path, name) => {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((item) => ts.isIdentifier(item.name) && item.name.text === name);
  assert.ok(declaration && ts.isObjectLiteralExpression(declaration.initializer), `missing ${name} dictionary`);
  return Object.fromEntries(declaration.initializer.properties.filter(ts.isPropertyAssignment)
    .filter((property) => ts.isStringLiteral(property.name) && ts.isStringLiteral(property.initializer))
    .map((property) => [property.name.text, property.initializer.text]));
};
assert.equal(dictionary('../src/i18n/en.ts', 'en')[notice], 'This information is used to personalise AI suggestions. When you use AI features, relevant information may be processed by third-party AI services. Please refer to the privacy policy for details.');
assert.equal(dictionary('../src/i18n/zh-TW.ts', 'zhTW')[notice], '這些資料用於個人化 AI 建議。使用 AI 功能時，相關資料可能由第三方 AI 服務處理；詳情請參閱隱私政策。');
for (const source of [onboarding, read('../src/i18n/en.ts'), read('../src/i18n/zh-TW.ts')]) {
  assert.doesNotMatch(source, /永远不会分享给第三方|永遠不會分享給第三方|Never shared with third parties/i, 'remove the inaccurate absolute third-party-sharing claim, including obsolete translation keys');
}
assert.ok(!read('../metro.config.js').includes('require(\'metro-cache\')'), 'Metro must use Expo version-matched defaults');
console.log('Native bootstrap, lab identity, release route and localized privacy/photo-purpose contracts passed');
