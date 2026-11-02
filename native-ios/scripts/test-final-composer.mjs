import assert from "node:assert/strict";
import {readFileSync,statSync} from "node:fs";
import {test} from "node:test";
import ts from "typescript";

const jsx=(type,props)=>({type,props});
const flat=style=>Array.isArray(style)?Object.assign({},...style.filter(Boolean).map(flat)):style??{};
const nodes=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
const present=n=>!n||typeof n!=="object"?n:Array.isArray(n)?n.map(present):typeof n.type==="function"&&n.type.name!=="VoicePreviewWaveform"?present(n.type(n.props)):{...n,props:{...n.props,children:present(n.props?.children)}};
function load(path,deps={}){
 const text=readFileSync(new URL(path,import.meta.url),"utf8");
 const code=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const m={exports:{}};new Function("require","module","exports",code)(name=>{if(name.startsWith("@/assets/"))return name;assert.ok(name in deps,`unexpected import ${name}`);return deps[name];},m,m.exports);return m.exports;
}
function hooks(){
 const slots=[],effects=[];let cursor=0,pending=[];
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
 const react={useRef(value){return slots[cursor++]??={current:value};},useId(){return "composer-test";},useState(value){const i=cursor++;if(!(i in slots))slots[i]=typeof value==="function"?value():value;return[slots[i],next=>slots[i]=typeof next==="function"?next(slots[i]):next];},useEffect(fn,deps){const i=cursor++;if(!effects[i]||!same(effects[i].deps,deps))pending.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});}};
 return {react,render(fn){cursor=0;pending=[];const tree=fn();pending.forEach(fn=>fn());return tree;},unmount(){effects.forEach(e=>e?.cleanup?.());}};
}
function composer(value=""){
 const h=hooks(),calls=[];let tree;
 const props={value,availableHeight:416,onChangeText:value=>props.value=value,onSend:()=>calls.push("send"),onAttach:()=>calls.push("attach"),onMic:()=>calls.push("mic"),testID:"qa"};
 const C=load("../src/uiux48/Composer.tsx",{react:h.react,"react/jsx-runtime":{jsx,jsxs:jsx},"expo-image":{Image:"Image"},"react-native":{InputAccessoryView:"Accessory",Keyboard:{dismiss:()=>calls.push("dismiss"),isVisible:()=>false,addListener:()=>({remove(){}})},KeyboardAvoidingView:"KAV",Modal:"Modal",Platform:{OS:"ios"},Pressable:"Pressable",StyleSheet:{create:x=>x},Text:"Text",TextInput:"Input",View:"View",useWindowDimensions:()=>({width:402,height:874,fontScale:1})},"react-native-safe-area-context":{useSafeAreaInsets:()=>({top:62,bottom:34})},"@/src/i18n":{useT:()=>({locale:"en"}),translate:(_l,s)=>s},"./Theme":{useNuriTheme:()=>({ink:"#4A454D",secondary:"#706A74",keyboard:{appearance:"light"}})},"./Primitives":{NuriText:"Text"},"@/src/uiuxfinal/Primitives":{FinalSurface:"Surface",FinalText:"Text"},"./composerLayout":load("../src/uiux48/composerLayout.ts")}).NuriComposer;
 return {props,calls,render(){tree=present(h.render(()=>C(props)));return tree;},find:id=>nodes(tree).find(n=>n.props?.testID===id),all:()=>nodes(tree),kind:type=>nodes(tree).find(n=>n.type===type),unmount:h.unmount};
}
function imageIn(node){return nodes(node).find(n=>n.type==="Image");}
function assertAsset(image,size){
 assert.deepEqual(image.props.style,{width:size,height:size});
 const path=image.props.source.replace("@/","../");const url=new URL(path,import.meta.url);
 assert.ok(statSync(url).size>0);const root=readFileSync(url,"utf8").match(/<svg\b[^>]+>/)?.[0];
 assert.match(root,new RegExp(`\\bwidth="${size}"`));assert.match(root,new RegExp(`\\bheight="${size}"`));
}
test("final empty composer uses original24pt artwork and 60pt cream capsule, with no extra expand row",()=>{
 const f=composer();const tree=f.render(),all=f.all();
 const row=all.find(n=>n.type==="View"&&n.props?.style?.gap===14);
 assert.equal(row.props.style.marginLeft,3);assert.equal(row.props.style.marginRight,5);
 const surfaces=all.filter(n=>n.type==="Surface"&&!n.props.fill);
 assert.equal(surfaces[0].props.style.width,60);assert.equal(surfaces[0].props.contentStyle.height,60);
 const card=f.find("qa-composer");assert.equal(card.props.radius,999);assert.equal(card.props.surfaceColor,"rgba(255,250,242,.64)");
 assert.equal(flat(f.find("qa-editor-region").props.style).height,60);
 for(const id of ["qa-attach","qa-mic"]){const control=f.find(id);assert.equal(flat(control.props.style({pressed:false})).width,44);assert.equal(flat(control.props.style({pressed:false})).height,44);assertAsset(imageIn(control),24);}
 assert.equal(f.find("qa-expand"),undefined);assert.equal(f.find("qa-send-btn"),undefined);
 assert.equal(flat(f.find("qa-input").props.style).textAlignVertical,"center");assert.equal(f.find("qa-input").props.scrollEnabled,true);
 assert.deepEqual(f.calls,[]);f.unmount();
});
test("typed capsule retains150pt measuring width and44pt original20pt microphone/send targets",()=>{
 const f=composer("draft");f.render();const card=f.find("qa-composer");
 assert.equal(card.props.radius,999);assert.equal(flat(f.find("qa-editor-region").props.style).paddingRight,108);
 f.render().props.onLayout({nativeEvent:{layout:{width:354}}});f.render();
 assert.equal(flat(f.find("qa-wrap-measure").props.style).width,150);
 assertAsset(imageIn(f.find("qa-mic")),20);assertAsset(imageIn(f.find("qa-send-btn")),20);
 assert.equal(flat(f.find("qa-send-btn").props.style({pressed:false})).height,44);
 f.find("qa-mic").props.onPress();f.find("qa-send-btn").props.onPress();assert.deepEqual(f.calls,["mic","send"]);f.unmount();
});
test("multiline frame is208pt at416available, with independent header,80pt full-width input and left media tools",()=>{
 const f=composer("first\nsecond");f.render();const card=f.find("qa-composer"),content=flat(card.props.contentStyle),header=f.find("qa-editor-header"),input=flat(f.find("qa-input").props.style),actions=f.find("qa-actions");
 assert.equal(card.props.radius,24);assert.equal(card.props.surfaceColor,"rgba(255,250,242,.64)");
 assert.equal(content.paddingHorizontal,16);assert.equal(content.paddingVertical,12);assert.equal(content.gap,8);
 assert.equal(header.props.style.height,44);assert.equal(input.height,80);assert.equal(input.paddingRight,undefined);assert.equal(input.scrollEnabled,undefined);
 assert.equal(f.find("qa-input").props.scrollEnabled,true);assert.equal(input.textAlignVertical,"top");
 assert.equal(24+44+8+input.height+8+44,208);
 assert.deepEqual(nodes(actions).filter(n=>n.type==="Pressable").map(n=>n.props.testID),["qa-attach","qa-mic","qa-send-btn"]);
 for(const id of ["qa-expand","qa-attach","qa-mic","qa-send-btn"])assertAsset(imageIn(f.find(id)),20);
 assert.deepEqual(f.calls,[]);f.unmount();
});
test("full editor caption and collapse live above the unpadded scrolling draft; collapse preserves it",()=>{
 const f=composer("first\nsecond");f.render();f.find("qa-expand").props.onPress();f.render();
 const header=f.find("qa-expanded-header"),input=flat(f.find("qa-expanded-input").props.style);
 assert.equal(header.props.style.height,44);assert.ok(nodes(header).some(n=>n.props?.children==="Edit message"));
 assert.equal(f.find("qa-expanded-composer").props.radius,24);assert.equal(f.find("qa-expanded-composer").props.fill,true);
 assert.equal(f.kind("KAV").props.style[0].paddingHorizontal,24);assert.equal(f.kind("KAV").props.style[1].paddingTop,62);
 assert.equal(input.paddingRight,undefined);assert.equal(input.flex,1);assert.equal(f.find("qa-expanded-input").props.scrollEnabled,true);
 assertAsset(imageIn(f.find("qa-expanded-done")),20);f.find("qa-expanded-done").props.onPress();f.render();assert.equal(f.find("qa-input").props.value,"first\nsecond");assert.deepEqual(f.calls,[]);f.unmount();
});
function voiceModule(react={},native={}){
 return load("../src/uiux48/VoiceInputBar.tsx",{react,"react/jsx-runtime":{jsx,jsxs:jsx},"expo-image":{Image:"Image"},"react-native":{ActivityIndicator:"Activity",Pressable:"Pressable",View:"View",...native},"@/src/i18n":{useT:()=>({locale:"en",t:s=>s})},"@/src/components/VoiceWaveform":{__esModule:true,default:"LiveWaveform"},"./Primitives":{IconAction:"IconAction"},"./Theme":{useNuriTheme:()=>({ink:"#5C5662"})},"@/src/uiuxfinal/Primitives":{FinalSurface:"Surface",FinalText:"Text"}});
}
test("recording bar is60pt; original32pt stop/send have44pt targets and cancel remains reachable without extra rows",()=>{
 const C=voiceModule().VoiceInputBar,calls=[],level=()=>.2;
 const tree=C({phase:"recording",seconds:9,metered:true,level,onCancel:()=>calls.push("cancel"),onStop:()=>calls.push("stop"),onSend:()=>calls.push("send")}),all=nodes(tree);
 assert.equal(tree.type,"Surface");assert.equal(tree.props.radius,999);assert.equal(tree.props.contentStyle.height,60);assert.equal(tree.props.contentStyle.padding,8);assert.equal(tree.props.contentStyle.gap,12);
 assert.deepEqual(calls,[]);assert.equal(all.find(n=>n.type==="LiveWaveform").props.level,level);
 const cancel=all.find(n=>n.props?.testID==="chat-voice-cancel");assert.match(cancel.props.accessibilityLabel,/0:09/);cancel.props.onAccessibilityAction({nativeEvent:{actionName:"cancel"}});assert.deepEqual(calls,["cancel"]);
 for(const [id,action]of [["chat-voice-stop","stop"],["chat-voice-send","send"]]){const control=all.find(n=>n.props?.testID===id);assert.equal(control.props.style.width,44);assert.equal(control.props.style.height,44);assertAsset(imageIn(control),32);control.props.onPress();assert.equal(calls.at(-1),action);}
 assert.equal(all.filter(n=>n.type==="Text").length,0,"No extra instruction or timer row in the live design");
});
test("starting/transcribing stay truthful and cancellable, with no send or waveform pretending to record",()=>{
 const C=voiceModule().VoiceInputBar;
 for(const phase of ["starting","transcribing"]){const calls=[],tree=C({phase,seconds:0,metered:false,level:()=>null,onCancel:()=>calls.push("cancel"),onStop:()=>calls.push("stop"),onSend:()=>calls.push("send")}),all=nodes(tree);assert.equal(tree.props.contentStyle.height,60);assert.equal(all.some(n=>n.props?.testID==="chat-voice-send"),false);assert.equal(all.some(n=>n.type==="LiveWaveform"),false);assert.deepEqual(calls,[]);all.find(n=>n.props?.testID==="chat-voice-cancel").props.onPress();assert.deepEqual(calls,["cancel"]);}
 const preview=C({phase:"recording",previewOnly:true,seconds:0,metered:false,level:()=>null,onCancel(){},onStop(){},onSend(){}});assert.ok(nodes(preview).some(n=>n.props?.children==="Voice preview · Not recording"));assert.equal(nodes(preview).some(n=>n.type==="LiveWaveform"),false);
 assert.equal(preview.type,"View");assert.equal(flat(preview.props.style).position,undefined,"Preview wrapper stays in normal layout, not an overlay");assert.equal(flat(preview.props.style).gap,4);
 const [caption,capsule]=preview.props.children;assert.equal(preview.props.children.length,2,"Preview caption and recording capsule are separate siblings");
 assert.equal(caption.type,"Text");assert.equal(caption.props.children,"Voice preview · Not recording");assert.equal(flat(caption.props.style).position,undefined,"Caption occupies its own row above the capsule instead of covering the waveform");
 assert.equal(capsule.type,"Surface");assert.equal(capsule.props.testID,"chat-voice-recording");assert.equal(capsule.props.contentStyle.height,60);assert.equal(capsule.props.contentStyle.alignItems,"center");
 assert.equal(nodes(capsule).some(n=>n.props?.children==="Voice preview · Not recording"),false,"Truthful preview label must not take waveform space inside the capsule");assert.ok(nodes(capsule).some(n=>typeof n.type==="function"&&n.type.name==="VoicePreviewWaveform"));
});
test("authored preview waveform uses exact4s linear−336pt loop, respects Reduce Motion and cleans up",async()=>{
 const h=hooks(),calls=[],listeners=new Set();let value=0;
 const Animated={Value:class{setValue(next){value=next;}},View:"AnimatedView",timing:(_value,config)=>{calls.push(["timing",config]);return config;},loop:()=>({start:()=>calls.push(["start"]),stop:()=>calls.push(["stop"])})};
 const AccessibilityInfo={isReduceMotionEnabled:async()=>false,addEventListener:(_event,fn)=>{listeners.add(fn);return{remove:()=>listeners.delete(fn)};}};
 const C=voiceModule(h.react,{Animated,AccessibilityInfo,Easing:{linear:"linear"},Platform:{OS:"ios"}}).VoicePreviewWaveform;
 let tree=h.render(()=>C());assert.equal(calls.length,0,"No animation before accessibility setting is known");await Promise.resolve();tree=h.render(()=>C());
 const config=calls.find(x=>x[0]==="timing")[1];assert.deepEqual(config,{toValue:-336,duration:4000,easing:"linear",useNativeDriver:true});assert.equal(value,0);
 const motion=nodes(tree).find(n=>n.type==="AnimatedView");assert.equal(motion.props.style.width,672);assert.equal(motion.props.style.gap,3);assert.equal(nodes(motion).filter(n=>n.type==="View").length,112);
 [...listeners][0](true);h.render(()=>C());assert.ok(calls.some(x=>x[0]==="stop"));assert.equal(value,0);h.unmount();assert.equal(listeners.size,0);
});
