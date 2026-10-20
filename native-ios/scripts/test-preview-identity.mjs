import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const config=JSON.parse(read('app.json')).expo;
const plist=p=>JSON.parse(spawnSync('/usr/bin/plutil',['-convert','json','-o','-',new URL('../'+p,import.meta.url).pathname],{encoding:'utf8'}).stdout);
test('Preview is independently installable, without claiming original URLs or OAuth client',()=>{
 assert.equal(config.ios.bundleIdentifier,'com.ordashtech.nuri.preview');
 assert.equal(config.scheme,'nuri-preview');
 assert.equal(config.ios.infoPlist.CFBundleDisplayName,'Nuri Preview');
 const info=plist('ios/NURINativeLab/Info.plist');
 assert.equal(info.CFBundleDisplayName,'Nuri Preview');
 assert.deepEqual(info.CFBundleURLTypes.flatMap(t=>t.CFBundleURLSchemes),['nuri-preview','com.ordashtech.nuri.preview']);
 assert.equal(info.GIDClientID,undefined);assert.equal(info.GIDServerClientID,undefined);
 assert.ok(!config.plugins.some(p=>Array.isArray(p)&&p[0]==='./plugins/withNuriGoogleSignIn'));
 assert.equal((read('ios/NURINativeLab.xcodeproj/project.pbxproj').match(/PRODUCT_BUNDLE_IDENTIFIER = com.ordashtech.nuri.preview;/g)||[]).length,2);
});
test('Preview has separate credentials and cannot register the original APNs topic',()=>{
 const storage=read('src/utils/storage/index.ts');
 assert.match(storage,/NATIVE_STORAGE_NAMESPACE = "com.ordashtech.nuri.preview.v1\."/);
 assert.match(storage,/keychainService: "com.ordashtech.nuri.preview.credentials.v1"/);
 assert.doesNotMatch(storage,/keychainService: "com.ordashtech.nuri.nativelab/);
 assert.equal(config.ios.infoPlist.NuriRemotePushEnabled,false);
 assert.equal(plist('ios/NURINativeLab/Info.plist').NuriRemotePushEnabled,false);
 assert.equal(plist('ios/NURINativeLab/NURINativeLab.entitlements')['aps-environment'],undefined);
 const bridge=read('native/NuriPushBridge.swift');
 assert.equal(bridge,read('ios/NURINativeLab/NuriPushBridge.swift'));
 const method=bridge.slice(bridge.indexOf('func requestPushRegistration('));
 assert.ok(method.indexOf('NuriRemotePushEnabled')<method.indexOf('center.requestAuthorization'));
 assert.ok(method.indexOf('resolve(NSNull())')<method.indexOf('registerForRemoteNotifications'));
 assert.match(read('src/nativePushRuntime.ts'),/value.bundleId !== "com.ordashtech.nuri.nativelab"/);
 const delegate=read('native/NuriAppDelegate.swift');
 assert.equal(delegate,read('ios/NURINativeLab/AppDelegate.swift'));
 const configure=delegate.slice(delegate.indexOf('private func configureNotifications('),delegate.indexOf('public override func applicationDidBecomeActive'));
 assert.ok(configure.indexOf('NuriRemotePushEnabled')<configure.indexOf('notificationCenter.requestAuthorization'));
 assert.match(delegate,/private func registerForRemoteNotifications\(\) \{\s*guard Bundle.main.object\(forInfoDictionaryKey: "NuriRemotePushEnabled"\)/);
});
test('Preview keeps mature two-tab scope and excludes unverified remote notification settings',()=>{
 const release=read('src/appStoreRelease.ts');
 assert.match(release,/"notification-settings"/);
 assert.match(release,/case "notifications": return null/);
 assert.doesNotMatch(read('app/(tabs)/profile.tsx'),/<MenuRow label=\{copy\("通知设置"/);
 assert.match(read('src/components/GoogleSignInButton.tsx'),/com.ordashtech.nuri.preview" && !available\) return null/);
 assert.deepEqual(config.ios.infoPlist.CFBundleLocalizations,['en','zh-Hans','zh-Hant']);
 for(const lang of ['en','zh-Hans','zh-Hant']){
  assert.equal(JSON.parse(read('locales/'+lang+'.json')).CFBundleDisplayName,'Nuri Preview');
  assert.match(read('ios/NURINativeLab/Supporting/'+lang+'.lproj/InfoPlist.strings'),/CFBundleDisplayName = "Nuri Preview";/);
 }
});
