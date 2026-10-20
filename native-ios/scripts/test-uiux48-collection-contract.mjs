import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import ts from "typescript";
const module={exports:{}};
new Function("module","exports",ts.transpileModule(readFileSync("src/collectionActions.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module,module.exports);
const {validCollectionName,assignFavoriteCollection,removeSavedFavorite}=module.exports;
const id="fixture-card",group="fixture-group";
const fixture=({items=[{id,collection_id:null}],save={saved:true,card_id:id,collection_id:group},remove={favorited:false,card_id:id}}={})=>{
 const writes=[];return{writes,listFavorites:async()=>items,saveFavorite:async(...args)=>{writes.push(["save",...args]);return save;},toggleFavorite:async(...args)=>{writes.push(["remove",...args]);return remove;}};
};
test("collection names match server's 1..20 Unicode-code-point bound without losing input",()=>{
 for(const text of ["","   ","中".repeat(21),"🙂".repeat(21)])assert.equal(validCollectionName(text),null);
 for(const text of ["a","中".repeat(20),"🙂".repeat(20)])assert.equal(validCollectionName(`  ${text}  `),text);
});
test("Done on the existing collection never invokes the backend's destructive toggle",async()=>{
 const f=fixture({items:[{id,collection_id:group}]});await assignFavoriteCollection(id,group,f,()=>true);assert.deepEqual(f.writes,[]);
});
test("a confirmed move uses the exact card and collection identities",async()=>{
 const f=fixture();await assignFavoriteCollection(id,group,f,()=>true);assert.deepEqual(f.writes,[["save",id,group]]);
});
test("removed/stale content is not silently recreated by collection assignment",async()=>{
 const f=fixture({items:[]});await assert.rejects(assignFavoriteCollection(id,group,f,()=>true),/NO_LONGER_SAVED/);assert.deepEqual(f.writes,[]);
});
test("false/malformed/wrong-ID assignment results never become a saved receipt or automatic retry",async()=>{
 for(const save of [null,{}, {saved:false,card_id:id,collection_id:group},{saved:true,card_id:"other",collection_id:group},{saved:true,card_id:id,collection_id:"other"}]){
  const f=fixture({save});await assert.rejects(assignFavoriteCollection(id,group,f,()=>true),/UNCONFIRMED/);assert.equal(f.writes.length,1);
 }
});
test("cancel/remove is a no-op when a fresh read already confirms absence",async()=>{
 const f=fixture({items:[]});await removeSavedFavorite(id,f,()=>true);assert.deepEqual(f.writes,[]);
 const g=fixture();await removeSavedFavorite(id,g,()=>true);assert.deepEqual(g.writes,[["remove",id]]);
});
test("unexpected toggle result cannot be shown as confirmed removal",async()=>{
 const f=fixture({remove:{favorited:true,card_id:id}});await assert.rejects(removeSavedFavorite(id,f,()=>true),/UNCONFIRMED/);assert.equal(f.writes.length,1);
});
test("account change during either read prevents a subsequent mutation under the newer identity",async()=>{
 for(const operation of ["assign","remove"]){
  let release;let current=true;const f=fixture();f.listFavorites=()=>new Promise(resolve=>{release=()=>resolve([{id}]);});
  const pending=operation==="assign"?assignFavoriteCollection(id,group,f,()=>current):removeSavedFavorite(id,f,()=>current);
  current=false;release();await assert.rejects(pending,/SESSION_CHANGED/);assert.deepEqual(f.writes,[]);
 }
});
