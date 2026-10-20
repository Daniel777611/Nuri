import assert from "node:assert/strict";
import {chromium} from "@playwright/test";
import {readFileSync} from "node:fs";
import {writeFile} from "node:fs/promises";
import ts from "typescript";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";
const output=ts.transpileModule(readFileSync("src/dev/uiux48/galleryData.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;const m={exports:{}};new Function("module","exports",output)(m,m.exports);const {GALLERY_SCREENS:groups}=m.exports;
const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48",source_snapshot=sourceSnapshot(),results=[],failures=[],page_errors=[],bounds=[],network=[];
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
try{for(const mode of ["Morning","Afternoon","Night"])for(const lang of ["zh-CN","en"]){
 const c=await browser.newContext({viewport:{width:390,height:844}});await c.route("**/*",r=>{const u=new URL(r.request().url());if(["localhost","127.0.0.1"].includes(u.hostname))return r.continue();network.push({host:u.hostname,blocked:true});return r.abort();});
 const p=await c.newPage();p.setDefaultTimeout(15000);p.setDefaultNavigationTimeout(60000);p.on("pageerror",e=>page_errors.push({mode,lang,error:e.message}));
 try{
  await p.goto(`http://127.0.0.1:8083/uiux48-gallery?theme=${mode}&lang=${lang}`,{waitUntil:"domcontentloaded"});await p.getByTestId("uiux48-isolated-gallery").waitFor();await p.getByTestId(`nuri-shell-${mode}`).waitFor();await p.evaluate(()=>document.fonts.ready);
  for(const g of groups){
   await p.getByTestId("gallery-title").filter({hasText:g.title[lang==="en"?1:0]}).waitFor();
   assert.ok(await p.getByTestId("gallery-warning").isVisible());assert.equal(await p.getByTestId("nuri-tab-bar").count(),1);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   const el=p.getByTestId(`gallery-card-${g.key}`);
   if(await el.count()){
    const box=await el.evaluate(e=>{const material=[...e.querySelectorAll("*")].find(x=>{const s=getComputedStyle(x);return s.borderTopLeftRadius==="28px"&&s.overflow==="hidden";});if(!material)return null;const b=material.getBoundingClientRect(),s=getComputedStyle(material);return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,radii:[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius],scroll:[...material.querySelectorAll("*")].some(x=>x.scrollHeight>x.clientHeight+1&&["auto","scroll"].includes(getComputedStyle(x).overflowY))};});
    assert.ok(box);assert.ok(box.radii.every(r=>r==="28px"));assert.ok(box.y>=0&&box.bottom<=844);bounds.push({group:g.key,mode,lang,...box});
   }
   const screenshot=`${out}/screenshots/continuation-${g.key}-${mode}-${lang}.png`;await p.screenshot({path:screenshot});results.push({group:g.key,node:g.node,mode,lang,screenshot,fixture_only:true});await p.getByTestId("gallery-next").click();
  }
  for(const v of ["loading","error","permission"]){await p.getByTestId("gallery-variant-"+v).click();await p.getByTestId("gallery-state-card").waitFor();const screenshot=`${out}/screenshots/continuation-common-${v}-${mode}-${lang}.png`;await p.screenshot({path:screenshot});results.push({group:"common-"+v,mode,lang,screenshot,fixture_only:true});}
  console.log(`${mode} ${lang}: ${groups.length} design fixtures +3 guarded states PASS`);
 }catch(e){const screenshot=`${out}/screenshots/continuation-error-${mode}-${lang}.png`;await p.screenshot({path:screenshot});failures.push({mode,lang,error:String(e),screenshot});console.log(String(e));}finally{await c.close();}
}}finally{await browser.close();}
await writeFile(out+"/continuation-web-verification.json",JSON.stringify({checked_at:new Date().toISOString(),source_snapshot,source_unchanged_during_run:sourceSnapshot().sha256===source_snapshot.sha256,results,bounds,failures,page_errors,external_requests_allowed:0,blocked_requests:network.length,fixture_only:true,native_interaction_verified:false,real_api_verified:false},null,2));process.exitCode=failures.length||page_errors.length?1:0;
