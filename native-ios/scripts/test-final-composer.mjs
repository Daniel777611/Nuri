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
function composer(value="",options={}){
 const h=hooks(),calls=[];let tree;
 const {os="ios",dimensions={width:402,height:874,fontScale:1},...initial}=options;
 const props={value,availableHeight:416,onChangeText:value=>props.value=value,onSend:()=>calls.push("send"),onAttach:()=>calls.push("attach"),onMic:()=>calls.push("mic"),onRemoveAttachment:id=>{calls.push(["remove",id]);props.attachments=props.attachments.filter(item=>item.id!==id);},onPreviewAttachment:attachment=>calls.push(["preview",attachment.id]),testID:"qa",...initial};
 const C=load("../src/uiux48/Composer.tsx",{react:h.react,"react/jsx-runtime":{jsx,jsxs:jsx},"expo-image":{Image:"Image"},"react-native":{InputAccessoryView:"Accessory",Keyboard:{dismiss:()=>calls.push("dismiss"),isVisible:()=>false,addListener:()=>({remove(){}})},KeyboardAvoidingView:"KAV",Modal:"Modal",Platform:{OS:os},Pressable:"Pressable",StyleSheet:{create:x=>x},Text:"Text",TextInput:"Input",View:"View",useWindowDimensions:()=>dimensions},"react-native-safe-area-context":{useSafeAreaInsets:()=>({top:62,bottom:34})},"@/src/i18n":{useT:()=>({locale:"en"}),translate:(_l,s)=>s},"./Theme":{useNuriTheme:()=>({ink:"#4A454D",secondary:"#706A74",keyboard:{appearance:"light"}})},"./Primitives":{NuriText:"Text"},"@/src/uiuxfinal/Primitives":{FinalSurface:"Surface",FinalText:"Text"},"./ChatAttachmentTray":{ChatAttachmentTray:"AttachmentTray"},"./composerLayout":load("../src/uiux48/composerLayout.ts")}).NuriComposer;
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

const media=Object.freeze([
 Object.freeze({id:"fixture-photo",kind:"image",uri:"file:///composer-fixture/photo.jpg"}),
 Object.freeze({id:"fixture-video",kind:"video",uri:"file:///composer-fixture/video.mp4",durationMs:12000}),
]);
const eventLines=count=>({nativeEvent:{lines:Array.from({length:count},()=>({height:24,width:150,text:"native text"}))}});
function treePath(node,id,path=[]){if(!node||typeof node!=="object")return null;if(Array.isArray(node)){for(let i=0;i<node.length;i++){const found=treePath(node[i],id,[...path,i]);if(found)return found;}return null;}return node.props?.testID===id?path:treePath(node.props?.children,id,[...path,node.type]);}

test("selected media replaces the header with72pt tray:354x208 card,278pt tray slot,52pt text and contained44pt tools",()=>{
 const f=composer("这是宝宝睡前的照片和视频，\n想请你帮我看看。",{attachments:media}),tree=f.render(),card=f.find("qa-composer"),content=flat(card.props.contentStyle),header=f.find("qa-editor-header"),tray=f.find("qa-attachment-tray"),input=flat(f.find("qa-input").props.style);
 assert.equal(content.paddingHorizontal,16);assert.equal(content.paddingVertical,12);assert.equal(content.gap,8);
 assert.equal(flat(header.props.style).height,72);assert.equal(flat(header.props.style).alignItems,"flex-start");assert.equal(flat(header.props.style).width,"100%");
 assert.ok(nodes(header).includes(tray));assert.equal(tray.props.attachments,media);
 const slot=nodes(header).find(n=>n.props?.style?.height===72&&n.props.style.flex===1);assert.ok(slot);assert.equal(slot.props.style.minWidth,0);
 assert.equal(354-2*content.paddingHorizontal,322);assert.equal(322-flat(f.find("qa-expand").props.style({pressed:false})).width,278);
 assert.equal(input.height,52);assert.equal(input.textAlignVertical,"top");assert.equal(f.find("qa-input").props.scrollEnabled,true);
 assert.equal(24+72+8+input.height+8+flat(f.find("qa-actions").props.style).height,208);
 assert.equal(nodes(tree).filter(n=>n.type==="Surface"&&!n.props.fill).length,1,"No separate attachment capsule or outside media panel");
 assert.deepEqual(nodes(f.find("qa-actions")).filter(n=>n.type==="Pressable").map(n=>n.props.testID),["qa-attach","qa-mic","qa-send-btn"]);
 for(const id of ["qa-expand","qa-attach","qa-mic","qa-send-btn"])assertAsset(imageIn(f.find(id)),20);
 assert.deepEqual(f.calls,[]);f.unmount();
});
test("attachment-only drafts can send, but legacy boolean retains its original capsule and all send guards",()=>{
 const f=composer("   ",{attachments:media});f.render();assert.equal(f.find("qa-composer").props.radius,24);assert.ok(f.find("qa-send-btn"));f.find("qa-send-btn").props.onPress();assert.deepEqual(f.calls,["send"]);
 for(const flag of ["busy","disabled","recording"]){f.props[flag]=true;f.render();assert.equal(f.find("qa-send-btn").props.disabled,true);f.find("qa-send-btn").props.onPress();f.props[flag]=false;}
 assert.deepEqual(f.calls,["send"]);f.unmount();
 const legacy=composer("",{hasAttachment:true});legacy.render();assert.equal(legacy.find("qa-composer").props.radius,999);assert.equal(legacy.find("qa-attachment-tray"),undefined);assert.equal(legacy.find("qa-editor-header"),undefined);legacy.find("qa-send-btn").props.onPress();assert.deepEqual(legacy.calls,["send"]);legacy.unmount();
});
test("controlled removal preserves source array and restores empty, short or multiline normal rules after the last item",()=>{
 for(const value of ["","short","first\nsecond"]){
  const f=composer(value,{attachments:media});f.render();f.find("qa-attachment-tray").props.onRemove(media[0].id);f.render();assert.equal(f.props.attachments.length,1);assert.equal(f.find("qa-input").props.value,value);assert.equal(flat(f.find("qa-input").props.style).height,52);
  f.find("qa-attachment-tray").props.onRemove(media[1].id);f.render();assert.equal(f.find("qa-attachment-tray"),undefined);assert.equal(f.find("qa-input").props.value,value);assert.equal(f.find("qa-composer").props.radius,value.includes("\n")?24:999);assert.equal(flat(f.find("qa-input").props.style).height,value.includes("\n")?80:24);assert.equal(!!f.find("qa-send-btn"),!!value.trim());
  assert.deepEqual(f.calls,[["remove",media[0].id],["remove",media[1].id]]);assert.equal(media.length,2);f.unmount();
 }
 const f=composer("",{attachments:media,hasAttachment:true});f.render();f.props.attachments=[];f.render();assert.equal(f.find("qa-composer").props.radius,999);assert.ok(f.find("qa-send-btn"));f.unmount();
});
test("adding/removing media never remounts the compact native field or alters Chinese composition/caret",()=>{
 const f=composer("中文 nihao composing"),before=f.render(),path=treePath(before,"qa-input"),ref=f.find("qa-input").props.ref;
 for(const attachments of [media,media.slice(1),[]]){f.props.attachments=attachments;const tree=f.render(),input=f.find("qa-input");assert.deepEqual(treePath(tree,"qa-input"),path);assert.equal(input.props.ref,ref);assert.equal(input.props.key,undefined);assert.equal(input.props.selection,undefined);assert.equal(input.props.value,"中文 nihao composing");}
 f.find("qa-input").props.onChangeText("  中文原文\n拼音组合  ");f.render();assert.equal(f.find("qa-input").props.value,"  中文原文\n拼音组合  ");assert.deepEqual(f.calls,[]);f.unmount();
});
test("media viewport sizes cannot create a false normal-text wrap and stale measurements cannot override current draft",()=>{
 const dimensions={width:402,height:874,fontScale:1},f=composer("old long draft",{dimensions});f.render().props.onLayout({nativeEvent:{layout:{width:354}}});f.render();const old=f.find("qa-wrap-measure");
 f.props.value="short";f.props.attachments=media;f.render();old.props.onTextLayout(eventLines(2));f.render();assert.equal(flat(f.find("qa-input").props.style).height,52);assert.equal(flat(f.find("qa-wrap-measure").props.style).width,150);
 f.find("qa-input").props.onContentSizeChange({nativeEvent:{contentSize:{height:52}}});f.render();f.props.attachments=[];f.render();assert.equal(f.find("qa-composer").props.radius,999);
 f.props.attachments=media;f.render();const oldWidth=f.find("qa-wrap-measure");f.render().props.onLayout({nativeEvent:{layout:{width:390}}});f.render();oldWidth.props.onTextLayout(eventLines(2));f.render();const oldFont=f.find("qa-wrap-measure");dimensions.fontScale=1.5;f.render();oldFont.props.onTextLayout(eventLines(2));f.render();f.props.attachments=[];f.render();assert.equal(f.find("qa-composer").props.radius,999);assert.equal(flat(f.find("qa-input").props.style).height,36);assert.deepEqual(f.calls,[]);f.unmount();
});
test("expanded editing retains the controlled media and draft through collapse, Done and remove-last",()=>{
 const f=composer("original 中文 draft",{attachments:media});f.render();f.find("qa-expand").props.onPress();f.render();
 assert.equal(f.kind("Modal").props.visible,true);assert.equal(f.find("qa-expanded-attachment-tray").props.attachments,media);assert.equal(f.find("qa-attachment-tray").props.attachments,media);assert.equal(f.find("qa-expanded-input").props.value,"original 中文 draft");
 f.find("qa-expanded-input").props.onChangeText("更新的\n中文草稿");f.render();f.find("qa-expanded-done").props.onPress();f.render();assert.equal(f.find("qa-input").props.value,"更新的\n中文草稿");assert.equal(f.find("qa-attachment-tray").props.attachments,media);
 f.find("qa-expand").props.onPress();f.render();f.props.attachments=[];f.render();assert.equal(f.find("qa-expanded-attachment-tray"),undefined);assert.equal(f.kind("Modal").props.visible,true);assert.equal(f.find("qa-expanded-input").props.value,"更新的\n中文草稿");f.find("qa-expanded-keyboard-done").props.onPress();f.render();assert.equal(f.kind("Modal").props.visible,false);assert.equal(f.find("qa-input").props.value,"更新的\n中文草稿");assert.deepEqual(f.calls,["dismiss"]);f.unmount();
});
test("compact preview is explicit; expanded preview waits for dismissal and only the first queued media action runs",()=>{
 const f=composer("draft",{attachments:media});f.render();assert.deepEqual(f.calls,[]);f.find("qa-attachment-tray").props.onPreview(media[0]);assert.deepEqual(f.calls,[["preview",media[0].id]]);f.calls.length=0;
 f.find("qa-expand").props.onPress();f.render();const tray=f.find("qa-expanded-attachment-tray");tray.props.onPreview(media[1]);tray.props.onPreview(media[0]);f.render();assert.equal(f.kind("Modal").props.visible,false);assert.deepEqual(f.calls,["dismiss"]);f.kind("Modal").props.onDismiss();assert.deepEqual(f.calls,["dismiss",["preview",media[1].id]]);f.kind("Modal").props.onDismiss();assert.equal(f.calls.length,2);assert.equal(f.find("qa-input").props.value,"draft");assert.equal(f.props.attachments,media);f.unmount();
});
test("queued preview revalidates current attachment identity and busy state before invoking the owner",()=>{
 for(const change of ["removed","busy"]){const f=composer("draft",{attachments:media});f.render();f.find("qa-expand").props.onPress();f.render();f.find("qa-expanded-attachment-tray").props.onPreview(media[0]);if(change==="removed")f.props.attachments=media.slice(1);else f.props.busy=true;f.render();f.kind("Modal").props.onDismiss();assert.deepEqual(f.calls,["dismiss"]);f.unmount();}
 const f=composer("draft",{attachments:media,onRemoveAttachment:undefined,onPreviewAttachment:undefined});f.render();f.find("qa-attachment-tray").props.onRemove(media[0].id);f.find("qa-attachment-tray").props.onPreview(media[0]);assert.equal(f.props.attachments,media);assert.deepEqual(f.calls,[]);f.unmount();
});
test("web expanded media handoff stays synchronous and does not lose the source draft",()=>{
 const f=composer("draft",{attachments:media,os:"web"});f.render();f.find("qa-expand").props.onPress();f.render();f.find("qa-expanded-attachment-tray").props.onPreview(media[1]);assert.deepEqual(f.calls,["dismiss",["preview",media[1].id]]);f.render();assert.equal(f.kind("Modal").props.visible,false);assert.equal(f.find("qa-input").props.value,"draft");f.unmount();
});
test("Android fallback and native onDismiss cannot double-present media, and unmount cancels a queued action",async()=>{
 const f=composer("draft",{attachments:media,os:"android"});f.render();f.find("qa-expand").props.onPress();f.render();f.find("qa-expanded-attachment-tray").props.onPreview(media[0]);f.render();await new Promise(resolve=>setTimeout(resolve,380));assert.deepEqual(f.calls,["dismiss",["preview",media[0].id]]);f.kind("Modal").props.onDismiss();assert.equal(f.calls.length,2);f.unmount();
 const g=composer("draft",{attachments:media,os:"android"});g.render();g.find("qa-expand").props.onPress();g.render();g.find("qa-expanded-attachment-tray").props.onPreview(media[0]);g.render();g.unmount();await new Promise(resolve=>setTimeout(resolve,380));g.kind("Modal").props.onDismiss();assert.deepEqual(g.calls,["dismiss"]);
});
test("plus supplies exact60pt window bounds or a centered60pt anchor from panel44pt bounds",()=>{
 for(const attached of [false,true]){const f=composer("",{attachments:attached?media:undefined});f.props.onAttach=anchor=>f.calls.push(["anchor",anchor]);f.render();const target=attached?f.find("qa-attach"):f.all().find(n=>n.type==="View"&&n.props.ref&&n.props.style?.width===60);assert.equal(target.props.collapsable,false);target.props.ref.current={measureInWindow:fn=>fn(40,470,attached?44:60,attached?44:60)};f.find("qa-attach").props.onPress();assert.deepEqual(f.calls,[["anchor",{x:attached?32:40,y:attached?462:470,width:60,height:60}]]);f.unmount();}
 const f=composer("draft",{attachments:media});f.props.onAttach=anchor=>f.calls.push(["anchor",anchor]);f.render();f.find("qa-expand").props.onPress();f.render();f.find("qa-expanded-attach").props.ref.current={measureInWindow:fn=>fn(24,500,44,44)};f.find("qa-expanded-attach").props.onPress();f.render();assert.deepEqual(f.calls,["dismiss"]);f.kind("Modal").props.onDismiss();assert.deepEqual(f.calls,["dismiss",["anchor",{x:16,y:492,width:60,height:60}]]);f.unmount();
});
test("late native anchor measurement is ignored after unmount",()=>{
 const f=composer();f.render();let callback;const target=f.all().find(n=>n.type==="View"&&n.props.ref&&n.props.style?.width===60);target.props.ref.current={measureInWindow:fn=>callback=fn};f.find("qa-attach").props.onPress();f.unmount();callback(10,20,60,60);assert.deepEqual(f.calls,[]);
});
test("web plus waits for delayed exact window bounds and opens the popover once for empty, typed and panel layouts",()=>{
 for(const scenario of [{value:"",bounds:[27,772,60,60],expected:{x:27,y:772,width:60,height:60}},{value:"typed draft",bounds:[24,772,60,60],expected:{x:24,y:772,width:60,height:60}},{value:"",attachments:media,bounds:[40,616,44,44],expected:{x:32,y:608,width:60,height:60}}]){
  const f=composer(scenario.value,{os:"web",attachments:scenario.attachments});f.props.onAttach=anchor=>f.calls.push(["anchor",anchor]);f.render();let later;
  const target=scenario.attachments?f.find("qa-attach"):f.all().find(n=>n.type==="View"&&n.props.ref&&n.props.style?.width===60);target.props.ref.current={measureInWindow:fn=>later=fn};
  f.find("qa-attach").props.onPress();assert.deepEqual(f.calls,[],"plus must not preempt deferred measurement with a guessed anchor");later(...scenario.bounds);later(0,0,60,60);assert.deepEqual(f.calls,[["anchor",scenario.expected]]);assert.equal(f.find("qa-input").props.value,scenario.value);assert.equal(f.props.attachments,scenario.attachments);f.unmount();
 }
});
test("delayed web expanded-plus retains the draft until measurement, then closes its editor before presenting the measured popover",()=>{
 const f=composer("中文 draft",{os:"web",attachments:media});f.props.onAttach=anchor=>f.calls.push(["anchor",anchor]);f.render();f.find("qa-expand").props.onPress();f.render();let later;f.find("qa-expanded-attach").props.ref.current={measureInWindow:fn=>later=fn};f.find("qa-expanded-attach").props.onPress();assert.deepEqual(f.calls,[]);assert.equal(f.kind("Modal").props.visible,true);later(24,500,44,44);later(100,100,44,44);f.render();assert.deepEqual(f.calls,["dismiss",["anchor",{x:16,y:492,width:60,height:60}]]);assert.equal(f.kind("Modal").props.visible,false);assert.equal(f.find("qa-input").props.value,"中文 draft");assert.equal(f.props.attachments,media);f.unmount();
});
test("delayed web measurements recheck current busy, disabled and mounted guards; a missing ref retains owner fallback",()=>{
 for(const state of ["busy","disabled","unmounted"]){const f=composer("",{os:"web"});f.render();let later;f.all().find(n=>n.type==="View"&&n.props.ref&&n.props.style?.width===60).props.ref.current={measureInWindow:fn=>later=fn};f.find("qa-attach").props.onPress();if(state==="unmounted")f.unmount();else{f.props[state]=true;f.render();}later(27,772,60,60);assert.deepEqual(f.calls,[]);if(state!=="unmounted")f.unmount();}
 const f=composer("",{os:"web"});f.render();f.find("qa-attach").props.onPress();assert.deepEqual(f.calls,["attach"]);f.unmount();
});
test("a stale send handler cannot send removed media or bypass current busy state",()=>{
 const f=composer("",{attachments:media});f.render();const old=f.find("qa-send-btn").props.onPress;f.props.attachments=[];f.render();old();assert.deepEqual(f.calls,[]);f.props.attachments=media;f.render();const prior=f.find("qa-send-btn").props.onPress;f.props.busy=true;f.render();prior();assert.deepEqual(f.calls,[]);f.unmount();
});
test("media layout preserves legacy80pt text and scales the new52pt editor without moving controls outside its card",()=>{
 const {composerLayout:normal,composerAttachmentLayout:layout,composerAttachmentAnchor:anchor,COMPOSER_ATTACHMENT_CHROME:chrome}=load("../src/uiux48/composerLayout.ts");assert.equal(normal(1,416).roomyInputHeight,80);assert.equal(chrome,156);assert.equal(layout(1,416).cardHeight,208);assert.equal(layout(1,416).inputHeight,52);
 for(const scale of [1,1.5,2,2.8])for(const available of [0,160,180,200,220,300,416,600]){const g=layout(scale,available);assert.ok(g.inputHeight>=g.lineHeight);assert.equal(g.cardHeight,24+72+8+g.inputHeight+8+44);assert.equal(g.fitsAvailable,available>=g.minimumHeight);if(g.fitsAvailable)assert.ok(g.cardHeight<=available);else assert.equal(g.cardHeight,g.minimumHeight);}
 assert.deepEqual(anchor({x:20,y:30,width:44,height:44}),{x:12,y:22,width:60,height:60});for(const bad of [NaN,Infinity,0,-1])assert.equal(anchor({x:0,y:0,width:bad,height:44}),undefined);
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
