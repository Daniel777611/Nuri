import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
const require=createRequire(import.meta.url), read=p=>readFileSync(p,"utf8");
function load(path,deps={}) {const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,m={exports:{}};new Function("require","module","exports",code)(name=>{assert.ok(name in deps,"unexpected import: "+name);return deps[name];},m,m.exports);return m.exports;}
const data=load("src/uiux49/prototype/screens.ts"), model=load("src/uiux49/prototype/model.ts",{"./screens":data});
const {createFlow49:create,flowReducer49:reduce,draftSlot49:slot,canChat49:canChat}=model;
const step=(s,...events)=>events.reduce(reduce,s);
test("new authority uses exactly five type roles, dual themes and64pt navigation",()=>{
 const spec=load("src/uiux49/spec.ts");assert.deepEqual(Object.keys(spec.TYPE49),["H1","H2","H3","Body","Caption"]);
 assert.deepEqual(Object.values(spec.TYPE49).map(t=>[t.fontSize,t.lineHeight]),[[24,32],[20,28],[18,26],[16,24],[12,16]]);
 assert.deepEqual(spec.ACTIVE_THEMES49,["Morning","Night"]);assert.equal(spec.normalizeTheme49("Afternoon"),"Morning");
 assert.deepEqual([4,5,12,18,19].map(spec.hourTheme49),["Night","Morning","Morning","Morning","Night"]);
 assert.equal(spec.TAB49.height,64);assert.equal(spec.TAB49.itemHeight+2*spec.TAB49.padding,64);
});
test("32 scoped presentations have current base anchors and complete explicit Traditional Chinese copy",()=>{
 const tw=load("src/uiux49/prototype/traditional.ts").FLOW_TW49;
 assert.equal(data.FLOW_SCREENS.length,32);assert.equal(new Set(data.FLOW_SCREENS.map(s=>s.key)).size,32);
 for(const s of data.FLOW_SCREENS){assert.match(s.node,/^8:\d+$/);for(const copy of [s.title,...s.blocks.flatMap(b=>b.copy)]){assert.ok(copy[0]&&copy[1]);assert.ok(tw[copy[0]],"missing Traditional Chinese: "+copy[0]);assert.doesNotMatch(copy[1],/[\u3400-\u9fff]/);}}
 assert.ok(!data.FLOW_SCREENS.some(s=>s.key==="communityChatSent"),"no canned auto-reply receipt");
});
test("answer refinement and follow-up retain role, same bottle and reply context",()=>{
 let s=reduce(create(),{type:"bottle",role:"responder"}), draft=slot(s);s=step(s,{type:"draft",slot:draft,text:"My answer"},{type:"refine"});
 assert.equal(s.screen,"bottleRefine");assert.equal(s.context.role,"responder");assert.equal(slot(s),draft);
 s=reduce(s,{type:"editOriginal"});assert.equal(s.screen,"bottleRespond");assert.equal(s.drafts[draft],"My answer");
 s=step(s,{type:"ownReplies"},{type:"followup"});assert.equal(s.context.bottleId,"demo-bottle-own");assert.equal(s.context.role,"questioner");assert.equal(s.context.replyId,"demo-reply-Maya");
 const followup=slot(s);assert.notEqual(followup,draft);s=step(s,{type:"draft",slot:followup,text:"Follow-up"},{type:"refine"},{type:"deliverBottle"});assert.equal(s.screen,"bottleWaiting");assert.equal(s.context.replyId,"demo-reply-Maya");assert.equal(s.messages.length,0);assert.deepEqual(s.connections,{});
});
test("exclusive anonymity and drafts survive canceled origin-aware voice review",()=>{
 let s=step(create(),{type:"bottle",role:"responder"},{type:"identity",value:"firstName"},{type:"identity",value:"anonymous"});assert.equal(s.identity,"anonymous");
 const originalSlot=slot(s);s=step(s,{type:"draft",slot:originalSlot,text:"Original"},{type:"voice",slot:originalSlot},{type:"voiceText",text:"Voice"},{type:"voiceReview"},{type:"cancelVoice"});
 assert.equal(s.screen,"bottleRespond");assert.equal(s.drafts[originalSlot],"Original");assert.equal(s.voiceOrigin,null);assert.equal(s.messages.length,0);
 s=step(s,{type:"voice",slot:originalSlot},{type:"voiceText",text:"Voice"},{type:"voiceReview"},{type:"applyVoice"});
 assert.equal(s.screen,"bottleRespond");assert.equal(s.drafts[originalSlot],"Original\nVoice");assert.equal(s.context.role,"responder");assert.ok(!s.history.some(h=>h.screen==="communityVoice"));
});
test("Keep original never overwrites source with edited refinement; closed bottle can start a separate new question",()=>{
 let s=reduce(create(),{type:"bottle",role:"questioner"}),key=slot(s);s=step(s,{type:"draft",slot:key,text:"Original"},{type:"refine"},{type:"draft",slot:`refine:${key}`,text:"Edited"});assert.equal(s.drafts[key],"Original");s=reduce(s,{type:"finishRefine",useEdited:false});assert.equal(s.screen,"bottleWaiting");assert.equal(s.drafts[key],"Original");const old=s.context.bottleId;
 s=step(s,{type:"go",screen:"bottleClose"},{type:"closeBottle"},{type:"bottle",role:"questioner"});assert.equal(s.closed[old],true);assert.notEqual(s.context.bottleId,old);assert.notEqual(slot(s),key);assert.equal(s.drafts[slot(s)],undefined);
});
test("matching needs explicit mutual simulation; icebreaker edits without sending",()=>{
 let s=create();assert.equal(reduce(s,{type:"go",screen:"communityChat"}),s);assert.equal(reduce(s,{type:"simulateMutual"}),s);
 s=step(s,{type:"person",name:"Deana",source:"discovery"},{type:"requestMatch"});assert.equal(s.screen,"matchPending");assert.equal(canChat(s),false);
 assert.equal(reduce(s,{type:"go",screen:"matchConnected"}),s);
 s=step(s,{type:"simulateMutual"},{type:"go",screen:"communityNewChat"},{type:"icebreaker",text:"Editable hello"});
 assert.equal(s.screen,"communityTyping");assert.equal(s.drafts[slot(s)],"Editable hello");assert.equal(s.messages.length,0);
 s=reduce(s,{type:"back"});assert.equal(s.screen,"communityNewChat");assert.equal(s.messages.length,0);assert.equal(s.drafts[slot(s)],"Editable hello");
 s=reduce(s,{type:"send"});assert.equal(s.messages.length,1);assert.equal(s.messages[0].text,"Editable hello");assert.equal(s.drafts[slot(s)],"");
 s=reduce(s,{type:"send"});assert.equal(s.messages.length,1,"no duplicate send or fabricated reply");
});
test("attachment preview preserves original draft, explicit remove and conversation isolation",()=>{
 let s=reduce(create(),{type:"person",name:"Maya",source:"inbox"}), firstSlot=slot(s);
 s=step(s,{type:"draft",slot:firstSlot,text:"Keep me"},{type:"attach",slot:firstSlot},{type:"go",screen:"communityCameraPermission"},{type:"go",screen:"communityImageReview"},{type:"cancelAttachment"});
 assert.equal(s.screen,"communityNewChat");assert.equal(s.drafts[firstSlot],"Keep me");assert.equal(s.attachment,false);
 s=step(s,{type:"attach",slot:firstSlot},{type:"applyAttachment"},{type:"person",name:"Priya",source:"inbox"},{type:"send"});assert.equal(s.messages.length,0);assert.notEqual(s.attachmentSlot,slot(s));
 s=reduce(s,{type:"removeAttachment"});assert.equal(s.attachment,false);assert.equal(s.attachmentSlot,null);
});
test("safety navigation never mutates; local confirmation is distinct and blocked chats stay inaccessible",()=>{
 let s=step(create(),{type:"person",name:"Maya",source:"inbox"},{type:"go",screen:"communitySafety"},{type:"go",screen:"communityBlock"});
 assert.deepEqual(s.blocked,{});const id=s.context.personId;s=reduce(s,{type:"confirmSafety",action:"block"});assert.equal(s.blocked[id],true);assert.equal(s.screen,"communityInbox");assert.equal(canChat(s),false);
 s=reduce(s,{type:"go",screen:"communityChat"});assert.equal(s.screen,"communityInbox");
 s=reduce(s,{type:"back"});assert.notEqual(s.screen,"communityChat");
 s=step(s,{type:"reviewBlocked",personId:id,name:"Maya"},{type:"confirmSafety",action:"unblock"});assert.equal(s.blocked[id],false);
 s=step(s,{type:"go",screen:"communityReport"});const unchanged=reduce(s,{type:"confirmSafety",action:"report"});assert.equal(unchanged,s);
 s=step(s,{type:"choose",group:"communityReport:0",index:1,single:true},{type:"confirmSafety",action:"report"});assert.equal(s.screen,"communityReported");assert.equal(s.receipt,"local");assert.equal(s.hidden,false);
 s=step(s,{type:"go",screen:"communityDisconnect"},{type:"confirmSafety",action:"disconnect"});assert.equal(s.connections[id],"disconnected");assert.equal(s.hidden,false);assert.equal(s.blocked[id],false);
});
test("ordinary builds exclude prototype graph; original-app explicit TestFlight channel is independently gated",()=>{
 const run=(bundle,dev,env)=>{const m={exports:{}};vm.runInNewContext(read("metro.config.js"),{module:m,__dirname:"/fixture/native-ios",process:{env},require:name=>name==="expo/metro-config"?{getDefaultConfig:()=>({resolver:{}})}:name==="./app.json"?{expo:{ios:{bundleIdentifier:bundle}}}:require(name)});return m.exports;};
 for(const bundle of ["com.ordashtech.nuri.nativelab","com.ordashtech.nuri.preview","com.ordashtech.nuri.preview.qa"])
 for(const dev of [true,false])for(const preview of ["0","1"])for(const channel of [undefined,"testflight-prototype","uiux49-qa"])for(const flag of ["0","1"]){
  const env={EXPO_PUBLIC_PREVIEW_MODE:preview,EXPO_PUBLIC_FLOW_PROTOTYPE:flag,NURI_RELEASE_CHANNEL:channel};const c=run(bundle,dev,env);
  const path=c.resolver.resolveRequest({dev},"nuri-ux49-flow-preview","ios").filePath;
  const expected=flag==="1"&&(channel==="testflight-prototype"&&bundle==="com.ordashtech.nuri.nativelab"&&preview==="0"||channel==="uiux49-qa"&&dev&&preview==="1");
  assert.equal(path.endsWith("prototype/FlowPreview.tsx"),expected,JSON.stringify({bundle,dev,preview,channel,flag}));
 }
 const base=run("com.ordashtech.nuri.nativelab",false,{}), proto=run("com.ordashtech.nuri.nativelab",false,{EXPO_PUBLIC_FLOW_PROTOTYPE:"1",NURI_RELEASE_CHANNEL:"testflight-prototype"});assert.notEqual(base.cacheVersion,proto.cacheVersion);
 for(const sdk of ["iphoneos26.5","iphonesimulator26.5"])for(const bundle of ["com.ordashtech.nuri.nativelab","com.ordashtech.nuri.preview.qa"]){const c=run("com.ordashtech.nuri.nativelab",false,{EXPO_PUBLIC_FLOW_PROTOTYPE:"1",EXPO_PUBLIC_PREVIEW_MODE:"1",NURI_RELEASE_CHANNEL:"uiux49-qa",SDK_NAME:sdk,PRODUCT_BUNDLE_IDENTIFIER:bundle});assert.equal(c.resolver.resolveRequest({dev:false},"nuri-ux49-flow-preview","ios").filePath.endsWith("prototype/FlowPreview.tsx"),sdk.startsWith("iphonesimulator")&&bundle.endsWith(".qa"));}
});
const walk=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(walk):[n,...walk(n.props?.children)];
function ui(locale="en",entry="community") {
 let cursor=0,tree;const hooks=[],navigation=[],effects=[];
 const jsx=(type,props)=>({type,props});
 const react={useReducer:(r,arg,init)=>{const i=cursor++;hooks[i]??=init(arg);return[hooks[i],event=>{hooks[i]=r(hooks[i],event);}];},useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=initial;return[hooks[i],value=>hooks[i]=typeof value==="function"?value(hooks[i]):value];},useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},useCallback:x=>x};
 const names=["ChoiceChip","GlassSurface","IconAction","MenuRow","NuriButton","NuriField","NuriKeyboardFrame","NuriText","ToggleRow"];
 const Component=load("src/uiux49/prototype/FlowPreview.tsx",{react,"react/jsx-runtime":{jsx,jsxs:jsx},"react-native":{ActivityIndicator:"Loading",ScrollView:"ScrollView",StyleSheet:{create:x=>x},View:"View"},"expo-router":{useFocusEffect:f=>effects.push(f),usePathname:()=>"/"+entry,useRouter:()=>({setParams:p=>navigation.push(p),navigate:p=>navigation.push(p),push:p=>navigation.push(p)})},"@/src/i18n":{useT:()=>({locale}),translate:(_l,t)=>t},"@/src/components/nativeNavigation":{registerNativeNavigationGuard:()=>()=>{}},"@/src/uiux48/Primitives":Object.fromEntries(names.map(n=>[n,n])),"@/src/uiux48/Composer":{NuriComposer:"Composer"},"./screens":data,"./model":model,"./traditional":load("src/uiux49/prototype/traditional.ts")}).default;
 return{render(){cursor=0;tree=Component({entry});return tree;},find:id=>walk(tree).find(n=>n.props?.testID===id),get state(){return hooks[0];},dispatch:event=>hooks[0]=reduce(hooks[0],event),presentation:screen=>{hooks[0]={...hooks[0],screen};},navigation};
}
test("actual UI hub reaches editable answer, voice review returns to answer and no real adapter is invoked",()=>{
 const a=ui();a.render();a.find("flow-hub-2").props.onPress();a.render();a.find("flow-row-4").props.onPress();a.render();a.find("flow-field-3").props.onChangeText("Fixture answer");a.render();a.find("flow-answer-voice").props.onPress();a.render();a.find("flow-voice-text").props.onChangeText("Fixture voice");a.render();a.find("flow-action-voiceReview").props.onPress();a.render();a.find("flow-action-applyVoice").props.onPress();a.render();assert.equal(a.state.screen,"bottleRespond");assert.equal(a.find("flow-field-3").props.value,"Fixture answer\nFixture voice");assert.equal(a.navigation.length,0);
});
test("all32 mapped UI states render in three locales without invoking service or permission modules",()=>{
 for(const locale of ["zh-CN","zh-TW","en"])for(const screen of data.FLOW_SCREENS){const a=ui(locale);a.render();a.presentation(screen.key);assert.doesNotThrow(()=>a.render(),screen.key+locale);assert.ok(a.find("flow-preview-label"));assert.equal(a.state.screen,screen.key,"presentation coverage is distinct from transition acceptance");}
 for(const path of ["src/uiux49/prototype/FlowPreview.tsx","src/uiux49/prototype/model.ts","src/uiux49/prototype/screens.ts"]){const source=read(path);assert.doesNotMatch(source,/from ["'][^"']*(?:api|auth|storage|ImagePicker|chatVoiceInput|expo-audio)["']|\bfetch\s*\(|setTimeout\s*\(|setInterval\s*\(/);}
});
