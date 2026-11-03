import {translate as _translateForI18nFixture} from './i18n-test-utils.mjs';
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import ts from "typescript";
import {spawnSync} from "node:child_process";
function load(path,deps={}){
 let source=readFileSync(new URL(path,import.meta.url),"utf8");
 if(path==="../src/uiux48/Composer.tsx"&&process.env.NURI_COMPOSER_BASELINE_REF){const old=spawnSync("git",["show",process.env.NURI_COMPOSER_BASELINE_REF+":native-ios/src/uiux48/Composer.tsx"],{encoding:"utf8"});assert.equal(old.status,0);source=old.stdout;}
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const module={exports:{}};new Function("require","module","exports",output)(name=>{if(name.startsWith("@/assets/"))return name;assert.ok(name in deps,"unexpected import "+name);return deps[name];},module,module.exports);return module.exports;
}
test("drafts survive Home/full-chat bridge but never cross account epochs or stale owners",()=>{
 let epoch=1;const d=load("../src/uiux48/chatDraft.ts",{"@/src/api":{auth:{getSessionGeneration:()=>epoch}}});
 d.writeChatDraft("chat","draft A",1);assert.equal(d.readChatDraft("chat"),"draft A");
 epoch=2;assert.equal(d.readChatDraft("chat"),"");d.writeChatDraft("chat","late A",1);assert.equal(d.readChatDraft("chat"),"");
 d.writeChatDraft("chat","B draft",2);assert.equal(d.readChatDraft("chat"),"B draft");
 epoch=3;assert.equal(d.readChatDraft("chat"),"");d.writeChatDraft("chat","A again",3);d.writeChatDraft("chat","",3);assert.equal(d.readChatDraft("chat"),"");
});
const nodes=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
test("native media modal respects measured root safe area and localizes Back without acting on render",()=>{
 for(const top of [59,62])for(const locale of ["zh-CN","zh-TW","en"]){
  const calls=[],jsx=(type,props)=>({type,props});
  const Component=load("../src/uiux48/MediaPanel.tsx",{"react/jsx-runtime":{jsx,jsxs:jsx},"react-native":{Modal:"Modal",Platform:{OS:"ios"},View:"View"},"react-native-safe-area-context":{useSafeAreaInsets:()=>({top,bottom:34,left:0,right:0})},"@/src/i18n":{useT:()=>({t:key=>_translateForI18nFixture(locale,key)})},"./Primitives":{IconAction:"IconAction",NuriText:"Text"},"./Scene":{NuriScene:"Scene"},"./Shell":{NuriTabBar:"TabBar"},"./Theme":{useNuriTheme:()=>({night:true})}}).MediaPanel;
  const tree=Component({visible:true,title:"permission",children:"fixture only",onClose:()=>calls.push("close"),onDismiss:()=>calls.push("dismiss")}),all=nodes(tree);
  assert.equal(all.find(n=>n.props?.testID==="media-header-safe-area").props.style.paddingTop,top);
  const back=all.find(n=>n.props?.testID==="media-back");assert.equal(back.props.label,locale==="en"?"Back":"返回");assert.deepEqual(calls,[]);
  back.props.onPress();assert.deepEqual(calls,["close"]);tree.props.onDismiss();assert.deepEqual(calls,["close","dismiss"]);
 }
});
let sequence=0;
test("compact composer centers mic/send in the same pill axis at every text scale",()=>{
 const flatten=s=>Array.isArray(s)?Object.assign({},...s.filter(Boolean).map(flatten)):s??{};
 for(const fontScale of [1,1.5,2,2.8])for(const props of [{value:""},{value:"draft"},{hasAttachment:true}]){
  const p=composer(props,false,"en",{width:390,height:844,fontScale});const tree=p.render();
  const action=flatten(p.find("qa-actions").props.style);
  assert.equal(action.height,44);assert.equal(action.top,"50%");assert.deepEqual(action.transform,[{translateY:-22}]);assert.equal(action.bottom,undefined);
  const input=flatten(p.find("qa-input").props.style);assert.equal(input.paddingVertical,0);assert.equal(input.textAlignVertical,"center");
  assert.equal(p.find("qa-input").props.multiline,true);assert.equal(p.find("qa-input").props.scrollEnabled,true);
  assert.equal(nodes(tree).find(n=>n.props?.style?.flexDirection==="row"&&n.props.style.gap===(props.value===""?14:16)).props.style.alignItems,"center");
  p.props.value="line one\nline two";p.render();assert.equal(flatten(p.find("qa-input").props.style).textAlignVertical,"top");
  assert.deepEqual(p.calls,[]);
 }
});
function composer(initial={},night=false,locale="en",dimensions={width:402,height:874,fontScale:1},options={}){
 const slots=[],effects=[],listeners=new Map();let pending=[],cursor=0;let tree;const calls=[];let props={value:"",availableHeight:416,onChangeText:v=>{props.value=v;},onSend:()=>calls.push("send"),onAttach:()=>calls.push("attach"),onMic:()=>calls.push("mic"),testID:"qa",...initial};
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
 const react={useEffect(fn,deps){const i=cursor++;if(options.effects&&(!effects[i]||!same(effects[i].deps,deps)))pending.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});},useRef(value){const i=cursor++;return slots[i]??={current:value};},useId(){const i=cursor++;return slots[i]??= "composer-"+(++sequence);},useState(value){const i=cursor++;if(!(i in slots))slots[i]=value;return[slots[i],v=>{slots[i]=typeof v==="function"?v(slots[i]):v;}];}};
 const jsx=(type,props)=>({type,props});
 const keyboard=load("../src/uiux48/keyboard.ts").iosKeyboard48(night);
 const Component=load("../src/uiux48/Composer.tsx",{react,"react/jsx-runtime":{jsx,jsxs:jsx},"expo-image":{Image:"Image"},"react-native":{InputAccessoryView:"Accessory",Keyboard:{dismiss(){calls.push("dismiss-keyboard");},isVisible:()=>false,addListener:(name,fn)=>{listeners.set(name,fn);return{remove:()=>listeners.delete(name)};}},KeyboardAvoidingView:"KAV",Modal:"Modal",Platform:{OS:"ios"},Pressable:"Pressable",StyleSheet:{create:x=>x},Text:"MeasureText",TextInput:"Input",View:"View",useWindowDimensions:()=>dimensions},"react-native-safe-area-context":{useSafeAreaInsets:()=>({top:62,bottom:34})},"@/src/i18n":{translate:_translateForI18nFixture,useT:()=>({locale})},"./Theme":{useNuriTheme:()=>({secondary:"#aaa",ink:"#333",coral:"#eb8183",composer:"#fff",night,keyboard})},"./Primitives":{GlassSurface:"Glass",IconAction:"IconAction",NuriButton:"Button",NuriText:"Text"},"@/src/uiuxfinal/Primitives":{FinalSurface:"Glass",FinalText:"Text"},"./ChatAttachmentTray":{ChatAttachmentTray:"AttachmentTray"},"./composerLayout":load("../src/uiux48/composerLayout.ts")}).NuriComposer;
 const render=()=>{cursor=0;pending=[];tree=Component(props);pending.forEach(fn=>fn());return tree;};
 return{render,calls,props,listeners,emitKeyboard:name=>listeners.get(name)?.(),unmount:()=>effects.forEach(e=>e?.cleanup?.()),find:id=>nodes(tree).find(n=>n.props?.testID===id),kind:type=>nodes(tree).find(n=>n.type===type)};
}
// Single-line design has no extra expand row; its accessibility action opens
// the same editor. Multiline uses the visible,44pt header action.
function expandComposer(p){const action=p.find("qa-expand");if(action)action.props.onPress();else p.find("qa-input").props.onAccessibilityAction({nativeEvent:{actionName:"expand"}});}
test("Traditional Chinese compact/expanded composer labels preserve drafts and never send on render",()=>{
 for(const night of [false,true]){
  const p=composer({value:"使用者的原文 draft"},night,"zh-TW");p.render();
  assert.equal(p.find("qa-input").props.placeholder,"和 Nuri 說點什麼…");
  assert.equal(p.find("qa-input").props.accessibilityLabel,"給 Nuri 的訊息");
  assert.equal(p.find("qa-attach").props.label,"加入照片或影片");
  assert.equal(p.find("qa-mic").props.label,"錄音");
  assert.equal(p.find("qa-send-btn").props.accessibilityLabel,"傳送");
  expandComposer(p);p.render();
  assert.equal(p.find("qa-expanded-input").props.value,"使用者的原文 draft");
  assert.equal(p.find("qa-expanded-done").props.label,"收起輸入");
  assert.equal(p.find("qa-expanded-mic").props.label,"錄音");
  assert.equal(p.find("qa-expanded-attach").props.label,"加入照片或影片");
  assert.deepEqual(p.calls,[]);
 }
});
test("text keeps microphone and separate send; recording cannot send while mic can stop",()=>{
 const p=composer({value:"text"});p.render();assert.ok(p.find("qa-mic"));assert.ok(p.find("qa-send-btn"));p.find("qa-mic").props.onPress();assert.deepEqual(p.calls,["mic"]);
 p.props.recording=true;p.render();assert.equal(p.find("qa-send-btn").props.disabled,true);p.find("qa-send-btn").props.onPress();assert.deepEqual(p.calls,["mic"]);
 assert.equal(p.find("qa-mic").props.disabled,undefined);
});
test("half-viewport automatic composer, expansion draft continuity and unique iOS accessory IDs",()=>{
 const a=composer({value:"draft"}),b=composer();a.render();b.render();assert.notEqual(a.find("qa-input").props.inputAccessoryViewID,b.find("qa-input").props.inputAccessoryViewID);
 a.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:200}}});a.render();assert.equal(a.find("qa-input").props.style[1].height,80);
 a.find("qa-input").props.onChangeText("");a.render();assert.equal(a.find("qa-input").props.style[1].height,24);
 a.find("qa-input").props.onChangeText("draft");a.render();
 expandComposer(a);a.render();assert.equal(a.kind("Modal").props.visible,true);assert.ok(a.kind("KAV"));assert.equal(a.find("qa-expanded-input").props.value,"draft");
 assert.ok(a.find("qa-expanded-attach"));assert.ok(a.find("qa-expanded-mic"));assert.ok(a.find("qa-expanded-send-btn"));
 assert.notEqual(a.find("qa-input").props.inputAccessoryViewID,a.find("qa-expanded-input").props.inputAccessoryViewID);
 a.find("qa-expanded-attach").props.onPress();a.find("qa-expanded-mic").props.onPress();assert.deepEqual(a.calls,["dismiss-keyboard"],"No system media UI is presented over the expanded Modal");a.render();assert.equal(a.kind("Modal").props.visible,false);a.kind("Modal").props.onDismiss();assert.deepEqual(a.calls,["dismiss-keyboard","attach"],"Only the first queued media action runs after dismissal");a.kind("Modal").props.onDismiss();assert.equal(a.calls.length,2);
 a.find("qa-expanded-input").props.onChangeText("expanded draft");a.find("qa-expanded-done").props.onPress();a.render();assert.equal(a.find("qa-input").props.value,"expanded draft");assert.equal(a.kind("Modal").props.visible,false);
});
test("multiline visibility: iOS caret can scroll before a delayed content-size event and at two lines",()=>{
 for(const value of ["line one\nline two","第一行第二行继续自动换行的中文草稿","First line\nSecond line\nThird line\nFourth line"]){
  const p=composer({value});p.render();
  assert.equal(p.find("qa-input").props.scrollEnabled,true,"Native caret visibility cannot depend on JS reaching the three-line height cap");
  p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:48}}});p.render();
  assert.equal(p.find("qa-input").props.style[1].height,80);
  assert.equal(p.find("qa-input").props.scrollEnabled,true,"A two-line draft must not disable native scrolling");
  assert.deepEqual(p.calls,[]);
 }
});
test("multiline visibility: fractional native text measurements round up rather than clip the last line",()=>{
 const p=composer({value:"two lines"});p.render();
 p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:48.25}}});p.render();
 assert.ok(p.find("qa-input").props.style[1].height>=49);
});
test("multiline visibility: half-viewport bounds follow iOS accessibility font scaling",()=>{
 for(const fontScale of [1.25,1.6,2]){
  const p=composer({},false,"en",{width:390,height:844,fontScale});p.render();
  assert.equal(p.find("qa-input").props.style[1].height,Math.ceil(24*fontScale));
  p.props.value="First line\nSecond line\nThird line\nFourth line";
  p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:240}}});p.render();
  assert.equal(p.find("qa-input").props.style[1].height,Math.max(80,2*Math.ceil(24*fontScale)));
  assert.equal(p.find("qa-input").props.scrollEnabled,true);
 }
});
test("multiline visibility: expanded measurement never overwrites the compact field height",()=>{
 const p=composer({value:"two line draft"});p.render();
 p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:48}}});p.render();
 expandComposer(p);p.render();
 p.find("qa-expanded-input").props.onContentSizeChange?.({nativeEvent:{contentSize:{height:132}}});
 p.find("qa-expanded-done").props.onPress();p.render();
 assert.equal(p.find("qa-input").props.style[1].height,80);
 assert.equal(p.find("qa-input").props.value,"two line draft");
 assert.deepEqual(p.calls,[]);
});
test("multiline visibility: external draft clear returns to one line without waiting on a native measurement",()=>{
 const p=composer({value:"long draft"});p.render();
 p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:160}}});p.render();
 assert.equal(p.find("qa-input").props.style[1].height,80);
 p.props.value="";p.render();
 assert.equal(p.find("qa-input").props.style[1].height,24);
 assert.equal(p.find("qa-send-btn"),undefined);
});
test("multiline visibility: invalid native content sizes cannot collapse or poison the visible editor",()=>{
 const p=composer({value:"two lines"});p.render();
 p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:48}}});p.render();
 for(const height of [0,-20,NaN,Infinity]){
  p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height}}});p.render();
  assert.equal(p.find("qa-input").props.style[1].height,80);
 }
});
test("multiline visibility: composer layout reserves its measured height instead of shrinking behind clipped glass",()=>{
 const p=composer({value:"two lines"});const tree=p.render();
 assert.equal(tree.props.style?.flexShrink,0);
 assert.equal(Object.assign({},...p.find("qa-composer").props.style.filter(Boolean)).flexShrink,0);
 assert.equal(Object.assign({},...p.find("qa-composer").props.contentStyle.filter(Boolean)).flexShrink,0);
});
test("multiline visibility: wrapping keeps a roomy editor without oscillating while retaining all media controls",()=>{
 for(const locale of ["en","zh-CN","zh-TW"])for(const night of [false,true]){
  const p=composer({value:"original draft"},night,locale);p.render();
  for(const measured of [48,72,120,48,24]){
   p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:measured}}});p.render();
   const input=p.find("qa-input");
   assert.equal(input.props.style[1].height,80,"Widening the editor must not collapse it and cause wrapping oscillation");
   assert.equal(input.props.scrollEnabled,true);
   assert.equal(input.props.selection,undefined,"Do not force the caret to the end while the user edits an earlier line");
   assert.equal(input.props.value,"original draft");
   assert.ok(p.find("qa-attach"));assert.ok(p.find("qa-mic"));assert.ok(p.find("qa-send-btn"));
  }
  assert.deepEqual(p.calls,[]);
  p.find("qa-input").props.onChangeText("short");p.render();assert.equal(p.find("qa-input").props.style[1].height,24);
 }
});
test("automatic editor: second-line wrapping promotes to a half-viewport panel and controls move beneath the input",()=>{
 const p=composer({value:"a long original draft",availableHeight:400});p.render();
 assert.equal(p.find("qa-input").props.style[1].height,24);
 p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:48}}});p.render();
 assert.equal(p.find("qa-input").props.style[1].height,72);
 assert.equal(p.find("qa-actions").props.style[1],null);
 assert.ok(p.find("qa-expand"));assert.ok(p.find("qa-mic"));assert.ok(p.find("qa-attach"));assert.ok(p.find("qa-send-btn"));
 p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:24}}});p.render();assert.equal(p.find("qa-input").props.style[1].height,72);
 assert.deepEqual(p.calls,[]);
});
test("automatic editor: explicit newline promotes immediately and actual measured space bounds the editor",()=>{
 const p=composer({value:"first\nsecond",availableHeight:200});p.render();assert.equal(p.find("qa-input").props.style[1].height,48);
 p.props.availableHeight=400;p.render();assert.equal(p.find("qa-input").props.style[1].height,72);
 p.props.availableHeight=100;p.render();assert.equal(p.find("qa-input").props.style[1].height,24);assert.equal(p.find("qa-input").props.scrollEnabled,true);
});
test("stable native input: automatic growth keeps the native field at the same React tree path and ref",()=>{
 const path=(node,target,p=[])=>{if(!node||typeof node!=="object")return null;if(Array.isArray(node)){for(let i=0;i<node.length;i++){const found=path(node[i],target,[...p,i]);if(found)return found;}return null;}if(node.props?.testID===target)return p;return path(node.props?.children,target,[...p,node.type]);};
 const p=composer({value:"retained composition"});const before=p.render(),ref=p.find("qa-input").props.ref;
 p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:48}}});const after=p.render();
 assert.deepEqual(path(before,"qa-input"),path(after,"qa-input"));assert.equal(p.find("qa-input").props.ref,ref);assert.equal(p.find("qa-input").props.key,undefined);assert.deepEqual(p.calls,[]);
});
test("full viewport editor: expansion fills the keyboard-avoiding safe area rather than a fixed text height",()=>{
 const p=composer({value:"draft"});p.render();expandComposer(p);p.render();
 assert.equal(p.kind("KAV").props.style[0].flex,1);assert.equal(p.kind("KAV").props.style[1].paddingTop,62);
 assert.equal(p.find("qa-expanded-viewport").props.style[0].flex,1);
 const surface=p.find("qa-expanded-composer");assert.equal(surface.props.fill,true);assert.equal(surface.props.style.flex,1);assert.equal(surface.props.contentStyle.flex,1);
 const input=p.find("qa-expanded-input");assert.equal(input.props.style[1].height,undefined);assert.equal(input.props.style[2].flex,1);assert.equal(input.props.scrollEnabled,true);
 assert.ok(p.find("qa-expanded-mic"));assert.ok(p.find("qa-expanded-attach"));assert.ok(p.find("qa-expanded-send-btn"));
 p.find("qa-expanded-done").props.onPress();p.render();assert.equal(p.find("qa-input").props.value,"draft");
});
test("full viewport editor: keyboard visibility removes only the safe-bottom gap and listeners clean up on collapse",()=>{
 const p=composer({value:"draft"},false,"en",{width:390,height:844,fontScale:1},{effects:true});
 try{p.render();assert.equal(p.listeners.size,0);expandComposer(p);p.render();assert.equal(p.listeners.size,4);
 p.emitKeyboard("keyboardWillShow");p.render();assert.equal(p.find("qa-expanded-viewport").props.style[1].paddingBottom,12);
 p.emitKeyboard("keyboardWillHide");p.render();assert.equal(p.find("qa-expanded-viewport").props.style[1].paddingBottom,34);
 p.find("qa-expanded-done").props.onPress();p.render();assert.equal(p.listeners.size,0);assert.deepEqual(p.calls,[]);
 }finally{p.unmount();assert.equal(p.listeners.size,0);}
});
test("automatic editor: half-viewport geometry fits portrait, cramped and accessibility-sized native layouts",()=>{
 const {composerLayout:l}=load("../src/uiux48/composerLayout.ts");
 assert.equal(l(1,400).roomyInputHeight,72);assert.equal(l(1,400).roomyCardHeight,200);
 assert.equal(l(1,200).roomyInputHeight,48);assert.equal(l(1,200).roomyCardHeight,176);
 assert.equal(l(1,100).roomyAllowed,false);assert.equal(l(1,416).roomyCardHeight,208);assert.equal(l(1,416).roomyInputHeight,80);
 for(const scale of [1,1.25,1.6,2])for(const available of [0,160,200,300,500]){const g=l(scale,available);if(g.roomyAllowed)assert.ok(g.roomyCardHeight<=available);if(g.roomyAllowed)assert.ok(g.roomyInputHeight>=2*g.lineHeight);}
 assert.equal(l(NaN,400).lineHeight,24);assert.equal(l(Infinity,400).lineHeight,24);
});
function measureFrame(p,width=342){const tree=p.render();assert.equal(typeof tree.props.onLayout,"function","Actual composer width must be measured");tree.props.onLayout({nativeEvent:{layout:{width}}});return p.render();}
const textLines=count=>({nativeEvent:{lines:Array.from({length:count},()=>({height:24,width:180,text:"native layout"}))}});
test("native middle state: real text layout promotes without any TextInput content-size callback",()=>{
 for(const locale of ["en","zh-CN","zh-TW"]){
  const draft=locale==="en"?"This naturally wrapping draft has no explicit newline":"这是一段自然换行且没有手动换行符的输入草稿";
  const p=composer({availableHeight:400},false,locale);measureFrame(p);const ref=p.find("qa-input").props.ref;
  p.find("qa-input").props.onChangeText(draft);p.render();assert.equal(p.find("qa-input").props.style[1].height,24);
  const mirror=p.find("qa-wrap-measure");assert.ok(mirror);assert.equal(mirror.props.children,draft);assert.equal(mirror.props.style[1].width,138);assert.equal(mirror.props.numberOfLines,2);
  mirror.props.onTextLayout(textLines(2));p.render();assert.equal(p.find("qa-input").props.style[1].height,72);assert.equal(p.kind("Modal").props.visible,false);assert.equal(p.find("qa-input").props.ref,ref);
  for(const id of ["qa-expand","qa-mic","qa-attach","qa-send-btn"])assert.ok(p.find(id));assert.deepEqual(p.calls,[]);
 }
});
test("native middle state: compact-width measurement does not widen with the editor or get overridden by stale viewport size",()=>{
 const p=composer({value:"naturally wrapped",availableHeight:400});measureFrame(p);const width=p.find("qa-wrap-measure").props.style[1].width;
 p.find("qa-wrap-measure").props.onTextLayout(textLines(2));p.render();assert.equal(p.find("qa-wrap-measure").props.style[1].width,width);
 p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:24}}});p.render();assert.equal(p.find("qa-input").props.style[1].height,72);
 expandComposer(p);p.render();p.find("qa-expanded-done").props.onPress();p.render();assert.equal(p.find("qa-input").props.style[1].height,72);assert.equal(p.find("qa-input").props.value,"naturally wrapped");
});
test("native middle state: late layout for an older draft or width cannot open or collapse the current editor",()=>{
 const p=composer({value:"old long draft",availableHeight:400});measureFrame(p);const old=p.find("qa-wrap-measure");
 p.find("qa-input").props.onChangeText("short");p.render();old.props.onTextLayout(textLines(2));p.render();assert.equal(p.find("qa-input").props.style[1].height,24);
 p.find("qa-wrap-measure").props.onTextLayout(textLines(1));p.render();const oldWidth=p.find("qa-wrap-measure");measureFrame(p,500);oldWidth.props.onTextLayout(textLines(2));p.render();assert.equal(p.find("qa-input").props.style[1].height,24);
});
test("native middle state: only a current one-line measurement collapses a populated editor; clearing resets immediately",()=>{
 const p=composer({value:"long draft is wrapping",availableHeight:400});measureFrame(p);p.find("qa-wrap-measure").props.onTextLayout(textLines(2));p.render();
 p.find("qa-input").props.onChangeText("short");p.render();assert.equal(p.find("qa-input").props.style[1].height,72,"Do not flicker closed before the new native line measurement");
 p.find("qa-wrap-measure").props.onTextLayout(textLines(1));p.render();assert.equal(p.find("qa-input").props.style[1].height,24);
 p.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:48}}});p.render();assert.equal(p.find("qa-input").props.style[1].height,24,"Stale input viewport callbacks cannot override real one-line layout");
 p.find("qa-input").props.onChangeText("");p.render();assert.equal(p.find("qa-input").props.style[1].height,24);assert.equal(p.find("qa-wrap-measure"),undefined);assert.deepEqual(p.calls,[]);
});
test("native middle state: measurement is invisible, inaccessible, font-matched and never captures input or dispatches actions",()=>{
 const p=composer({value:"draft"});measureFrame(p);const m=p.find("qa-wrap-measure"),input=p.find("qa-input");assert.equal(m.type,"MeasureText");assert.equal(m.props.accessible,false);assert.equal(m.props.accessibilityElementsHidden,true);assert.equal(m.props.importantForAccessibility,"no-hide-descendants");assert.equal(m.props.pointerEvents,"none");
 for(const field of ["fontSize","lineHeight","paddingHorizontal","paddingVertical"])assert.equal(m.props.style[0][field],input.props.style[0][field]);
 assert.equal(m.props.style[0].position,"absolute");assert.equal(m.props.style[0].opacity,0);assert.equal(m.props.onPress,undefined);assert.equal(m.props.onChangeText,undefined);assert.deepEqual(p.calls,[]);
});
test("native middle state: a trailing newline remains two-line editing even when native Text omits its empty final line",()=>{
 const p=composer({value:"first\n",availableHeight:400});measureFrame(p);p.find("qa-wrap-measure").props.onTextLayout(textLines(1));p.render();assert.equal(p.find("qa-input").props.style[1].height,72);assert.equal(p.kind("Modal").props.visible,false);
});
test("native middle state: width, send control and font scale invalidate old line measurements",()=>{
 const dimensions={width:390,height:844,fontScale:1};const p=composer({value:"draft",availableHeight:400},true,"zh-TW",dimensions);measureFrame(p,342.5);const old=p.find("qa-wrap-measure");assert.equal(old.props.style[1].width,138.5);
 dimensions.fontScale=1.25;p.render();old.props.onTextLayout(textLines(2));p.render();assert.equal(p.find("qa-input").props.style[1].height,30);p.find("qa-wrap-measure").props.onTextLayout(textLines(2));p.render();assert.equal(p.find("qa-input").props.style[1].height,72);
 const {compactComposerTextWidth:w}=load("../src/uiux48/composerLayout.ts");assert.equal(w(342,true),138);assert.equal(w(342,false),188);for(const width of [0,-1,NaN,Infinity])assert.equal(w(width,true),0);
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
  expandComposer(p);p.render();
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
 p.calls.length=0;expandComposer(p);p.render();
 p.find("qa-expanded-input").props.ref.current={blur:()=>p.calls.push("blur-expanded")};
 p.find("qa-expanded-keyboard-done").props.onPress();p.render();
 assert.equal(p.kind("Modal").props.visible,false);
 assert.equal(p.find("qa-input").props.value,"three\nline\ndraft");
 p.kind("Modal").props.onDismiss();
 assert.deepEqual(p.calls,["blur-compact","blur-expanded","dismiss-keyboard","blur-compact","blur-expanded","dismiss-keyboard"]);
 p.kind("Modal").props.onDismiss();assert.equal(p.calls.length,6,"Dismiss intent is consumed once");
 p.calls.length=0;expandComposer(p);p.render();p.find("qa-expanded-done").props.onPress();p.render();
 p.kind("Modal").props.onDismiss();assert.deepEqual(p.calls,[],"Collapse preserves normal focus behavior");
});
test("expanded input waits for native Modal mounting before focusing so its keyboard accessory can attach",()=>{
 const p=composer({value:"draft"});p.render();expandComposer(p);p.render();
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
