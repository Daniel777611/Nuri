import assert from "node:assert/strict";
import {chromium} from "@playwright/test";
import {writeFile} from "node:fs/promises";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";
const source_snapshot=sourceSnapshot();const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48";const results=[],failures=[];
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
try{for(const mode of ["Morning","Afternoon","Night"])for(const locale of ["zh-CN","en"]){
 const c=await browser.newContext({viewport:{width:402,height:874}});await c.route("**/*",r=>["127.0.0.1","localhost"].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());const p=await c.newPage();p.setDefaultNavigationTimeout(60000);
 try{
  await p.goto(`http://127.0.0.1:8082/login?theme=${mode}&lang=${locale}`,{waitUntil:"domcontentloaded"});await p.getByTestId("login-email").fill("parent@example.com");await p.getByTestId("login-password").fill("preview-only");await p.getByTestId("login-submit-btn").click();await p.getByTestId("home-settings").waitFor();
  await p.goto(`http://127.0.0.1:8082/notification-settings?theme=${mode}&lang=${locale}`,{waitUntil:"domcontentloaded"});await p.getByTestId(`nuri-shell-${mode}`).waitFor();
  const save=p.getByTestId("notification-settings-save");await save.scrollIntoViewIfNeeded();const button=await save.boundingBox();const panel=await p.getByTestId("notification-settings-card").boundingBox();
  assert.ok(button&&panel&&button.y>=panel.y-1&&button.y+button.height<=panel.y+panel.height+1&&button.x>=panel.x&&button.x+button.width<=panel.x+panel.width+1,"Save action must stay inside the externally rounded card's internal scroller");
  await save.click();await p.waitForFunction(()=>/Settings saved|设置已保存/.test(document.querySelector('[data-testid="notification-settings-result"]')?.textContent??""));
  const path=out+`/screenshots/notification-settings-actions-${mode}-${locale}.png`;await p.screenshot({path});
  results.push({mode,locale,screenshot:path,action_inside_scroller:true,fixture_save_confirmed:true});console.log(mode+" "+locale+": form scroll/save PASS");
 }catch(e){failures.push({mode,locale,error:String(e)});}finally{await c.close();}
}}finally{await browser.close();}
await writeFile(out+"/form-scroll-results.json",JSON.stringify({checked_at:new Date().toISOString(),source_snapshot,source_unchanged_during_run:sourceSnapshot().sha256===source_snapshot.sha256,fixture_only:true,native_verified:false,results,failures},null,2));process.exitCode=failures.length?1:0;
