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
}

function testStreamingAndFallbackShareOnePayload() {
  const chat = read("../app/chat/[id].tsx");
  assert.equal(
    (chat.match(/const payload = buildChatMessagePayload\(/g) || []).length,
    1,
    "the chat turn must build its client-context payload exactly once",
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

testPayloadCarriesClientTimeContext();
testStreamingAndFallbackShareOnePayload();
console.log("chat client-context contracts passed");
