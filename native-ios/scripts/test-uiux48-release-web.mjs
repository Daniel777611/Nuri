import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,stat,writeFile} from "node:fs/promises";
import {resolve,sep,extname} from "node:path";
import {chromium} from "@playwright/test";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";

// Test the actual production export, not Metro's fixture server. Every external
// browser request is aborted locally before any authentication reaches a server.
const out="/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48";
const root=resolve("build/uiux48-real-api-web");
const source_snapshot=sourceSnapshot();
const builds=JSON.parse(await readFile(out+"/real-api-build-results/summary.json","utf8"));
const web=builds.results.find(r=>r.name==="web-export");
assert.ok(web&&web.exit===0&&!web.fixture_mode&&web.build_env_preview_mode==="0","Preview-off Web export required");
assert.equal(web.source_snapshot.sha256,source_snapshot.sha256,"Export must match current source");
const types={".html":"text/html",".js":"application/javascript",".css":"text/css",".json":"application/json",".png":"image/png",".svg":"image/svg+xml",".ttf":"font/ttf",".woff2":"font/woff2"};
const server=createServer(async(req,res)=>{
 try{
  if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405);res.end();return;}
  let path=resolve(root,"."+decodeURIComponent(new URL(req.url,"http://localhost").pathname));
  if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  try{if(!(await stat(path)).isFile())path=resolve(root,"index.html");}catch{path=resolve(root,"index.html");}
  const body=await readFile(path);res.writeHead(200,{"Content-Type":types[extname(path)]??"application/octet-stream"});res.end(req.method==="HEAD"?undefined:body);
 }catch{res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const blocked_external_requests=[],page_errors=[],results=[];
let browser,error=null;
try{
 browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
 const c=await browser.newContext({viewport:{width:390,height:844}});
 await c.route("**/*",async r=>{
  const u=new URL(r.request().url());
  if(u.origin===origin)return r.continue();
  blocked_external_requests.push({origin:u.origin,path:u.pathname,method:r.request().method(),blocked_before_network:true});
  return r.abort();
 });
 const p=await c.newPage();p.setDefaultNavigationTimeout(60000);p.on("pageerror",e=>page_errors.push(e.message));
 await p.goto(origin+"/welcome?theme=Night&lang=en",{waitUntil:"domcontentloaded"});
 await p.getByTestId("welcome-mascot").waitFor();await p.evaluate(()=>document.fonts.ready);
 const actual_shell_mode=await p.locator('[data-testid^="nuri-shell-"]').first().getAttribute("data-testid");
 const welcome=out+"/screenshots/release-preview-off-welcome.png";await p.screenshot({path:welcome});
 results.push({screen:"welcome",screenshot:welcome,actual_shell_mode,theme_and_locale_query_not_assumed_in_release:true});
 await p.goto(origin+"/login?theme=Night&lang=en",{waitUntil:"domcontentloaded"});
 await p.getByTestId("login-email").fill("uiux48-qa@example.invalid");await p.getByTestId("login-password").fill("not-a-real-password");
 const request=p.waitForRequest(r=>new URL(r.url()).pathname==="/api/auth/login"&&r.method()==="POST");
 await p.getByTestId("login-submit-btn").click();const login=await request;
 assert.equal(new URL(login.url()).origin,"https://nurifam.app","Production API wiring changed unexpectedly");
 await p.getByTestId("login-error").waitFor();
 assert.equal(await p.getByTestId("home-settings").count(),0,"Must not log in through fixture adapter");
 const screenshot=out+"/screenshots/release-preview-off-login-blocked.png";await p.screenshot({path:screenshot});
 results.push({screen:"login",screenshot,production_request_wiring_verified:true,fixture_login_not_used:true,external_request_sent:false});
 await p.goto(origin+"/uiux48-gallery",{waitUntil:"domcontentloaded"});await p.getByTestId("welcome-mascot").waitFor();
 assert.equal(await p.getByTestId("uiux48-isolated-gallery").count(),0,"Release must resolve the inert gallery module");
 results.push({screen:"gallery-disabled-release",redirected_to_welcome:true,fixture_ui_available:false});
 assert.equal(page_errors.length,0,"Unexpected page errors");
 await c.close();
}catch(e){error=String(e);}finally{
 await browser?.close();await new Promise(resolve=>server.close(resolve));
}
const report={checked_at:new Date().toISOString(),source_snapshot,source_unchanged_during_run:sourceSnapshot().sha256===source_snapshot.sha256,build_env_preview_mode:"0",fixture_mode:false,web_runtime_preview_adapter_disabled_verified:!error,real_authenticated_api_verified:false,native_runtime_verified:false,external_requests_sent:0,blocked_external_requests,page_errors,results,error};
await writeFile(out+"/release-web-smoke-results.json",JSON.stringify(report,null,2));
console.log(JSON.stringify(report));process.exitCode=error?1:0;
