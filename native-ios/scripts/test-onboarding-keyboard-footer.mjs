import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { translate } from './i18n-test-utils.mjs';

// Actual route, footer hook/wrapper, keyboard frame, account hooks and form
// fields. React scheduling/native hosts/events/services are isolated. These
// are component/layout-state contracts, NOT UIKit/physical-keyboard pixels.
const jsx = (type, props, key) => ({ type, props, key });
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const tick = () => new Promise(resolve => setImmediate(resolve));
class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [2026, 10, 7, 12])); } }
function load(file, deps = {}, globals = {}) {
  const module = { exports: {} }, code = ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('require', 'module', 'exports', 'Date', ...Object.keys(globals), code)(name => {
    if (name.startsWith('@/assets/')) return 'fixture-asset';
    assert.ok(Object.hasOwn(deps, name), file + ': unexpected dependency ' + name); return deps[name];
  }, module, module.exports, FixtureDate, ...Object.values(globals));
  return module.exports;
}
function keyboardFixture({ visible = false, frame = visible ? { height: 300, screenY: 544 } : undefined } = {}) {
  const subscriptions = new Map(), retired = [], calls = [];
  let snapshot = visible, metrics = frame, subscribeRace = false;
  return {
    subscriptions, retired, calls,
    api: {
      isVisible: () => snapshot, metrics: () => metrics, dismiss: () => calls.push('dismiss'),
      addListener(name, callback) {
        if (!subscriptions.has(name)) subscriptions.set(name, new Set());
        subscriptions.get(name).add(callback);
        if (subscribeRace) { subscribeRace = false; snapshot = true; metrics = { height: 300, screenY: 544 }; }
        return { remove() { subscriptions.get(name).delete(callback); retired.push(callback); } };
      },
    },
    emit(name, next = { height: 300, screenY: 544 }) {
      if (name === 'keyboardDidHide') { snapshot = false; metrics = undefined; }
      else if (name === 'keyboardDidShow' || name === 'keyboardDidChangeFrame') { snapshot = next.height > 0 && next.screenY < 844; metrics = next; }
      const event = { endCoordinates: { ...next, screenX: 0, width: 390 }, duration: 250, easing: 'keyboard' };
      for (const callback of [...(subscriptions.get(name) ?? [])]) callback(event);
    },
    close() { snapshot = false; metrics = undefined; },
    raceOnSubscribe() { subscribeRace = true; },
    count: () => [...subscriptions.values()].reduce((n, listeners) => n + listeners.size, 0),
  };
}

function fixture({ keyboard = keyboardFixture(), locale = 'en', os = 'ios', kids = [], account = 'account-A' } = {}) {
  const owners = new Map(), hosts = new Map(), calls = [], routes = [], raf = new Map(), scrolls = [];
  const appStateListeners = new Set(), retiredAppState = [];
  let owner, tree, dirty = false, mounted = true, customVisible = false, generation = 1, token = 'fixture-A', serial = 0, staleUpdates = 0;
  const effect = (callback, deps) => {
    const current = owner, index = current.cursor++;
    if (!same(current.effects[index]?.deps, deps)) current.pending.push(() => {
      current.effects[index]?.cleanup?.(); current.effects[index] = { deps, cleanup: callback() };
    });
  };
  const react = {
    forwardRef: fn => fn,
    useRef(initial) { return owner.slots[owner.cursor++] ??= { current: initial }; },
    useState(initial) {
      const current = owner, index = current.cursor++;
      const slot = current.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      slot.set ??= value => {
        if (!mounted || !owners.has(current.key)) { staleUpdates++; return; }
        const next = typeof value === 'function' ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
      };
      return [slot.value, slot.set];
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useMemo(fn, deps) { const index = owner.cursor++; if (!same(owner.slots[index]?.deps, deps)) owner.slots[index] = { value: fn(), deps }; return owner.slots[index].value; },
    useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore(_subscribe, getSnapshot) { owner.cursor++; return getSnapshot(); },
  };
  const native = {
    ...Object.fromEntries(['View', 'Text', 'Pressable', 'ScrollView', 'KeyboardAvoidingView', 'ActivityIndicator', 'Switch'].map(name => [name, name])),
    TextInput: 'TextInput', Keyboard: keyboard.api, Platform: { OS: os }, Dimensions: { get: () => ({ height: 844, width: 390 }) },
    AppState: { addEventListener(name, callback) { assert.equal(name, 'change'); appStateListeners.add(callback); return { remove() { appStateListeners.delete(callback); retiredAppState.push(callback); } }; } },
    StyleSheet: { create: value => value, absoluteFill: {}, flatten: value => Object.assign({}, ...[value].flat(Infinity).filter(Boolean)) },
    AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
  };
  const theme = { night: false, ink: 'ink', secondary: 'secondary', composer: 'composer', outline: 'outline', keyboard: { appearance: 'light' }, token: () => 'color' };
  const i18n = { useT: () => ({ locale, t: (key, vars) => translate(locale, key, vars) }), translate };
  const router = { replace: path => routes.push(path) }, recover = async () => {};
  const auth = { getSessionGeneration: () => generation, subscribeSessionBoundary: () => () => {}, getToken: async () => token,
    setOnboarded: async (...args) => { calls.push(['onboarded', ...args]); return true; } };
  const scoped = load('src/useAccountState.ts', { react, './api': { auth } });
  const common = { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': native, '@/src/i18n': i18n };
  const primitives = load('src/uiux48/Primitives.tsx', { ...common,
    '@/src/keyboard/AppKeyboard': { NuriTextInput: 'TextInput' }, 'expo-image': { Image: 'Image' }, 'expo-blur': { BlurView: 'BlurView' },
    'expo-router': { useRouter: () => router }, './Theme': { useNuriTheme: () => theme },
    './materials': { GLASS_BLUR48: {}, GLASS_SHADOW48: {} }, './inputLayout': { singleLineInputStyle: {}, multilineInputStyle: {} },
    './GlassLighting': { GlassLighting: 'GlassLighting' },
    '@/src/uiux49/spec': { TYPE49: { Body: {}, H1: {}, H2: {}, H3: {}, Caption: {} } }, '@/src/uiuxfinal/ButtonMaterial': { ButtonBackdrop: 'ButtonBackdrop' } });
  const routePrimitives = { ...primitives, NuriButton: 'NuriButton', NuriText: 'NuriText', NuriIcon: 'NuriIcon', NuriField: 'TextInput' };
  const footer = load('src/uiuxfinal/OnboardingKeyboardFooter.tsx', { ...common, '@/src/keyboard/AppKeyboard': { useAppKeyboardVisible: () => customVisible } });
  const dates = load('src/child-age.ts'), children = load('src/onboardingChildren.ts', { './child-age': dates });
  const model = load('src/onboardingInlineDate.ts', { './child-age': dates });
  const simplified = load('src/simplifiedOnboarding.ts', { './onboardingChildren': children, './onboardingInlineDate': model, './child-age': dates });
  const form = load('src/uiuxfinal/OnboardingForm.tsx', { ...common, '@/src/uiux48/Primitives': routePrimitives,
    '@/src/uiux48/Theme': { useNuriTheme: () => theme }, 'expo-image': { Image: 'Image' }, './InlineChildDate': { InlineChildDate: 'InlineChildDate' } });
  const api = { me: async () => { calls.push(['me']); return { id: account, nickname: 'Fixture parent', city: '' }; },
    listChildren: async () => { calls.push(['children']); return structuredClone(kids); },
    updateMe: async body => { calls.push(['profile', body]); return { onboarding_completed: true }; },
    addChild: async body => { calls.push(['create', body]); return { ...body, id: 'created-fixture' }; },
    updateChild: async (id, body) => { calls.push(['child', id, body]); return { ...body, id }; },
    deleteChild: async id => { calls.push(['delete', id]); return { ok: true }; } };
  const Screen = load('app/onboarding.tsx', { ...common, 'expo-router': { useRouter: () => router, useFocusEffect: fn => react.useEffect(fn, [fn]) },
    '@/src/useAccountState': scoped, '@/src/api': { api, auth, isAuthError: () => false }, '@/src/authExpiredRecovery': { ExpiredSessionRecoveryNotice: 'Recovery', useExpiredSessionRecovery: () => ({ blocked: false, recover }) },
    '@/src/components/nativeNavigation': { registerNativeNavigationGuard: () => () => {} }, '@/src/components/ConfirmDialog': { default: 'ConfirmDialog', __esModule: true },
    '@/src/uiux48/Primitives': routePrimitives, '@/src/uiux48/Theme': { useNuriTheme: () => theme }, '@/src/onboardingChildren': children, '@/src/simplifiedOnboarding': simplified,
    '@/src/onboardingParentGender': { readParentGender: async () => 'hidden', saveParentGender: async () => {} },
    '@/src/uiuxfinal/OnboardingForm': form, '@/src/uiuxfinal/OnboardingKeyboardFooter': footer },
    { requestAnimationFrame: fn => { const id = ++serial; raf.set(id, fn); return id; }, cancelAnimationFrame: id => raf.delete(id) });
  function render() {
    assert.ok(mounted); let passes = 0;
    do {
      dirty = false; const seen = new Set(), pending = [];
      function expand(node, path) {
        if (!node || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}:${child?.key ?? i}`));
        const key = `${path}:${node.key ?? ''}`;
        if (typeof node.type === 'function') {
          let current = owners.get(key);
          if (!current || current.type !== node.type) { current?.effects.forEach(item => item?.cleanup?.()); current = { key, type: node.type, cursor: 0, slots: [], effects: [], pending: [] }; owners.set(key, current); }
          seen.add(key); current.cursor = 0; owner = current;
          const child = node.type(node.props); pending.push(...current.pending.splice(0));
          return expand(child, key + ':child');
        }
        const host = hosts.get(key) ?? { key, scrollTo: value => scrolls.push(value), measureInWindow: callback => callback(0, 62, 390, 748) };
        hosts.set(key, host); if (node.props.ref) node.props.ref.current = host;
        return { ...node, host, props: { ...node.props, children: expand(node.props.children, key + ':children') } };
      }
      tree = expand(jsx(Screen.default, {}), 'root');
      for (const [key, current] of owners) if (!seen.has(key)) { current.effects.forEach(item => item?.cleanup?.()); owners.delete(key); }
      pending.forEach(fn => fn()); assert.ok(++passes < 20, 'render/effect loop');
    } while (dirty);
    return tree;
  }
  const walk = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(walk) : [node, ...walk(node.props?.children)];
  const find = id => walk(tree).find(node => node.props?.testID === id);
  const ancestors = target => { const search = (node, path = []) => { if (!node || typeof node !== 'object') return null; if (Array.isArray(node)) { for (const child of node) { const hit = search(child, path); if (hit) return hit; } return null; } if (node === target) return path; return search(node.props?.children, [...path, node]); }; return search(tree); };
  return { keyboard, calls, routes, scrolls, render, find, walk: () => walk(tree), ancestors, appStateListeners, retiredAppState,
    async ready() { render(); for (let i = 0; i < 6; i++) { await tick(); render(); } assert.ok(find('onboarding-parent-name')); },
    press(id) { const node = find(id); assert.ok(node, id); assert.notEqual(node.props.disabled, true, id); node.props.onPress(); render(); },
    type(id, value) { const node = find(id); assert.ok(node, id); const identity = node.host; node.props.onChangeText(value); render(); assert.equal(find(id).host, identity, 'typing must not remount field'); },
    emit(name, frame) { keyboard.emit(name, frame); render(); }, custom(value) { customVisible = value; render(); },
    appState(state) { for (const callback of appStateListeners) callback(state); render(); },
    flushRaf() { const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(fn => fn()); render(); },
    unmount() { for (const current of owners.values()) current.effects.forEach(item => item?.cleanup?.()); owners.clear(); mounted = false; },
    staleUpdates: () => staleUpdates, ownerChange() { generation++; token = 'fixture-B'; render(); } };
}

function assertFooter(f, hidden, label) {
  const slot = f.find('onboarding-static-footer'), footer = f.find('onboarding-fixed-footer'), button = f.find('onboarding-next-btn');
  assert.ok(slot && footer && button); assert.equal(slot.props.style.flexShrink, 0); assert.equal(slot.props.style.opacity, hidden ? 0 : 1);
  assert.equal(slot.props.pointerEvents, hidden ? 'none' : 'auto'); assert.equal(slot.props.accessibilityElementsHidden, hidden);
  assert.equal(slot.props.importantForAccessibility, hidden ? 'no-hide-descendants' : 'auto'); assert.equal(button.props.disabled, hidden); assert.equal(button.props.style.width, 200);
  if (label) assert.equal(button.props.label, label);
  assert.ok(!f.ancestors(footer).some(node => node.type === 'KeyboardAvoidingView'), 'footer must not be lifted by KAV padding');
  assert.equal(footer.props.style.paddingHorizontal, 24); assert.equal(footer.props.style.paddingTop, 16); assert.equal(footer.props.style.paddingBottom, 8);
  assert.ok(!('display' in slot.props.style) && !('height' in slot.props.style), 'hide keeps original footer slot, without display:none or keyboard-height offsets');
  const scroll = f.find('onboarding-scroll'); assert.ok(f.ancestors(scroll).some(node => node.type === 'KeyboardAvoidingView'));
  assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled'); assert.equal(scroll.props.keyboardDismissMode, 'on-drag'); assert.equal(scroll.props.style.flex, 1); assert.equal(scroll.props.removeClippedSubviews, false);
}
const child = { id: 'kid', nickname: 'Fixture child', birth_date: '2010-05-06', gender: 'other', allergies: [], notes: '' };

test('parent Continue stays outside the actual KAV and hides through keyboard dismissal without losing typed fields', async () => {
  const f = fixture(); await f.ready(); assertFooter(f, false, 'Continue'); const host = f.find('onboarding-parent-name').host;
  assert.equal(f.find('onboarding-parent-name').props.style.borderWidth, 0, 'the approved outer input rim must not gain a second inherited main-field border');
  assert.equal(f.find('onboarding-parent-name').props.style.textAlign, 'auto');
  f.emit('keyboardWillShow'); assertFooter(f, true, 'Continue'); f.type('onboarding-parent-name', 'Typed parent'); f.emit('keyboardDidShow'); assert.equal(f.find('onboarding-parent-name').host, host); assert.equal(f.find('onboarding-parent-name').props.value, 'Typed parent');
  f.emit('keyboardWillHide'); assertFooter(f, true, 'Continue'); f.emit('keyboardWillChangeFrame', { height: 300, screenY: 844 }); assertFooter(f, true, 'Continue');
  f.emit('keyboardDidHide'); assertFooter(f, false, 'Continue'); assert.equal(f.find('onboarding-parent-name').props.value, 'Typed parent'); assert.deepEqual(f.calls.filter(call => !['me', 'children'].includes(call[0])), []);
});
test('child Continue and new-card auto-scroll/clearance survive repeated focus and keyboard dismissal', async () => {
  const f = fixture(); await f.ready(); f.press('onboarding-next-btn'); const first = f.walk().find(node => node.type === 'TextInput' && node.props.testID?.startsWith('onboarding-child-name-'));
  f.type(first.props.testID, 'Child draft'); for (let i = 0; i < 3; i++) { f.emit('keyboardWillShow'); assertFooter(f, true, 'Continue'); f.emit('keyboardDidHide'); assertFooter(f, false, 'Continue'); }
  f.emit('keyboardWillShow'); f.press('onboarding-add-another'); assert.ok(f.keyboard.calls.includes('dismiss')); assertFooter(f, true, 'Continue'); assert.equal(f.find(first.props.testID).props.value, 'Child draft');
  const layout = f.walk().filter(node => node.props?.onLayout && node.props.children?.props?.testID?.startsWith('onboarding-child-card-')).at(-1); assert.ok(layout); layout.props.onLayout({ nativeEvent: { layout: { y: 480 } } }); f.flushRaf(); assert.deepEqual(f.scrolls.at(-1), { y: 472, animated: true });
  const clearance = f.find('onboarding-add-clearance'); assert.equal(clearance.props.style.overflow, 'visible'); assert.equal(clearance.props.style.paddingBottom, 12); f.emit('keyboardDidHide'); assertFooter(f, false, 'Continue');
});
test('review-edit Save and review Confirm never remain actionable above a keyboard; cancelling retains the committed child', async () => {
  const f = fixture({ kids: [child] }); await f.ready(); f.press('onboarding-next-btn'); f.press('onboarding-next-btn'); assertFooter(f, false, 'Confirm');
  f.press('onboarding-edit-kid'); assertFooter(f, false, 'Save'); f.emit('keyboardWillShow'); f.type('onboarding-child-name-kid', 'Discard review draft'); assertFooter(f, true, 'Save');
  f.press('onboarding-skip'); assertFooter(f, true, 'Confirm'); assert.ok(f.walk().some(node => node.props?.children === 'Fixture child')); f.emit('keyboardDidHide'); assertFooter(f, false, 'Confirm'); assert.deepEqual(f.calls.filter(call => !['me', 'children'].includes(call[0])), []);
});
test('keyboard snapshots hide on the first mount, and subscribing resyncs a keyboard that appeared during mount', async () => {
  for (const mode of ['visible', 'subscribe-race']) { const keyboard = keyboardFixture({ visible: mode === 'visible' }); if (mode === 'subscribe-race') keyboard.raceOnSubscribe(); const f = fixture({ keyboard }); await f.ready(); assertFooter(f, true, 'Continue'); f.emit('keyboardDidHide'); assertFooter(f, false, 'Continue'); f.unmount(); assert.equal(keyboard.count(), 0); }
});
test('hardware focus, zero-height and wholly offscreen frames keep the footer visible; final frame can recover without DidHide', async () => {
  const f = fixture(); await f.ready(); f.type('onboarding-parent-name', 'Hardware typing'); assertFooter(f, false, 'Continue');
  f.emit('keyboardWillShow', { height: 0, screenY: 844 }); assertFooter(f, false); f.emit('keyboardDidShow', { height: 300, screenY: 900 }); assertFooter(f, false);
  f.emit('keyboardDidShow'); assertFooter(f, true); f.emit('keyboardDidChangeFrame', { height: 0, screenY: 844 }); assertFooter(f, false); assert.equal(f.find('onboarding-parent-name').props.value, 'Hardware typing');
});
test('custom-preview and native visibility are ORed, so hiding either one alone cannot expose the CTA', async () => {
  const f = fixture({ os: 'web' }); await f.ready(); f.custom(true); assertFooter(f, true); f.emit('keyboardDidShow'); f.custom(false); assertFooter(f, true); f.custom(true); f.emit('keyboardDidHide'); assertFooter(f, true); f.custom(false); assertFooter(f, false);
});
test('unmount removes every listener; retired callbacks cannot update a newly mounted account or trigger a save', async () => {
  const keyboard = keyboardFixture(), a = fixture({ keyboard }); await a.ready(); a.emit('keyboardWillShow'); assert.equal(keyboard.count(), 5); a.unmount(); assert.equal(keyboard.count(), 0); keyboard.close();
  const b = fixture({ keyboard, account: 'account-B' }); await b.ready(); assertFooter(b, false); for (const callback of keyboard.retired) callback({ endCoordinates: { height: 300, screenY: 544 } }); b.render(); assertFooter(b, false); assert.equal(a.staleUpdates(), 0); assert.deepEqual(b.calls.filter(call => !['me', 'children'].includes(call[0])), []); b.unmount(); assert.equal(keyboard.count(), 0);
});
test('layout-only open/close and repeated focus never reload account APIs or duplicate keyboard subscriptions', async () => {
  const f = fixture(); await f.ready(); const reads = f.calls.length; for (let i = 0; i < 5; i++) { f.emit('keyboardWillShow'); f.type('onboarding-parent-name', 'Retained ' + i); f.emit('keyboardDidHide'); }
  assert.equal(f.keyboard.count(), 5); assert.equal(f.calls.length, reads); assert.equal(f.find('onboarding-parent-name').props.value, 'Retained 4'); assert.deepEqual(f.routes, []);
});
test('foreground resyncs a closed snapshot after a missing hide event, without showing during ordinary WillHide', async () => {
  const f = fixture(); await f.ready(); f.emit('keyboardWillShow'); f.emit('keyboardWillHide'); assertFooter(f, true); f.appState('background'); f.keyboard.close(); assertFooter(f, true);
  f.appState('active'); assertFooter(f, false); assert.equal(f.appStateListeners.size, 1); f.emit('keyboardDidShow'); f.appState('active'); assertFooter(f, true);
  const callbacks = [...f.appStateListeners]; f.unmount(); assert.equal(f.appStateListeners.size, 0); for (const callback of callbacks) callback('active'); assert.equal(f.staleUpdates(), 0);
});
