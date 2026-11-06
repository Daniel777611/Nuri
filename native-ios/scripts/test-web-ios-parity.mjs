import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
const BASE='13da662851f3cd589f5be0a9315a8164a7aff60d';
const root=path.resolve('..');
const read=p=>readFileSync(p,'utf8');
const hash=v=>createHash('sha256').update(v).digest('hex');
const git=args=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
const main=p=>git(['show',`${BASE}:${p}`]);
function loadSource(source,deps={},globals={}){const module={exports:{}};const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;new Function('require','module','exports',...Object.keys(globals),code)(name=>{assert.ok(name in deps,'Unexpected dependency '+name);return deps[name];},module,module.exports,...Object.values(globals));return module.exports;}
const load=(p,deps={},globals={})=>loadSource(read(p),deps,globals);
const ast=(s,name='file.ts')=>ts.createSourceFile(name,s,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function objectKeys(source,variable){let found;const walk=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText()===variable&&n.initializer&&ts.isObjectLiteralExpression(n.initializer))found=n.initializer.properties.map(p=>p.name?.getText().replace(/^['"]|['"]$/g,'')).filter(Boolean);ts.forEachChild(n,walk);};walk(ast(source));assert.ok(found,variable);return found;}
function exportsOf(source){return ast(source).statements.filter(n=>n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)).flatMap(n=>ts.isVariableStatement(n)?n.declarationList.declarations.map(d=>d.name.getText()):n.name?[n.name.getText()]:[]);}

test('real theme keeps browser requests same-origin and native defaults separate',()=>{
 for(const os of ['web','ios','android'])for(const backend of [undefined,'','https://backend.example.invalid/']){
  const mod=load('src/theme.ts',{'react-native':{Platform:{OS:os}}},{process:{env:{EXPO_PUBLIC_BACKEND_URL:backend}}});
  assert.equal(mod.API,backend?'https://backend.example.invalid/api':os==='web'?'/api':'https://nurifam.app/api');
 }
});
function metro(flags={}){const process={env:flags},module={exports:{}};new Function('require','module','exports','__dirname','process',read('metro.config.js'))(name=>name==='expo/metro-config'?{getDefaultConfig:()=>({resolver:{}})}:name==='node:path'?path:name==='node:crypto'?{createHash}:name==='./app.json'?JSON.parse(read('app.json')):(()=>{throw Error(name)})(),module,module.exports,process.cwd?.()??path.resolve('.'),process);return module.exports;}
const webFlags={EXPO_PUBLIC_BACKEND_URL:'',EXPO_PUBLIC_PREVIEW_MODE:'0',EXPO_PUBLIC_FLOW_PROTOTYPE:'1',EXPO_PUBLIC_UIUX48_GALLERY:'0',NURI_RELEASE_CHANNEL:'web-local-prototype'};
test('real Metro resolver scopes Community-local prototype to the exact independent web flags',()=>{
 const cases=[['web',webFlags,true],['ios',webFlags,false],['android',webFlags,false],['web',{...webFlags,EXPO_PUBLIC_FLOW_PROTOTYPE:'0'},false],['web',{...webFlags,EXPO_PUBLIC_PREVIEW_MODE:'1'},false],['web',{...webFlags,EXPO_PUBLIC_UIUX48_GALLERY:'1'},false],['web',{...webFlags,NURI_RELEASE_CHANNEL:'production'},false],['web',{},false]];
 for(const [platform,flags,enabled]of cases){const c=metro(flags),resolve=c.resolver.resolveRequest,context={dev:false,resolveRequest:(_c,m,p)=>({m,p})};assert.ok(resolve(context,'nuri-ux49-flow-preview',platform).filePath.endsWith(enabled?'prototype/FlowPreview.tsx':'FlowUnavailable.tsx'));assert.ok(resolve(context,'nuri-uiux48-fixture-gallery',platform).filePath.endsWith('GalleryUnavailable.tsx'));assert.deepEqual(resolve(context,'ordinary-module',platform),{m:'ordinary-module',p:platform});}
 assert.notEqual(metro(webFlags).cacheVersion,metro({...webFlags,EXPO_PUBLIC_PREVIEW_MODE:'1'}).cacheVersion);
 assert.notEqual(metro(webFlags).cacheVersion,metro({...webFlags,EXPO_PUBLIC_BACKEND_URL:'https://other.example.invalid'}).cacheVersion);
});
test('web scripts pin empty backend plus preview0/flow1/gallery0 instead of enabling API fixtures',()=>{
 const scripts=JSON.parse(read('package.json')).scripts;
 for(const name of ['build:web:ios-parity','web:ios-parity'])for(const [key,value]of Object.entries(webFlags))assert.match(scripts[name],new RegExp(`(?:^| )${key}=${value}(?: |$)`));
 assert.match(scripts['build:web:ios-parity'],/expo export --platform web$/);
 const flow=read('src/uiux49/prototype/FlowPreview.tsx');assert.match(flow,/entry\s*===\s*["']community["']/);assert.match(flow,/<CommunityRedesign\s+key=\{generation\}/);
 // Community runs on the live API through its one client, never raw fetch or fixtures.
 assert.doesNotMatch(read('src/uiuxfinal/communityModel.ts'),/\bfetch\s*\(|from\s+["'][^"']*api["']/);
 assert.match(read('src/uiuxfinal/CommunityFinal.tsx'),/from "@\/src\/communityApi"/);assert.doesNotMatch(read('src/uiuxfinal/CommunityFinal.tsx'),/\bfetch\s*\(/);
 const preview=load('src/preview-api.ts',{}, {process:{env:{EXPO_PUBLIC_PREVIEW_MODE:'0'}}});assert.equal(preview.isPreviewMode,false);
});
test('main native-ios API superset and module exports survive migration; legacy frontend paging is not fabricated',()=>{
 const current=read('src/api.ts'),baseline=main('native-ios/src/api.ts'),keys=objectKeys(current,'api'),old=objectKeys(baseline,'api');assert.equal(old.length,73);for(const k of old)assert.ok(keys.includes(k),'Missing main native client operation '+k);
 for(const k of exportsOf(baseline))assert.ok(exportsOf(current).includes(k),'Missing main export '+k);
 assert.ok(!old.includes('getMessagesPage'));assert.ok(!keys.includes('getMessagesPage'));
 const legacy=objectKeys(main('frontend/src/api.ts'),'api');assert.deepEqual(legacy.filter(k=>!keys.includes(k)),['getMessagesPage']);
 const chat=read('app/chat/[id].tsx');assert.match(chat,/await api\.getMessages\(id\)/);assert.doesNotMatch(chat,/getMessagesPage|has_more|next_cursor/);
});
test('web-specific identity/storage/font/shell adapters retain exact main source bytes',()=>{
 for(const p of ['src/theme.ts','src/utils/storage/index.web.ts','src/components/GoogleSignInButton.web.tsx','src/nativeShell.web.ts','src/textFonts.web.ts','src/hooks/use-icon-fonts.ts','src/googleSignInSession.ts'])assert.equal(hash(readFileSync(p)),hash(main('native-ios/'+p)),p);
 for(const [p,name]of [['src/i18n/en.ts','en'],['src/i18n/zh-TW.ts','zhTW']]){const old=loadSource(main('native-ios/'+p))[name],current=load(p)[name];for(const [key,value]of Object.entries(old))assert.equal(current[key],value,'Main dictionary key must remain: '+key);}
});
test('actual web font adapter installs local-only aliases once and all four route consumers use it',()=>{
 const inserted=[],nodes=new Map(),document={getElementById:id=>nodes.get(id),createElement:tag=>({tag}),head:{appendChild:n=>{nodes.set(n.id,n);inserted.push(n);}}};
 const first=load('src/textFonts.web.ts',{}, {document});load('src/textFonts.web.ts',{}, {document});assert.deepEqual(first.TEXT_FONTS,{});assert.equal(inserted.length,1);assert.equal((inserted[0].textContent.match(/@font-face/g)||[]).length,5);assert.match(inserted[0].textContent,/src:local\(/);assert.doesNotMatch(inserted[0].textContent,/url\(|https?:/);assert.deepEqual(load('src/textFonts.web.ts',{}, {document:undefined}).TEXT_FONTS,{});
 for(const p of ['app/_layout.tsx','app/register.tsx','app/onboarding.tsx','app/verify-email.tsx']){const source=read(p);assert.match(source,/from ["']@\/src\/textFonts["']/);assert.match(source,/useFonts\(TEXT_FONTS\)/);assert.doesNotMatch(source,/from ["']@expo-google-fonts\/noto-sans-sc["']/);}
});
test('actual browser storage uses only its platform adapter and preserves typed round-trips and removal',async()=>{
 const data=new Map(),calls=[],AsyncStorage={getItem:async k=>{calls.push(['get',k]);return data.get(k)??null;},setItem:async(k,v)=>{calls.push(['set',k]);data.set(k,v);},removeItem:async k=>{calls.push(['remove',k]);data.delete(k);}};
 const base=load('src/utils/storage/storage-base.ts'),C=load('src/utils/storage/index.web.ts',{'@react-native-async-storage/async-storage':{default:AsyncStorage,__esModule:true},'./storage-base':base});
 for(const value of ['fixture-token',true,3,null]){await C.storage.secureSet('fixture',value);assert.equal(await C.storage.secureGet('fixture','missing'),value);assert.equal(data.get('fixture'),JSON.stringify(value));}
 assert.equal(await C.storage.secureRemove('fixture'),true);assert.equal(await C.storage.secureGet('fixture','missing'),'missing');assert.ok(calls.some(c=>c[0]==='remove'));
});
test('real same-origin API transport remains authenticated, non-cached and account-epoch isolated',async()=>{
 const memory=new Map(),calls=[],storage={secureGet:async(k,f)=>memory.get(k)??f,secureSet:async(k,v)=>{memory.set(k,v);return true;},secureRemove:async k=>{memory.delete(k);return true;},getItem:async(k,f)=>memory.get(k)??f,setItem:async(k,v)=>{memory.set(k,v);return true;},removeItem:async k=>{memory.delete(k);return true;}};
 let held=null;const fetch=async(url,init)=>{assert.match(url,/^\/api\//,'An absolute or external request is forbidden in this fixture');calls.push({url,init});if(held)return held;return {ok:true,status:200,json:async()=>url.endsWith('/auth/me')?{id:'fixture-A'}:[],text:async()=>''};};
 const C=load('src/api.ts',{'./theme':{API:'/api'},'./utils/storage':{storage},'./preview-api':{isPreviewMode:false,previewRequest:()=>{throw Error('API fixture mode forbidden');}},'./aiConsent':load('src/aiConsent.ts'),'./sessionBoundary':load('src/sessionBoundary.ts')},{fetch});
 await C.auth.setToken('fixture-A');calls.length=0;assert.deepEqual(await C.api.getMessages('session-A'),[]);assert.equal(calls[0].url,'/api/chat/sessions/session-A/messages');assert.equal(calls[0].init.cache,'no-store');assert.equal(calls[0].init.headers.Authorization,'Bearer fixture-A');
 let resolve;held=new Promise(r=>resolve=r);const late=C.api.getMessages('session-A');while(calls.length<2)await new Promise(r=>setImmediate(r));await C.auth.setToken('fixture-B');resolve({ok:true,status:200,json:async()=>[{id:'A-private'}],text:async()=>''});await assert.rejects(late,e=>e.name==='SessionChangedError'||e.sessionChanged===true);assert.equal(await C.auth.getToken(),'fixture-B');
});
test('protected backend/native-shell/frontend trees remain main and Vercel changes only buildCommand',()=>{
 // The branch merged origin/main for the Community backend; protected trees must equal that main.
 const mainBase=(()=>{try{return git(['merge-base','HEAD','refs/remotes/origin/main']).trim()||BASE;}catch{return BASE;}})();
 const changed=git(['diff','--name-only',mainBase,'--','.',':(exclude)native-ios',':(exclude)vercel.json']).trim();assert.equal(changed,'','Changes outside independent native-ios frontend are forbidden');
 const untracked=git(['ls-files','--others','--exclude-standard']).trim().split('\n').filter(Boolean);assert.ok(untracked.every(p=>p.startsWith('native-ios/')),'No new protected root/backend files');
 const old=JSON.parse(main('vercel.json')),current=JSON.parse(read('../vercel.json'));// Production web builds like main again (no prototype flags), the same build the native apps use.
 assert.equal(current.buildCommand,old.buildCommand,'vercel.json buildCommand stays main');delete old.buildCommand;delete current.buildCommand;assert.deepEqual(current,old,'Rewrites/functions/crons/output and all remaining root deployment settings must remain main');
});
