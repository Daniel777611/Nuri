import {translate as _translateForI18nFixture} from './i18n-test-utils.mjs';
import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import ts from "typescript";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";

const handoff="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48";
const manifest=JSON.parse(readFileSync(handoff+"/approved-icon-assets-ecd4df22/icon-manifest.json","utf8"));
const receipt=JSON.parse(readFileSync(handoff+"/mac-icon-import-receipt.json","utf8"));
const names={home:"home",chat:"chat",notifications:"notifications",person:"person",chevronRight:"chevron-right",arrowRight:"arrow-right",play:"play",camera:"camera",image:"image",send:"send",mic:"microphone",plus:"plus",expand:"expand",collapse:"collapse",close:"close",back:"back",settings:"settings",community:"community"};
const assets=[];
function load(path,deps={}){
 deps={"@/src/uiux48/StateCard":{StateCard:"StateCard"},...deps};
 const output=ts.transpileModule(readFileSync(path,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const module={exports:{}};new Function("require","module","exports",output)(name=>{
  if(name.startsWith("@/assets/uiux48/approved-icons/"))return name;
  assert.ok(name in deps,"unexpected import "+name);return deps[name];
 },module,module.exports);return module.exports;
}
test("all 18 original SVGs retain exact hashes, root24 geometry and approved1px metadata",()=>{
 assert.equal(manifest.assets.length,18);assert.deepEqual(manifest.canvas,{width:24,height:24});assert.equal(manifest.strokeWidth,1);
 assert.equal(receipt.archiveSha256,"ecd4df224aca0673335f4334fefd3a359fa2880ed2c849f1d32bf2eae092c6b7");
 for(const a of manifest.assets){
  const input=readFileSync(handoff+"/approved-icon-assets-ecd4df22/"+a.file),output=readFileSync("assets/uiux48/approved-icons/"+a.file);
  const sha=b=>createHash("sha256").update(b).digest("hex");
  assert.equal(sha(input),a.sha256);assert.equal(sha(output),a.sha256);assert.equal(output.length,a.byteLength);assert.equal(input.length,a.byteLength);
  assert.equal(receipt.assets.find(x=>x.file===a.file).sha256,a.sha256);
  const root=output.toString("utf8",0,180).match(/<svg\b[^>]*>/)?.[0];
  assert.ok(root);assert.match(root,/\bwidth="24"/);assert.match(root,/\bheight="24"/);assert.ok(a.strokeWeights.every(s=>s.weight===1));
  assets.push({file:a.file,sha256:sha(output),bytes:output.length,width:24,height:24,source_node:a.nodeId});
 }
});
test("shared icon component maps every supplied file, uses theme ink and24px artwork inside44pt actions",()=>{
 let ink="#49404f";const jsx=(type,props)=>({type,props});
 const rn={ActivityIndicator:"Activity",KeyboardAvoidingView:"KAV",Platform:{OS:"ios"},Pressable:"Pressable",ScrollView:"ScrollView",StyleSheet:{create:x=>x},Switch:"Switch",Text:"Text",TextInput:"Input",View:"View"};
 const p=load("src/uiux48/Primitives.tsx",{react:{forwardRef:x=>x},"react/jsx-runtime":{jsx,jsxs:jsx},"react-native":rn,"expo-blur":{BlurView:"Blur"},"expo-image":{Image:"Image"},"expo-linear-gradient":{LinearGradient:"Gradient"},"@/src/i18n":{translate:_translateForI18nFixture,useT:()=>({locale:"en"})},"expo-router":{},"./Theme":{useNuriTheme:()=>({ink})},"./materials":{GLASS_BLUR48:{}}});
 for(const color of ["#49404f","#f9f1e8"]){ink=color;for(const [name,file]of Object.entries(names)){
  const el=p.NuriIcon({name});assert.equal(el.props.source,"@/assets/uiux48/approved-icons/"+file+".svg");assert.deepEqual(el.props.style,{width:24,height:24});assert.equal(el.props.tintColor,color);assert.equal(el.props.accessible,false);
  let pressed=0;const action=p.IconAction({name,label:name,onPress:()=>pressed++});const target=action.props.style({pressed:false})[0];assert.equal(target.width,44);assert.equal(target.height,44);action.props.onPress();assert.equal(pressed,1);
 }}
 const composer=readFileSync("src/uiux48/Composer.tsx","utf8");assert.match(composer,/<NuriIcon name="send"/);assert.match(composer,/<IconAction name="collapse"/);assert.match(composer,/keyboardAccessory/);
 const home=readFileSync("app/(tabs)/index.tsx","utf8");assert.doesNotMatch(home,/name="(?:arrowRight|chevronRight)"/);
 const google=readFileSync("src/components/GoogleSignInButton.tsx","utf8");assert.match(google,/google-sdk-logo\.png/);assert.doesNotMatch(google,/tintColor/);
});

const nodes=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
function harness(path,dependencies){
 const values=[];let cursor=0,tree,focus;
 const state=initial=>{const i=cursor++;if(!(i in values))values[i]=typeof initial==="function"?initial():initial;return[values[i],v=>{values[i]=typeof v==="function"?v(values[i]):v;}];};
 const jsx=(type,props)=>({type,props});const router={replace:()=>{},setParams:()=>{},push:()=>{}};
 const rn={View:"View",AppState:{addEventListener:()=>({remove(){}})},Pressable:"Pressable",StyleSheet:{create:x=>x}};
 const component=load(path,{react:{useState:state,useCallback:x=>x,useRef:initial=>{const i=cursor++;return values[i]??={current:initial};}},"react/jsx-runtime":{jsx,jsxs:jsx},"react-native":rn,"expo-router":{useRouter:()=>router,useLocalSearchParams:()=>({uiState:"permission"}),useFocusEffect:fn=>{focus=fn;}},"@/src/useAccountState":{useAccountState:state,useAccountScope:()=>({capture:()=>1,current:t=>t===1})},"@/src/i18n":{translate:_translateForI18nFixture,useT:()=>({locale:"en",t:x=>x})},"@/src/uiux48/Primitives":{AuthFrame:"AuthFrame",CenteredCard:"CenteredCard",CardList:"CardList",NuriText:"Text",NuriButton:"Button",NuriField:"Field",MenuRow:"Row",ToggleRow:"Toggle",InlineState:"State",ChoiceChip:"Choice"},"@react-navigation/elements":{useHeaderHeight:()=>60},"@expo/vector-icons":{},"@/src/components/NativeSafeAreaView":{},"@/src/theme":{colors:{},radius:{},spacing:{},type:{}},...dependencies}).default;
 return{router,render(){cursor=0;tree=component();return tree;},find:id=>nodes(tree).find(n=>n.props?.testID===id),text:()=>nodes(tree).filter(n=>n.type==="Text").map(n=>n.props.children).join(" "),focus:()=>focus()};
}
test("reset success waits for existing API confirmation, clears secrets and returns to login without silent sign-in",async()=>{
 let fail=true,calls=0;const destinations=[],params=[];
 const a=harness("app/forgot-password.tsx",{"@/src/api":{api:{forgotPassword:async()=>({resend_after:0}),resetPassword:async()=>{calls++;if(fail)throw Error("offline");return{access_token:"ignored-test-response"};}}},"@/src/authFlow":{authErrorMessage:()=>null,cleanCode:x=>x,useCountdown:()=>0}});
 a.router.replace=x=>destinations.push(x);a.router.setParams=x=>params.push(x);a.render();a.find("forgot-email").props.onChangeText("parent@example.invalid");a.render();await a.find("forgot-send-btn").props.onPress();a.render();
 for(const [id,value]of [["forgot-code","123456"],["forgot-new-password","fixture-password"],["forgot-confirm-password","fixture-password"]])a.find(id).props.onChangeText(value);
 a.render();await a.find("forgot-reset-btn").props.onPress();a.render();assert.ok(a.find("forgot-error"));assert.equal(a.find("reset-done-login"),undefined);assert.deepEqual(destinations,[]);
 fail=false;await a.find("forgot-reset-btn").props.onPress();a.render();assert.ok(a.find("reset-done-login"));assert.equal(a.find("forgot-new-password"),undefined);assert.deepEqual(params,[{uiState:"resetDone"}]);assert.deepEqual(destinations,[]);assert.equal(calls,2);a.find("reset-done-login").props.onPress();assert.deepEqual(destinations,["/login"]);
});
test("notification permission asks only on user action, deduplicates taps and never reports denied as allowed",async()=>{
 let requests=0,permission="not_determined",finish;const navigation=[];
 const a=harness("app/notification-settings.tsx",{"@/src/api":{api:{getNotificationPreferences:async()=>({}),getPrivacy:async()=>({})}},"@/src/nativePush":{getReminderSettings:async()=>({permissionStatus:permission}),requestNotificationPermission:()=>{requests++;return new Promise(r=>finish=r);},openNotificationSettings:async()=>{}}});
 a.router.replace=x=>navigation.push(x);a.render();a.focus();await new Promise(r=>setImmediate(r));a.render();assert.equal(requests,0);
 a.find("notification-permission-allow").props.onPress();a.find("notification-permission-allow").props.onPress();assert.equal(requests,1);permission="denied";finish(null);await new Promise(r=>setImmediate(r));a.render();assert.deepEqual(navigation,[]);assert.match(a.text(),/not allowed yet/);
 a.find("notification-permission-skip").props.onPress();assert.equal(requests,1);assert.deepEqual(navigation,["/notification-settings"]);
 permission="authorized";a.find("notification-permission-allow").props.onPress();finish(null);await new Promise(r=>setImmediate(r));assert.equal(requests,2);assert.deepEqual(navigation,["/notification-settings","/notification-settings"]);
});
test("external status screens return only to known internal resources, never supplied URLs",()=>{
 const {contentReturnTarget:target}=load("src/uiux48/contentReturn.ts");
 assert.deepEqual(target("video","video-1"),{pathname:"/daily-video",params:{id:"video-1"}});
 assert.deepEqual(target("post","post-1"),{pathname:"/daily-post",params:{id:"post-1"}});
 assert.deepEqual(target("https://example.invalid","https://example.invalid"),{pathname:"/daily-post",params:{}});
 assert.deepEqual(target("video",["cross-account"]),{pathname:"/daily-video",params:{}});
});
test("source preview and unavailable cards retain return/reload/chat callbacks",()=>{
 const deps={"@/src/uiux48/contentReturn":load("src/uiux48/contentReturn.ts")};
 const source=harness("app/source-preview.tsx",deps),routes=[];source.router.replace=x=>routes.push(x);source.render();source.find("source-preview-return").props.onPress();assert.deepEqual(routes,[{pathname:"/daily-post",params:{}}]);
 const missing=harness("app/content-unavailable.tsx",deps);missing.router.replace=x=>routes.push(x);missing.router.navigate=x=>routes.push(x);missing.render();missing.find("content-unavailable-reload").props.onPress();missing.find("content-unavailable-chat").props.onPress();assert.deepEqual(routes.at(-2),{pathname:"/daily-post",params:{}});assert.equal(routes.at(-1),"/(tabs)/chats");
});
test.after(()=>writeFileSync(handoff+"/icon-assets-source-verification.json",JSON.stringify({message_id:"UIUX48-ICON-ASSETS-20261019-01",checked_at:new Date().toISOString(),source_snapshot:sourceSnapshot(),assets,source_archive_hash_source:"Existing import receipt; 18 extracted source and integrated SVG files freshly rehashed, archive not freshly rehashed",svg_paths_changed:false,native_verified:false,google_logo_unchanged:true},null,2)));
