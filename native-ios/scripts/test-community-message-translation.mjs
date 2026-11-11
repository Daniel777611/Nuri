import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
function load(path, dependencies = {}, globals = {}) {
  const m = { exports: {} }, source = readFileSync(path, 'utf8');
  new Function('require', 'module', 'exports', ...Object.keys(globals), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText)(name => { if (name.startsWith('@/assets/')) return 'fixture-art'; assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency ' + name); return dependencies[name]; }, m, m.exports, ...Object.values(globals));
  return m.exports;
}
const helper = load('src/communityMessageTranslation.ts');
const VERSION = '2026-11-06.1', APP_VERSION = '2026-10-01.1', conversationId = 'conversation-fixture';
const grant = (purpose = 'translation', patch = {}) => ({ request_id: purpose + '-request', purpose, notice_version: VERSION, state: 'effective', effective: true, epoch: 0,
  version: 1, initiated_by: 'me', my_decision: 'allow', parent_decision: 'allow', effective_from_seq: 0, ...patch });
const participation = patch => ({ conversation_id: conversationId, epoch: 0, effective: true, notice_version: VERSION, requests: { conversation_notes: grant('conversation_notes'), translation: grant() }, ...patch });
const message = (id = 'm1', patch = {}) => ({ message_id: id, conversation_id: conversationId, seq: 1, sender: 'parent', text: 'Original words', media: [], state: 'saved', created_at: '', client_message_id: null, ...patch });
const translated = (m, language = 'en', patch = {}) => ({ message_id: m.message_id, original: { text: m.text, language: 'zh-CN' },
  translation: { id: 'translated-' + m.message_id, kind: 'translation', state: 'succeeded', text: 'Translated words', target_language: language, created_at: '' }, ...patch });
const scope = (ai = participation(), owner = 'account-A', language = 'en') => helper.communityTranslationScope(owner, conversationId, language, ai);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };

test('notes, stale epochs/notices, one-party approval and missing historical boundary never become translation consent', () => {
  assert.ok(scope());
  for (const patch of [{ purpose: 'conversation_notes' }, { state: 'pending' }, { effective: false }, { my_decision: 'pending' }, { parent_decision: 'decline' }, { epoch: 1 }, { notice_version: 'old' }, { effective_from_seq: undefined }, { effective_from_seq: -1 }]) {
    const ai = participation(); ai.requests.translation = grant('translation', patch); assert.equal(scope(ai), null, JSON.stringify(patch));
  }
  const notesOnly = participation(); notesOnly.requests.translation = null; assert.equal(scope(notesOnly), null);
  assert.equal(helper.communityTranslationScope('A', 'other', 'en', participation()), null); assert.equal(scope(participation(), '', 'en'), null);
  assert.equal(scope(participation(), 'A', 'fr'), null);
});

test('P29 and optional-purpose P25/P27 use the exact backend contract without changing old notes calls', async () => {
  const calls = [], c = load('src/communityApi.ts', { './api': { ApiError: Error, apiRequest: async (path, init, timeout) => { calls.push([path, init.method, init.body ? JSON.parse(init.body) : undefined, timeout]); return {}; } }, './aiConsent': { AI_CONSENT_VERSION: APP_VERSION } }).communityApi;
  await c.requestAI('c/1', VERSION, 'notes-key'); await c.requestAI('c/1', VERSION, 'translation-key', 'translation');
  await c.revokeAI('c/1'); await c.revokeAI('c/1', 'translation'); await c.translateMessage('m/1', 'zh-TW', 'tr-key');
  assert.equal(calls[0][2].purpose, 'conversation_notes'); assert.equal(calls[1][2].purpose, 'translation');
  assert.equal(calls[2][0], '/community/v1/conversations/c%2F1/ai-participation'); assert.equal(calls[3][0], '/community/v1/conversations/c%2F1/ai-participation?purpose=translation');
  assert.deepEqual(calls[4], ['/community/v1/messages/m%2F1/translations', 'POST', { target_language: 'zh-TW', ai_consent_version: APP_VERSION, client_request_id: 'tr-key' }, 30000]);
});

test('only incoming text after the granted boundary is translated once, sequentially, with originals retained', async () => {
  const list = [message('old', { seq: 1 }), message('incoming', { seq: 2 }), message('mine', { seq: 3, sender: 'me' }), message('photo', { seq: 4, text: '', media: [{ media_id: 'photo' }] }), message('wrong', { seq: 5, conversation_id: 'other' })];
  const calls = []; const controller = new helper.CommunityMessageTranslations(async (id, language, key) => { calls.push([id, language, key]); return translated(list.find(m => m.message_id === id), language); }, () => 'stable-logical-key');
  const ai = participation(); ai.requests.translation.effective_from_seq = 1; controller.configure(scope(ai), true);
  const before = structuredClone(list); await controller.queue(list, () => true, () => {}); await controller.queue(list, () => true, () => {});
  assert.deepEqual(calls, [['incoming', 'en', 'stable-logical-key']]); assert.equal(controller.text(list[1]), 'Translated words'); assert.deepEqual(list, before);
  controller.configure(scope(ai), false); assert.equal(controller.text(list[1]), null); controller.configure(scope(ai), true); assert.equal(controller.text(list[1]), 'Translated words');
});

test('failure is original-only and never retried by polling or preference/device gate toggles', async () => {
  let calls = 0; const controller = new helper.CommunityMessageTranslations(async () => { calls++; throw Error('fixture unavailable'); }, () => 'tr-key');
  const m = message(); controller.configure(scope(), true); await controller.queue([m], () => true, () => {});
  for (let n = 0; n < 5; n++) { controller.configure(scope(), false); controller.configure(scope(), true); await controller.queue([m], () => true, () => {}); }
  assert.equal(calls, 1); assert.equal(controller.text(m), null);
});

test('withdrawing while a historical queue is pending prevents every unsent model call and never replays the failed in-flight message', async () => {
  const hold = deferred(), list = [message('one'), message('two', { seq: 2 }), message('three', { seq: 3 })], calls = [];
  const controller = new helper.CommunityMessageTranslations(async (id, language) => { calls.push(id); if (id === 'one') await hold.promise; return translated(list.find(m => m.message_id === id), language); }, () => 'key');
  controller.configure(scope(), true); const work = controller.queue(list, () => true, () => {}); await tick(); assert.deepEqual(calls, ['one']);
  controller.configure(scope(), false); hold.resolve(); await work; assert.deepEqual(calls, ['one']); assert.equal(controller.text(list[0]), null);
  controller.configure(scope(), true); await controller.queue(list, () => true, () => {}); assert.deepEqual(calls, ['one', 'two', 'three']);
});

test('withdrawal/account/conversation/notice/language changes discard late results and clear old rendered translations', async () => {
  for (const boundary of ['withdraw', 'account', 'conversation', 'notice', 'language', 'owner-callback']) {
    const wait = deferred(), m = message(); let owns = true, changed = 0;
    const controller = new helper.CommunityMessageTranslations(async () => { await wait.promise; return translated(m); }, () => 'key'); controller.configure(scope(), true);
    const work = controller.queue([m], () => owns, () => changed++); await tick();
    if (boundary === 'withdraw') controller.configure(scope(), false);
    if (boundary === 'account') controller.configure(scope(participation(), 'account-B'), true);
    if (boundary === 'conversation') controller.clear();
    if (boundary === 'notice') { const ai = participation({ notice_version: 'new' }); ai.requests.translation.notice_version = 'new'; controller.configure(scope(ai), true); }
    if (boundary === 'language') controller.configure(scope(participation(), 'account-A', 'zh-TW'), true);
    if (boundary === 'owner-callback') owns = false;
    wait.resolve(); await work; assert.equal(controller.text(m), null, boundary); assert.equal(changed, 0, boundary);
  }
});

test('malformed, wrong-message, altered-original and wrong-target responses never replace the source', async () => {
  const m = message();
  for (const patch of [{ message_id: 'other' }, { original: { text: 'not the original' } }, { translation: { kind: 'translation', state: 'succeeded', text: 'wrong language', target_language: 'zh-TW' } }, { translation: { kind: 'translation', state: 'failed', text: 'not a result', target_language: 'en' } }]) {
    const controller = new helper.CommunityMessageTranslations(async () => translated(m, 'en', patch), () => 'key'); controller.configure(scope(), true); await controller.queue([m], () => true, () => assert.fail('No invalid translation may publish')); assert.equal(controller.text(m), null);
  }
});

test('all three explicit purpose notices include historical scope, provider and notes separation', () => {
  for (const [locale, required] of [['en', ['OpenAI', 'before consent', 'not recording or notes']], ['zh-CN', ['OpenAI', '同意之前的历史消息', '不是记录或整理许可']], ['zh-TW', ['OpenAI', '同意之前的歷史訊息', '不是記錄或整理許可']]]) {
    const copy = helper.communityTranslationCopy(locale); for (const term of required) assert.ok(copy.bodyTranslation.includes(term), locale + term);
    assert.ok(copy.closeWarning.length > 20); assert.ok(copy.allowTranslation !== copy.allowNotes);
  }
});

const jsx = (type, props, key) => ({ type, props, key });
const nodes = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
function uiFixture({ ai = participation(), preference = true, allowed = true, holdTranslation = null, transport = {} } = {}) {
  let cursor = 0, tree, live = true, generation = 1, locale = 'en', serial = 0, notificationId;
  const slots = [], effects = [], pending = [], intervals = new Map(), calls = [], params = [], focusLeases = new Set(), entries = new Map(), requestKeys = new Map();
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = { useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; slots[i].set ??= value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }; return [slots[i].value, slots[i].set]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; }, useReducer(reduce, arg, init) { const [value, set] = react.useState(() => init(arg)); return [value, event => set(old => reduce(old, event))]; },
    useMemo(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; }, useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (!same(effects[i]?.deps, deps)) pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); } };
  const local = { status: allowed ? 'allowed' : 'not_allowed', userId: 'account-A', session: 1, version: APP_VERSION };
  const list = [message(), message('mine', { sender: 'me', seq: 2, text: 'My original' })], conversation = { conversation_id: conversationId, parent: { parent_id: 'parent-A', display_name: 'Parent' }, allowed_actions: ['send_message'], relationship_state: 'connected' };
  const chats = new Map([[conversationId, { ai, list, conversation }]]);
  const apiRequest = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null; calls.push({ path, method: init.method ?? 'GET', body });
    const record = [...chats.values()].find(value => path.includes('/conversations/' + value.conversation.conversation_id + '/')) ?? chats.get(conversationId);
    if (path === '/community/v1/preferences') return { auto_translate_messages: preference, parent_message_notifications_enabled: true, profile_hidden: false, version: 1 };
    if (path === '/community/v1/conversations') return { conversation: [...chats.values()].find(value => value.conversation.parent.parent_id === body.target_parent_id).conversation };
    if (path.includes('/messages?')) return { items: structuredClone(record.list), conversation: record.conversation, next_cursor: null, has_more: false };
    if (path.endsWith('/ai-participation')) return structuredClone(record.ai);
    if (path.includes('/ai-participation?purpose=')) { if (transport.holdRevoke) await transport.holdRevoke.promise; if (transport.revokeError) throw transport.revokeError; record.ai.epoch++; record.ai.effective = false; record.ai.requests = { conversation_notes: null, translation: null }; return { effective: false }; }
    if (path.endsWith('/read-cursor')) return {};
    if (path.startsWith('/community/v1/me/notifications/') && path.endsWith('/read')) return {};
    if (path.endsWith('/translations')) { if (holdTranslation) await holdTranslation.promise; return translated([...chats.values()].flatMap(value => value.list).find(m => path.includes('/' + m.message_id + '/')), body.target_language); }
    if (path.endsWith('/ai-consent-requests')) {
      const cached = requestKeys.get(body.client_request_id); if (cached) return { request: structuredClone(cached), created: false };
      const existing = record.ai.requests[body.purpose]; if (existing && ['pending', 'effective'].includes(existing.state)) return { request: structuredClone(existing), created: false };
      const request = grant(body.purpose, { request_id: body.purpose + '-request-' + (++serial), state: transport.nextRequestState ?? 'pending', effective: false, parent_decision: transport.nextRequestState === 'declined' ? 'decline' : 'pending', epoch: record.ai.epoch, initiated_by: 'me' });
      transport.nextRequestState = undefined; record.ai.requests[body.purpose] = request; requestKeys.set(body.client_request_id, request);
      if (transport.failRequestOnce) { transport.failRequestOnce = false; throw Error('unknown response after server saved request'); }
      return { request: structuredClone(request), created: true };
    }
    if (path.endsWith('/my-decision')) { const owner = [...chats.values()].find(value => Object.values(value.ai.requests).some(r => r && path.includes('/' + r.request_id + '/'))), request = Object.values(owner.ai.requests).find(r => r && path.includes('/' + r.request_id + '/')); request.my_decision = body.decision; request.effective = body.decision === 'allow' && request.parent_decision === 'allow'; request.state = request.effective ? 'effective' : body.decision === 'decline' ? 'declined' : 'pending'; if (request.purpose === 'conversation_notes') owner.ai.effective = request.effective; return { request: structuredClone(request) }; }
    throw Error('Unapproved fixture call ' + path);
  };
  const client = load('src/communityApi.ts', { './api': { ApiError: Error, apiRequest }, './aiConsent': { AI_CONSENT_VERSION: APP_VERSION } });
  const model = load('src/uiuxfinal/communityModel.ts'), initialized = { ...model.createFinalCommunity('hub'), screen: 'chat', person: 'parent-A', personName: 'Parent' };
  const router = { setParams: value => { params.push(value); if (Object.hasOwn(value, 'notificationId')) notificationId = value.notificationId; }, push() {}, dismissTo() {} };
  const component = load('src/uiuxfinal/CommunityFinal.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { ...Object.fromEntries(['View', 'Text', 'Pressable', 'ScrollView', 'Modal', 'ActivityIndicator'].map(n => [n, n])), Platform: { OS: 'ios' }, StyleSheet: { create: x => x }, Keyboard: { dismiss() {} }, Animated: {}, Easing: {}, AccessibilityInfo: {} },
    'expo-image': { Image: 'Image' }, 'expo-blur': { BlurView: 'BlurView' }, 'expo-image-picker': {},
    'expo-router': { useLocalSearchParams: () => ({ notificationId }), usePathname: () => '/community', useRouter: () => router, useFocusEffect: fn => react.useEffect(() => { const lease = { fn, cleanup: fn() }; focusLeases.add(lease); return () => { focusLeases.delete(lease); lease.cleanup?.(); }; }, [fn]) },
    '@/src/i18n': { useT: () => ({ locale }), translate: (_locale, s) => s }, '@/src/keyboard/AppKeyboard': { NuriTextInput: 'Input', useAppKeyboardVisible: () => false },
    '@/src/api': { api: {}, aiConsent: { getState: () => ({ ...local }) }, apiErrorDetail: () => '', isAuthError: () => false }, '@/src/aiConsent': { AI_CONSENT_VERSION: APP_VERSION }, '@/src/useAIConsent': { useAIConsent: () => ({ state: { ...local } }) },
    '@/src/communityMessageTranslation': helper, '@/src/communityApi': client, '@/src/useAccountState': { useAccountScope: () => ({ generation, capture: () => live ? generation : null, current: ticket => live && ticket === generation }) },
    '@/src/components/nativeNavigation': { registerNativeNavigationGuard: () => () => {} }, '@/src/aiPermissionNavigation': { aiPermissionHref: () => '/ai-permission' },
    '@/src/uiux48/Primitives': { IconAction: 'IconAction', NuriKeyboardFrame: 'NuriKeyboardFrame' }, '@/src/uiux48/Composer': { NuriComposer: 'NuriComposer' }, '@/src/uiux48/VoiceInputBar': { VoiceInputBar: 'VoiceInputBar' },
    '@/src/chatImageInput': { ChatImageInputError: Error, pickWebChatImageFile() {}, prepareChatImage() {} }, '@/src/chatVoiceInput': { MAX_VOICE_SECONDS: 60, VoiceInputError: Error, isVoiceInputSupported: () => false, startVoiceRecording() {} },
    '@/src/uiux48/useComposerDock': { useComposerDockInset: () => 0 }, '@/src/uiux48/inputLayout': { singleLineInputStyle: {} },
    './Primitives': { ...Object.fromEntries(['FinalButton', 'FinalChatBubble', 'FinalDivider', 'FinalSurface', 'FinalText'].map(n => [n, n])), FINAL_COLOR: {} }, './ButtonMaterial': { ButtonBackdrop: 'Backdrop', FrostedPressable: 'Pressable' },
    './ParentChatHeader': { ParentChatAvatar: 'Avatar', ParentChatHeader: 'ParentChatHeader' }, './Settings': { SettingsPage: 'SettingsPage', SettingsRow: 'SettingsRow', SettingsButton: 'SettingsButton' },
    './CommunityProfileEditor': { CommunityProfileEditor: 'Editor', GENDER_TAGS: [] }, './CommunityReportSheet': { CommunityReportSheet: 'Report' },
    './communityModel': { ...model, createFinalCommunity: () => initialized }, './communityHubLayout': { communityHubTopPadding: () => 0, HUB_PAGINATION: {}, HUB_CARD_BOTTOM_GUTTER: 0, HUB_PAGER_GAP: 0 },
    '@/src/communityNotificationEntry': { loadCommunityNotificationEntry: async id => { assert.ok(entries.has(id)); return entries.get(id); } }, '@/src/communityImageSelection': { selectCommunityImage() {} },
  }, { setInterval: (fn, delay) => { const id = ++serial; intervals.set(id, { fn, delay }); return id; }, clearInterval: id => intervals.delete(id) }).default;
  const render = () => { cursor = 0; tree = component(); pending.splice(0).forEach(fn => fn()); return tree; }, find = id => nodes(tree).find(n => n.props?.testID === id);
  return { calls, local, ai, list, params, render, find, nodes: () => nodes(tree), translations: () => calls.filter(c => c.path.endsWith('/translations')),
    addChat(id = 'conversation-B', parentId = 'parent-B', nextAI = participation({ conversation_id: id })) { const record = { ai: nextAI, list: [message('B-message', { conversation_id: id, text: 'B original' })], conversation: { ...conversation, conversation_id: id, parent: { parent_id: parentId, display_name: parentId } } }; chats.set(id, record); return record; },
    navigateChat(id, parentId) { notificationId = 'fixture-navigation-' + (++serial); entries.set(notificationId, { conversation: { id, parentId }, events: [{ type: 'person', person: parentId, name: parentId, screen: 'chat' }] }); render(); },
    switchAccount() { generation++; local.userId = 'account-B'; local.session++; render(); },
    async settle() { for (let n = 0; n < 8; n++) { render(); await tick(); } render(); },
    poll() { for (const item of intervals.values()) if (item.delay === 8000) item.fn(); },
    blur() { for (const lease of focusLeases) { lease.cleanup?.(); lease.cleanup = undefined; } }, focus() { for (const lease of focusLeases) lease.cleanup = lease.fn(); },
    press(id) { const node = find(id); assert.ok(node, 'Missing ' + id); assert.notEqual(node.props.disabled, true, 'Disabled ' + id); node.props.onPress(); render(); },
    locale(value) { locale = value; render(); }, unmount() { live = false; effects.forEach(effect => effect?.cleanup?.()); },
  };
}

test('actual chat executes P29 only with all three gates and renders a labelled translation beside the unchanged original', async () => {
  const f = uiFixture(); try { await f.settle(); assert.equal(f.translations().length, 1); assert.equal(f.find('final-parent-original-1').props.children, 'Original words'); assert.ok(f.find('final-parent-translation-1')); assert.equal(f.find('final-parent-translation-2'), undefined);
    f.poll(); await f.settle(); f.poll(); await f.settle(); assert.equal(f.translations().length, 1); assert.equal(f.translations()[0].body.target_language, 'en'); assert.equal(f.translations()[0].body.ai_consent_version, APP_VERSION);
  } finally { f.unmount(); }
});

test('actual new-message polling translates only the new inbound text; language changes hide the old target before another render', async () => {
  const f = uiFixture(); try { await f.settle(); f.list.push(message('new-message', { seq: 3, text: 'New original' })); f.poll(); await f.settle();
    assert.equal(f.translations().length, 2); assert.equal(f.find('final-parent-original-3').props.children, 'New original'); assert.ok(f.find('final-parent-translation-3'));
    f.locale('zh-TW'); assert.equal(f.find('final-parent-translation-1'), undefined); await f.settle();
    assert.equal(f.translations().length, 4); assert.ok(f.translations().slice(2).every(call => call.body.target_language === 'zh-TW')); assert.equal(f.find('final-parent-original-1').props.children, 'Original words');
  } finally { f.unmount(); }
});

test('actual chat preference/device/translation-purpose gates fail closed, and merely opening a consent sheet sends no P25', async () => {
  for (const options of [{ preference: false }, { allowed: false }, { ai: participation({ requests: { conversation_notes: grant('conversation_notes'), translation: null } }) }]) {
    const f = uiFixture(options); try { await f.settle(); assert.equal(f.translations().length, 0); assert.ok(f.find('final-parent-original-1'));
      if (f.find('final-parent-translation-request')) { f.press('final-parent-translation-request'); assert.match(f.find('final-parent-consent-purpose').props.children, /not recording or notes/); assert.equal(f.calls.filter(c => c.path.endsWith('/ai-consent-requests')).length, 0); f.press('final-parent-consent-decline'); }
    } finally { f.unmount(); }
  }
});

test('actual explicit request uses translation purpose, not the effective notes grant; repeated tap cannot duplicate it', async () => {
  const f = uiFixture({ ai: participation({ requests: { conversation_notes: grant('conversation_notes'), translation: null } }) }); try {
    await f.settle(); f.press('final-parent-translation-request'); const agree = f.find('final-parent-consent-agree').props.onPress; agree(); agree(); await f.settle();
    const requests = f.calls.filter(c => c.path.endsWith('/ai-consent-requests')); assert.equal(requests.length, 1); assert.equal(requests[0].body.purpose, 'translation'); assert.equal(f.translations().length, 0); assert.equal(f.ai.requests.conversation_notes.effective, true);
  } finally { f.unmount(); }
});

test('actual incoming translation refusal addresses its own request and never becomes a notes decision or a polling prompt loop', async () => {
  const ai = participation(); ai.requests.translation = grant('translation', { initiated_by: 'parent', state: 'pending', effective: false, my_decision: 'pending' });
  const f = uiFixture({ ai }); try { await f.settle(); assert.match(f.find('final-parent-consent-purpose').props.children, /before consent/); f.press('final-parent-consent-decline'); await f.settle();
    const decisions = f.calls.filter(c => c.path.endsWith('/my-decision')); assert.equal(decisions.length, 1); assert.ok(decisions[0].path.includes('/translation-request/')); assert.equal(decisions[0].body.decision, 'decline'); assert.equal(f.translations().length, 0);
    f.poll(); await f.settle(); assert.equal(f.find('final-parent-consent-agree'), undefined); assert.equal(f.ai.requests.conversation_notes.effective, true);
  } finally { f.unmount(); }
});

test('actual local withdrawal/unmount discard an in-flight result and do not automatically retry a failed attempt', async () => {
  for (const boundary of ['withdraw', 'unmount']) { const hold = deferred(), f = uiFixture({ holdTranslation: hold }); await f.settle(); assert.equal(f.translations().length, 1);
    if (boundary === 'withdraw') { f.local.status = 'not_allowed'; f.render(); } else f.unmount(); hold.resolve();
    if (boundary === 'withdraw') { await f.settle(); assert.equal(f.find('final-parent-translation-1'), undefined); f.local.status = 'allowed'; await f.settle(); assert.equal(f.translations().length, 1); f.unmount(); }
    else await tick();
  }
});

test('actual purpose withdrawal hides cached translations, tells the epoch consequence and never resumes from notes consent', async () => {
  const f = uiFixture(); try { await f.settle(); assert.ok(f.find('final-parent-translation-1')); f.press('final-parent-translation-revoke'); await f.settle();
    assert.equal(f.find('final-parent-translation-1'), undefined); assert.ok(f.find('final-parent-original-1')); assert.equal(f.ai.epoch, 1);
    assert.ok(f.calls.some(c => c.path.endsWith('/ai-participation?purpose=translation'))); f.poll(); await f.settle(); assert.equal(f.translations().length, 1);
  } finally { f.unmount(); }
});

test('actual stale consent callback cannot decide a replacement epoch/request', async () => {
  const ai = participation(); ai.requests.translation = grant('translation', { initiated_by: 'parent', state: 'pending', effective: false, my_decision: 'pending' });
  const f = uiFixture({ ai }); try { await f.settle(); const old = f.find('final-parent-consent-agree').props.onPress;
    f.ai.epoch++; f.ai.requests.translation = grant('translation', { epoch: 1, request_id: 'replacement', initiated_by: 'parent', state: 'pending', effective: false, my_decision: 'pending' }); f.poll(); await f.settle();
    old(); await f.settle(); assert.equal(f.calls.filter(c => c.path.endsWith('/my-decision')).length, 0); assert.equal(f.find('final-parent-consent-agree').props.disabled, true);
  } finally { f.unmount(); }
});

test('actual blur and refocus cannot revive a prior consent-sheet action lease in the same conversation', async () => {
  const ai = participation(); ai.requests.translation = grant('translation', { initiated_by: 'parent', state: 'pending', effective: false, my_decision: 'pending' });
  const f = uiFixture({ ai }); try { await f.settle(); const old = f.find('final-parent-consent-agree').props.onPress;
    f.blur(); f.focus(); await f.settle(); old(); await f.settle();
    assert.equal(f.calls.filter(c => c.path.endsWith('/my-decision')).length, 0); assert.equal(f.find('final-parent-consent-agree').props.disabled, true);
  } finally { f.unmount(); }
});

const parentHeader = f => f.nodes().find(node => node.type === 'ParentChatHeader');
const requestCalls = f => f.calls.filter(call => call.path.endsWith('/ai-consent-requests'));
const revokeCalls = f => f.calls.filter(call => call.path.includes('/ai-participation?purpose='));
function openPurpose(f, purpose) {
  if (purpose === 'translation') f.press('final-parent-translation-request');
  else { parentHeader(f).props.onToggle(true); f.render(); }
  assert.ok(f.find('final-parent-consent-agree'), 'Explicit purpose sheet must be shown');
}

test('saved Stop translation and notes OFF callbacks cannot revoke another chat or revive after any ownership boundary', async () => {
  for (const boundary of ['chat', 'round-trip', 'blur', 'epoch', 'notice', 'account']) {
    const f = uiFixture(); try {
      await f.settle(); const oldStop = f.find('final-parent-translation-revoke').props.onPress, oldToggle = parentHeader(f).props.onToggle;
      const b = f.addChat();
      if (boundary === 'chat' || boundary === 'round-trip') { f.navigateChat(b.conversation.conversation_id, b.conversation.parent.parent_id); await f.settle(); }
      if (boundary === 'round-trip') { f.navigateChat(conversationId, 'parent-A'); await f.settle(); }
      if (boundary === 'blur') { f.blur(); f.focus(); await f.settle(); }
      if (boundary === 'epoch') { f.ai.epoch++; for (const request of Object.values(f.ai.requests)) request.epoch++; f.poll(); await f.settle(); }
      if (boundary === 'notice') { f.ai.notice_version = 'new-notice'; for (const request of Object.values(f.ai.requests)) request.notice_version = 'new-notice'; f.poll(); await f.settle(); }
      if (boundary === 'account') { f.switchAccount(); await f.settle(); }
      oldStop(); oldToggle(false); await f.settle(); assert.equal(revokeCalls(f).length, 0, boundary);
      assert.equal(f.find('final-community-notice'), undefined, boundary);
      if (boundary === 'chat') {
        assert.equal(f.find('final-parent-original-1').props.children, 'B original'); assert.ok(f.find('final-parent-translation-1'));
        f.press('final-parent-translation-revoke'); await f.settle(); assert.equal(revokeCalls(f).length, 1);
        assert.ok(revokeCalls(f)[0].path.includes('/conversation-B/')); assert.equal(f.ai.epoch, 0, 'A was not withdrawn by B’s current button');
      }
    } finally { f.unmount(); }
  }
});

test('in-flight withdrawal success or failure stays with its original chat and never reloads, pauses or notices the next chat', async () => {
  for (const fails of [false, true]) {
    const hold = deferred(), transport = { holdRevoke: hold, revokeError: fails ? Error('A withdrawal failed') : null }, f = uiFixture({ transport });
    try {
      await f.settle(); const oldToggle = parentHeader(f).props.onToggle, oldStop = f.find('final-parent-translation-revoke').props.onPress;
      oldStop(); oldStop(); oldToggle(true); await f.settle(); assert.equal(revokeCalls(f).length, 1); assert.equal(f.find('final-parent-consent-agree'), undefined, 'A cached ON callback cannot race an in-flight withdrawal');
      assert.equal(f.find('final-parent-translation-revoke').props.disabled, true);
      const b = f.addChat(); f.navigateChat(b.conversation.conversation_id, b.conversation.parent.parent_id); await f.settle();
      assert.equal(f.find('final-parent-original-1').props.children, 'B original'); assert.ok(f.find('final-parent-translation-1'));
      assert.equal(f.find('final-parent-translation-revoke').props.disabled, false, 'A pending operation cannot lock B');
      const bReads = f.calls.filter(call => call.path.includes('/conversation-B/messages?')).length;
      hold.resolve(); await f.settle(); assert.equal(f.calls.filter(call => call.path.includes('/conversation-B/messages?')).length, bReads);
      assert.equal(f.find('final-community-notice'), undefined); assert.ok(f.find('final-parent-translation-1')); assert.equal(b.ai.epoch, 0);
      assert.equal(f.find('final-parent-translation-revoke').props.disabled, false);
    } finally { hold.resolve(); f.unmount(); }
  }
});

test('saved open-consent callbacks cannot switch purpose or reopen a later chat, including A to B to A and blur/refocus', async () => {
  for (const boundary of ['chat', 'round-trip', 'blur']) {
    const f = uiFixture({ ai: participation({ effective: false, requests: { conversation_notes: null, translation: null } }) });
    try {
      await f.settle(); const oldNotes = parentHeader(f).props.onToggle, oldTranslation = f.find('final-parent-translation-request').props.onPress;
      const b = f.addChat('conversation-B', 'parent-B', participation({ conversation_id: 'conversation-B', effective: false, requests: { conversation_notes: null, translation: null } }));
      if (boundary !== 'blur') { f.navigateChat(b.conversation.conversation_id, b.conversation.parent.parent_id); await f.settle(); }
      if (boundary === 'round-trip') { f.navigateChat(conversationId, 'parent-A'); await f.settle(); }
      if (boundary === 'blur') { f.blur(); f.focus(); await f.settle(); }
      oldNotes(true); oldTranslation(); await f.settle(); assert.equal(f.find('final-parent-consent-agree'), undefined, boundary); assert.equal(requestCalls(f).length, 0);
      openPurpose(f, 'translation'); assert.match(f.find('final-parent-consent-purpose').props.children, /not recording or notes/);
    } finally { f.unmount(); }
  }
});

test('old notes Agree, Decline and Close cannot consent to or dismiss a new translation sheet in another chat', async () => {
  const f = uiFixture({ ai: participation({ effective: false, requests: { conversation_notes: null, translation: null } }) });
  try {
    await f.settle(); openPurpose(f, 'conversation_notes');
    const oldAgree = f.find('final-parent-consent-agree').props.onPress, oldDecline = f.find('final-parent-consent-decline').props.onPress, oldClose = f.find('final-parent-consent-close').props.onPress;
    const b = f.addChat('conversation-B', 'parent-B', participation({ conversation_id: 'conversation-B', effective: false, requests: { conversation_notes: null, translation: null } }));
    f.navigateChat(b.conversation.conversation_id, b.conversation.parent.parent_id); await f.settle(); openPurpose(f, 'translation');
    const expectedAgree = f.find('final-parent-consent-agree').props.onPress;
    oldAgree(); oldDecline(); oldClose(); await f.settle();
    assert.equal(requestCalls(f).length, 0); assert.equal(f.calls.filter(call => call.path.endsWith('/my-decision')).length, 0);
    assert.match(f.find('final-parent-consent-purpose').props.children, /not recording or notes/); assert.equal(f.find('final-parent-consent-agree').props.disabled, false);
    expectedAgree(); await f.settle(); assert.equal(requestCalls(f).length, 1); assert.equal(requestCalls(f)[0].body.purpose, 'translation'); assert.ok(requestCalls(f)[0].path.includes('/conversation-B/'));
    assert.equal(f.ai.requests.conversation_notes, null); assert.equal(b.ai.requests.translation.my_decision, 'allow');
  } finally { f.unmount(); }
});

for (const purpose of ['conversation_notes', 'translation']) {
  test(`confirmed ${purpose} request retires its logical key so a refusal can be followed by a fresh explicit request in the same epoch`, async () => {
    const f = uiFixture({ ai: participation({ effective: false, requests: { conversation_notes: null, translation: null } }) });
    try {
      await f.settle(); openPurpose(f, purpose); f.press('final-parent-consent-agree'); await f.settle();
      const first = f.ai.requests[purpose]; first.state = 'declined'; first.parent_decision = 'decline'; first.effective = false;
      f.poll(); await f.settle(); assert.equal(f.ai.epoch, 0); openPurpose(f, purpose); f.press('final-parent-consent-agree'); await f.settle();
      assert.equal(requestCalls(f).length, 2); assert.notEqual(requestCalls(f)[0].body.client_request_id, requestCalls(f)[1].body.client_request_id);
      assert.notEqual(f.ai.requests[purpose].request_id, first.request_id); assert.equal(f.ai.requests[purpose].state, 'pending'); assert.equal(f.ai.epoch, 0);
      f.poll(); await f.settle(); assert.equal(requestCalls(f).length, 2, 'No automatic new consent request');
    } finally { f.unmount(); }
  });

  test(`unknown-outcome ${purpose} request retries its original key; a terminal response never claims consent was requested`, async () => {
    for (const terminal of [false, true]) {
      const transport = terminal ? { nextRequestState: 'declined' } : { failRequestOnce: true };
      const f = uiFixture({ transport, ai: participation({ effective: false, requests: { conversation_notes: null, translation: null } }) });
      try {
        await f.settle(); openPurpose(f, purpose); f.press('final-parent-consent-agree'); await f.settle();
        assert.equal(requestCalls(f).length, 1); assert.ok(f.find('final-parent-consent-agree'), 'Unknown or terminal response cannot report success');
        assert.notEqual(f.find('final-community-notice')?.props.children, helper.communityTranslationCopy('en').sent);
        f.press('final-parent-consent-agree'); await f.settle(); assert.equal(requestCalls(f).length, 2);
        if (terminal) assert.notEqual(requestCalls(f)[0].body.client_request_id, requestCalls(f)[1].body.client_request_id);
        else assert.equal(requestCalls(f)[0].body.client_request_id, requestCalls(f)[1].body.client_request_id);
        assert.equal(f.ai.requests[purpose].state, 'pending'); assert.equal(f.find('final-parent-consent-agree'), undefined);
      } finally { f.unmount(); }
    }
  });
}
