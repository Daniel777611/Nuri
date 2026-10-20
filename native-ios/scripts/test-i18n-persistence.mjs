import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import ts from 'typescript';
import {en,zhTW} from './i18n-test-utils.mjs';
function fixture(){
 let locale='zh-CN',fail=false;const writes=[];
 const deps={react:{createContext:()=>({Provider:'Provider'}),useEffect:()=>{},useState:()=>[locale,value=>{locale=value;}],useCallback:fn=>fn,useMemo:fn=>fn()},
  'react/jsx-runtime':{jsx:(type,props)=>({type,props})},'./en':{en},'./zh-TW':{zhTW},
  '@/src/utils/storage':{storage:{getItem:async()=>'',setItem:async(key,value)=>{writes.push([key,value]);return !fail;}}}};
 const js=ts.transpileModule(readFileSync(new URL('../src/i18n/index.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const m={exports:{}};new Function('require','module','exports',js)(name=>{assert.ok(name in deps);return deps[name];},m,m.exports);
 return {writes,fail:()=>{fail=true;},success:()=>{fail=false;},locale:()=>locale,value:()=>m.exports.I18nProvider({children:null}).props.value};
}
test('actual I18nProvider updates only after successful native storage and accepts Traditional aliases',async()=>{
 const f=fixture();await f.value().setLocale('zh-Hant');assert.equal(f.locale(),'zh-TW');assert.equal(f.value().locale,'zh-TW');
 assert.equal(f.writes.at(-1)[1],'zh-TW');await f.value().setLocale('en');assert.equal(f.locale(),'en');
});
test('actual storage false rejects language save without publishing a false UI success; retry remains usable',async()=>{
 const f=fixture();f.fail();await assert.rejects(f.value().setLocale('zh-TW'),/LOCAL_LANGUAGE_SAVE_FAILED/);assert.equal(f.locale(),'zh-CN');
 f.success();await f.value().setLocale('zh-TW');assert.equal(f.locale(),'zh-TW');
});
