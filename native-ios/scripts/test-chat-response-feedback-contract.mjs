import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const feedbackIcons = {
  copy: readFileSync(new URL("../public/chat-feedback/copy.svg", import.meta.url)),
  like: readFileSync(new URL("../public/chat-feedback/like.svg", import.meta.url)),
  dislike: readFileSync(new URL("../public/chat-feedback/dislike.svg", import.meta.url)),
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex").toUpperCase();

// Native glyphs are bundled locally; relative web SVG URLs have no origin in
// a React Native Image and must not be used as the native feedback controls.
assert.match(chat, /name="copy-outline"/, "native Copy must have a visible bundled glyph");
assert.match(chat, /"thumbs-up" : "thumbs-up-outline"/, "native Like must display selected state");
assert.match(chat, /"thumbs-down" : "thumbs-down-outline"/, "native Dislike must display selected state");
assert.match(chat, /await Clipboard\.setStringAsync\(text\)/, "native copy must use the system clipboard");
assert.doesNotMatch(chat, /uri: "\/chat-feedback\//, "native feedback must not fetch relative web-only assets");
assert.equal(sha256(feedbackIcons.copy), "3F41570EF35828DAB4F39D49BFFCED36E6E2B4CB9B21A18E9BDD208A0F29EA2F", "Copy SVG must remain the exact Figma export");
assert.equal(sha256(feedbackIcons.like), "A7B472CE22188F7A7A1A97D4E7B1D1515DB6E0F0FCC95AB19DA4EDC329C8A1C7", "Like SVG must remain the exact Figma export");
assert.equal(sha256(feedbackIcons.dislike), "CA3A2FAF904D4B24D1081F7E1B3B1EC0FE336DFD0D6892D1B57480B4635127E5", "Dislike SVG must remain the exact Figma export");
assert.match(chat, /responseAction: \{[\s\S]*?width: 44,[\s\S]*?height: 44,/, "native feedback buttons must provide a 44pt touch target");
assert.match(chat, /accessibilityState=\{\{ selected: msg\.feedback_rating === "like", disabled: feedbackSaving \}\}/, "selected native feedback must be accessible");
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
