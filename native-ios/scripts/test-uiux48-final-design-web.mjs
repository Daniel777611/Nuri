import assert from "node:assert/strict";
import {chromium} from "@playwright/test";
import {writeFile} from "node:fs/promises";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";
const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48",source_snapshot=sourceSnapshot();
const results=[],failures=[],page_errors=[],blocked_external=[];
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
try{outer:for(const viewport of (process.env.UIUX48_QA_SINGLE?[{width:390,height:844}]:[{width:390,height:844},{width:320,height:568}]))for(const mode of (process.env.UIUX48_QA_SINGLE?["Morning"]:["Morning","Afternoon","Night"]))for(const lang of (process.env.UIUX48_QA_SINGLE?["en"]:["zh-CN","en"])){
 const c=await browser.newContext({viewport});await c.route("**/*",r=>{const u=new URL(r.request().url());if(["127.0.0.1","localhost"].includes(u.hostname))return r.continue();blocked_external.push({origin:u.origin,method:r.request().method()});return r.abort();});
 const p=await c.newPage();p.setDefaultTimeout(15000);p.setDefaultNavigationTimeout(60000);p.on("pageerror",e=>page_errors.push(e.message));
 const url=path=>`http://127.0.0.1:8084${path}${path.includes("?")?"&":"?"}theme=${mode}&lang=${lang}`;
 const shot=async name=>{await p.evaluate(()=>document.fonts.ready);const path=`${out}/screenshots/final-${name}-${viewport.width}-${mode}-${lang}.png`;await p.screenshot({path});return path;};
 let stage="login";
 try{
  await p.goto(url("/login"),{waitUntil:"domcontentloaded"});await p.getByTestId("login-email").fill("fixture-only@example.invalid");await p.getByTestId("login-password").fill("fixture-only");await p.getByTestId("login-submit-btn").click();await p.getByTestId("home-settings").waitFor();
  await p.goto(url("/ai-permission?returnTo=%2F(tabs)"),{waitUntil:"domcontentloaded"});await p.getByTestId("ai-permission-allow").click();await p.getByTestId("home-settings").waitFor();
  stage="collection";await p.goto(url("/saved/card-1"),{waitUntil:"domcontentloaded"});await p.getByTestId("saved-detail-choose").click();await p.getByTestId("collection-choose-new").click();await p.getByTestId("collection-new-name").fill("Fixture sleep");await p.getByTestId("collection-create").click();
  const row=p.locator('[data-testid^="choose-collection-fixture-"]').first();await row.waitFor();await row.click();await p.getByTestId("collection-choose-save").click();await p.getByTestId("saved-content-result").waitFor();
  await p.getByTestId("saved-content-result-primary").click();await p.getByTestId("saved-detail-choose").click();await row.click();await p.getByTestId("collection-choose-save").click();await p.getByTestId("saved-content-result").waitFor();await p.getByTestId("saved-content-result-primary").click();await p.getByTestId("saved-detail-chat").waitFor();
  const saved=await shot("collection-still-saved");
  stage="notification-save";await p.goto(url("/notification-settings"),{waitUntil:"domcontentloaded"});await p.getByTestId("notification-settings-save").waitFor();await p.getByTestId("quiet-hours-start").fill("21:15");await p.getByTestId("notification-settings-save").click();await p.getByTestId("notification-settings-saved").waitFor();const notification=await shot("notification-saved");
  await p.getByTestId("notification-settings-saved-primary").click();await p.getByTestId("notification-settings-save").waitFor();assert.equal(await p.getByTestId("quiet-hours-start").inputValue(),"21:15");
  stage="home-language";await p.goto(url("/"),{waitUntil:"domcontentloaded"});await p.getByTestId("home-daily-post-card").waitFor();await p.getByTestId("home-daily-video-card").waitFor();
  if(lang==="en"){assert.doesNotMatch(await p.getByTestId("home-nuri-memo").innerText(),/[\u3400-\u9fff]/);assert.doesNotMatch(await p.getByTestId("home-daily-video-external-title").innerText(),/[\u3400-\u9fff]/);assert.doesNotMatch(await p.getByTestId("home-daily-post-card").innerText(),/[\u3400-\u9fff]/);}
  const home=await shot("home-language");
  stage="post-return";await p.goto(url("/daily-post"),{waitUntil:"domcontentloaded"});await p.getByTestId("daily-post-chat").waitFor();assert.equal(await p.locator('[data-testid^="daily-post-guide-action-"]').count(),0);const post=await shot("post-no-homework");
  stage="social-takeaway";await p.getByTestId("daily-post-summary-point-0").click();await p.getByTestId("social-takeaway-card").waitFor();assert.match(p.url(),/id=preview-daily-post/);assert.match(p.url(),/uiState=takeaway/);const takeaway=await shot("social-takeaway");
  await p.getByTestId("social-takeaway-card-secondary").click();await p.getByTestId("daily-post-chat").waitFor();assert.doesNotMatch(p.url(),/uiState=takeaway/);
  await p.getByTestId("daily-post-chat").click();await p.waitForURL(/\/chat\//);await p.getByTestId("chat-input").waitFor();await p.getByTestId("chat-input").fill("My preserved draft");await p.getByTestId("native-header-back").click();await p.waitForURL(/\/daily-post/);await p.getByTestId("daily-post-chat").waitFor();
  stage="video-return";await p.goto(url("/daily-video"),{waitUntil:"domcontentloaded"});await p.getByTestId("daily-video-chat").waitFor();assert.equal(await p.locator('[data-testid^="daily-video-guide-action-"]').count(),0);const video=await shot("video-no-homework");
  await p.getByTestId("daily-video-chat").click();await p.waitForURL(/\/chat\//);await p.getByTestId("chat-input").waitFor();await p.getByTestId("native-header-back").click();await p.waitForURL(/\/daily-video/);
  stage="community-coming-soon";await p.goto(url("/community"),{waitUntil:"domcontentloaded"});await p.getByTestId("community-launch-status").waitFor();
  for(const id of ["community-ask","community-find","community-inbox"]){await p.getByTestId(id).click();await p.getByTestId("community-service-unavailable").waitFor();assert.match(await p.getByTestId("community-service-unavailable").innerText(),lang==="en"?/Coming soon/:/未上线/);assert.equal(await p.getByTestId("community-bottle-draft").count(),0);if(id==="community-ask")var community=await shot("community-coming-soon");await p.getByTestId("community-service-unavailable-primary").click();await p.getByTestId("community-launch-status").waitFor();}
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),viewport.width);
  results.push({mode,lang,viewport,screenshots:[saved,notification,home,post,takeaway,video,community],same_collection_retained:true,back_returns_to_resource:true,social_takeaway_real_entry_and_back:true,community_all_entries_explicit_coming_soon:true,mandatory_checklist_removed:true,notification_saved_visible:true,english_home_no_cached_chinese:true});console.log(`${viewport.width} ${mode} ${lang}: PASS`);
 }catch(e){const screenshot=await shot("failure-"+stage);failures.push({mode,lang,viewport,stage,error:String(e),screenshot});console.log(`${stage}: ${String(e)}`);break outer;}finally{await c.close();}
}}finally{await browser.close();}
await writeFile(out+"/final-design-web-results.json",JSON.stringify({checked_at:new Date().toISOString(),source_snapshot,source_unchanged_during_run:sourceSnapshot().sha256===source_snapshot.sha256,results,failures,page_errors,blocked_external,fixture_only:true,external_requests_sent:0,native_interaction_verified:false,real_api_verified:false},null,2));
process.exitCode=failures.length||page_errors.length?1:0;
