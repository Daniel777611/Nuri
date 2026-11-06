import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = path => readFileSync(new URL(path, import.meta.url), "utf8");
const jsx = (type, props) => ({ type, props });
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
function compile(path, deps, globals = {}) {
  const output = ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} }, names = Object.keys(globals);
  new Function("require", "module", "exports", ...names, output)(name => {
    assert.ok(Object.hasOwn(deps, name), `Unexpected adapter dependency ${name}`);
    return deps[name];
  }, module, module.exports, ...names.map(name => globals[name]));
  return module.exports;
}
const editing = compile("../src/keyboard/editingModel.ts", {});

/** This deliberately executes actual source with a small React-hook/native-ref
 * adapter. It does not simulate Yoga, UIKit, browser IME or a real soft keyboard. */
function environment({ os = "ios", locale = "en", candidates, actualEngine = false } = {}) {
  let current = null, nextId = 0, path = "/fixture", appState = "active";
  const contexts = [], tasks = [], listeners = new Set(), candidateCalls = [];
  const document = { activeElement: { closest: () => null } };
  const react = {
    createContext(value) { const context = { current: value, Provider: "Provider" }; contexts.push(context); return context; },
    forwardRef: fn => fn,
    useContext: context => context.current,
    useId() { const i = current.cursor++; return current.slots[i] ??= `fixture-${++nextId}`; },
    useRef(value) { const i = current.cursor++; return current.slots[i] ??= { current: value }; },
    useState(initial) {
      const runner = current, i = runner.cursor++;
      if (!(i in runner.slots)) runner.slots[i] = typeof initial === "function" ? initial() : initial;
      runner.setters[i] ??= next => { if (!runner.mounted) { runner.lateWrites++; return; } const value = typeof next === "function" ? next(runner.slots[i]) : next; if (!Object.is(value, runner.slots[i])) { runner.slots[i] = value; runner.dirty = true; } };
      return [runner.slots[i], runner.setters[i]];
    },
    useMemo(fn, deps) { const i = current.cursor++; if (!same(current.slots[i]?.deps, deps)) current.slots[i] = { value: fn(), deps }; return current.slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useLayoutEffect(fn, deps) { effect("layout", fn, deps); },
    useEffect(fn, deps) { effect("passive", fn, deps); },
    useSyncExternalStore(subscribe, getSnapshot) {
      const runner = current, i = runner.cursor++;
      if (runner.slots[i]?.subscribe !== subscribe) { runner.slots[i]?.cleanup?.(); runner.slots[i] = { subscribe, cleanup: subscribe(() => { runner.dirty = true; }) }; }
      return getSnapshot();
    },
  };
  function effect(phase, fn, deps) { const runner = current, i = runner.cursor++; if (!same(runner.effects[i]?.deps, deps)) runner.pending[phase].push(() => { runner.effects[i]?.cleanup?.(); runner.effects[i] = { deps, fn, cleanup: fn(), phase }; }); }
  const dictionary = { getPinyinCandidates(raw, script) { candidateCalls.push([raw, script]); return candidates?.(raw, script) ?? (raw === "nihao" ? [script === "zh-TW" ? "你好" : "你好", "你号"] : []); } };
  if (actualEngine) {
    const engine = compile("../src/keyboard/pinyinEngine.ts", {
      "./vendor/simple-ime/google-pinyin-dict.json": require("../src/keyboard/vendor/simple-ime/google-pinyin-dict.json"),
      "./vendor/opencc-js/cn2t.js": require("../src/keyboard/vendor/opencc-js/cn2t.js"),
    });
    dictionary.getPinyinCandidates = engine.getPinyinCandidates;
  }
  const api = compile("../src/keyboard/AppKeyboard.tsx", {
    react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Platform: { OS: os }, TextInput: "NativeTextInput", View: "View", AppState: { get currentState() { return appState; }, addEventListener(event, fn) { assert.equal(event, "change"); listeners.add(fn); return { remove() { listeners.delete(fn); } }; } } },
    "expo-router": { usePathname: () => path },
    "@/src/i18n": { useT: () => ({ locale }), translate: (_locale, text) => text },
    "./KeyboardPanel": { KeyboardPanel: "KeyboardPanel" }, "./pinyinEngine": dictionary, "./editingModel": editing,
  }, { queueMicrotask: task => tasks.push(task), document });
  const controller = new api.AppKeyboardController(); contexts[0].current = controller;
  function runner(fn, commit = () => {}) {
    const r = { slots: [], setters: [], effects: [], cursor: 0, dirty: false, mounted: true, lateWrites: 0, pending: { layout: [], passive: [] }, tree: null };
    return Object.assign(r, {
      render() {
        assert.equal(r.mounted, true); let rounds = 0;
        do { assert.ok(++rounds < 30, "Adapter render loop"); r.dirty = false; r.cursor = 0; r.pending = { layout: [], passive: [] }; current = r; r.tree = fn(); current = null; commit(r.tree); for (const phase of ["layout", "passive"]) r.pending[phase].forEach(fn => fn()); } while (r.dirty);
        return r.tree;
      },
      strictReplay() { r.effects.forEach(effect => effect?.cleanup?.()); r.effects.forEach(effect => { if (effect) effect.cleanup = effect.fn(); }); },
      unmount() { if (!r.mounted) return; r.effects.forEach(effect => effect?.cleanup?.()); r.slots.forEach(slot => slot?.cleanup?.()); r.mounted = false; },
    });
  }
  const actionRunner = runner(() => api.useAppKeyboard());
  function input(initial = {}, { scope = { id: "root", active: true }, forwarded = { current: null }, controlled = true } = {}) {
    const changes = [], calls = [], props = { ...(controlled ? { value: "" } : {}), onChangeText: value => { changes.push(value); if (controlled) props.value = value; }, ...initial };
    let attachedRef;
    const handle = { focus() { calls.push("focus"); }, blur() { calls.push("blur"); }, measure() {}, clear() {}, isFocused: () => true };
    const r = runner(() => { contexts[1].current = scope; return api.NuriTextInput(props, forwarded); }, tree => { assert.equal(tree.type, "NativeTextInput"); if (tree.props.ref !== attachedRef) { attachedRef?.(null); attachedRef = tree.props.ref; attachedRef(handle); } });
    return Object.assign(r, { props, changes, calls, handle, forwarded, scope,
      focus() { r.render().props.onFocus({ nativeEvent: {} }); r.render(); },
      select(start, end = start) { r.render().props.onSelectionChange({ nativeEvent: { selection: { start, end } } }); r.render(); },
      external(value) { props.value = value; r.render(); },
      unmount() { if (!r.mounted) return; r.effects.forEach(effect => effect?.cleanup?.()); r.slots.forEach(slot => slot?.cleanup?.()); r.mounted = false; attachedRef?.(null); },
    });
  }
  return { api, controller, input, runner, candidateCalls, document, contexts, actions: () => actionRunner.render(),
    flush() { let count = 0; while (tasks.length) { assert.ok(++count < 100); tasks.shift()(); } },
    path(value) { path = value; }, appState(value) { appState = value; [...listeners].forEach(fn => fn(value)); }, get listeners() { return listeners.size; },
  };
}

function binding(controller, patch = {}) {
  const field = { value: "", selection: { start: 0, end: 0 }, hostId: "root", active: true, editable: true, secure: false, layout: "text", locale: "en", multiline: false, returnKeyLabel: "Done", ...patch };
  const calls = [];
  const item = { id: patch.id ?? "field", read: () => field, apply(edit) { calls.push(["apply", edit.value]); field.value = edit.value; field.selection = edit.selection; return true; }, blur: () => calls.push(["blur"]), system: enabled => calls.push(["system", enabled]), done: () => calls.push(["done"]), submit: patch.submit, dictate: patch.dictate, sticker: patch.sticker };
  const unregister = controller.register(item); return { field, calls, item, unregister, focus: () => controller.focus(item.id) };
}

for (const text of ["👨‍👩‍👧‍👦", "👩🏽‍💻", "🇺🇸", "e\u0301", "1️⃣", "🏳️‍🌈", "\r\n", "a\u0301\u0327"]) test(`grapheme deletion preserves boundaries: ${JSON.stringify(text)}`, () => {
  const value = `A${text}B`, result = editing.deleteKeyboardSelection(value, { start: 1 + text.length, end: 1 + text.length });
  assert.equal(result.value, "AB"); assert.deepEqual(result.selection, { start: 1, end: 1 });
});
test("fallback without Intl.Segmenter still deletes emoji families, flags and combining clusters", () => {
  const fallback = compile("../src/keyboard/editingModel.ts", {}, { Intl: {} });
  for (const text of ["👨‍👩‍👧‍👦", "👩🏽‍💻", "🇺🇸", "e\u0301", "1️⃣", "🏳️‍🌈"]) assert.equal(fallback.deleteKeyboardSelection(`A${text}`, { start: 1 + text.length, end: 1 + text.length }).value, "A");
});
test("selection clamps invalid/reversed UTF16 ranges and cannot split a grapheme", () => {
  assert.deepEqual(editing.keyboardSelection("abc", { start: Infinity, end: -9 }), { start: 0, end: 3 });
  assert.deepEqual(editing.keyboardSelection("A👩🏽‍💻B", { start: 2, end: 2 }), { start: 1, end: 1 });
  assert.equal(editing.replaceKeyboardSelection("abcd", { start: 3, end: 1 }, "X").value, "aXd");
});
test("maxLength trims only at whole graphemes and does not truncate existing unselected data", () => {
  assert.equal(editing.replaceKeyboardSelection("a", { start: 1, end: 1 }, "👩🏽‍💻", 3).value, "a");
  assert.equal(editing.replaceKeyboardSelection("abcdef", { start: 6, end: 6 }, "x", 3).value, "abcdef");
  assert.equal(editing.replaceKeyboardSelection("abc", { start: 1, end: 2 }, "XYZ", 4).value, "aXYc");
});
test("real wrapper rapid taps in one batch use optimistic text and caret, not stale props", () => {
  const e = environment(), f = e.input(); f.focus(); const actions = e.actions();
  for (const letter of "abcdef") actions.onText(letter);
  assert.deepEqual(f.changes, ["a", "ab", "abc", "abcd", "abcde", "abcdef"]);
  assert.equal(f.render().props.value, "abcdef"); assert.deepEqual(f.render().props.selection, { start: 6, end: 6 }); f.unmount();
});
test("real wrapper keeps the original native ref and component identity across typing, selection and external clear", () => {
  const e = environment(), forwarded = { current: null }, f = e.input({ value: "abcdef" }, { forwarded }); f.focus();
  const before = f.render(), ref = before.props.ref; assert.equal(forwarded.current, f.handle);
  f.select(2, 4); e.actions().onText("X"); assert.equal(f.render().props.value, "abXef");
  assert.equal(f.render().props.ref, ref); assert.equal(f.render().type, before.type); assert.equal(f.render().props.key, undefined);
  f.external(""); e.actions().onText("z"); assert.equal(f.render().props.value, "z"); assert.equal(f.forwarded.current, f.handle); f.unmount(); assert.equal(forwarded.current, null);
});
test("a controlled parent rejection cannot leave phantom text for the next virtual edit", () => {
  const e = environment(); let reject = true;
  const f = e.input({ value: "KEEP", onChangeText: value => { if (reject) reject = false; else f.props.value = value; } });
  f.focus(); e.actions().onText("x"); assert.equal(f.render().props.value, "KEEP");
  e.actions().onBackspace(); assert.equal(f.render().props.value, "KEE", "Delete must use displayed controlled text, not rejected KEEPx"); f.unmount();
});
test("hardware input rejected by a controlled parent also rebases before virtual backspace", () => {
  const e = environment(); let reject = true;
  const f = e.input({ value: "KEEP", onChangeText: value => { if (reject) reject = false; else f.props.value = value; } });
  f.focus(); f.render().props.onChangeText("KEEPx"); assert.equal(f.render().props.value, "KEEP"); e.actions().onBackspace(); assert.equal(f.render().props.value, "KEE"); f.unmount();
});
test("controlled parent normalization is acknowledged before subsequent virtual edits", () => {
  const e = environment(), f = e.input({ onChangeText: value => { f.props.value = value.toUpperCase(); } }); f.focus(); e.actions().onText("a"); assert.equal(f.render().props.value, "A"); e.actions().onText("b"); assert.equal(f.render().props.value, "AB"); assert.deepEqual(f.render().props.selection, { start: 2, end: 2 }); f.unmount();
});
test("native selection callbacks and controlled selection props both direct virtual replacement", () => {
  const e = environment(), events = [], f = e.input({ value: "12345", onSelectionChange: event => events.push(event) }); f.focus();
  f.select(1, 4); e.actions().onText("XY"); assert.equal(f.render().props.value, "1XY5"); assert.equal(events.length, 1);
  f.props.selection = { start: 0, end: 1 }; f.render(); e.actions().onText("A"); assert.equal(f.render().props.value, "AXY5"); f.unmount();
});
test("hardware/autofill onChangeText passes through exact contents and cancels virtual composition", () => {
  const e = environment({ locale: "zh-CN" }), f = e.input(); f.focus(); e.actions().onText("nihao"); f.render(); assert.equal(e.actions().preedit, "nihao");
  const callback = f.render().props.onChangeText; callback("hardware 甲\n乙"); f.render(); assert.equal(f.props.value, "hardware 甲\n乙"); assert.equal(e.actions().preedit, ""); assert.deepEqual(e.actions().candidates, []); f.unmount();
});
test("external clearing invalidates every old panel action, including held backspace and candidate", () => {
  const e = environment({ locale: "zh-CN" }), f = e.input({ onAppKeyboardDone() { assert.fail("stale done"); }, onAppKeyboardSubmit() { assert.fail("stale submit"); }, onAppKeyboardDictation() { assert.fail("stale dictate"); }, onAppKeyboardSticker() { assert.fail("stale sticker"); } });
  f.focus(); e.actions().onText("nihao"); f.render(); const old = e.actions(); f.external("");
  old.onText("BAD"); old.onBackspace(); old.onSpace(); old.onEnter(); old.onDone(); old.onModeChange("emoji"); old.onShift(); old.onCandidate("你好"); old.onDictation(); old.onSticker(1); old.onUseSystemKeyboard();
  assert.equal(f.props.value, ""); assert.equal(e.actions().visible, true); assert.equal(e.actions().shift, false); assert.equal(f.render().props.showSoftInputOnFocus, false); f.unmount();
});
test("all leased panel actions from a previous field are inert after focus changes", () => {
  const e = environment({ locale: "zh-CN" }), a = e.input({ onAppKeyboardDictation() { assert.fail("stale dictate"); }, onAppKeyboardSticker() { assert.fail("stale sticker"); } }), b = e.input({ value: "keep" }); a.focus(); e.actions().onText("nihao"); a.render(); const old = e.actions(); b.focus();
  old.onText("BAD"); old.onBackspace(); old.onSpace(); old.onEnter(); old.onDone(); old.onModeChange("emoji"); old.onShift(); old.onCandidate("你好"); old.onDictation(); old.onSticker(5); old.onUseSystemKeyboard();
  assert.equal(b.props.value, "keep"); assert.equal(e.actions().visible, true); assert.equal(e.actions().shift, false); assert.equal(b.render().props.showSoftInputOnFocus, false); a.unmount(); b.unmount();
});
test("Done, language/emoji/symbol changes and unmount preserve raw pinyin without fabricated conversion", () => {
  for (const transition of ["done", "en", "emoji", "symbols", "unmount"]) {
    const e = environment({ locale: "zh-CN" }), f = e.input(); f.focus(); for (const letter of "unknown") e.actions().onText(letter); f.render();
    if (transition === "done") e.actions().onDone(); else if (transition === "unmount") f.unmount(); else e.actions().onModeChange(transition);
    assert.equal(f.props.value, "unknown", transition); if (transition !== "unmount") f.unmount();
  }
});
test("new field focus remembers the last text language, never the intervening symbol or emoji page", () => {
  for (const language of ["en", "zh-CN", "zh-TW"]) for (const panel of ["symbols", "emoji"]) {
    const e = environment({ locale: language === "en" ? "zh-CN" : "en" }), first = e.input();
    first.focus(); e.actions().onModeChange(language); e.actions().onModeChange(panel);
    assert.equal(e.actions().mode, panel);
    e.actions().onDone(); assert.equal(e.actions().visible, false);
    const next = e.input(); next.focus();
    assert.equal(e.actions().mode, language, `${language} → ${panel} → Done → next field`);
    first.unmount(); next.unmount();
  }
});
test("whole-range pinyin candidate replaces selected raw only; stale/non-candidate strings are rejected", () => {
  const e = environment({ locale: "zh-CN" }), f = e.input({ value: "前后" }); f.focus(); f.select(1); e.actions().onText("nihao"); f.render(); assert.equal(f.props.value, "前nihao后");
  e.actions().onCandidate("伪造"); assert.equal(f.props.value, "前nihao后"); e.actions().onCandidate("你好"); assert.equal(f.render().props.value, "前你好后"); assert.deepEqual(e.actions().candidates, []); f.unmount();
});
test("Space/Enter commit a whole candidate first, without inserting a space or submitting", () => {
  for (const action of ["onSpace", "onEnter"]) { const e = environment({ locale: "zh-CN" }), f = e.input({ onAppKeyboardSubmit() { assert.fail("candidate must not submit"); } }); f.focus(); e.actions().onText("nihao"); f.render(); e.actions()[action](); assert.equal(f.render().props.value, "你好"); f.unmount(); }
});
test("candidate cannot partially truncate at maxLength or replace a moved caret's unrelated text", () => {
  const e = environment({ locale: "zh-CN", candidates: raw => raw === "ni" ? ["你好啊"] : [] }), f = e.input({ maxLength: 2 }); f.focus(); e.actions().onText("ni"); f.render(); e.actions().onCandidate("你好啊"); assert.equal(f.props.value, "ni");
  f.select(0); assert.deepEqual(e.actions().candidates, []); e.actions().onCandidate("你好啊"); assert.equal(f.props.value, "ni"); f.unmount();
});
test("actual local dictionary integrates once with the controller instead of only stub candidates", () => {
  const e = environment({ locale: "zh-CN", actualEngine: true }), f = binding(e.controller, { locale: "zh-CN" }); f.focus(); e.controller.text("nihao"); assert.ok(e.controller.getSnapshot().candidates.includes("你好")); e.controller.candidate("你好"); assert.equal(f.field.value, "你好"); f.unregister();
});
test("secure fields retain secure/autofill props, do not call pinyin, and deny suggestions/dictation/stickers", () => {
  const e = environment({ locale: "zh-CN" }), f = e.input({ secureTextEntry: true, textContentType: "password", autoComplete: "current-password", maxLength: 8, onAppKeyboardDictation() { assert.fail("secure dictate"); }, onAppKeyboardSticker() { assert.fail("secure sticker"); } }); f.focus();
  e.actions().onModeChange("zh-CN"); e.actions().onModeChange("emoji"); e.actions().onText("abc123!@"); e.actions().onText("TOO LONG"); const tree = f.render();
  assert.equal(tree.props.value, "abc123!@"); assert.equal(tree.props.secureTextEntry, true); assert.equal(tree.props.textContentType, "password"); assert.equal(tree.props.autoComplete, "current-password"); assert.equal(e.actions().layout, "password"); assert.equal(e.actions().mode, "en"); assert.equal(e.actions().onDictation, undefined); assert.equal(e.actions().onSticker, undefined); assert.deepEqual(e.candidateCalls, []); assert.deepEqual(e.actions().candidates, []); f.unmount();
});
test("OTP/numeric layout preserves oneTimeCode metadata and rejects invalid input without deleting selection", () => {
  const e = environment(), f = e.input({ value: "123456", keyboardType: "number-pad", textContentType: "oneTimeCode", autoComplete: "one-time-code", maxLength: 6 }); f.focus(); f.select(1, 4); e.actions().onText("letters👋"); assert.equal(f.props.value, "123456");
  e.actions().onText("9x8"); const tree = f.render(); assert.equal(tree.props.value, "19856"); assert.equal(tree.props.textContentType, "oneTimeCode"); assert.equal(tree.props.autoComplete, "one-time-code"); assert.equal(tree.props.keyboardType, "number-pad"); assert.equal(e.actions().layout, "numeric"); f.unmount();
});
test("decimal and phone layouts filter unsupported keys without changing input/controller identity", () => {
  for (const [keyboardType, text, result] of [["decimal-pad", "-12.3a", "-12.3"], ["phone-pad", "+1(23)*#x", "+1(23)*#"]]) { const e = environment(), f = e.input({ keyboardType }); f.focus(); e.actions().onText(text); assert.equal(f.render().props.value, result); f.unmount(); }
});
test("email and URL retain Latin layouts even when application locale is Chinese", () => {
  for (const [keyboardType, layout] of [["email-address", "email"], ["url", "url"]]) { const e = environment({ locale: "zh-TW" }), f = e.input({ keyboardType }); f.focus(); e.actions().onModeChange("zh-CN"); e.actions().onModeChange("emoji"); assert.equal(e.actions().mode, "en"); assert.equal(e.actions().layout, layout); e.actions().onText("a@b.example/path"); assert.equal(f.render().props.value, "a@b.example/path"); assert.deepEqual(e.candidateCalls, []); f.unmount(); }
});
test("explicit submit is separate from Done/dictation; multiline Enter only inserts a newline", () => {
  const e = environment(), calls = [], f = e.input({ onAppKeyboardSubmit: () => calls.push("submit"), onAppKeyboardDone: () => calls.push(["done", e.actions().visible]), onAppKeyboardDictation: () => calls.push(["dictate", e.actions().visible]) }); f.focus(); e.actions().onText("exact"); f.render(); e.actions().onEnter(); assert.deepEqual(calls, ["submit"]); e.actions().onDone(); assert.deepEqual(calls.at(-1), ["done", false]); assert.equal(f.props.value, "exact");
  f.focus(); e.actions().onDictation(); assert.deepEqual(calls.at(-1), ["dictate", false]); f.unmount();
  const g = e.input({ multiline: true, onAppKeyboardSubmit() { assert.fail("newline is not submit"); } }); g.focus(); e.actions().onEnter(); assert.equal(g.render().props.value, "\n"); g.unmount();
});
test("custom submit does not forge native onSubmitEditing; hardware event callback is preserved", () => {
  const e = environment(), native = [], f = e.input({ onSubmitEditing: event => native.push(event) }); f.focus(); e.actions().onEnter(); assert.deepEqual(native, []); const event = { nativeEvent: { text: "native" } }; f.render().props.onSubmitEditing(event); assert.equal(native[0], event); f.unmount();
});
test("system fallback is explicit, restores platform props and cannot leave a custom accessory over native keys", () => {
  for (const os of ["ios", "web"]) { const e = environment({ os }), f = e.input({ keyboardType: "email-address", inputMode: "email", inputAccessoryViewID: "original-accessory" }); f.focus(); const before = f.render(); assert.equal(before.props.showSoftInputOnFocus, false); assert.equal(before.props.inputAccessoryViewID, undefined); if (os === "web") assert.equal(before.props.inputMode, "none");
    e.actions().onUseSystemKeyboard(); const after = f.render(); assert.equal(e.actions().visible, false); assert.notEqual(after.props.showSoftInputOnFocus, false); assert.equal(after.props.inputMode, "email"); assert.equal(after.props.inputAccessoryViewID, "original-accessory"); assert.equal(after.props.ref, before.props.ref); assert.equal(e.actions().layout, "email"); f.unmount(); }
});
test("unmanaged opt-out retains original keyboard and accessory props without activating the provider", () => {
  const e = environment(), f = e.input({ appKeyboard: false, showSoftInputOnFocus: true, inputAccessoryViewID: "native", inputMode: "email" }); f.focus(); const tree = f.render(); assert.equal(tree.props.showSoftInputOnFocus, true); assert.equal(tree.props.inputAccessoryViewID, "native"); assert.equal(tree.props.inputMode, "email"); assert.equal(e.actions().visible, false); f.unmount();
});
test("inactive/offscreen, disabled and readOnly inputs cannot activate either keyboard or receive virtual edits", () => {
  for (const props of [{ keyboardActive: false }, { editable: false }, { readOnly: true }]) { const e = environment(), f = e.input(props); f.focus(); assert.equal(e.actions().visible, false); assert.equal(f.render().props.showSoftInputOnFocus, false); e.controller.text("BAD"); assert.equal(f.props.value, ""); f.unmount(); }
});
test("scope deactivation and unmount close only the matching modal field, preserving raw text", () => {
  const e = environment({ locale: "zh-CN" }), scope = { id: "expanded", active: true }, f = e.input({}, { scope });
  const scopeRunner = e.runner(() => e.api.AppKeyboardScope({ id: scope.id, active: scope.active, children: null })); scopeRunner.render(); f.focus(); e.actions().onText("nihao"); f.render(); assert.equal(e.actions().activeHostId, "expanded");
  scope.active = false; scopeRunner.render(); assert.equal(e.actions().visible, false); assert.equal(f.props.value, "nihao"); scope.active = true; scopeRunner.render(); f.focus(); scopeRunner.unmount(); assert.equal(e.actions().visible, false); f.unmount();
});
test("only the active host renders a normal flex footer; stale height callbacks are inert", () => {
  const e = environment(), f = e.input({}, { scope: { id: "modal", active: true } }); f.focus();
  const root = e.runner(() => e.api.AppKeyboardHost({})), modal = e.runner(() => e.api.AppKeyboardHost({ scopeId: "modal" })); assert.equal(root.render(), null);
  const tree = modal.render(); assert.equal(tree.type, "View"); assert.deepEqual(tree.props.style, { flexShrink: 0, width: "100%" }); const oldHeight = tree.props.children.props.onHeightChange; oldHeight(333); assert.equal(e.actions().height, 333); e.actions().onDone(); oldHeight(999); assert.equal(e.actions().height, 0); f.unmount(); root.unmount(); modal.unmount();
});
test("web host prevents pointer focus loss; blur to keyboard AX controls is retained but body blur dismisses", () => {
  const e = environment({ os: "web" }), f = e.input(); f.focus(); const host = e.runner(() => e.api.AppKeyboardHost({})), tree = host.render(); let prevented = 0; tree.props.onPointerDownCapture({ preventDefault: () => prevented++ }); assert.equal(prevented, 1); assert.equal(tree.type, "div");
  e.document.activeElement = { closest: () => ({}) }; f.render().props.onBlur({}); e.flush(); assert.equal(e.actions().visible, true);
  e.document.activeElement = { closest: () => null }; f.render().props.onBlur({}); e.flush(); assert.equal(e.actions().visible, false); f.unmount(); host.unmount();
});
test("queued web blur cannot close a later refocus or write after unmount", () => {
  const e = environment({ os: "web" }), f = e.input(); f.focus(); f.render().props.onBlur({}); f.focus(); e.flush(); assert.equal(e.actions().visible, true); f.render().props.onBlur({}); f.unmount(); e.flush(); assert.equal(f.lateWrites, 0); assert.equal(e.actions().visible, false);
});
test("provider route, account-owner and background transitions invalidate leases without altering drafts", () => {
  for (const transition of ["path", "owner", "inactive", "background"]) { const e = environment({ locale: "zh-CN" }), props = { ownerKey: 1, children: null }, provider = e.runner(() => e.api.AppKeyboardProvider(props)); const tree = provider.render(); e.contexts[0].current = tree.props.value; const f = e.input(); f.focus(); e.actions().onText("nihao"); f.render(); const old = e.actions();
    if (transition === "path") e.path("/another"); else if (transition === "owner") props.ownerKey = 2; else e.appState(transition); provider.render(); assert.equal(e.actions().visible, false); old.onText("BAD"); assert.equal(f.props.value, "nihao"); f.unmount(); provider.unmount(); assert.equal(e.listeners, 0); }
});
test("StrictMode effect replay leaves registration active once and cleans subscriptions", () => {
  const e = environment(), provider = e.runner(() => e.api.AppKeyboardProvider({ children: null })); e.contexts[0].current = provider.render().props.value; provider.strictReplay(); assert.equal(e.listeners, 1); const f = e.input(); f.render(); f.strictReplay(); f.focus(); e.actions().onText("ok"); assert.equal(f.render().props.value, "ok"); f.unmount(); provider.unmount(); assert.equal(e.listeners, 0); assert.equal(e.actions().visible, false);
});
test("uncontrolled fields still retain exact draft and callback-ref instance", () => {
  const e = environment(), refs = [], f = e.input({ defaultValue: "seed" }, { controlled: false, forwarded: node => refs.push(node) }); f.focus(); e.actions().onText("!"); assert.equal(f.render().props.value, "seed!"); assert.equal(refs[0], f.handle); assert.equal(refs.length, 1); f.unmount(); assert.equal(refs.at(-1), null);
});
test("controller subscribes, ignores invalid modes/sticker IDs and unregisters without a stale destination", () => {
  const e = environment(), f = binding(e.controller, { sticker() { assert.fail("invalid sticker"); } }); let events = 0; const unsubscribe = e.controller.subscribe(() => events++); f.focus(); e.controller.mode("invalid"); e.controller.sticker(99); assert.equal(e.controller.getSnapshot().mode, "en"); const seen = events; unsubscribe(); f.unregister(); e.controller.text("BAD"); assert.equal(events, seen); assert.equal(f.field.value, "");
});
test("adapter does not import transport/storage/audio or replace TextInput with fake drawn text", () => {
  const text = source("../src/keyboard/AppKeyboard.tsx"); assert.doesNotMatch(text, /\bfetch\s*\(|localStorage|AsyncStorage|from\s+["'][^"']*(?:\/api|expo-audio|chatVoiceInput)/); assert.match(text, /return <TextInput\s/); assert.match(text, /forwardRef<TextInput, NuriTextInputProps>/); assert.doesNotMatch(text, /Keyboard\.\w+\s*=/);
});
