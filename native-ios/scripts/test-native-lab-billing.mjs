import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/billing.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const plans = [{ interval: "month", currency: "usd", unit_amount: 1200 }, { interval: "year", currency: "usd", unit_amount: 12000 }];
const member = { entitled: true, enabled: true, plans, has_customer: true, subscription: { interval: "year", status: "active", cancel_at_period_end: false, current_period_end: "2030-01-01T00:00:00Z" } };
const nonmember = { ...member, entitled: false, subscription: null };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ platform = "ios", locale = "en", purchaseAllowed = true, inShell = true, status = nonmember, checkout, loadFailure = false } = {}) {
  const states = [];
  const refs = [];
  const focus = [];
  const effects = [];
  const checkoutCalls = [];
  const portalCalls = [];
  const links = [];
  let stateCursor = 0;
  let refCursor = 0;
  let statusCalls = 0;
  let returned;
  const platformValue = { OS: platform };
  const dependencies = {
    "react": {
      useState: (initial) => { const index = stateCursor++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
      useRef: (initial) => { const index = refCursor++; if (!(index in refs)) refs[index] = { current: initial }; return refs[index]; },
      useCallback: (callback) => callback,
      useEffect: (callback) => effects.push(callback),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", ActivityIndicator: "ActivityIndicator", Platform: platformValue, Linking: { openURL: (url) => links.push(url) }, StyleSheet: { create: (styles) => styles }, useWindowDimensions: () => ({ width: 402 }) },
    "@/src/components/NativeSafeAreaView": { SafeAreaView: "SafeAreaView" },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "expo-router": { useRouter: () => ({ canGoBack: () => false, replace: () => {} }), useLocalSearchParams: () => ({ checkout }), useFocusEffect: (callback) => focus.push(callback) },
    "@/src/api": { apiErrorDetail: () => "", api: {
      billingStatus: async () => { statusCalls++; if (loadFailure) throw new Error("offline"); return status; },
      billingCheckout: async (...args) => { checkoutCalls.push(args); return { url: "https://checkout.invalid/fixture" }; },
      billingPortal: async (...args) => { portalCalls.push(args); return { url: "https://portal.invalid/fixture" }; },
    } },
    "@/src/i18n": { useT: () => ({ locale, t: (key) => key }) },
    "@/src/nativeShell": { isNativeShell: () => inShell, usePurchaseAllowed: () => purchaseAllowed, useOnReturnToApp: (callback) => { returned = callback; } },
    "@/src/theme": { colors: {}, radius: {}, spacing: {}, type: {} },
  };
  const hookModule = { exports: {} };
  const hookCode = ts.transpileModule(readFileSync(new URL("../src/useAccountState.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "module", "exports", hookCode)((name) => name === "react" ? dependencies.react : { auth: { getSessionGeneration: () => 0, subscribeSessionBoundary: () => () => {} } }, hookModule, hookModule.exports);
  dependencies["@/src/useAccountState"] = hookModule.exports;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => { assert.ok(name in dependencies, "unexpected dependency " + name); return dependencies[name]; }, loaded, loaded.exports);
  function expand(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === "function") return expand(node.type(node.props));
    const children = node.props?.children;
    return { ...node, props: { ...node.props, children: Array.isArray(children) ? children.map(expand) : expand(children) } };
  }
  const render = () => { stateCursor = refCursor = 0; focus.length = effects.length = 0; return expand(loaded.exports.default()); };
  const find = (node, id) => {
    if (!node || typeof node !== "object") return null;
    if (node.props?.testID === id) return node;
    for (const child of Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]) { const result = find(child, id); if (result) return result; }
    return null;
  };
  const text = (node) => typeof node === "string" ? node : node && typeof node === "object" ? (Array.isArray(node.props?.children) ? node.props.children.flat(Infinity) : [node.props?.children]).map(text).join(" ") : "";
  const mount = async () => { render(); for (const callback of [...focus, ...effects]) callback(); await tick(); return render(); };
  return { mount, render, find, text, returned: () => returned(), checkoutCalls, portalCalls, links, statusCalls: () => statusCalls, platformValue };
}

for (const purchaseAllowed of [true, false]) {
  test("iOS nonmember is read-only even when purchaseAllowed=" + purchaseAllowed, async () => {
    const f = fixture({ purchaseAllowed });
    const tree = await f.mount();
    assert.equal(f.statusCalls(), 1);
    assert.ok(f.find(tree, "billing-native-lab-read-only"));
    for (const interval of ["month", "year"]) {
      const button = f.find(tree, "billing-subscribe-" + interval);
      assert.equal(button.props.disabled, true);
      // Call the real component callback despite disabled UI to prove hard gate.
      await button.props.onPress();
    }
    const history = f.find(tree, "billing-history-btn");
    assert.equal(history.props.disabled, true);
    await history.props.onPress();
    assert.deepEqual(f.checkoutCalls, []);
    assert.deepEqual(f.portalCalls, []);
    assert.deepEqual(f.links, []);
    assert.equal(f.find(tree, "billing-external-notice"), null);
  });
}

test("iOS membership status remains visible without storefront capability", async () => {
  const f = fixture({ purchaseAllowed: false, status: member });
  const tree = await f.mount();
  assert.ok(f.find(tree, "billing-member-card"));
  assert.equal(f.find(tree, "billing-shell-notice"), null);
  const manage = f.find(tree, "billing-manage-btn");
  assert.equal(manage.props.disabled, true);
  await manage.props.onPress();
  f.returned();
  await tick();
  assert.equal(f.statusCalls(), 2, "foreground return should still refresh read-only membership");
  assert.deepEqual(f.portalCalls, []);
  assert.deepEqual(f.links, []);
});

test("iOS entitlement without a subscription row still displays membership", async () => {
  const f = fixture({ purchaseAllowed: false, status: { ...member, subscription: null } });
  assert.ok(f.find(await f.mount(), "billing-member-card"));
});

for (const [locale, expected] of [["zh-CN", "仅供查看会员状态"], ["zh-TW", "僅供查看會員狀態"], ["en", "membership status only"]]) {
  test("read-only explanation follows locale " + locale, async () => {
    const f = fixture({ locale });
    assert.ok(f.text(f.find(await f.mount(), "billing-native-lab-read-only")).includes(expected));
  });
}

test("iOS checkout query does not claim payment success or start polling", async () => {
  const f = fixture({ checkout: "success" });
  const tree = await f.mount();
  assert.equal(f.statusCalls(), 1);
  assert.equal(f.find(tree, "billing-banner-success"), null);
  assert.deepEqual(f.checkoutCalls, []);
});

test("iOS read-only page still surfaces status loading errors", async () => {
  const f = fixture({ purchaseAllowed: false, loadFailure: true });
  assert.ok(f.find(await f.mount(), "billing-load-failed"));
});

test("web checkout and portal behavior remains enabled", async () => {
  const f = fixture({ platform: "web", inShell: false });
  const tree = await f.mount();
  assert.equal(f.find(tree, "billing-native-lab-read-only"), null);
  const subscribe = f.find(tree, "billing-subscribe-month");
  assert.equal(subscribe.props.disabled, false);
  await subscribe.props.onPress();
  await f.find(tree, "billing-history-btn").props.onPress();
  assert.deepEqual(f.checkoutCalls, [["month", "web"]]);
  assert.deepEqual(f.portalCalls, [["web"]]);
});

test("callback guard checks iOS directly rather than only disabled render state", async () => {
  const f = fixture({ platform: "web", inShell: false });
  const tree = await f.mount();
  f.platformValue.OS = "ios";
  await f.find(tree, "billing-subscribe-month").props.onPress();
  await f.find(tree, "billing-history-btn").props.onPress();
  assert.deepEqual(f.checkoutCalls, []);
  assert.deepEqual(f.portalCalls, []);
  assert.deepEqual(f.links, []);
});
