import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read=p=>readFileSync(p,"utf8");
function load(path,deps={}){
 const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const m={exports:{}};
 if(path==="src/uiuxfinal/CommunityFinal.tsx"){
  deps={...deps,"./ParentChatHeader":load("src/uiuxfinal/ParentChatHeader.tsx",{"react/jsx-runtime":deps["react/jsx-runtime"],"react-native":deps["react-native"],"expo-image":deps["expo-image"],"./Primitives":deps["./Primitives"]})};
  deps["./Primitives"]={...deps["./Primitives"],FinalChatBubble:"FinalChatBubble"};
 }
 new Function("require","module","exports",code)(name=>{if(name==="./CommunityProfileEditor")return {CommunityProfileEditor:"CommunityProfileEditor"};if(name.startsWith("@/assets/"))return name;if(name==="./communityHubLayout")return load("src/uiuxfinal/communityHubLayout.ts");if(name==="@/src/uiux48/inputLayout")return load("src/uiux48/inputLayout.ts");if(name==="@/src/uiux48/useComposerDock")return {useComposerDockInset:enabled=>enabled?46:0};assert.ok(name in deps,"Unapproved dependency "+name);return deps[name];},m,m.exports);
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
function ui(locale="en",options={}){
 let cursor=0,tree,pending=[];const hooks=[],effects=[],jsx=(type,props)=>({type,props});
 const react={useReducer:(r,arg,init)=>{const i=cursor++;hooks[i]??=init(options.uiState??arg);return[hooks[i],event=>hooks[i]=r(hooks[i],event)];},useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=initial;return[hooks[i],value=>hooks[i]=typeof value==="function"?value(hooks[i]):value];},useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},useCallback:f=>f,useEffect:(fn,deps)=>{const i=cursor++;if(options.effects&&(!effects[i]||deps.some((d,j)=>!Object.is(d,effects[i].deps[j]))))pending.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});}};
 const component=load("src/uiuxfinal/CommunityFinal.tsx",{react,"react/jsx-runtime":{jsx,jsxs:jsx},"react-native":Object.fromEntries(["ActivityIndicator","Modal","Pressable","ScrollView","Switch","TextInput","View"].map(n=>[n,n]).concat([["StyleSheet",{create:x=>x}]])),"expo-image":{Image:"Image"},"expo-blur":{BlurView:"BlurView"},"expo-router":{useFocusEffect:fn=>{if(options.focus)fn();},useLocalSearchParams:()=>({}),usePathname:()=>"/community",useRouter:()=>({setParams:p=>options.params?.push(p),navigate:()=>{},dismissTo:()=>{}})},"@/src/i18n":{useT:()=>({locale}),translate:(_locale,text)=>text},"@/src/components/nativeNavigation":{registerNativeNavigationGuard:()=>()=>{}},"@/src/uiux48/Primitives":{IconAction:"IconAction",NuriKeyboardFrame:"NuriKeyboardFrame"},"@/src/uiux48/Composer":{NuriComposer:"NuriComposer"},"@/src/uiux48/VoiceInputBar":{VoiceInputBar:"VoiceInputBar"},"./Primitives":{FinalButton:"FinalButton",FinalDivider:"FinalDivider",FinalSurface:"FinalSurface",FinalText:"FinalText",FINAL_COLOR:{accent:"#735c84"}},"./Settings":Object.fromEntries(["SettingsPage","SettingsRow","SettingsToggle","SettingsButton","SettingsSpacer","SettingsField"].map(n=>[n,n])),"./communityModel":model}).default;
 return{render(){cursor=0;pending=[];tree=component();pending.forEach(fn=>fn());return tree;},get state(){return hooks[0]},show(screen){hooks[0]={...hooks[0],screen};},back(){hooks[0]=reduce(hooks[0],{type:"back"});},find(id){return walk(tree).find(n=>n.props?.testID===id);},buttons(){return walk(tree).filter(n=>n.type==="FinalButton");}};
}
test("real TSX renders all canonical states in both languages without service/permission imports",()=>{
 for(const locale of ["zh-CN","en"])for(const screen of Object.keys(nodes)){const a=ui(locale);a.render();a.show(screen);assert.doesNotThrow(()=>a.render(),locale+screen);}
 assert.doesNotMatch(read("src/uiuxfinal/CommunityFinal.tsx"),/\bfetch\(|from ["'][^"']*(?:\/api|auth|ImagePicker|expo-audio)["']/);
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
  a.find("final-community-pager").props.onMomentumScrollEnd({nativeEvent:{contentOffset:{x:0}}});a.render();assert.equal(a.state.page,0);assert.deepEqual(calls.at(-1),{x:0,animated:false});
  a.find("final-community-dot-1").props.onPress();a.render();a.find("final-community-pager-viewport").props.onLayout({nativeEvent:{layout:{width:844}}});a.render();assert.deepEqual(calls.at(-1),{x:844,animated:false});
  const resizedCount=calls.length;a.find("final-community-pager").props.onContentSizeChange(780);assert.equal(calls.length,resizedCount);a.find("final-community-pager").props.onContentSizeChange(1688);assert.deepEqual(calls.at(-1),{x:844,animated:false});
  a.find("final-parent-Ray").props.onPress();a.render();assert.equal(a.state.person,"Ray");assert.equal(a.state.screen,"chat");a.back();a.render();assert.equal(a.state.page,1);assert.deepEqual(calls.at(-1),{x:844,animated:false});
  assert.ok(calls.every(c=>c.y===undefined),"Never auto-scroll a card vertically to hide an overflowing layout");
 }
});
test("production notification list adapter uses verified main read-only route, not demo history",()=>{
 const api=read("src/api.ts"),page=read("app/notifications/index.tsx");assert.match(api,/listNotifications:.*\/notifications\?limit=/);assert.match(page,/api\.listNotifications\(\)/);assert.doesNotMatch(page,/FlowPreview|FLOW_PREVIEW_ENABLED/);assert.match(page,/encodeURIComponent\(item.id\)/);
});
test("distance has all five Figma choices while gender still rejects out-of-range indices",()=>{
 for(const index of [0,1,2,3,4])assert.equal(reduce(create(),{type:"filter",key:"distance",index}).filters.distance,index);
 for(const index of [-1,5,1.5,NaN]){const s=create();assert.equal(reduce(s,{type:"filter",key:"distance",index}),s);}
 const s=create();assert.equal(reduce(s,{type:"filter",key:"gender",index:3}),s);
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
test("settings-only avatar hiding is explicit and resets on leaving; send disclosure does not shift main feedback",()=>{
 const params=[],a=ui("en",{uiState:"preferences",params,focus:true});a.render();assert.equal(params.at(-1).communityHideAvatar,"1");a.find("final-open-profile-settings").props.onPress();a.render();assert.equal(params.at(-1).communityHideAvatar,"0");a.back();a.render();assert.equal(params.at(-1).communityHideAvatar,"1");
 for(const screen of ["blocked","blockedEmpty"]){a.show(screen);a.render();assert.equal(params.at(-1).communityHideAvatar,"1");}a.show("hub");a.render();assert.equal(params.at(-1).communityHideAvatar,"0");a.show("sent");a.render();const note=a.find("final-sent-local-disclosure");assert.equal(note.props.style.position,"absolute");assert.equal(note.props.style.bottom,24);assert.equal(note.props.style.marginTop,undefined);
});
test("profile editing keeps the current about draft and controlled intentions across Save",()=>{
 const params=[],a=ui("en",{uiState:"profile",params});a.render();a.find("final-profile-edit").props.onPress();assert.equal(params.at(-1).communityBackdrop,"settings");let tree=a.render(),editor=walk(tree).find(n=>n.type==="CommunityProfileEditor");assert.ok(editor);assert.ok(editor.props.about.includes("restaurant"));assert.equal(editor.props.avatar.props.size,104);
 editor.props.onAboutChange("My locally edited profile");editor.props.onToggleIntent(4);tree=a.render();editor=walk(tree).find(n=>n.type==="CommunityProfileEditor");assert.equal(editor.props.about,"My locally edited profile");assert.ok(editor.props.selectedIntents.includes(4));a.find("final-profile-save").props.onPress();assert.equal(params.at(-1).communityBackdrop,"final-bottle");tree=a.render();assert.ok(walk(tree).some(n=>n.type==="FinalText"&&n.props.children==="My locally edited profile"));assert.ok(!walk(tree).some(n=>n.type==="CommunityProfileEditor"));assert.equal(a.state.localReceipt,false);
});
