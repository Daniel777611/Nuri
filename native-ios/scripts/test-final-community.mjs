// Community on the live /api/community/v1 API: navigation model, API client,
// AI-consent classification, and the screen source no longer carrying fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const read = p => readFileSync(p, "utf8");
function load(path, deps = {}) {
  const code = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const m = { exports: {} };
  new Function("require", "module", "exports", code)(name => { assert.ok(name in deps, "Unapproved dependency " + name); return deps[name]; }, m, m.exports);
  return m.exports;
}
const model = load("src/uiuxfinal/communityModel.ts");
const { createFinalCommunity: create, finalCommunityReducer: reduce, FINAL_COMMUNITY_NODES: nodes } = model;
const step = (s, ...events) => events.reduce(reduce, s);

class ApiError extends Error {
  constructor(status, path, detail) { super(`API ${path} ${status}: ${detail}`); this.status = status; let p = null; try { p = JSON.parse(detail); } catch {} this.detail = typeof p?.detail === "string" ? p.detail : ""; }
}
function client() {
  const calls = [];
  const apiRequest = async (path, init, timeoutMs) => { calls.push({ path, method: (init?.method || "GET").toUpperCase(), body: init?.body ? JSON.parse(init.body) : undefined, timeoutMs }); return { ok: true }; };
  const mod = load("src/communityApi.ts", { "./api": { ApiError, apiRequest }, "./aiConsent": { AI_CONSENT_VERSION: "2026-10-01.1" } });
  return { ...mod, calls };
}

test("all 42 approved design states keep their Figma nodes; the safety menu stays local", () => {
  assert.equal(Object.keys(nodes).length, 42);
  for (const node of Object.values(nodes)) assert.match(node, /^188:\d+$/);
  assert.equal(model.isFinalCommunityScreen("__proto__"), false);
  assert.deepEqual(model.FINAL_COMMUNITY_LOCAL_SCREENS, ["parentSettings"]);
  assert.equal(model.isFinalCommunityScreen("parentSettings"), true);
});

test("the model holds navigation and drafts only, never server data or fixtures", () => {
  const s = create();
  for (const key of ["questions", "incoming", "contacts", "messages", "comments", "ai", "blocked", "sentInvitations", "receivedInvitations", "preferences", "localReceipt"]) assert.equal(key in s, false, key);
  assert.doesNotMatch(read("src/uiuxfinal/communityModel.ts"), /\bfetch\(|from ["'][^"']*(?:api|auth|storage)["']|Maya|PARENT_FIXTURES|QUESTION_FIXTURES/);
  // Deep links may not open a screen that needs a server id.
  for (const screen of ["chat", "chatOn", "consent", "replies", "respond", "parent", "sending", "sent", "safetyConfirm", "connected"]) assert.equal(create(screen).screen, "hub", screen);
  for (const screen of ["hub", "inbox", "contacts", "invitations", "myQuestions", "received", "preferences", "suggestions"]) assert.equal(create(screen).screen, screen);
  assert.equal(create("receivedLocked").receivedTab, "locked");
});

test("pager roots normalize page/expanded state and keep drafts across navigation", () => {
  for (const [screen, page, inboxExpanded] of [["hub", 0, false], ["friends", 1, false], ["inbox", 1, true]]) { const s = create(screen); assert.equal(s.page, page); assert.equal(s.inboxExpanded, inboxExpanded); assert.deepEqual(s.history, []); }
  let s = step(create("inbox"), { type: "draft", slot: "chat:p1", text: "unfinished" }, { type: "go", screen: "contacts" });
  assert.equal(s.history.length, 1);
  s = reduce(s, { type: "back" }); assert.equal(s.screen, "inbox"); assert.equal(s.drafts["chat:p1"], "unfinished");
  s = step(s, { type: "page", page: 0 }); assert.equal(s.screen, "hub"); assert.equal(s.inboxExpanded, true);
  s = step(s, { type: "page", page: 1 }); assert.equal(s.screen, "inbox");
});

test("a question is sent only through the server: sending → sent, a failure returns to preview with the same key", () => {
  let s = step(create(), { type: "newQuestion" }, { type: "draft", slot: "question", text: "  托育告别总哭怎么办？ " });
  assert.equal(model.selectedQuestionText(s), "托育告别总哭怎么办？");
  assert.equal(reduce(s, { type: "sent", id: "q1" }).screen, "compose", "a result outside sending is ignored");
  s = step(s, { type: "previewQuestion" }, { type: "sending", key: "q-key-1" });
  assert.equal(s.screen, "sending"); assert.equal(s.sendKey, "q-key-1");
  const failed = reduce(s, { type: "sendFailed", message: "网络或服务暂时不可用" });
  assert.equal(failed.screen, "preview"); assert.equal(failed.sendKey, "q-key-1", "a retry must reuse the key"); assert.equal(failed.notice, "网络或服务暂时不可用");
  assert.equal(failed.drafts.question.trim(), "托育告别总哭怎么办？", "drafts survive a failure");
  const sent = reduce(s, { type: "sent", id: "q1" });
  assert.equal(sent.screen, "sent"); assert.deepEqual(sent.history, []); assert.equal(sent.questionID, "q1"); assert.equal(sent.drafts.question, ""); assert.equal(sent.sendKey, null);
  // Changing the content or a privacy switch starts a new logical write.
  assert.equal(reduce(failed, { type: "toggle", key: "anonymous" }).sendKey, null);
  assert.equal(reduce(failed, { type: "draft", slot: "question", text: "别的" }).sendKey, null);
  assert.equal(reduce(failed, { type: "draft", slot: "chat:p1", text: "x" }).sendKey, "q-key-1");
});

test("polish keeps the original and selects the server's draft", () => {
  let s = step(create(), { type: "newQuestion" }, { type: "draft", slot: "question", text: "原话" }, { type: "polished", text: "润色稿", id: "polish-1" });
  assert.equal(s.screen, "polished"); assert.equal(s.drafts.question, "原话"); assert.equal(s.drafts.polished, "润色稿"); assert.equal(s.polishID, "polish-1");
  assert.equal(model.selectedQuestionText(s), "润色稿");
  s = reduce(s, { type: "version", version: "original" }); assert.equal(model.selectedQuestionText(s), "原话");
});

test("received questions, replies and comment threads are addressed by server ids", () => {
  let s = step(create("received"), { type: "openReceived", id: "q9", deliveryID: "d9", status: "waiting" });
  assert.equal(s.screen, "responsePrompt"); assert.equal(s.deliveryID, "d9");
  s = step(s, { type: "go", screen: "respond" }, { type: "draft", slot: "answer:q9", text: "我们的经验" }, { type: "responseSent" });
  assert.equal(s.screen, "responseSent"); assert.equal(s.drafts["answer:q9"], ""); assert.deepEqual(s.history, []);
  let r = step(create("myQuestions"), { type: "openQuestion", id: "q1" }, { type: "replyTarget", target: "reply-7", name: "Ann" });
  assert.equal(r.screen, "replyDetail"); assert.equal(r.replyTarget, "reply-7"); assert.equal(r.replyTargetName, "Ann");
  r = step(r, { type: "draft", slot: "comment:q1:reply-7", text: "谢谢" }, { type: "commentSent", slot: "comment:q1:reply-7" });
  assert.equal(r.screen, "comments"); assert.equal(r.drafts["comment:q1:reply-7"], "");
  const all = step(create("myQuestions"), { type: "openQuestion", id: "q1" }, { type: "replyTarget", target: "all", expanded: true }, { type: "commentSent", slot: "comment:q1:all" });
  assert.equal(all.screen, "replies");
  const closed = step(create("myQuestions"), { type: "go", screen: "selection" }, { type: "select", id: "q1" }, { type: "select", id: "q2" }, { type: "select", id: "q1" });
  assert.deepEqual(closed.selected, ["q2"]);
  assert.deepEqual(reduce(closed, { type: "questionsChanged" }).selected, []);
});

test("parents are public ids; consent opens only from a chat and closes to the server's answer", () => {
  let s = step(create("friends"), { type: "person", person: "pub-1", name: "Ann", screen: "chat" });
  assert.equal(s.screen, "chat"); assert.equal(s.person, "pub-1"); assert.equal(s.personName, "Ann");
  assert.equal(reduce(create(), { type: "requestConsent" }).screen, "hub");
  s = reduce(s, { type: "requestConsent" }); assert.equal(s.screen, "consent");
  assert.equal(reduce(s, { type: "consentClosed", effective: true }).screen, "chatOn");
  assert.equal(reduce(s, { type: "consentClosed", effective: false }).screen, "chat");
  const safety = step(create("blocked"), { type: "safety", action: "unblock", person: "pub-2", name: "Ben" });
  assert.equal(safety.screen, "safetyConfirm"); assert.equal(safety.person, "pub-2");
  assert.equal(reduce(safety, { type: "safetyDone" }).screen, "blocked");
  assert.equal(step(create("contacts"), { type: "safety", action: "block", person: "pub-3" }, { type: "safetyDone" }).screen, "contacts");
  for (const [index, ok] of [[0, true], [4, true], [5, false], [-1, false], [1.5, false]]) assert.equal(reduce(create("suggestions"), { type: "filter", key: "distance", index }).filters.distance, ok ? index : 0);
});

test("the API client sends exactly the backend's paths, methods and keyed bodies", async () => {
  const c = client(), api = c.communityApi;
  await api.ask({ body: "Q", original_language: "zh-CN", version_source: "original", polish_id: null, anonymous: true, show_child_age: false, client_request_id: "q-1" });
  await api.respond("d1", "A", "r-1", 2);
  await api.comment("q1", "all", "C", "c-1");
  await api.invite("pub-1", "i-1");
  await api.decideInvitation("inv-1", "accept", "dec-1");
  await api.block("pub-1"); await api.unblock("pub-1"); await api.disconnect("rel-1");
  await api.sendMessage("conv-1", "hi", "m-1"); await api.markRead("conv-1", 7);
  await api.requestAI("conv-1", "2026-11-05.1", "air-1"); await api.decideAI("req-1", "allow", "2026-11-05.1", "aid-1"); await api.revokeAI("conv-1");
  await api.polish("text", "zh-CN", "p-1");
  await api.recommendations({ role: "dad", distance_miles: 3 }); await api.recommendations({ role: "any", distance_miles: null });
  await api.savePreferences({ profile_hidden: true, expected_version: 2 });
  await api.transitionQuestions("close", [{ question_id: "q1" }], "t-1");
  const summary = c.calls.map(x => `${x.method} ${x.path}`);
  assert.deepEqual(summary, [
    "POST /community/v1/questions", "POST /community/v1/question-deliveries/d1/responses",
    "POST /community/v1/questions/q1/reply-threads/all/comments", "POST /community/v1/invitations",
    "POST /community/v1/invitations/inv-1/decisions", "PUT /community/v1/me/blocks/pub-1",
    "DELETE /community/v1/me/blocks/pub-1?confirmed=true", "DELETE /community/v1/relationships/rel-1?confirmed=true",
    "POST /community/v1/conversations/conv-1/messages", "PUT /community/v1/conversations/conv-1/read-cursor",
    "POST /community/v1/conversations/conv-1/ai-consent-requests", "PUT /community/v1/ai-consent-requests/req-1/my-decision",
    "DELETE /community/v1/conversations/conv-1/ai-participation", "POST /community/v1/question-polishes",
    "GET /community/v1/recommendations?role=dad&distance_miles=3", "GET /community/v1/recommendations?role=any",
    "PATCH /community/v1/preferences", "POST /community/v1/questions/batch-transitions",
  ]);
  const body = i => c.calls[i].body;
  assert.equal(body(0).client_request_id, "q-1"); assert.equal(body(0).anonymous, true);
  assert.deepEqual(body(1), { body: "A", client_request_id: "r-1", expected_version: 2 });
  assert.deepEqual(body(2), { body: "C", client_message_id: "c-1" });
  assert.deepEqual(body(3), { target_parent_id: "pub-1", client_request_id: "i-1" });
  assert.deepEqual(body(5), { confirmed: true });
  assert.deepEqual(body(8), { text: "hi", client_message_id: "m-1" });
  assert.deepEqual(body(9), { last_read_seq: 7 });
  assert.equal(body(10).purpose, "conversation_notes");
  assert.deepEqual(body(13), { text: "text", language: "zh-CN", ai_consent_version: "2026-10-01.1", client_request_id: "p-1" });
  assert.deepEqual(body(17), { action: "close", items: [{ question_id: "q1" }], confirmed: true, client_request_id: "t-1" });
  // No call carries an owner or sender: the token is the only identity.
  for (const call of c.calls) assert.doesNotMatch(JSON.stringify(call.body ?? {}), /user_id|sender_id|author_id|owner/);
});

test("client helpers: error codes, intents, child age, times and unique keys", () => {
  const c = client();
  const err = new ApiError(409, "/community/v1/questions", JSON.stringify({ detail: "x", error: { code: "IDEMPOTENCY_CONFLICT" } }));
  assert.equal(c.communityErrorCode(err), "IDEMPOTENCY_CONFLICT");
  assert.equal(c.communityErrorCode(new Error("network")), "");
  assert.deepEqual(c.intentIndexes(["casual_chat", "share_parenting_ideas", "unknown"]), [5, 0]);
  assert.deepEqual(c.intentCodes([5, 0, 9]), ["share_parenting_ideas", "casual_chat"]);
  assert.equal(c.childAgeLabel(27, false), "2岁3个月"); assert.equal(c.childAgeLabel(5, false), "5个月"); assert.equal(c.childAgeLabel(null, false), null);
  assert.equal(c.childAgeLabel(24, true), "2 yrs");
  const now = new Date(2026, 10, 5, 12, 0);
  assert.equal(c.shortTime(new Date(2026, 10, 5, 9, 5).toISOString(), false, now), "今天 09:05");
  assert.equal(c.shortTime(new Date(2026, 10, 3, 9, 5).toISOString(), false, now), "11月3日");
  assert.equal(c.shortTime("garbage", false, now), "");
  const keys = new Set(Array.from({ length: 200 }, () => c.communityKey("q")));
  assert.equal(keys.size, 200); for (const k of keys) assert.ok(k.length >= 8 && k.startsWith("q-"));
});

test("polish, transcription, translation and server-side question matching need device AI permission", () => {
  const { requiresAIConsent } = load("src/aiConsent.ts", { "./utils/storage": { storage: {} } });
  const post = { method: "POST" };
  assert.equal(requiresAIConsent("/community/v1/question-polishes", post), true);
  assert.equal(requiresAIConsent("/community/v1/transcriptions", post), true);
  assert.equal(requiresAIConsent("/community/v1/messages/m1/translations", post), true);
  assert.equal(requiresAIConsent("/community/v1/questions", post), true);
  assert.equal(requiresAIConsent("/community/v1/questions?q=x"), false);
  for (const path of ["/community/v1/conversations/c1/messages", "/community/v1/invitations", "/community/v1/me/inbox", "/community/v1/conversations/c1/ai-consent-requests"])
    assert.equal(requiresAIConsent(path, path.includes("inbox") ? undefined : post), false, path);
});

test("the screens read and write the live API and carry no sample people or simulated sends", () => {
  const source = read("src/uiuxfinal/CommunityFinal.tsx");
  assert.match(source, /from "@\/src\/communityApi"/);
  for (const banned of [/\bMaya\b/, /\bNina\b/, /Savannah/, /PARENT_FIXTURES|QUESTION_FIXTURES/, /示例家长|示例附件|这是一条语音示例/, /finishSend/, /DemoLabel/, /\bfetch\s*\(/])
    assert.doesNotMatch(source, banned, String(banned));
  // Every write goes through the client and moves the flow only on its result.
  for (const call of ["communityApi.ask(", "communityApi.respond(", "communityApi.comment(", "communityApi.invite(", "communityApi.decideInvitation(", "communityApi.block(", "communityApi.unblock(", "communityApi.disconnect(", "communityApi.sendMessage(", "communityApi.requestAI(", "communityApi.decideAI(", "communityApi.revokeAI(", "communityApi.transitionQuestions(", "communityApi.savePreferences(", "communityApi.saveProfile(", "communityApi.polish("])
    assert.ok(source.includes(call), call);
  assert.match(source, /dispatch\(\{type:"sent",id:result\.question\.question_id\}\)/);
  assert.match(source, /dispatch\(\{type:"sendFailed",message:failure\(error\)\}\)/);
  const route = read("app/community.tsx");
  assert.match(route, /<CommunityFinal key=\{generation\} \/>/);
});

test("photos and voice: one prepared image per message, voice is transcription into the draft (D14)", async () => {
  const c = client(), api = c.communityApi;
  await api.uploadImage("data:image/jpeg;base64,AAAA", "message", "img-1");
  await api.sendMessage("conv-1", "", "m-2", ["media-1"]);
  await api.mediaAccess("media-1");
  await api.transcribe("data:audio/webm;base64,AAAA", "zh-CN", "asr-1");
  assert.deepEqual(c.calls.map(x => `${x.method} ${x.path}`), [
    "POST /community/v1/media", "POST /community/v1/conversations/conv-1/messages",
    "GET /community/v1/media/media-1/access", "POST /community/v1/transcriptions",
  ]);
  assert.deepEqual(c.calls[0].body, { purpose: "message", data_uri: "data:image/jpeg;base64,AAAA", client_request_id: "img-1" });
  assert.deepEqual(c.calls[1].body, { text: "", media_ids: ["media-1"], client_message_id: "m-2" });
  assert.deepEqual(c.calls[3].body, { audio_base64: "data:audio/webm;base64,AAAA", locale: "zh-CN", ai_consent_version: "2026-10-01.1", client_request_id: "asr-1" });
  const source = read("src/uiuxfinal/CommunityFinal.tsx");
  assert.doesNotMatch(source, /notSupported|即将支持|coming soon/i);
  for (const needle of ["startVoiceRecording()", "communityApi.transcribe(", "communityApi.uploadImage(", "selectCommunityImage(", "prepareChatImage)", "<VoiceInputBar", "<CommunityImage"]) assert.ok(source.includes(needle), needle);
  // A transcript lands in the draft; only the chat's own Send button sends it.
  assert.match(source, /dispatch\(\{type:"draft",slot,text:/);
  assert.match(source, /if\(spoken&&sendAfter&&slot\.startsWith\("chat:"\)\)/);
});

test("reports: every kind of community content and parents can be reported in-app (Play UGC)", async () => {
  const c = client();
  await c.communityApi.report({ target_kind: "message", target_id: "m1", reason: "harassment", note: "x", block: true });
  assert.deepEqual(c.calls.map(x => `${x.method} ${x.path}`), ["POST /community/v1/reports"]);
  assert.deepEqual(c.calls[0].body, { target_kind: "message", target_id: "m1", reason: "harassment", note: "x", block: true });
  const source = read("src/uiuxfinal/CommunityFinal.tsx");
  for (const entry of ['reportButton("question"', 'reportButton("reply"', 'reportButton("comment"', 'reportButton("parent"', 'kind:"message"', 'testID="final-report-parent-menu"'])
    assert.ok(source.includes(entry), entry);
  // Anonymous content can be reported but not blocked from the sheet (it would reveal the author).
  assert.match(source, /reportButton\("question",question\.question_id,c\([^)]*\),!question\.anonymous/);
  assert.match(source, /reportButton\("reply",reply\.reply_id,c\([^)]*\),!reply\.anonymous/);
  const sheet = read("src/uiuxfinal/CommunityReportSheet.tsx");
  for (const reason of ["harassment", "sexual", "hate", "child_safety", "self_harm", "spam", "other"]) assert.ok(sheet.includes(`"${reason}"`), reason);
  assert.doesNotMatch(sheet, /\bfetch\(|communityApi\./);  // the sheet only collects; the screen sends
});
