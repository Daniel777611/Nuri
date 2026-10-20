import assert from 'node:assert/strict';
import {translate} from './i18n-test-utils.mjs';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
const read=p=>readFileSync(p,'utf8');
const load=(path,deps={})=>{const m={exports:{}};const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,'unexpected import '+name);return deps[name];},m,m.exports);return m.exports;};
const policy=load('src/appStoreRelease.ts');
const nodes=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
test('App Store fixed scope has only mature Home and Chat tabs for every account',()=>{
 assert.deepEqual(policy.APP_STORE_TABS.map(t=>t.name),['home','chat']);
 assert.doesNotMatch(read('src/appStoreRelease.ts'),/process\.env|isReviewer|user\.email|remoteConfig/);
 for(const tab of policy.APP_STORE_TABS)assert.ok(policy.isAppStorePathAllowed(tab.route));
});
test('old/unlaunched deep links are excluded; existing push-by-ID and settings stay supported',()=>{
 for(const path of ['/community','/community?uiState=inbox','/community/ask','/notifications','/notifications/','/admin','/admin/logs','/billing','/tasks','/(tabs)/tasks','/task/123','/uiux48-gallery'])assert.equal(policy.isAppStorePathAllowed(path),false,path);
 for(const path of ['/','/(tabs)','/chats','/chat/real-id','/notification-settings','/notifications/11223344-1234-4234-8234-112233445566','/login','/register','/forgot-password','/account-deletion','/ai-permission','/daily-post','/daily-video','/saved/item','/child/item'])assert.equal(policy.isAppStorePathAllowed(path),true,path);
 assert.equal(policy.appStoreNavigationRoute('community'),null);
 assert.equal(policy.appStoreNavigationRoute('notifications'),'/notification-settings');
});
test('Expo protected screens block mounting (not merely hidden buttons)',()=>{
 const root=read('app/_layout.tsx'),tabs=read('app/(tabs)/_layout.tsx');
 assert.match(root,/<Stack\.Protected guard=\{false\}>\{APP_STORE_BLOCKED_STACK_ROUTES\.map/);
 for(const path of ['community','notifications/index','billing','admin','admin/logs','task/[id]','uiux48-gallery'])assert.ok(policy.APP_STORE_BLOCKED_STACK_ROUTES.includes(path));
 assert.match(tabs,/<Stack\.Protected guard=\{false\}><Stack.Screen name="tasks"/);
});
test('retired route fallback renders no placeholder, icon, CTA or API call',()=>{
 const jsx=(type,props)=>({type,props});
 for(const path of ['app/community.tsx','app/notifications/index.tsx','app/(tabs)/tasks.tsx','app/task/[id].tsx']){
  const Component=load(path,{'react/jsx-runtime':{jsx,jsxs:jsx},'expo-router':{Redirect:'Redirect'}}).default;
  assert.deepEqual(Component(),{type:'Redirect',props:{href:'/(tabs)'}});
  assert.doesNotMatch(read(path),/\bfetch\s*\(|useEffect|api\.|onPress|Coming soon|未上线/);
 }
 assert.doesNotMatch(read('src/api.ts'),/req\([^\n]*["'`]\/tasks/);
 assert.match(read('app/notifications/[id].tsx'),/await api\.openNotification\(id as string\)/);
 assert.match(read('app/(tabs)/profile.tsx'),/router\.push\("\/notification-settings"\)/);
});
test('actual tab component has no Community or notification-history buttons/icons in CN and EN',()=>{
 const ast=ts.createSourceFile('Shell.tsx',read('src/uiux48/Shell.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const component=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='NuriTabBar');assert.ok(component);
 const code=ts.transpileModule(component.getText(ast)+'\nmodule.exports=NuriTabBar;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 for(const locale of ['zh-CN','zh-TW','en']){
  const jsx=(type,props)=>({type,props}),m={exports:{}},routes=[];
  new Function('require','module','exports','usePathname','useRouter','useT','useNuriTheme','useSafeAreaInsets','APP_STORE_TABS','requestGuardedNativeNavigation','View','GlassSurface','Pressable','NuriIcon','Text','s','translate',code)(()=>({jsx,jsxs:jsx}),m,m.exports,()=>'/profile',()=>({navigate:p=>routes.push(p)}),()=>({locale}),()=>({night:false,ink:'#222'}),()=>({bottom:34}),policy.APP_STORE_TABS,()=>false,'View','Glass','Pressable','Icon','Text',{footer:{},tabs:{},tab:{}},translate);
  const all=nodes(m.exports()),tabs=all.filter(n=>n.props?.accessibilityRole==='tab');assert.equal(tabs.length,2);
  assert.deepEqual(tabs.map(n=>n.props.testID),['nuri-tab-home','nuri-tab-chat']);
  assert.deepEqual(all.filter(n=>n.type==='Icon').map(n=>n.props.name),['home','chat']);
  for(const tab of tabs)tab.props.onPress();assert.deepEqual(routes,['/(tabs)','/(tabs)/chats']);
 }
});
