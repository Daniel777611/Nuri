import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { en, zhTW, translate } from './i18n-test-utils.mjs';

// Actual production source and dictionaries, isolated React/device/storage.
// No account, locale setting, network, or persistence outside this fixture.
function load(path, deps = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('require', 'module', 'exports', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', js)(name => {
    if (name.startsWith('@/assets/')) return 'fixture-asset';
    assert.ok(name in deps, 'unexpected dependency ' + name); return deps[name];
  }, module, module.exports, callback => { callback(); return 1; }, () => {}, (callback, delay) => {
    const timer = setTimeout(callback, delay); if (delay > 60_000) timer.unref(); return timer;
  });
  return module.exports;
}
const jsx = (type, props, key) => ({ type, props, key });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function hooks() {
  let cursor = 0, tree, live = true, staleUpdates = 0;
  const slots = [], effects = [], pending = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const state = initial => {
    const index = cursor++;
    slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    slots[index].set ??= value => { if (!live) staleUpdates++; slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; };
    return [slots[index].value, slots[index].set];
  };
  const react = {
    createContext: value => ({ value, Provider: 'Provider' }), useContext: context => context.value,
    useState: state, useRef: initial => { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback: (fn, deps) => { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: fn, deps }; return slots[index].value; },
    useMemo: (fn, deps) => { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useEffect: (fn, deps) => { const index = cursor++; if (!same(effects[index]?.deps, deps)) pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: fn() }; }); },
  };
  return { react, state, render(Component, props = {}) { cursor = 0; tree = Component(props); pending.splice(0).forEach(fn => fn()); return tree; },
    unmount() { live = false; for (const effect of effects) effect?.cleanup?.(); }, staleUpdates: () => staleUpdates };
}
function languageFixture({ phone = 'en-US', saved = {}, settingsThrows = false } = {}) {
  const h = hooks(), values = new Map(Object.entries(saved)), writes = [], listeners = new Set(), watches = new Map();
  let device = phone, failKey, throwKey, readGate, writeGate, removeCount = 0;
  const storage = {
    getItem: async (key, fallback) => { const value = values.has(key) ? values.get(key) : fallback; if (readGate) await readGate.promise; return value; },
    setItem: async (key, value) => { writes.push([key, value]); if (writeGate) await writeGate.promise; if (key === throwKey) throw Error('fixture storage unavailable'); if (key === failKey) return false; values.set(key, value); return true; },
  };
  const deps = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, './en': { en }, './zh-TW': { zhTW }, '@/src/utils/storage': { storage },
    'react-native': { Platform: { OS: 'ios' }, Settings: { get: key => { if (settingsThrows) throw Error('fixture unavailable'); return key === 'AppleLanguages' ? (device === undefined ? undefined : [device]) : device; },
      watchKeys: (keys, callback) => { assert.deepEqual(keys, ['AppleLanguages', 'AppleLocale']); const id = watches.size; watches.set(id, callback); return id; }, clearWatch: id => watches.delete(id) },
      AppState: { currentState: 'active', addEventListener: (_event, callback) => { listeners.add(callback); return { remove: () => { listeners.delete(callback); removeCount++; } }; } } } };
  const actual = load('src/i18n/index.tsx', deps);
  const value = () => h.render(actual.I18nProvider, { children: null }).props.value;
  return { actual, values, writes, value, setPhone: next => { device = next; }, event: state => { for (const callback of [...listeners]) callback(state); },
    async ready() { value(); await tick(); return value(); }, async settle() { await tick(); return value(); },
    fail: key => { failKey = key; }, failThrow: key => { throwKey = key; }, recover: () => { failKey = undefined; throwKey = undefined; }, blockReads: () => readGate = deferred(), unblockReads: () => { const gate = readGate; readGate = undefined; gate?.resolve(); },
    blockWrites: () => writeGate = deferred(), unblockWrites: () => { const gate = writeGate; writeGate = undefined; gate?.resolve(); },
    settingsUpdated: () => { for (const callback of watches.values()) callback(); }, watches: () => watches.size,
    unmount: h.unmount, staleUpdates: h.staleUpdates, removals: () => removeCount, listeners: () => listeners.size };
}

test('device language mapping supports English and both Chinese scripts; unsupported languages fall back to English only', () => {
  const f = languageFixture();
  for (const value of ['en', 'en-US', 'en_GB', 'fr-FR', 'es-ES', 'it-IT', 'ja-JP', 'ko-KR', 'unknown', '', null, undefined]) assert.equal(f.actual.normalizeDeviceLocale(value), 'en', String(value));
  for (const value of ['zh', 'zh-Hans', 'zh-CN', 'zh_Hans_CN', 'zh-SG']) assert.equal(f.actual.normalizeDeviceLocale(value), 'zh-CN', value);
  for (const value of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-HK', 'zh_HK']) assert.equal(f.actual.normalizeDeviceLocale(value), 'zh-TW', value);
  // Backend/profile normalization remains compatible; it is not the device fallback.
  assert.equal(f.actual.normalizeLocale('fr-FR'), 'zh-CN');
});
for (const [phone, expected] of [['en-US', 'en'], ['zh-Hans-CN', 'zh-CN'], ['zh-Hant-TW', 'zh-TW'], ['fr-FR', 'en'], ['es-ES', 'en'], ['it-IT', 'en'], ['ja-JP', 'en'], ['ko-KR', 'en'], ['unknown', 'en']]) {
  test(`new device ${phone} starts in ${expected}, follows the phone, and does not persist an inferred preference`, async () => {
    const f = languageFixture({ phone });
    assert.equal(f.value().locale, expected, 'first render must not flash a hard-coded Simplified default');
    assert.equal((await f.ready()).languageMode, 'system'); assert.equal(f.value().locale, expected);
    await f.value().setLocale('zh-CN'); assert.equal(f.value().locale, expected, 'account hydration cannot select a language');
    assert.deepEqual(f.writes, []); assert.equal(f.values.has('ui_language_mode'), false);
  });
}
for (const cache of ['zh-CN', 'zh-TW', 'en']) {
  test(`legacy cache-only ${cache} is preserved verbatim but is not evidence of an explicit language choice`, async () => {
    const f = languageFixture({ phone: 'en-US', saved: { ui_language: cache } });
    assert.equal((await f.ready()).languageMode, 'system'); assert.equal(f.value().locale, 'en');
    f.setPhone('zh-Hant-HK'); f.event('active'); assert.equal(f.value().locale, 'zh-TW');
    await f.value().setLocale(cache); assert.equal(f.value().locale, 'zh-TW');
    assert.equal(f.values.get('ui_language'), cache); assert.equal(f.values.has('ui_language_mode'), false); assert.deepEqual(f.writes, []);
  });
}
test('automatic language changes only on active, survives storage failure, and removes its listener on unmount', async () => {
  const f = languageFixture({ phone: 'en-US', saved: { ui_language_mode: 'system', ui_language: 'en' } }); await f.ready();
  f.fail('ui_language'); f.setPhone('zh-CN'); f.event('background'); assert.equal(f.value().locale, 'en');
  f.event('active'); assert.equal(f.value().locale, 'zh-CN'); f.setPhone('zh-Hant'); f.event('active'); assert.equal(f.value().locale, 'zh-TW');
  f.setPhone('ko-KR'); f.event('active'); assert.equal(f.value().locale, 'en'); assert.deepEqual(f.writes, []);
  assert.equal(f.listeners(), 1); assert.equal(f.watches(), 1); f.unmount(); assert.equal(f.listeners(), 0); assert.equal(f.watches(), 0); assert.equal(f.removals(), 1);
  f.setPhone('zh-CN'); f.event('active'); await tick(); assert.equal(f.staleUpdates(), 0);
});
test('a native Settings cache update delivered after active refreshes automatic language, but not background or explicit mode', async () => {
  const f = languageFixture({ phone: 'en-US' }); await f.ready(); f.event('background'); f.event('active');
  f.setPhone('zh-Hant'); f.settingsUpdated(); assert.equal(f.value().locale, 'zh-TW');
  f.event('background'); f.setPhone('zh-CN'); f.settingsUpdated(); assert.equal(f.value().locale, 'zh-TW'); f.event('active'); assert.equal(f.value().locale, 'zh-CN');
  await f.value().chooseLanguage('en'); f.setPhone('zh-Hant'); f.settingsUpdated(); assert.equal(f.value().locale, 'en');
  f.unmount(); f.settingsUpdated(); assert.equal(f.staleUpdates(), 0);
});
for (const chosen of ['en', 'zh-CN', 'zh-TW']) {
  test(`explicit ${chosen} mode overrides conflicting cache, phone, and account hydration`, async () => {
    const f = languageFixture({ phone: 'zh-Hant', saved: { ui_language_mode: chosen, ui_language: chosen === 'en' ? 'zh-CN' : 'en' } });
    assert.equal((await f.ready()).locale, chosen); assert.equal(f.value().languageMode, chosen);
    f.setPhone('fr-FR'); f.event('active'); await f.value().setLocale(chosen === 'en' ? 'zh-CN' : 'en');
    assert.equal(f.value().locale, chosen); assert.equal(f.value().languageMode, chosen); assert.deepEqual(f.writes, []);
  });
}
test('explicit choices persist only as choices; choosing system resumes live phone language and survives a fresh provider', async () => {
  const f = languageFixture({ phone: 'zh-CN' }); await f.ready();
  assert.equal(await f.value().chooseLanguage('en'), 'en'); assert.equal(f.value().languageMode, 'en'); assert.equal(f.values.get('ui_language_mode'), 'en');
  f.setPhone('zh-Hant'); f.event('active'); assert.equal(f.value().locale, 'en');
  assert.equal(await f.value().chooseLanguage('system'), 'zh-TW'); assert.equal(f.value().languageMode, 'system');
  f.setPhone('ja-JP'); f.event('active'); assert.equal(f.value().locale, 'en');
  const next = languageFixture({ phone: 'zh-Hans', saved: Object.fromEntries(f.values) }); assert.equal((await next.ready()).locale, 'zh-CN'); assert.equal(next.value().languageMode, 'system');
});
for (const failKey of ['ui_language', 'ui_language_mode']) {
  test(`failed ${failKey} save cannot publish a successful user choice and can be retried`, async () => {
    const f = languageFixture({ phone: 'en-US' }); await f.ready(); f.fail(failKey);
    await assert.rejects(f.value().chooseLanguage('zh-TW'), /LOCAL_LANGUAGE_SAVE_FAILED/); assert.equal(f.value().locale, 'en'); assert.equal(f.value().languageMode, 'system');
    assert.equal(f.values.has('ui_language_mode'), false); f.recover(); assert.equal(await f.value().chooseLanguage('zh-TW'), 'zh-TW'); assert.equal(f.value().locale, 'zh-TW');
  });
}
test('a delayed initial read or account hydration cannot overwrite a later explicit choice', async () => {
  const f = languageFixture({ phone: 'en-US', saved: { ui_language_mode: 'zh-CN' } }); f.blockReads(); f.value();
  const hydration = f.value().setLocale('zh-CN'); await tick();
  const selection = f.value().chooseLanguage('zh-TW'); f.unblockReads(); await hydration; await selection; await f.settle();
  assert.equal(f.value().locale, 'zh-TW'); assert.equal(f.value().languageMode, 'zh-TW'); assert.equal(f.values.get('ui_language_mode'), 'zh-TW');
});
test('rapid choices serialize storage and only the latest choice publishes; selecting system uses the phone at completion', async () => {
  const f = languageFixture({ phone: 'en-US' }); await f.ready(); f.blockWrites();
  const first = f.value().chooseLanguage('zh-CN'); const firstFailure = assert.rejects(first, /LANGUAGE_SELECTION_SUPERSEDED/); await tick();
  const latest = f.value().chooseLanguage('system'); f.setPhone('zh-Hant'); f.unblockWrites(); await firstFailure; assert.equal(await latest, 'zh-TW');
  assert.equal(f.value().locale, 'zh-TW'); assert.equal(f.values.get('ui_language_mode'), 'system');
});
test('unmount prevents pending initialization, hydration, and language-choice callbacks from updating React', async () => {
  const f = languageFixture({ phone: 'en-US' }); f.blockReads(); f.value(); const hydration = f.value().setLocale('zh-CN'); await tick();
  f.unmount(); f.unblockReads(); await hydration; await tick(); assert.equal(f.staleUpdates(), 0);
  const g = languageFixture(); await g.ready(); g.blockWrites(); const choice = g.value().chooseLanguage('zh-TW'); const failure = assert.rejects(choice, /LANGUAGE_SELECTION_SUPERSEDED/); await tick();
  g.unmount(); g.unblockWrites(); await failure; assert.equal(g.staleUpdates(), 0); assert.equal(g.values.has('ui_language_mode'), false);
});
test('unreadable device settings safely fall back to English without creating a preference', async () => {
  const f = languageFixture({ settingsThrows: true }); assert.equal((await f.ready()).locale, 'en'); assert.deepEqual(f.writes, []);
});
test('invalid stored modes do not become explicit preferences, and unsupported explicit choices cannot save a guessed locale', async () => {
  for (const mode of ['fr-FR', 'zh-Hant', 'garbage', '', null]) {
    const f = languageFixture({ phone: 'zh-HK', saved: { ui_language_mode: mode, ui_language: 'zh-CN' } });
    assert.equal((await f.ready()).languageMode, 'system'); assert.equal(f.value().locale, 'zh-TW');
    await assert.rejects(f.value().chooseLanguage('fr-FR'), /UNSUPPORTED_LANGUAGE_SELECTION/); assert.deepEqual(f.writes, []); assert.equal(f.values.get('ui_language_mode'), mode);
  }
});
test('thrown preference storage errors retain the last confirmed mode and do not poison subsequent choices', async () => {
  const f = languageFixture({ phone: 'zh-Hant', saved: { ui_language_mode: 'en', ui_language: 'en' } }); await f.ready(); f.failThrow('ui_language_mode');
  await assert.rejects(f.value().chooseLanguage('zh-CN'), /fixture storage unavailable/); assert.equal(f.value().locale, 'en'); assert.equal(f.value().languageMode, 'en');
  const next = languageFixture({ phone: 'zh-Hant', saved: Object.fromEntries(f.values) }); assert.equal((await next.ready()).locale, 'en', 'a partially changed cache is not an explicit preference');
  f.recover(); await f.value().chooseLanguage('zh-CN'); assert.equal(f.value().locale, 'zh-CN');
});

const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const words = tree => nodes(tree).flatMap(node => {
  const text = node.props?.children;
  return [typeof text === 'string' ? text : null, node.props?.accessibilityLabel, node.props?.accessibilityValue?.text, node.props?.label, node.props?.title, node.props?.message, node.props?.confirmText].filter(value => typeof value === 'string');
});
const dates = load('src/child-age.ts');
const children = load('src/onboardingChildren.ts', { './child-age': dates });
const inlineModel = load('src/onboardingInlineDate.ts', { './child-age': dates });
const simplified = load('src/simplifiedOnboarding.ts', { './onboardingChildren': children, './child-age': dates, './onboardingInlineDate': inlineModel });
function localizedComponents(locale) {
  const instances = new Map();
  const react = new Proxy({}, { get: (_target, name) => (...args) => active.react[name](...args) });
  let active;
  const rn = { ...Object.fromEntries(['View', 'Pressable', 'ScrollView', 'Text'].map(name => [name, name])), Platform: { OS: 'ios' }, StyleSheet: { create: value => value },
    AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) } };
  const shared = { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': rn,
    '@/src/uiux48/Primitives': { NuriText: 'NuriText', NuriField: 'NuriField' }, '@/src/uiux48/Theme': { useNuriTheme: () => ({ ink: 'fixture', secondary: 'fixture', outline: 'fixture' }) },
    '@/src/i18n': { useT: () => ({ locale, t: (source, vars) => translate(locale, source, vars) }), translate }, '@/src/onboardingInlineDate': inlineModel, '@/src/child-age': dates };
  const inline = load('src/uiuxfinal/InlineChildDate.tsx', shared);
  const form = load('src/uiuxfinal/OnboardingForm.tsx', { ...shared, 'expo-image': { Image: 'Image' }, './InlineChildDate': inline });
  const expand = (node, path = 'root') => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((child, index) => expand(child, path + '/' + index));
    if (typeof node.type === 'function') {
      const key = path + ':' + node.type.name; if (!instances.has(key)) instances.set(key, hooks()); active = instances.get(key);
      return expand(active.render(node.type, node.props), key);
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children, path + '/' + (node.key ?? node.type)) } };
  };
  return { ...form, ...inline, render: (Component, props) => expand(jsx(Component, props)) };
}
function routeFixture({ locale = 'en', loadFails = false, existingChildren = [] } = {}) {
  const h = hooks(), calls = [], mutations = [], routes = [];
  let currentLocale = locale, tree, failure = loadFails, profileFailure = false;
  const capture = () => 1, current = ticket => ticket === 1, recover = async () => {};
  const api = { me: async () => { calls.push('me'); if (failure) throw Error('fixture offline'); return { id: 'fixture-account', nickname: 'Fixture caregiver', city: 'Fixture city' }; },
    listChildren: async () => { calls.push('children'); return structuredClone(existingChildren); }, updateMe: async body => { mutations.push(body); if (profileFailure) throw Error('fixture profile offline'); return { onboarding_completed: true }; },
    addChild: async () => { throw Error('fixture child response unavailable'); }, updateChild: async () => { throw Error('fixture child response unavailable'); }, deleteChild: async () => { throw Error('fixture deletion unavailable'); } };
  const deps = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { ...Object.fromEntries(['View', 'Pressable', 'ScrollView', 'ActivityIndicator'].map(name => [name, name])), Keyboard: { dismiss() {} }, StyleSheet: { create: value => value },
      AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) } },
    'expo-router': { useRouter: () => ({ replace: path => routes.push(path) }), useFocusEffect: callback => h.react.useEffect(callback, [callback]) },
    '@/src/useAccountState': { useAccountScope: () => ({ capture, current }), useAccountState: h.state },
    '@/src/api': { api, auth: { getToken: async () => 'fixture-token', setOnboarded: async () => true }, isAuthError: () => false },
    '@/src/authExpiredRecovery': { ExpiredSessionRecoveryNotice: 'ExpiredSessionRecoveryNotice', useExpiredSessionRecovery: () => ({ blocked: false, recover }) },
    '@/src/components/nativeNavigation': { registerNativeNavigationGuard: () => () => {} }, '@/src/components/ConfirmDialog': { default: 'ConfirmDialog', __esModule: true },
    '@/src/uiux48/Primitives': Object.fromEntries(['NuriButton', 'NuriIcon', 'NuriKeyboardFrame', 'NuriText'].map(name => [name, name])),
    '@/src/uiux48/Theme': { useNuriTheme: () => ({ ink: 'fixture', outline: 'fixture', composer: 'fixture' }) },
    '@/src/i18n': { useT: () => ({ locale: currentLocale, t: (source, vars) => translate(currentLocale, source, vars) }), translate },
    '@/src/onboardingChildren': children, '@/src/simplifiedOnboarding': simplified,
    '@/src/uiuxfinal/OnboardingKeyboardFooter': { OnboardingKeyboardFooter: 'OnboardingKeyboardFooter', useOnboardingKeyboardVisible: () => false },
    '@/src/onboardingParentGender': { readParentGender: async () => 'hidden', saveParentGender: async () => {} },
    '@/src/uiuxfinal/OnboardingForm': Object.fromEntries(['ChildProfileCard', 'ParentProfileCard', 'ChildReviewCard', 'OnboardingPrompt'].map(name => [name, name])) };
  const Component = load('app/onboarding.tsx', deps).default;
  const render = () => tree = h.render(Component), find = id => nodes(tree).find(node => node.props?.testID === id), kind = name => nodes(tree).filter(node => node.type === name);
  return { calls, mutations, routes, render, find, kind, text: () => words(tree), setProfileFailure: value => { profileFailure = value; }, setLoadFailure: value => { failure = value; },
    async settle() { for (let count = 0; count < 6; count++) { await tick(); render(); } }, setLocale(value) { currentLocale = value; render(); },
    press(id) { const node = find(id); assert.ok(node, 'missing ' + id); assert.notEqual(node.props.disabled, true); node.props.onPress(); render(); } };
}
const labels = {
  en: { parent: ['Parent profile', 'Name', 'Gender', 'Female', 'Male', 'Hidden', 'City (optional)', 'Gender is saved only on this device; you may keep it hidden.'],
    child: ['Child 2', 'Nickname', 'Gender (optional)', 'Boy', 'Girl', 'Not specified', 'Date of birth', 'Remove this child', 'Year', 'Month', 'Day', 'Scroll to confirm this incomplete date'], expecting: 'Expected child 2', due: 'Due date', edit: 'Edit Kid 中文',
    prompts: ['Your profile', 'Child profiles', 'Review profiles'], next: 'Continue', confirm: 'Confirm', skip: 'Skip', step: 'Step 1 of 2', validation: 'Enter your name, or skip this step.' },
  'zh-CN': { parent: ['家长资料', '称呼', '性别', '女', '男', '隐藏', '地址（可选）', '性别选择仅保存在本机，可选隐藏。'],
    child: ['已出生孩子 2', '昵称', '性别（可选）', '男孩', '女孩', '不选择', '出生日期', '移除此孩子', '年', '月', '日', '请滚动确认未完整的日期'], expecting: '未出生孩子 2', due: '预产期', edit: '编辑 Kid 中文',
    prompts: ['创建你的档案', '创建孩子档案', '确认孩子资料'], next: '继续', confirm: '确认', skip: '跳过', step: '步骤 1，共 2 步', validation: '请填写称呼，或跳过此步骤。' },
  'zh-TW': { parent: ['家長資料', '稱呼', '性別', '女', '男', '隱藏', '地址（選填）', '性別選擇僅儲存在本機，可選擇隱藏。'],
    child: ['已出生孩子 2', '暱稱', '性別（選填）', '男孩', '女孩', '不選擇', '出生日期', '移除此孩子', '年', '月', '日', '請捲動確認未完整的日期'], expecting: '未出生孩子 2', due: '預產期', edit: '編輯 Kid 中文',
    prompts: ['建立你的檔案', '建立孩子檔案', '確認孩子資料'], next: '繼續', confirm: '確認', skip: '跳過', step: '步驟 1，共 2 步', validation: '請填寫稱呼，或跳過此步驟。' },
};
for (const locale of ['en', 'zh-CN', 'zh-TW']) {
  test(`${locale}: actual parent, child, review and inline date UI translate labels, a11y, placeholders and user-name templates`, () => {
    const f = localizedComponents(locale), expected = labels[locale];
    const parent = f.render(f.ParentProfileCard, { value: { nickname: 'Parent 中文', city: 'City 原文', gender: 'hidden' }, onChange() {}, disabled: false });
    for (const value of expected.parent) assert.ok(words(parent).includes(value), value);
    assert.equal(nodes(parent).find(node => node.props?.testID === 'onboarding-parent-name').props.value, 'Parent 中文');
    assert.equal(nodes(parent).find(node => node.props?.testID === 'onboarding-city').props.value, 'City 原文');
    const row = { key: 'fixture', nickname: 'Kid 中文', birth_date: '', gender: 'other', allergies: [], notes: '', expecting: false, date_parts: { year: null, month: null, day: null } };
    const child = f.render(f.ChildProfileCard, { row, ordinal: 2, onChange() {}, onRemove() {}, disabled: false });
    for (const value of expected.child) assert.ok(words(child).includes(value), value);
    for (const wheel of nodes(child).filter(node => node.props?.accessibilityRole === 'adjustable')) {
      assert.match(wheel.props.accessibilityValue.text, /^\d+$/);
      assert.ok(!nodes(wheel).some(node => node.props?.children === '—'));
    }
    const unborn = f.render(f.ChildProfileCard, { row: { ...row, expecting: true }, ordinal: 2, onChange() {}, onRemove() {}, disabled: false });
    for (const value of [expected.expecting, expected.due]) assert.ok(words(unborn).includes(value), value);
    const review = f.render(f.ChildReviewCard, { row: { ...row, birth_date: '2010-05-06' }, onEdit() {}, disabled: false });
    for (const value of ['Kid 中文', '2010-05-06', expected.edit]) assert.ok(words(review).includes(value), value);
  });
  test(`${locale}: actual route translates every step, visible skip, progress, validation, load/save errors and recovery actions`, async () => {
    const f = routeFixture({ locale }); f.render(); await f.settle();
    assert.equal(f.kind('OnboardingPrompt')[0].props.label, labels[locale].prompts[0]); assert.ok(f.text().includes(labels[locale].step));
    assert.ok(words(f.find('onboarding-skip')).includes(labels[locale].skip)); assert.equal(f.find('onboarding-next-btn').props.label, labels[locale].next);
    const parent = f.kind('ParentProfileCard')[0]; parent.props.onChange({ ...parent.props.value, nickname: '' }); f.render(); f.press('onboarding-next-btn');
    assert.ok(words(f.find('onboarding-error')).includes(labels[locale].validation));
    f.press('onboarding-skip'); assert.equal(f.kind('OnboardingPrompt')[0].props.label, labels[locale].prompts[1]);
    for (const key of ['已出生', '未出生', '添加已出生孩子']) assert.ok(f.text().includes(translate(locale, key)), key);
    f.press('onboarding-expecting'); assert.ok(f.text().includes(translate(locale, '添加未出生孩子'))); f.press('onboarding-skip');
    assert.equal(f.kind('OnboardingPrompt')[0].props.label, labels[locale].prompts[2]); assert.equal(f.find('onboarding-next-btn').props.label, labels[locale].confirm);
    assert.ok(f.text().includes(translate(locale, '暂未添加孩子，之后可在设置中补充。')));
    f.setProfileFailure(true); f.press('onboarding-next-btn'); await f.settle();
    assert.ok(words(f.find('onboarding-error')).includes(translate(locale, '保存失败，这次资料尚未完整写入。请检查网络后重试。')));
    assert.equal(f.find('onboarding-reconcile-children').props.label, children.onboardingChildCopy(locale).refresh);
    const failed = routeFixture({ locale, loadFails: true }); failed.render(); await failed.settle();
    assert.ok(words(failed.find('onboarding-error')).includes(translate(locale, '家庭资料加载失败，请检查网络并刷新后重试。')));
    assert.equal(failed.find('onboarding-reload').props.label, children.onboardingChildCopy(locale).reload);
  });
  test(`${locale}: actual incomplete-child and review-edit errors and confirmed-delete dialog retain localized wording`, async () => {
    const f = routeFixture({ locale }); f.render(); await f.settle(); f.press('onboarding-next-btn');
    const child = f.kind('ChildProfileCard')[0]; child.props.onChange({ ...child.props.row, nickname: 'Fixture child', birth_date: '', date_parts: { year: 2010, month: null, day: 6 } }); f.render(); f.press('onboarding-next-btn');
    assert.ok(words(f.find('onboarding-error')).includes(translate(locale, '请补全孩子昵称和有效日期，或移除未填写的卡片。')));
    const incomplete = f.kind('ChildProfileCard')[0]; incomplete.props.onChange({ ...incomplete.props.row, birth_date: '2010-05-06', date_parts: { year: 2010, month: 5, day: 6 } }); f.render(); f.press('onboarding-next-btn');
    f.kind('ChildReviewCard')[0].props.onEdit(); f.render(); const editor = f.kind('ChildProfileCard')[0]; editor.props.onChange({ ...editor.props.row, birth_date: '', date_parts: { year: null, month: null, day: null } }); f.render(); f.press('onboarding-next-btn');
    assert.ok(words(f.find('onboarding-error')).includes(translate(locale, '请填写昵称并选择有效日期。')));
    const row = { id: 'fixture-child', nickname: 'Saved child', birth_date: '2010-05-06', gender: 'other', allergies: [], notes: '' }, saved = routeFixture({ locale, existingChildren: [row] }); saved.render(); await saved.settle(); saved.press('onboarding-next-btn');
    saved.kind('ChildProfileCard')[0].props.onRemove(); saved.render(); const dialog = saved.kind('ConfirmDialog')[0], copy = children.onboardingChildCopy(locale);
    assert.equal(dialog.props.visible, true); assert.equal(dialog.props.title, copy.deleteTitle); assert.equal(dialog.props.message, copy.deleteBody); assert.equal(dialog.props.confirmText, copy.deleteConfirm);
    dialog.props.onConfirm(); await saved.settle(); assert.ok(words(saved.find('onboarding-error')).includes(copy.deleteFailed));
    const pending = routeFixture({ locale }); pending.render(); await pending.settle(); pending.press('onboarding-next-btn'); const newChild = pending.kind('ChildProfileCard')[0];
    newChild.props.onChange({ ...newChild.props.row, nickname: 'Unconfirmed fixture child', birth_date: '2010-05-06', date_parts: { year: 2010, month: 5, day: 6 } }); pending.render(); pending.press('onboarding-next-btn'); pending.press('onboarding-next-btn'); await pending.settle();
    assert.ok(words(pending.find('onboarding-error')).includes(copy.unconfirmed)); assert.deepEqual(pending.routes, [], 'an unconfirmed save is never reported as completed setup');
  });
}
test('changing runtime locale on the current onboarding route translates immediately without reloading APIs or losing parent/partial child drafts', async () => {
  const f = routeFixture({ locale: 'en' }); f.render(); await f.settle(); const calls = [...f.calls];
  f.kind('ParentProfileCard')[0].props.onChange({ nickname: 'Unsaved 中文 parent', city: 'Uncommitted city', gender: 'female' }); f.render();
  f.setLocale('zh-TW'); await f.settle(); assert.deepEqual(f.calls, calls); assert.equal(f.kind('ParentProfileCard')[0].props.value.nickname, 'Unsaved 中文 parent');
  assert.equal(f.kind('OnboardingPrompt')[0].props.label, labels['zh-TW'].prompts[0]); f.press('onboarding-next-btn');
  const card = f.kind('ChildProfileCard')[0], partial = { ...card.props.row, nickname: 'Unsaved child 中文', date_parts: { year: 2010, month: null, day: 6 }, birth_date: '' };
  card.props.onChange(partial); f.render(); f.setLocale('zh-CN'); await f.settle();
  assert.deepEqual(f.calls, calls); assert.deepEqual(f.kind('ChildProfileCard')[0].props.row, partial); assert.equal(f.kind('OnboardingPrompt')[0].props.label, labels['zh-CN'].prompts[1]);
  f.setLocale('en'); await f.settle(); assert.deepEqual(f.calls, calls); assert.deepEqual(f.kind('ChildProfileCard')[0].props.row, partial); assert.deepEqual(f.mutations, []);
});
test('already-visible onboarding errors follow language changes without reloading or clearing the failed state', async () => {
  const f = routeFixture({ locale: 'en', loadFails: true }); f.render(); await f.settle(); const calls = [...f.calls];
  for (const locale of ['zh-TW', 'zh-CN', 'en']) { f.setLocale(locale); await f.settle(); assert.deepEqual(f.calls, calls); assert.ok(words(f.find('onboarding-error')).includes(translate(locale, '家庭资料加载失败，请检查网络并刷新后重试。'))); }
  const g = routeFixture({ locale: 'en' }); g.render(); await g.settle(); g.kind('ParentProfileCard')[0].props.onChange({ nickname: '', city: 'Unsaved 中文 city', gender: 'hidden' }); g.render(); g.press('onboarding-next-btn'); const loaded = [...g.calls];
  for (const locale of ['zh-TW', 'zh-CN', 'en']) { g.setLocale(locale); await g.settle(); assert.deepEqual(g.calls, loaded); assert.ok(words(g.find('onboarding-error')).includes(labels[locale].validation)); assert.equal(g.kind('ParentProfileCard')[0].props.value.city, 'Unsaved 中文 city'); }
});
test('onboarding wrapper keys are static, fully covered in en/zh-TW, and do not hide unlocalized JSX copy', () => {
  const failures = [];
  for (const path of ['app/onboarding.tsx', 'src/uiuxfinal/OnboardingForm.tsx', 'src/uiuxfinal/InlineChildDate.tsx']) {
    const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8'), ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text, argument = node.arguments[name === 'translate' ? 1 : 0];
        if (['cn', 'copy', 't', 'translate'].includes(name) && argument && ts.isStringLiteral(argument) && /\p{Script=Han}/u.test(argument.text)) {
          for (const [locale, dictionary] of [['en', en], ['zh-TW', zhTW]]) if (!Object.hasOwn(dictionary, argument.text)) failures.push(`${path}: ${locale} missing ${argument.text}`);
        }
        if (['cn', 'copy'].includes(name) && argument && ts.isTemplateExpression(argument)) failures.push(`${path}: dynamic translation key ${argument.getText(ast)}`);
      }
      if (ts.isJsxText(node) && node.text.trim() && /\p{Script=Han}|[A-Za-z]/u.test(node.text)) failures.push(`${path}: unlocalized JSX ${node.text.trim()}`);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert.deepEqual(failures, []);
});
