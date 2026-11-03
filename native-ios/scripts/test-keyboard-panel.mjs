import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import ts from "typescript";

// Execute the real panel and its Key/Glyph/material children with independent
// hook lifetimes. Only native/browser boundaries are mocked; no input owner,
// permissions, file picker, account, network, or native GUI is accessed.
// These are callback/style/asset checks, not pixel or UIKit acceptance.
const sourcePath = "src/keyboard/KeyboardPanel.tsx";
const read = path => readFileSync(path, "utf8");
const walk = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
const flatten = style => typeof style === "function" ? flatten(style({ pressed: false })) : Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flatten)) : style ?? {};
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const CHROMIUM_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

function fixture(options = {}) {
  const contexts = new Map(), listeners = new Map(), mediaListeners = new Set(), intervals = new Map(), pressedKeys = new Set();
  const calls = [], imports = [], optionalModules = [], glassImports = [], writes = [];
  const subscriptions = { nativeQueries: 0, nativeAdds: 0, mediaQueries: 0, mediaAdds: 0 };
  let current, pending = [], tree, timerID = 0, mounted = true;
  const dimensions = options.dimensions ?? { width: 402, height: 874, fontScale: 1 };
  const safe = options.safe ?? { top: 62, bottom: 34, left: 0, right: 0 };
  const media = { matches: !!options.reduced, addEventListener: (_event, fn) => { subscriptions.mediaAdds++;mediaListeners.add(fn); }, removeEventListener: (_event, fn) => mediaListeners.delete(fn) };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useRef(initial) { const c = current, i = c.cursor++; return c.slots[i] ??= { current: initial }; },
    useState(initial) {
      const c = current, i = c.cursor++;
      if (!(i in c.slots)) c.slots[i] = typeof initial === "function" ? initial() : initial;
      return [c.slots[i], next => { writes.push(c.id); if (c.mounted) c.slots[i] = typeof next === "function" ? next(c.slots[i]) : next; }];
    },
    useEffect(fn, deps) {
      const c = current, i = c.cursor++;
      if (!c.effects[i] || !same(c.effects[i].deps, deps)) pending.push(() => { c.effects[i]?.cleanup?.(); c.effects[i] = { deps, cleanup: fn() }; });
    },
  };
  const Fragment = Symbol("Fragment"), jsx = (type, props, key) => ({ type, props, key });
  const native = {
    View: "View", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", Modal: "Modal",
    Platform: { OS: options.os ?? "ios" }, useWindowDimensions: () => dimensions,
    StyleSheet: { create: value => value, absoluteFill: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 } },
    // RN-web does not expose this method. Its absence must not be hidden by a
    // permissive fixture, which would miss the real browser crash regression.
    AccessibilityInfo: {
      ...(options.os === "web" ? {} : { isReduceTransparencyEnabled: () => { subscriptions.nativeQueries++;return options.reductionQuery?.() ?? Promise.resolve(!!options.reduced); } }),
      addEventListener(name, fn) { if (options.os === "web") throw Error("Web must not call native accessibility APIs"); subscriptions.nativeAdds++;listeners.set(name, fn); return { remove: () => listeners.delete(name) }; },
    },
  };
  const deps = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment }, "react-native": native,
    "expo-image": { Image: "Image" }, "expo-blur": { BlurView: "BlurView" },
    expo: { requireOptionalNativeModule: name => { optionalModules.push(name); return options.nativeModule === false ? null : {}; } },
    "react-native-safe-area-context": { useSafeAreaInsets: () => safe },
    "@/src/i18n": { useT: () => ({ locale: options.locale ?? "en" }) },
    "./vendor/THIRD_PARTY_NOTICES.json": { default: JSON.parse(read("src/keyboard/vendor/THIRD_PARTY_NOTICES.json")) },
  };
  const compiled = ts.transpileModule(read(sourcePath), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "globalThis", "navigator", "setInterval", "clearInterval", compiled)(name => {
    imports.push(name);
    if (name.startsWith("@/assets/")) return name;
    if (name === "expo-glass-effect") {
      glassImports.push(name);
      if (options.glassImportThrows) throw Error("Fixture old binary has no public glass module");
      return { GlassView: "PublicGlassView", isLiquidGlassAvailable: () => options.liquidGlass !== false, isGlassEffectAPIAvailable: () => options.glassAPI !== false };
    }
    assert.ok(name in deps, "Unexpected panel service/permission dependency: " + name);
    return deps[name];
  }, module, module.exports, {
    ...(options.noMatchMedia ? {} : { matchMedia: query => { subscriptions.mediaQueries++;assert.equal(query, "(prefers-reduced-transparency: reduce)"); return media; } }),
    // Deliberately permissive syntax support must not enable an unverified
    // paint engine. UA is explicit; never inherit Node's real navigator.
    CSS: { supports: () => true },
  }, options.noNavigator ? undefined : { userAgent: options.userAgent ?? CHROMIUM_UA }, fn => { const id = ++timerID; intervals.set(id, fn); return id; }, id => intervals.delete(id));
  const props = {
    layout: "text", mode: "en", shift: false, secure: false, multiline: false, returnKeyLabel: "Send", preedit: "", candidates: [],
    onText: value => calls.push(["text", value]), onBackspace: () => calls.push(["backspace"]), onSpace: () => calls.push(["space"]), onEnter: () => calls.push(["enter"]), onDone: () => calls.push(["done"]), onModeChange: value => calls.push(["mode", value]), onShift: () => calls.push(["shift"]), onCandidate: value => calls.push(["candidate", value]), onUseSystemKeyboard: () => calls.push(["system"]), onHeightChange: value => calls.push(["height", value]),
    ...options.props,
  };
  function expand(node, path, seen) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key ?? index}`, seen));
    if (node.type === Fragment) return expand(node.props?.children, path + "/fragment", seen);
    if (typeof node.type === "function") {
      const id = path + ":" + node.type.name;
      let c = contexts.get(id);
      if (!c) { c = { id, slots: [], effects: [], cursor: 0, mounted: true }; contexts.set(id, c); }
      c.cursor = 0; seen.add(id); const previous = current; current = c;
      const rendered = node.type(node.props); current = previous;
      return expand(rendered, id, seen);
    }
    const children = node.type === "Pressable" && typeof node.props?.children === "function" ? node.props.children({ pressed: pressedKeys.has(node.props.testID), hovered: false, focused: false }) : node.props?.children;
    return { ...node, props: { ...node.props, children: expand(children, path + "/children", seen) } };
  }
  const f = {
    props, calls, imports, optionalModules, glassImports, dimensions, safe, subscriptions, exports: module.exports,
    get tree() { return tree; }, get writes() { return writes.length; }, get intervalCount() { return intervals.size; },
    get listenerCount() { return listeners.size + mediaListeners.size; },
    get reductionHandler() { return listeners.get("reduceTransparencyChanged"); },
    render(patch) {
      assert.equal(mounted, true); Object.assign(props, patch); pending = []; const seen = new Set();
      // React creates a new props object each render; old event closures must
      // retain their old owner rather than reading a fixture-mutated object.
      tree = expand(jsx(module.exports.KeyboardPanel, { ...props }), "root", seen);
      for (const [id, c] of contexts) if (!seen.has(id)) { c.effects.forEach(effect => effect?.cleanup?.()); c.mounted = false; contexts.delete(id); }
      pending.forEach(fn => fn()); return tree;
    },
    async settle() { await tick(); return f.render(); },
    all() { return walk(tree); }, find(id) { return walk(tree).find(node => node.props?.testID === id || node.props?.["data-testid"] === id); },
    pressed(id, value) { if(value)pressedKeys.add(id);else pressedKeys.delete(id);return f.render(); },
    press(id) { const node = f.find(id); assert.ok(node, id); if (!node.props.disabled) node.props.onPress(); },
    longPress(id) { const node = f.find(id); assert.ok(node?.props.onLongPress, id); if (!node.props.disabled) node.props.onLongPress(); },
    release(id) { f.find(id).props.onPressOut(); },
    repeat() { for (const fn of [...intervals.values()]) fn(); },
    reduce(value) { media.matches = value; mediaListeners.forEach(fn => fn()); listeners.get("reduceTransparencyChanged")?.(value); },
    unmount() { contexts.forEach(c => { c.mounted = false; c.effects.forEach(effect => effect?.cleanup?.()); }); mounted = false; },
  };
  f.render(); return f;
}

test("portrait keyboard keeps the 402×336 design,43pt keys,28pt panel corners and measured-height callback", async () => {
  const f = fixture({ os: "web" }); await f.settle();
  const root = f.find("app-keyboard"), style = flatten(root.props.style), keys = f.all().filter(node => node.props?.accessibilityRole === "keyboardkey");
  assert.equal(style.width, "100%"); assert.equal(style.height, 336); assert.equal(style.flexShrink, 0); assert.equal(style.borderTopLeftRadius, 28); assert.equal(style.borderTopRightRadius, 28); assert.equal(style.overflow, "hidden"); assert.equal(style.backdropFilter, undefined, "Blur belongs to its native DOM material layer, not the RNW root stacking context");
  assert.equal(f.exports.KEYBOARD_DESIGN.key.height, 43); assert.equal(f.exports.KEYBOARD_DESIGN.key.rowGap, 11); assert.equal(f.exports.KEYBOARD_DESIGN.key.radius, 8.5); assert.equal(f.exports.KEYBOARD_DESIGN.glass.refraction, .8); assert.equal(f.exports.KEYBOARD_DESIGN.cssBlur, 25);
  for (const key of keys) { assert.equal(flatten(key.props.style).height, 43); assert.equal(flatten(key.props.style).borderRadius, 8.5); assert.equal(flatten(key.props.style).overflow, "hidden"); }
  const letter = walk(f.find("app-key-q")).find(node => node.type === "Text"); assert.equal(flatten(letter.props.style).fontSize, 28); assert.equal(flatten(letter.props.style).lineHeight, 34);
  assert.equal(flatten(f.find("app-keyboard-done").props.style).height, 44); assert.deepEqual(f.calls, []);
  root.props.onLayout({ nativeEvent: { layout: { height: 336 } } }); assert.deepEqual(f.calls, [["height", 336]]); f.unmount();
});

test("small portrait and landscape layouts remain bounded style trees without invented fixed screen widths", async () => {
  for (const [width, height, top, bottom] of [[320, 568, 20, 0], [568, 320, 0, 21], [874, 402, 0, 21]]) {
    const f = fixture({ dimensions: { width, height, fontScale: 2 }, safe: { top, bottom, left: 0, right: 0 } }); await f.settle();
    const root = flatten(f.find("app-keyboard").props.style), key = flatten(f.find("app-key-q").props.style), scale = Math.min(1, Math.max(.55, (height - top - 160) / 336));
    assert.equal(root.width, "100%"); assert.equal(root.height, 336 * scale + Math.max(0, bottom - 34)); assert.ok(root.height > 0 && root.height <= height - top); assert.equal(key.height, 43 * scale); assert.ok(key.height >= 20); assert.equal(key.minWidth, 0);
    const letter = walk(f.find("app-key-q")).find(node => node.type === "Text"), text = flatten(letter.props.style); assert.equal(letter.props.numberOfLines, 1); assert.equal(text.fontSize, 28 * scale); assert.equal(text.lineHeight, 34 * scale); assert.ok(text.fontSize <= key.height && text.lineHeight <= key.height, "Scaled Key text cannot retain a taller28/34pt line inside a23.65pt landscape key");
    const footerFixed = 50 + 44 + 93 + 3 * 6 + 2 * 6.67; assert.ok(footerFixed < width, "Fixed footer tools leave space for the flex space key");
    for (const image of f.all().filter(node => node.type === "Image")) assert.ok(flatten(image.props.style).height <= key.height, "20pt glyph stays inside a scaled key");
    f.unmount();
  }
  // Font rasterization, real flex/Yoga positions and native touch ergonomics
  // are intentionally not inferred from this style-tree bound check.
});

test("web material tolerates missing RNW ReduceTransparency API and missing matchMedia", async () => {
  for (const noMatchMedia of [false, true]) {
    const f = fixture({ os: "web", noMatchMedia }); await f.settle();
    assert.equal(f.optionalModules.length, 0); assert.equal(f.glassImports.length, 0); assert.equal(f.all().some(node => node.type === "BlurView" || node.type === "PublicGlassView"), false); assert.equal(flatten(f.find("app-keyboard-material").props.style).pointerEvents, "none");
    assert.match(flatten(f.find("app-keyboard-material").props.style).backdropFilter,/^blur\(25px\) url\(#nuri-keyboard-panel-tint\)$/);assert.ok(f.all().some(node=>node.type==="filter"&&node.props.id==="nuri-keyboard-panel-tint"));f.unmount(); assert.equal(f.listenerCount, 0);
  }
});

test("old native binary never imports missing ExpoGlassEffect and retains the explicit blur fallback", async () => {
  const f = fixture({ nativeModule: false }); await f.settle();
  assert.deepEqual(f.optionalModules, ["ExpoGlassEffect"]); assert.deepEqual(f.glassImports, []); const blur = walk(f.find("app-keyboard-material")).find(node => node.type === "BlurView"); assert.ok(blur); assert.equal(blur.props.intensity, 50); assert.equal(blur.props.tint, "systemUltraThinMaterialLight"); assert.equal(f.all().some(node => node.type === "PublicGlassView"), false); f.unmount(); assert.equal(f.listenerCount, 0);
});

test("public native glass is used only with its module and both supported public availability checks", async () => {
  for (const options of [{}, { liquidGlass: false }, { glassAPI: false }, { glassImportThrows: true }, { os: "android" }]) {
    const f = fixture(options); await f.settle(); const panel = walk(f.find("app-keyboard-material")), glass = panel.find(node => node.type === "PublicGlassView");
    const available = options.os !== "android" && options.liquidGlass !== false && options.glassAPI !== false && !options.glassImportThrows;
    assert.equal(!!glass, available); assert.equal(panel.some(node => node.type === "BlurView"), !available);
    if (available) { assert.equal(glass.props.glassEffectStyle, "regular"); assert.equal(glass.props.colorScheme, "light"); }
    if (options.os === "android") { assert.deepEqual(f.optionalModules, []); assert.deepEqual(f.glassImports, []); } f.unmount();
  }
});

test("reduced transparency is opaque, live changes clean up, and a late native query cannot write after unmount", async () => {
  for (const os of ["ios", "web"]) {
    const f = fixture({ os, reduced: true }); await f.settle(); assert.ok(f.all().some(node => flatten(node.props?.style).backgroundColor === "#F8F3F2")); assert.equal(f.all().some(node => node.type === "BlurView" || node.type === "PublicGlassView"), false); assert.deepEqual(f.glassImports, []);
    const panel = f.find("app-keyboard-material"), key = f.find("app-key-material");assert.ok(walk(key).some(node => flatten(node.props?.style).backgroundColor === "white"));for(const material of[panel,key])assert.ok(walk(material).every(node => !flatten(node.props?.style).mixBlendMode && !flatten(node.props?.style).backdropFilter), "Reduced transparency never keeps tint or blur layers");
    f.reduce(false); f.render(); assert.equal(f.all().some(node => flatten(node.props?.style).backgroundColor === "#F8F3F2"), false); f.unmount(); assert.equal(f.listenerCount, 0);
  }
  let resolve; const f = fixture({ reductionQuery: () => new Promise(yes => { resolve = yes; }) }); f.unmount(); const before = f.writes; resolve(false); await tick(); assert.equal(f.writes, before); assert.deepEqual(f.glassImports, []);
});

test("a newer native Reduce Transparency event beats the pending initial query, and retired events cannot write", async () => {
  let resolve;
  const f = fixture({ reductionQuery: () => new Promise(yes => { resolve = yes; }) });
  const retiredEvent = f.reductionHandler; assert.equal(typeof retiredEvent, "function");
  f.reduce(true); f.render(); const writesAfterEvent = f.writes;
  resolve(false); await tick(); f.render();
  assert.equal(f.writes, writesAfterEvent, "The old query must not schedule a state update after a newer event");
  for (const material of f.all().filter(node => node.props?.testID === "app-keyboard-material" || node.props?.testID === "app-key-material")) {
    const expected = material.props.testID === "app-key-material" ? "white" : "#F8F3F2";
    assert.ok(walk(material).some(node => flatten(node.props?.style).backgroundColor === expected));
    assert.equal(walk(material).some(node => node.type === "BlurView" || node.type === "PublicGlassView"), false);
  }
  assert.deepEqual(f.optionalModules, []); assert.deepEqual(f.glassImports, []);
  f.unmount(); const writesAfterUnmount = f.writes;
  retiredEvent(false); await tick();
  assert.equal(f.writes, writesAfterUnmount); assert.equal(f.listenerCount, 0);
});

test("only explicitly verified Chromium UAs enable SVG backdrop transfer; WebKit, Firefox and unknown engines retain real25px blur", async () => {
  const cases = [
    ["Chrome", { userAgent: CHROMIUM_UA }, true],
    ["Chromium", { userAgent: CHROMIUM_UA.replace("Chrome/", "Chromium/") }, true],
    ["Edge", { userAgent: CHROMIUM_UA + " Edg/142.0.0.0" }, true],
    ["Opera", { userAgent: CHROMIUM_UA + " OPR/124.0.0.0" }, true],
    ["Safari", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15" }, false],
    ["iOS Chrome", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1" }, false],
    ["Firefox", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0" }, false],
    ["iOS Firefox hard exclusion", { userAgent: CHROMIUM_UA + " FxiOS/144.0" }, false],
    ["iOS Edge hard exclusion", { userAgent: CHROMIUM_UA + " EdgiOS/142.0" }, false],
    ["unknown", { userAgent: "UnverifiedEngine/1" }, false],
    ["empty UA", { userAgent: "" }, false],
    ["missing navigator", { noNavigator: true }, false],
  ];
  for (const [name, options, transfer] of cases) {
    const f = fixture({ os: "web", ...options }); await f.settle();
    const materials = f.all().filter(node => ["app-keyboard-material", "app-key-material"].includes(node.props?.["data-testid"]));
    assert.ok(materials.length > 30, name); assert.deepEqual(f.optionalModules, []); assert.deepEqual(f.glassImports, []);
    for (const material of materials) {
      const key = material.props["data-testid"] === "app-key-material", style = flatten(material.props.style);
      const expected = transfer ? `blur(25px) url(#nuri-keyboard-${key ? "key" : "panel"}-tint)` : "blur(25px)";
      assert.equal(style.backdropFilter, expected, name); assert.equal(style.WebkitBackdropFilter, expected, name);
      assert.equal(style.pointerEvents, "none"); assert.equal(style.backgroundColor, undefined);
      const backgrounds = [material.props.children].flat(Infinity).filter(Boolean).map(node => flatten(node.props.style).background);
      assert.deepEqual(backgrounds, key ? ["rgba(255,255,255,.67)", ...(!transfer ? [`rgba(255,255,255,${25/255/(1-.67)})`] : [])] : ["rgba(229,167,159,.1)", ...(!transfer ? [`rgba(255,255,255,${27/255*.2})`, "rgba(211,158,158,.1)"] : [])], name);
      assert.ok(walk(material).every(node => !["multiply", "screen", "linear-burn", "plus-lighter"].includes(flatten(node.props?.style).mixBlendMode)));
      assert.ok(walk(material).every(node => !/^#(?:191919|c4c4c4)$/i.test(flatten(node.props?.style).background ?? flatten(node.props?.style).backgroundColor ?? "")));
      assert.equal(walk(material).some(node => node.type === "Text" || node.type === "Image"), false);
    }
    assert.equal(f.exports.KEYBOARD_DESIGN.cssBlur, 25); assert.equal(f.exports.KEYBOARD_DESIGN.blurRadius, 50); assert.equal(f.exports.KEYBOARD_DESIGN.fills[2].blend, "linear-burn");
    f.unmount(); assert.equal(f.listenerCount, 0);
  }
  // These assertions cover the chosen fallback contract, not optical or
  // CSS paint support; the real browser/native acceptance remains separate.
});

test("web panel/key materials use independent native DOM backdrop transfers without opaque dark keys or RNW isolation", async () => {
  const f=fixture({os:"web"});await f.settle();const panel=f.find("app-keyboard-material"),layers=panel.props.children;
  assert.equal(panel.type,"div");assert.equal(panel.props["aria-hidden"],"true");assert.equal(flatten(panel.props.style).backdropFilter,"blur(25px) url(#nuri-keyboard-panel-tint)");assert.equal(flatten(panel.props.style).WebkitBackdropFilter,flatten(panel.props.style).backdropFilter);assert.equal(flatten(panel.props.style).borderRadius,"inherit");assert.ok(walk(panel).every(node=>node.type==="div"));
  assert.deepEqual([layers].flat().filter(Boolean).map(node=>flatten(node.props.style).background),["rgba(229,167,159,.1)"]);assert.deepEqual([layers].flat().filter(Boolean).map(node=>flatten(node.props.style).mixBlendMode),["luminosity"]);assert.equal(f.exports.KEYBOARD_DESIGN.fills[2].blend,"linear-burn","Preserve the raw design reference, not the unsupported rendering approximation");
  const keys=f.all().filter(node=>node.props?.testID?.startsWith("app-key-")&&node.props.accessibilityRole==="keyboardkey");assert.ok(keys.length>30);
  for(const key of keys){const children=key.props.children;assert.ok(Array.isArray(children));const material=children[0];assert.equal(material.props["data-testid"],"app-key-material");assert.equal(material.type,"div");assert.ok(walk(material).every(node=>node.type==="div"));assert.equal(flatten(material.props.style).backdropFilter,"blur(25px) url(#nuri-keyboard-key-tint)");assert.equal(flatten(material.props.style).WebkitBackdropFilter,flatten(material.props.style).backdropFilter);assert.deepEqual([material.props.children].flat().filter(Boolean).map(node=>flatten(node.props.style).background),["rgba(255,255,255,.67)"]);assert.ok(walk(material).every(node=>flatten(node.props?.style).zIndex===undefined));assert.ok(!walk(material).some(node=>node.type==="Text"||node.type==="Image"));assert.equal(flatten(key.props.style).backgroundColor,undefined,"Do not replace independent material with an opaque target fill");}
  const renderedMaterials=[...walk(panel),...keys.flatMap(key=>walk(key.props.children[0]))];assert.ok(renderedMaterials.every(node=>!['multiply','linear-burn','plus-lighter'].includes(flatten(node.props?.style).mixBlendMode)));assert.ok(renderedMaterials.every(node=>!/^#(?:191919|c4c4c4)$/i.test(flatten(node.props?.style).background??flatten(node.props?.style).backgroundColor??"")),"Never restore the opaque dark additive fill that produced gray keys");assert.deepEqual(f.calls,[]);f.unmount();
});

test("SVG sRGB transfer endpoints and midpoints preserve the declared channel math rather than premultiplied-alpha gray", async () => {
  const f=fixture({os:"web"});await f.settle();const filters=f.all().filter(node=>node.type==="filter");assert.equal(filters.length,2);const panel=filters.find(node=>node.props.id==="nuri-keyboard-panel-tint"),key=filters.find(node=>node.props.id==="nuri-keyboard-key-tint");for(const filter of[panel,key])assert.equal(filter.props.colorInterpolationFilters,"sRGB");
  const channels=walk(panel).filter(node=>/^feFunc[RGB]$/.test(node.type));assert.equal(channels.length,3);for(const[channel,rose]of channels.map((node,index)=>[node,index===0?.8269230723381042:.620192289352417])){assert.equal(channel.props.type,"table");const values=channel.props.tableValues.split(/\s+/).map(Number);assert.equal(values.length,256);assert.ok(values.every((value,index)=>Number.isFinite(value)&&value>=0&&value<=1&&(index===0||value>=values[index-1])));for(const index of[0,127,128,255]){const backdrop=index/255,burn=backdrop*.9+Math.max(0,backdrop+rose-1)*.1,expected=burn*.8+Math.min(1,burn+27/255)*.2;assert.ok(Math.abs(values[index]-expected)<=.00000051,`${channel.type}/${index}`);}}
  const functions=walk(key).filter(node=>/^feFunc[RGB]$/.test(node.type));assert.equal(functions.length,3);const clamp=value=>Math.max(0,Math.min(1,value));for(const fn of functions){assert.equal(fn.props.type,"linear");assert.equal(Number(fn.props.slope),1);assert.equal(fn.props.intercept,25/255/(1-.67));for(const backdrop of[0,127/255,.5,128/255,.9,1]){const actual=.67+(1-.67)*clamp(backdrop+fn.props.intercept),expected=clamp(.67+(1-.67)*backdrop+25/255);assert.ok(Math.abs(actual-expected)<1e-12);}assert.equal(.67+.33*clamp(1+fn.props.intercept),1);const correctedMidpoint=255*(.67+.33*clamp(.5+fn.props.intercept)),oldOpaqueGray=255*.67+25;assert.ok(correctedMidpoint>oldOpaqueGray+35,"The old #c4 gray negative control must stay materially darker than the corrected mid-gray-backdrop channel");}
  // This tests channel arithmetic and resource references, not the browser's
  // backdrop-filter implementation or native optical/performance equivalence.
  f.unmount();
});

test("each native key keeps its own50pt Blur plus white/additive approximation while panel alone uses public regular glass", async () => {
  const f=fixture();await f.settle();const panel=f.find("app-keyboard-material"),keyMaterials=f.all().filter(node=>node.props?.testID==="app-key-material"),keys=f.all().filter(node=>node.props?.testID?.startsWith("app-key-")&&node.props.accessibilityRole==="keyboardkey");assert.equal(keyMaterials.length,keys.length);assert.equal(walk(panel).filter(node=>node.type==="PublicGlassView").length,1);assert.equal(walk(panel).some(node=>node.type==="BlurView"),false);
  for(const material of keyMaterials){const blur=walk(material).find(node=>node.type==="BlurView");assert.ok(blur);assert.equal(blur.props.intensity,50);assert.equal(blur.props.tint,"systemUltraThinMaterialLight");assert.equal(walk(material).some(node=>node.type==="PublicGlassView"),false);assert.ok(walk(material).some(node=>flatten(node.props?.style).backgroundColor==="rgba(255,255,255,.67)"));assert.ok(walk(material).some(node=>flatten(node.props?.style).backgroundColor===`rgba(255,255,255,${25/255/(1-.67)})`));assert.ok(walk(material).every(node=>flatten(node.props?.style).backgroundColor!=="#191919"&&!['screen','multiply','plus-lighter'].includes(flatten(node.props?.style).mixBlendMode)));assert.equal(material.props.pointerEvents,"none");}
  assert.ok(walk(panel).some(node=>flatten(node.props?.style).backgroundColor===`rgba(255,255,255,${27/255*.2})`));assert.ok(walk(panel).every(node=>!['multiply','linear-burn','screen'].includes(flatten(node.props?.style).mixBlendMode)));assert.ok(!walk(panel).some(node=>flatten(node.props?.style).backgroundColor==="rgba(27,27,27,.2)"));f.unmount();
});

test("pressed/selected veils do not replace per-key blur or blur the glyph/text", async () => {
  for(const os of["web","ios"]){const f=fixture({os,props:{shift:true}});await f.settle();const id="app-key-Q",before=f.find(id),material=before.props.children[0],text=before.props.children[2];assert.equal(flatten(before.props.children[1].props.style).backgroundColor,"transparent");assert.equal(flatten(f.find("app-key-shift").props.children[1].props.style).backgroundColor,"rgba(193,160,221,.55)");
    f.pressed(id,true);const pressed=f.find(id);assert.equal(pressed.type,before.type);assert.deepEqual(pressed.props.children[0].props.style,material.props.style);assert.equal(flatten(pressed.props.children[1].props.style).backgroundColor,"rgba(235,129,131,.24)");assert.equal(pressed.props.children[1].props.pointerEvents,"none");assert.equal(pressed.props.children[2].type,text.type);assert.deepEqual(pressed.props.children[2].props.style,text.props.style);for(const key of['filter','backdropFilter','opacity'])assert.equal(flatten(pressed.props.children[2].props.style)[key],undefined);assert.equal(walk(pressed.props.children[0]).some(node=>node.type==="Text"||node.type==="Image"),false);assert.ok(os==="web"?flatten(pressed.props.children[0].props.style).backdropFilter:walk(pressed.props.children[0]).some(node=>node.type==="BlurView"));f.pressed(id,false);assert.equal(flatten(f.find(id).props.children[1].props.style).backgroundColor,"transparent");assert.deepEqual(f.calls,[]);f.unmount();
  }
});

test("all keys share one accessibility preference subscription and one native capability probe per parent render", async () => {
  for(const os of["ios","web"]){const f=fixture({os});await f.settle();assert.ok(f.all().filter(node=>node.props?.testID==="app-key-material"||node.props?.["data-testid"]==="app-key-material").length>30);assert.equal(f.listenerCount,1);assert.deepEqual(f.subscriptions,os==="web"?{nativeQueries:0,nativeAdds:0,mediaQueries:1,mediaAdds:1}:{nativeQueries:1,nativeAdds:1,mediaQueries:0,mediaAdds:0});const probes=f.optionalModules.length;assert.equal(probes,os==="ios"?1:0);f.render();assert.equal(f.optionalModules.length-probes,os==="ios"?1:0);assert.equal(f.listenerCount,1);assert.equal(f.subscriptions.nativeAdds+f.subscriptions.mediaAdds,1);f.unmount();assert.equal(f.listenerCount,0);}
});

test("glyphs use the actual exported files in20pt contain slots while original file roots remain unchanged", async () => {
  const expected = {
    "keyboard-shift.svg": [21, 19, "d5830a8cd26aca28e702cb1312755f6c5bfae0f52efccdecd6d8bed8270bdc09"],
    "keyboard-delete.svg": [21, 18, "7ac2650d42e8abaf2bf5a56f4e0570dc759be2dec69be47acf2c468413c5f049"],
    "keyboard-globe.svg": [20, 20, "bd6c3a2be445ca1431da0a14e2d8da5f0d5c2fab387ce424ee7a33d783d12d12"],
    "keyboard-return.svg": [21, 18, "0676db25fbb5d1fd2e757e0065b0c48319bbde77c1c0643f10e00c624e556d6c"],
    "community-emoji.svg": [20, 20, "ead4193f3ccd34cf438988b3168be96eb1b5b4e2456fc7823e91df34906aaa68"],
    "microphone.svg": [20, 20, "0890fceeb80343a219932fb7f931089537e43b7858439e07bac7e352ae40f215"],
  };
  const f = fixture({ props: { multiline: true, onDictation() {} } }); await f.settle(); const images = f.all().filter(node => node.type === "Image");
  for (const [file, [width, height, hash]] of Object.entries(expected)) {
    const image = images.find(node => node.props.source.endsWith("/" + file)); assert.ok(image, file); assert.deepEqual(image.props.style, { width: 20, height: 20 }); assert.equal(image.props.contentFit, "contain"); assert.equal(image.props.accessible, false);
    const bytes = readFileSync("assets/final-flow-20261101/" + file), root = bytes.toString("utf8").match(/<svg\b[^>]*>/)?.[0]; assert.ok(root); assert.match(root, new RegExp(`\\bwidth="${width}"`)); assert.match(root, new RegExp(`\\bheight="${height}"`)); assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  }
  f.unmount();
});

test("letters, shift, language, candidates, space, return, dictation and Done call only their explicit owner action", async () => {
  const f = fixture({ props: { preedit: "ni", candidates: ["你", "尼"], onDictation: () => f.calls.push(["dictate"]) } }); await f.settle(); assert.deepEqual(f.calls, []); assert.equal(f.find("app-keyboard-preedit").props.children, "ni");
  for (const id of ["app-key-q", "app-key-shift", "app-key-language", "app-keyboard-candidate-0", "app-key-space", "app-key-return", "app-keyboard-dictation", "app-keyboard-done"]) f.press(id);
  assert.deepEqual(f.calls, [["text", "q"], ["shift"], ["mode", "zh-CN"], ["candidate", "你"], ["space"], ["enter"], ["dictate"], ["done"]]);
  f.calls.length = 0; f.render({ shift: true, mode: "zh-TW" }); assert.ok(f.find("app-key-Q")); f.press("app-key-Q"); f.press("app-key-language"); f.longPress("app-key-language"); assert.deepEqual(f.calls, [["text", "Q"], ["mode", "en"], ["system"]]); f.unmount();
  const traditional = fixture({ locale: "zh-TW" }); traditional.press("app-key-language"); assert.deepEqual(traditional.calls, [["mode", "zh-TW"]]); traditional.unmount();
});

test("symbols pages stay controlled, and email/url punctuation use the original text owner without opening files", () => {
  const f = fixture({ props: { mode: "symbols" } }); f.press("app-key-1"); f.press("app-key-shift"); f.render(); assert.ok(f.find("app-key-[")); f.press("app-key-["); f.press("app-key-symbols"); assert.deepEqual(f.calls, [["text", "1"], ["text", "["], ["mode", "en"]]); f.unmount();
  for (const [layout, value] of [["email", "@"], ["url", "/"]]) { const f = fixture({ props: { layout } }); f.press("app-key-at-or-slash"); assert.deepEqual(f.calls, [["text", value]]); f.unmount(); }
});

test("numeric/decimal/phone grids expose correct punctuation and cannot switch into emoji while secure text also suppresses it", () => {
  for (const [layout, extra] of [["numeric", null], ["decimal", "."], ["phone", "+"]]) {
    const f = fixture({ props: { layout, mode: "emoji" } }); assert.ok(f.find("app-keyboard-number-keys")); assert.equal(f.find("app-keyboard-emoji").props.disabled, true); f.press("app-keyboard-emoji"); assert.deepEqual(f.calls, []);
    f.press("app-key-1"); f.press("app-key-0"); if (extra) f.press("app-key-" + extra); else f.press("app-key-system"); f.press("app-key-return"); assert.deepEqual(f.calls, [["text", "1"], ["text", "0"], extra ? ["text", extra] : ["system"], ["enter"]]); f.unmount();
  }
  const secure = fixture({ props: { secure: true, layout: "password", mode: "emoji" } }); assert.equal(secure.find("app-keyboard-emoji").props.disabled, true); assert.equal(secure.find("app-keyboard-emoji-0-0"), undefined); assert.equal(secure.find("app-keyboard-dictation"), undefined); secure.press("app-keyboard-emoji"); secure.press("app-keyboard-done"); assert.deepEqual(secure.calls, [["done"]]); secure.unmount();
});

test("emoji search owns only its local query, uses Search to filter, and does not mutate the active draft", () => {
  const f = fixture({ props: { mode: "emoji", candidates: ["should-not-select"] } }); f.press("app-keyboard-emoji-search"); f.render();
  for (const value of "smile") f.press("app-key-" + value); f.render(); assert.equal(f.find("app-keyboard-preedit").props.children, "smile"); assert.equal(f.find("app-keyboard-candidate-0"), undefined); assert.deepEqual(f.calls, []);
  f.press("app-key-backspace"); f.render(); assert.equal(f.find("app-keyboard-preedit").props.children, "smil"); f.press("app-key-e"); f.press("app-key-return"); f.render(); assert.ok(f.find("app-keyboard-emoji-search")); assert.deepEqual(f.calls, []);
  const results = f.all().filter(node => node.props?.testID?.startsWith("app-keyboard-emoji-") && node.props?.accessibilityRole === "keyboardkey"); assert.ok(results.length > 0); assert.ok(results.every(node => !node.props.accessibilityLabel.startsWith("Sticker"))); f.press(results[0].props.testID); assert.deepEqual(f.calls, [["text", results[0].props.accessibilityLabel]]); f.unmount();
});

test("five original image stickers preview non-destructively in a text-only field; explicit attachment owner alone receives an ID", () => {
  const expected = [[293, 313, "d4efa5802cbfb4c78bff50ef9904782e1e4740ad5ac620ed19c69466766b8008"], [278, 317, "20de6771b0a614be71c67515122e918a4e49dc825959b5d6dde54a85420a43a5"], [298, 320, "2222657189f8ce06f5f2c4c511e88d9a5d788d2ee2ed60941765e157a6e23e6d"], [243, 313, "2d84535a71d99183ed4ce453f1e0dd1d2678ea369f3f72506731ff0effe154d1"], [308, 300, "d60dae0eb92950f885bad1b89355fb1d7f8a9ea3da5d1485c9eb7e809dd49832"]];
  const f = fixture({ props: { mode: "emoji" } }); const stickerKeys = () => f.all().filter(node => /^Sticker [1-5]$/.test(node.props?.accessibilityLabel ?? "")); assert.equal(stickerKeys().length, 5);
  for (const key of stickerKeys()) {
    const id = Number(key.props.accessibilityLabel.slice(-1)); f.press(key.props.testID); f.render(); const preview = f.find("app-keyboard-sticker-preview"), image = walk(preview).find(node => node.type === "Image"); assert.ok(f.all().some(node => node.type === "Modal" && node.props.visible && walk(node).includes(preview))); assert.equal(image.props.source, f.exports.KEYBOARD_STICKERS[id]); assert.deepEqual(f.calls, []); f.press("app-keyboard-sticker-preview"); f.render(); assert.equal(f.all().some(node => node.type === "Modal" && node.props.visible), false);
    const bytes = readFileSync(f.exports.KEYBOARD_STICKERS[id].replace("@/", "")); assert.ok(bytes.length > 0); assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], expected[id - 1].slice(0, 2)); assert.equal(createHash("sha256").update(bytes).digest("hex"), expected[id - 1][2]);
  }
  f.render({ onSticker: id => f.calls.push(["sticker", id]) }); for (const key of stickerKeys()) f.press(key.props.testID); f.render(); assert.deepEqual(f.calls, [1, 2, 3, 4, 5].map(id => ["sticker", id])); assert.equal(f.all().some(node => node.type === "Modal" && node.props.visible), false); f.unmount();
});

test("sticker preview and notices each own their web portal focus marker, while native uses a normal View", () => {
  for (const os of ["web", "ios"]) for (const destination of ["preview", "notices"]) {
    const f = fixture({ os, props: { mode: "emoji" } });
    if (destination === "preview") f.press(f.all().find(node => node.props?.accessibilityLabel === "Sticker 1").props.testID); else f.longPress("app-keyboard-done");
    f.render(); const shown = f.all().filter(node => node.type === "Modal" && node.props.visible); assert.equal(shown.length, 1); const modal = shown[0], portal = modal.props.children;
    assert.equal(portal.type, os === "web" ? "div" : "View"); assert.equal(portal.props["data-nuri-keyboard-host"], os === "web" ? "keyboard-portal" : undefined); assert.equal(flatten(portal.props.style).flex, 1);
    assert.equal(f.find("app-keyboard").props["data-nuri-keyboard-host"], undefined, "Only the owned Modal roots get a portal marker, not arbitrary body content");
    if (destination === "preview") assert.ok(walk(portal).some(node => node.props?.testID === "app-keyboard-sticker-preview")); else assert.ok(walk(portal).some(node => node.props?.accessibilityLabel === "Close notices"));
    assert.deepEqual(f.calls, []); modal.props.onRequestClose(); f.render(); assert.equal(f.all().some(node => node.type === "Modal" && node.props.visible), false); assert.deepEqual(f.calls, []); f.unmount();
  }
});

test("held delete repeats only until release/unmount, and optional notices never invoke Done or draft callbacks", () => {
  const f = fixture(); f.press("app-key-backspace"); f.longPress("app-key-backspace"); assert.equal(f.intervalCount, 1); f.repeat(); f.release("app-key-backspace"); assert.equal(f.intervalCount, 0); f.repeat(); assert.deepEqual(f.calls, [["backspace"], ["backspace"]]);
  f.find("app-keyboard-done").props.onAccessibilityAction({ nativeEvent: { actionName: "unknown" } }); f.render(); assert.equal(f.all().some(node => node.type === "Modal" && node.props.visible), false);
  f.find("app-keyboard-done").props.onAccessibilityAction({ nativeEvent: { actionName: "notices" } }); f.render(); assert.equal(f.all().filter(node => node.type === "Modal" && node.props.visible).length, 1); assert.deepEqual(f.calls, [["backspace"], ["backspace"]]); f.longPress("app-key-backspace"); f.unmount(); assert.equal(f.intervalCount, 0); assert.equal(f.listenerCount, 0);
});

test("a held delete retains its original handler lease when a later render supplies a different field callback", () => {
  const attempts = [], f = fixture({ props: { onBackspace: () => attempts.push("old-field") } });
  f.longPress("app-key-backspace"); assert.equal(f.intervalCount, 1); f.render({ onBackspace: () => attempts.push("new-field") }); f.repeat();
  assert.deepEqual(attempts, ["old-field"], "The interval must retain the old callback; the controller can reject that obsolete lease instead of deleting from the new field");
  f.release("app-key-backspace"); f.repeat(); assert.deepEqual(attempts, ["old-field"]); f.press("app-key-backspace"); assert.deepEqual(attempts, ["old-field", "new-field"]);
  f.longPress("app-key-backspace"); f.unmount(); assert.equal(f.intervalCount, 0); f.repeat(); assert.deepEqual(attempts, ["old-field", "new-field"]);
});

test("panel has no file-picker entry or implicit permission/network/storage/import behavior", () => {
  const f = fixture(); const controls = f.all().filter(node => node.props?.accessibilityRole === "button" || node.props?.accessibilityRole === "keyboardkey"); assert.ok(controls.length > 30); assert.ok(controls.every(node => !/file picker|browse files|选择文件|浏览文件|打开文件|上传文件/i.test(node.props.accessibilityLabel ?? ""))); assert.deepEqual(f.calls, []);
  assert.doesNotMatch(read(sourcePath), /(?:from\s*["']|require\(["'])(?:expo-image-picker|expo-document-picker|[^"']*(?:\/api|\/storage|\/auth))/); assert.doesNotMatch(read(sourcePath), /\bfetch\s*\(|request(?:Camera|MediaLibrary|Recording)Permissions|\bLinking\./); f.unmount();
});
