import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Run the real public router, native adapter and accessory. Only React hooks,
// host views and unrelated platform services are replaced. Injected native
// events establish ownership/pass-through contracts, not device IME accuracy,
// keyboard pixels, actual candidate selection, dictation or marked-text UX.
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const jsx = (type, props, key) => ({ type, props, key });
const Fragment = Symbol("Fragment");
const same = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
function compile(path, deps) {
  const output = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)(name => {
    assert.ok(Object.hasOwn(deps, name), `Unexpected service dependency in ${path}: ${name}`);
    return deps[name];
  }, module, module.exports);
  return module.exports;
}

function fixture(initial = {}, { publicRouter = false } = {}) {
  let current, tree, attachedRef, nextID = 0;
  const contexts = [], owners = new Map(), nativeCalls = [], refs = [], renderTypes = [];
  const getOwner = key => {
    if (!owners.has(key)) owners.set(key, { cursor: 0, slots: [], effects: [], pending: [] });
    return owners.get(key);
  };
  const effect = (fn, deps) => {
    const owner = current, index = owner.cursor++;
    if (!same(owner.effects[index]?.deps, deps)) owner.pending.push(() => {
      owner.effects[index]?.cleanup?.();
      owner.effects[index] = { fn, deps, cleanup: fn() };
    });
  };
  const react = {
    forwardRef: fn => fn,
    createContext(value) { const context = { current: value, Provider: Symbol("Provider") }; contexts.push(context); return context; },
    useContext: context => context.current,
    useRef(initial) { const index = current.cursor++; return current.slots[index] ??= { current: initial }; },
    useId() { const index = current.cursor++; return current.slots[index] ??= `native-ownership-${++nextID}`; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useMemo(fn, deps) { const index = current.cursor++; if (!same(current.slots[index]?.deps, deps)) current.slots[index] = { deps, value: fn() }; return current.slots[index].value; },
    useEffect: effect, useLayoutEffect: effect,
    useState() { assert.fail("The native route must not add a JS text/caret or keyboard-mode state"); },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const impossible = () => assert.fail("The native route must not enter the custom editing, candidates or inputView policy");
  const native = {
    Platform: { OS: "ios" }, TextInput: "NativeTextInput", View: "View", Text: "Text", Pressable: "Pressable", InputAccessoryView: "InputAccessoryView",
    StyleSheet: { create: value => value, hairlineWidth: .5 }, useWindowDimensions: () => ({ width: 402, height: 874, fontScale: 1 }),
    AppState: { currentState: "active", addEventListener: impossible }, Keyboard: { dismiss: impossible },
  };
  const common = { react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment }, "react-native": native, "@/src/i18n": { useT: () => ({ locale: "en" }), translate: (_locale, text) => text } };
  const accessory = compile("../src/keyboard/NativeKeyboardAccessory.tsx", { ...common, "./KeyboardPanel": { KeyboardBackdrop: "ApprovedWarmKeyboardBackdrop" } });
  const nativeAPI = compile("../src/keyboard/NativeNuriTextInput.tsx", { ...common, "./NativeKeyboardAccessory": accessory });
  const appAPI = publicRouter ? compile("../src/keyboard/AppKeyboard.tsx", {
    ...common, "./NativeNuriTextInput": nativeAPI,
    "expo-router": { usePathname: impossible }, "@/src/sessionBoundary": { subscribeSessionBoundary: impossible },
    "./KeyboardPanel": { KeyboardPanel: impossible },
    "./pinyinEngine": { getPinyinCandidates: impossible },
    "./editingModel": { keyboardSelection: impossible, deleteKeyboardSelection: impossible, moveKeyboardSelection: impossible, replaceKeyboardSelection: impossible },
    "./nativeInputPolicy": { applyNativeInputPolicy: impossible },
  }) : null;
  const props = { scopeActive: true, ...initial }, handle = {
    focus() { nativeCalls.push("focus"); }, blur() { nativeCalls.push("blur"); },
    isFocused: () => true, clear: impossible, setNativeProps: impossible,
  };
  const forwarded = node => refs.push(node);
  let mounted = true;
  function invoke(component, inputProps, ref, key) {
    const previous = current, owner = getOwner(key);
    owner.cursor = 0; owner.pending = []; current = owner;
    renderTypes.push(component);
    const output = component(inputProps, ref);
    current = previous;
    return expand(output, key);
  }
  function expand(node, key) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item, index) => expand(item, `${key}:${index}`));
    if (typeof node.type === "function") return invoke(node.type, node.props, node.props.ref, `${key}:${node.type.name}`);
    return { ...node, props: { ...node.props, children: expand(node.props?.children, `${key}:children`) } };
  }
  const f = {
    props, handle, refs, nativeCalls, renderTypes,
    render(patch) {
      assert.ok(mounted, "Cannot render an unmounted native adapter"); Object.assign(props, patch);
      tree = invoke(appAPI?.NuriTextInput ?? nativeAPI.NativeNuriTextInput, { ...props }, forwarded, "root");
      assert.ok(f.input, "The real public route must reach a native TextInput host");
      if (attachedRef !== f.input.props.ref) {
        attachedRef?.(null); attachedRef = f.input.props.ref; attachedRef(handle);
      }
      for (const owner of owners.values()) owner.pending.forEach(fn => fn());
      return tree;
    },
    get input() { return walk(tree).find(node => node.type === "NativeTextInput"); },
    get done() { return walk(tree).find(node => node.type === "Pressable" && /-keyboard-done$/.test(node.props?.testID ?? "")); },
    scope(active) {
      assert.ok(appAPI, "Scope changes require the public router fixture");
      const context = contexts.find(item => item.current?.id === "root"); assert.ok(context);
      context.current = { id: "root", active }; f.render();
    },
    focus(event = { nativeEvent: { target: 11 } }) { f.input.props.onFocus(event); },
    end(event = { nativeEvent: { text: "draft", target: 11 } }) { f.input.props.onEndEditing(event); },
    strictReplay() {
      for (const owner of owners.values()) owner.effects.forEach(item => item?.cleanup?.());
      for (const owner of owners.values()) owner.effects.forEach(item => { if (item) item.cleanup = item.fn(); });
    },
    unmount() {
      if (!mounted) return;
      for (const owner of owners.values()) owner.effects.forEach(item => item?.cleanup?.());
      mounted = false; attachedRef?.(null);
    },
  };
  f.render(); return f;
}

for (const [label, values] of [
  ["Pinyin and arbitrary Latin prefixes beyond the third letter", ["n", "ni", "nih", "niha", "nihao", "你好", "q", "qx", "qxz", "qxzp", "qxzpq"]],
  ["French accents", ["b", "bo", "bon", "bonj", "bonjour", "été", "français", "œuvre"]],
  ["numbers and punctuation", ["1", "12", "123", "123.45/#"]],
  ["Zhuyin", ["ㄓ", "ㄓㄨ", "ㄓㄨㄥ", "ㄓㄨㄥˋ", "種"]],
  ["Hebrew", ["ש", "של", "שלום", "שלום 123"]],
  ["Japanese", ["に", "にほ", "にほん", "日本", "日本語"]],
  ["Korean", ["ㅎ", "하", "한", "한ㄱ", "한국", "한국어"]],
  ["mixed Unicode and selection", ["👨‍👩‍👧‍👦", "e\u0301", "前👨‍👩‍👧‍👦後", "مرحبا 123"]],
]) test(`actual iOS public route forwards ${label} raw without custom conversion`, () => {
  const calls = [], f = fixture({ defaultValue: "", onChange: event => calls.push(["change", event]), onChangeText: text => calls.push(["text", text]), onSelectionChange: event => calls.push(["selection", event]) }, { publicRouter: true });
  const ref = f.input.props.ref, nativeID = f.input.props.nativeID;
  f.focus();
  values.forEach((text, index) => {
    const event = { nativeEvent: { text, eventCount: index + 1, target: 11, markedText: { start: 0, end: text.length } } };
    const selection = { nativeEvent: { text, selection: { start: 0, end: text.length }, target: 11 } };
    f.input.props.onChange(event); f.input.props.onChangeText(text); f.input.props.onSelectionChange(selection); f.render();
    assert.deepEqual(calls.slice(-3), [["change", event], ["text", text], ["selection", selection]]);
    assert.equal(calls.at(-3)[1], event); assert.equal(calls.at(-1)[1], selection);
    assert.equal(f.input.props.ref, ref); assert.equal(f.input.props.nativeID, nativeID);
    assert.equal(f.input.props.value, undefined); assert.equal(f.input.props.selection, undefined);
    assert.notEqual(f.input.props.inputMode, "none"); assert.notEqual(f.input.props.showSoftInputOnFocus, false);
  });
  assert.equal(calls.length, values.length * 3);
  assert.equal(f.renderTypes.filter(component => component.name === "NativeNuriTextInput").length, values.length + 1);
  assert.deepEqual(f.refs, [f.handle]); f.unmount(); assert.deepEqual(f.refs, [f.handle, null]);
});

test("native raw callbacks use the current caller without replacing the native input or marked text", () => {
  const calls = [], f = fixture({ onChange: event => calls.push(["old-change", event]), onChangeText: text => calls.push(["old-text", text]), onSelectionChange: event => calls.push(["old-selection", event]) });
  const old = f.input.props, selection = { start: 1, end: 2 };
  f.render({ value: "ㄓㄨ", selection, onChange: event => calls.push(["change", event]), onChangeText: text => calls.push(["text", text]), onSelectionChange: event => calls.push(["selection", event]) });
  const event = { nativeEvent: { text: "ㄓㄨㄥ", eventCount: 3 } }, caret = { nativeEvent: { selection: { start: 3, end: 3 } } };
  old.onChange(event); old.onChangeText(event.nativeEvent.text); old.onSelectionChange(caret);
  assert.deepEqual(calls, [["change", event], ["text", event.nativeEvent.text], ["selection", caret]]);
  assert.equal(f.input.props.selection, selection); assert.equal(f.input.props.value, "ㄓㄨ"); assert.deepEqual(f.refs, [f.handle]); f.unmount();
});

test("native stale callbacks do not mutate a caller after unmount", () => {
  const calls = [], callback = (...args) => calls.push(args);
  const f = fixture({ onChange: callback, onChangeText: callback, onSelectionChange: callback, onFocus: callback, onBlur: callback, onKeyPress: callback, onEndEditing: callback, onPressIn: callback, onPressOut: callback, onLayout: callback, onContentSizeChange: callback, onScroll: callback, onAccessibilityAction: callback, onSubmitEditing: callback, onAppKeyboardDone: callback });
  f.focus(); calls.length = 0;
  const old = f.input.props, done = f.done.props.onPress, before = f.nativeCalls.length;
  f.unmount();
  for (const name of ["onChange", "onChangeText", "onSelectionChange", "onFocus", "onBlur", "onKeyPress", "onEndEditing", "onPressIn", "onPressOut", "onLayout", "onContentSizeChange", "onScroll", "onAccessibilityAction", "onSubmitEditing"]) old[name]({ nativeEvent: { text: "retired" } });
  done(); assert.deepEqual(calls, []); assert.equal(f.nativeCalls.length, before);
});

test("actual public scope deactivation blocks queued edit, selection and submit while retaining draft", () => {
  const calls = [], f = fixture({ value: "保留 ㄓㄨ draft", onChange: event => calls.push(["change", event]), onChangeText: text => calls.push(["text", text]), onSelectionChange: event => calls.push(["selection", event]), onKeyPress: event => calls.push(["key", event]), onSubmitEditing: event => calls.push(["submit", event]), onAppKeyboardDone: () => calls.push(["done"]) }, { publicRouter: true });
  f.focus(); const old = f.input.props, done = f.done.props.onPress;
  f.scope(false);
  const event = { nativeEvent: { text: "queued", selection: { start: 6, end: 6 }, key: "a" } };
  old.onChange(event); old.onChangeText("queued"); old.onSelectionChange(event); old.onKeyPress?.(event); old.onSubmitEditing(event); done();
  assert.deepEqual(calls, []); assert.ok(f.nativeCalls.includes("blur")); assert.equal(f.input.props.value, "保留 ㄓㄨ draft");
  f.scope(true); f.focus(); f.input.props.onChangeText("可继续 123"); assert.deepEqual(calls, [["text", "可继续 123"]]); f.unmount();
});

test("keyboard lease and readonly transitions reject queued native edits and late focus", () => {
  for (const patch of [{ keyboardActive: false }, { editable: false }, { readOnly: true }]) {
    const calls = [], f = fixture({ onFocus: () => calls.push("focus"), onChangeText: () => calls.push("text"), onSelectionChange: () => calls.push("selection"), onSubmitEditing: () => calls.push("submit") });
    f.focus(); calls.length = 0; const old = f.input.props; f.render(patch);
    old.onChangeText("retired"); old.onSelectionChange({ nativeEvent: { selection: { start: 1, end: 1 } } }); old.onFocus({ nativeEvent: {} }); old.onSubmitEditing({ nativeEvent: { text: "retired" } });
    assert.deepEqual(calls, [], JSON.stringify(patch)); assert.ok(f.nativeCalls.includes("blur")); f.unmount();
  }
});

test("native blur cleanup and layout events stay observable while mounted after scope closes", () => {
  const calls = [], f = fixture({ onBlur: event => calls.push(["blur", event]), onEndEditing: event => calls.push(["end", event]), onLayout: event => calls.push(["layout", event]), onContentSizeChange: event => calls.push(["size", event]) });
  f.focus(); const old = f.input.props; f.render({ scopeActive: false });
  const events = [1, 2, 3, 4].map(value => ({ nativeEvent: { target: value } }));
  old.onBlur(events[0]); old.onEndEditing(events[1]); old.onLayout(events[2]); old.onContentSizeChange(events[3]);
  assert.deepEqual(calls, [["blur", events[0]], ["end", events[1]], ["layout", events[2]], ["size", events[3]]]); f.unmount();
});

test("native secure and OTP fields keep exact UIKit traits through the real public router", () => {
  const f = fixture({ secureTextEntry: true, textContentType: "password", autoComplete: "current-password", importantForAutofill: "yes", keyboardType: "default", autoCorrect: false, spellCheck: false, autoCapitalize: "none", passwordRules: "minlength: 12;", maxLength: 64 }, { publicRouter: true });
  for (const key of ["secureTextEntry", "textContentType", "autoComplete", "importantForAutofill", "keyboardType", "autoCorrect", "spellCheck", "autoCapitalize", "passwordRules", "maxLength"]) assert.equal(f.input.props[key], f.props[key], key);
  const ref = f.input.props.ref;
  f.render({ secureTextEntry: false, textContentType: "oneTimeCode", autoComplete: "one-time-code", inputMode: "numeric", keyboardType: "number-pad", maxLength: 6 });
  for (const key of ["secureTextEntry", "textContentType", "autoComplete", "inputMode", "keyboardType", "maxLength"]) assert.equal(f.input.props[key], f.props[key], key);
  assert.equal(f.input.props.ref, ref); assert.equal(f.input.props.showSoftInputOnFocus, undefined); f.unmount();
});

test("native submit preserves event and invokes one callback even when blur precedes submit", () => {
  const calls = [], f = fixture({ onSubmitEditing: event => calls.push(["native", event]), onAppKeyboardSubmit: () => calls.push(["fallback"]), onAppKeyboardDone: () => calls.push(["done"]) });
  const event = { nativeEvent: { text: "日本語", eventCount: 7, target: 11 } };
  f.focus(); f.input.props.onBlur({ nativeEvent: { target: 11 } }); f.input.props.onSubmitEditing(event);
  assert.deepEqual(calls, [["native", event]]); assert.equal(calls[0][1], event);
  f.render({ onSubmitEditing: undefined }); f.focus(); f.input.props.onSubmitEditing(event);
  assert.deepEqual(calls, [["native", event], ["fallback"]]); f.unmount();
});

test("native Done waits for native end editing, reads current callback and never sends", () => {
  const calls = [], f = fixture({ onAppKeyboardDone: () => calls.push("old"), onAppKeyboardSubmit: () => calls.push("submit") });
  const done = f.done.props.onPress; done(); assert.deepEqual(calls, []);
  f.focus(); f.render({ onAppKeyboardDone: () => { assert.equal(f.nativeCalls.at(-1), "blur"); calls.push("current"); } });
  done(); done(); assert.deepEqual(calls, []); assert.deepEqual(f.nativeCalls, ["blur"]);
  f.end(); f.end(); assert.deepEqual(calls, ["current"]);
  f.focus(); f.done.props.onPress(); assert.deepEqual(calls, ["current"]); f.end(); assert.deepEqual(calls, ["current", "current"]);
  f.unmount(); done(); assert.deepEqual(calls, ["current", "current"]);
});

test("native asynchronous Done drains final raw Change then EndEditing before closing the current draft", () => {
  const calls = [], f = fixture({ value: "niha", onChange: event => calls.push(["change", event]), onChangeText: text => { calls.push(["text", text]); f.render({ value: text }); }, onEndEditing: event => calls.push(["end", event]), onAppKeyboardDone: () => { calls.push(["done", f.props.value]); f.scope(false); } }, { publicRouter: true });
  f.focus(); const ref = f.input.props.ref;
  f.done.props.onPress(); assert.deepEqual(calls, []); assert.equal(f.props.scopeActive, true); assert.equal(f.input.props.value, "niha");
  const change = { nativeEvent: { text: "你好", eventCount: 5, target: 11 } }, end = { nativeEvent: { text: "你好", eventCount: 5, target: 11 } };
  f.input.props.onChange(change); f.input.props.onChangeText(change.nativeEvent.text);
  assert.equal(f.input.props.value, "你好"); assert.deepEqual(calls, [["change", change], ["text", "你好"]]);
  f.end(end); assert.deepEqual(calls, [["change", change], ["text", "你好"], ["end", end], ["done", "你好"]]);
  assert.equal(calls[0][1], change); assert.equal(calls[2][1], end); assert.equal(f.input.props.ref, ref);
  f.end(end); assert.equal(calls.length, 5, "A duplicate end is forwarded but must not invoke another Done");
  assert.deepEqual(calls.at(-1), ["end", end]); f.unmount();
});

test("pending native Done is cancelled by scope, keyboard lease, readonly, unmount and a new focus", () => {
  for (const patch of [{ scopeActive: false }, { keyboardActive: false }, { editable: false }, { readOnly: true }, "unmount", "focus"]) {
    const calls = [], f = fixture({ onAppKeyboardDone: () => calls.push("done") });
    f.focus(); const end = f.input.props.onEndEditing; f.done.props.onPress(); assert.deepEqual(calls, []);
    if (patch === "unmount") f.unmount(); else if (patch === "focus") f.focus(); else f.render(patch);
    end({ nativeEvent: { text: "final marked text", target: 11 } }); assert.deepEqual(calls, [], JSON.stringify(patch));
    f.unmount();
  }
});

test("native Done accepts a synchronous EndEditing inside blur and consumes its acknowledgement only once", () => {
  const calls = [], f = fixture({ onEndEditing: event => calls.push(["end", event]), onAppKeyboardDone: () => calls.push(["done"]) });
  const end = { nativeEvent: { text: "한국어", target: 11 } };
  f.handle.blur = () => { f.nativeCalls.push("blur"); f.end(end); };
  f.focus(); f.done.props.onPress(); f.done.props.onPress();
  assert.deepEqual(calls, [["end", end], ["done"]]); assert.equal(calls[0][1], end); assert.deepEqual(f.nativeCalls, ["blur"]); f.unmount();
});

test("native EndEditing without an outstanding Done is forwarded and never synthesizes text or Done", () => {
  const calls = [], f = fixture({ onEndEditing: event => calls.push(["end", event]), onChangeText: text => calls.push(["text", text]), onAppKeyboardDone: () => calls.push(["done"]) });
  const end = { nativeEvent: { text: "שלום", target: 11 } };
  f.focus(); f.end(end); assert.deepEqual(calls, [["end", end]]); assert.deepEqual(f.nativeCalls, []); f.unmount();
});

test("native EndEditing caller can retire or refocus a pending Done before its callback", () => {
  for (const action of ["unmount", "deactivate", "refocus"]) {
    const calls = [], f = fixture({ onEndEditing: event => {
      calls.push(["end", event]);
      if (action === "unmount") f.unmount(); else if (action === "deactivate") f.render({ scopeActive: false }); else f.focus();
    }, onAppKeyboardDone: () => calls.push(["done"]) });
    const end = { nativeEvent: { text: "final", target: 11 } };
    f.focus(); f.done.props.onPress(); f.end(end); assert.deepEqual(calls, [["end", end]], action); f.unmount();
  }
});

test("native Done cannot call a retired owner if blur synchronously closes its scope or unmounts", () => {
  for (const action of ["unmount", "deactivate"]) {
    const calls = [], f = fixture({ onAppKeyboardDone: () => calls.push("done") });
    f.focus();
    f.handle.blur = () => {
      f.nativeCalls.push("blur");
      f.handle.blur = () => f.nativeCalls.push("blur");
      if (action === "unmount") f.unmount(); else f.render({ scopeActive: false });
    };
    f.done.props.onPress(); assert.deepEqual(calls, [], action); f.unmount();
  }
});

test("native multiline text and literal newline never synthesize submit or Done", () => {
  const calls = [], f = fixture({ multiline: true, submitBehavior: "newline", returnKeyType: "default", onChangeText: text => calls.push(["text", text]), onAppKeyboardSubmit: () => calls.push(["submit"]), onAppKeyboardDone: () => calls.push(["done"]) }, { publicRouter: true });
  f.focus(); f.input.props.onChangeText("第一行\n두 번째 줄"); f.input.props.onBlur({ nativeEvent: {} });
  assert.deepEqual(calls, [["text", "第一行\n두 번째 줄"]]); assert.equal(f.input.props.submitBehavior, "newline"); assert.equal(f.input.props.multiline, true); f.unmount();
});

test("caller-owned accessory and explicit native opt-out remain caller-owned", () => {
  const calls = [], f = fixture({ appKeyboard: false, scopeActive: false, keyboardActive: false, inputAccessoryViewID: "external-native-accessory", onFocus: () => calls.push("focus"), onChangeText: text => calls.push(text) });
  assert.equal(f.done, undefined); assert.equal(f.input.props.inputAccessoryViewID, "external-native-accessory");
  f.focus(); f.input.props.onChangeText("123 שלום"); assert.deepEqual(calls, ["focus", "123 שלום"]); assert.deepEqual(f.nativeCalls, []); f.unmount();
});

test("StrictMode effect replay preserves native identity and live event callbacks", () => {
  const calls = [], f = fixture({ onChangeText: text => calls.push(text), onAppKeyboardDone: () => calls.push("done") }, { publicRouter: true });
  const ref = f.input.props.ref; f.strictReplay(); f.focus(); f.input.props.onChangeText("ㄓㄨㄥ"); f.done.props.onPress(); f.end();
  assert.deepEqual(calls, ["ㄓㄨㄥ", "done"]); assert.equal(f.input.props.ref, ref); assert.deepEqual(f.refs, [f.handle]); f.unmount();
});
