import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {performance} from "node:perf_hooks";
import {test} from "node:test";
import vm from "node:vm";
import ts from "typescript";

const sourceUrl = new URL("../src/keyboard/pinyinEngine.ts", import.meta.url);
const vendorUrl = new URL("../src/keyboard/vendor/", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const dictionaryBytes = readFileSync(new URL("simple-ime/google-pinyin-dict.json", vendorUrl));
const converterBytes = readFileSync(new URL("opencc-js/cn2t.js", vendorUrl));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const code = ts.transpileModule(source, {compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, removeComments: true,
}}).outputText;

// Real unmodified dictionary/converter bytes, not a candidate mock. The VM has
// no DOM, native module, network, storage, WebAssembly, timer or log API.
function loadEngine({failData = false, failConverter = false} = {}) {
  const required = [], module = {exports: {}}, sandbox = {
    module, exports: module.exports, fetch: undefined, XMLHttpRequest: undefined,
    window: undefined, document: undefined, localStorage: undefined,
    WebAssembly: undefined, console: undefined, setTimeout: undefined,
    require(name) {
      required.push(name);
      if (name === "./vendor/simple-ime/google-pinyin-dict.json") {
        if (failData) throw new Error("fixture local data unavailable");
        return JSON.parse(dictionaryBytes.toString("utf8"));
      }
      if (name === "./vendor/opencc-js/cn2t.js") {
        if (failConverter) throw new Error("fixture local converter unavailable");
        const converterModule = {exports: {}};
        vm.runInNewContext(converterBytes.toString("utf8"), {
          module: converterModule, exports: converterModule.exports,
          window: undefined, document: undefined, fetch: undefined,
          localStorage: undefined, WebAssembly: undefined, console: undefined,
        }, {filename: "pinned-opencc-cn2t.js", timeout: 5000});
        return converterModule.exports;
      }
      throw new Error(`unexpected engine dependency ${name}`);
    },
  };
  vm.runInNewContext(code, sandbox, {filename: "pinyinEngine.js", timeout: 5000});
  return {...module.exports, required};
}

const engine = loadEngine();
const candidates = (raw, script = "zh-CN") => Array.from(engine.getPinyinCandidates(raw, script));

test("vendored Google/AOSP data is pinned, real word-frequency data without augmented emoji", () => {
  assert.equal(dictionaryBytes.length, 4093442);
  assert.equal(hash(dictionaryBytes), "b69f653eeae8f730eb90c8d07f6587c0d2d879e2533e41aa14e49027bb02ea3d");
  const dictionary = JSON.parse(dictionaryBytes.toString("utf8"));
  assert.equal(Object.keys(dictionary).length, 49506);
  let records = 0;
  const words = new Set();
  for (const [key, rows] of Object.entries(dictionary)) {
    assert.match(key, /^[a-z]+$/);
    for (const row of rows) {
      assert.equal(typeof row.w, "string"); assert.ok(row.w.length);
      assert.ok(Number.isFinite(row.f) && row.f >= 0);
      assert.doesNotMatch(row.w, /\p{Extended_Pictographic}/u);
      records++; words.add(row.w);
    }
  }
  assert.equal(records, 103385); assert.equal(words.size, 54666);
  const syllables = source.match(/const SYLLABLES = new Set\("([a-z|]+)"\.split/)[1].split("|");
  assert.equal(syllables.length, 416); assert.equal(new Set(syllables).size, 416);
  assert.equal(hash(syllables.join("\n")), "e463de9d56cb9e2ed9f1057d706c8fba6464f74b4a8e0fc9dd832769cbf20289");
});

test("MIT, Apache and conversion provenance stay shipped with exact pinned converter bytes", () => {
  assert.equal(converterBytes.length, 1100656);
  assert.equal(hash(converterBytes), "d66d920069ab526db08c6f2bc15fcf6feb7d07de3cf98e7e27c0aaf7d136baee");
  const text = path => readFileSync(new URL(path, vendorUrl), "utf8");
  assert.match(text("simple-ime/LICENSE"), /MIT License[\s\S]*nieyuyao0826/);
  assert.match(text("simple-ime/AOSP-NOTICE"), /Apache License[\s\S]*Version 2\.0/);
  assert.match(text("simple-ime/PROVENANCE.md"), /d503bee97392f3b99e1fb9d6f23cecc86ced6f26/);
  assert.match(text("opencc-js/LICENSE"), /MIT License[\s\S]*nk2028/);
  assert.match(text("opencc-js/APACHE-2.0.txt"), /Apache License[\s\S]*Version 2\.0/);
  assert.match(text("opencc-js/THIRD_PARTY_LICENSES.md"), /opencc-data[\s\S]*Apache/);
  assert.match(text("opencc-js/PROVENANCE.md"), /opencc-js@1\.4\.2[\s\S]*ba20c6eda99e7ec385bcf706da2776372675b898/);
});

test("bundled notices payload includes exact complete license and attribution texts for an in-app access path", () => {
  const notices = JSON.parse(readFileSync(new URL("THIRD_PARTY_NOTICES.json", vendorUrl), "utf8"));
  assert.equal(notices.title, "Keyboard open-source notices");
  assert.equal(notices.components.length, 5);
  assert.equal(new Set(notices.components.map(item => item.name)).size, 5);
  const files = ["simple-ime/LICENSE", "simple-ime/AOSP-NOTICE", "opencc-js/LICENSE",
    "opencc-js/APACHE-2.0.txt", "opencc-js/THIRD_PARTY_LICENSES.md"];
  for (const [index, component] of notices.components.entries()) {
    assert.equal(typeof component.name, "string"); assert.ok(component.name.length);
    assert.equal(typeof component.version, "string"); assert.ok(component.version.length);
    assert.ok(["MIT", "Apache-2.0"].includes(component.license));
    assert.match(component.source, /^https:\/\/(?:github\.com|registry\.npmjs\.org)\//);
    assert.deepEqual(component.paths, [files[index]]);
    assert.equal(component.text, readFileSync(new URL(files[index], vendorUrl), "utf8"));
    assert.ok(component.text.length > 1000);
  }
  assert.match(notices.components[0].version, /1\.2\.4[\s\S]*d503bee9/);
  assert.match(notices.components[2].version, /1\.4\.2[\s\S]*ba20c6ed/);
});

test("actual full pinyin and phrase segmentation return real whole-composition candidates", () => {
  for (const [raw, expected] of [["nihao", "你好"], ["baobao", "宝宝"], ["mama", "妈妈"],
    ["xihongshi", "西红柿"], ["woshizhongguoren", "我是中国人"]]) {
    assert.equal(candidates(raw)[0], expected);
  }
  assert.ok(candidates("nh").includes("你好"), "Original real dictionary abbreviation remains usable");
  assert.equal(candidates("shi")[0], "是", "Static frequency must be descending, unlike upstream storage order");
  assert.ok(candidates("shi").includes("诗"));
});

test("Traditional output uses genuine phrase-aware local OpenCC, not fabricated character swaps", () => {
  for (const [raw, simplified, traditional] of [["baobao", "宝宝", "寶寶"],
    ["mama", "妈妈", "媽媽"], ["toufa", "头发", "頭髮"],
    ["fazhan", "发展", "發展"], ["diannao", "电脑", "電腦"],
    ["woshizhongguoren", "我是中国人", "我是中國人"]]) {
    assert.equal(candidates(raw, "zh-CN")[0], simplified);
    assert.equal(candidates(raw, "zh-TW")[0], traditional);
  }
});

test("full raw-range replacement honors apostrophes and never offers only a consumed prefix", () => {
  assert.ok(candidates("ni'hao").includes("你好"));
  assert.deepEqual(candidates("ni’hao"), candidates("ni'hao"));
  assert.ok(candidates("xi'an").includes("西安"));
  assert.ok(!candidates("xi'an").includes("先"));
  assert.ok(!candidates("nihao").includes("你"));
  assert.deepEqual(candidates("nihaozzzz"), []);
  assert.deepEqual(candidates("iiii"), []);
  const raw = "nihaozzzz";
  engine.getPinyinCandidates(raw); assert.equal(raw, "nihaozzzz", "Unknown raw draft is retained by its caller");
  for (const text of candidates("woshizhongguoren")) assert.equal(Array.from(text).length, 5);
});

test("normalization, limits and invalid inputs are deterministic without truncation or asset access", () => {
  assert.deepEqual(candidates("NIHAO"), candidates("nihao"));
  assert.deepEqual(candidates("LÜ"), candidates("lv"));
  assert.equal(engine.MAX_PINYIN_INPUT_LENGTH, 32);
  assert.equal(engine.MAX_PINYIN_CANDIDATES, 32);
  const fresh = loadEngine();
  for (const raw of ["", "'", "'''", "中文", "ni hao", "ni3hao3", "ni-hao", "ni\nhao", "a".repeat(33), null, 42, {}]) {
    assert.deepEqual(Array.from(fresh.getPinyinCandidates(raw)), []);
  }
  assert.deepEqual(Array.from(fresh.getPinyinCandidates("nihao", "invalid")), []);
  assert.deepEqual(fresh.required, []);
  const output = engine.getPinyinCandidates("shi");
  assert.ok(Object.isFrozen(output)); assert.ok(output.length <= 32);
  assert.equal(new Set(output).size, output.length);
  assert.ok(output.every(value => typeof value === "string" && value.length));
  assert.throws(() => output.push("not a candidate"), error => error.name === "TypeError");
  assert.deepEqual(candidates("shi"), Array.from(output));
});

test("missing local resources fail closed without partial conversion, mutation, network or hidden fallback", () => {
  const dataFailure = loadEngine({failData: true});
  assert.deepEqual(Array.from(dataFailure.getPinyinCandidates("nihao")), []);
  assert.deepEqual(dataFailure.required, ["./vendor/simple-ime/google-pinyin-dict.json"]);
  const conversionFailure = loadEngine({failConverter: true});
  assert.deepEqual(Array.from(conversionFailure.getPinyinCandidates("baobao", "zh-TW")), []);
  assert.equal(conversionFailure.getPinyinCandidates("baobao", "zh-CN")[0], "宝宝");
  assert.deepEqual(conversionFailure.required, ["./vendor/simple-ime/google-pinyin-dict.json", "./vendor/opencc-js/cn2t.js"]);
  assert.deepEqual(engine.required, ["./vendor/simple-ime/google-pinyin-dict.json", "./vendor/opencc-js/cn2t.js"]);
  assert.doesNotMatch(code, /\b(?:fetch|XMLHttpRequest|localStorage|AsyncStorage|SecureStore|console)\s*[.(]/);
  assert.doesNotMatch(code, /\b(?:setTimeout|setInterval|eval|WebAssembly)\s*[.(]/);
  assert.doesNotMatch(source, /[\u3400-\u9fff]/, "There must be no hardcoded Hanzi candidate fixtures in the engine");
  assert.match(source, /const MAX_PREFIX_KEYS = 8192/);
  assert.match(source, /const BEAM_SIZE = 8/);
  assert.match(source, /const dict = data\(\), lookups = new Map/);
});

test("bounded cold/warm offline work reports Node-only measurements, not native performance acceptance", t => {
  const before = process.memoryUsage().heapUsed, fresh = loadEngine();
  const start = performance.now();
  assert.equal(fresh.getPinyinCandidates("nihao")[0], "你好");
  const simplifiedMs = performance.now() - start, traditionalStart = performance.now();
  assert.equal(fresh.getPinyinCandidates("toufa", "zh-TW")[0], "頭髮");
  const traditionalMs = performance.now() - traditionalStart;
  const afterCold = process.memoryUsage().heapUsed;
  const probes = ["xian".repeat(8), "an".repeat(16), "z".repeat(32), "nihaozzzz", "baobao", "woshizhongguoren"];
  const warmStart = performance.now();
  for (let index = 0; index < 120; index++) {
    const values = fresh.getPinyinCandidates(probes[index % probes.length], index % 2 ? "zh-CN" : "zh-TW");
    assert.ok(values.length <= 32); assert.equal(new Set(values).size, values.length);
  }
  const warm120Ms = performance.now() - warmStart;
  assert.ok(simplifiedMs < 5000 && traditionalMs < 5000 && warm120Ms < 5000, "Broad offline smoke ceiling only, not a frame budget");
  assert.deepEqual(fresh.required, ["./vendor/simple-ime/google-pinyin-dict.json", "./vendor/opencc-js/cn2t.js"]);
  t.diagnostic(JSON.stringify({runtime: "bundled Node VM, not Hermes/UIKit acceptance", simplifiedColdMs: +simplifiedMs.toFixed(2),
    traditionalFirstMs: +traditionalMs.toFixed(2), warm120Ms: +warm120Ms.toFixed(2),
    heapDeltaColdMiB: +((afterCold - before) / 1048576).toFixed(2),
    limits: {raw: 32, candidates: 32, prefixKeys: 8192, beam: 8}}));
});
