import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,readdirSync,writeFileSync} from "node:fs";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";
const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48",source_snapshot=sourceSnapshot();
const build=JSON.parse(readFileSync(out+"/real-api-build-results/summary.json","utf8"));
assert.equal(build.results.length,3);for(const b of build.results){assert.equal(b.exit,0);assert.equal(b.source_snapshot.sha256,source_snapshot.sha256);assert.equal(b.source_unchanged_during_build,true);assert.equal(b.fixture_mode,false);}
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+"/"+e.name):[dir+"/"+e.name]);
const paths=[...walk("build/uiux48-real-api-web").filter(p=>p.endsWith(".js")),... ["iphoneos","iphonesimulator"].flatMap(p=>[`build/uiux48-real-api-derived/Build/Products/Release-${p}/main.jsbundle`,`build/uiux48-real-api-derived/Build/Products/Release-${p}/NURINativeLab.app/main.jsbundle`])];
const forbidden=["NURI_UIUX48_ISOLATED_GALLERY_20261019","GALLERY_SCREENS","DEVELOPMENT FIXTURE — no real people, sends, matches or history."];
const files=paths.map(path=>{const buffer=readFileSync(path),found=forbidden.filter(s=>buffer.includes(Buffer.from(s)));assert.deepEqual(found,[],path+" contains development fixture code");return{path,bytes:buffer.length,sha256:createHash("sha256").update(buffer).digest("hex"),forbidden_markers_found:found};});
writeFileSync(out+"/continuation-release-exclusion.json",JSON.stringify({checked_at:new Date().toISOString(),source_snapshot,source_unchanged_during_check:sourceSnapshot().sha256===source_snapshot.sha256,files,forbidden_markers:forbidden,actual_native_and_web_artifacts_checked:true,fixture_graph_excluded:true,release_route_inert:true,native_interaction_verified:false,signed_archive:false,uploaded:false},null,2));console.log(JSON.stringify({files_checked:files.length,fixture_graph_excluded:true,source_snapshot}));
