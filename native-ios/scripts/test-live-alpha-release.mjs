import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { LIVE_ALPHA, PROFILES, PROTOTYPE_FLAGS, resolveReleaseProfile } = require('../release/profiles.cjs');
const { nativeMetadata } = require('../release/native-metadata.cjs');
const base = require('../app.json').expo;
const BETA = '22059260132-d1bj5842fjq1f4g6v097flm5ubn6fsdo.apps.googleusercontent.com';
const env = { EXPO_PUBLIC_RELEASE_FLAVOR: 'live-alpha', NURI_RELEASE_CHANNEL: 'live-alpha',
  NURI_BETA_GOOGLE_IOS_CLIENT_ID: BETA, ...Object.fromEntries(PROTOTYPE_FLAGS.map(key => [key, '0'])) };
const debug = { ...env, CONFIGURATION: 'Debug', SDK_NAME: 'iphonesimulator26.0',
  NURI_LOCAL_COMMUNITY_DEBUG: '1', EXPO_PUBLIC_BACKEND_URL: 'http://127.0.0.1:8765' };

function config(input, value = base) {
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports,process){' + readFileSync(new URL('../app.config.js', import.meta.url), 'utf8') + '\n})', {})
    (name => require('../' + name.slice(2)), module, module.exports, { env: input });
  return module.exports({ config: value });
}

test('only a live-alpha profile exists, and unselected main configuration returns byte-equivalent values', () => {
  assert.deepEqual(Object.keys(PROFILES), ['live-alpha']); assert.equal(resolveReleaseProfile({}), null);
  assert.equal(config({}), base); assert.equal(base.ios.bundleIdentifier, 'com.ordashtech.nuri.nativelab');
  assert.equal(base.ios.buildNumber, '1019'); assert.equal(base.version, '0.4.0');
  for (const flavor of ['alpha', 'beta', 'app-store', 'early-access', 'live-alpha ', 'unknown']) {
    assert.throws(() => resolveReleaseProfile({ ...env, EXPO_PUBLIC_RELEASE_FLAVOR: flavor }), /only live-alpha/);
  }
});

test('live-alpha fixes the existing Alpha identity, live API mode, even candidate and version', () => {
  assert.deepEqual(resolveReleaseProfile(env), LIVE_ALPHA); assert.ok(Object.isFrozen(LIVE_ALPHA));
  assert.equal(LIVE_ALPHA.bundleIdentifier, 'com.ordashtech.nuri.beta'); assert.equal(LIVE_ALPHA.appStoreId, '6831012896');
  assert.equal(LIVE_ALPHA.displayName, 'Nuri Alpha'); assert.equal(LIVE_ALPHA.scheme, 'nuri-beta');
  assert.equal(LIVE_ALPHA.communityMode, 'live-api-v1'); assert.equal(LIVE_ALPHA.communityEnabled, true);
  assert.equal(LIVE_ALPHA.version, '0.4.0'); assert.equal(LIVE_ALPHA.buildNumber, '1058');
  assert.equal(resolveReleaseProfile({ ...env, NURI_BUILD_NUMBER: '1060' }).buildNumber, '1060');
  for (const build of ['', '0', '-2', '01058', '1057', '1056', '1058.0', '1e4', '9007199254740992']) {
    assert.throws(() => resolveReleaseProfile({ ...env, NURI_BUILD_NUMBER: build }), /even safe build/);
  }
  for (const version of ['', '0.3.0', '0.4', '0.4.1']) assert.throws(() => resolveReleaseProfile({ ...env, NURI_MARKETING_VERSION: version }), /exact existing/);
});

test('wrong/absent channel, app identity and every nonzero prototype flag fail closed', () => {
  for (const channel of [undefined, '', 'testflight-alpha', 'testflight-prototype', 'testflight-beta']) assert.throws(() => resolveReleaseProfile({ ...env, NURI_RELEASE_CHANNEL: channel }), /explicit live-alpha/);
  for (const key of ['PRODUCT_BUNDLE_IDENTIFIER', 'NURI_APP_BUNDLE_IDENTIFIER']) {
    for (const bundle of ['', 'com.ordashtech.nuri.nativelab', 'com.ordashtech.nuri.earlyaccess', 'com.ordashtech.nuri.preview', 'other.app']) {
      assert.throws(() => config({ ...env, [key]: bundle }), /bundle identifier/);
    }
  }
  assert.throws(() => config({ ...env, NURI_APP_BUILD_NUMBER: '1019' }), /Custom app build\/version/);
  assert.throws(() => config({ ...env, NURI_APP_MARKETING_VERSION: '0.3.0' }), /Custom app build\/version/);
  assert.equal(config({ ...env, NURI_APP_BUILD_NUMBER: '1058', NURI_APP_MARKETING_VERSION: '0.4.0' }).ios.buildNumber, '1058');
  for (const key of PROTOTYPE_FLAGS) {
    for (const value of ['1', 'true', '2', '']) assert.throws(() => config({ ...env, [key]: value }), /prototype flag/);
    assert.equal(config({ ...env, [key]: undefined }).extra.communityMode, 'live-api-v1');
  }
});

test('app config stages only Alpha iOS identity and retains Android, plugins and main base object', () => {
  const before = JSON.stringify(base), result = config(env);
  assert.equal(JSON.stringify(base), before); assert.deepEqual(result.android, base.android);
  assert.equal(result.name, 'Nuri Alpha'); assert.equal(result.slug, 'nuri-beta'); assert.equal(result.scheme, 'nuri-beta');
  assert.equal(result.ios.bundleIdentifier, LIVE_ALPHA.bundleIdentifier); assert.equal(result.ios.buildNumber, '1058');
  assert.equal(result.version, '0.4.0'); assert.equal(result.ios.infoPlist.NuriCommunityMode, 'live-api-v1');
  assert.equal(result.extra.releaseFlavor, 'live-alpha'); assert.equal(result.extra.releaseChannel, 'live-alpha');
  assert.equal(result.extra.communityEnabled, true); assert.equal(result.extra.communityMode, 'live-api-v1');
  const google = result.plugins.find(p => Array.isArray(p) && p[0] === './plugins/withNuriGoogleSignIn')[1];
  assert.equal(google.iosClientId, BETA); assert.equal(google.webClientId, base.plugins.find(p => Array.isArray(p) && p[0] === './plugins/withNuriGoogleSignIn')[1].webClientId);
  assert.deepEqual(result.plugins.filter(p => !Array.isArray(p) || p[0] !== './plugins/withNuriGoogleSignIn'), base.plugins.filter(p => !Array.isArray(p) || p[0] !== './plugins/withNuriGoogleSignIn'));
  assert.deepEqual(result.ios.entitlements, base.ios.entitlements);
});

test('missing, invented, Web, Preview or production iOS OAuth client cannot configure Alpha', () => {
  for (const value of [undefined, '', '123456789-fixture.apps.googleusercontent.com',
    '22059260132-gpd9u7gra897fs9p7ue6n62sa0nppfuv.apps.googleusercontent.com',
    '22059260132-e9njjaftvdn0farumni9b67p6l17nfgt.apps.googleusercontent.com',
    '22059260132-mn5m08856rb2k198lsrsl3t1kjrnchr7.apps.googleusercontent.com']) {
    assert.throws(() => config({ ...env, NURI_BETA_GOOGLE_IOS_CLIENT_ID: value }), /actual registered Beta/);
  }
});

test('only the exact EXConstants static Pod context substitutes the explicit Alpha app bundle', () => {
  const pod = { ...env, PROJECT_NAME: 'Pods', TARGET_NAME: 'EXConstants', PRODUCT_TYPE: 'com.apple.product-type.library.static',
    PRODUCT_BUNDLE_IDENTIFIER: 'org.cocoapods.EXConstants', NURI_APP_BUNDLE_IDENTIFIER: LIVE_ALPHA.bundleIdentifier };
  assert.equal(config(pod).ios.bundleIdentifier, LIVE_ALPHA.bundleIdentifier);
  for (const [key, value] of [['PROJECT_NAME', 'NURINativeLab'], ['TARGET_NAME', 'OtherPod'],
    ['PRODUCT_TYPE', 'com.apple.product-type.application'], ['PRODUCT_BUNDLE_IDENTIFIER', 'org.cocoapods.OtherPod']]) {
    assert.throws(() => config({ ...pod, [key]: value }), /bundle identifier/);
  }
  assert.throws(() => config({ ...pod, NURI_APP_BUNDLE_IDENTIFIER: undefined }), /explicit app bundle/);
  assert.throws(() => config({ ...pod, NURI_APP_BUNDLE_IDENTIFIER: 'com.ordashtech.nuri.nativelab' }), /bundle identifier/);
  assert.throws(() => config({ ...pod, PROJECT_NAME: 'NURINativeLab', TARGET_NAME: 'NURINativeLab' }), /bundle identifier/);
});

test('only exact Debug simulator and explicit localhost opt-in permit the local real-router test backend', () => {
  const result = config(debug); assert.equal(result.ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
  assert.equal(result.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  for (const [key, value] of [['CONFIGURATION', undefined], ['CONFIGURATION', 'Release'], ['CONFIGURATION', 'debug'],
    ['SDK_NAME', undefined], ['SDK_NAME', 'iphoneos26.0'], ['NURI_LOCAL_COMMUNITY_DEBUG', undefined],
    ['NURI_LOCAL_COMMUNITY_DEBUG', '0'], ['EXPO_PUBLIC_BACKEND_URL', undefined],
    ['EXPO_PUBLIC_BACKEND_URL', 'http://localhost:8765'], ['EXPO_PUBLIC_BACKEND_URL', 'http://127.0.0.1:8765/'],
    ['EXPO_PUBLIC_BACKEND_URL', 'http://127.0.0.1:8765/api']]) assert.throws(() => config({ ...debug, [key]: value }), /Local Community|only https/);
  for (const url of ['https://example.invalid', 'http://nurifam.app', 'https://nurifam.app/api']) assert.throws(() => config({ ...env, EXPO_PUBLIC_BACKEND_URL: url }), /only https/);
  for (const url of [undefined, '', 'https://nurifam.app']) assert.equal(config({ ...env, EXPO_PUBLIC_BACKEND_URL: url }).ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking, undefined);
});

test('native metadata binds the exact selected profile, callback and topic, retaining no debug ATS in Release', () => {
  const source = { Unrelated: 'keep', NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true } };
  const before = JSON.stringify(source), metadata = nativeMetadata(source, LIVE_ALPHA, env);
  assert.equal(JSON.stringify(source), before); assert.equal(metadata.Unrelated, 'keep');
  assert.equal(metadata.CFBundleIdentifier, LIVE_ALPHA.bundleIdentifier); assert.equal(metadata.CFBundleDisplayName, 'Nuri Alpha');
  assert.equal(metadata.CFBundleVersion, '1058'); assert.equal(metadata.CFBundleShortVersionString, '0.4.0');
  assert.deepEqual(metadata.CFBundleURLTypes.map(p => p.CFBundleURLSchemes), [['nuri-beta', LIVE_ALPHA.bundleIdentifier], [BETA.split('.').reverse().join('.')]]);
  assert.equal(metadata.GIDClientID, BETA); assert.equal(metadata.NuriReleaseFlavor, 'live-alpha');
  assert.equal(metadata.NuriReleaseChannel, 'live-alpha'); assert.equal(metadata.NuriCommunityMode, 'live-api-v1');
  assert.equal(metadata.NuriAPNSEnvironment, 'production'); assert.deepEqual(metadata.NSAppTransportSecurity, { NSAllowsArbitraryLoads: false });
  assert.equal(nativeMetadata({}, LIVE_ALPHA, debug).NSAppTransportSecurity.NSAllowsLocalNetworking, true);
  for (const field of ['flavor', 'channel', 'displayName', 'bundleIdentifier', 'scheme', 'version', 'communityMode', 'appStoreId']) {
    assert.throws(() => nativeMetadata({}, { ...LIVE_ALPHA, [field]: 'wrong' }, env), /exact existing/);
  }
  assert.throws(() => nativeMetadata({}, LIVE_ALPHA, { ...env, NURI_BUILD_NUMBER: '1060' }), /matching live Alpha/);
  assert.throws(() => nativeMetadata({}, LIVE_ALPHA, { NURI_BETA_GOOGLE_IOS_CLIENT_ID: BETA }), /selected matching/);
});
