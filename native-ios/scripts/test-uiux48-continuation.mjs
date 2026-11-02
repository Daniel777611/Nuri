import {translate as _translateForI18nFixture} from './i18n-test-utils.mjs';
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import ts from "typescript";
const read=p=>readFileSync(p,"utf8");
function load(path,deps={}){const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;const m={exports:{}};new Function("require","module","exports",code)(name=>{assert.ok(name in deps,"unexpected import "+name);return deps[name];},m,m.exports);return m.exports;}
const all=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];
const tick=()=>new Promise(r=>setImmediate(r));
function savedFixture({fail=false,initialCollection=null,existingDraft=""}={}){
 let epoch=1,renderEpoch=1,cursor=0,tree,focus,release;const slots=[],calls=[],routes=[],drafts=[],sessionRequests=[];let params={id:"fixture-card",uiState:"detail"};
 const state=initial=>{const index=cursor++,owner=renderEpoch;if(!(index in slots))slots[index]=initial;return[slots[index],v=>{if(owner===epoch)slots[index]=typeof v==="function"?v(slots[index]):v;}];};
 const jsx=(type,props)=>({type,props});
 const Component=load("app/saved/[id].tsx",{react:{useCallback:x=>x,useRef:v=>{const index=cursor++;return slots[index]??={current:v};}},"react/jsx-runtime":{jsx,jsxs:jsx},"expo-router":{useLocalSearchParams:()=>params,useRouter:()=>({setParams:p=>{params={...params,...p};},replace:p=>routes.push(p),push:p=>routes.push(p)}),useFocusEffect:fn=>{focus=fn;}},"@/src/api":{auth:{getToken:async()=>"fixture-token"},api:{listFavorites:async()=>[{id:"fixture-card",title:"Fixture bedtime",body:"Fixture body",collection_id:initialCollection}],listCollections:async()=>[{id:"fixture-collection",name:"Fixture sleep"}],saveFavorite:(...a)=>{calls.push(["save",...a]);return new Promise((yes,no)=>{release=()=>fail?no(Error("fixture offline")):yes({saved:true,card_id:"fixture-card",collection_id:"fixture-collection"});});},toggleFavorite:async(...a)=>calls.push(["remove",...a]),startSession:async payload=>{sessionRequests.push(payload);return {id:"fixture-chat"};}}},"@/src/useAccountState":{useAccountState:state,useAccountScope:()=>{const owner=renderEpoch;return{capture:()=>epoch===owner?owner:null,current:t=>t!==null&&t===epoch};}},"@/src/i18n":{translate:_translateForI18nFixture,useT:()=>({locale:"en"})},"@/src/uiux48/Primitives":Object.fromEntries(["AuthFrame","MenuRow","NuriButton","NuriField","NuriText"].map(n=>[n,n])),"@/src/uiux48/StateCard":{StateCard:"StateCard"},"@/src/collectionActions":load("src/collectionActions.ts"),"@/src/uiux48/chatDraft":{readChatDraft:()=>existingDraft,writeChatDraft:(...a)=>drafts.push(a)}}).default;
 return{calls,routes,drafts,sessionRequests,render(){cursor=0;renderEpoch=epoch;tree=Component();return tree;},find:id=>all(tree).find(n=>n.props?.testID===id),async focus(){focus();await tick();await tick();},finish:()=>release(),changeOwner(){epoch++;}};
}
test("saved detail and collection navigation have no mutation side effects",async()=>{
 const f=savedFixture();f.render();await f.focus();f.render();assert.deepEqual(f.calls,[]);f.find("saved-detail-choose").props.onPress();f.render();assert.ok(f.find("collection-choose-card"));assert.deepEqual(f.calls,[]);
 f.find("choose-collection-fixture-collection").props.onPress();f.render();assert.deepEqual(f.calls,[]);f.find("collection-choose-save").props.onPress();f.find("collection-choose-save").props.onPress();f.render();await tick();assert.deepEqual(f.calls,[["save","fixture-card","fixture-collection"]]);assert.equal(f.find("saved-content-result"),undefined);
 f.finish();await tick();f.render();assert.ok(f.find("saved-content-result"));
});
test("failed collection save never renders a success receipt",async()=>{
 const f=savedFixture({fail:true});f.render();await f.focus();f.render();f.find("saved-detail-choose").props.onPress();f.render();f.find("choose-collection-fixture-collection").props.onPress();f.render();f.find("collection-choose-save").props.onPress();await tick();f.finish();await tick();f.render();assert.equal(f.find("saved-content-result"),undefined);assert.ok(JSON.stringify(f.render()).includes("not confirmed"));
});
test("stale saved-content callbacks cannot mutate a replacement account; discussion preserves a draft without sending",async()=>{
 const f=savedFixture();f.render();await f.focus();f.render();const old=f.find("saved-detail-remove").props.onPress;f.changeOwner();old();await tick();assert.deepEqual(f.calls,[]);
 const g=savedFixture();g.render();await g.focus();g.render();g.find("saved-detail-chat").props.onPress();await tick();assert.deepEqual(g.drafts,[["fixture-chat","Fixture bedtime",1]]);assert.deepEqual(g.routes,["/chat/fixture-chat"]);assert.deepEqual(g.calls,[]);
});
test("existing collection Done is read-confirmed without toggling off the favorite and returns to its detail",async()=>{
 const f=savedFixture({initialCollection:"fixture-collection"});f.render();await f.focus();f.render();f.find("saved-detail-choose").props.onPress();f.render();f.find("choose-collection-fixture-collection").props.onPress();f.render();f.find("collection-choose-save").props.onPress();await tick();f.render();assert.deepEqual(f.calls,[]);assert.ok(f.find("saved-content-result"));f.find("saved-content-result").props.primary.onPress();await tick();f.render();assert.ok(f.find("saved-detail-card"));assert.deepEqual(f.routes,[]);
});
test("saved-content discussion carries exact resource identity and preserves an existing main draft",async()=>{
 const f=savedFixture({existingDraft:"My unfinished question"});f.render();await f.focus();f.render();f.find("saved-detail-chat").props.onPress();await tick();assert.deepEqual(f.sessionRequests,[{card_id:"fixture-card"}]);assert.deepEqual(f.drafts,[]);assert.deepEqual(f.routes,["/chat/fixture-chat"]);
});
test("47 exact-node bilingual fixture mappings are unique and contain no service/permission imports",()=>{
 const {GALLERY_SCREENS:s}=load("src/dev/uiux48/galleryData.ts");assert.equal(s.length,47);assert.equal(new Set(s.map(x=>x.key)).size,47);assert.equal(new Set(s.map(x=>x.node)).size,47);
 for(const screen of s){assert.match(screen.node,/^\d+:\d+$/);for(const p of [screen.title,...screen.blocks.flatMap(b=>b.copy)]){assert.equal(p.length,2);assert.ok(p[0]&&p[1]);assert.doesNotMatch(p[1],/[\u3400-\u9fff]/);}}
 const gallery=read("src/dev/uiux48/Gallery.tsx");assert.doesNotMatch(gallery,/from ["'][^"']*(?:api|auth|storage|ImagePicker|chatVoiceInput)["']/);assert.match(gallery,/DEVELOPMENT FIXTURE/);assert.match(gallery,/variant===\"permission\"/);assert.match(gallery,/variant===\"loading\"/);
});
test("Metro excludes gallery graph in all release combinations, even an accidentally enabled flag",()=>{
 for(const dev of [false,true])for(const preview of ["0","1"])for(const flag of ["0","1"]){
  const p=spawnSync(process.execPath,["-e",`const c=require('./metro.config.js');console.log(c.resolver.resolveRequest({dev:${dev}},'nuri-uiux48-fixture-gallery','ios').filePath);`],{encoding:"utf8",env:{...process.env,EXPO_NO_DOTENV:"1",EXPO_PUBLIC_PREVIEW_MODE:preview,EXPO_PUBLIC_UIUX48_GALLERY:flag}});assert.equal(p.status,0,p.stderr);assert.equal(p.stdout.trim().endsWith("src/dev/uiux48/Gallery.tsx"),dev&&preview==="1"&&flag==="1");
 }
});
test("user-approved inline media removes redundant permission/review pages while retaining real adapters",()=>{
 const source=read("app/chat/[id].tsx");assert.doesNotMatch(source,/setMediaState|voice-permission-continue|camera-permission-continue|media-review-send/);assert.match(source,/onStop=\{\(\)=>void stopVoice\("draft"\)\}/);assert.match(source,/onSend=\{\(\)=>void stopVoice\("send"\)\}/);assert.match(source,/onDismiss=\{flushNativePicker\}/);assert.match(source,/await api\.transcribeVoice\(clip, locale\)/);assert.match(source,/startVoiceRecording\(\)/);assert.match(source,/launchCameraAsync/);assert.match(source,/testID="chat-image-preview"/);
 const state=read("src/uiux48/StateCard.tsx");assert.doesNotMatch(state,/useEffect|from ["'][^"']*(?:api|auth)["']/);assert.match(state,/onPress=\{primary.onPress\}/);
});

test("release Community entries are localized coming-soon surfaces, with no compose or network contract",()=>{
 const jsx=(type,props)=>({type,props});
 for(const locale of ["zh-CN","zh-TW","en"]){
  let params={},tree;const routes=[];
  const Component=load("app/community.tsx",{
   "nuri-ux49-flow-preview":{FLOW_PREVIEW_ENABLED:false,default:"DisabledPrototype",__esModule:true},
   "react/jsx-runtime":{jsx,jsxs:jsx},
   "expo-router":{useLocalSearchParams:()=>params,useRouter:()=>({push:href=>routes.push(href),replace:href=>routes.push(href),canGoBack:()=>false})},
   "@/src/i18n":{useT:()=>({locale})},
   "@/src/uiux48/Primitives":{CardList:"CardList",MenuRow:"MenuRow",NuriText:"NuriText"},
   "@/src/uiux48/StateCard":{StateCard:"StateCard"},
  }).UnavailableCommunity;
  const status=locale==="en"?"Coming soon":locale==="zh-TW"?"未上線":"未上线";
  tree=Component();assert.equal(all(tree).find(n=>n.props?.testID==="community-launch-status").props.children,status);
  for(const [id,screen] of [["community-ask","ask"],["community-find","find"],["community-inbox","inbox"]]){
   params={};tree=Component();all(tree).find(n=>n.props?.testID===id).props.onPress();
   assert.deepEqual(routes.at(-1),{pathname:"/community",params:{uiState:screen}});
   params={uiState:screen};tree=Component();assert.equal(tree.props.testID,"community-service-unavailable");assert.equal(tree.props.title,status);
   assert.equal(all(tree).find(n=>n.props?.testID==="community-bottle-draft"),undefined);
   tree.props.primary.onPress();assert.equal(routes.at(-1),"/community");
  }
  params={uiState:"unrecognized"};assert.equal(Component().props.title,status,"unknown service state also fails closed");
 }
 assert.doesNotMatch(read("app/community.tsx"),/from ["'][^"']*(?:api|auth|storage)["']|\bfetch\s*\(|useEffect/);
});
