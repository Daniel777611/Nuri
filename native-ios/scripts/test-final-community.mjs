import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import {translate as translateFixture} from "./i18n-test-utils.mjs";

const read=p=>readFileSync(p,"utf8");
function load(path,deps={}){
 deps={...deps,"./ButtonMaterial":{FrostedPressable:deps["react-native"]?.Pressable??"Pressable",ButtonBackdrop:"ButtonBackdrop"}};
 const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const m={exports:{}};
 if(path==="src/uiuxfinal/CommunityFinal.tsx"){
  deps={...deps,"./ParentChatHeader":load("src/uiuxfinal/ParentChatHeader.tsx",{"react/jsx-runtime":deps["react/jsx-runtime"],"react-native":deps["react-native"],"expo-image":deps["expo-image"],"./Primitives":deps["./Primitives"]})};
  deps["./Primitives"]={...deps["./Primitives"],FinalChatBubble:"FinalChatBubble"};
 }
 new Function("require","module","exports",code)(name=>{if(name==="@/src/keyboard/AppKeyboard")return {NuriTextInput:deps["react-native"]?.TextInput??"TextInput",useAppKeyboardVisible:()=>false,useAppKeyboard:()=>({visible:false,height:0,activeHostId:null,dismiss:()=>{}}),AppKeyboardScope:({children})=>children,AppKeyboardHost:"AppKeyboardHost"};if(name==="./CommunityProfileEditor")return {CommunityProfileEditor:"CommunityProfileEditor"};if(name.startsWith("@/assets/"))return name;if(name==="./communityHubLayout")return load("src/uiuxfinal/communityHubLayout.ts");if(name==="@/src/uiux48/inputLayout")return load("src/uiux48/inputLayout.ts");if(name==="@/src/uiux48/useComposerDock")return {useComposerDockInset:enabled=>enabled?46:0};assert.ok(name in deps,"Unapproved dependency "+name);return deps[name];},m,m.exports);
 return m.exports;
}
const model=load("src/uiuxfinal/communityModel.ts");
const {createFinalCommunity:create,finalCommunityReducer:reduce,FINAL_COMMUNITY_NODES:nodes}=model;
const step=(s,...events)=>events.reduce(reduce,s);
test("all final presentation states refer to the supplied final file nodes",()=>{
 assert.equal(Object.keys(nodes).length,42);
 for(const node of Object.values(nodes))assert.match(node,/^188:\d+$/);
 assert.equal(model.isFinalCommunityScreen("__proto__"),false);
 assert.equal(nodes.profileSettings,"188:63013");assert.equal(nodes.parentSettings,undefined);assert.deepEqual(model.FINAL_COMMUNITY_LOCAL_SCREENS,["parentSettings"]);assert.equal(model.isFinalCommunityScreen("parentSettings"),true);
});
test("opening every destination is inert: no consent, messages, deletes or service dependencies",()=>{
 const start=create();for(const screen of Object.keys(nodes)){const s=reduce(start,{type:"go",screen});assert.deepEqual(s.ai,{});assert.deepEqual(s.messages,[]);assert.deepEqual(s.questions,start.questions);}
 assert.doesNotMatch(read("src/uiuxfinal/communityModel.ts"),/\bfetch\(|from ["'][^"']*(?:api|auth|storage)/);
});
test("all3 pager roots normalize page/expanded state, clear navigation history and preserve local content without side effects",()=>{
 for(const[screen,page,inboxExpanded]of [["hub",0,false],["friends",1,false],["inbox",1,true]]){const s=create(screen);assert.equal(s.page,page);assert.equal(s.inboxExpanded,inboxExpanded);assert.deepEqual(s.history,[]);assert.deepEqual(s.ai,{});assert.deepEqual(s.messages,[]);}
 const original=step(create("inbox"),{type:"draft",slot:"chat:Maya",text:"Keep my unfinished message"},{type:"filter",key:"distance",index:2},{type:"go",screen:"contacts"});assert.equal(original.history.length,1);
 for(const[screen,page,inboxExpanded]of [["hub",0,true],["friends",1,false],["inbox",1,true]]){const s=reduce(original,{type:"go",screen});assert.equal(s.screen,screen);assert.equal(s.page,page);assert.equal(s.inboxExpanded,inboxExpanded);assert.deepEqual(s.history,[]);for(const key of ["drafts","messages","questions","incoming","filters","ai","contacts","blocked","disconnected"])assert.deepEqual(s[key],original[key],screen+"/"+key);}
 let s=reduce(original,{type:"go",screen:"inbox"});s=reduce(s,{type:"page",page:0});assert.equal(s.screen,"hub");assert.equal(s.page,0);assert.equal(s.inboxExpanded,true);s=reduce(s,{type:"page",page:1});assert.equal(s.screen,"inbox");assert.equal(s.page,1);assert.equal(s.inboxExpanded,true);assert.deepEqual(s.history,[]);assert.equal(s.drafts["chat:Maya"],"Keep my unfinished message");
 s=reduce(s,{type:"go",screen:"friends"});assert.equal(s.inboxExpanded,false);s=step(s,{type:"page",page:0},{type:"page",page:1});assert.equal(s.screen,"friends");assert.equal(s.inboxExpanded,false);
});
test("expanded inbox navigation round trips retain page1 while no pager or back action grants AI or changes messages",()=>{
 for(const destination of ["chat","contacts","invitations"]){let s=create("inbox");s=reduce(s,destination==="chat"?{type:"person",person:"Ray",screen:"chat"}:{type:"go",screen:destination});assert.equal(s.screen,destination);assert.equal(s.page,1);assert.equal(s.inboxExpanded,true);s=reduce(s,{type:"back"});assert.equal(s.screen,"inbox");assert.equal(s.page,1);assert.equal(s.inboxExpanded,true);assert.deepEqual(s.history,[]);assert.deepEqual(s.ai,{});assert.deepEqual(s.messages,[]);}
 for(const screen of ["chat","contacts","suggestions","consent"]){const s=create(screen);for(const page of [0,1])assert.equal(reduce(s,{type:"page",page}),s,"Late pager events cannot navigate over "+screen);}
 for(const page of [-1,2,.5,NaN]){const s=create("inbox");assert.equal(reduce(s,{type:"page",page}),s,"Out-of-range native page index is inert");}
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
 let s=create("received");const q=s.incoming.find(q=>q.status==="waiting");s=reduce(s,{type:"openReceived",id:q.id});assert.equal(s.screen,"responsePrompt");assert.equal(s.history.length,1);s=reduce(s,{type:"go",screen:"respond"});
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
 s=step(s,{type:"person",person:"Maya",screen:"parent"},{type:"connect"});assert.equal(s.screen,"inviteSent");assert.ok(!s.contacts.includes("Maya"));assert.ok(s.disconnected.includes("Maya"));assert.ok(s.sentInvitations.includes("Maya"));
});
test("user initials and photo URI fallback do not fabricate profile media",()=>{
 const a=load("src/uiuxfinal/avatar.ts");assert.equal(a.userInitial("  Momo妈妈 "),"M");assert.equal(a.userInitial(" 张妈妈 "),"张");assert.equal(a.userInitial(""),"");assert.equal(a.userInitial(null),"");assert.equal(a.userPhotoURL("javascript:bad"),null);assert.equal(a.userPhotoURL("https://example.invalid/a.png"),"https://example.invalid/a.png");
});
const walk=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(walk):[n,...walk(n.props?.children)];
// Inspect visible child/label copy, never AX hints or hidden disclosure props.
const visibleCopy=n=>n==null||typeof n==="boolean"?"":typeof n==="string"||typeof n==="number"?String(n):Array.isArray(n)?n.map(visibleCopy).join("\n"):["children","label","detail","title","message","note"].map(key=>visibleCopy(n.props?.[key])).join("\n");
const removedCommunityCopy=[
 ["仅保存在本次演示，没有发送到服务器。","Saved in this preview only. Nothing was sent to a server."],
 ["仅本次演示","This preview only"],
 ["社区服务尚未接入；以上为本地演示设置。","Community service is not connected; these are local preview settings."],
 ["仅更改本地演示，不影响真实账号或联系。","This changes only the local preview, not real accounts or connections."],
 ["仅本地模拟，未真实发送。","Local simulation only; nothing sent."],
 ["仅在本次演示中预览，不向真实家长发送信息。","Local preview only. Nothing is sent to real parents."],
 ["本地流程预览，没有发送到服务器。","Local flow preview. Nothing sent to a server."],
 ["只影响本次演示中的选中记录，不修改真实数据。","Only selected records in this preview are affected; no real data is changed."],
 ["仅在此设备模拟，不保存真实同意，也不启动真实记录。","Simulated on this device only. No real consent is saved and no real recording starts."],
 ["你的演示回复","Your preview reply"],
];
function assertNoExtraCommunityCopy(a,locale,context){
 assert.equal(a.find("final-local-receipt"),undefined,context);
 assert.equal(a.find("final-sent-local-disclosure"),undefined,context);
 const visible=visibleCopy(a.tree);
 for(const[cn,en]of removedCommunityCopy)for(const phrase of new Set([cn,en,translateFixture(locale,cn)]))assert.ok(!visible.includes(phrase),`${context}: unexpected visible copy ${phrase}`);
}
function ui(locale="en",options={}){
 let cursor=0,focusCursor=0,tree,pending=[],focused=!!options.focus,mounted=true;
 const hooks=[],effects=[],focuses=[],setters=[],writes=[],measurements=[],refs=[],routes=[],jsx=(type,props,key)=>({type,props,...(key===undefined?{}:{key})});
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 const set=(i,value)=>{writes.push(i);if(mounted)hooks[i]=typeof value==="function"?value(hooks[i]):value;};
 const react={useReducer:(r,arg,init)=>{const i=cursor++;hooks[i]??=init(options.uiState??arg);setters[i]??=event=>set(i,previous=>r(previous,event));return[hooks[i],setters[i]];},useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==="function"?initial():initial;setters[i]??=value=>set(i,value);return[hooks[i],setters[i]];},useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},useCallback:(fn,deps)=>{const i=cursor++;if(!hooks[i]||!same(hooks[i].deps,deps))hooks[i]={fn,deps};return hooks[i].fn;},useEffect:(fn,deps)=>{const i=cursor++;if(options.effects&&(!effects[i]||!same(deps,effects[i].deps)))pending.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});}};
 const navigation=load("src/components/nativeNavigation.ts"),router={setParams:p=>options.params?.push(p),navigate:href=>routes.push({type:"navigate",href}),dismissTo:href=>routes.push({type:"dismissTo",href})};
 const component=load("src/uiuxfinal/CommunityFinal.tsx",{react,"react/jsx-runtime":{jsx,jsxs:jsx},"react-native":Object.fromEntries(["ActivityIndicator","Modal","Pressable","ScrollView","Switch","TextInput","View"].map(n=>[n,n]).concat([["StyleSheet",{create:x=>x}],["Platform",{OS:options.platform??"ios"}]])),"expo-image":{Image:"Image"},"expo-blur":{BlurView:"BlurView"},"expo-router":{useFocusEffect:fn=>{const i=focusCursor++;if(focuses[i]?.fn!==fn)pending.push(()=>{focuses[i]?.cleanup?.();focuses[i]={fn,cleanup:focused?fn():null};});},useLocalSearchParams:()=>({}),usePathname:()=>"/community",useRouter:()=>router},"@/src/i18n":{useT:()=>({locale}),translate:(activeLocale,text)=>options.realTranslations?translateFixture(activeLocale,text):text},"@/src/components/nativeNavigation":navigation,"@/src/uiux48/Primitives":{IconAction:"IconAction",NuriKeyboardFrame:"NuriKeyboardFrame"},"@/src/uiux48/Composer":{NuriComposer:"NuriComposer"},"@/src/uiux48/VoiceInputBar":{VoiceInputBar:"VoiceInputBar"},"./Primitives":{FinalButton:"FinalButton",FinalDivider:"FinalDivider",FinalSurface:"FinalSurface",FinalText:"FinalText",FINAL_COLOR:{accent:"#735c84"}},"./Settings":Object.fromEntries(["SettingsPage","SettingsRow","SettingsToggle","SettingsButton","SettingsSpacer","SettingsField"].map(n=>[n,n])),"./communityModel":model}).default;
 const find=id=>walk(tree).find(n=>n.props?.testID===id);
 return{render(){assert.equal(mounted,true);cursor=0;focusCursor=0;pending=[];tree=component();pending.forEach(fn=>fn());return tree;},get state(){return hooks[0]},get tree(){return tree},get routes(){return routes},get writes(){return writes.length},show(screen){hooks[0]={...hooks[0],screen};},back(){hooks[0]=reduce(hooks[0],{type:"back"});},find,buttons(){return walk(tree).filter(n=>n.type==="FinalButton");},blur(){focused=false;focuses.forEach(entry=>{entry.cleanup?.();entry.cleanup=null;});},focus(){focused=true;focuses.forEach(entry=>{entry.cleanup=entry.fn();});},unmount(){if(!mounted)return;effects.forEach(entry=>entry?.cleanup?.());focuses.forEach(entry=>entry?.cleanup?.());[...new Set([...refs,...walk(tree).map(node=>node.props?.ref).filter(Boolean)])].forEach(ref=>{if(typeof ref==="function")ref(null);else ref.current=null;});mounted=false;},navigate(action){return navigation.requestGuardedNativeNavigation("/community",action);},measure(id,bounds,{defer=false}={}){const ref=find(id)?.props.ref;assert.ok(ref,`Missing actual native ref ${id}`);const handle={measureInWindow:callback=>{const entry={id,callback,bounds};measurements.push(entry);if(!defer)callback(...bounds);}};if(typeof ref==="function")ref(handle);else ref.current=handle;refs.push(ref);return handle;},get measurements(){return measurements},resolveMeasure(index,bounds=measurements[index]?.bounds){assert.ok(measurements[index],"Missing deferred measure");measurements[index].callback(...bounds);}};
}
test("real TSX renders all canonical states in both languages without service/permission imports",()=>{
 for(const locale of ["zh-CN","en"])for(const screen of Object.keys(nodes)){const a=ui(locale);a.render();a.show(screen);assert.doesNotThrow(()=>a.render(),locale+screen);}
 assert.doesNotMatch(read("src/uiuxfinal/CommunityFinal.tsx"),/\bfetch\(|from ["'][^"']*(?:\/api|auth|ImagePicker|expo-audio)["']/);
});
test("all42 canonical Community states omit only the removed visible extra copy in all3 production locales",()=>{
 for(const locale of ["zh-CN","zh-TW","en"])for(const screen of Object.keys(nodes)){
  const a=ui(locale,{uiState:screen,realTranslations:true});a.render();assertNoExtraCommunityCopy(a,locale,`${locale}/${screen}`);
 }
 // Presentation cleanup must not turn the local mock graph into a service.
 for(const file of ["src/uiuxfinal/CommunityFinal.tsx","src/uiuxfinal/communityModel.ts"])assert.doesNotMatch(read(file),/\bfetch\(|from ["'][^"']*(?:\/api|auth|ImagePicker|expo-audio)["']/);
});
test("actual close/delete confirmation returns to My questions with localReceipt true but no visible receipt in all3 locales",()=>{
 for(const locale of ["zh-CN","zh-TW","en"])for(const action of ["close","delete"]){
  const a=ui(locale,{uiState:"myQuestions",realTranslations:true});a.render();const original=structuredClone(a.state.questions),selected=original.find(q=>q.id==="sample-daycare"),remaining=original.filter(q=>q.id!==selected.id);
  a.find("final-select-questions").props.onPress();a.render();a.find("final-select-sample-daycare").props.onPress();a.render();a.find("final-question-more").props.onPress();a.render();a.find(`final-question-menu-${action}`).props.onPress();a.render();
  assert.equal(a.state.screen,action);assert.deepEqual(a.state.questions,original,"Merely opening the confirmation cannot change records");assert.ok(a.find("final-confirm-questions"));assertNoExtraCommunityCopy(a,locale,`${locale}/${action}/confirm`);
  a.find("final-confirm-questions").props.onPress();a.render();assert.equal(a.state.screen,"myQuestions");assert.equal(a.state.localReceipt,true);assert.deepEqual(a.state.selected,[]);assert.deepEqual(a.state.history,[]);assertNoExtraCommunityCopy(a,locale,`${locale}/${action}/myQuestions`);
  assert.deepEqual(a.state.questions.filter(q=>q.id!==selected.id),remaining,"Unselected records and message text remain unchanged");
  if(action==="close")assert.deepEqual(a.state.questions.find(q=>q.id===selected.id),{...selected,closed:true});else assert.equal(a.state.questions.find(q=>q.id===selected.id),undefined);
  for(const question of remaining)assert.ok(visibleCopy(a.tree).includes(locale==="en"?question.en:question.cn));
 }
});
test("real local reply and parent-message callbacks preserve exact content without reintroducing visible demo receipts",()=>{
 for(const locale of ["zh-CN","zh-TW","en"]){
  const a=ui(locale,{uiState:"replies",realTranslations:true}),text="Keep my exact reply 甲\n乙";a.render();a.find("final-expand-reply").props.onPress();a.render();a.find("final-input-comment:sample-daycare:all").props.onChangeText(text);a.render();const send=a.find("final-send-experience");assert.equal(send.props.disabled,false);send.props.onPress();a.render();
  assert.equal(a.state.screen,"replies");assert.equal(a.state.localReceipt,true);assert.equal(a.state.comments.at(-1).text,text);assert.equal(a.state.drafts["comment:sample-daycare:all"],"");assert.equal(a.state.messages.length,0);assert.ok(visibleCopy(a.tree).includes(text));assert.ok(visibleCopy(a.tree).includes(locale==="en"?"Your reply":translateFixture(locale,"你的回复")));assertNoExtraCommunityCopy(a,locale,`${locale}/replied`);
  const b=ui(locale,{uiState:"chat",realTranslations:true});b.render();const composer=()=>walk(b.tree).find(n=>n.type==="NuriComposer");composer().props.onChangeText(text);b.render();composer().props.onSend();b.render();assert.equal(b.state.localReceipt,true);assert.equal(b.state.messages.at(-1).text,text);assert.ok(visibleCopy(b.tree).includes(text));assert.deepEqual(b.state.ai,{});assertNoExtraCommunityCopy(b,locale,`${locale}/chat-sent`);
  composer().props.onAttach();b.render();const attachment=b.find("final-parent-sample-attachment");assert.equal(attachment.props.children,locale==="en"?"Sample attachment":translateFixture(locale,"示例附件"));assert.equal(attachment.props.accessibilityLabel,locale==="en"?"Sample attachment · No photo access or upload":translateFixture(locale,"示例附件 · 不读取相册、不上传"));assert.ok(!visibleCopy(b.tree).includes("No photo access or upload"));assert.ok(!visibleCopy(b.tree).includes(translateFixture(locale,"不读取相册、不上传")));const remove=b.buttons().find(n=>n.props.label===(locale==="en"?"Remove attachment":translateFixture(locale,"移除附件")));assert.ok(remove);remove.props.onPress();b.render();assert.equal(b.find("final-parent-sample-attachment"),undefined);assert.equal(b.state.messages.at(-1).text,text);
 }
});
test("hub uses original tilted unread asset beside title, bounded preview lines and flow-owned disclosure",()=>{
 for(const locale of ["zh-CN","en"]){
  const a=ui(locale),tree=a.render();
  for(const [screen,id] of [["myQuestions","final-open-my-questions"],["received","final-open-received"]]){
   const row=a.find(id),icon=a.find("final-bottle-icon-"+screen);
   assert.equal(row.props.style.minHeight,80);assert.equal(row.props.style.paddingRight,24);
   assert.equal(icon.props.source,"@/assets/final-flow-20261101/bottle-unread.svg");assert.deepEqual(icon.props.style,{width:31,height:29});
   const iconSlot=walk(row).find(n=>n.props?.children===icon);assert.equal(iconSlot.props.style.width,29);assert.equal(iconSlot.props.style.height,24);
   const titleRow=walk(row).find(n=>n.props?.style?.gap===12);assert.equal(titleRow.props.style.alignItems,"center");assert.equal(titleRow.props.style.minHeight,24);
   const texts=walk(row).filter(n=>n.type==="FinalText");assert.equal(texts[1].props.numberOfLines,1);assert.equal(texts[1].props.ellipsizeMode,"tail");assert.equal(texts[2].props.size,12);
  }
  const demo=walk(tree).find(n=>typeof n.type==="function"&&n.type.name==="DemoLabel"),disclosure=demo.type(demo.props);
  assert.equal(disclosure.type,"View");assert.equal(disclosure.props.style.position,"absolute");assert.equal(disclosure.props.style.width,1);assert.equal(disclosure.props.style.height,1);
  assert.equal(disclosure.props.accessible,true);assert.ok(disclosure.props.accessibilityLabel.includes(locale==="en"?"Sample data":"示例数据"));assert.ok(disclosure.props.accessibilityLabel.includes(locale==="en"?"nothing is sent":"不发送到服务器"));
  const page=a.find("final-community-page-0");assert.equal(walk(page).find(n=>n.type==="ScrollView").props.contentContainerStyle.paddingTop,68);
  a.find("final-community-pager").props.onLayout({nativeEvent:{layout:{height:565}}});a.render();
  assert.equal(walk(a.find("final-community-page-0")).find(n=>n.type==="ScrollView").props.contentContainerStyle.paddingTop,26);
  a.find("final-community-pager").props.onLayout({nativeEvent:{layout:{height:623}}});a.render();
  assert.equal(walk(a.find("final-community-page-0")).find(n=>n.type==="ScrollView").props.contentContainerStyle.paddingTop,68);
 }
 const svg=read("assets/final-flow-20261101/bottle-unread.svg");assert.match(svg,/^<svg width="31" height="29" viewBox="0 0 31 29"/);
});
test("reachable actual hub CTA opens editable question then preview, never submits on navigation",()=>{
 const a=ui();a.render();a.find("final-hub-primary-0").props.onPress();a.render();assert.equal(a.state.screen,"compose");
 a.find("final-question-input").props.onChangeText("Internal fixture");a.render();a.find("final-preview-question").props.onPress();a.render();assert.equal(a.state.screen,"preview");assert.equal(a.state.questions.length,model.QUESTION_FIXTURES.length);a.find("final-send-question").props.onPress();a.render();assert.equal(a.state.screen,"sending");
});
test("Friends first-frame spacing follows the Figma grouped message stack, not five 12pt gaps",()=>{
 const {communityHubTopPadding:top}=load("src/uiuxfinal/communityHubLayout.ts");
 for(const locale of ["zh-CN","en"])for(const height of [565,623]){
  const a=ui(locale);a.render();a.find("final-community-pager").props.onLayout({nativeEvent:{layout:{height}}});a.render();
  const page=a.find("final-community-page-1"),scroll=walk(page).find(n=>n.type==="ScrollView"),messages=a.find("final-friends-messages");
  assert.equal(scroll.props.contentContainerStyle.paddingTop,height===623?88:33);
  assert.equal(scroll.props.contentContainerStyle.paddingBottom,16);assert.equal(scroll.props.contentContainerStyle.gap,12);
  assert.equal(messages.props.style.paddingTop,4);assert.equal(messages.props.style.gap,4);
  assert.equal(a.find("final-open-inbox").props.style.minHeight,32);
  for(const p of ["Maya","Ray"]){
   const row=a.find("final-parent-"+p);assert.equal(row.props.style.minHeight,72);assert.equal(row.props.style.padding,8);assert.equal(row.props.style.gap,16);
   const text=walk(row).find(n=>n.type==="FinalText"&&n.props.size===14);assert.equal(text.props.style.lineHeight,20);assert.equal(text.props.numberOfLines,1);assert.equal(text.props.ellipsizeMode,"tail");
   const avatar=walk(row).find(n=>typeof n.type==="function"&&n.type.name==="FriendPreviewAvatar"),tree=avatar.type();
   assert.equal(tree.props.style.width,40);assert.equal(tree.props.style.height,40);
   const art=walk(tree).find(n=>n.props?.source?.endsWith("parent-avatar.png"));assert.deepEqual(art.props.style,{position:"absolute",left:4,top:12.332,width:31.667,height:27.667});
  }
  // The base text stack and full 40pt Ray avatar fit without a vertical scroll.
  assert.ok(top(height,1)+528<=height-4);
 }
 assert.equal(top(623,0),68);assert.equal(top(565,0),26);assert.equal(top(300,1),16);assert.equal(top(0,1),88);
});
test("original 30×9 pagination art preserves 21pt centers independently of adjacent non-overlapping hit regions",()=>{
 const {HUB_PAGINATION:p}=load("src/uiuxfinal/communityHubLayout.ts");assert.deepEqual(p,{width:30,height:9,dotSize:9,centerDistance:21,targetSize:44,targetHeight:32});
 const a=ui();a.render();const dots=a.find("final-community-dots"),art=a.find("final-community-dots-art");
 assert.equal(dots.props.style.width,88);assert.equal(dots.props.style.height,32);assert.equal(dots.props.style.marginTop,-23);assert.equal(dots.props.style.justifyContent,"flex-end");
 assert.equal(dots.props.style.height+dots.props.style.marginTop,9);assert.deepEqual(art.props.style,{width:30,height:9});
 // Region ends at the dot's bottom, before the parent's 4pt bottom padding.
 // Its upper 15pt use only the card's 16pt empty padding, never Ray's row.
 assert.equal(8+dots.props.style.marginTop,-15);assert.equal(8+dots.props.style.marginTop+dots.props.style.height,17);
 const visualLeft=(88-30)/2;
 for(const i of [0,1]){
  const hit=Object.assign({},...a.find(`final-community-dot-${i}`).props.style),center=visualLeft+4.5+21*i;
  assert.equal(hit.width,44);assert.equal(hit.height,32);assert.equal(hit.left,i*44);assert.ok(center>hit.left&&center<hit.left+44);
 }
 assert.ok(art.props.source.endsWith("pagination-questions.svg"));a.find("final-community-dot-1").props.onPress();a.render();assert.equal(a.state.page,1);assert.equal(a.find("final-community-dot-1").props.accessibilityState.selected,true);assert.ok(a.find("final-community-dots-art").props.source.endsWith("pagination-friends.svg"));
 for(const file of ["pagination-friends.svg","pagination-questions.svg"])assert.match(read("assets/final-flow-20261101/"+file),/width="30" height="9" viewBox="0 0 30 9"/);
});
test("initial Friends, dot taps, swipe, resize and subpage return keep selection and native horizontal offset in sync",()=>{
 for(const initial of ["hub","friends"]){
  const a=ui("en",{effects:true,uiState:initial}),calls=[];a.render();
  a.find("final-community-pager").props.ref.current={scrollTo:args=>calls.push(args)};
  a.find("final-community-pager-viewport").props.onLayout({nativeEvent:{layout:{width:390}}});a.render();assert.deepEqual(calls.at(-1),{x:initial==="friends"?390:0,animated:false});
  a.find("final-community-pager").props.onContentSizeChange(780);assert.deepEqual(calls.at(-1),{x:initial==="friends"?390:0,animated:false});
  const count=calls.length;a.find("final-community-pager").props.onContentSizeChange(1);assert.equal(calls.length,count);
  a.find("final-community-dot-1").props.onPress();a.render();assert.deepEqual(calls.at(-1),{x:390,animated:false});
  a.find("final-community-pager").props.onMomentumScrollEnd({nativeEvent:{contentOffset:{x:0},layoutMeasurement:{width:390}}});a.render();assert.equal(a.state.page,0);assert.deepEqual(calls.at(-1),{x:0,animated:false});
  a.find("final-community-dot-1").props.onPress();a.render();a.find("final-community-pager-viewport").props.onLayout({nativeEvent:{layout:{width:844}}});a.render();assert.deepEqual(calls.at(-1),{x:844,animated:false});
  const resizedCount=calls.length;a.find("final-community-pager").props.onContentSizeChange(780);assert.equal(calls.length,resizedCount);a.find("final-community-pager").props.onContentSizeChange(1688);assert.deepEqual(calls.at(-1),{x:844,animated:false});
  a.find("final-parent-Ray").props.onPress();a.render();assert.equal(a.state.person,"Ray");assert.equal(a.state.screen,"chat");a.back();a.render();assert.equal(a.state.page,1);assert.deepEqual(calls.at(-1),{x:844,animated:false});
  assert.ok(calls.every(c=>c.y===undefined),"Never auto-scroll a card vertically to hide an overflowing layout");
 }
});
function pagerUI(initial="inbox",locale="en",platform="ios"){
 const a=ui(locale,{effects:true,focus:true,uiState:initial,realTranslations:true,platform}),calls=[];a.render();const ref=a.find("final-community-pager")?.props.ref;assert.ok(ref,"The actual shared pager must exist even for a direct expanded entry");ref.current={scrollTo:args=>calls.push(args)};
 const layout=(width,height=623)=>{a.find("final-community-pager-viewport").props.onLayout({nativeEvent:{layout:{width}}});a.render();a.find("final-community-pager").props.onLayout({nativeEvent:{layout:{width,height}}});a.render();a.find("final-community-pager").props.onContentSizeChange(width*2,height);};
 layout(390);return{a,calls,ref,layout};
}
function pagerEnd(a,x,width=390,handler=a.find("final-community-pager").props.onMomentumScrollEnd){handler({nativeEvent:{contentOffset:{x,y:0},layoutMeasurement:{width,height:623},contentSize:{width:width*2,height:623}}});a.render();}
function hostPath(node,id,path=[]){
 if(!node||typeof node!=="object")return;
 if(Array.isArray(node)){for(const[index,child]of node.entries()){const found=hostPath(child,id,[...path,{index}]);if(found)return found;}return;}
 const here=[...path,{type:typeof node.type==="function"?node.type.name:node.type,key:node.key??null}];return node.props?.testID===id?here:hostPath(node.props?.children,id,here);
}
test("direct hub/Friends/expanded inbox mount the same real two-page horizontal pager with one interactive dot pair",()=>{
 for(const initial of ["hub","friends","inbox"]){const{a,calls}=pagerUI(initial);assert.equal(a.state.page,initial==="hub"?0:1);assert.equal(a.state.inboxExpanded,initial==="inbox");assert.deepEqual(calls.at(-1),{x:initial==="hub"?0:390,animated:false});const outer=a.find("final-community-pager"),all=walk(a.tree);assert.equal(outer.type,"ScrollView");assert.equal(outer.props.horizontal,true);assert.equal(outer.props.pagingEnabled,true);assert.equal(outer.props.directionalLockEnabled,true);assert.equal(all.filter(n=>n.type==="ScrollView"&&n.props.horizontal).length,1);for(const index of [0,1])assert.ok(walk(outer).includes(a.find(`final-community-page-${index}`)));assert.equal(all.filter(n=>n.props?.testID==="final-community-dots-art").length,1);for(const index of [0,1])assert.equal(all.filter(n=>n.props?.testID===`final-community-dot-${index}`).length,1);assert.equal(a.find(`final-community-dot-${a.state.page}`).props.accessibilityState.selected,true);if(initial==="inbox")assert.ok(walk(a.find("final-community-page-1")).includes(a.find("final-inbox-scroll")));a.unmount();}
});
test("actual inbox expansion/swipes/dots/collapse preserve the outer pager host while only the right-page vertical body changes",()=>{
 for(const locale of ["zh-CN","zh-TW","en"]){const{a,calls,ref}=pagerUI("friends",locale),path=hostPath(a.tree,"final-community-pager"),oldRight=walk(a.find("final-community-page-1")).find(n=>n.type==="ScrollView");a.find("final-open-inbox").props.onPress();a.render();assert.equal(a.state.screen,"inbox");assert.equal(a.state.page,1);assert.equal(a.state.inboxExpanded,true);assert.deepEqual(a.state.history,[]);assert.equal(a.find("final-community-pager").props.ref,ref);assert.deepEqual(hostPath(a.tree,"final-community-pager"),path);const list=a.find("final-inbox-scroll");assert.ok(list);assert.ok(walk(a.find("final-community-page-1")).includes(list));assert.equal(list.props.horizontal,undefined);assert.equal(list.props.nestedScrollEnabled,true);assert.equal(list.props.directionalLockEnabled,true);assert.equal(list.props.keyboardShouldPersistTaps,"handled");assert.notEqual(list.key,oldRight.key,"Only the collapsed/expanded vertical body resets its own scroll identity");for(const p of ["Maya","Ray","Dean","Robin","Maria","Zoe"])assert.ok(walk(list).some(n=>n.props?.testID==="final-parent-"+p));
  pagerEnd(a,0);assert.equal(a.state.screen,"hub");assert.equal(a.state.inboxExpanded,true);assert.equal(a.find("final-community-dot-0").props.accessibilityState.selected,true);assert.equal(a.find("final-community-pager").props.ref,ref);assert.deepEqual(hostPath(a.tree,"final-community-pager"),path);a.find("final-community-dot-1").props.onPress();a.render();assert.equal(a.state.screen,"inbox");assert.equal(a.state.page,1);assert.ok(a.find("final-inbox-scroll"));assert.deepEqual(calls.at(-1),{x:390,animated:false});
  a.find("final-collapse-inbox").props.onPress();a.render();assert.equal(a.state.screen,"friends");assert.equal(a.state.page,1);assert.equal(a.state.inboxExpanded,false);assert.equal(a.find("final-inbox-scroll"),undefined);assert.ok(a.find("final-open-inbox"));assert.equal(a.find("final-community-pager").props.ref,ref);assert.deepEqual(hostPath(a.tree,"final-community-pager"),path);pagerEnd(a,0);pagerEnd(a,390);assert.equal(a.state.screen,"friends");assert.equal(a.state.inboxExpanded,false);assert.deepEqual(a.state.ai,{});assert.deepEqual(a.state.messages,[]);assertNoExtraCommunityCopy(a,locale,`${locale}/pager-round-trip`);assert.ok(calls.every(call=>call.y===undefined),"The horizontal pager must not write a vertical list offset");a.unmount();
 }
});
test("expanded parent-chat header Back and contacts Back restore the actual inbox, selected right dot and horizontal alignment",()=>{
 for(const destination of ["chat","contacts"]){const{a,calls}=pagerUI();const baseline=structuredClone({questions:a.state.questions,incoming:a.state.incoming,messages:a.state.messages,ai:a.state.ai});if(destination==="chat"){a.find("final-parent-Ray").props.onPress();a.render();assert.equal(a.state.screen,"chat");assert.equal(a.state.person,"Ray");const header=walk(a.tree).find(n=>typeof n.type==="function"&&n.type.name==="ParentChatHeader");assert.ok(header);header.props.onBack();}else{const contact=walk(a.find("final-inbox-scroll")).find(n=>n.type==="Pressable"&&n.props.accessibilityLabel==="Address book");assert.ok(contact);contact.props.onPress();a.render();assert.equal(a.state.screen,"contacts");const back=walk(a.tree).find(n=>n.type==="IconAction"&&n.props.name==="back");assert.ok(back);back.props.onPress();}a.render();assert.equal(a.state.screen,"inbox");assert.equal(a.state.page,1);assert.equal(a.state.inboxExpanded,true);assert.deepEqual(a.state.history,[]);assert.ok(a.find("final-inbox-scroll"));assert.equal(a.find("final-community-dot-1").props.accessibilityState.selected,true);a.find("final-community-pager").props.onContentSizeChange(780,623);assert.deepEqual(calls.at(-1),{x:390,animated:false});for(const key of Object.keys(baseline))assert.deepEqual(a.state[key],baseline[key]);a.unmount();}
});
test("expanded inbox rotation ignores obsolete content widths and realignment stays on the selected page",()=>{
 const{a,calls,layout}=pagerUI();for(const width of [844,320,390]){layout(width);assert.equal(a.state.screen,"inbox");assert.equal(a.state.page,1);assert.deepEqual(calls.at(-1),{x:width,animated:false});const count=calls.length;for(const old of [1,2,...[390,844,320].filter(value=>value!==width).map(value=>value*2)])a.find("final-community-pager").props.onContentSizeChange(old,623);assert.equal(calls.length,count);a.find("final-community-pager").props.onContentSizeChange(width*2,623);assert.deepEqual(calls.at(-1),{x:width,animated:false});pagerEnd(a,0,width);assert.equal(a.state.screen,"hub");layout(width);assert.deepEqual(calls.at(-1),{x:0,animated:false});pagerEnd(a,width,width);assert.equal(a.state.screen,"inbox");assert.equal(a.state.inboxExpanded,true);}assert.ok(calls.every(call=>call.y===undefined));a.unmount();
});
test("web onScroll settles real schema endpoints only after direct-entry/dot/rotation alignment and cannot collapse inbox",()=>{
 const{a,layout}=pagerUI("inbox","en","web"),event=(x,width=390)=>({nativeEvent:{contentOffset:{x,y:0},layoutMeasurement:{width,height:623},contentSize:{width:width*2,height:623}}});let pager=a.find("final-community-pager").props;assert.equal(typeof pager.onScroll,"function");assert.equal(pager.scrollEventThrottle,16);assert.equal(pager.onScroll,pager.onMomentumScrollEnd);const initial=a.state,writes=a.writes;
 pager.onScroll(event(0));pager.onScroll(event(195));pager.onScroll({nativeEvent:{contentOffset:{x:0}}});assert.equal(a.state,initial,"Direct inbox must ignore the browser's pre-alignment default x0");assert.equal(a.writes,writes);pager.onScroll(event(390));assert.equal(a.state,initial);assert.equal(a.writes,writes,"Observing the requested initial right offset is alignment, not navigation");pager.onScroll(event(.5));a.render();assert.equal(a.state.screen,"hub");assert.equal(a.state.page,0);assert.equal(a.state.inboxExpanded,true);
 a.find("final-community-dot-1").props.onPress();a.render();pager=a.find("final-community-pager").props;const requested=a.state,requestedWrites=a.writes;pager.onScroll(event(0));assert.equal(a.state,requested);assert.equal(a.writes,requestedWrites);pager.onScroll(event(390));assert.equal(a.state.screen,"inbox");assert.equal(a.state.inboxExpanded,true);const old=pager;layout(844);pager=a.find("final-community-pager").props;const rotated=a.state,rotatedWrites=a.writes;old.onScroll(event(0));pager.onScroll(event(0,390));pager.onScroll(event(0,844));assert.equal(a.state,rotated);assert.equal(a.writes,rotatedWrites);pager.onScroll(event(844,844));pager.onScroll(event(844*.4,844));assert.equal(a.state,rotated);pager.onScroll(event(0,844));a.render();assert.equal(a.state.screen,"hub");assert.equal(a.state.inboxExpanded,true);a.find("final-community-dot-1").props.onPress();a.render();assert.equal(a.state.screen,"inbox");assert.ok(a.find("final-inbox-scroll"));assert.deepEqual(a.state.ai,{});assert.deepEqual(a.state.messages,[]);a.unmount();
});
test("late pager geometry from an old width, host or non-pager route never dispatches over current state",()=>{
 const{a,calls,layout,ref}=pagerUI(),old=a.find("final-community-pager").props;layout(844);const current=a.find("final-community-pager").props,state=a.state,writeCount=a.writes,scrollCount=calls.length,event=(x,width)=>({nativeEvent:{contentOffset:{x,y:0},layoutMeasurement:{width,height:623},contentSize:{width:width*2,height:623}}});
 old.onMomentumScrollEnd(event(0,390));old.onContentSizeChange(780,623);current.onMomentumScrollEnd(event(0,390));assert.equal(a.state,state);assert.equal(a.writes,writeCount);assert.equal(calls.length,scrollCount);
 for(const x of [NaN,Infinity,-Infinity,-10000,844*3,844*.3])current.onMomentumScrollEnd(event(x,844));for(const width of [NaN,Infinity,0,-844])current.onMomentumScrollEnd(event(0,width));assert.equal(a.state,state,"Invalid or not-yet-landed offsets are not page choices");assert.equal(a.writes,writeCount);
 const host=ref.current;ref.current={scrollTo:args=>calls.push(args)};current.onMomentumScrollEnd(event(0,844));current.onContentSizeChange(1688,623);assert.equal(a.state,state,"A previous host's saved callbacks cannot steer its replacement");assert.equal(calls.length,scrollCount);ref.current=host;
 a.find("final-parent-Ray").props.onPress();a.render();const chatState=a.state,chatWrites=a.writes;current.onMomentumScrollEnd(event(0,844));current.onContentSizeChange(1688,623);assert.equal(a.state,chatState);assert.equal(a.writes,chatWrites);assert.equal(a.state.screen,"chat");assert.equal(calls.length,scrollCount);
 a.unmount();const unmountedWrites=a.writes;current.onMomentumScrollEnd(event(0,844));current.onContentSizeChange(1688,623);assert.equal(a.writes,unmountedWrites);assert.equal(calls.length,scrollCount);
 const fresh=pagerUI();const callback=fresh.a.find("final-community-pager").props,unmountedState=fresh.a.state;fresh.a.unmount();const writes=fresh.a.writes,count=fresh.calls.length;assert.equal(fresh.ref.current,null,"Fixture detaches the actual rendered native ref on unmount");callback.onMomentumScrollEnd(event(0,390));callback.onContentSizeChange(780,623);assert.equal(fresh.a.state,unmountedState);assert.equal(fresh.a.writes,writes);assert.equal(fresh.calls.length,count);
});
test("same-size chat Back can attach a fresh pager after render and current callbacks still align/settle while old-host callbacks stay inert",()=>{
 for(const platform of ["ios","web"]){const{a,calls,ref}=pagerUI("inbox","en",platform),event=x=>({nativeEvent:{contentOffset:{x,y:0},layoutMeasurement:{width:390,height:623},contentSize:{width:780,height:623}}}),old=a.find("final-community-pager").props;if(platform==="web")old.onScroll(event(390));a.find("final-parent-Ray").props.onPress();ref.current=null;a.render();assert.equal(a.state.screen,"chat");walk(a.tree).find(n=>typeof n.type==="function"&&n.type.name==="ParentChatHeader").props.onBack();a.render();assert.equal(a.state.screen,"inbox");const current=a.find("final-community-pager").props;assert.equal(current.ref,ref);assert.equal(ref.current,null,"Same width/height return has rendered before the native host commits");const freshCalls=[];ref.current={scrollTo:args=>freshCalls.push(args)};const state=a.state,writes=a.writes,count=calls.length;
  old.onContentSizeChange(780,623);old.onMomentumScrollEnd(event(0));assert.equal(a.state,state);assert.equal(a.writes,writes);assert.equal(calls.length,count);assert.deepEqual(freshCalls,[]);current.onContentSizeChange(780,623);assert.deepEqual(freshCalls.at(-1),{x:390,animated:false},"The new render's null snapshot must lazily bind after native commit, without a size change");
  if(platform==="web"){current.onScroll(event(0));assert.equal(a.state,state,"New host default x0 cannot use the old host's alignment");current.onScroll(event(390));assert.equal(a.state,state);}current.onMomentumScrollEnd(event(0));a.render();assert.equal(a.state.screen,"hub");assert.equal(a.state.page,0);assert.equal(a.state.inboxExpanded,true);assert.deepEqual(a.state.messages,[]);assert.deepEqual(a.state.ai,{});a.unmount();
 }
});
test("a new web host cannot inherit the old host's right-page readiness before observing its own requested offset",()=>{
 const{a,ref}=pagerUI("inbox","en","web"),event=x=>({nativeEvent:{contentOffset:{x,y:0},layoutMeasurement:{width:390,height:623},contentSize:{width:780,height:623}}}),old=a.find("final-community-pager").props;old.onScroll(event(390));const freshCalls=[];ref.current={scrollTo:args=>freshCalls.push(args)};a.render();const current=a.find("final-community-pager").props,state=a.state,writes=a.writes;old.onScroll(event(0));old.onContentSizeChange(780,623);current.onScroll(event(0));assert.equal(a.state,state);assert.equal(a.writes,writes);assert.deepEqual(freshCalls,[]);current.onContentSizeChange(780,623);assert.deepEqual(freshCalls.at(-1),{x:390,animated:false});current.onScroll(event(0));assert.equal(a.state,state);current.onScroll(event(390));assert.equal(a.state,state);current.onScroll(event(0));a.render();assert.equal(a.state.screen,"hub");assert.equal(a.state.inboxExpanded,true);a.unmount();
});
test("expanded inbox search filters only its vertical rows and cannot send, navigate or overwrite fixture records",()=>{
 const{a,calls}=pagerUI(),original=structuredClone({questions:a.state.questions,incoming:a.state.incoming,messages:a.state.messages,ai:a.state.ai,filters:a.state.filters}),count=calls.length;
 const search=walk(a.find("final-inbox-scroll")).find(n=>typeof n.type==="function"&&n.type.name==="Search");assert.ok(search);const input=walk(search.type(search.props)).find(n=>n.type==="TextInput");assert.ok(input);input.props.onChangeText("ma");a.render();const list=a.find("final-inbox-scroll");for(const name of ["Maya","Maria"])assert.ok(walk(list).some(n=>n.props?.testID==="final-parent-"+name));for(const name of ["Ray","Dean","Robin","Zoe"])assert.equal(walk(list).some(n=>n.props?.testID==="final-parent-"+name),false);assert.equal(a.state.screen,"inbox");assert.equal(a.state.page,1);assert.equal(a.state.inboxExpanded,true);assert.deepEqual(a.routes,[]);assert.equal(calls.length,count);for(const key of Object.keys(original))assert.deepEqual(a.state[key],original[key]);
 pagerEnd(a,0);a.render();assert.equal(a.state.screen,"hub");a.find("final-community-dot-1").props.onPress();a.render();a.render();assert.equal(a.state.screen,"inbox");const retained=walk(a.find("final-inbox-scroll")).find(n=>typeof n.type==="function"&&n.type.name==="Search");assert.equal(retained.props.value,"ma","One pager search scope survives swiping between both pages");for(const name of ["Maya","Maria"])assert.ok(a.find("final-parent-"+name));assert.equal(a.find("final-parent-Ray"),undefined);a.unmount();
});
test("contacts/invitations have distinct search scopes and their text cannot leak into the returned expanded inbox",()=>{
 for(const destination of ["contacts","invitations"]){const{a}=pagerUI(),searchIn=tree=>walk(tree).find(n=>typeof n.type==="function"&&n.type.name==="Search"),change=(tree,value)=>{const search=searchIn(tree);assert.ok(search);walk(search.type(search.props)).find(n=>n.type==="TextInput").props.onChangeText(value);a.render();};change(a.find("final-inbox-scroll"),"ma");assert.equal(searchIn(a.find("final-inbox-scroll")).props.value,"ma");walk(a.find("final-inbox-scroll")).find(n=>n.type==="Pressable"&&n.props.accessibilityLabel==="Address book").props.onPress();a.render();a.render();assert.equal(a.state.screen,"contacts");assert.equal(searchIn(a.tree).props.value,"");if(destination==="invitations"){a.find("final-new-connections").props.onPress();a.render();a.render();assert.equal(a.state.screen,"invitations");assert.equal(searchIn(a.tree).props.value,"");}change(a.tree,destination==="contacts"?"zo":"so");assert.equal(searchIn(a.tree).props.value,destination==="contacts"?"zo":"so");walk(a.tree).find(n=>n.type==="IconAction"&&n.props.name==="back").props.onPress();a.render();a.render();if(destination==="invitations"){assert.equal(a.state.screen,"contacts");assert.equal(searchIn(a.tree).props.value,"");walk(a.tree).find(n=>n.type==="IconAction"&&n.props.name==="back").props.onPress();a.render();a.render();}assert.equal(a.state.screen,"inbox");assert.equal(a.state.page,1);assert.equal(a.state.inboxExpanded,true);assert.equal(searchIn(a.find("final-inbox-scroll")).props.value,"");for(const name of ["Maya","Ray","Dean","Robin","Maria","Zoe"])assert.ok(a.find("final-parent-"+name));assert.deepEqual(a.state.messages,[]);assert.deepEqual(a.state.ai,{});a.unmount();}
});
test("production notification list adapter uses verified main read-only route, not demo history",()=>{
 const api=read("src/api.ts"),page=read("app/notifications/index.tsx");assert.match(api,/listNotifications:.*\/notifications\?limit=/);assert.match(page,/api\.listNotifications\(\)/);assert.doesNotMatch(page,/FlowPreview|FLOW_PREVIEW_ENABLED/);assert.match(page,/encodeURIComponent\(item.id\)/);
});
test("distance has all five Figma choices while gender still rejects out-of-range indices",()=>{
 for(const index of [0,1,2,3,4])assert.equal(reduce(create(),{type:"filter",key:"distance",index}).filters.distance,index);
 for(const index of [-1,5,1.5,NaN]){const s=create();assert.equal(reduce(s,{type:"filter",key:"distance",index}),s);}
 const s=create();assert.equal(reduce(s,{type:"filter",key:"gender",index:3}),s);
});
function filterUI(key="gender",{locale="en",trigger=[24,120,144,32],viewport=[0,0,390,844],deferTrigger=false,deferRoot=false}={}){
 const params=[],a=ui(locale,{effects:true,focus:true,uiState:"suggestions",params});a.render();
 a.measure(`final-filter-${key}`,trigger,{defer:deferTrigger});a.find(`final-filter-${key}`).props.onPress();a.render();
 assert.ok(a.find("final-filter-modal"));assert.ok(a.find("final-filter-backdrop"));
 a.measure("final-filter-modal-root",viewport,{defer:deferRoot});a.find("final-filter-modal-root").props.onLayout();a.render();
 return{a,params};
}
const suggestionIDs=a=>walk(a.tree).filter(node=>node.props?.testID?.startsWith("final-suggestion-")).map(node=>node.props.testID);
for(const key of ["gender","distance"])test(`${key} opens an immediate full-screen blocking layer and outside tap only dismisses without changing cards, filters or navigation`,()=>{
 const{a,params}=filterUI(key,{deferTrigger:true,deferRoot:true});try{
  const modal=a.find("final-filter-modal"),root=a.find("final-filter-modal-root"),backdrop=a.find("final-filter-backdrop"),state=a.state,cards=suggestionIDs(a),beforeParams=params.length;let stopped=0;
  assert.equal(modal.type,"Modal");assert.equal(modal.props.visible,true);assert.equal(modal.props.transparent,true);assert.equal(modal.props.presentationStyle,"overFullScreen");assert.equal(modal.props.statusBarTranslucent,true);assert.equal(root.props.accessibilityViewIsModal,true);assert.equal(root.props.style.flex,1);
  assert.deepEqual(backdrop.props.style,{position:"absolute",left:0,right:0,top:0,bottom:0});assert.equal(a.find("final-filter-menu"),undefined,"The blocking layer must exist even before either native measurement finishes");
  const hidden=walk(a.tree).find(node=>node.props?.importantForAccessibility==="no-hide-descendants");assert.equal(hidden.props.accessibilityElementsHidden,true);
  backdrop.props.onPress({stopPropagation:()=>stopped++});a.render();assert.equal(stopped,1);assert.equal(a.find("final-filter-modal"),undefined);assert.equal(a.state,state);assert.deepEqual(suggestionIDs(a),cards);assert.deepEqual(a.routes,[]);assert.equal(params.length,beforeParams);
  const writes=a.writes;a.resolveMeasure(0);a.resolveMeasure(1);a.render();assert.equal(a.writes,writes);assert.equal(a.find("final-filter-modal"),undefined);assert.equal(a.state,state);
 }finally{a.unmount();}
});
for(const key of ["gender","distance"])test(`${key} options preserve every original choice and select only that local filter before closing`,()=>{
 for(const locale of ["zh-CN","en"])for(let index=0;index<(key==="gender"?3:5);index++){
  const{a}=filterUI(key,{locale});try{const options=walk(a.find("final-filter-options")).filter(node=>node.props?.accessibilityRole==="radio");assert.equal(options.length,key==="gender"?3:5);for(const option of options){assert.equal(option.props.style.minHeight,44);assert.equal(option.props.accessibilityState.checked,option.props["aria-checked"]);}
   a.find(`final-filter-${key}-option-${index}`).props.onPress();a.render();assert.equal(a.state.filters[key],index);assert.equal(a.state.filters[key==="gender"?"distance":"gender"],0);assert.equal(a.state.screen,"suggestions");assert.equal(a.find("final-filter-modal"),undefined);assert.equal(a.find(`final-filter-${key}`).props.accessibilityState.expanded,false);assert.deepEqual(a.routes,[]);assert.deepEqual(a.state.ai,{});assert.deepEqual(a.state.messages,[]);
   assert.equal(suggestionIDs(a).length,key==="gender"?(index?4:8):index===1?2:8);
  }finally{a.unmount();}
 }
});
for(const key of ["gender","distance"])test(`${key} card and no-match fallback consume the first tap for dismissal and require a second tap to navigate`,()=>{
 for(const target of ["card","no-match"]){const{a,params}=filterUI(key);try{const state=a.state,before=params.length,action=target==="card"?a.find("final-suggestion-Maya").props.onPress:a.buttons().find(node=>node.props.label==="Preview no-match state").props.onPress;
   action();a.render();assert.equal(a.state,state);assert.equal(a.find("final-filter-modal"),undefined);assert.equal(params.length,before);assert.deepEqual(a.routes,[]);action();a.render();assert.equal(a.state.screen,target==="card"?"parent":"noMatches");assert.ok(params.length>before);
  }finally{a.unmount();}}
});
for(const key of ["gender","distance"])test(`${key} hardware back, accessibility escape and guarded header navigation first close only`,()=>{
 for(const action of ["requestClose","escape","back","profile"]){const{a,params}=filterUI(key);try{const state=a.state,before=params.length;
   if(action==="requestClose")a.find("final-filter-modal").props.onRequestClose();else if(action==="escape")a.find("final-filter-modal-root").props.onAccessibilityEscape();else assert.equal(a.navigate(action),true);
   a.render();assert.equal(a.state,state);assert.equal(a.find("final-filter-modal"),undefined);assert.deepEqual(a.routes,[]);assert.equal(params.length,before);
   if(action==="back"||action==="profile"){assert.equal(a.navigate(action),true);assert.deepEqual(a.routes,[{type:action==="back"?"dismissTo":"navigate",href:action==="back"?"/(tabs)":"/(tabs)/profile"}]);}
  }finally{a.unmount();}}
});
test("filter menu uses window measurements minus the actual Modal origin, preserves144pt width on320pt screens and stays scroll-bounded",()=>{
 for(const[key,trigger,viewport]of [["gender",[32,120,144,32],[5,44,390,800]],["distance",[176,120,130.56,32],[0,20,320,568]],["distance",[800,330,144,32],[0,0,844,390]],["distance",[260,160,130.56,32],[0,0,320,180]]]){
  const{a}=filterUI(key,{trigger,viewport});try{const menu=a.find("final-filter-menu"),wrapper=walk(a.tree).find(node=>node.props?.children===menu),style=wrapper.props.style,scroll=a.find("final-filter-options"),rawTop=trigger[1]+trigger[3]+8-viewport[1];
   assert.equal(style.width,144);assert.equal(style.left,Math.max(12,Math.min(trigger[0]-viewport[0],viewport[2]-144-12)));assert.equal(style.top,Math.max(12,Math.min(rawTop,viewport[3]-64)));assert.ok(style.left>=12);assert.ok(style.left+style.width<=viewport[2]-12);assert.ok(style.top+style.height<=viewport[3]-12);assert.equal(scroll.props.style.minHeight,0);assert.equal(scroll.props.style.flex,1);assert.equal(scroll.props.keyboardShouldPersistTaps,"handled");
   if(viewport[3]===180)assert.equal(style.height,52,"Short space scrolls all five choices instead of drawing below the Modal");
  }finally{a.unmount();}
 }
});
for(const key of ["gender","distance"])test(`${key} delayed trigger and Modal measurements are inert after close, blur, screen change or unmount`,()=>{
 for(const boundary of ["outside","back","blur","screen","unmount","other-trigger"]){const{a}=filterUI(key,{deferTrigger:true,deferRoot:true});let stopped=0;try{
   if(boundary==="outside")a.find("final-filter-backdrop").props.onPress({stopPropagation:()=>stopped++});else if(boundary==="back")a.find("final-filter-modal").props.onRequestClose();else if(boundary==="blur")a.blur();else if(boundary==="screen"){a.show("profileSettings");a.render();}else if(boundary==="unmount")a.unmount();else a.find(`final-filter-${key==="gender"?"distance":"gender"}`).props.onPress();
   const state=a.state,writes=a.writes,measureCount=a.measurements.length;a.resolveMeasure(0);a.resolveMeasure(1);assert.equal(a.writes,writes,`${boundary} must reject stale native callbacks before setState`);assert.equal(a.state,state);assert.equal(a.measurements.length,measureCount);assert.deepEqual(a.routes,[]);
   if(boundary!=="unmount"){a.render();assert.equal(a.find("final-filter-modal"),undefined);}if(boundary==="outside")assert.equal(stopped,1);
   if(boundary==="blur"){assert.equal(a.navigate("profile"),false,"Focus cleanup unregisters the actual navigation guard");a.focus();a.render();assert.equal(a.find("final-filter-modal"),undefined);}
  }finally{a.unmount();}}
});
test("old filter options, dismiss handlers and measurements cannot select or close a newer menu, including same-key reopen",()=>{
 for(const nextKey of ["gender","distance"]){const{a}=filterUI("gender");try{const oldOption=a.find("final-filter-gender-option-2").props.onPress,oldBackdrop=a.find("final-filter-backdrop").props.onPress,oldClose=a.find("final-filter-modal").props.onRequestClose,oldLayout=a.find("final-filter-modal-root").props.onLayout;
   a.measure("final-filter-modal-root",[0,0,390,844],{defer:true});oldLayout();const oldRootIndex=a.measurements.length-1;
   oldClose();a.render();a.measure(`final-filter-${nextKey}`,[176,120,144,32],{defer:true});a.find(`final-filter-${nextKey}`).props.onPress();a.render();const newTriggerIndex=a.measurements.length-1;a.measure("final-filter-modal-root",[0,0,390,844],{defer:true});a.find("final-filter-modal-root").props.onLayout();const newRootIndex=a.measurements.length-1;
   const state=a.state,writes=a.writes;let stopped=0;oldOption();oldBackdrop({stopPropagation:()=>stopped++});oldClose();oldLayout();a.resolveMeasure(oldRootIndex);assert.equal(a.writes,writes);assert.equal(a.state,state);assert.equal(stopped,1);a.render();assert.ok(a.find("final-filter-modal"));assert.equal(a.find("final-filter-menu"),undefined);
   a.resolveMeasure(newRootIndex);a.render();assert.equal(a.find("final-filter-menu"),undefined);a.resolveMeasure(newTriggerIndex);a.render();assert.ok(a.find(`final-filter-${nextKey}-option-0`));assert.deepEqual(a.state.filters,{gender:0,distance:0});assert.deepEqual(a.routes,[]);
  }finally{a.unmount();}}
});
test("missing or invalid native measurements fail closed and a changed Modal viewport dismisses instead of keeping an obsolete anchor",()=>{
 const missing=ui("en",{effects:true,focus:true,uiState:"suggestions"});try{missing.render();missing.find("final-filter-gender").props.onPress();missing.render();assert.equal(missing.find("final-filter-modal"),undefined);}finally{missing.unmount();}
 for(const target of ["trigger","root"])for(const bounds of [[0,0,0,32],[0,0,144,0],[NaN,0,144,32],[0,Infinity,144,32]]){const a=ui("en",{effects:true,focus:true,uiState:"suggestions"});try{a.render();a.measure("final-filter-gender",target==="trigger"?bounds:[24,120,144,32]);a.find("final-filter-gender").props.onPress();a.render();if(target==="root"){a.measure("final-filter-modal-root",bounds);a.find("final-filter-modal-root").props.onLayout();a.render();}assert.equal(a.find("final-filter-modal"),undefined);assert.deepEqual(a.state.filters,{gender:0,distance:0});assert.deepEqual(a.routes,[]);}finally{a.unmount();}}
 const{a}=filterUI("distance");try{a.measure("final-filter-modal-root",[0,0,844,390]);a.find("final-filter-modal-root").props.onLayout();a.render();assert.equal(a.find("final-filter-modal"),undefined);assert.deepEqual(a.state.filters,{gender:0,distance:0});}finally{a.unmount();}
});
test("outbound invitations stay pending; only explicitly accepting an incoming invitation connects",()=>{
 let s=step(create(),{type:"person",person:"Sonya",screen:"parent"},{type:"connect"});assert.equal(s.screen,"inviteSent");assert.ok(s.sentInvitations.includes("Sonya"));assert.ok(!s.contacts.includes("Sonya"));
 s=step(s,{type:"person",person:"Sonya",screen:"incomingParent"},{type:"connect"});assert.equal(s.screen,"connected");assert.ok(s.contacts.includes("Sonya"));assert.ok(!s.receivedInvitations.includes("Sonya"));
 const a=step(create(),{type:"person",person:"Robin",screen:"incomingParent"},{type:"declineInvitation"});assert.ok(!a.receivedInvitations.includes("Robin"));assert.ok(!a.contacts.includes("Robin"));assert.equal(a.screen,"invitations");
 assert.deepEqual(create().receivedInvitations,["Sonya","Robin"],"No persistence or real service mutation");
});
test("global send returns to both experiences; anonymous and named threads never mix",()=>{
 const questionID="sample-daycare";let s=create("replies");
 s=step(s,{type:"replyTarget",target:"anonymous"},{type:"draft",slot:`comment:${questionID}:anonymous`,text:"Anonymous-only"},{type:"sendComment"});assert.equal(s.screen,"comments");assert.equal(s.replyTarget,"anonymous");
 s=step(s,{type:"go",screen:"replies"},{type:"replyTarget",target:"all",expanded:true},{type:"draft",slot:`comment:${questionID}:all`,text:"Everyone"},{type:"sendComment"});assert.equal(s.screen,"replies");assert.equal(s.replyTarget,"all");assert.equal(s.comments.length,2);
 const a=ui();a.render();a.state.comments.push({questionID,target:"Maya",text:"Named-private"},{questionID,target:"anonymous",text:"Anon-private"},{questionID,target:"all",text:"Global-comment"});a.show("replies");let texts=walk(a.render()).filter(n=>n.type==="FinalText").map(n=>n.props.children);assert.ok(texts.includes("Global-comment"));assert.ok(!texts.includes("Named-private"));assert.ok(!texts.includes("Anon-private"));
 a.find("final-reply-anonymous").props.onPress();texts=walk(a.render()).filter(n=>n.type==="FinalText").map(n=>n.props.children);assert.ok(texts.includes("Anon-private"));assert.ok(!texts.includes("Named-private"));assert.ok(!texts.includes("Global-comment"));
});
test("received question opens Nuri prompt before an editable local experience composer",()=>{
 const a=ui("en",{uiState:"received"});a.render();a.find("final-open-received-waiting-0").props.onPress();a.render();assert.equal(a.state.screen,"responsePrompt");assert.ok(a.find("final-share-experience"));assert.equal(a.find("final-send-experience"),undefined);
 a.find("final-share-experience").props.onPress();a.render();assert.equal(a.state.screen,"respond");assert.equal(a.find("final-experience-editor").props.style.height,145);assert.ok(a.find("final-input-answer:received-waiting-0"));assert.equal(a.state.incoming[0].status,"waiting");
});
test("question version controls preserve exact176/80 editor geometry and original16pt radios",()=>{
 const a=ui();a.render();a.find("final-hub-primary-0").props.onPress();a.render();a.find("final-question-input").props.onChangeText("The same editable draft");a.render();
 a.find("final-refine-question").props.onPress();let tree=a.render();assert.equal(a.state.questionVersion,"polished");assert.equal(a.state.drafts.polished,"The same editable draft");
 assert.equal(a.find("final-question-input").props.style.height,122);assert.equal(a.find("final-polished-input").props.style.height,78);
 for(const id of ["final-question-original","final-question-version"]){const r=a.find(id);assert.equal(r.props.style.width,44);assert.equal(r.props.style.height,44);const icon=walk(r).find(n=>n.type==="Image");assert.deepEqual(icon.props.style,{width:16,height:16});}
 assert.ok(walk(tree).some(n=>n.props?.style?.height===176));assert.ok(walk(tree).some(n=>n.props?.style?.height===80));
});
test("question field focus hides only the bottom preview action without replacing inputs, drafts or the scrollable card",()=>{
 for(const locale of ["zh-CN","zh-TW","en"])for(const screen of ["compose","original","polished"]){
  const a=ui(locale,{uiState:screen,focus:true,effects:true,realTranslations:true});a.render();
  const ids=screen==="compose"?["final-question-input"]:["final-question-input","final-polished-input"];
  for(const id of ids)a.find(id).props.onChangeText(id+"\n甲乙，保留全文。");
  a.render();
  for(const id of ids){
   const input=a.find(id),path=hostPath(a.tree,id),props=input.props,state=a.state,disabled=a.find("final-preview-question").props.disabled;
   input.props.onFocus();a.render();assert.equal(a.find("final-preview-question"),undefined,locale+"/"+screen+"/"+id);assert.equal(a.state,state,"Focus is presentation-only");
   const focused=a.find(id);assert.equal(focused.type,input.type);assert.equal(focused.key,input.key);assert.equal(focused.props.ref,props.ref);assert.deepEqual(hostPath(a.tree,id),path);assert.deepEqual(focused.props.style,props.style);assert.equal(focused.props.value,props.value);assert.equal(focused.props.multiline,true);
   const card=a.find("final-community-"+screen),scroll=walk(card).find(n=>n.type==="ScrollView");assert.ok(scroll);assert.equal(scroll.props.keyboardShouldPersistTaps,"handled");assert.equal(scroll.props.keyboardDismissMode,"interactive");assert.ok(walk(scroll).includes(focused));for(const control of ["final-question-showAge","final-question-anonymous"])assert.ok(walk(scroll).includes(a.find(control)),"Privacy controls stay in the scrollable card");if(screen==="compose")assert.ok(walk(scroll).includes(a.find("final-refine-question")));
   assert.ok(walk(card).some(n=>n.props?.style?.height===176));if(screen!=="compose")assert.ok(walk(card).some(n=>n.props?.style?.height===80));
   focused.props.onBlur();a.render();assert.ok(a.find("final-preview-question"));assert.equal(a.find("final-preview-question").props.disabled,disabled);assert.equal(a.state,state);assert.deepEqual(hostPath(a.tree,id),path);assert.deepEqual(a.find(id).props.style,props.style);assert.equal(a.find(id).props.value,props.value);
  }
  a.unmount();
 }
});
test("switching between original and polished inputs ignores the earlier field blur and retains both controlled drafts",()=>{
 for(const screen of ["original","polished"]){
  const a=ui("en",{uiState:screen,focus:true,effects:true});a.render();a.find("final-question-input").props.onChangeText("Original draft\n甲");a.find("final-polished-input").props.onChangeText("Polished draft\n乙");a.render();
  const original=a.find("final-question-input"),polished=a.find("final-polished-input"),state=a.state;
  original.props.onFocus();a.render();polished.props.onFocus();original.props.onBlur();a.render();assert.equal(a.find("final-preview-question"),undefined,"A late blur from the previous field cannot reveal the bottom action");assert.equal(a.state,state);assert.equal(a.find("final-question-input").props.value,"Original draft\n甲");assert.equal(a.find("final-polished-input").props.value,"Polished draft\n乙");
  a.find("final-polished-input").props.onBlur();a.render();assert.ok(a.find("final-preview-question"));assert.equal(a.state,state);a.unmount();
 }
});
test("leaving and reopening a question rejects old focus callbacks without sending or mutating question records",()=>{
 const a=ui("en",{focus:true,effects:true});a.render();const questions=structuredClone(a.state.questions);a.find("final-hub-primary-0").props.onPress();a.render();a.find("final-question-input").props.onChangeText("Unfinished first question");a.render();const old=a.find("final-question-input");old.props.onFocus();a.render();assert.equal(a.find("final-preview-question"),undefined);
 assert.equal(a.navigate("back"),true);a.render();assert.equal(a.state.screen,"hub");old.props.onFocus();old.props.onBlur();a.render();a.find("final-hub-primary-0").props.onPress();a.render();assert.ok(a.find("final-preview-question"));assert.equal(a.find("final-preview-question").props.disabled,true);
 a.find("final-question-input").props.onChangeText("New question\nkeep this exact draft");a.render();a.find("final-question-input").props.onFocus();a.render();const state=a.state;old.props.onBlur();a.render();assert.equal(a.find("final-preview-question"),undefined);a.find("final-question-input").props.onBlur();a.render();assert.ok(a.find("final-preview-question"));old.props.onFocus();a.render();assert.ok(a.find("final-preview-question"));assert.equal(a.state,state);assert.deepEqual(a.state.questions,questions);assert.equal(a.state.localReceipt,false);
 const current=a.find("final-question-input");a.unmount();const writes=a.writes;old.props.onFocus();old.props.onBlur();current.props.onFocus();current.props.onBlur();assert.equal(a.writes,writes,"Unmounted input callbacks must not set presentation state");
});
test("selection action menu closes only checked local records after confirmation",()=>{
 const a=ui("en",{uiState:"myQuestions"});a.render();a.find("final-select-questions").props.onPress();a.render();a.find("final-select-sample-daycare").props.onPress();a.render();a.find("final-question-more").props.onPress();a.render();a.find("final-question-menu-close").props.onPress();a.render();assert.equal(a.state.screen,"close");assert.equal(a.state.questions[0].closed,false);
 a.find("final-confirm-questions").props.onPress();a.render();assert.equal(a.state.screen,"myQuestions");assert.equal(a.state.questions[0].closed,true);assert.equal(a.state.questions[1].closed,false);
});
test("expanded global draft without a native keyboard retains both experiences and145pt input",()=>{
 const a=ui("en",{uiState:"replies"});a.render();a.find("final-expand-reply").props.onPress();a.render();assert.equal(a.state.screen,"replyExpanded");assert.ok(a.find("final-reply-list-scroll"));assert.ok(a.find("final-reply-Maya"));assert.ok(a.find("final-reply-anonymous"));assert.equal(a.find("final-experience-editor").props.style.height,145);
});
test("scoped original Community assets are present and retain exported SVG roots",()=>{
 const source=read("src/uiuxfinal/CommunityFinal.tsx");for(const [,asset]of source.matchAll(/require\("@\/(assets\/final-flow-20261101\/[^\"]+)"\)/g))assert.ok(statSync(asset).size>0,asset);
 for(const [file,width,height]of [["community-profile-background.svg",104,104],["community-reply-background.svg",36,36],["community-radio-selected.svg",16,16],["community-radio-empty.svg",16,16],["community-checkbox-selected.svg",20,20],["community-checkbox-empty.svg",20,20],["community-connected-pink.svg",146,146],["community-connected-purple.svg",146,146],["community-patient.svg",174,217],["community-experience-sent.svg",179,223],["community-sending-ring.svg",64,64]]){
  const root=read("assets/final-flow-20261101/"+file).match(/^<svg[^>]*>/)?.[0];assert.ok(root?.includes('width="'+width+'"')&&root.includes('height="'+height+'"'),file);
 }
 // Structural geometry / asset tests are not screenshot or native acceptance.
});
test("settings headers use actual design labels while local safety retains the selected parent context",()=>{
 for(const locale of ["zh-CN","en"])for(const [screen,zh,en,header]of [["preferences","社区偏好","Community preferences","regular"],["blockedEmpty","屏蔽的家长","Blocked parents","regular"],["blocked","屏蔽的家长","Blocked parents","blocked-list"],["profileSettings","我的档案","My profile","regular"],["parentSettings","Maya","Maya","regular"],["safetyConfirm","Maya","Maya","regular"],["replyExpanded","漂流瓶回复","Bottle replies","default"]]){
  const params=[],a=ui(locale,{uiState:screen,params,focus:true});a.render();assert.equal(params.at(-1).flowTitle,locale==="en"?en:zh);assert.equal(params.at(-1).communityHeader,header);
 }
});
test("community preference order, explanations, switches and blocked empty content follow the final source",()=>{
 const a=ui("en",{uiState:"preferences"}),tree=a.render(),group=a.find("final-community-preferences-group");
 assert.equal(group.props.style.gap,12);assert.equal(a.find("final-community-preference-discoverable").props.style.minHeight,48);
 assert.equal(a.find("final-community-preference-discoverable").props.accessibilityState.checked,true);assert.equal(a.find("final-community-preference-showAge").props.accessibilityState.checked,true);assert.equal(a.find("final-community-preference-nearby").props.accessibilityState.checked,false);a.find("final-community-preference-nearby").props.onPress();a.render();assert.equal(a.find("final-community-preference-nearby").props.accessibilityState.checked,true);assert.equal(a.state.localReceipt,false);
 const labels=walk(tree).filter(n=>n.type==="FinalText"||n.type==="SettingsRow").map(n=>n.props.label??n.props.children);
 assert.ok(labels.indexOf("Blocked parents")<labels.indexOf("Translate messages automatically"));assert.ok(labels.includes("Pause parent recommendations; existing conversations are unaffected"));
 a.find("final-open-blocked").props.onPress();const empty=a.render();assert.equal(a.state.screen,"blockedEmpty");const text=walk(empty).filter(n=>n.type==="FinalText").map(n=>n.props.children);assert.ok(text.includes("You can change your choice at any time"));assert.ok(text.includes("Unblocking does not automatically restore a friendship."));assert.ok(text.includes("No blocked parents"));assert.ok(text.includes("You can block a parent in conversation settings when needed."));
});
test("preferences opens the settings profile variant and both profile save levels preserve local controlled values",()=>{
 const params=[],a=ui("en",{uiState:"preferences",params,focus:true});a.render();a.find("final-open-profile-settings").props.onPress();let tree=a.render();assert.equal(a.state.screen,"profileSettings");assert.equal(params.at(-1).communityBackdrop,"settings");assert.ok(a.find("final-profile-settings-save"));assert.ok(a.find("final-profile-settings-intents"));assert.ok(!a.buttons().some(n=>n.props.label==="Next"));
 a.find("final-profile-edit").props.onPress();tree=a.render();let editor=walk(tree).find(n=>n.type==="CommunityProfileEditor");assert.ok(editor);editor.props.onAboutChange("Local edited introduction");editor.props.onToggleIntent(4);a.render();a.find("final-profile-save").props.onPress();tree=a.render();assert.equal(params.at(-1).communityBackdrop,"settings");assert.ok(walk(tree).some(n=>n.type==="FinalText"&&n.props.children==="Local edited introduction"));assert.ok(a.state.intents.includes(4));assert.equal(a.state.localReceipt,false);a.find("final-profile-settings-save").props.onPress();a.render();assert.equal(a.state.screen,"preferences");assert.equal(a.state.drafts["profile:about"],"Local edited introduction");
});
test("question version radios expose checked semantics and local send feedback retains one complete authored cycle",()=>{
 const a=ui("en",{uiState:"original"});a.render();assert.equal(a.find("final-question-original").props.accessibilityState.checked,true);assert.equal(a.find("final-question-version").props["aria-checked"],false);a.find("final-question-version").props.onPress();a.render();assert.equal(a.find("final-question-original").props.accessibilityState.checked,false);assert.equal(a.find("final-question-version").props["aria-checked"],true);
 const source=read("src/uiuxfinal/CommunityFinal.tsx");assert.match(source,/type: "finishSend"\s*\}\), 2400\)/);assert.match(source,/duration:\s*2400/);
});
test("question lists retain their original20pt search export without enlarging contacts or inbox icons",()=>{
 for(const [screen,size,asset]of [["myQuestions",20,"community-question-search.png"],["selection",20,"community-question-search.png"],["contacts",16,"community-search.png"],["inbox",16,"community-search.png"]]){
  const a=ui("en",{uiState:screen}),tree=a.render(),search=walk(tree).find(n=>typeof n.type==="function"&&n.type.name==="Search"),rendered=search.type(search.props),icon=walk(rendered).find(n=>n.type==="Image");assert.equal(icon.props.style.width,size);assert.equal(icon.props.style.height,size);assert.ok(icon.props.source.endsWith(asset));
 }
});
test("received Replied alone uses the approved gray bottle at the same original dimensions and diagonal transform",()=>{
 for(const [screen,status,asset,count]of [["received","waiting","community-received-bottle.svg",3],["receivedReplied","replied","community-question-bottle-gray.svg",2]]){
  const a=ui("en",{uiState:screen}),tree=a.render(),icons=walk(tree).filter(n=>n.type==="Image"&&n.props.testID?.startsWith("final-received-bottle-"));assert.equal(icons.length,count);for(const icon of icons){assert.ok(icon.props.testID.includes(status));assert.ok(icon.props.source.endsWith(asset));assert.deepEqual(icon.props.style,{width:7.875,height:16.3125,transform:[{rotate:"45deg"}]});}
 }
 const svg=read("assets/final-flow-20261101/community-question-bottle-gray.svg"),root=svg.match(/^<svg[^>]*>/)?.[0];assert.ok(root.includes('width="7.875"')&&root.includes('height="16.3125"'));assert.match(svg,/stroke="#706A74"/);
});
test("settings profile uses the source169pt first life column and22pt bottom inset without fixed total height",()=>{
 const a=ui("zh-CN",{uiState:"profileSettings"});a.render();const context=a.find("final-profile-settings-context"),column=a.find("final-profile-settings-children"),surface=a.find("final-community-profileSettings"),scroll=walk(surface).find(n=>n.type==="ScrollView"),insets=Object.assign({},...scroll.props.contentContainerStyle);
 assert.equal(context.props.style.gap,16);assert.equal(column.props.style.width,"51.2121%");assert.equal(column.props.style.maxWidth,169);assert.equal(insets.paddingTop,32);assert.equal(insets.paddingBottom,22);assert.equal(surface.props.style?.height,undefined);
 // Width402 yields330pt inner width, firstcol169, second startsx221.
 // On320 the two columns stay fluid instead of overflowing two fixed169pt slots.
 assert.ok(Math.abs(Math.min((402-72)*.512121,169)+36+16-221)<.01);assert.ok((320-72)-Math.min((320-72)*.512121,169)-16>100);
});
test("settings-only avatar hiding resets on leaving and sent feedback has no extra local disclosure",()=>{
 const params=[],a=ui("en",{uiState:"preferences",params,focus:true});a.render();assert.equal(params.at(-1).communityHideAvatar,"1");a.find("final-open-profile-settings").props.onPress();a.render();assert.equal(params.at(-1).communityHideAvatar,"0");a.back();a.render();assert.equal(params.at(-1).communityHideAvatar,"1");
 for(const screen of ["blocked","blockedEmpty"]){a.show(screen);a.render();assert.equal(params.at(-1).communityHideAvatar,"1");}a.show("hub");a.render();assert.equal(params.at(-1).communityHideAvatar,"0");a.show("sent");a.render();assert.equal(a.find("final-sent-local-disclosure"),undefined);assert.ok(visibleCopy(a.tree).includes("Sent successfully"));assert.ok(visibleCopy(a.tree).includes("Please wait for replies"));
});
test("profile editing keeps the current about draft and controlled intentions across Save",()=>{
 const params=[],a=ui("en",{uiState:"profile",params});a.render();a.find("final-profile-edit").props.onPress();assert.equal(params.at(-1).communityBackdrop,"settings");let tree=a.render(),editor=walk(tree).find(n=>n.type==="CommunityProfileEditor");assert.ok(editor);assert.ok(editor.props.about.includes("restaurant"));assert.equal(editor.props.avatar.props.size,104);
 editor.props.onAboutChange("My locally edited profile");editor.props.onToggleIntent(4);tree=a.render();editor=walk(tree).find(n=>n.type==="CommunityProfileEditor");assert.equal(editor.props.about,"My locally edited profile");assert.ok(editor.props.selectedIntents.includes(4));a.find("final-profile-save").props.onPress();assert.equal(params.at(-1).communityBackdrop,"final-bottle");tree=a.render();assert.ok(walk(tree).some(n=>n.type==="FinalText"&&n.props.children==="My locally edited profile"));assert.ok(!walk(tree).some(n=>n.type==="CommunityProfileEditor"));assert.equal(a.state.localReceipt,false);
});
