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
function composer(initial={}){
 const slots=[];let cursor=0;let tree;const calls=[];let props={value:"",onChangeText:v=>{props.value=v;},onSend:()=>calls.push("send"),onAttach:()=>calls.push("attach"),onMic:()=>calls.push("mic"),testID:"qa",...initial};
 const react={useRef(value){const i=cursor++;return slots[i]??={current:value};},useId(){const i=cursor++;return slots[i]??= "composer-"+(++sequence);},useState(value){const i=cursor++;if(!(i in slots))slots[i]=value;return[slots[i],v=>{slots[i]=typeof v==="function"?v(slots[i]):v;}];}};
 const jsx=(type,props)=>({type,props});
 const Component=load("../src/uiux48/Composer.tsx",{react,"react/jsx-runtime":{jsx,jsxs:jsx},"react-native":{InputAccessoryView:"Accessory",Keyboard:{dismiss(){}},KeyboardAvoidingView:"KAV",Modal:"Modal",Platform:{OS:"ios"},Pressable:"Pressable",StyleSheet:{create:x=>x},TextInput:"Input",View:"View"},"react-native-safe-area-context":{useSafeAreaInsets:()=>({top:62,bottom:34})},"@/src/i18n":{useT:()=>({locale:"en"})},"./Theme":{useNuriTheme:()=>({secondary:"#aaa",ink:"#333",coral:"#eb8183",composer:"#fff"})},"./Primitives":{GlassSurface:"Glass",IconAction:"IconAction",NuriButton:"Button",NuriText:"Text"}}).NuriComposer;
 const render=()=>{cursor=0;tree=Component(props);return tree;};
 return{render,calls,props,find:id=>nodes(tree).find(n=>n.props?.testID===id),kind:type=>nodes(tree).find(n=>n.type===type)};
}
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
