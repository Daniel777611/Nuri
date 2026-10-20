import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
import {i18n,translate,zhTW} from './i18n-test-utils.mjs';
const read=p=>readFileSync(p,'utf8');
const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);
test('Traditional aliases, persisted identifier and all three language labels remain distinct',()=>{
 assert.deepEqual(i18n.LOCALES,['zh-CN','zh-TW','en']);
 for(const value of ['zh-TW','zh_TW','zh-Hant','zh-Hant-TW','zh-HK','zh-MO'])assert.equal(i18n.normalizeLocale(value),'zh-TW');
 assert.equal(i18n.normalizeLocale('zh-Hans'),'zh-CN');assert.equal(i18n.normalizeLocale('en-US'),'en');
 assert.equal(i18n.LOCALE_LABELS['zh-TW'],'繁體中文');
 assert.match(read('app/(tabs)/profile.tsx'),/LOCALES\.map/);
 assert.doesNotMatch(read('app/(tabs)/profile.tsx'),/LOCALES\.filter/);
});
test('public static copy uses the Traditional dictionary, not an English/Simplified-only branch',()=>{
 const keys=new Set(),unwrapped=[];
 const files=[...walk('app'),...walk('src/uiux48'),...walk('src/components'),'src/appStoreRelease.ts'].filter(p=>/\.tsx?$/.test(p)&&!/(?:\/admin[/.]|\/dev\/|__tests__|GalleryUnavailable|TaskCard)/.test(p));
 for(const path of files){const sf=ts.createSourceFile(path,read(path),99,true,ts.ScriptKind.TSX);function visit(n){
  if(ts.isConditionalExpression(n)&&/^(?:en|locale\s*===\s*["']en["'])$/.test(n.condition.getText(sf))&&ts.isStringLiteral(n.whenFalse)&&/\p{Script=Han}/u.test(n.whenFalse.text))unwrapped.push(path+': '+n.whenFalse.text);
  if(ts.isCallExpression(n)){const name=n.expression.getText(sf),index=name==='translate'?1:0;const key=n.arguments[index];if(['t','copy','translate'].includes(name)&&key&&ts.isStringLiteral(key)&&/\p{Script=Han}/u.test(key.text))keys.add(key.text);}
  // Navigation/state tables carry static copy outside direct t() calls.
  if(ts.isPropertyAssignment(n)&&['cn','zhCN'].includes(n.name.getText(sf))&&ts.isStringLiteral(n.initializer)&&/\p{Script=Han}/u.test(n.initializer.text))keys.add(n.initializer.text);
  ts.forEachChild(n,visit);
 }visit(sf);}
 assert.deepEqual(unwrapped,[]);assert.ok(keys.size>500);
 assert.deepEqual([...keys].filter(k=>!Object.hasOwn(zhTW,k)),[],'All public static keys need reviewed Traditional copy');
 for(const key of keys){assert.ok(zhTW[key].trim());assert.deepEqual([...(key.match(/\{\w+\}/g)||[])].sort(),[...(zhTW[key].match(/\{\w+\}/g)||[])].sort(),key);}
});
test('translation is static and never rewrites user/API content; interpolation preserves the original name',()=>{
 assert.equal(translate('zh-TW','欢迎，{nickname}！',{nickname:'Daniel 简体名字'}),'歡迎，Daniel 简体名字！');
 assert.equal(translate('zh-TW','用户的原始消息，不在静态词典中'),'用户的原始消息，不在静态词典中');
 assert.equal(translate('zh-CN','通知设置'),'通知设置');assert.equal(translate('en','发送'),'Send');
 assert.equal(translate('zh-TW','首页'),'首頁');assert.equal(translate('en','首页'),'Home');
 assert.match(read('src/uiux48/Primitives.tsx'),/locale!=="zh-CN"\?undefined/);
 assert.match(read('src/uiux48/Theme.tsx'),/lang === "zh-TW"/);
});
test('native permission purpose strings and supported iOS languages include Traditional without changing privileges',()=>{
 const config=JSON.parse(read('app.json')).expo;
 assert.deepEqual(config.ios.infoPlist.CFBundleLocalizations,['en','zh-Hans','zh-Hant']);
 const keys=['NSCameraUsageDescription','NSMicrophoneUsageDescription','NSPhotoLibraryUsageDescription','NSPhotoLibraryAddUsageDescription','NSFaceIDUsageDescription'];
 for(const locale of ['en','zh-Hans','zh-Hant']){const d=JSON.parse(read('locales/'+locale+'.json'));for(const key of keys)assert.ok(d[key]);}
 assert.match(read('locales/zh-Hant.json'),/麥克風/);
 assert.equal(config.ios.bundleIdentifier,'com.ordashtech.nuri.nativelab');
 assert.equal(config.ios.entitlements['aps-environment'],'production');
});
