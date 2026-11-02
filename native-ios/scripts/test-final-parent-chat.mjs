import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {test} from "node:test";
import ts from "typescript";
const read=p=>readFileSync(p,"utf8"),jsx=(type,props)=>({type,props}),runtime={jsx,jsxs:jsx};
const walk=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(walk):[n,...walk(n.props?.children)];
const rn=Object.fromEntries(["ActivityIndicator","Modal","Pressable","ScrollView","Switch","TextInput","View","Text"].map(n=>[n,n]).concat([["StyleSheet",{create:x=>x,absoluteFill:{position:"absolute",left:0,top:0,right:0,bottom:0}}],["Platform",{OS:"ios"}]]));
const presentation={FinalText:"FinalText",FinalChatBubble:"FinalChatBubble",FinalButton:"FinalButton",FinalDivider:"FinalDivider",FinalSurface:"FinalSurface",FINAL_COLOR:{accent:"#735C84",ink:"#4A454D",coral:"#EB8183"}};
function load(path,deps={}){
 const m={exports:{}};
 new Function("require","module","exports",ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>{
  if(name.startsWith("@/assets/"))return name;
  if(name==="./CommunityProfileEditor")return {CommunityProfileEditor:"CommunityProfileEditor"};
  if(name==="./communityHubLayout")return load("src/uiuxfinal/communityHubLayout.ts");
  if(name==="@/src/uiux48/inputLayout")return load("src/uiux48/inputLayout.ts");
  assert.ok(name in deps,"Unapproved dependency "+name);return deps[name];
 },m,m.exports);return m.exports;
}
const header=load("src/uiuxfinal/ParentChatHeader.tsx",{"react/jsx-runtime":runtime,"react-native":rn,"expo-image":{Image:"Image"},"./Primitives":presentation});
const model=load("src/uiuxfinal/communityModel.ts");
const find=(tree,id)=>walk(tree).find(n=>n.props?.testID===id);
test("one 60pt Figma header aligns status with original 44pt toggle and contains no settings/profile/flow label",()=>{
 for(const participating of [false,true])for(const status of [participating?"Nuri 参与中":"Nuri 未参与",participating?"Nuri is on":"Nuri is off"]){
  const calls=[],tree=header.ParentChatHeader({person:"A long parent name that must shrink",participating,status,backLabel:"Back",toggleHint:"Local preview; no recording",onBack:()=>calls.push("back"),onToggle:v=>calls.push(v)});
  assert.deepEqual(calls,[]);assert.deepEqual(tree.props.style,{minHeight:60,flexShrink:0,paddingLeft:12,paddingRight:24,flexDirection:"row",alignItems:"center",gap:8});
  const name=find(tree,"final-parent-name"),label=find(tree,"final-parent-ai-status"),toggle=find(tree,"final-parent-ai-toggle");
  assert.equal(name.props.style.flex,1);assert.equal(name.props.style.minWidth,0);assert.equal(name.props.numberOfLines,1);assert.equal(name.props.ellipsizeMode,"tail");
  assert.equal(label.props.style.width,72);assert.equal(label.props.style.lineHeight,18);assert.equal(label.props.style.flexShrink,0);assert.equal(label.props.children,status);
  assert.equal(toggle.props.style.width,44);assert.equal(toggle.props.style.height,44);assert.equal(toggle.props.accessibilityRole,"switch");assert.equal(toggle.props.accessibilityState.checked,participating);assert.equal(toggle.props["aria-checked"],participating);assert.match(toggle.props.accessibilityHint,/no recording/);
  const art=find(tree,"final-parent-ai-art");assert.deepEqual(art.props.style,{width:44,height:44});assert.ok(art.props.source.endsWith(participating?"parent-ai-on.svg":"parent-ai-off.svg"));
  for(const width of [320,390,402])assert.ok(width-12-24-44-32-72-44-8*4>=60,"Name slot cannot push fixed controls outside the header");
  assert.doesNotMatch(JSON.stringify(tree),/settings|profile|Flow preview|流程/);
  toggle.props.onPress();find(tree,"final-parent-back").props.onPress();assert.deepEqual(calls,[!participating,"back"]);
 }
});
test("header and message avatar assets retain their exact original export sizes and crop slots",()=>{
 for(const size of [32,40]){
  const tree=header.ParentChatAvatar({size}),images=walk(tree).filter(n=>n.type==="Image");
  assert.equal(tree.props.style.width,size);assert.equal(tree.props.style.height,size);assert.equal(images[0].props.style.width,size);assert.equal(images[0].props.style.height,size);
  assert.ok(images[0].props.source.endsWith(size===32?"parent-header-avatar-background.svg":"parent-avatar-background.svg"));
  assert.deepEqual(images[1].props.style,size===32?{position:"absolute",left:3.2,top:9.866,width:25.333,height:22.133}:{position:"absolute",left:4,top:12.332,width:31.667,height:27.667});
 }
 const hashes={"parent-ai-off.svg":"2e7482d275ed1f6adfff01b80b2f5d5ff63caab3e416c4e7038482d5558543a2","parent-ai-on.svg":"009bba4b7447da6e9e64b24375fed28a2aa2a8012fe50e51fd27cec96aa95dde","parent-header-avatar-background.svg":"170e5fd024c3c42cab02a1636eca08231fcdff89ba9f9319c4cd4ab9a4af310f","parent-header-back.svg":"7d66e2af0a611377e58920bfd0644a7c46256e9002e48f147ac5afec8e36444d","parent-header-avatar.png":"cd057472ca358a020195416424b712bc6a75e05cacd07ed156e944336f6660bf"};
 for(const [file,hash]of Object.entries(hashes))assert.equal(createHash("sha256").update(readFileSync("assets/final-flow-20261101/"+file)).digest("hex"),hash);
 for(const file of ["parent-ai-on.svg","parent-ai-off.svg"])assert.match(read("assets/final-flow-20261101/"+file).slice(0,220),/width="44" height="44" viewBox="0 0 44 44"/);
});
function community(locale="zh-CN",initial="chat"){
 let cursor=0,pending=[],tree;const slots=[],effects=[],params=[],routes=[];
 const react={useReducer:(r,arg,init)=>{const i=cursor++;slots[i]??=init(initial??arg);return[slots[i],e=>slots[i]=r(slots[i],e)];},useState:v=>{const i=cursor++;if(!(i in slots))slots[i]=v;return[slots[i],v=>slots[i]=typeof v==="function"?v(slots[i]):v];},useRef:v=>{const i=cursor++;return slots[i]??={current:v};},useCallback:f=>f,useEffect:(fn,deps)=>{const i=cursor++;if(!effects[i]||deps.some((d,j)=>!Object.is(d,effects[i].deps[j])))pending.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});}};
 const C=load("src/uiuxfinal/CommunityFinal.tsx",{react,"react/jsx-runtime":runtime,"react-native":rn,"expo-image":{Image:"Image"},"expo-blur":{BlurView:"Blur"},"expo-router":{useFocusEffect:fn=>pending.push(fn),useLocalSearchParams:()=>({uiState:initial}),usePathname:()=>"/community",useRouter:()=>({setParams:p=>params.push(p),navigate:r=>routes.push(r),dismissTo:r=>routes.push(r)})},"@/src/i18n":{useT:()=>({locale}),translate:(_l,s)=>s},"@/src/components/nativeNavigation":{registerNativeNavigationGuard:()=>()=>{}},"@/src/uiux48/Primitives":{IconAction:"IconAction",NuriKeyboardFrame:"Frame"},"@/src/uiux48/Composer":{NuriComposer:"Composer"},"@/src/uiux48/useComposerDock":{useComposerDockInset:enabled=>enabled?46:0},"@/src/uiux48/VoiceInputBar":{VoiceInputBar:"Voice"},"./Primitives":presentation,"./ParentChatHeader":header,"./Settings":Object.fromEntries(["SettingsPage","SettingsRow","SettingsToggle","SettingsButton","SettingsSpacer","SettingsField"].map(n=>[n,n])),"./communityModel":model}).default;
 return {render(){cursor=0;pending=[];tree=C();pending.splice(0).forEach(fn=>fn());return tree;},find:id=>find(tree,id),get head(){return walk(tree).find(n=>n.type===header.ParentChatHeader)},get tree(){return tree},get state(){return slots[0]},params,routes,show(screen){slots[0]=model.finalCommunityReducer(slots[0],{type:"go",screen});}};
}
test("actual parent TSX removes both legacy rows, uses five original role bubbles and never sends on navigation",()=>{
 for(const locale of ["zh-CN","zh-TW","en"])for(const initial of ["chat","chatOn","consent"]){
  const a=community(locale,initial),tree=a.render(),all=walk(tree);
  assert.ok(a.head);assert.equal(a.params.at(-1).communityHeader,"parent-chat");assert.equal(a.params.at(-1).communityHideTabs,"1");
  assert.equal(all.some(n=>typeof n.type==="function"&&n.type.name==="DemoLabel"),false);assert.equal(a.find("final-parent-settings"),undefined);
  assert.doesNotMatch(JSON.stringify(tree),/流程|Flow preview|Consent-flow/);assert.deepEqual(a.state.messages,[]);assert.deepEqual(a.state.ai,{});
  for(let i=0;i<5;i++){
   const row=a.find("final-parent-message-"+i),bubble=walk(row).find(n=>n.type==="FinalChatBubble");
   assert.ok(row);assert.ok(walk(row).some(n=>n.type===header.ParentChatAvatar));assert.equal(row.props.style.gap,8);
   assert.equal(row.props.style.alignItems,i%2?"flex-end":"flex-start");assert.equal(bubble.props.incoming,i%2===0);assert.equal(bubble.props.style.maxWidth,i%2?258:306);
  }
  a.show("friends");a.render();assert.equal(a.params.at(-1).communityHeader,"default");assert.equal(a.params.at(-1).communityHideTabs,"0");assert.equal(a.head,undefined);
 }
});
test("actual header toggle still requires consent, decline stays off, agreement enables only local state, and back restores hub",()=>{
 const a=community("en","friends");a.render();a.find("final-parent-Maya").props.onPress();assert.equal(a.params.at(-1).communityHeader,"parent-chat","Shell mode changes in the event batch, before render/effects");assert.equal(a.params.at(-1).communityBackdrop,"plain");a.render();assert.equal(a.state.screen,"chat");assert.equal(a.head.props.participating,false);
 a.head.props.onToggle(true);a.render();assert.equal(a.state.screen,"consent");assert.equal(a.head.props.participating,false);assert.deepEqual(a.state.ai,{});
 const decline=walk(a.tree).find(n=>n.type==="FinalButton"&&n.props.label==="Not now");decline.props.onPress();a.render();assert.equal(a.state.ai.Maya,false);
 a.head.props.onToggle(true);a.render();a.find("final-parent-consent-agree").props.onPress();a.render();assert.equal(a.head.props.participating,true);assert.equal(a.head.props.status,"Nuri is on");
 a.head.props.onToggle(false);a.render();assert.equal(a.head.props.participating,false);a.head.props.onBack();assert.equal(a.params.at(-1).communityHeader,"default","Return restores header before render/effects");assert.equal(a.params.at(-1).flowTitle,"Community");a.render();assert.equal(a.state.screen,"friends");assert.equal(a.params.at(-1).communityHeader,"default");
 const direct=community();direct.render();direct.head.props.onBack();assert.deepEqual(direct.routes,["/(tabs)"]);
});
test("shared native controls yield only to parent prototype header and explicitly restore after a stale direct-link uiState",()=>{
 const previous=process.env.EXPO_PUBLIC_FLOW_PROTOTYPE;
 const cases=[{uiState:"chat"},{uiState:"chat",communityHeader:"default"},{communityHeader:"parent-chat"},{communityHeader:"feedback"},{uiState:"friends"},{uiState:"profileSettings"}].map(params=>({params,avatar:true}));
 for(const uiState of ["preferences","blocked","blockedEmpty"]){
  cases.push({params:{uiState},avatar:false},{params:{uiState,communityHideAvatar:"1"},avatar:false},{params:{uiState,communityHideAvatar:"0",communityHeader:"default"},avatar:true});
 }
 cases.push({params:{uiState:"profileSettings",communityHideAvatar:"1"},avatar:false},{params:{uiState:"profileSettings",communityHideAvatar:"0"},avatar:true});
 try{
  for(const enabled of ["0","1"])for(const path of ["/community","/daily-video","/chat/session"]){
   process.env.EXPO_PUBLIC_FLOW_PROTOTYPE=enabled;
   for(const {params,avatar} of cases){
    const C=load("src/components/NativePageControls.tsx",{"react/jsx-runtime":runtime,"react-native":rn,"@expo/vector-icons":{},"expo-router":{usePathname:()=>path,useGlobalSearchParams:()=>params,useRouter:()=>({})},"@/src/i18n":{useT:()=>({locale:"en",t:s=>s}),translate:(_l,s)=>s},"@/src/theme":{colors:{}},"@/src/useAIConsent":{useAIConsent:()=>({state:{status:"allowed"}})},"@/src/aiConsentCopy":{aiConsentCopy:()=>({})},"@/src/aiPermissionNavigation":{},"@/src/requestFailure":{},"./nativeNavigation":{},"@/src/uiux48/Primitives":{IconAction:"IconAction",NuriText:"Text"},"@/src/uiux48/Scene":{NuriAvatar:"Avatar"},"@/src/uiuxfinal/UserAvatar":{CurrentUserAvatarAction:"Profile"},"@/src/uiuxfinal/Primitives":{FinalText:"Text"}}).default;
    const hidden=enabled==="1"&&path==="/community"&&(params.communityHeader==="parent-chat"||params.communityHeader==="feedback"||params.communityHeader===undefined&&params.uiState==="chat");
    const tree=C();assert.equal(tree===null,hidden);
    if(tree&&path==="/community")assert.equal(!!find(tree,"native-header-settings"),avatar,`Avatar visibility follows explicit current presentation before stale uiState: ${JSON.stringify(params)}`);
   }
  }
 }finally{if(previous===undefined)delete process.env.EXPO_PUBLIC_FLOW_PROTOTYPE;else process.env.EXPO_PUBLIC_FLOW_PROTOTYPE=previous;}
});
test("parent backdrop reuses original unified illustration, physical blur and independent half-white veil",()=>{
 const C=load("src/uiuxfinal/ChatBackdrop.tsx",{react:{useRef:v=>({current:v})},"react/jsx-runtime":runtime,"react-native":{...rn,useWindowDimensions:()=>({width:402,height:874})},"expo-image":{Image:"Image"}}).FinalChatBackdrop;
 const parent=C({scene:"parent"}),pattern=find(parent,"final-chat-background-pattern");
 assert.equal(pattern.props.source,"@/assets/final-flow-20261101/community-background.png");assert.equal(pattern.props.blurRadius,20);
 assert.equal(find(parent,"final-chat-background-veil").props.style[1].backgroundColor,"rgba(255,255,255,.5)");assert.ok(find(C(),"final-chat-background-pattern").props.source.endsWith("chat-background-source.png"));
 assert.match(read("src/uiux48/Shell.tsx"),/parentChat\|\|communityBackdrop==="plain"\?<FinalChatBackdrop scene="parent"\//);
});
test("deep-link first render has the parent background and no tabs even before route presentation effects",()=>{
 const previous=process.env.EXPO_PUBLIC_FLOW_PROTOTYPE;process.env.EXPO_PUBLIC_FLOW_PROTOTYPE="1";
 try{for(const params of [{uiState:"chat"},{uiState:"consent"},{communityHeader:"parent-chat"},{uiState:"chat",communityHeader:"default",communityBackdrop:"final-unified",communityHideTabs:"0"}]){
  const C=load("src/uiux48/Shell.tsx",{react:{useEffect:()=>{},useRef:v=>({current:v}),useState:v=>[v,()=>{}]},"react/jsx-runtime":runtime,"react-native":rn,"expo-router":{usePathname:()=>"/community",useSegments:()=>[],useGlobalSearchParams:()=>params},"react-native-safe-area-context":{SafeAreaView:"Safe"},"expo-status-bar":{StatusBar:"Status"},"expo-image":{Image:"Image"},"expo-linear-gradient":{LinearGradient:"Gradient"},"expo-blur":{},"@/src/i18n":{},"@/src/components/NativePageControls":{default:"NativeControls"},"@/src/components/nativeNavigation":{},"./Scene":{NuriScene:"Scene"},"./Theme":{useNuriTheme:()=>({night:false,mode:"Morning",keyboard:{}})},"./Primitives":{},"@/src/uiuxfinal/Primitives":presentation,"@/src/uiuxfinal/ChatBackdrop":{FinalChatBackdrop:"ChatBackdrop"},"@/src/uiuxfinal/ReadingBackdrop":{FinalReadingBackdrop:"ReadingBackdrop"},"./keyboard":{}}).NuriShell;
  const tree=C({children:"page"}),all=walk(tree),parent=params.communityHeader!=="default";
  assert.equal(all.some(n=>n.type==="ChatBackdrop"&&n.props.scene==="parent"),parent);assert.equal(all.some(n=>typeof n.type==="function"&&n.type.name==="NuriTabBar"),!parent);
  assert.ok(all.some(n=>n.type==="Safe"&&n.props.edges?.[0]==="top"),"Always retain shell top safe area");
 }}finally{if(previous===undefined)delete process.env.EXPO_PUBLIC_FLOW_PROTOTYPE;else process.env.EXPO_PUBLIC_FLOW_PROTOTYPE=previous;}
});
