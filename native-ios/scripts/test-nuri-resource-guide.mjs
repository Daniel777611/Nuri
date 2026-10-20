import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/nuriResourceGuide.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const context = {
  exports: {},
  fetch: () => { throw new Error("network is forbidden in an authored reading template"); },
  require: () => { throw new Error("provider/storage imports are forbidden"); },
};
vm.runInNewContext(compiled, context);
const { nuriResourceGuide } = context.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const visible = (guide) => [guide.headline, guide.intro, ...guide.actions, guide.disclosure].join("\n");
const substitute = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (whole, key) => key in vars ? String(vars[key]) : whole);

const en = {
  "聊聊「{concern}」": "Talk about {concern}",
  "想聊的时候，Nuri 都在": "Nuri is here when you want to talk",
  "孩子正处在{stage}，关于「{concern}」，你最在意什么？可以从最近的一件事聊起。": "At {stage}, what matters to you about {concern}? We can start with something recent.",
  "关于「{concern}」，你最在意什么？想聊的时候可以直接告诉 Nuri，不需要先整理。": "What matters to you about {concern}? Tell Nuri whenever you like, no preparation needed.",
  "孩子正处在{stage}，你最近感觉怎么样？不需要先准备问题。": "With your child at {stage}, how have you been? No prepared questions needed.",
  "不需要先查资料或整理问题。想聊的时候，直接说说最近的情况就好。": "No research or prepared questions needed. Tell Nuri how things have been, whenever you like.",
  "这是可选的聊天邀请，不是原文或完整视频摘要。": "This is optional, not the original text or a full video summary.",
  "NURI 阅读导读": "NURI reading guide",
  "关于「{concern}」的 NURI 导读": "A NURI reading guide to {concern}",
  "你可以结合孩子目前的阶段（{stage}），围绕「{concern}」阅读原站内容，并核对哪些信息与你家有关。": "With your child's current stage ({stage}) in mind, read the source about {concern} and check what relates to your family.",
  "围绕「{concern}」阅读原站内容，留意作者说明的适用情境，和你家的情况作比较。": "Read the source about {concern}, note the author's stated context, and compare it with your family's situation.",
  "结合孩子目前的阶段（{stage}）阅读原站内容，留意作者说明的适用情境。": "Read the source with your child's current stage ({stage}) in mind, noting the author's stated context.",
  "阅读原站内容时，可以核对来源和适用情境，再决定是否继续了解。": "When reading the source, check its origin and context before deciding whether to learn more.",
  "到原站核对作者、发布日期和内容背景。": "Check the author, publication date, and context on the source website.",
  "记下与你家情况相关、还想进一步了解的问题。": "Note questions relevant to your family that you would like to explore further.",
  "把你的问题和观察带回 NURI，一起梳理和讨论。": "Bring your questions and observations back to NURI to organize and discuss them.",
  "这是 NURI 根据你的关注点提供的导读，不是原文或完整视频摘要。": "This is a NURI reading guide based on your interests, not the original text or a full video summary.",
};

test("QA Oct18: optional conversation invitation has no homework checklist", () => {
  const guide = nuriResourceGuide();
  assert.deepEqual(Object.keys(guide).sort(), ["actions", "disclosure", "headline", "intro"]);
  assert.equal(guide.headline, "想聊的时候，Nuri 都在");
  assert.equal(guide.actions.length, 0);
  assert.equal(guide.disclosure, "这是可选的聊天邀请，不是原文或完整视频摘要。");
  assert.doesNotMatch(visible(guide), /到原站核对作者|记下与你家|把你的问题和观察带回/);
  assert.ok(guide.intro.length < 80);
  assert.match(guide.intro, /不需要/);
});

test("Chinese default interpolates the family's concern and stage without placeholders", () => {
  const guide = nuriResourceGuide({ concern: "睡眠", stage: "11个月" });
  assert.equal(guide.headline, "聊聊「睡眠」");
  assert.match(guide.intro, /11个月.*睡眠/);
  assert.doesNotMatch(visible(guide), /\{(?:concern|stage)\}/);
});

test("English translator receives only Chinese keys and sanitized concern/stage variables", () => {
  const calls = [];
  const t = (key, vars) => {
    assert.ok(key in en, "missing test translation: " + key);
    calls.push({ key, vars });
    return substitute(en[key], vars);
  };
  const guide = nuriResourceGuide({ concern: "sleep", stage: "11 months" }, t);
  assert.equal(guide.headline, "Talk about sleep");
  assert.match(guide.intro, /11 months.*sleep/);
  assert.doesNotMatch(visible(guide), /[一-鿿]|\{(?:concern|stage)\}/);
  assert.deepEqual(plain(calls[0].vars), { concern: "sleep" });
  assert.deepEqual(plain(calls[1].vars), { concern: "sleep", stage: "11 months" });
});

test("concern-only, stage-only and empty branches have complete translated sentences", () => {
  const t = (key, vars) => substitute(en[key], vars);
  for (const input of [{ concern: "sleep" }, { stage: "11 months" }, {}]) {
    const guide = nuriResourceGuide(input, t);
    assert.equal(guide.actions.length, 0);
    assert.doesNotMatch(visible(guide), /undefined|null|\{(?:concern|stage)\}|[一-鿿]/);
  }
});
test("untranslated Chinese labels cannot leak into the English invitation",()=>{
 const t=(key,vars)=>substitute(en[key]??key,vars);
 const guide=nuriResourceGuide({concern:"7个月 · 饮食",stage:"7个月"},t,"en");
 assert.doesNotMatch(visible(guide),/[一-鿿]/);assert.equal(guide.headline,en["想聊的时候，Nuri 都在"]);
 assert.equal(guide.actions.length,0,"fallback is an invitation, not fabricated translated advice");
});

test("empty and non-text labels cannot stringify unknown objects into UI", () => {
  const fallback = plain(nuriResourceGuide());
  for (const input of [null, undefined, {}, { concern: "  ", stage: "\n" },
    { concern: { text: "RAW_OBJECT" }, stage: ["RAW_ARRAY"] }, { concern: 42, stage: true }]) {
    assert.deepEqual(plain(nuriResourceGuide(input)), fallback);
  }
});

test("HTML, links, control and bidirectional characters are removed before interpolation", () => {
  const guide = nuriResourceGuide({
    concern: "<script>RAW_SCRIPT</script><b>睡眠</b> https://private.example/RAW_URL\u202e\u0000",
    stage: "<em>11个月</em>\n\t",
  });
  assert.equal(guide.headline, "聊聊「睡眠」");
  assert.match(guide.intro, /11个月.*睡眠/);
  assert.doesNotMatch(visible(guide), /RAW_|<|>|https|\u202e|\u0000/);
});

test("malicious links and encoded markup alone degrade to the generic guide", () => {
  const fallback = plain(nuriResourceGuide());
  for (const concern of ["<a href='https://private.example'>RAW_ANCHOR</a>",
    "[RAW_MARKDOWN](https://private.example/path)", "javascript:RAW_PAYLOAD", "data:text/html,RAW_PAYLOAD",
    "https%3A%2F%2Fprivate.example/RAW_URL", "private.example/RAW_URL", "person@private.example",
    "&lt;script&gt;RAW_SCRIPT&lt;/script&gt;", "<!--RAW_COMMENT", "<img src='https://private.example/RAW_IMAGE'>"]) {
    assert.deepEqual(plain(nuriResourceGuide({ concern })), fallback, concern);
  }
});

test("labels are bounded by Unicode code points without half an emoji", () => {
  const calls = [];
  nuriResourceGuide({ concern: "🦙".repeat(5000), stage: "月".repeat(5000) }, (key, vars) => {
    calls.push({ key, vars });
    return substitute(key, vars);
  });
  assert.equal(Array.from(calls[0].vars.concern).length, 48);
  assert.equal(Array.from(calls[1].vars.stage).length, 32);
  assert.equal(calls[0].vars.concern, "🦙".repeat(48));
  const guide = nuriResourceGuide({ concern: "a".repeat(5000), stage: "b".repeat(5000) });
  assert.ok(Array.from(guide.headline).length < 80);
  assert.ok(Array.from(guide.intro).length < 160);
});

test("raw resource fields are never read or copied, even as fallbacks", () => {
  const input = { concern: "睡眠", stage: "11个月" };
  for (const field of ["title", "headline", "summary", "excerpt", "why_this", "description", "source_url", "thumbnail_url"]) {
    Object.defineProperty(input, field, { get() { throw new Error("raw source field read: " + field); } });
  }
  assert.deepEqual(plain(nuriResourceGuide(input)), plain(nuriResourceGuide({ concern: "睡眠", stage: "11个月" })));
  const raw = { title: "RAW_TITLE", summary: "RAW_SUMMARY", excerpt: "RAW_EXCERPT", why_this: "RAW_GUIDE" };
  assert.doesNotMatch(visible(nuriResourceGuide(raw)), /RAW_/);
});

test("module has no imports or executable network/provider/storage dependency", () => {
  const ast = ts.createSourceFile("guide.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) imports.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(imports.length, 0);
  assert.doesNotMatch(compiled, /\b(?:fetch|require|XMLHttpRequest|WebSocket)\s*\(/);
  assert.doesNotMatch(visible(nuriResourceGuide()), /诊断|治愈|服药|保证|疗效/);
});
