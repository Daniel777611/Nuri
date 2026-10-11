import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/resourceSummary.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const context = { exports: {}, require: () => { throw new Error("summary display must not import providers, storage or source data"); },
  fetch: () => { throw new Error("network forbidden"); } };
vm.runInNewContext(compiled, context);
const { resourceSummary, shortResourceSummary, resourceSummaryDisclosure, RESOURCE_SUMMARY_DISCLOSURE } = context.exports;

test("short supplied text is preserved without paraphrasing or adding facts", () => {
  assert.equal(resourceSummary("Some families report different routines."), "Some families report different routines.");
  assert.equal(shortResourceSummary("用户的问题", 10), "用户的问题", "a short whole phrase need not invent punctuation");
  assert.equal(resourceSummary(["First supplied point.", "Second supplied point."]), "First supplied point.\nSecond supplied point.");
});
test("non-text values and empty inputs do not select fields or stringify objects", () => {
  const input = {};
  for (const field of ["title", "headline", "summary", "excerpt", "body", "description"]) {
    Object.defineProperty(input, field, { get() { throw new Error("source field must not be read"); } });
  }
  for (const value of [input, null, undefined, 42, true, [], ["text", {}], "  \n\t ", "<br>"]) assert.equal(resourceSummary(value), null);
});
test("HTML, entities, scripts, URLs and controls become plain display text", () => {
  const value = "<script>RAW_SCRIPT</script><style>RAW_STYLE</style><p>先核对&amp;比较。</p><p>再提问。https://source.example/RAW_URL\u0000\u202e</p>";
  assert.equal(resourceSummary(value), "先核对&比较。\n再提问。");
  assert.equal(resourceSummary("&lt;b&gt;Don't&lt;/b&gt; skip context. &#x1F9D0;"), "Don't skip context. 🧐");
  assert.equal(resourceSummary("See [the source](https://example.com/path) first."), "See the source first.");
  assert.equal(resourceSummary("https://example.com/secret"), null);
  assert.equal(resourceSummary("www.example.com/secret"), null);
  assert.equal(resourceSummary("person@example.com"), null);
});
test("overlong Chinese text stops only at a complete sentence or supplied paragraph", () => {
  const first = "先了解孩子的情况。";
  const second = "不要在没有专业指导的情况下把这个方法用于所有孩子。";
  assert.equal(shortResourceSummary(first + second, first.length + 6), first);
  assert.equal(shortResourceSummary(second + "后面还有背景信息。", 12), null, "never trim away a condition or sentence-ending negation");
  assert.equal(resourceSummary(["第一个完整要点", "第二个完整要点很长很长"], { limit: 10 }), "第一个完整要点");
  const chinese = "这是已提供的完整一句。".repeat(40);
  const result = resourceSummary(chinese);
  assert.ok(Array.from(result).length <= 220); assert.ok(result.endsWith("。"));
});
test("overlong English text keeps complete sentences, not decimal or abbreviation fragments", () => {
  assert.equal(resourceSummary("Dr. Smith explains the context. Do not skip the qualification.", { limit: 12 }), null);
  assert.equal(resourceSummary("A score of 1.5 does not settle the question. More context is needed.", { limit: 16 }), null);
  assert.equal(resourceSummary("One supplied sentence. The long second sentence continues without enough space.", { limit: 30 }), "One supplied sentence.");
  const result = resourceSummary("A supplied sentence with context. ".repeat(80), { locale: "en" });
  assert.ok(Array.from(result).length <= 800); assert.ok(result.endsWith("."));
});
test("closing quotes and Unicode code points are kept whole", () => {
  const value = "“先核对。”然后是后续很长的背景。";
  assert.equal(resourceSummary(value, { limit: 6 }), "“先核对。”");
  assert.equal(resourceSummary(value, { limit: 5 }), null, "do not cut a sentence's closing quotation mark");
  assert.equal(resourceSummary("🦙🦙。后续背景还很长。", { limit: 3 }), "🦙🦙。");
});
test("locale and caller limits stay bounded; unbroken overlong fragments return null", () => {
  const input = "完整的一句。".repeat(200);
  assert.ok(Array.from(resourceSummary(input, { locale: "zh-TW" })).length <= 220);
  assert.ok(Array.from(resourceSummary(input, { locale: "en" })).length <= 800);
  assert.ok(Array.from(shortResourceSummary(input, 60)).length <= 60);
  assert.equal(resourceSummary("a".repeat(900)), null);
  assert.equal(resourceSummary("a".repeat(100001)), null);
  assert.equal(resourceSummary(input, { limit: -5 }), null);
});
test("disclosure preserves provenance limits without claiming lawful permission or full source coverage", () => {
  assert.equal(resourceSummaryDisclosure(), RESOURCE_SUMMARY_DISCLOSURE);
  assert.equal(resourceSummaryDisclosure((key) => "translated:" + key), "translated:" + RESOURCE_SUMMARY_DISCLOSURE);
  assert.match(RESOURCE_SUMMARY_DISCLOSURE, /部分内容.*有误.*原站核对.*不代表完整/);
  assert.doesNotMatch(RESOURCE_SUMMARY_DISCLOSURE, /合法|已授权|不会侵权|完整视频摘要已验证/);
  assert.doesNotMatch(compiled, /\b(?:fetch|require|XMLHttpRequest|WebSocket)\s*\(/);
});
