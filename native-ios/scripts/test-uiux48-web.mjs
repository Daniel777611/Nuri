import {chromium} from "@playwright/test";
import {mkdir,writeFile} from "node:fs/promises";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";
const source_snapshot=sourceSnapshot();
const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48";
const screenshots=out+"/screenshots";await mkdir(screenshots,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
const results=[];const failures=[];const errors=[];
try {
 for(const mode of ["Morning","Afternoon","Night"])for(const locale of ["zh-CN","en"]){
  const context=await browser.newContext({viewport:{width:402,height:874},deviceScaleFactor:1});
  await context.route("**/*",route=>{const u=new URL(route.request().url());if(!["127.0.0.1","localhost"].includes(u.hostname))return route.abort();return route.continue();});
  const page=await context.newPage();page.setDefaultNavigationTimeout(60000);page.on("pageerror",e=>errors.push({mode,locale,message:e.message}));
  const url=(path)=>`http://127.0.0.1:8082${path}${path.includes("?")?"&":"?"}theme=${mode}&lang=${locale}`;
  const snap=async(name)=>{
   await page.getByTestId(`nuri-shell-${mode}`).waitFor({timeout:20000});
   await page.evaluate(()=>document.fonts.ready);
   await page.locator("img").evaluateAll(imgs=>Promise.all(imgs.map(i=>i.decode().catch(()=>{}))));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const path=`${screenshots}/${name}-${mode}-${locale}.png`;
   await page.screenshot({path});
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   results.push({screen:name,mode,locale,screenshot:path,horizontal_overflow:overflow});console.log(`${mode} ${locale}: ${name}`);
  };
  try{
   await page.goto(url("/welcome"),{waitUntil:"domcontentloaded"});await snap("welcome");
   await page.goto(url("/login"),{waitUntil:"domcontentloaded"});await page.getByTestId("login-email").fill("parent@example.com");await page.getByTestId("login-password").fill("preview-only");await snap("login");
   await page.getByTestId("login-submit-btn").click();await page.getByTestId("home-settings").waitFor({timeout:20000});
   // This is an isolated preview account/browser, not the user's device trust.
   await page.goto(url("/ai-permission?returnTo=%2F(tabs)"),{waitUntil:"domcontentloaded"});
   await page.getByTestId("ai-permission-allow").click();
   await page.getByTestId("home-settings").waitFor({timeout:20000});
   await page.goto(url("/"),{waitUntil:"domcontentloaded"});await page.getByTestId("home-settings").waitFor();await snap("home");
   await page.getByTestId("home-settings").click();await snap("profile");
   await page.goto(url("/profile?section=children"),{waitUntil:"domcontentloaded"});await snap("children");
   await page.goto(url("/profile?section=privacy"),{waitUntil:"domcontentloaded"});await snap("privacy");
   await page.goto(url("/notification-settings"),{waitUntil:"domcontentloaded"});await snap("notification-settings");
   await page.goto(url("/notifications"),{waitUntil:"domcontentloaded"});await snap("notifications-unavailable");
   await page.goto(url("/community"),{waitUntil:"domcontentloaded"});await snap("community");
   await page.getByTestId("community-ask").click();await snap("community-bottle-unavailable");
   await page.goto(url("/daily-post"),{waitUntil:"domcontentloaded"});await snap("social-detail");
   await page.goto(url("/daily-video"),{waitUntil:"domcontentloaded"});await snap("video-detail");
   await page.goto(url("/chat/chat-1"),{waitUntil:"domcontentloaded"});await page.getByTestId("chat-input").waitFor({timeout:20000});
   await page.getByTestId("chat-input").fill("A draft that keeps both microphone and send controls.");
   await page.getByTestId("chat-mic").waitFor();await page.getByTestId("chat-send-btn").waitFor();
   await snap("chat-draft");
   await page.getByTestId("chat-expand").click();await page.getByTestId("chat-expanded-input").waitFor();
   // A mounted offscreen Modal is not visual evidence. Wait for its slide to
   // settle fully inside the viewport before capturing the expanded controls.
   await page.waitForFunction(()=>{const e=document.querySelector('[data-testid="chat-expanded-composer"]');if(!e)return false;const r=e.getBoundingClientRect();return r.height>=207&&r.top>=0&&r.bottom<=innerHeight-11.5;});
   await snap("chat-expanded");
   await page.getByTestId("chat-expanded-mic").waitFor();await page.getByTestId("chat-expanded-attach").waitFor();await page.getByTestId("chat-expanded-send-btn").waitFor();
   const expanded=await page.getByTestId("chat-expanded-input").inputValue();if(!expanded.includes("A draft"))throw Error("Expanded composer lost its draft");
   await page.getByTestId("chat-expanded-done").click();
   if(!(await page.getByTestId("chat-input").inputValue()).includes("A draft"))throw Error("Closing expansion lost the draft");
  }catch(e){failures.push({mode,locale,message:String(e)});}finally{await context.close();}
 }
}finally{await browser.close();}
const report={checked_at:new Date().toISOString(),source_snapshot,source_unchanged_during_run:sourceSnapshot().sha256===source_snapshot.sha256,fixture_mode:true,real_api_verified:false,native_keyboard_verified:false,results,failures,page_errors:errors};
await writeFile(out+"/web-visual-results.json",JSON.stringify(report,null,2));
console.log(JSON.stringify({screenshots:results.length,failures,page_errors:errors},null,2));process.exitCode=failures.length||errors.length?1:0;
