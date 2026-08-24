import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function testPayloadCarriesClientTimeContext() {
  const context = read("../src/chatClientContext.ts");
  assert.match(
    context,
    /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone \|\| "UTC"/,
    "the IANA timezone must come from Intl and fall back to UTC",
  );
  assert.match(
    context,
    /utc_offset_minutes: -now\.getTimezoneOffset\(\)/,
    "the UTC offset must use the opposite sign from Date#getTimezoneOffset",
  );
  assert.match(
    context,
    /locale,/,
    "the active UI locale must be included",
  );
  assert.match(
    context,
    /local_datetime: formatLocalDateTime\(now\)/,
    "the client datetime must include the local wall clock and offset",
  );
  assert.match(
    context,
    /client_message_id: `client-\$\{randomId\}`/,
    "each turn needs one stable client message id for stream fallback idempotency",
  );
}

function testStreamingAndFallbackShareOnePayload() {
  const chat = read("../app/chat/[id].tsx");
  assert.equal(
    (chat.match(/buildChatMessagePayload\(/g) || []).length,
    1,
    "a new chat turn must build its client-context payload at most once",
  );
  assert.match(
    chat,
    /api\.streamMessage\(id, payload, \(chunk\) =>/,
    "the streaming path must use the shared payload",
  );
  assert.match(
    chat,
    /api\.sendMessage\(id, payload\)/,
    "the non-streaming fallback must use the same shared payload",
  );
}

function testLeavingChatNeverDeletesPersistentConversation() {
  const chat = read("../app/chat/[id].tsx");
  const api = read("../src/api.ts");
  assert.doesNotMatch(
    chat,
    /api\.deleteSession\(/,
    "leaving or reloading chat must never delete the account's persistent conversation",
  );
  assert.doesNotMatch(
    chat,
    /Auto-delete session/,
    "the obsolete unmount cleanup must not return",
  );
  assert.doesNotMatch(
    api,
    /deleteSession:/,
    "the ordinary client API must not expose deletion for a persistent conversation",
  );
}

function testStorageFailuresNeverTriggerASecondPost() {
  const api = read("../src/api.ts");
  assert.match(
    api,
    /STREAM_ROUTE_FALLBACK_STATUSES = new Set\(\[404, 405, 415, 501\]\)/,
    "only an unavailable stream route may fall back to the non-streaming endpoint",
  );
  assert.match(
    api,
    /return new ApiError\(status, path, detail \|\| "stream request failed"\)/,
    "database 5xx responses must remain real errors instead of being reposted",
  );
  assert.doesNotMatch(
    api,
    /if \(!res\.ok\) throw new StreamUnsupportedError/,
    "a 503 must never be classified as stream unsupported",
  );
}

function testNativeAndFetchStreamingTransportsClassifyFailuresSafely() {
  const api = read("../src/api.ts");
  assert.match(
    api,
    /typeof body\?\.getReader === "function"/,
    "fetch streaming support requires a real ReadableStream reader",
  );
  assert.match(
    api,
    /typeof res\.body\?\.getReader !== "function"/,
    "each fetch response must expose getReader before the streaming path uses it",
  );

  const nativeStart = api.indexOf("function xhrStream(");
  const nativeEnd = api.indexOf("/**", nativeStart);
  assert.ok(nativeStart >= 0 && nativeEnd > nativeStart, "the native XHR transport must exist");
  const native = api.slice(nativeStart, nativeEnd);
  const onloadStart = native.indexOf("xhr.onload = () => {");
  const statusCheck = native.indexOf("xhr.status < 200 || xhr.status >= 300", onloadStart);
  const classifiedError = native.indexOf("streamHttpError(xhr.status, url", statusCheck);
  const finalDrain = native.indexOf("drain();", classifiedError);
  assert.ok(
    onloadStart >= 0 && statusCheck > onloadStart && classifiedError > statusCheck,
    "React Native onload must recheck every HTTP status through streamHttpError",
  );
  assert.ok(
    finalDrain > classifiedError,
    "the successful native response must drain its remaining bytes only after status classification",
  );
  assert.doesNotMatch(
    native.slice(0, onloadStart),
    /reject\(streamHttpError/,
    "HEADERS_RECEIVED may optimize state tracking but cannot be the only HTTP error check",
  );
  assert.match(
    native,
    /getResponseHeader\("content-type"\)[\s\S]*text\/event-stream[\s\S]*StreamUnsupportedError/,
    "a 2xx native response with a non-SSE content type may use the idempotent compatibility fallback",
  );
}

function testUnchangedManualRetryKeepsTheSameTurnKey() {
  const chat = read("../app/chat/[id].tsx");
  assert.match(
    chat,
    /const failedSendRef = useRef</,
    "a failed draft must retain the payload that owns its idempotency key",
  );
  assert.match(
    chat,
    /failedSend\.text === text[\s\S]*failedSend\.imageBase64 === normalizedImage[\s\S]*\? failedSend\.payload/,
    "resending unchanged content must reuse the original payload and client_message_id",
  );
  assert.match(
    chat,
    /failedSendRef\.current = \{ text, imageBase64: normalizedImage, payload \}/,
    "the catch path must retain the exact failed payload",
  );
  assert.match(
    chat,
    /if \(text\) setInput\(text\)/,
    "a failed text draft must be restored so the parent can retry it",
  );
}

function testRestoredMemoryIsNotRenderedAsChatHistory() {
  const chat = read("../app/chat/[id].tsx");
  const zhTw = read("../src/i18n/zh-TW.ts");
  const en = read("../src/i18n/en.ts");
  const memoryBranch = chat.indexOf('msg.transition?.kind === "memory_context"');
  const genericBubble = chat.indexOf('testID={`bubble-${msg.role}`}');

  assert.ok(memoryBranch >= 0, "memory_context needs an explicit render branch");
  assert.ok(
    genericBubble > memoryBranch,
    "memory_context must be intercepted before the generic chat bubble",
  );
  assert.match(
    chat,
    /function MemoryContextCard[\s\S]*testID="chat-memory-context"/,
    "restored memory must render as a dedicated context card",
  );
  assert.match(
    chat,
    /Array\.isArray\(transition\?\.items\)[\s\S]*typeof candidate\.text === "string"/,
    "the card must validate and render the backend memory items",
  );
  assert.match(
    chat,
    /typeof transition\?\.notice === "string"/,
    "the card must render the backend-authored notice when present",
  );
  assert.doesNotMatch(
    chat.slice(memoryBranch, chat.indexOf('if (msg.transition?.kind === "card_opened")')),
    /styles\.bubble/,
    "memory_context must never use the historical-message bubble style",
  );
  assert.match(zhTw, /"已恢复的家庭记忆": "已恢復的家庭記憶"/);
  assert.match(en, /"已恢复的家庭记忆": "Restored family memory"/);
}

testPayloadCarriesClientTimeContext();
testStreamingAndFallbackShareOnePayload();
testLeavingChatNeverDeletesPersistentConversation();
testStorageFailuresNeverTriggerASecondPost();
testNativeAndFetchStreamingTransportsClassifyFailuresSafely();
testUnchangedManualRetryKeepsTheSameTurnKey();
testRestoredMemoryIsNotRenderedAsChatHistory();
console.log("chat client-context contracts passed");
