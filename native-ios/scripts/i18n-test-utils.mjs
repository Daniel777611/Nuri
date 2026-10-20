import {readFileSync} from 'node:fs';
import ts from 'typescript';
// Test harnesses use the real production dictionaries and translator. Only
// React/storage are isolated; no server, account, or permission is accessed.
function load(path,deps={}) {
  const module={exports:{}};
  const js=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}
  }).outputText;
  new Function('require','module','exports',js)(name=>{
    if(!(name in deps))throw Error('Unexpected i18n fixture dependency '+name);
    return deps[name];
  },module,module.exports);
  return module.exports;
}
export const en=load('../src/i18n/en.ts').en;
export const zhTW=load('../src/i18n/zh-TW.ts').zhTW;
export const i18n=load('../src/i18n/index.tsx',{
  react:{createContext:value=>({value,Provider:'I18nProvider'})},
  'react/jsx-runtime':{},'@/src/utils/storage':{storage:{}},'./en':{en},'./zh-TW':{zhTW}
});
export const translate=i18n.translate;
