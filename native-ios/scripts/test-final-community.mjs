import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read=p=>readFileSync(p,"utf8");
function load(path,deps={}){
 const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const m={exports:{}};
 new Function("require","module","exports",code)(name=>{if(name.startsWith("@/assets/"))return name;assert.ok(name in deps,"Unapproved dependency "+name);return deps[name];},m,m.exports);
 return m.exports;
}
const model=load("src/uiuxfinal/communityModel.ts");
const {createFinalCommunity:create,finalCommunityReducer:reduce,FINAL_COMMUNITY_NODES:nodes}=model;
const step=(s,...events)=>events.reduce(reduce,s);
test("all final presentation states refer to the supplied final file nodes",()=>{
 assert.equal(Object.keys(nodes).length,39);
 for(const node of Object.values(nodes))assert.match(node,/^188:\d+$/);
 assert.equal(model.isFinalCommunityScreen("__proto__"),false);
});
test("opening every destination is inert: no consent, messages, deletes or service dependencies",()=>{
 const start=create();for(const screen of Object.keys(nodes)){const s=reduce(start,{type:"go",screen});assert.deepEqual(s.ai,{});assert.deepEqual(s.messages,[]);assert.deepEqual(s.questions,start.questions);}
 assert.doesNotMatch(read("src/uiuxfinal/communityModel.ts"),/\bfetch\(|from ["'][^"']*(?:api|auth|storage)/);
});
test("question preview preserves exact text, double-send is inert, closing and deletion require confirmation",()=>{
 let s=step(create(),{type:"newQuestion"},{type:"draft",slot:"question",text:"Fixture question 甲\n乙"},{type:"previewQuestion"});
 assert.equal(s.screen,"preview");assert.equal(s.drafts.question,"Fixture question 甲\n乙");
 assert.equal(reduce(s,{type:"confirmQuestions",action:"delete"}),s);
 s=step(s,{type:"sendQuestion"},{type:"finishSend"});assert.equal(s.screen,"sent");assert.equal(s.questions[0].cn,"Fixture question 甲\n乙");
 assert.equal(reduce(s,{type:"finishSend"}),s);
 const keep=s.questions[1].id,id=s.questions[0].id;
 s=step(s,{type:"go",screen:"selection"},{type:"select",id},{type:"go",screen:"close"});assert.equal(s.questions[0].closed,false);
 s=reduce(s,{type:"confirmQuestions",action:"close"});assert.equal(s.questions[0].closed,true);assert.equal(s.questions[1].closed,false);
 s=step(s,{type:"go",screen:"selection"},{type:"select",id},{type:"go",screen:"delete"},{type:"confirmQuestions",action:"delete"});
 assert.ok(!s.questions.some(q=>q.id===id));assert.ok(s.questions.some(q=>q.id===keep));
});
test("each parent keeps separate draft, messages and explicit local consent",()=>{
 let s=create();for(const person of ["Maya","Ray"]){s=step(s,{type:"person",person,screen:"chat"},{type:"draft",slot:"chat:"+person,text:"for "+person},{type:"sendMessage"});}
 assert.deepEqual(s.messages.map(m=>m.person),["Maya","Ray"]);assert.equal(s.messages[1].text,"for Ray");assert.deepEqual(s.ai,{});
 s=reduce(s,{type:"requestConsent"});assert.equal(s.screen,"consent");assert.deepEqual(s.ai,{});
 s=reduce(s,{type:"confirmConsent",allowed:false});assert.equal(s.ai.Ray,false);
 s=step(s,{type:"requestConsent"},{type:"confirmConsent",allowed:true});assert.equal(s.ai.Ray,true);assert.equal(s.ai.Maya,undefined);
 s=reduce(s,{type:"disableAI"});assert.equal(s.ai.Ray,false);assert.deepEqual(create().messages,[]);
});
test("reply drafts and comments are question/target scoped, not parent chat messages",()=>{
 let s=step(create(),{type:"openQuestion",id:model.QUESTION_FIXTURES[0].id},{type:"replyTarget",target:"Maya"});
 const slot=`comment:${s.questionID}:Maya`;
 s=step(s,{type:"draft",slot,text:"Keep this reply"},{type:"sendComment"});
 assert.equal(s.comments.length,1);assert.equal(s.comments[0].target,"Maya");assert.equal(s.messages.length,0);assert.equal(s.drafts[slot],"");
 s=reduce(s,{type:"back"});assert.equal(s.screen,"replies");
});
test("daytime is invariant for every hour and saved/preview Night value",()=>{
 const theme=load("src/uiux49/spec.ts");assert.deepEqual(theme.ACTIVE_THEMES49,["Morning"]);
 for(let hour=0;hour<24;hour++)assert.equal(theme.hourTheme49(hour),"Morning");
 for(const value of ["Night","Afternoon","Morning",null])assert.equal(theme.normalizeTheme49(value),"Morning");
});
test("success/back never revisits progress or repeats creation; deleted IDs stay monotonic",()=>{
 let s=step(create(),{type:"newQuestion"},{type:"draft",slot:"question",text:"One"},{type:"previewQuestion"},{type:"sendQuestion"},{type:"finishSend"});
 const count=s.questions.length,id=s.questionID;
 for(let i=0;i<8;i++)s=step(s,{type:"back"},{type:"finishSend"});
 assert.equal(s.questions.length,count);assert.equal(s.questions[0].id,id);assert.notEqual(s.screen,"sending");
 s=step(s,{type:"go",screen:"selection"},{type:"select",id},{type:"go",screen:"delete"},{type:"confirmQuestions",action:"delete"});
 assert.ok(!s.history.some(x=>x.screen==="delete"));
 s=step(s,{type:"newQuestion"},{type:"draft",slot:"question",text:"Two"},{type:"previewQuestion"},{type:"sendQuestion"},{type:"finishSend"});assert.notEqual(s.questionID,id);
});
test("received question opens once and a local answer moves the same record to Replied",()=>{
 let s=create("received");const q=s.incoming.find(q=>q.status==="waiting");s=reduce(s,{type:"openReceived",id:q.id});assert.equal(s.screen,"respond");assert.equal(s.history.length,1);
 s=step(s,{type:"draft",slot:`answer:${q.id}`,text:"Our family experience"},{type:"sendResponse"});assert.equal(s.incoming.find(x=>x.id===q.id).answer,"Our family experience");
 s=step(s,{type:"go",screen:"receivedReplied"},{type:"openReceived",id:q.id});assert.equal(s.screen,"replies");assert.equal(s.questionID,q.id);
});
test("closed questions and blocked parents reject writes; blocking only occurs after explicit confirmation",()=>{
 let s=step(create(),{type:"go",screen:"selection"},{type:"select",id:"sample-daycare"},{type:"go",screen:"close"},{type:"confirmQuestions",action:"close"},{type:"openQuestion",id:"sample-daycare"});
 assert.equal(reduce(s,{type:"replyTarget",target:"Maya"}),s);
 s=step(s,{type:"draft",slot:`comment:${s.questionID}:all`,text:"No write"},{type:"sendComment"});assert.equal(s.comments.length,0);
 s=step(s,{type:"person",person:"Maya",screen:"chat"},{type:"safety",action:"block"});assert.deepEqual(s.blocked,[]);
 s=reduce(s,{type:"confirmSafety"});assert.deepEqual(s.blocked,["Maya"]);
 s=step(s,{type:"person",person:"Maya",screen:"chat"},{type:"draft",slot:"chat:Maya",text:"No send"},{type:"sendMessage"});assert.equal(s.messages.length,0);
 s=step(s,{type:"safety",action:"unblock"},{type:"confirmSafety"});assert.deepEqual(s.blocked,[]);
});
test("disconnect and unblock do not silently restore a relationship; reconnection is explicit",()=>{
 let s=step(create(),{type:"person",person:"Maya",screen:"chat"},{type:"safety",action:"disconnect"},{type:"confirmSafety"});
 assert.ok(!s.contacts.includes("Maya"));assert.ok(s.disconnected.includes("Maya"));s=reduce(s,{type:"person",person:"Maya",screen:"chat"});assert.equal(s.screen,"parent");
 s=step(s,{type:"safety",action:"block"},{type:"confirmSafety"},{type:"safety",action:"unblock",person:"Maya"},{type:"confirmSafety"});assert.ok(s.disconnected.includes("Maya"));assert.ok(!s.contacts.includes("Maya"));
 s=step(s,{type:"person",person:"Maya",screen:"parent"},{type:"connect"});assert.ok(s.contacts.includes("Maya"));assert.ok(!s.disconnected.includes("Maya"));
});
test("user initials and photo URI fallback do not fabricate profile media",()=>{
 const a=load("src/uiuxfinal/avatar.ts");assert.equal(a.userInitial("  Momo妈妈 "),"M");assert.equal(a.userInitial(" 张妈妈 "),"张");assert.equal(a.userInitial(""),"");assert.equal(a.userInitial(null),"");assert.equal(a.userPhotoURL("javascript:bad"),null);assert.equal(a.userPhotoURL("https://example.invalid/a.png"),"https://example.invalid/a.png");
});
const walk=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(walk):[n,...walk(n.props?.children)];
function ui(locale="en"){
 let cursor=0,tree;const hooks=[],jsx=(type,props)=>({type,props});
 const react={useReducer:(r,arg,init)=>{const i=cursor++;hooks[i]??=init(arg);return[hooks[i],event=>hooks[i]=r(hooks[i],event)];},useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=initial;return[hooks[i],value=>hooks[i]=typeof value==="function"?value(hooks[i]):value];},useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},useCallback:f=>f,useEffect:()=>{}};
 const component=load("src/uiuxfinal/CommunityFinal.tsx",{react,"react/jsx-runtime":{jsx,jsxs:jsx},"react-native":Object.fromEntries(["ActivityIndicator","Modal","Pressable","ScrollView","Switch","TextInput","View"].map(n=>[n,n]).concat([["StyleSheet",{create:x=>x}]])),"expo-image":{Image:"Image"},"expo-blur":{BlurView:"BlurView"},"expo-router":{useFocusEffect:()=>{},useLocalSearchParams:()=>({}),usePathname:()=>"/community",useRouter:()=>({setParams:()=>{},navigate:()=>{},dismissTo:()=>{}})},"@/src/i18n":{useT:()=>({locale}),translate:(_locale,text)=>text},"@/src/components/nativeNavigation":{registerNativeNavigationGuard:()=>()=>{}},"@/src/uiux48/Primitives":{IconAction:"IconAction",NuriKeyboardFrame:"NuriKeyboardFrame"},"@/src/uiux48/Composer":{NuriComposer:"NuriComposer"},"@/src/uiux48/VoiceInputBar":{VoiceInputBar:"VoiceInputBar"},"./Primitives":{FinalButton:"FinalButton",FinalDivider:"FinalDivider",FinalSurface:"FinalSurface",FinalText:"FinalText",FINAL_COLOR:{accent:"#735c84"}},"./Settings":Object.fromEntries(["SettingsPage","SettingsRow","SettingsToggle","SettingsButton","SettingsSpacer","SettingsField"].map(n=>[n,n])),"./communityModel":model}).default;
 return{render(){cursor=0;tree=component();return tree;},get state(){return hooks[0]},show(screen){hooks[0]={...hooks[0],screen};},find(id){return walk(tree).find(n=>n.props?.testID===id);},buttons(){return walk(tree).filter(n=>n.type==="FinalButton");}};
}
test("real TSX renders all canonical states in both languages without service/permission imports",()=>{
 for(const locale of ["zh-CN","en"])for(const screen of Object.keys(nodes)){const a=ui(locale);a.render();a.show(screen);assert.doesNotThrow(()=>a.render(),locale+screen);}
 assert.doesNotMatch(read("src/uiuxfinal/CommunityFinal.tsx"),/\bfetch\(|from ["'][^"']*(?:\/api|auth|ImagePicker|expo-audio)["']/);
});
test("reachable actual hub CTA opens editable question then preview, never submits on navigation",()=>{
 const a=ui();a.render();a.find("final-hub-primary-0").props.onPress();a.render();assert.equal(a.state.screen,"compose");
 a.find("final-question-input").props.onChangeText("Internal fixture");a.render();a.find("final-preview-question").props.onPress();a.render();assert.equal(a.state.screen,"preview");assert.equal(a.state.questions.length,model.QUESTION_FIXTURES.length);a.find("final-send-question").props.onPress();a.render();assert.equal(a.state.screen,"sending");
});
test("production notification list adapter uses verified main read-only route, not demo history",()=>{
 const api=read("src/api.ts"),page=read("app/notifications/index.tsx");assert.match(api,/listNotifications:.*\/notifications\?limit=/);assert.match(page,/api\.listNotifications\(\)/);assert.doesNotMatch(page,/FlowPreview|FLOW_PREVIEW_ENABLED/);assert.match(page,/encodeURIComponent\(item.id\)/);
});
