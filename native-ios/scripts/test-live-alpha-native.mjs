import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url), read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const PROD = 'com.ordashtech.nuri.nativelab', BETA = 'com.ordashtech.nuri.beta', PREVIEW = 'com.ordashtech.nuri.earlyaccess';
const IOS = '22059260132-d1bj5842fjq1f4g6v097flm5ubn6fsdo.apps.googleusercontent.com';
const WEB = '22059260132-e9njjaftvdn0farumni9b67p6l17nfgt.apps.googleusercontent.com';
const PROD_IOS = '22059260132-gpd9u7gra897fs9p7ue6n62sa0nppfuv.apps.googleusercontent.com';
const PREVIEW_IOS = '22059260132-mn5m08856rb2k198lsrsl3t1kjrnchr7.apps.googleusercontent.com';

test('localized privacy resources never override the main or staged Alpha Home Screen name', () => {
  assert.match(read('ios/NURINativeLab/Info.plist'), /<key>CFBundleDisplayName<\/key>\s*<string>Nuri<\/string>/);
  const privacyKeys = ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSPhotoLibraryAddUsageDescription', 'NSFaceIDUsageDescription'];
  for (const locale of ['en', 'zh-Hans', 'zh-Hant']) {
    const source = JSON.parse(read(`locales/${locale}.json`));
    const generated = read(`ios/NURINativeLab/Supporting/${locale}.lproj/InfoPlist.strings`);
    assert.equal(Object.hasOwn(source, 'CFBundleDisplayName'), false, locale);
    assert.doesNotMatch(generated, /CFBundleDisplayName\s*=/, locale);
    assert.deepEqual(Object.keys(source).sort(), [...privacyKeys].sort(), locale);
    for (const key of privacyKeys) {
      assert.ok(source[key].trim(), locale + ':' + key);
      assert.ok(generated.includes(`${key} = ${JSON.stringify(source[key])};`), locale + ':' + key);
    }
  }
});
function load(path, dependencies = {}) {
  const module = { exports: {} }, code = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => { assert.ok(name in dependencies, 'unexpected dependency: ' + name); return dependencies[name]; }, module, module.exports);
  return module.exports;
}
function google({ os = 'ios', linked = true, config = { bundleId: BETA, iosClientId: IOS, webClientId: WEB, callbackRegistered: true } } = {}) {
  const calls = [], sdk = { GoogleSignin: { configure: value => calls.push(['configure', value]),
    signOut: async () => calls.push(['signOut']), signIn: async () => { calls.push(['signIn']); return { type: 'success', data: { idToken: 'fixtureHeader.fixtureIdentity.fixtureSignature' } }; } },
    isErrorWithCode: () => false, statusCodes: { SIGN_IN_CANCELLED: 'cancelled' } };
  return { calls, ...load('src/googleNativeAuth.ts', { 'react-native': { Platform: { OS: os },
    TurboModuleRegistry: { get: () => linked ? {} : null }, NativeModules: { NuriGoogleAuthBridge: { getConfiguration: async () => config } } },
    '@react-native-google-signin/google-signin': sdk }) };
}

test('iOS Google bridge accepts only the three existing identities with a registered separate client/callback', async () => {
  for (const [bundleId, iosClientId] of [[PROD, PROD_IOS], [BETA, IOS], [PREVIEW, PREVIEW_IOS]]) {
    const f = google({ config: { bundleId, iosClientId, webClientId: WEB, callbackRegistered: true } });
    assert.equal((await f.getNativeGoogleConfiguration()).bundleId, bundleId);
  }
  for (const config of [null, { bundleId: 'com.ordashtech.nuri' }, { bundleId: 'com.ordashtech.nuri.preview' },
    { iosClientId: PROD_IOS }, { iosClientId: WEB }, { iosClientId: PREVIEW_IOS },
    { iosClientId: '123456789-invented.apps.googleusercontent.com' }, { callbackRegistered: false }, { webClientId: '' }]) {
    const f = google({ config: config === null ? null : { bundleId: BETA, iosClientId: IOS, webClientId: WEB, callbackRegistered: true, ...config } });
    assert.equal(await f.getNativeGoogleConfiguration(), null); await assert.rejects(f.obtainNativeGoogleCredential(), { code: 'unavailable' });
    assert.deepEqual(f.calls, []);
  }
});

test('main Android Google flow retains its original package/Web audience, no iOS client or bridge dependency', async () => {
  const f = google({ os: 'android', config: null });
  assert.deepEqual(await f.getNativeGoogleConfiguration(), { bundleId: 'com.ordashtech.nuri', iosClientId: '', webClientId: WEB, callbackRegistered: true });
  assert.equal(await f.obtainNativeGoogleCredential(), 'fixtureHeader.fixtureIdentity.fixtureSignature');
  assert.deepEqual(f.calls, [['configure', { webClientId: WEB, offlineAccess: false }], ['signOut'], ['signIn'], ['signOut']]);
  assert.equal(await google({ os: 'android', linked: false }).getNativeGoogleConfiguration(), null);
  assert.equal(await google({ os: 'web' }).getNativeGoogleConfiguration(), null);
});

test('Google provider still rejects malformed credentials rather than trusting a public config', async () => {
  const f = google(); assert.equal(await f.obtainNativeGoogleCredential(() => false), null); assert.deepEqual(f.calls, []);
  const source = read('src/googleNativeAuth.ts');
  assert.match(source, /credential\.length < 20 \|\| credential\.length > 8000 \|\| credential\.split\("\."\)\.length !== 3/);
  assert.match(source, /sdk\.GoogleSignin\.signOut\(\)/); assert.doesNotMatch(source, /console\.|revokeAccess/);
});

test('Expo Google plugin stages the actual Beta client/callback, but never inherits production credentials', async () => {
  const plugin = require('../plugins/withNuriGoogleSignIn.js');
  const input = { name: 'Nuri Alpha', ios: { bundleIdentifier: BETA }, _internal: { projectRoot: new URL('..', import.meta.url).pathname } };
  for (const iosClientId of [undefined, '', PROD_IOS, WEB, PREVIEW_IOS, '123456789-fixture.apps.googleusercontent.com']) {
    assert.throws(() => plugin(structuredClone(input), { iosClientId, webClientId: WEB }), /actual registered|real public/);
  }
  assert.throws(() => plugin(structuredClone(input), { iosClientId: IOS, webClientId: WEB, bundleIdentifier: PROD }), /matching independent/);
  assert.throws(() => plugin({ ...input, ios: { bundleIdentifier: 'com.ordashtech.nuri.preview' } }, { iosClientId: IOS, webClientId: WEB }), /allowlisted/);
  const configured = plugin(structuredClone(input), { iosClientId: IOS, webClientId: WEB, bundleIdentifier: BETA });
  const result = await configured.mods.ios.infoPlist({ ...configured, modRawConfig: input,
    modResults: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['nuri-beta'] }] }, modRequest: { platform: 'ios', introspect: true } });
  assert.equal(configured.ios.bundleIdentifier, BETA); assert.equal(result.modResults.GIDClientID, IOS); assert.equal(result.modResults.GIDServerClientID, WEB);
  assert.deepEqual(result.modResults.CFBundleURLTypes.flatMap(row => row.CFBundleURLSchemes), ['nuri-beta', IOS.split('.').reverse().join('.')]);
});

const { parseNativeToken } = load('src/nativePushRuntime.ts');
const state = { token: 'aA'.repeat(32), environment: 'production', installationId: 'b22911a4-37dd-47b1-a775-632b0b800733',
  bundleId: BETA, permissionStatus: 'authorized', timeZone: 'UTC', appVersion: '0.4.0', buildNumber: '1058' };
test('APNs parser preserves the real topic for each approved iOS app and fails closed on token/identity/environment', () => {
  for (const bundleId of [PROD, BETA, PREVIEW]) {
    const result = parseNativeToken({ ...state, bundleId }); assert.equal(result.bundle_id, bundleId); assert.equal(result.platform, 'ios'); assert.equal(result.apns_token, 'aa'.repeat(32));
  }
  for (const patch of [{ bundleId: 'com.ordashtech.nuri' }, { bundleId: 'com.ordashtech.nuri.preview' }, { bundleId: 'other.app' },
    { token: 'a'.repeat(31) }, { token: 'a'.repeat(257) }, { token: 'not-apns' }, { installationId: 'bad' },
    { environment: 'unknown' }, { permissionStatus: 'unknown' }, { platform: 'android' }, { platform: 'other' }]) assert.equal(parseNativeToken({ ...state, ...patch }), null);
});

test('main Android FCM parsing remains platform-specific and preserves the case-sensitive token', () => {
  const token = 'FCMfixtureAaBb:1234567890_abcdefghijklmn-XYZ';
  const value = { ...state, platform: 'android', bundleId: 'com.ordashtech.nuri', token, environment: undefined };
  const result = parseNativeToken(value); assert.equal(result.platform, 'android'); assert.equal(result.bundle_id, 'com.ordashtech.nuri');
  assert.equal(result.apns_token, token); assert.equal(result.apns_environment, 'production');
  for (const patch of [{ token: 'too short' }, { token: 'a'.repeat(4097) }, { token: token + '!' }, { installationId: 'bad' }, { permissionStatus: 'bad' }]) assert.equal(parseNativeToken({ ...value, ...patch }), null);
});

test('Swift identity owns distinct exact keys, retains production/Beta accounts and fails closed without an identity', () => {
  const swift = read('native/NuriPushBridge.swift'), delegate = read('native/NuriAppDelegate.swift');
  assert.equal(read('ios/NURINativeLab/NuriPushBridge.swift'), swift); assert.equal(read('ios/NURINativeLab/AppDelegate.swift'), delegate);
  const identities = [...swift.matchAll(/case "([^"]+)":\s+return NuriNativeIdentity\(\s+bundleId: "([^"]+)",\s+keychainAccount: "([^"]+)"/g)].map(([, installed, bundle, account]) => ({ installed, bundle, account }));
  assert.deepEqual(identities, [{ installed: PROD, bundle: PROD, account: 'native-lab-installation-id' },
    { installed: BETA, bundle: BETA, account: 'nuri-beta-installation-id' }, { installed: PREVIEW, bundle: PREVIEW, account: 'nuri-preview-installation-id' }]);
  for (const [key, suffix] of Object.entries({ tokenKey: '.apns-token', tokenEnvironmentKey: '.apns-token-environment', keychainService: '.installation',
    reminderQueueLabel: '.local-reminder-settings', enabledKey: '.reminder-enabled', intervalKey: '.reminder-interval-seconds',
    reminderIdentifier: '.local-reminder', batchIdentifierPrefix: '.local-reminder.batch.', remindersInitializedKey: '.reminders-initialized' })) {
    assert.ok(swift.includes(`var ${key}: String { "\\(bundleId)${suffix}" }`));
    assert.equal(new Set(identities.map(({ bundle }) => bundle + suffix)).size, 3);
  }
  assert.match(swift, /default:\s+return nil/); assert.match(swift, /bundleId == identity\.bundleId/);
  assert.match(swift, /guard NuriNativeIdentity\.current != nil else \{\s+reject\("PUSH_UNAVAILABLE"/);
  assert.match(delegate, /guard let identity = NuriNativeIdentity\.current else \{ return \}/);
  assert.match(delegate, /let migrationKey = identity\.remindersInitializedKey/);
  assert.doesNotMatch(swift, /kSecAttrAccessGroup|legacyIdentifiers|removeLegacyTests/);
});

test('existing Alpha private session namespace remains unchanged and never requests a shared Keychain group', () => {
  const storage = read('src/utils/storage/index.ts');
  assert.match(storage, /NATIVE_STORAGE_NAMESPACE = "com\.ordashtech\.nuri\.nativelab\.v1\."/);
  assert.match(storage, /keychainService: "com\.ordashtech\.nuri\.nativelab\.credentials\.v1"/);
  assert.match(storage, /keychainAccessible: SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  assert.doesNotMatch(storage, /accessGroup\s*:/);
  const entitlements = read('ios/NURINativeLab/NURINativeLab.entitlements');
  assert.doesNotMatch(entitlements, /keychain-access-groups|application-groups/);
});
