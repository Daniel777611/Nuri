import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import ts from "typescript";
import {chromium} from "@playwright/test";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";

const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48";
const source_snapshot=sourceSnapshot();
const manifest=JSON.parse(readFileSync(out+"/approved-shadow-assets-ef01abd3/shadow-manifest.json","utf8"));
const receipt=JSON.parse(readFileSync(out+"/mac-shadow-import-receipt.json","utf8"));
const source=ts.transpileModule(readFileSync("src/uiux48/sceneGeometry.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const geometryModule={exports:{}};new Function("exports",source)(geometryModule.exports);
const geometry=geometryModule.exports.SCENE48;
const sceneSource=readFileSync("src/uiux48/Scene.tsx","utf8");
const assets=[],scenes=[],composers=[],failures=[],page_errors=[];
assert.equal(manifest.assets.length,6);assert.equal(manifest.intendedBlendMode,"MULTIPLY");
assert.deepEqual(manifest.canvas,{width:402,height:874});
assert.equal(receipt.archiveSha256,"ef01abd325cbd8d278e12cb800ca4cc4b1be27f64745ddafc990850f446fa6ca");
assert.doesNotMatch(sceneSource,/\bskew|\brotate|scaleX|scaleY|1\.149/);
for(const asset of manifest.assets){
 const imported=readFileSync(out+"/approved-shadow-assets-ef01abd3/"+asset.file);
 const integrated=readFileSync("assets/uiux48/approved-shadows/"+asset.file);
 const sha=b=>createHash("sha256").update(b).digest("hex");
 assert.equal(sha(imported),asset.sha256);assert.equal(sha(integrated),asset.sha256);
 assert.equal(imported.length,asset.byteLength);assert.equal(integrated.length,asset.byteLength);
 assert.equal(integrated.readUInt32BE(16),asset.pixelWidth);assert.equal(integrated.readUInt32BE(20),asset.pixelHeight);
 assert.equal(integrated[25],6,"RGBA PNG required");
 assert.equal(sha(integrated),receipt.assets.find(x=>x.file===asset.file).sha256);
 const actual=geometry[asset.scene][asset.mode];
 assert.deepEqual(actual.shadow,asset.logicalPlacement);
 const {name,...actor}=asset.actorPlacements[0];assert.deepEqual(actual.actor,actor);
 assert.ok(sceneSource.includes('approved-shadows/'+asset.file));
 assets.push({scene:asset.scene,mode:asset.mode,file:asset.file,sha256:sha(integrated),bytes:integrated.length,logical_placement:actual.shadow,actor_placement:actual.actor});
}
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
try{for(const mode of ["Morning","Afternoon","Night"])for(const locale of ["zh-CN","en"]){
 const c=await browser.newContext({viewport:{width:390,height:844}});
 await c.route("**/*",r=>["127.0.0.1","localhost"].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 const p=await c.newPage();p.setDefaultTimeout(20000);p.setDefaultNavigationTimeout(60000);
 p.on("pageerror",error=>page_errors.push({mode,locale,error:error.message}));
 const url=path=>`${process.env.UIUX48_PREVIEW_ORIGIN??"http://127.0.0.1:8082"}${path}${path.includes("?")?"&":"?"}theme=${mode}&lang=${locale}`;
 const settle=async()=>{await p.getByTestId(`nuri-shell-${mode}`).waitFor();await p.evaluate(()=>document.fonts.ready);await p.locator("img").evaluateAll(a=>Promise.all(a.map(x=>x.decode().catch(()=>{}))));};
 const measureScene=async role=>{
  await settle();const asset=manifest.assets.find(x=>x.scene===role&&x.mode===mode);
  const shadow=p.getByTestId(`${role}-ground-shadow`),actor=p.getByTestId(`${role}-mascot`);
  assert.equal(await shadow.count(),1);assert.equal(await actor.count(),1);
  const shadowBox=await shadow.boundingBox(),actorBox=await actor.boundingBox(),scale=390/402;
  for(const [node,expected]of [[shadowBox,asset.logicalPlacement],[actorBox,asset.actorPlacements[0]]]){
   for(const [css,key]of [["x","left"],["y","top"],["width","width"],["height","height"]])assert.ok(Math.abs(node[css]-expected[key]*scale)<1,`${role} ${css} must match approved manifest`);
  }
  const rendered=await shadow.evaluate((el,actorId)=>{
   const style=getComputedStyle(el),canvas=getComputedStyle(el.parentElement);
   const actor=document.querySelector(`[data-testid="${actorId}"]`);
   const images=[...el.querySelectorAll("img")].map(x=>x.currentSrc||x.src);
   const backgrounds=[el,...el.querySelectorAll("*")].map(x=>getComputedStyle(x).backgroundImage);
   return{opacity:style.opacity,blend_mode:style.mixBlendMode,canvas_width:canvas.width,canvas_height:canvas.height,transform_origin:canvas.transformOrigin,transform:canvas.transform,shadow_before_actor:!!(el.compareDocumentPosition(actor)&Node.DOCUMENT_POSITION_FOLLOWING),image_sources:images,backgrounds,viewport_width:innerWidth,scroll_width:document.documentElement.scrollWidth};
  },`${role}-mascot`);
  assert.equal(rendered.opacity,"1");assert.equal(rendered.blend_mode,"multiply");
  assert.equal(rendered.canvas_width,"402px");assert.equal(rendered.canvas_height,"874px");
  assert.equal(rendered.transform_origin,"0px 0px");assert.ok(rendered.shadow_before_actor);
  assert.ok([...rendered.image_sources,...rendered.backgrounds].some(x=>x.includes(asset.file)),"Exact approved PNG must render");
  assert.equal(rendered.viewport_width,390);assert.ok(rendered.scroll_width<=391);
  const screenshot=`${out}/screenshots/shadow-followup-${role}-${mode}-${locale}.png`;await p.screenshot({path:screenshot});
  scenes.push({role,mode,locale,shadow_box:shadowBox,actor_box:actorBox,rendered,screenshot,fixture_only:true});
 };
 const measureComposer=async prefix=>{
  const draft=locale==="en"?"First line\nSecond line\nThird line":"第一行\n第二行\n第三行";
  const input=p.getByTestId(prefix+"-input");await input.fill(draft);
  await p.waitForFunction(id=>Math.abs(document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().height-72)<1,prefix+"-input");
  const compact={input_box:await input.boundingBox()};
  for(const control of ["attach","mic","send-btn"]){const element=p.getByTestId(`${prefix}-${control}`);assert.ok(await element.isVisible());compact[control]=await element.boundingBox();}
  await p.getByTestId(prefix+"-expand").click();
  const expandedId=prefix+"-expanded-composer";
  await p.waitForFunction(id=>{const e=document.querySelector(`[data-testid="${id}"]`);if(!e)return false;const r=e.getBoundingClientRect();return r.height>=207&&r.top>=0&&r.bottom<=innerHeight-11.5;},expandedId);
  const panel=p.getByTestId(expandedId),expanded={panel_box:await panel.boundingBox()};
  for(const control of ["attach","mic","send-btn"]){
   const element=panel.getByTestId(`${prefix}-expanded-${control}`),count=await element.count();assert.equal(count,1);assert.ok(await element.isVisible());
   const box=await element.boundingBox();assert.ok(box.width>=44&&box.height>=44);assert.ok(box.y>=expanded.panel_box.y&&box.y+box.height<=expanded.panel_box.y+expanded.panel_box.height+1);
   expanded[control]={count,box};
  }
  assert.equal(await p.getByTestId(prefix+"-expanded-input").inputValue(),draft);
  const screenshot=`${out}/screenshots/composer-followup-${prefix}-${mode}-${locale}.png`;await p.screenshot({path:screenshot});
  await p.getByTestId(prefix+"-expanded-done").click();await panel.waitFor({state:"hidden"});
  assert.equal(await input.inputValue(),draft);
  composers.push({prefix,mode,locale,compact,expanded,draft_preserved:true,screenshot,fixture_only:true,native_keyboard_verified:false});
 };
 try{
  await p.goto(url("/welcome"),{waitUntil:"domcontentloaded"});await measureScene("welcome");
  await p.goto(url("/login"),{waitUntil:"domcontentloaded"});await p.getByTestId("login-email").fill("parent@example.com");await p.getByTestId("login-password").fill("preview-only");await p.getByTestId("login-submit-btn").click();await p.getByTestId("home-settings").waitFor();
  await p.goto(url("/ai-permission?returnTo=%2F(tabs)"),{waitUntil:"domcontentloaded"});await p.getByTestId("ai-permission-allow").click();await p.getByTestId("home-settings").waitFor();
  await measureScene("home");await measureComposer("home");
  await p.goto(url("/chat/chat-1"),{waitUntil:"domcontentloaded"});await settle();await measureComposer("chat");
  console.log(`${mode} ${locale}: welcome/home shadows and both expanded composers PASS`);
 }catch(error){const screenshot=`${out}/screenshots/shadow-composer-failure-${mode}-${locale}.png`;await p.screenshot({path:screenshot});failures.push({mode,locale,error:String(error),screenshot});console.log(`${mode} ${locale}: FAIL ${String(error).slice(0,180)}`);}
 finally{await c.close();}
}}finally{await browser.close();}
await writeFile(out+"/shadow-composer-verification.json",JSON.stringify({message_id:"UIUX48-SHADOW-ASSETS-20261019-01",checked_at:new Date().toISOString(),source_snapshot,source_unchanged_during_run:sourceSnapshot().sha256===source_snapshot.sha256,assets,scenes,composers,failures,page_errors,fixture_only:true,external_network_blocked:true,native_verified:false,native_keyboard_verified:false,product_code_changed_this_message:false},null,2));
process.exitCode=failures.length||page_errors.length?1:0;
