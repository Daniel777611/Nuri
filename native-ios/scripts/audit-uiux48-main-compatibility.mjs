import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync,writeFileSync} from "node:fs";
import {sourceSnapshot} from "./uiux48-source-snapshot.mjs";
const ref="fd492f0c0fa5f0435051f6c1f73a066f8a35d87b";
const show=path=>execFileSync("git",["show",`${ref}:${path}`],{encoding:"utf8"}).replace(/^\uFEFF/,"");
const main=show("backend/main.py"),age=show("frontend/src/child-age.ts"),family=show("backend/nuri_core/family_store.py"),client=readFileSync("src/api.ts","utf8");
// Parse decorators, not incidental strings. No app import,
// authentication, backend startup, database read or HTTP request is performed.
const routes=JSON.parse(execFileSync("python3",["-c",`import ast,json,sys
t=ast.parse(sys.stdin.read()); rows=[]
for n in ast.walk(t):
 if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)):
  for d in n.decorator_list:
   if isinstance(d,ast.Call) and isinstance(d.func,ast.Attribute) and isinstance(d.func.value,ast.Name) and d.func.value.id in ('api','app') and d.func.attr in ('get','post','put','patch','delete') and d.args and isinstance(d.args[0],ast.Constant):
    rows.append({'router':d.func.value.id,'method':d.func.attr.upper(),'path':d.args[0].value,'line':n.lineno,'handler':n.name})
print(json.dumps(rows))`],{input:main,encoding:"utf8"}));
assert.equal(routes.length,111);assert.equal(routes.filter(r=>r.path.startsWith("/tasks")).length,0);
assert.match(age,/PREGNANCY_DAYS = 280/);assert.match(main,/value > date.today\(\) \+ timedelta\(days=core_family_store.PREGNANCY_DAYS\)/);assert.match(family,/PREGNANCY_DAYS = 280/);
assert.ok(client.includes("getMessages: (sid: string) => req("),"native getMessages no-limit signature");
assert.ok(main.includes("paged = limit is not None"),"server pagination must remain opt-in");
assert.ok(main.includes('return {"messages": messages, "has_more": has_more}'),"paged response must wrap messages");
assert.ok(main.includes("return messages"),"legacy no-limit response must remain a bare list");
const notificationRoutes=routes.filter(r=>r.path.startsWith("/notifications"));assert.equal(notificationRoutes.length,4);assert.equal(routes.filter(r=>/mefi|bottle|community|parent.match/i.test(r.path)).length,0);
const removedRoutes=["app/(tabs)/tasks.tsx","app/task/[id].tsx"].map(path=>({path,default_export_redirect_only:/export default function Deprecated\w+Route\(\) \{ return <Redirect href="\/\(tabs\)" \/>; \}/.test(readFileSync(path,"utf8"))}));assert.ok(removedRoutes.every(x=>x.default_export_redirect_only));
for(const method of ["getMainCheckin","openMainCheckin","getDailyPost","getDailyVideo"])assert.ok(client.includes(method+":"));
const report={message_id:"UIUX48-FINAL-DESIGN-QA-20261019",actual_thread_id:process.env.CODEX_THREAD_ID,checked_at:new Date().toISOString(),source_snapshot:sourceSnapshot(),latest_main:ref,verification:"Git fetch followed by fast-forward synchronization of the existing iOS-native-test branch to the verified main ref. Retained stash protects the original dirty work. AST over the actual main backend; no live/authenticated/model-generating API request.",total_main_route_count:routes.length,api_router_count:routes.filter(r=>r.router==='api').length,app_router_count:routes.filter(r=>r.router==='app').length,legacy_task_route_count:0,legacy_task_ui:removedRoutes,legacy_task_client_methods:"Historical unused methods remain, but deprecated route default exports only redirect; no task UI restored.",child_contract:{owner_source:`${ref}:backend/main.py ChildCreate.validate_birth_date + backend/nuri_core/family_store.py`,maximum_future_days:280,client_helpers_adapted_from:`${ref}:frontend/src/child-age.ts`,future_age_months:null,estimated_pregnancy_weeks:true,full_date_preserved:true},message_history:{no_limit:"bare oldest-to-newest list compatible with existing native getMessages",optional_limit_before:"{messages,has_more}; no pagination query added"},memory_routes:routes.filter(r=>r.path.startsWith("/memories")),memory_ui_added:false,memory_deletes_executed:0,notification_routes:notificationRoutes,self_account_deletion:{source_contract:routes.find(r=>r.method==="DELETE"&&r.path==="/auth/account"),consumer_contract_found:true,server_response:"ok/account_deleted/subscription_cancelled",billing_failure:"SUBSCRIPTION_CANCEL_FAILED; not_started",client_adapted:true,live_deployment_verified:false},missing_service_contracts:["MeFi matches/bottles/replies/chat/safety","notification history list/unread count"],existing_social_video_checkin_methods:true,checkin_get_is_not_readonly_diagnostic:true,new_backend_or_endpoint_added:false,backend_changes_from_main:0,backend_scope:"Existing APIs only; Community deferred by Daniel. No backend changes or deployment.",live_backend_verified:false,production_requests:0,fast_forwarded_to_main:true,reset_performed:false};
writeFileSync("/Users/wangding/Desktop/OrdashTech/HandoffDoc/UIUX48/main-compatibility-audit.json",JSON.stringify(report,null,2));console.log(JSON.stringify({route_count:routes.length,child_future_days:280,production_requests:0,report:"main-compatibility-audit.json"}));
