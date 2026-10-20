import assert from "node:assert/strict";
import {chromium} from "@playwright/test";
import {readFileSync} from "node:fs";
import {writeFile} from "node:fs/promises";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";
const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48";
const source_snapshot=sourceSnapshot(),results=[],failures=[];
const quick=process.env.UIUX48_QA_QUICK==="1";
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
const manifest=JSON.parse(readFileSync(out+"/approved-shadow-assets-ef01abd3/shadow-manifest.json"));
try{for(const size of (quick?[{width:320,height:568}]:[{width:390,height:844},{width:320,height:568}]))for(const mode of (quick?["Night"]:["Morning","Afternoon","Night"]))for(const locale of (quick?["en"]:["zh-CN","en"])){
 const c=await browser.newContext({viewport:size});await c.route("**/*",r=>["localhost","127.0.0.1"].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 const p=await c.newPage();p.setDefaultTimeout(20000);p.setDefaultNavigationTimeout(60000);
 const url=path=>`http://127.0.0.1:8082${path}${path.includes("?")?"&":"?"}theme=${mode}&lang=${locale}`;
 const settle=async()=>{await p.getByTestId(`nuri-shell-${mode}`).waitFor();await p.evaluate(()=>document.fonts.ready);await p.locator("img").evaluateAll(a=>Promise.all(a.map(x=>x.decode().catch(()=>{}))));};
 const capture=async name=>{await settle();const screenshot=`${out}/screenshots/qa48-${name}-${size.width}x${size.height}-${mode}-${locale}.png`;await p.screenshot({path:screenshot});const viewport=await p.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyScrollTop:document.scrollingElement.scrollTop}));assert.ok(viewport.scrollWidth<=size.width+1,"Horizontal overflow");return{screenshot,viewport};};
 const bounds=async(locator)=>locator.evaluate(e=>{
  const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
  let scroller=null,material=null;for(let n=e.parentElement;n&&n.tagName!=="BODY";n=n.parentElement){const s=getComputedStyle(n);if(!scroller&&/auto|scroll/.test(s.overflowY))scroller=n;if(!material&&Math.abs(parseFloat(s.borderTopLeftRadius)-28)<.1&&/hidden|clip/.test(s.overflow))material=n;}
  return{action:rect(e),scroller:scroller?{...rect(scroller),scrollTop:scroller.scrollTop,scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight}:null,material:material?{...rect(material),radii:["borderTopLeftRadius","borderTopRightRadius","borderBottomLeftRadius","borderBottomRightRadius"].map(k=>getComputedStyle(material)[k])}:null};
 });
 const check=async(name,fn)=>{try{const detail=await fn();results.push({screen:name,mode,locale,size,...detail});console.log(`${size.width} ${mode} ${locale}: ${name} PASS`);}catch(e){const path=`${out}/screenshots/qa48-error-${name}-${size.width}-${mode}-${locale}.png`;await p.screenshot({path});failures.push({screen:name,mode,locale,size,error:String(e),screenshot:path});console.log(`${name} FAIL: ${String(e).slice(0,200)}`);}};
 try{
  if(size.width===390)await check("welcome",async()=>{await p.goto(url("/welcome"),{waitUntil:"domcontentloaded"});await settle();const actor=await p.getByTestId("welcome-mascot").boundingBox(),shadow=await p.getByTestId("welcome-ground-shadow").boundingBox();const expected=manifest.assets.find(a=>a.scene==="welcome"&&a.mode===mode),scale=size.width/402;for(const[k,v]of Object.entries({x:expected.actorPlacements[0].left,y:expected.actorPlacements[0].top,width:expected.actorPlacements[0].width,height:expected.actorPlacements[0].height}))assert.ok(Math.abs(actor[k]-v*scale)<1,k+" actor geometry");for(const[k,v]of Object.entries({x:expected.logicalPlacement.left,y:expected.logicalPlacement.top,width:expected.logicalPlacement.width,height:expected.logicalPlacement.height}))assert.ok(Math.abs(shadow[k]-v*scale)<1,k+" shadow geometry");return{...await capture("welcome"),actor,shadow,geometry_matches_approved_export:true};});
  await p.goto(url("/login"),{waitUntil:"domcontentloaded"});await p.getByTestId("login-email").fill("parent@example.com");await p.getByTestId("login-password").fill("preview-only");await p.getByTestId("login-submit-btn").click();await p.getByTestId("home-settings").waitFor();
  const cases=[
   ["profile-main","/profile",()=>p.getByTestId("profile-section-account")],
   ["child-long-form","/child/new",()=>p.getByTestId("child-save-btn")],
   ["profile-preferences","/profile?section=preferences",()=>p.getByRole("button",{name:locale==="en"?"Save preferences":"保存偏好",exact:true})],
   ["profile-privacy","/profile?section=privacy",()=>p.getByTestId("privacy-save")],
   ["notification-settings","/notification-settings",()=>p.getByTestId("notification-settings-save")],
   ["community-hub","/community",()=>p.getByTestId("community-inbox")],
   ["community-bottle","/community?uiState=ask",()=>p.getByTestId("community-service-unavailable")]
  ];
  for(const[name,path,getAction]of cases)await check(name,async()=>{await p.goto(url(path),{waitUntil:"domcontentloaded"});await settle();const action=getAction();await action.waitFor();await action.scrollIntoViewIfNeeded();const measured=await bounds(action);assert.ok(measured.scroller,"No internal ScrollView");assert.ok(measured.material,"No rounded material");assert.ok(measured.material.radii.every(x=>parseFloat(x)===28),"Four outer corners must be28");assert.ok(measured.material.y>=0&&measured.material.bottom<=size.height+1,"Rounded card outside viewport");assert.ok(measured.action.y>=measured.scroller.y-1&&measured.action.bottom<=measured.scroller.bottom+1,"Action outside internal scroll bounds");return{...await capture(name),bounds:measured,fixture_only:true};});
 }catch(e){failures.push({screen:"session-setup",mode,locale,size,error:String(e)});}finally{await c.close();}
}}finally{await browser.close();}
await writeFile(out+(quick?"/qa48-small-screen-baseline.json":"/qa48-responsive-results.json"),JSON.stringify({checked_at:new Date().toISOString(),message_id:"UIUX48-QA-20261019-01",source_snapshot,source_unchanged_during_run:sourceSnapshot().sha256===source_snapshot.sha256,fixture_only:true,native_verified:false,results,failures},null,2));
process.exitCode=failures.length?1:0;
