import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReminderInterval, withDailyPushPreference } from "../reminderInterval.ts";
import { registerNativeNavigationGuard, requestGuardedNativeNavigation } from "../nativeNavigation.ts";
import { firstShareableResource, saveTaskCardToPhotos, TaskCardExportError } from "../taskCardExport.ts";
import { notificationText } from "../notificationCopy.ts";

test("free-form seconds normalize without changing the requested duration", () => {
  assert.deepEqual(parseReminderInterval(" 2 ", "125"), { ok: true, intervalSeconds: 245, minutes: "4", seconds: "5" });
  assert.deepEqual(parseReminderInterval("", "1"), { ok: true, intervalSeconds: 1, minutes: "0", seconds: "1" });
});

test("invalid, zero, and out-of-native-range intervals never schedule", () => {
  for (const value of ["-1", "1.5", "1e2", "abc"]) {
    assert.deepEqual(parseReminderInterval(value, "0"), { ok: false, reason: "integer" });
  }
  assert.deepEqual(parseReminderInterval("", ""), { ok: false, reason: "zero" });
  assert.equal(parseReminderInterval("525600", "0").ok, true);
  assert.deepEqual(parseReminderInterval("525600", "1"), { ok: false, reason: "range" });
  assert.deepEqual(parseReminderInterval("9007199254740992", "0"), { ok: false, reason: "range" });
});

test("changing real push consent preserves other fresh privacy preferences", () => {
  const current = Object.freeze({ daily_push: true, allow_history_training: false, allow_external_content_research: false, language: "en", anonymous_community_share: true });
  const next = withDailyPushPreference(current, false);
  assert.deepEqual(next, { ...current, daily_push: false });
  assert.equal(current.daily_push, true);
  assert.notEqual(next, current);
});

test("a chat navigation guard receives the destination before the header navigates", () => {
  const actions = [];
  const clear = registerNativeNavigationGuard("/chat/test", (action) => actions.push(action));
  assert.equal(requestGuardedNativeNavigation("/profile", "home"), false);
  assert.equal(requestGuardedNativeNavigation("/chat/test", "notifications"), true);
  assert.deepEqual(actions, ["notifications"]);
  clear();
  assert.equal(requestGuardedNativeNavigation("/chat/test", "home"), false);
});

test("an old screen cleanup cannot remove a newer screen's save guard", () => {
  const actions = [];
  const clearOld = registerNativeNavigationGuard("/chat/old", () => assert.fail("old guard ran"));
  const clearNew = registerNativeNavigationGuard("/chat/new", (action) => actions.push(action));
  clearOld();
  assert.equal(requestGuardedNativeNavigation("/chat/new", "home"), true);
  assert.deepEqual(actions, ["home"]);
  clearNew();
});

test("photo permission rejection captures and saves nothing", async () => {
  await assert.rejects(saveTaskCardToPhotos({
    requestWritePermission: async () => ({ granted: false }),
    captureCard: async () => assert.fail("must not capture without permission"),
    saveToPhotos: async () => assert.fail("must not write without permission"),
    releaseCapture: () => assert.fail("no file exists"),
  }), (error) => error instanceof TaskCardExportError && error.code === "permission_denied");
});

test("photo export completes only after the actual write and releases its temporary capture", async () => {
  const order = [];
  await saveTaskCardToPhotos({
    requestWritePermission: async () => { order.push("permission"); return { granted: true }; },
    captureCard: async () => { order.push("capture"); return "file:///tmp/task-card.png"; },
    saveToPhotos: async (uri) => { assert.equal(uri, "file:///tmp/task-card.png"); order.push("write"); },
    releaseCapture: (uri) => { assert.equal(uri, "file:///tmp/task-card.png"); order.push("release"); },
  });
  assert.deepEqual(order, ["permission", "capture", "write", "release"]);
});

test("failed photo writes reject instead of reporting success and still release the capture", async () => {
  const released = [];
  await assert.rejects(saveTaskCardToPhotos({
    requestWritePermission: async () => ({ granted: true }),
    captureCard: async () => "file:///tmp/task-card.png",
    saveToPhotos: async () => { throw new Error("Photos write failed"); },
    releaseCapture: (uri) => released.push(uri),
  }), /Photos write failed/);
  assert.deepEqual(released, ["file:///tmp/task-card.png"]);
});

test("an empty capture never reaches Photos", async () => {
  await assert.rejects(saveTaskCardToPhotos({
    requestWritePermission: async () => ({ granted: true }),
    captureCard: async () => "",
    saveToPhotos: async () => assert.fail("empty capture"),
    releaseCapture: () => assert.fail("empty capture"),
  }), (error) => error instanceof TaskCardExportError && error.code === "empty_image");
});

test("sharing accepts public HTTPS source links and refuses schemes or URL credentials", () => {
  assert.equal(firstShareableResource(null), null);
  assert.equal(firstShareableResource([{ url: "javascript:alert(1)" }, { url: "http://example.com" }, { url: "https://user:pass@example.com" }]), null);
  assert.deepEqual(firstShareableResource([{ url: "invalid" }, { title: "Source article", url: "https://example.com/article" }]), { title: "Source article", url: "https://example.com/article" });
});

test("notification settings honor all existing UI locales and interpolate the real coverage", () => {
  assert.equal(notificationText("en", "title"), "Notification settings");
  assert.equal(notificationText("zh-TW", "title"), "通知設定");
  assert.equal(notificationText("zh-CN", "title"), "通知设置");
  const copy = notificationText("en", "limited", { count: 60, seconds: 600 });
  assert.match(copy, /60 notifications/);
  assert.match(copy, /600 seconds/);
  assert.doesNotMatch(copy, /\{\w+\}/);
});
