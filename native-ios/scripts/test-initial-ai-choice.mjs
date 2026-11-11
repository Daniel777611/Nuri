import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function load(path, deps = {}, transform = source => source) {
  const output = ts.transpileModule(transform(readFileSync(new URL(path, import.meta.url), "utf8")), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)(name => { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name]; }, module, module.exports);
  return module.exports;
}
const policy = load("../src/aiConsent.ts");
const choice = load("../src/initialAIChoice.ts", { "./aiConsent": policy });
const copyModule = load("../src/aiConsentCopy.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(policyModule = policy, choiceModule = choice) {
  const secure = new Map(), ordinary = new Map(), writes = [];
  let token = null, failChoiceWrite = false, pauseChoice = null;
  const storage = {
    secureGet: async (key, fallback) => secure.get(key) ?? fallback,
    secureSet: async (key, value) => {
      writes.push(key);
      if (key === choiceModule.INITIAL_AI_CHOICE_KEY) { if (pauseChoice) await pauseChoice; if (failChoiceWrite) return false; }
      secure.set(key, value); return true;
    },
    getItem: async (key, fallback) => ordinary.get(key) ?? fallback,
    setItem: async (key, value) => { ordinary.set(key, value); return true; },
  };
  const aiConsent = new policyModule.AIConsentController({ storage, getToken: async () => token, resolveUser: async value => `user-${value}` });
  return { storage, secure, ordinary, writes, aiConsent, policy: policyModule, choice: choiceModule,
    signIn: async value => { token = value; aiConsent.sessionChanged(); await aiConsent.refresh(); },
    failChoice: value => failChoiceWrite = value,
    pauseChoice: () => { let release; pauseChoice = new Promise(resolve => release = resolve); return () => { pauseChoice = null; release(); }; },
  };
}

test("fresh/corrupt/old initial notice is never an account grant", async () => {
  for (const raw of [undefined, "not-json", JSON.stringify({ version: "old", allowed: true, phase: "pending", ownerId: null }), JSON.stringify({ version: policy.AI_CONSENT_VERSION, allowed: true, phase: "consumed", ownerId: null })]) {
    const f = fixture(); if (raw) f.secure.set(choice.INITIAL_AI_CHOICE_KEY, raw);
    const controller = new choice.InitialAIChoiceController(f.storage);
    assert.equal(await controller.load(), null);
    await f.signIn("A"); await assert.rejects(f.aiConsent.authorize("A"));
    assert.equal(f.aiConsent.getState().choiceRecorded, false);
  }
});
test("pre-login choice is one-use and is consumed durably before any account permission", async () => {
  const f = fixture(), c = new choice.InitialAIChoiceController(f.storage); await c.load();
  await c.choose(true, null); await f.signIn("A");
  assert.equal(f.aiConsent.getState().status, "not_allowed");
  const [one, two] = await Promise.all([c.claimPending("user-A"), c.claimPending("user-B")]);
  assert.equal(one.ownerId, "user-A"); assert.equal(two, null);
  assert.equal(JSON.parse(f.secure.get(choice.INITIAL_AI_CHOICE_KEY)).phase, "consumed");
  assert.equal(f.aiConsent.getState().status, "not_allowed");
  await f.aiConsent.setAllowed(one.allowed, f.aiConsent.getState());
  await f.aiConsent.authorize("A"); await f.signIn("B");
  assert.equal(await c.claimPending("user-B"), null); await assert.rejects(f.aiConsent.authorize("B"));
});
test("interrupted consume cannot grant a different account or replay after restart", async () => {
  const f = fixture(), c = new choice.InitialAIChoiceController(f.storage); await c.load(); await c.choose(true, null); await f.signIn("A");
  const expected = f.aiConsent.getState(), release = f.pauseChoice(), pending = c.claimPending("user-A");
  await tick(); await f.signIn("B"); release(); const claimed = await pending;
  assert.equal(await f.aiConsent.setAllowed(claimed.allowed, expected), false);
  const restarted = new choice.InitialAIChoiceController(f.storage); await restarted.load();
  assert.equal(await restarted.claimPending("user-B"), null); await assert.rejects(f.aiConsent.authorize("B"));
});
test("failed initial persistence or consume never authorizes AI", async () => {
  const f = fixture(), c = new choice.InitialAIChoiceController(f.storage); await c.load(); f.failChoice(true);
  await assert.rejects(c.choose(true, null)); await f.signIn("A"); await assert.rejects(f.aiConsent.authorize("A"));
  f.failChoice(false); await c.choose(true, null); f.failChoice(true); await assert.rejects(c.claimPending("user-A"));
  await assert.rejects(f.aiConsent.authorize("A"));
});
test("saved refusal is distinct from never asked and remains blocked after restore", async () => {
  const f = fixture(); await f.signIn("A"); assert.equal(f.aiConsent.getState().choiceRecorded, false);
  await f.aiConsent.setAllowed(false, f.aiConsent.getState()); await f.aiConsent.refresh();
  assert.equal(f.aiConsent.getState().choiceRecorded, true); assert.equal(f.aiConsent.getState().status, "not_allowed");
  await assert.rejects(f.aiConsent.authorize("A")); await f.signIn("B"); assert.equal(f.aiConsent.getState().choiceRecorded, false);
});

function gateFixture(f, locale = "zh-CN") {
  let cursor = 0; const hooks = [], effects = [], frames = [];
  // Match the actual useAIConsent subscription: releasing the deny-only
  // startup latch invalidates "allowed" and rechecks the durable account row.
  const unsubscribe = f.aiConsent.subscribe(next => { if (next.status === "unknown") void f.aiConsent.refresh(); });
  const react = {
    useState(initial) { const n = cursor++; if (!(n in hooks)) hooks[n] = { value: typeof initial === "function" ? initial() : initial }; return [hooks[n].value, value => hooks[n].value = typeof value === "function" ? value(hooks[n].value) : value]; },
    useRef(initial) { const n = cursor++; return hooks[n] ??= { current: initial }; },
    useEffect(callback, deps) { const n = cursor++, previous = hooks[n]; if (!previous || deps.some((value, i) => value !== previous.deps[i])) effects.push(() => { previous?.cleanup?.(); hooks[n] = { deps, cleanup: callback() }; }); },
  };
  const jsx = (type, props) => ({ type, props });
  const page = load("../src/components/AIConsentStartupGate.tsx", {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { ActivityIndicator: "ActivityIndicator", Linking: { openURL: (...args) => f.openURL ? f.openURL(...args) : Promise.resolve() }, Modal: "Modal", Pressable: "Pressable", ScrollView: "ScrollView", View: "View", StyleSheet: { create: v => v, hairlineWidth: 1 } },
    "react-native-safe-area-context": { SafeAreaProvider: "SafeAreaProvider", SafeAreaView: "SafeAreaView" },
    "@/src/api": { aiConsent: f.aiConsent }, "@/src/aiConsent": f.policy, "@/src/aiConsentCopy": copyModule,
    "@/src/initialAIChoice": f.choice, "@/src/useAIConsent": { useAIConsent: () => ({ state: f.aiConsent.getState(), refresh: f.aiConsent.refresh }) },
    "@/src/utils/storage": { storage: f.storage }, "@/src/i18n": { useT: () => ({ locale }), translate: (_locale, value) => value },
    "@/src/uiux48/Primitives": { NuriButton: "NuriButton", NuriText: "NuriText" },
  }).AIConsentStartupGate;
  const render = () => { cursor = 0; const tree = page({ children: "NAVIGATOR_STAYS_MOUNTED" }); frames.push(find(tree, node => node.type === "Modal").props.visible); effects.splice(0).forEach(run => run()); return tree; };
  const find = (node, predicate) => {
    if (!node || typeof node !== "object") return null;
    if (predicate(node)) return node;
    for (const child of [node.props?.children].flat(Infinity)) { const result = find(child, predicate); if (result) return result; }
    return null;
  };
  const byId = (tree, id) => find(tree, node => node.props?.testID === id);
  return { render, byId, frames, clearFrames: () => { frames.length = 0; }, modal: tree => find(tree, node => node.type === "Modal"),
    privacyLink: tree => find(tree, node => node.type === "Pressable" && node.props?.accessibilityRole === "link"),
    settle: async () => { let tree; for (let i = 0; i < 8; i++) { tree = render(); await tick(); } return tree; }, unmount: () => { unsubscribe(); hooks.forEach(h => h?.cleanup?.()); } };
}
for (const allowed of [true, false]) test(`first-open UI chooses ${allowed} before login; next account applies once, navigator never unmounts`, async () => {
  const f = fixture(); await f.aiConsent.refresh(); const ui = gateFixture(f); let tree = await ui.settle();
  assert.equal(ui.modal(tree).props.visible, true); assert.equal(tree.props.children[0], "NAVIGATOR_STAYS_MOUNTED");
  const button = ui.byId(tree, allowed ? "startup-ai-allow" : "startup-ai-decline"); assert.ok(button);
  assert.equal(button.props.style.width, "100%"); assert.ok(button.props.label.length < 20);
  assert.ok(ui.byId(tree, "startup-ai-explanation-scroll"));
  for (let i = 0; i < 5; i++) assert.ok(ui.byId(tree, `startup-ai-explanation-${i}`));
  button.props.onPress(); tree = await ui.settle(); assert.equal(ui.modal(tree).props.visible, false);
  assert.equal(f.aiConsent.getState().status, "signed_out"); await f.signIn("A"); tree = await ui.settle();
  assert.equal(f.aiConsent.getState().status, allowed ? "allowed" : "not_allowed");
  assert.equal(f.aiConsent.getState().choiceRecorded, true); assert.equal(ui.modal(tree).props.visible, false);
  await f.signIn("B"); tree = await ui.settle(); assert.equal(ui.modal(tree).props.visible, true);
  await assert.rejects(f.aiConsent.authorize("B")); assert.equal(tree.props.children[0], "NAVIGATOR_STAYS_MOUNTED");
});
test("full-screen startup modal owns its measured safe-area frame on all four edges without wrapping or resetting the navigator", async () => {
  const f = fixture(); await f.aiConsent.refresh(); const ui = gateFixture(f);
  const assertBoundary = tree => {
    assert.equal(tree.type, "Fragment"); assert.equal(tree.props.children[0], "NAVIGATOR_STAYS_MOUNTED");
    const modal = ui.modal(tree); assert.equal(modal.props.presentationStyle, "fullScreen");
    const provider = modal.props.children; assert.equal(provider.type, "SafeAreaProvider");
    assert.equal(provider.props.testID, "startup-ai-modal-safe-area-provider"); assert.equal(provider.props.style.flex, 1);
    assert.equal(Object.hasOwn(provider.props, "initialMetrics"), false, "Native modal measures its own frame, not cached root/window metrics");
    assert.equal(Object.hasOwn(provider.props, "key"), false, "No permission/account reset key on the provider");
    const safe = provider.props.children; assert.equal(safe.type, "SafeAreaView");
    assert.equal(safe.props.testID, "startup-ai-permission"); assert.equal(safe.props.style.flex, 1);
    assert.deepEqual(safe.props.edges, ["top", "right", "bottom", "left"]);
    const [heading, scroll, footer] = safe.props.children;
    assert.equal(heading.type, "View"); assert.equal(heading.props.children[0].type, "NuriText");
    assert.equal(scroll.props.testID, "startup-ai-explanation-scroll"); assert.equal(scroll.props.style.flex, 1);
    assert.equal(footer.type, "View"); assert.ok(ui.byId(footer, "startup-ai-allow")); assert.ok(ui.byId(footer, "startup-ai-decline"));
    assert.equal(heading.props.style.paddingTop, 20); assert.equal(footer.props.style.paddingBottom, 12, "Content padding is additional to the measured safe-area padding");
    assert.equal(tree.props.children.filter(child => child?.type === "SafeAreaProvider").length, 0, "The new provider is local to Modal, never an ancestor of the navigator");
    return modal;
  };
  try {
    let tree = await ui.settle(); assert.equal(assertBoundary(tree).props.visible, true);
    ui.byId(tree, "startup-ai-decline").props.onPress(); tree = await ui.settle(); assert.equal(assertBoundary(tree).props.visible, false);
    await f.signIn("A"); tree = await ui.settle(); assert.equal(assertBoundary(tree).props.visible, false);
    await f.signIn("B"); tree = await ui.settle(); assert.equal(assertBoundary(tree).props.visible, true);
  } finally { ui.unmount(); }
});
test("startup saving failure stays visible and waits for explicit retry, without a write loop", async () => {
  const f = fixture(); await f.aiConsent.refresh(); const ui = gateFixture(f); let tree = await ui.settle(); f.failChoice(true);
  ui.byId(tree, "startup-ai-allow").props.onPress(); tree = await ui.settle();
  assert.equal(ui.modal(tree).props.visible, true); assert.ok(ui.byId(tree, "startup-ai-error"));
  const count = f.writes.length; await ui.settle(); assert.equal(f.writes.length, count);
  f.failChoice(false); ui.byId(tree, "startup-ai-decline").props.onPress(); tree = await ui.settle(); assert.equal(ui.modal(tree).props.visible, false);
});
test("already-recorded account choices require no startup migration or account permission rewrite", async () => {
  for (const allowed of [true, false]) {
    const f = fixture(); await f.signIn("A"); await f.aiConsent.setAllowed(allowed, f.aiConsent.getState());
    const count = f.writes.length;
    const ui = gateFixture(f), tree = await ui.settle(); assert.equal(ui.modal(tree).props.visible, false);
    assert.equal(f.writes.length, count);
    assert.ok(ui.frames.every(visible => visible === false), "Hydration and automatic bookkeeping may not flash the consent sheet");
  }
});
test("startup hold release rechecks a loading legacy grant without opening the consent sheet", async () => {
  const f = fixture(); await f.signIn("A"); await f.aiConsent.setAllowed(true, f.aiConsent.getState());
  let releaseRead;
  const barrier = new Promise(resolve => releaseRead = resolve), originalGet = f.storage.secureGet;
  f.storage.secureGet = async (key, fallback) => {
    if (key.startsWith("ai_consent.")) await barrier;
    return originalGet(key, fallback);
  };
  const releaseWrite = f.pauseChoice(), ui = gateFixture(f);
  try {
    ui.render(); await tick();
    // Loading the initial journal releases the deny-only startup hold and
    // rechecks the existing account row; it never starts a migration write.
    ui.render(); await tick();
    assert.equal(f.aiConsent.getState().status, "loading");
    // Additional renders while account storage is slow must remain hidden.
    ui.render(); await tick();
    releaseWrite(); await tick();
    // The same loading read may finish normally after the storage barrier.
    ui.render(); await tick(); releaseRead();
    const tree = await ui.settle();
    assert.equal(f.aiConsent.getState().status, "allowed");
    assert.equal(ui.modal(tree).props.visible, false);
    assert.ok(ui.frames.every(visible => visible === false));
    await f.aiConsent.authorize("A");
    const writes = f.writes.length; await ui.settle();
    assert.equal(f.writes.length, writes, "A settled startup must not repeat migration writes");
  } finally { releaseWrite(); releaseRead(); ui.unmount(); }
});

for (const allowed of [true, false]) for (const initialJournal of [true, false]) test(`recorded ${allowed} account, journal=${initialJournal}: repeated background/active refresh has no visible consent frame`, async () => {
  const f = fixture(); await f.signIn("A"); await f.aiConsent.setAllowed(allowed, f.aiConsent.getState());
  if (initialJournal) { const c = new choice.InitialAIChoiceController(f.storage); await c.load(); await c.choose(allowed, "user-A"); }
  const ui = gateFixture(f);
  assert.equal(ui.modal(ui.render()).props.visible, false, "First hydration frame is not a permission request");
  await ui.settle();
  const originalRead = f.storage.secureGet;
  try {
    for (let cycle = 0; cycle < 5; cycle++) {
      let release; const paused = new Promise(resolve => release = resolve);
      f.storage.secureGet = async (key, fallback) => { if (key.startsWith("ai_consent.")) await paused; return originalRead(key, fallback); };
      const foreground = f.aiConsent.refresh();
      assert.equal(f.aiConsent.getState().status, "loading");
      for (let frame = 0; frame < 4; frame++) { assert.equal(ui.modal(ui.render()).props.visible, false); await tick(); }
      release(); await foreground; await ui.settle();
      assert.equal(f.aiConsent.getState().status, allowed ? "allowed" : "not_allowed");
    }
    assert.ok(ui.frames.every(visible => visible === false));
    assert.equal(f.writes.filter(key => key === choice.INITIAL_AI_CHOICE_KEY).length, initialJournal ? 1 : 0, "Returning to foreground does not rewrite startup history");
    if (allowed) await f.aiConsent.authorize("A"); else await assert.rejects(f.aiConsent.authorize("A"));
  } finally { f.storage.secureGet = originalRead; ui.unmount(); }
});

test("slow/failed startup-journal reads stay deny-only with neutral retry, never a false permission request", async () => {
  const f = fixture(); await f.signIn("A"); await f.aiConsent.setAllowed(true, f.aiConsent.getState());
  const originalRead = f.storage.secureGet; let rejectRead;
  const paused = new Promise((_resolve, reject) => rejectRead = reject);
  f.storage.secureGet = async (key, fallback) => key === choice.INITIAL_AI_CHOICE_KEY ? paused : originalRead(key, fallback);
  const ui = gateFixture(f);
  try {
    for (let frame = 0; frame < 4; frame++) { assert.equal(ui.modal(ui.render()).props.visible, false); await tick(); }
    await assert.rejects(f.aiConsent.authorize("A"), { code: "AI_CONSENT_REQUIRED" });
    rejectRead(new Error("fixture unavailable startup journal")); const failed = await ui.settle();
    assert.equal(ui.modal(failed).props.visible, false); assert.ok(ui.byId(failed, "startup-ai-status-unavailable"));
    await assert.rejects(f.aiConsent.authorize("A"), { code: "AI_CONSENT_REQUIRED" });
    f.storage.secureGet = originalRead;
    ui.byId(failed, "startup-ai-load-retry").props.onPress(); const recovered = await ui.settle();
    assert.equal(ui.modal(recovered).props.visible, false); assert.equal(ui.byId(recovered, "startup-ai-status-unavailable"), null);
    await f.aiConsent.authorize("A"); assert.ok(ui.frames.every(visible => visible === false));
  } finally { f.storage.secureGet = originalRead; ui.unmount(); }
});

test("failed or fallback account reads do not reinterpret a confirmed notice as never asked, and never authorize AI", async () => {
  for (const failure of ["throw", "fallback"]) {
    const f = fixture(); await f.signIn("A"); await f.aiConsent.setAllowed(true, f.aiConsent.getState());
    const ui = gateFixture(f); await ui.settle(); const read = f.storage.secureGet;
    f.storage.secureGet = async (key, fallback) => { if (key.startsWith("ai_consent.")) { if (failure === "throw") throw Error("fixture storage unavailable"); return fallback; } return read(key, fallback); };
    try {
      await f.aiConsent.refresh().catch(() => {}); await ui.settle();
      assert.notEqual(f.aiConsent.getState().status, "allowed");
      await assert.rejects(f.aiConsent.authorize("A")); assert.ok(ui.frames.every(visible => visible === false));
      f.storage.secureGet = read; await f.aiConsent.refresh(); await ui.settle(); await f.aiConsent.authorize("A");
    } finally { f.storage.secureGet = read; ui.unmount(); }
  }
});

test("cold-mount durable owner/notice acknowledgement suppresses false prompts without replaying its old allowance", async () => {
  const f = fixture(); await f.signIn("A"); await f.aiConsent.setAllowed(true, f.aiConsent.getState());
  const journal = new choice.InitialAIChoiceController(f.storage); await journal.load(); await journal.choose(true, "user-A");
  const read = f.storage.secureGet;
  f.storage.secureGet = async (key, fallback) => key.startsWith("ai_consent.") ? fallback : read(key, fallback);
  await f.aiConsent.refresh();
  assert.equal(f.aiConsent.getState().status, "not_allowed"); assert.equal(f.aiConsent.getState().choiceRecorded, false);
  // A NEW gate/controller has no prior React ref acknowledgement. Its only
  // presentation proof is the successfully persisted owner/notice journal.
  const ui = gateFixture(f); const writes = f.writes.length;
  try {
    assert.equal(ui.modal(ui.render()).props.visible, false); const tree = await ui.settle();
    assert.equal(ui.modal(tree).props.visible, false); assert.ok(ui.frames.every(visible => visible === false));
    assert.equal(f.writes.length, writes, "No migration or permission-replay writes are allowed");
    await assert.rejects(f.aiConsent.authorize("A"));
  } finally { f.storage.secureGet = read; ui.unmount(); }
});

test("account switch during slow hydration cannot reuse A's acknowledgement for never-asked B", async () => {
  const f = fixture(); await f.signIn("A"); await f.aiConsent.setAllowed(true, f.aiConsent.getState());
  const journal = new choice.InitialAIChoiceController(f.storage); await journal.load(); await journal.choose(true, "user-A");
  const read = f.storage.secureGet; let release;
  const paused = new Promise(resolve => release = resolve);
  f.storage.secureGet = async (key, fallback) => { if (key === choice.INITIAL_AI_CHOICE_KEY) await paused; return read(key, fallback); };
  const ui = gateFixture(f);
  try {
    assert.equal(ui.modal(ui.render()).props.visible, false); await f.signIn("B");
    assert.equal(ui.modal(ui.render()).props.visible, false, "B remains unknown until the startup journal is loaded");
    release(); const tree = await ui.settle();
    assert.equal(ui.modal(tree).props.visible, true); await assert.rejects(f.aiConsent.authorize("B"));
    assert.equal(f.secure.has(`ai_consent.${policy.AI_CONSENT_VERSION}.user-B`), false);
    ui.byId(tree, "startup-ai-decline").props.onPress(); await ui.settle();
    assert.equal(f.aiConsent.getState().choiceRecorded, true); await assert.rejects(f.aiConsent.authorize("B"));
  } finally { release(); f.storage.secureGet = read; ui.unmount(); }
});

test("withdrawing confirmed permission remains denied through refresh and never reapplies an old startup allowance", async () => {
  const f = fixture(); await f.signIn("A"); await f.aiConsent.setAllowed(true, f.aiConsent.getState());
  const c = new choice.InitialAIChoiceController(f.storage); await c.load(); await c.choose(true, "user-A");
  const ui = gateFixture(f); await ui.settle(); const lease = await f.aiConsent.authorize("A");
  const withdrawal = f.aiConsent.setAllowed(false, f.aiConsent.getState());
  assert.equal(ui.modal(ui.render()).props.visible, false); assert.throws(() => f.aiConsent.assertCurrent(lease));
  await withdrawal;
  for (let index = 0; index < 3; index++) { const refresh = f.aiConsent.refresh(); ui.render(); await refresh; await ui.settle(); }
  assert.ok(ui.frames.every(visible => visible === false)); assert.equal(f.aiConsent.getState().status, "not_allowed");
  await assert.rejects(f.aiConsent.authorize("A")); ui.unmount();
});

test("a new notice version ignores old account grants and startup journal until another explicit choice", async () => {
  const old = fixture(); await old.signIn("A"); await old.aiConsent.setAllowed(true, old.aiConsent.getState());
  const c = new choice.InitialAIChoiceController(old.storage); await c.load(); await c.choose(true, "user-A");
  const updatedPolicy = load("../src/aiConsent.ts", {}, source => source.replace(`AI_CONSENT_VERSION = "${policy.AI_CONSENT_VERSION}"`, 'AI_CONSENT_VERSION = "fixture-new-notice"'));
  const updatedChoice = load("../src/initialAIChoice.ts", { "./aiConsent": updatedPolicy });
  const f = fixture(updatedPolicy, updatedChoice);
  for (const [key, value] of old.secure) f.secure.set(key, value);
  for (const [key, value] of old.ordinary) f.ordinary.set(key, value);
  await f.signIn("A"); assert.equal(f.aiConsent.getState().version, "fixture-new-notice");
  const ui = gateFixture(f); assert.equal(ui.modal(ui.render()).props.visible, false);
  const tree = await ui.settle(); assert.equal(ui.modal(tree).props.visible, true);
  await assert.rejects(f.aiConsent.authorize("A"));
  ui.byId(tree, "startup-ai-decline").props.onPress(); await ui.settle();
  assert.equal(f.aiConsent.getState().choiceRecorded, true); assert.equal(f.aiConsent.getState().status, "not_allowed");
  await assert.rejects(f.aiConsent.authorize("A")); ui.unmount();
});
test("failed A consume cannot automatically retry on B after recovery", async () => {
  const f = fixture(); await f.aiConsent.refresh(); const ui = gateFixture(f); let tree = await ui.settle();
  ui.byId(tree, "startup-ai-allow").props.onPress(); await ui.settle();
  const release = f.pauseChoice(); await f.signIn("A"); ui.render(); await tick(); f.failChoice(true);
  await f.signIn("B"); release(); await tick(); f.failChoice(false); tree = await ui.settle();
  assert.notEqual(f.aiConsent.getState().status, "allowed"); await assert.rejects(f.aiConsent.authorize("B"));
  assert.equal(ui.modal(tree).props.visible, true, "B must make an explicit choice");
  assert.equal(f.secure.has(`ai_consent.${policy.AI_CONSENT_VERSION}.user-B`), false);
});
test("a delayed native link error and failed A refusal cannot replay the prior anonymous allowance onto B", async () => {
  const f = fixture(); await f.aiConsent.refresh();
  let rejectLink, releaseWrite;
  const link = new Promise((_resolve, reject) => rejectLink = reject);
  f.openURL = () => link;
  const ui = gateFixture(f);
  try {
    let tree = await ui.settle();
    // The native link operation outlives the user's anonymous Allow click.
    ui.privacyLink(tree).props.onPress();
    ui.byId(tree, "startup-ai-allow").props.onPress(); tree = await ui.settle();
    assert.equal(ui.modal(tree).props.visible, false);
    rejectLink(new Error("fixture native link failure")); await tick(); tree = await ui.settle();
    assert.equal(ui.modal(tree).props.visible, true); assert.ok(ui.byId(tree, "startup-ai-error"));
    await f.signIn("A"); tree = await ui.settle();
    releaseWrite = f.pauseChoice();
    // onPress intentionally returns immediately. Do not await the suspended
    // storage operation: switch accounts, fail it, then explicitly release it.
    ui.byId(tree, "startup-ai-decline").props.onPress(); await tick();
    await f.signIn("B"); f.failChoice(true); releaseWrite(); await tick();
    f.failChoice(false); tree = await ui.settle();
    assert.equal(f.aiConsent.getState().status, "not_allowed");
    assert.equal(ui.modal(tree).props.visible, true, "B must make its own explicit choice");
    assert.equal(f.secure.has(`ai_consent.${policy.AI_CONSENT_VERSION}.user-B`), false);
    await assert.rejects(f.aiConsent.authorize("B"));
    const writes = f.writes.length; await ui.settle(); assert.equal(f.writes.length, writes, "The failed owner-bound choice must not start an automatic replay/write loop");
  } finally { rejectLink(new Error("fixture cleanup")); releaseWrite?.(); f.failChoice(false); ui.unmount(); }
});
test("a new owner-bound or anonymous choice retires prior pending intent even when its persistence fails", async () => {
  for (const owner of ["user-A", null]) {
    const f = fixture(), c = new choice.InitialAIChoiceController(f.storage); await c.load(); await c.choose(true, null);
    f.failChoice(true); await assert.rejects(c.choose(false, owner));
    assert.equal(c.getState().phase, owner ? "consumed" : "retired");
    assert.equal(c.getState().ownerId, owner); assert.equal(c.getState().allowed, false);
    f.failChoice(false); assert.equal(await c.claimPending("user-B"), null);
    // The old durable pending row also cannot revive after process restart.
    const restored = new choice.InitialAIChoiceController(f.storage); assert.equal((await restored.load()).phase, "retired");
    assert.equal(await restored.claimPending("user-B"), null);
  }
});
test("restored pending intent requires another explicit click, never auto-grants B after a failed A consume", async () => {
  const f = fixture(), c = new choice.InitialAIChoiceController(f.storage); await c.load(); await c.choose(true, null);
  await f.signIn("A"); f.failChoice(true); await assert.rejects(c.claimPending("user-A")); f.failChoice(false);
  const restored = new choice.InitialAIChoiceController(f.storage); assert.equal((await restored.load()).phase, "retired");
  assert.equal(await restored.claimPending("user-B"), null);
  await f.signIn("B"); const ui = gateFixture(f), tree = await ui.settle();
  assert.equal(ui.modal(tree).props.visible, true); await assert.rejects(f.aiConsent.authorize("B"));
});
test("a stale A button during refresh is ignored, never converted into an anonymous B grant", async () => {
  const f = fixture(); await f.signIn("A");
  const ui = gateFixture(f); let tree = await ui.settle(); const oldAllow = ui.byId(tree, "startup-ai-allow").props.onPress;
  let releaseRead; const barrier = new Promise(resolve => releaseRead = resolve), originalGet = f.storage.secureGet;
  f.storage.secureGet = async (key, fallback) => { if (key.startsWith("ai_consent.")) await barrier; return originalGet(key, fallback); };
  const refresh = f.aiConsent.refresh(); await tick(); assert.equal(f.aiConsent.getState().status, "loading"); assert.equal(f.aiConsent.getState().userId, "user-A");
  oldAllow(); await tick(); const signInB = f.signIn("B");
  releaseRead(); await Promise.all([refresh, signInB]); tree = await ui.settle();
  assert.notEqual(f.aiConsent.getState().status, "allowed"); assert.equal(ui.modal(tree).props.visible, true);
  assert.equal(f.secure.has(choice.INITIAL_AI_CHOICE_KEY), false);
});

test("failed first owner-bound choice is not a durable acknowledgement after A→B→A", async () => {
  const f = fixture(); await f.signIn("A"); const ui = gateFixture(f); let tree = await ui.settle();
  f.failChoice(true); ui.byId(tree, "startup-ai-allow").props.onPress(); tree = await ui.settle();
  assert.ok(ui.byId(tree, "startup-ai-error")); await assert.rejects(f.aiConsent.authorize("A"));
  f.failChoice(false); await f.signIn("B"); await ui.settle(); await f.signIn("A"); tree = await ui.settle();
  assert.equal(ui.modal(tree).props.visible, true, "An in-memory consumed marker from a failed write is not a completed choice");
  assert.equal(f.secure.has(choice.INITIAL_AI_CHOICE_KEY), false); await assert.rejects(f.aiConsent.authorize("A")); ui.unmount();
});

test("queued button callbacks cannot reverse a later explicit withdrawal", async () => {
  const f = fixture(); await f.signIn("A"); const ui = gateFixture(f); const tree = await ui.settle();
  const oldAllow = ui.byId(tree, "startup-ai-allow").props.onPress;
  oldAllow(); await ui.settle(); await f.aiConsent.setAllowed(false, f.aiConsent.getState()); await ui.settle();
  const writes = f.writes.length; oldAllow(); await ui.settle();
  assert.equal(f.writes.length, writes); assert.equal(f.aiConsent.getState().status, "not_allowed");
  await assert.rejects(f.aiConsent.authorize("A")); ui.unmount();
});
test("startup hold rejects old permission leases and prevents old stored grant racing a new pre-login refusal", async () => {
  const f = fixture(); await f.signIn("A"); await f.aiConsent.setAllowed(true, f.aiConsent.getState()); const lease = await f.aiConsent.authorize("A");
  f.aiConsent.setStartupHold(true); assert.throws(() => f.aiConsent.assertCurrent(lease)); await assert.rejects(f.aiConsent.authorize("A"));
  await f.aiConsent.setAllowed(false, f.aiConsent.getState()); f.aiConsent.setStartupHold(false);
  await assert.rejects(f.aiConsent.authorize("A"));
});
test("authorization paused in identity lookup rejects when startup hold begins before it resumes", async () => {
  const f = fixture(); let pauseIdentity = false, identityPaused = false, release;
  const barrier = new Promise(resolve => release = resolve);
  const controller = new policy.AIConsentController({ storage: f.storage,
    getToken: async () => { if (pauseIdentity) { identityPaused = true; await barrier; } return "A"; },
    resolveUser: async () => "user-A",
  });
  await controller.refresh(); await controller.setAllowed(true, controller.getState());
  let allowedPublishes = 0;
  const unsubscribe = controller.subscribe(state => { if (state.status === "allowed") allowedPublishes++; });
  try {
    pauseIdentity = true;
    const pending = controller.authorize("A"); await tick();
    assert.equal(identityPaused, true, "The authorization must be paused in identify(), before capturing its read decision");
    controller.setStartupHold(true); pauseIdentity = false; release();
    await assert.rejects(pending, error => error instanceof policy.AIConsentError && error.code === "AI_CONSENT_REQUIRED");
    assert.equal(allowedPublishes, 0, "An authorization crossing the hold must not publish a new allowed state or return a lease");
    controller.setStartupHold(false); await controller.refresh();
    const lease = await controller.authorize("A"); controller.assertCurrent(lease);
  } finally { pauseIdentity = false; release(); unsubscribe(); }
});
test("root installs startup gate above a stable navigator for all three release flavors", () => {
  const root = readFileSync(new URL("../app/_layout.tsx", import.meta.url), "utf8");
  assert.match(root, /<AIConsentStartupGate><NuriShell><Stack/);
  assert.doesNotMatch(root, /AIConsentStartupGate.*(?:RELEASE_FLAVOR|key=)/);
  for (const locale of ["en", "zh-CN", "zh-TW"]) { const c = copyModule.aiConsentCopy(locale); assert.ok(c.allow.length < 25); assert.match(c.data, /OpenAI/); }
});
test("all three notices disclose Community AI matching/polishing/translation while ordinary replies, private chat and reporting stay non-AI", () => {
  for (const [locale, phrases] of [
    ["en", ["Community question matching", "your question and related family information to OpenAI", "question polishing", "voice transcription", "message translation", "Ordinary replies, private chat and reporting remain available without AI permission"]],
    ["zh-CN", ["社区问题匹配", "问题及相关家庭信息发送给 OpenAI", "问题润色", "语音转录", "消息翻译", "普通回复、私聊和举报不受 AI 许可影响"]],
    ["zh-TW", ["社區問題配對", "問題及相關家庭資訊傳送給 OpenAI", "問題潤飾", "語音轉錄", "訊息翻譯", "一般回覆、私訊和檢舉不受 AI 許可影響"]],
  ]) {
    const c = copyModule.aiConsentCopy(locale); for (const phrase of phrases) assert.ok(c.data.includes(phrase), locale + ': ' + phrase);
    assert.ok(c.allow.length < 25); assert.match(c.withdraw, /(?:blocks new|立即阻止)/);
  }
});
