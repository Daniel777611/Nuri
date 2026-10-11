import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const output = ts.transpileModule(readFileSync(new URL("../src/aiPermissionNavigation.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
new Function("require", "module", "exports", output)((name) => { throw new Error(`unexpected dependency ${name}`); }, module, module.exports);
const { aiPermissionReturnPath, aiPermissionHref } = module.exports;

const safe = ["/(tabs)", "/(tabs)/chats", "/(tabs)/profile", "/(tabs)/tasks", "/knowledge", "/daily-post", "/chat/session_1-A", "/detail/card_1-A", "/daily-video", "/daily-video?id=video_1-A"];

test("only known app-local routes are retained and the home alias is normalized", () => {
  assert.equal(aiPermissionReturnPath("/"), "/(tabs)");
  for (const path of safe) assert.equal(aiPermissionReturnPath(path), path);
  for (const prefix of ["/chat/", "/detail/"]) {
    assert.equal(aiPermissionReturnPath(prefix + "a".repeat(128)), prefix + "a".repeat(128));
    assert.equal(aiPermissionReturnPath(prefix + "a".repeat(129)), null);
  }
  assert.equal(aiPermissionReturnPath("/daily-video?id=" + "a".repeat(128)), "/daily-video?id=" + "a".repeat(128));
  assert.equal(aiPermissionReturnPath("/daily-video?id=" + "a".repeat(129)), null);
});

const unsafe = [
  "https://outside.invalid/", "http://outside.invalid/", "//outside.invalid/", "nuri-native-lab://chat/a", "javascript:alert(1)", "data:text/html,mock",
  "/\\outside.invalid", "/%2f%2foutside.invalid", "/chat/a/../b", "/chat/a/b", "/chat/", "/detail/", "/chat/a?redirect=https://outside.invalid", "/detail/a#outside",
  "/chat/%61", "/chat/a\\b", "/chat/a\n", " /(tabs)", "/knowledge?x=1", "/login", "/ai-permission", "", null, undefined, 42, ["/knowledge"], { returnTo: "/knowledge" },
  "/daily-video?id=", "/daily-video?id=a&redirect=https://outside.invalid", "/daily-video?id=a&id=b", "/daily-video?id=a#outside",
  "/daily-video?id=%61", "/daily-video?id=a/b", "/daily-video?id=../b", "/daily-video?id=a\\b", "/daily-video?id=a\n", "/daily-video?locale=en&id=a",
];

test("external URLs, schemes, traversal, extra parameters and non-string router params fail closed", () => {
  for (const path of unsafe) assert.equal(aiPermissionReturnPath(path), null, `unsafe return path ${JSON.stringify(path)}`);
});

test("permission href always targets the permission page and sanitizes its return parameter", () => {
  for (const path of ["/", ...safe]) {
    assert.deepEqual(aiPermissionHref(path), { pathname: "/ai-permission", params: { returnTo: aiPermissionReturnPath(path) } });
  }
  for (const path of unsafe) assert.deepEqual(aiPermissionHref(path), { pathname: "/ai-permission", params: { returnTo: "/(tabs)" } });
});
