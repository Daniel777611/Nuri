import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const chat = read("../app/chat/[id].tsx");
const api = read("../src/api.ts");
const preview = read("../src/preview-api.ts");
const backend = read("../../backend/main.py");
const migration = read("../../supabase/migrations/20260922010000_chat_message_feedback.sql");
const admin = read("../src/admin/UsageDashboard.tsx");

assert.match(chat, /copy-outline/, "AI answers must expose Copy");
assert.match(chat, /heart-outline/, "AI answers must expose Like");
assert.match(chat, /thumbs-down-outline/, "AI answers must expose Dislike");
assert.match(chat, /actionsEnabled=\{false\}/, "streaming placeholders must not accept feedback");
assert.match(chat, /feedbackSavingRef\.current\.has\(message\.id\)/, "rapid duplicate feedback must be locked");
assert.match(chat, /message\.feedback_rating === rating/, "selected feedback must be idempotent");
assert.match(chat, /feedback_rating: previous/, "failed writes must roll optimistic state back");
assert.match(api, /setChatMessageFeedback/, "client must use the durable feedback endpoint");
assert.match(preview, /feedback\$\/\.test\(path\)/, "preview mode must exercise feedback behavior");

assert.match(backend, /Depends\(_req_uid\)/, "feedback must require an authenticated user");
assert.match(backend, /await _load_owned_session\(session_id, uid, sb\)/, "feedback must enforce session ownership");
assert.match(backend, /message\.get\("role"\) != "ai"/, "only AI answers may be rated");
assert.match(backend, /on_conflict="user_id,message_id"/, "one answer must have one mutable vote per user");
assert.match(backend, /allow_history_training/, "training eligibility must honor privacy settings");
assert.match(backend, /@app\.get\("\/admin\/chat-feedback"\)/, "admin must expose a review queue");
assert.match(admin, /usage-chat-feedback/, "admin dashboard must render answer feedback");
assert.match(admin, /不会自动进入模型训练/, "dashboard must communicate the human-review boundary");

assert.match(migration, /enable row level security/, "feedback table must use RLS");
assert.match(migration, /revoke all.+anon, authenticated/, "app roles must not access the training labels directly");
assert.match(migration, /unique \(user_id, message_id\)/, "duplicate votes must be prevented by the database");
assert.match(migration, /review_status/, "training candidates must have an editorial review state");

console.log("chat response feedback contract: ok");
