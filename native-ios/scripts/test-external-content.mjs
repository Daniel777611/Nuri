import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { fixture, page, load } from "./test-daily-home-failure.mjs";

const { externalSourceUrl, externalSourceHost } = load("../src/externalContent.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const response = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });

test("external source URL is public HTTPS without credentials or unsafe schemes", () => {
  for (const source of ["https://www.facebook.com/groups/family/posts/123", "https://www.threads.net/@parent/post/123", "https://www.youtube.com/watch?v=ScMzIvxBSi4", "https://public.example/article?a=1"]) {
    assert.equal(externalSourceUrl(source), source);
  }
  for (const source of [null, "", "javascript:alert(1)", "file:///etc/passwd", "http://public.example", "https://secret@public.example/article", "https://public.example:8443", "https://127.0.0.1", "https://[::1]", "https://router.local", "https://private.internal", "https://public.example/?access_token=secret", "https://public.example/?password=secret", "https://public.example/\nsecret", "https://public.example\\@private.local/"]) {
    assert.equal(externalSourceUrl(source), null, String(source));
  }
  assert.equal(externalSourceHost("https://www.facebook.com/post/123"), "www.facebook.com");
  assert.equal(externalSourceHost("javascript:alert(1)"), "");
});

test("actual post landing hides copied fields and opens the real source only on tap", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit();
    f.responder = (path) => path.startsWith("/feed/daily-post") ? response({ state: "ready", card: {
      id: "daily-A", card_id: "post-A", nickname: "A", audience: "parent", platform: "facebook", basis: "conversation",
      source_url: "https://www.facebook.com/groups/family/posts/123", headline: "COPY_HEADLINE", question: "COPY_QUESTION",
      situation: "COPY_SITUATION", takeaways: ["COPY_TAKEAWAY"], excerpt: "COPY_EXCERPT", why_this: "COPY_GUIDE", caution: "COPY_CAUTION",
    } }) : null;
    p = page(f); p.render(); await tick(); p.render();
    assert.doesNotMatch(p.visible(), /COPY_/);
    assert.equal(p.find("daily-post-excerpt"), undefined);
    assert.deepEqual(p.external, []);
    await p.find("daily-post-source").props.onPress();
    assert.deepEqual(p.external, ["https://www.facebook.com/groups/family/posts/123"]);
  } finally { p?.unmount(); f.restore(); }
});

test("actual post refuses a poisoned backend URL and shows actionable error", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); await f.permit();
    f.responder = (path) => path.startsWith("/feed/daily-post") ? response({ state: "ready", card: {
      id: "daily-A", nickname: "A", platform: "facebook", source_url: "https://secret@public.example/article",
    } }) : null;
    p = page(f); p.render(); await tick(); p.render();
    await p.find("daily-post-source").props.onPress(); p.render();
    assert.deepEqual(p.external, []);
    assert.ok(p.find("daily-post-source-error"));
  } finally { p?.unmount(); f.restore(); }
});

test("knowledge detail retains source links without copied images, summaries or guide", async () => {
  const f = fixture(); let p;
  try {
    await f.login("A"); p = page(f, "detail", { id: "stored-card", content_category: "authority" });
    p.render(); await tick(); p.render();
    assert.ok(p.find("detail-external-link-notice"));
    assert.doesNotMatch(p.visible(), /Stored summary|Stored body|Stored article|Stored video/);
    assert.equal(p.kind("ExpoImage"), undefined);
    assert.ok(p.find("detail-resource-stored-article"));
    await p.find("detail-resource-stored-article").props.onPress();
    assert.deepEqual(p.external, ["https://resource.invalid/article"]);
  } finally { p?.unmount(); f.restore(); }
});

test("dedicated chat recommendation markers cannot reproduce copied content, user photo/chat remain", () => {
  const source = readFileSync(new URL("../app/chat/[id].tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const renderProperties = [];
  function visit(node, inJsx = false) {
    const jsx = inJsx || ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
    if (jsx && ts.isPropertyAccessExpression(node)) renderProperties.push(node.getText(ast));
    ts.forEachChild(node, (child) => visit(child, jsx));
  }
  visit(ast);
  for (const key of ["post.headline", "post.takeaways", "video.thumbnail_url", "video.title", "video.channel"]) assert.ok(!renderProperties.includes(key), key);
  assert.match(source, /msg\.text && !post && !video/);
  assert.match(source, /uri: msg\.image_base64/);
});
