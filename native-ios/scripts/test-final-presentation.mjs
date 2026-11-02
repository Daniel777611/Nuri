import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import ts from "typescript";
const tick=()=>new Promise(r=>setImmediate(r));
function load(path,deps={}){const m={exports:{}};new Function("require","module","exports",ts.transpileModule(readFileSync(path,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(name=>{if(name.startsWith("@/assets/"))return name;assert.ok(name in deps,"Unexpected dependency "+name);return deps[name];},m,m.exports);return m.exports;}
const jsx=(type,props)=>({type,props});
const runtime={jsx,jsxs:jsx};
const walk=n=>!n||typeof n!=="object"?[]:Array.isArray(n)?n.flatMap(walk):[n,...walk(n.props?.children)];
function hooks(){let cursor=0,tree;const slots=[],pending=[];const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));const react={createContext:()=>({Provider:"Provider"}),useState(initial){const i=cursor++;slots[i]??={value:typeof initial==="function"?initial():initial};return[slots[i].value,v=>slots[i].value=typeof v==="function"?v(slots[i].value):v];},useRef(initial){const i=cursor++;return slots[i]??={current:initial};},useMemo(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))slots[i]={deps,value:fn()};return slots[i].value;},useCallback(fn,deps){return react.useMemo(()=>fn,deps);},useEffect(fn,deps){const i=cursor++;if(!same(slots[i]?.deps,deps))pending.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};return{react,render(C,props){cursor=0;tree=C(props);pending.splice(0).forEach(fn=>fn());return tree;},find:id=>walk(tree).find(n=>n.props?.testID===id)};}
function languageFixture(map=new Map(),delay=null){const h=hooks();let language="zh-Hant-TW";const listeners=new Set(),calls=[];const module=load("src/i18n/index.tsx",{react:h.react,"react/jsx-runtime":runtime,"react-native":{Platform:{OS:"ios"},Settings:{get:key=>key==="AppleLanguages"?[language]:language},AppState:{addEventListener:(_event,fn)=>{listeners.add(fn);return{remove:()=>listeners.delete(fn)};}}},"@/src/utils/storage":{storage:{getItem:async(key,fallback)=>map.get(key)??fallback,setItem:async(key,value)=>{calls.push([key,value]);if(delay)await delay(key,value);map.set(key,value);return true;}}},"./en":{en:{}},"./zh-TW":{zhTW:{}}});return{...h,module,map,calls,render:()=>h.render(module.I18nProvider,{children:null}).props.value,activate(next){language=next;listeners.forEach(fn=>fn("active"));}};}
test("actual provider follows device language, retains explicit system mode through account hydration, and switches on activation",async()=>{
 const f=languageFixture(new Map([["ui_language_mode","system"],["ui_language","en"]]));f.render();await tick();let v=f.render();assert.equal(v.locale,"zh-TW");assert.equal(v.languageMode,"system");
 await v.setLocale("en");v=f.render();assert.equal(v.locale,"zh-TW");assert.equal(v.languageMode,"system");
 f.activate("en-US");await tick();v=f.render();assert.equal(v.locale,"en");await v.chooseLanguage("zh-CN");v=f.render();assert.equal(v.languageMode,"zh-CN");assert.equal(v.locale,"zh-CN");
 f.activate("en-US");await tick();assert.equal(f.render().locale,"zh-CN");
});
test("older language writes are serialized: an in-flight old choice cannot overwrite the last choice on disk or UI",async()=>{
 let release;const gate=new Promise(r=>release=r);let held=false;
 const f=languageFixture(new Map(),async(key,value)=>{if(!held&&key==="ui_language"&&value==="en"){held=true;await gate;}});f.render();await tick();const v=f.render();
 const first=v.chooseLanguage("en").then(()=>"ok",e=>e.message);await tick();const second=v.chooseLanguage("zh-TW");release();assert.equal(await first,"LANGUAGE_SELECTION_SUPERSEDED");await second;
 const latest=f.render();assert.equal(latest.locale,"zh-TW");assert.equal(latest.languageMode,"zh-TW");assert.equal(f.map.get("ui_language"),"zh-TW");assert.equal(f.map.get("ui_language_mode"),"zh-TW");
});
test("date dialog edits any historical year, validates real dates, and never commits on render/cancel",()=>{
 const h=hooks(),calls=[];const dates=load("src/child-age.ts");const C=load("src/uiuxfinal/ChildDateDialog.tsx",{react:h.react,"react/jsx-runtime":runtime,"react-native":{Modal:"Modal",TextInput:"TextInput",View:"View",KeyboardAvoidingView:"KAV",Platform:{OS:"ios"}},"expo-blur":{BlurView:"Blur"},"@/src/i18n":{useT:()=>({locale:"en"}),translate:(_l,s)=>s},"@/src/child-age":dates,"./Primitives":{FinalButton:"Button",FinalSurface:"Surface",FinalText:"Text",FINAL_COLOR:{ink:"#4A454D"}}}).ChildDateDialog;
 const props={value:"2024-02-29",expecting:false,onClose:()=>calls.push("close"),onConfirm:value=>calls.push(value)};h.render(C,props);assert.deepEqual(calls,[]);
 h.find("child-date-part-0").props.onChangeText("1900");h.render(C,props);assert.equal(h.find("child-date-confirm").props.disabled,true);
 h.find("child-date-part-2").props.onChangeText("28");h.render(C,props);assert.equal(h.find("child-date-confirm").props.disabled,false);h.find("child-date-confirm").props.onPress();assert.deepEqual(calls,["1900-02-28"]);
 h.find("child-date-part-0").props.onChangeText("0001");h.render(C,props);assert.equal(h.find("child-date-confirm").props.disabled,false);
 h.find("child-date-part-0").props.onChangeText("9999");h.render(C,props);assert.equal(h.find("child-date-confirm").props.disabled,true);
});
test("merged article preserves supplied summary/disclosure and only runs source/chat callbacks after taps",async()=>{
 const h=hooks(),calls=[];const C=load("src/uiuxfinal/Article.tsx",{react:h.react,"react/jsx-runtime":runtime,"react-native":{ActivityIndicator:"Loading",Pressable:"Pressable",ScrollView:"Scroll",View:"View"},"expo-image":{Image:"Image"},"@/src/uiux48/Primitives":{IconAction:"IconAction",NuriIcon:"Icon"},"@/src/uiux48/Scene":{NuriAvatar:"Avatar"},"@/src/i18n":{useT:()=>({locale:"en"}),translate:(_l,s)=>s},"./Primitives":{FinalDivider:"Divider",FinalSurface:"Surface",FinalText:"Text",FINAL_COLOR:{accent:"#735c84"}}}).FinalArticle;
 const props={title:"Supplied title",source:"Source",summary:"Supplied summary",points:["Supplied point"],notes:["Provenance warning"],onSource:()=>calls.push("source"),onTalk:async()=>calls.push("chat"),busy:false,allowSavePreview:true};
 h.render(C,props);assert.deepEqual(calls,[]);assert.equal(h.find("daily-post-summary-situation").props.children,"Supplied summary");assert.equal(h.find("daily-post-summary-disclosure").props.children,"Provenance warning");
 h.find("final-article-save-preview").props.onPress();h.render(C,props);assert.ok(h.find("final-article-save-note"));assert.deepEqual(calls,[]);
 h.find("daily-post-source").props.onPress();await h.find("daily-post-chat").props.onPress();assert.deepEqual(calls,["source","chat"]);
 assert.doesNotMatch(readFileSync("src/uiuxfinal/Article.tsx","utf8"),/\bfetch\(|from.*(?:\/api|auth|storage)/);
});
