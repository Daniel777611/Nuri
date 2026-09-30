import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const delegate = read('../native/NuriAppDelegate.swift');
assert.ok(delegate.includes('class AppDelegate: ExpoAppDelegate'));
const bind = delegate.indexOf('bindReactNativeFactory(factory)');
const start = delegate.indexOf('factory.startReactNative(');
assert.ok(bind > 0 && bind < start, 'Expo SDK 54 must bind its factory before creating the root view');
assert.equal(read('../ios/NURINativeLab/AppDelegate.swift'), delegate, 'generated delegate must match the source plugin');
const config = JSON.parse(read('../app.json')).expo;
assert.equal(config.ios.bundleIdentifier, 'com.ordashtech.nuri');
assert.equal(config.version, '0.3.0');
assert.equal(config.ios.buildNumber, '1001');
assert.equal(config.ios.entitlements['aps-environment'], 'production');
assert.equal(config.ios.infoPlist.NuriAPNSEnvironment, 'production');
assert.match(read('../ExportOptions-InternalOnly.plist'), /<key>testFlightInternalTestingOnly<\/key>\s*<true\s*\/>/);
assert.ok(!read('../metro.config.js').includes('require(\'metro-cache\')'), 'Metro must use Expo version-matched defaults');
console.log('Native bootstrap, production APNs and internal-only release contracts passed');
