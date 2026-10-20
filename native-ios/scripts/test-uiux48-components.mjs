import {translate as _translateForI18nFixture} from './i18n-test-utils.mjs';
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import ts from "typescript";
import {spawnSync} from "node:child_process";
function load(path,deps={}){
 const output=ts.transpileModule(readFileSync(new URL(path,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const module={exports:{}};new Function("require","module","exports",output)(name=>{assert.ok(name in deps,"unexpected import "+name);return deps[name];},module,module.exports);return module.exports;
}
test("drafts survive Home/full-chat bridge but never cross account epochs or stale owners",()=>{
 let epoch=1;const d=load("../src/uiux48/chatDraft.ts",{"@/src/api":{auth:{getSessionGeneration:()=>epoch}}});
 d.writeChatDraft("chat","draft A",1);assert.equal(d.readChatDraft("chat"),"draft A");
 epoch=2;assert.equal(d.readChatDraft("chat"),"");d.writeChatDraft("chat","late A",1);assert.equal(d.readChatDraft("chat"),"");
 d.writeChatDraft("chat","B draft",2);assert.equal(d.readChatDraft("chat"),"B draft");
 epoch=3;assert.equal(d.readChatDraft("chat"),"");d.writeChatDraft("chat","A again",3);d.writeChatDraft("chat","",3);assert.equal(d.readChatDraft("chat"),"");
});
const nodes=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
let sequence=0;
function composer(initial={},night=false,locale="en"){
 const slots=[];let cursor=0;let tree;const calls=[];let props={value:"",onChangeText:v=>{props.value=v;},onSend:()=>calls.push("send"),onAttach:()=>calls.push("attach"),onMic:()=>calls.push("mic"),testID:"qa",...initial};
 const react={useRef(value){const i=cursor++;return slots[i]??={current:value};},useId(){const i=cursor++;return slots[i]??= "composer-"+(++sequence);},useState(value){const i=cursor++;if(!(i in slots))slots[i]=value;return[slots[i],v=>{slots[i]=typeof v==="function"?v(slots[i]):v;}];}};
 const jsx=(type,props)=>({type,props});
 const keyboard=load("../src/uiux48/keyboard.ts").iosKeyboard48(night);
 const Component=load("../src/uiux48/Composer.tsx",{react,"react/jsx-runtime":{jsx,jsxs:jsx},"react-native":{InputAccessoryView:"Accessory",Keyboard:{dismiss(){calls.push("dismiss-keyboard");}},KeyboardAvoidingView:"KAV",Modal:"Modal",Platform:{OS:"ios"},Pressable:"Pressable",StyleSheet:{create:x=>x},TextInput:"Input",View:"View",useWindowDimensions:()=>({width:402,height:874})},"react-native-safe-area-context":{useSafeAreaInsets:()=>({top:62,bottom:34})},"@/src/i18n":{translate:_translateForI18nFixture,useT:()=>({locale})},"./Theme":{useNuriTheme:()=>({secondary:"#aaa",ink:"#333",coral:"#eb8183",composer:"#fff",night,keyboard})},"./Primitives":{GlassSurface:"Glass",IconAction:"IconAction",NuriButton:"Button",NuriText:"Text"}}).NuriComposer;
 const render=()=>{cursor=0;tree=Component(props);return tree;};
 return{render,calls,props,find:id=>nodes(tree).find(n=>n.props?.testID===id),kind:type=>nodes(tree).find(n=>n.type===type)};
}
test("Traditional Chinese compact/expanded composer labels preserve drafts and never send on render",()=>{
 for(const night of [false,true]){
  const p=composer({value:"使用者的原文 draft"},night,"zh-TW");p.render();
  assert.equal(p.find("qa-input").props.placeholder,"和 Nuri 說點什麼…");
  assert.equal(p.find("qa-input").props.accessibilityLabel,"給 Nuri 的訊息");
  assert.equal(p.find("qa-attach").props.label,"拍照或上傳圖片");
  assert.equal(p.find("qa-mic").props.label,"錄音");
  assert.equal(p.find("qa-send-btn").props.accessibilityLabel,"傳送");
  p.find("qa-expand").props.onPress();p.render();
  assert.equal(p.find("qa-expanded-input").props.value,"使用者的原文 draft");
  assert.equal(p.find("qa-expanded-done").props.label,"收起輸入");
  assert.equal(p.find("qa-expanded-mic").props.label,"錄音");
  assert.equal(p.find("qa-expanded-attach").props.label,"拍照或上傳圖片");
  assert.deepEqual(p.calls,[]);
 }
});
test("text keeps microphone and separate send; recording cannot send while mic can stop",()=>{
 const p=composer({value:"text"});p.render();assert.ok(p.find("qa-mic"));assert.ok(p.find("qa-send-btn"));p.find("qa-mic").props.onPress();assert.deepEqual(p.calls,["mic"]);
 p.props.recording=true;p.render();assert.equal(p.find("qa-send-btn").props.disabled,true);p.find("qa-send-btn").props.onPress();assert.deepEqual(p.calls,["mic"]);
 assert.equal(p.find("qa-mic").props.disabled,undefined);
});
test("one-to-three-line composer clamp, expansion draft continuity and unique iOS accessory IDs",()=>{
 const a=composer({value:"draft"}),b=composer();a.render();b.render();assert.notEqual(a.find("qa-input").props.inputAccessoryViewID,b.find("qa-input").props.inputAccessoryViewID);
 a.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:200}}});a.render();assert.equal(a.find("qa-input").props.style[1].height,72);
 a.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:10}}});a.render();assert.equal(a.find("qa-input").props.style[1].height,24);
 a.find("qa-expand").props.onPress();a.render();assert.equal(a.kind("Modal").props.visible,true);assert.ok(a.kind("KAV"));assert.equal(a.find("qa-expanded-input").props.value,"draft");
 assert.ok(a.find("qa-expanded-attach"));assert.ok(a.find("qa-expanded-mic"));assert.ok(a.find("qa-expanded-send-btn"));
 assert.notEqual(a.find("qa-input").props.inputAccessoryViewID,a.find("qa-expanded-input").props.inputAccessoryViewID);
 a.find("qa-expanded-attach").props.onPress();a.find("qa-expanded-mic").props.onPress();assert.deepEqual(a.calls,["attach","mic"]);
 a.find("qa-expanded-input").props.onChangeText("expanded draft");a.find("qa-expanded-done").props.onPress();a.render();assert.equal(a.find("qa-input").props.value,"expanded draft");assert.equal(a.kind("Modal").props.visible,false);
});
test("glass has role/theme strength and composer remains the opaque input tier",()=>{
 const {GLASS_BLUR48:g}=load("../src/uiux48/materials.ts");
 assert.ok(g.Night.card>g.Morning.card);assert.ok(g.Night.message>g.Afternoon.message);
 for(const mode of ["Morning","Afternoon","Night"]){assert.equal(g[mode].composer,100);assert.equal(g[mode].pill,70);}
});
test("native keyboard keeps its own suggestions and the same functional Done callback",()=>{
 for(const night of [false,true]){
  const p=composer({value:"draft"},night);p.render();
  assert.equal(p.find("qa-input").props.keyboardAppearance,night?"dark":"light");
  assert.equal(p.kind("Accessory").props.nativeID,p.find("qa-input").props.inputAccessoryViewID);
  assert.equal(p.find("qa-keyboard-material"),undefined,"No overlay may cover predictive keyboard content");
  assert.equal(p.find("qa-keyboard-panel").props.style[0].height,44);
  assert.equal(p.find("qa-keyboard-done").props.style.height,44);
  p.find("qa-expand").props.onPress();p.render();
  assert.equal(p.find("qa-expanded-input").props.keyboardAppearance,night?"dark":"light");
  assert.equal(p.kind("Accessory").props.nativeID,p.find("qa-expanded-input").props.inputAccessoryViewID);
  p.find("qa-expanded-keyboard-done").props.onPress();p.render();
  assert.equal(p.kind("Modal").props.visible,false);assert.deepEqual(p.calls,["dismiss-keyboard"]);
 }
 const theme=readFileSync(new URL("../src/uiux48/Theme.tsx",import.meta.url),"utf8");
 assert.match(theme,/Appearance\.setColorScheme\(mode === "Night" \? "dark" : "light"\)/);
 assert.match(readFileSync(new URL("../src/uiux48/Primitives.tsx",import.meta.url),"utf8"),/keyboardAppearance=\{t\.keyboard\.appearance\}/);
 const shell=readFileSync(new URL("../src/uiux48/Shell.tsx",import.meta.url),"utf8");
 assert.match(shell,/top:panelTop/);assert.match(shell,/backgroundColor:keyboardTheme.surface/);
 assert.doesNotMatch(readFileSync(new URL("../src/uiux48/Composer.tsx",import.meta.url),"utf8"),/bottom:\s*-28|NativeKeyboardAccessory/);
});
test("keyboard panel uses measured frame coordinates, not a fixed bottom margin or floating-keyboard mask",()=>{
 const {keyboardPanelTop:top}=load("../src/uiux48/keyboard.ts");
 assert.equal(top({screenY:500,height:374,width:402},{y:0,height:874,width:402}),500);
 assert.equal(top({screenY:500,height:374,width:402},{y:62,height:812,width:402}),438);
 assert.equal(top({screenY:874,height:0,width:402},{y:0,height:874,width:402}),null);
 assert.equal(top({screenY:874,height:374,width:402},{y:0,height:874,width:402}),null);
 assert.equal(top({screenY:500,height:200,width:250},{y:0,height:874,width:402}),null);
 assert.equal(top(null,{y:0,height:874,width:402}),null);
});
test("Done blurs both native fields and survives modal focus restoration without losing the draft",()=>{
 const p=composer({value:"three\nline\ndraft"});p.render();
 const compact=p.find("qa-input").props.ref;
 compact.current={blur:()=>p.calls.push("blur-compact")};
 p.find("qa-keyboard-done").props.onPress();
 assert.deepEqual(p.calls,["blur-compact","dismiss-keyboard"]);
 p.calls.length=0;p.find("qa-expand").props.onPress();p.render();
 p.find("qa-expanded-input").props.ref.current={blur:()=>p.calls.push("blur-expanded")};
 p.find("qa-expanded-keyboard-done").props.onPress();p.render();
 assert.equal(p.kind("Modal").props.visible,false);
 assert.equal(p.find("qa-input").props.value,"three\nline\ndraft");
 p.kind("Modal").props.onDismiss();
 assert.deepEqual(p.calls,["blur-compact","blur-expanded","dismiss-keyboard","blur-compact","blur-expanded","dismiss-keyboard"]);
 p.kind("Modal").props.onDismiss();assert.equal(p.calls.length,6,"Dismiss intent is consumed once");
 p.calls.length=0;p.find("qa-expand").props.onPress();p.render();p.find("qa-expanded-done").props.onPress();p.render();
 p.kind("Modal").props.onDismiss();assert.deepEqual(p.calls,[],"Collapse preserves normal focus behavior");
});
test("expanded input waits for native Modal mounting before focusing so its keyboard accessory can attach",()=>{
 const p=composer({value:"draft"});p.render();p.find("qa-expand").props.onPress();p.render();
 const input=p.find("qa-expanded-input");assert.notEqual(input.props.autoFocus,true);
 input.props.ref.current={focus:()=>p.calls.push("focus-expanded")};
 assert.deepEqual(p.calls,[]);p.kind("Modal").props.onShow();assert.deepEqual(p.calls,["focus-expanded"]);
});
test("actual native typing indicator uses shared glass, approved avatar and theme ink in CN and EN",()=>{
 const source=readFileSync(new URL("../app/chat/[id].tsx",import.meta.url),"utf8");
 const ast=ts.createSourceFile("chat.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const component=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==="TypingDots");assert.ok(component);
 const code=ts.transpileModule(component.getText(ast)+"\nmodule.exports=TypingDots;",{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 for(const locale of ["en","zh-CN","zh-TW"])for(const ink of ["#3d3340","#f8f2f8"]){
  const jsx=(type,props)=>({type,props}),module={exports:{}};
  const Animated={Value:class{},loop:()=>({start(){},stop(){}}),sequence:x=>x,delay:x=>x,timing:()=>({}),View:"AnimatedView"};
  new Function("require","module","exports","useNuriTheme","useT","useRef","useEffect","Animated","Easing","View","GlassSurface","NuriText","SceneAvatar","translate",code)(()=>({jsx,jsxs:jsx}),module,module.exports,()=>({ink}),()=>({locale}),x=>({current:x}),cb=>cb(),Animated,{inOut:x=>x,out:x=>x,in:x=>x,quad:"quad"},"View","GlassSurface","NuriText","SceneAvatar",_translateForI18nFixture);
  const tree=module.exports(),all=nodes(tree);
  assert.equal(tree.type,"GlassSurface");assert.equal(tree.props.kind,"message");
  assert.equal(all.filter(n=>n.type==="SceneAvatar").length,1);
  assert.equal(all.filter(n=>n.type==="AnimatedView").length,3);
  for(const dot of all.filter(n=>n.type==="AnimatedView"))assert.equal(dot.props.style.backgroundColor,ink);
  assert.ok(all.find(n=>n.props?.accessibilityLiveRegion==="polite").props.children.includes(locale==="en"?"replying":locale==="zh-TW"?"正在回覆":"正在回复"));
 }
});
test("all 112 theme and 54 layout tokens retain three design modes",()=>{
 const t=load("../src/uiux48/tokens.ts");assert.equal(Object.keys(t.THEME48).length,112);assert.equal(Object.keys(t.LAYOUT48).length,54);
 for(const values of Object.values(t.THEME48))assert.deepEqual(Object.keys(values).sort(),["Afternoon","Morning","Night"]);
});
test("Metro cache separates fixture, real API and different backend builds",()=>{
 const cacheKey=(preview,backend)=>{
  const child=spawnSync(process.execPath,["-e","console.log(require('./metro.config.js').cacheVersion)"],{cwd:new URL("..",import.meta.url),encoding:"utf8",env:{...process.env,EXPO_NO_DOTENV:"1",EXPO_PUBLIC_PREVIEW_MODE:preview,EXPO_PUBLIC_BACKEND_URL:backend}});
  assert.equal(child.status,0,child.stderr);return child.stdout.trim();
 };
 const live=cacheKey("0","https://example.invalid"),fixture=cacheKey("1","https://example.invalid");
 assert.notEqual(live,fixture);assert.notEqual(live,cacheKey("0","https://other.example.invalid"));assert.equal(live,cacheKey("0","https://example.invalid"));
});
