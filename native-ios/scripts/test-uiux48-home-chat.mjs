import assert from "node:assert/strict";
import {chromium} from "@playwright/test";
import {writeFile} from "node:fs/promises";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";
const source_snapshot=sourceSnapshot();
const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48";
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
const results=[];const failures=[];
try{
 for(const mode of (process.env.UIUX48_QA_SINGLE?["Morning"]:["Morning","Afternoon","Night"]))for(const locale of (process.env.UIUX48_QA_SINGLE?["en"]:["zh-CN","en"])){
  const context=await browser.newContext({viewport:{width:402,height:874}});
  await context.route("**/*",r=>["127.0.0.1","localhost"].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
  const p=await context.newPage();p.setDefaultTimeout(20000);p.setDefaultNavigationTimeout(60000);
  const url=path=>`http://127.0.0.1:8082${path}${path.includes("?")?"&":"?"}theme=${mode}&lang=${locale}`;
  let stage="login";try{
   await p.goto(url("/login"),{waitUntil:"domcontentloaded"});await p.getByTestId("login-email").fill("parent@example.com");await p.getByTestId("login-password").fill("preview-only");await p.getByTestId("login-submit-btn").click();await p.getByTestId("home-settings").waitFor();
   await p.goto(url("/ai-permission?returnTo=%2F(tabs)"),{waitUntil:"domcontentloaded"});await p.getByTestId("ai-permission-allow").click();await p.getByTestId("home-settings").waitFor();
   stage="inline-send";const before=await p.getByTestId("home-mascot").boundingBox();
   await p.getByTestId("home-input").fill("UIUX48 local preview message");await p.getByTestId("home-send-btn").click();
   await p.getByTestId("home-chat-input").waitFor();await p.getByTestId("chat-scroll").getByText("UIUX48 local preview message",{exact:true}).waitFor();
   await p.waitForFunction(()=>{const e=document.querySelector('[data-testid="home-chat-input"]');return e&&!e.readOnly&&!e.disabled;});
   const after=await p.getByTestId("home-mascot").boundingBox();assert.deepEqual(after,before,"Opening inline chat must not resize/reposition the mascot");
   const inputBounds=await p.getByTestId("home-chat-input").boundingBox();assert.ok(inputBounds&&inputBounds.height>=24&&inputBounds.y+inputBounds.height<874,"Inline composer must remain on screen");
   const inline=out+`/screenshots/home-inline-${mode}-${locale}.png`;await p.screenshot({path:inline});
   stage="open-full";await p.getByTestId("home-chat-input").fill("Preserved UIUX48 draft");
   await p.getByTestId("home-nuri-action").click();await p.waitForURL(/\/chat\//);
   await p.getByTestId("chat-input").waitFor();await p.waitForFunction(()=>document.querySelector('[data-testid="chat-input"]')?.value==="Preserved UIUX48 draft");
   stage="return-home";await p.getByTestId("native-header-back").click();await p.getByTestId("home-screen").waitFor();
   await p.waitForFunction(()=>{const e=document.querySelector('[data-testid="home-chat-input"], [data-testid="home-input"]');return e?.value==="Preserved UIUX48 draft";});
   const original=await p.getByTestId("home-mascot").boundingBox();
   await p.setViewportSize({width:402,height:600});await p.waitForTimeout(100);
   const resized=await p.getByTestId("home-mascot").boundingBox();assert.deepEqual(resized,original,"Scene must retain geometry when foreground viewport height shrinks");
   const path=out+`/screenshots/home-inline-resized-${mode}-${locale}.png`;await p.screenshot({path});
   results.push({mode,locale,inline_screenshot:inline,resized_screenshot:path,send_fixture:true,scene_geometry_stable:true,draft_round_trip:true,synthetic_viewport_only:true,native_keyboard_verified:false});console.log(mode+" "+locale+": inline send/draft/scene PASS");
  }catch(e){const path=out+`/screenshots/home-chat-error-${mode}-${locale}.png`;await p.screenshot({path});failures.push({mode,locale,stage,url:p.url(),error:String(e),screenshot:path});console.log(mode+" "+locale+": FAIL at "+stage+" "+p.url()+" "+String(e).slice(0,160));}
  finally{await context.close();}
 }
}finally{await browser.close();}
await writeFile(out+"/home-chat-behavior-results.json",JSON.stringify({checked_at:new Date().toISOString(),source_snapshot,source_unchanged_during_run:sourceSnapshot().sha256===source_snapshot.sha256,fixture_only:true,results,failures,native_keyboard_verified:false},null,2));process.exitCode=failures.length?1:0;
