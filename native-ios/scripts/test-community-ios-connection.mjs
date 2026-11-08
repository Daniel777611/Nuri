import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
const read = p => readFileSync(p,"utf8");
function load(path) {
  const m={exports:{}};
  const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function("require","module","exports",code)(n=>{throw new Error("Unexpected runtime import "+n);},m,m.exports);
  return m.exports;
}
const {loadCommunityNotificationEntry:open,CommunityTargetUnavailable:Missing}=load("src/communityNotificationEntry.ts");
const {selectCommunityImage:select}=load("src/communityImageSelection.ts");
const id="11111111-1111-4111-8111-111111111111", q="22222222-2222-4222-8222-222222222222", d="33333333-3333-4333-8333-333333333333", p="44444444-4444-4444-8444-444444444444";
const api=target=>({notificationTarget:async()=>({notification_id:id,accessible:true,target}),question:async()=>({question:{question_id:q,is_mine:false,status:"open",delivery:{delivery_id:d,state:"waiting"}}}),messages:async cid=>({conversation:{conversation_id:cid,parent:{parent_id:p,display_name:"Local parent"}}})});
test("notification targets are reauthorized, typed and never arbitrary URLs",async()=>{
  await assert.rejects(open("bad",api({})),Missing);
  for(const target of [{kind:"external",url:"https://example.com"},{kind:"community_reply",question_id:q,thread_id:"../../admin"},{kind:"community_conversation",conversation_id:"not-uuid"}])await assert.rejects(open(id,api(target)),Missing);
  await assert.rejects(open(id,{notificationTarget:async()=>({notification_id:id,accessible:false,target:null})}),Missing);
  await assert.rejects(open(id,{notificationTarget:async()=>({notification_id:q,accessible:true,target:{kind:"community_invitation",invitation_id:d}})}),Missing);
});
test("question, reply, invitation, conversation and consent map to real server ids",async()=>{
  assert.deepEqual((await open(id,api({kind:"community_question",question_id:q,delivery_id:d}))).events,[{type:"openReceived",id:q,deliveryID:d,status:"waiting"}]);
  assert.deepEqual((await open(id,api({kind:"community_reply",question_id:q,thread_id:d}))).events,[{type:"openQuestion",id:q},{type:"replyTarget",target:d}]);
  assert.deepEqual((await open(id,api({kind:"community_invitation",invitation_id:d}))).events,[{type:"go",screen:"invitations"}]);
  for(const kind of ["community_conversation","community_ai_consent"]){const r=await open(id,api({kind,conversation_id:d}));assert.deepEqual(r.conversation,{parentId:p,id:d});assert.equal(r.events[0].person,p);}
});
test("a missing/mismatched conversation parent cannot become a chat",async()=>{
  await assert.rejects(open(id,{...api({kind:"community_conversation",conversation_id:d}),messages:async()=>({conversation:{conversation_id:d,parent:null}})}),Missing);
});
test("authorization is literal true and received-question delivery must belong to this account",async()=>{
  const target={kind:"community_question",question_id:q,delivery_id:d};
  await assert.rejects(open(id,{...api(target),notificationTarget:async()=>({notification_id:id,accessible:"false",target})}),Missing);
  for(const delivery of [undefined,{delivery_id:q,state:"waiting"},{delivery_id:d,state:"unexpected"}])await assert.rejects(open(id,{...api(target),question:async()=>({question:{question_id:q,is_mine:false,delivery}})}),Missing);
});
test("image picker discards stale account/chat/blur/unmount leases before decoding",async()=>{
  for(const boundary of ["account","chat","chat-return","blur","unmount"]){let live=true,release,decoded=0;const r=select(()=>live,()=>new Promise(done=>release=done),async()=>{decoded++;return "image";});live=false;release("asset");assert.equal(await r,null,boundary);assert.equal(decoded,0);}
});
test("image preparation cannot commit across an intervening navigation lease",async()=>{
  let live=true,release;const r=select(()=>live,async()=>"asset",()=>new Promise(done=>release=done));await Promise.resolve();live=false;release("image");assert.equal(await r,null);
  assert.equal(await select(()=>true,async()=>"asset",async a=>a+"-ready"),"asset-ready");
});
test("notification route never writes a community event into NURI chat and media has no cross-account cache",()=>{
  const route=read("app/notifications/[id].tsx"),ui=read("src/uiuxfinal/CommunityFinal.tsx");
  assert.ok(route.indexOf("api.getNotification")<route.indexOf("api.openNotification"));
  assert.match(route,/isCommunityNotificationKind/);assert.match(route,/notificationId: id/);
  assert.match(ui,/loadCommunityNotificationEntry\(notificationId,communityApi\)/);
  assert.match(ui,/accountScope\.current\(ticket\)/);assert.doesNotMatch(ui,/const mediaUrls/);assert.match(ui,/cachePolicy="none"/);
});
