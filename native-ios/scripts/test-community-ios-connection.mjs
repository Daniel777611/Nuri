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
const {COMMUNITY_CHAT_PHOTO_LIMIT,selectCommunityImage:select,selectCommunityImages:selectMany,sendCommunityChatPhotos:sendPhotos}=load("src/communityImageSelection.ts");
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
test("a current translation notification opens the exact conversation permissions in Settings",async()=>{
  const target={kind:"community_ai_consent",conversation_id:d,consent_request_id:q};
  const current={conversation_id:d,epoch:2,notice_version:"current",requests:{translation:{
    request_id:q,purpose:"translation",epoch:2,notice_version:"current",state:"pending"}}};
  const input={...api(target),messages:async()=>({conversation:{conversation_id:d,
    parent:{parent_id:p,display_name:"Local parent"},allowed_actions:["send_message"]}}),
    aiParticipation:async()=>current};
  assert.deepEqual(await open(id,input),{events:[{type:"go",screen:"preferences"}],
    translationSettings:{conversationId:d,parentName:"Local parent"}});
  for(const patch of [{request_id:id},{epoch:1},{purpose:"conversation_notes"},{state:"revoked"}]){
    const stale={...input,aiParticipation:async()=>({...current,requests:{translation:{...current.requests.translation,...patch}}})};
    assert.equal((await open(id,stale)).translationSettings,undefined);
  }
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
test("the photo picker preserves selection order and caps the draft at ten",async()=>{
  const assets=Array.from({length:12},(_item,index)=>index+1);
  const prepared=await selectMany(()=>true,async()=>assets,async asset=>`photo-${asset}`,COMMUNITY_CHAT_PHOTO_LIMIT);
  assert.deepEqual(prepared,assets.slice(0,10).map(asset=>`photo-${asset}`));
  let current=true;
  const started=[];
  assert.deepEqual(await selectMany(()=>current,async()=>assets,async asset=>{
    started.push(asset);
    current=false;
    return asset;
  },10),[]);
  assert.deepEqual(started,[1],"A navigation boundary stops the remaining asset preparation");
});
test("the ten-photo send acknowledges nine before the last and retries only the remaining draft",async()=>{
  const original=Array.from({length:10},(_item,index)=>index+1);
  let draft=[...original],caption="caption",fail=true;
  const uploaded=[],sent=[];
  const upload=async photo=>{uploaded.push(photo);return String(photo);};
  const send=async (text,mediaIds)=>{
    sent.push({text,mediaIds});
    if(mediaIds[0]==="10"&&fail)throw new Error("Unavailable");
  };
  const accepted=(photos,text)=>{
    draft=draft.filter(photo=>!photos.includes(photo));
    if(text===caption)caption="";
  };
  await assert.rejects(sendPhotos(draft,caption,()=>true,upload,send,accepted),/Unavailable/);
  assert.deepEqual(draft,[10]);
  assert.equal(caption,"");
  fail=false;
  await sendPhotos(draft,caption,()=>true,upload,send,accepted);
  assert.deepEqual(draft,[]);
  assert.deepEqual(uploaded,[...original,10]);
  assert.deepEqual(sent,[
    {text:"caption",mediaIds:original.slice(0,9).map(String)},
    {text:"",mediaIds:["10"]},
    {text:"",mediaIds:["10"]},
  ]);
});
test("an updated server receives all ten photos in one message",async()=>{
  const photos=Array.from({length:10},(_item,index)=>index+1);
  const sent=[],acked=[];
  await sendPhotos(photos,"caption",()=>true,async id=>String(id),
    async (text,mediaIds)=>sent.push({text,mediaIds}),
    (selected,text)=>acked.push({selected,text}),10);
  assert.deepEqual(sent,[{text:"caption",mediaIds:photos.map(String)}]);
  assert.deepEqual(acked,[{selected:photos,text:"caption"}]);
});
test("notification route never writes a community event into NURI chat and media has no cross-account cache",()=>{
  const route=read("app/notifications/[id].tsx"),ui=read("src/uiuxfinal/CommunityFinal.tsx");
  assert.ok(route.indexOf("api.getNotification")<route.indexOf("api.openNotification"));
  assert.match(route,/isCommunityNotificationKind/);assert.match(route,/notificationId: id/);
  assert.match(ui,/loadCommunityNotificationEntry\(notificationId,communityApi\)/);
  assert.match(ui,/accountScope\.current\(ticket\)/);assert.doesNotMatch(ui,/const mediaUrls/);assert.match(ui,/cachePolicy="none"/);
});
