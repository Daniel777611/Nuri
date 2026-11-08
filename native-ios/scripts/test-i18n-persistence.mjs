import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
import {en,zhTW} from './i18n-test-utils.mjs';
function fixture(){
 let cursor=0,fail=false;const writes=[],slots=[],effects=[],values=new Map();
 const deps={react:{createContext:()=>({Provider:'Provider'}),useEffect:(fn,dependencies)=>{const i=cursor++;if(!effects[i])effects[i]={cleanup:fn(),dependencies};},
 useState:initial=>{const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};slots[i].set??=value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;};return[slots[i].value,slots[i].set];},
 useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},useCallback:fn=>{cursor++;return fn;},useMemo:fn=>{cursor++;return fn();}},
  'react-native':{Platform:{OS:'ios'},Settings:{get:key=>key==='AppleLanguages'?['en-US']:'en_US'},AppState:{currentState:'active',addEventListener:()=>({remove(){}})}},
  'react/jsx-runtime':{jsx:(type,props)=>({type,props})},'./en':{en},'./zh-TW':{zhTW},
  '@/src/utils/storage':{storage:{getItem:async(key,fallback)=>values.get(key)??fallback,setItem:async(key,value)=>{writes.push([key,value]);if(fail)return false;values.set(key,value);return true;}}}};
 const js=ts.transpileModule(readFileSync(new URL('../src/i18n/index.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const m={exports:{}};new Function('require','module','exports',js)(name=>{assert.ok(name in deps);return deps[name];},m,m.exports);
 const value=()=>{cursor=0;return m.exports.I18nProvider({children:null}).props.value;};
 return {writes,values,normalize:m.exports.normalizeLocale,fail:()=>{fail=true;},success:()=>{fail=false;},locale:()=>value().locale,value};
}
test('actual I18nProvider explicit choices update only after native storage and retain Traditional alias normalization',async()=>{
 const f=fixture();assert.equal(f.value().languageMode,'system');assert.equal(f.locale(),'en');
 await f.value().chooseLanguage(f.normalize('zh-Hant'));assert.equal(f.locale(),'zh-TW');assert.equal(f.value().locale,'zh-TW');
 assert.equal(f.values.get('ui_language'),'zh-TW');assert.equal(f.values.get('ui_language_mode'),'zh-TW');
 await f.value().setLocale('zh-CN');assert.equal(f.locale(),'zh-TW','account hydration cannot replace the explicit local mode');
 await f.value().chooseLanguage('en');assert.equal(f.locale(),'en');assert.equal(f.values.get('ui_language_mode'),'en');
});
test('actual storage false rejects language save without publishing a false UI success; retry remains usable',async()=>{
 const f=fixture();f.value();f.fail();await assert.rejects(f.value().chooseLanguage('zh-TW'),/LOCAL_LANGUAGE_SAVE_FAILED/);assert.equal(f.locale(),'en');assert.equal(f.value().languageMode,'system');assert.equal(f.values.has('ui_language_mode'),false);
 f.success();await f.value().chooseLanguage('zh-TW');assert.equal(f.locale(),'zh-TW');assert.equal(f.value().languageMode,'zh-TW');
});
