import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
function load(path, dependencies = {}, globals = {}) {
  const m = { exports: {} }, source = readFileSync(path, 'utf8');
  new Function('require', 'module', 'exports', ...Object.keys(globals), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText)(name => { if (name.startsWith('@/assets/')) return 'fixture-art'; if (name === '@/src/profileDisplayName') return load('src/profileDisplayName.ts'); assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency ' + name); return dependencies[name]; }, m, m.exports, ...Object.values(globals));
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

test('automatic translation skips known target-language messages and leaves unchanged outputs as original', async () => {
  const list = [message('simplified', { language: 'zh-Hans', text: '你好' }),
    message('english', { language: 'en-US', seq: 2, text: 'Good morning' }),
    message('unknown', { seq: 3, text: '早上好' }),
    message('japanese', { language: 'ja', seq: 4, text: 'おはようございます' })];
  const calls = [];
  const controller = new helper.CommunityMessageTranslations(async (id, language) => {
    calls.push([id, language]);
    const original = list.find(m => m.message_id === id);
    const result = translated(original, language);
    if (id === 'unknown') result.translation.text = original.text;
    return result;
  }, () => 'approved-scope');
  controller.configure(scope(participation(), 'account-A', 'zh-CN'), true);
  await controller.queue(list, () => true, () => {});
  assert.deepEqual(calls, [['english', 'zh-CN'], ['unknown', 'zh-CN'], ['japanese', 'zh-CN']]);
  assert.equal(controller.text(list[0]), null);
  assert.equal(controller.text(list[1]), 'Translated words');
  assert.equal(controller.text(list[2]), null);
  assert.equal(controller.text(list[3]), 'Translated words');
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

test('notes notices keep the historical scope and withdrawal warning in all three languages', () => {
  for (const [locale, required] of [['en', 'before consent'], ['zh-CN', '同意之前的历史消息'], ['zh-TW', '同意之前的歷史訊息']]) {
    const copy = helper.communityNotesConsentCopy(locale);
    assert.ok(copy.body.includes(required), locale);
    assert.ok(copy.closeWarning.length > 20);
  }
});

const jsx = (type, props, key) => ({ type, props, key });
const nodes = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
const bottleFixture = (replyCount = 1) => ({
  question: { question_id: 'bottle-A', body: 'How did you manage the first day?', status: 'open', is_mine: true, reply_count: replyCount, created_at: '' },
  replies: Array.from({ length: replyCount }, (_, index) => ({ reply_id: 'reply-' + index, author: { parent_id: 'parent-' + index, display_name: 'Parent' }, body: 'One step at a time.', allowed_actions: ['comment'], comment_count: 0 })),
});
function uiFixture({ ai = participation(), preference = true, preferenceVersion = 1, allowed = true, holdTranslation = null, transport = {}, bottle = null, notifications = [], waiting = [], initialScreen,
  localItems = new Map(), localOwner = 'account-A', connected = true } = {}) {
  let cursor = 0, tree, live = true, generation = 1, locale = 'en', serial = 0, notificationId, keyboardVisible = false, navigationGuard;
  const slots = [], effects = [], pending = [], intervals = new Map(), frames = new Map(), calls = [], params = [], focusLeases = new Set(), entries = new Map(), requestKeys = new Map();
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = { useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; slots[i].set ??= value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }; return [slots[i].value, slots[i].set]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; }, useReducer(reduce, arg, init) { const [value, set] = react.useState(() => init(arg)); return [value, event => set(old => reduce(old, event))]; },
    useMemo(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; }, useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (!same(effects[i]?.deps, deps)) pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); } };
  const local = { status: allowed ? 'allowed' : 'not_allowed', userId: localOwner, session: 1, version: APP_VERSION };
  const list = [message(), message('mine', { sender: 'me', seq: 2, text: 'My original' })], conversation = { conversation_id: conversationId, parent: { parent_id: 'parent-A', display_name: 'Parent' },
    allowed_actions: connected ? ['send_message'] : [], relationship_state: connected ? 'connected' : 'disconnected' };
  const chats = new Map([[conversationId, { ai, list, conversation }]]);
  const apiRequest = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null; calls.push({ path, method: init.method ?? 'GET', body });
    if (path.startsWith('/community/v1/me/notifications?')) {
      if (transport.notificationError) throw transport.notificationError;
      return { items: structuredClone(notifications), has_more: false };
    }
    if (path.startsWith('/community/v1/me/question-deliveries?')) {
      if (transport.waitingRequest) return transport.waitingRequest(path, generation);
      return { items: structuredClone(waiting), has_more: false, next_cursor: null };
    }
    const delivered = waiting.find(delivery => path === '/community/v1/questions/' + delivery.question.question_id);
    if (delivered) {
      if (transport.holdQuestion) await transport.holdQuestion.promise;
      return { question: transport.receivedQuestion ?? { ...delivered.question, delivery: delivered } };
    }
    if (path.startsWith('/community/v1/me/questions?') && !bottle) return { items: [], has_more: false };
    if (bottle) {
      const questionPath = '/community/v1/questions/' + bottle.question.question_id;
      const page = { has_more: false, next_cursor: null };
      if (path.startsWith('/community/v1/me/questions?')) return { ...page, items: [bottle.question] };
      if (path.startsWith(questionPath + '/replies?')) return { ...page, question: bottle.question, items: bottle.replies, all_thread: { thread_id: 'all', can_post: true, comment_count: bottle.allCommentCount ?? 0 } };
      if (path.startsWith(questionPath + '/reply-threads/')) {
        if (init.method === 'POST') return { created: true };
        if (transport.holdComments) await transport.holdComments.promise;
        return { ...page, items: [], can_post: true };
      }
    }
    const record = [...chats.values()].find(value => path.includes('/conversations/' + value.conversation.conversation_id + '/')) ?? chats.get(conversationId);
    if (path.startsWith('/community/v1/me/inbox?')) return { items: [...chats.values()].map(({ conversation }) => ({ ...conversation, kind: 'conversation', unread_count: 0, last_message: null })), next_cursor: null, has_more: false, summary: {} };
    if (path === '/community/v1/preferences') return { auto_translate_messages: preference, parent_message_notifications_enabled: true, profile_hidden: false, version: preferenceVersion };
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
  const model = load('src/uiuxfinal/communityModel.ts');
  const initialized = initialScreen ? model.createFinalCommunity(initialScreen) : bottle ? model.createFinalCommunity('myQuestions') : { ...model.createFinalCommunity('hub'), screen: 'chat', person: 'parent-A', personName: 'Parent' };
  const router = { setParams: value => { params.push(value); if (Object.hasOwn(value, 'notificationId')) notificationId = value.notificationId; }, push() {}, dismissTo() {} };
  const component = load('src/uiuxfinal/CommunityFinal.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { ...Object.fromEntries(['View', 'Text', 'Pressable', 'ScrollView', 'Modal', 'ActivityIndicator'].map(n => [n, n])), Platform: { OS: 'ios' }, StyleSheet: { create: x => x }, Keyboard: { dismiss() {} }, Animated: {}, Easing: {}, AccessibilityInfo: {} },
    'expo-image': { Image: 'Image' }, 'expo-blur': { BlurView: 'BlurView' }, 'expo-image-picker': {},
    'expo-router': { useLocalSearchParams: () => ({ notificationId }), usePathname: () => '/community', useRouter: () => router, useFocusEffect: fn => react.useEffect(() => { const lease = { fn, cleanup: fn() }; focusLeases.add(lease); return () => { focusLeases.delete(lease); lease.cleanup?.(); }; }, [fn]) },
    '@/src/i18n': { useT: () => ({ locale }), translate: (_locale, s) => s }, '@/src/keyboard/AppKeyboard': { NuriTextInput: 'Input', useAppKeyboardVisible: () => false },
    '@/src/api': { api: {}, aiConsent: { getState: () => ({ ...local }) }, apiErrorDetail: () => '', isAuthError: () => false }, '@/src/aiConsent': { AI_CONSENT_VERSION: APP_VERSION }, '@/src/useAIConsent': { useAIConsent: () => ({ state: { ...local } }) },
    '@/src/communityMessageTranslation': helper, '@/src/communityApi': client, '@/src/useAccountState': { useAccountScope: () => ({ generation, capture: () => live ? generation : null, current: ticket => live && ticket === generation }) },
    '@/src/components/nativeNavigation': { registerNativeNavigationGuard: (_path, guard) => { navigationGuard = guard; return () => { navigationGuard = undefined; }; } }, '@/src/aiPermissionNavigation': { aiPermissionHref: () => '/ai-permission' },
    '@/src/uiux48/Primitives': { IconAction: 'IconAction', NuriKeyboardFrame: 'NuriKeyboardFrame' }, '@/src/uiux48/Composer': { NuriComposer: 'NuriComposer' }, '@/src/uiux48/VoiceInputBar': { VoiceInputBar: 'VoiceInputBar' },
    '@/src/chatImageInput': { ChatImageInputError: Error, pickWebChatImageFile() {}, prepareChatImage() {} }, '@/src/chatVoiceInput': { MAX_VOICE_SECONDS: 60, VoiceInputError: Error, isVoiceInputSupported: () => false, startVoiceRecording() {} },
    '@/src/uiux48/useComposerDock': { useComposerDockInset: enabled => enabled ? (keyboardVisible ? 12 : 46) : 0 }, '@/src/uiux48/inputLayout': { singleLineInputStyle: {} },
    './Primitives': { ...Object.fromEntries(['FinalButton', 'FinalChatBubble', 'FinalDivider', 'FinalSurface', 'FinalText'].map(n => [n, n])), FINAL_COLOR: {} }, './ButtonMaterial': { ButtonBackdrop: 'Backdrop', FrostedPressable: 'Pressable' },
    './ParentChatHeader': { ParentChatAvatar: 'Avatar', ParentChatHeader: 'ParentChatHeader' }, './Settings': { SettingsPage: 'SettingsPage', SettingsRow: 'SettingsRow', SettingsButton: 'SettingsButton' },
    './CommunityProfileEditor': { CommunityProfileEditor: 'Editor', GENDER_TAGS: [] }, './CommunityReportSheet': { CommunityReportSheet: 'Report' },
    './communityModel': { ...model, createFinalCommunity: () => initialized }, './communityHubLayout': { communityHubTopPadding: () => 0, HUB_PAGINATION: {}, HUB_CARD_BOTTOM_GUTTER: 0, HUB_PAGER_GAP: 0 },
    '@/src/communityNotificationEntry': { loadCommunityNotificationEntry: async id => { assert.ok(entries.has(id)); return entries.get(id); } }, '@/src/communityImageSelection': { selectCommunityImage() {} },
    '@/src/utils/storage': { storage: {
      getItem: async (key, fallback) => {
        if (key.startsWith('community.notes-offer-dismissed.') && transport.holdOfferRead) await transport.holdOfferRead.promise;
        return localItems.get(key) ?? fallback;
      },
      setItem: async (key, value) => { localItems.set(key, value); return true; },
    } },
  }, { setInterval: (fn, delay) => { const id = ++serial; intervals.set(id, { fn, delay }); return id; }, clearInterval: id => intervals.delete(id),
    requestAnimationFrame: fn => { const id = ++serial; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id) }).default;
  const render = () => { cursor = 0; tree = component(); pending.splice(0).forEach(fn => fn()); return tree; }, find = id => nodes(tree).find(n => n.props?.testID === id);
  return { calls, local, ai, list, params, render, find, nodes: () => nodes(tree), translations: () => calls.filter(c => c.path.endsWith('/translations')),
    addChat(id = 'conversation-B', parentId = 'parent-B', nextAI = participation({ conversation_id: id })) { const record = { ai: nextAI, list: [message('B-message', { conversation_id: id, text: 'B original' })], conversation: { ...conversation, conversation_id: id, parent: { parent_id: parentId, display_name: parentId } } }; chats.set(id, record); return record; },
    navigateChat(id, parentId) { notificationId = 'fixture-navigation-' + (++serial); entries.set(notificationId, { conversation: { id, parentId }, events: [{ type: 'person', person: parentId, name: parentId, screen: 'chat' }] }); render(); },
    switchAccount() { generation++; local.userId = 'account-B'; local.session++; render(); },
    async settle() { for (let n = 0; n < 8; n++) { render(); await tick(); } render(); },
    poll() { for (const item of intervals.values()) if (item.delay === 8000) item.fn(); },
    flushFrame() { const callbacks = [...frames.values()]; frames.clear(); for (const fn of callbacks) fn(); },
    keyboard(visible) { keyboardVisible = visible; render(); },
    blur() { for (const lease of focusLeases) { lease.cleanup?.(); lease.cleanup = undefined; } }, focus() { for (const lease of focusLeases) lease.cleanup = lease.fn(); },
    back() { assert.ok(navigationGuard); navigationGuard('back'); render(); },
    press(id) { const node = find(id); assert.ok(node, 'Missing ' + id); assert.notEqual(node.props.disabled, true, 'Disabled ' + id); node.props.onPress(); render(); },
    locale(value) { locale = value; render(); }, unmount() { live = false; effects.forEach(effect => effect?.cleanup?.()); },
  };
}

const receivedDelivery = () => ({ delivery_id: 'delivery-A', state: 'waiting', lock_reason: null, my_reply: null,
  question: { question_id: 'received-A', body: 'A real waiting question', status: 'open', is_mine: false,
    author: { parent_id: 'other-parent', display_name: 'Another parent' }, created_at: '' } });
const receivedNotice = id => ({ notification_id: id, read_at: null,
  target: { kind: 'community_question', question_id: 'received-A', delivery_id: 'delivery-A' } });
async function withReceivedFixture(options, run) {
  const previous = process.env.EXPO_PUBLIC_RELEASE_FLAVOR;
  process.env.EXPO_PUBLIC_RELEASE_FLAVOR = 'live-alpha';
  const f = uiFixture({ initialScreen: 'hub', ...options });
  try { await run(f); }
  finally { f.unmount(); if (previous === undefined) delete process.env.EXPO_PUBLIC_RELEASE_FLAVOR; else process.env.EXPO_PUBLIC_RELEASE_FLAVOR = previous; }
}

test('an empty received snapshot renders no questions and zero unread despite one stale delivery notice', async () => {
  await withReceivedFixture({ notifications: [receivedNotice('stale')] }, async f => {
    await f.settle();
    assert.equal(f.find('final-bottle-icon-received').props.count, 0);
    assert.ok(f.find('final-open-received').props.accessibilityLabel.includes('No new questions'));
    f.press('final-open-received'); await f.settle();
    assert.ok(f.nodes().some(node => node.props?.children === 'No questions waiting for you'));
    assert.equal(f.calls.filter(call => call.path.endsWith('/read')).length, 0);
  });
});

test('a notification failure preserves accessible waiting content with an unknown zero unread count', async () => {
  await withReceivedFixture({ waiting: [receivedDelivery()], transport: { notificationError: Error('Notifications unavailable') } }, async f => {
    await f.settle();
    assert.equal(f.find('final-bottle-icon-received').props.count, 0);
    assert.ok(f.find('final-open-received').props.accessibilityLabel.includes('A real waiting question'));
    f.press('final-open-received'); await f.settle();
    assert.ok(f.find('final-open-delivery-A'));
    f.press('final-open-delivery-A'); await f.settle();
    assert.ok(f.nodes().some(node => node.props?.children === 'A real waiting question'));
  });
});

test('a waiting 500 preserves My questions unread replies and Received retry restores available content', async () => {
  let fail = true;
  const notifications = [receivedNotice('received-unread'), { notification_id: 'own-unread', read_at: null,
    target: { kind: 'community_reply', question_id: 'bottle-A', thread_id: 'reply-0' } }];
  await withReceivedFixture({ bottle: bottleFixture(), notifications, transport: { waitingRequest: async () => {
    if (fail) throw Error('HTTP 500 waiting deliveries');
    return { items: [receivedDelivery()], has_more: false };
  } } }, async f => {
    await f.settle();
    assert.equal(f.find('final-bottle-icon-myQuestions').props.count, 1);
    assert.equal(f.find('final-bottle-icon-received').props.count, 0);
    assert.ok(f.find('final-open-received').props.accessibilityLabel.includes('Couldn’t load preview'));
    assert.ok(f.calls.some(call => call.path.includes('/questions/bottle-A/replies?')),
      'Owned replies still receive independent validation after the waiting read fails');
    f.press('final-open-my-questions'); await f.settle();
    assert.equal(f.find('final-my-bottle-bottle-A').props.count, 1);
    f.back(); await f.settle(); f.press('final-open-received'); await f.settle();
    assert.ok(f.nodes().some(node => node.props?.children === 'The service is unavailable; please try again'));
    assert.equal(f.nodes().some(node => node.props?.children === 'No questions waiting for you'), false);
    const retry = f.nodes().find(node => node.type === 'FinalButton' && node.props.label === 'Retry');
    assert.ok(retry);
    fail = false; retry.props.onPress(); await f.settle();
    assert.ok(f.find('final-open-delivery-A'));
    f.back(); await f.settle();
    assert.equal(f.find('final-bottle-icon-myQuestions').props.count, 1);
    assert.equal(f.find('final-bottle-icon-received').props.count, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith('/read')).length, 0);
  });
});

test('a real received question counts once and clears every duplicate notice only after its content loads', async () => {
  const holdQuestion = deferred();
  await withReceivedFixture({ waiting: [receivedDelivery()], notifications: [receivedNotice('one'), receivedNotice('two')], transport: { holdQuestion } }, async f => {
    await f.settle();
    assert.equal(f.find('final-bottle-icon-received').props.count, 1);
    assert.ok(f.find('final-open-received').props.accessibilityLabel.includes('A real waiting question'));
    f.press('final-open-received'); await f.settle();
    assert.ok(f.find('final-open-delivery-A'));
    assert.equal(f.calls.filter(call => call.path.endsWith('/read')).length, 0);
    f.press('final-open-delivery-A'); await f.settle();
    assert.equal(f.calls.filter(call => call.path.endsWith('/read')).length, 0);
    holdQuestion.resolve(); await f.settle();
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/read')).map(call => call.path).sort(), [
      '/community/v1/me/notifications/one/read', '/community/v1/me/notifications/two/read',
    ]);
    f.back(); f.back(); await f.settle();
    assert.equal(f.find('final-bottle-icon-received').props.count, 0);
    assert.ok(f.find('final-open-received').props.accessibilityLabel.includes('A real waiting question'), 'Read waiting content remains accessible');
  });
});

test('received read receipts require the loaded detail to match this exact question and delivery', async () => {
  const delivery = receivedDelivery();
  for (const receivedQuestion of [
    { ...delivery.question, delivery: { delivery_id: 'other-delivery', state: 'waiting' } },
    { ...delivery.question, question_id: 'other-question', delivery },
    { ...delivery.question, is_mine: true, delivery },
    { ...delivery.question, delivery: { ...delivery, state: 'replied' } },
  ]) {
    await withReceivedFixture({ waiting: [delivery], notifications: [receivedNotice('unread')], transport: { receivedQuestion } }, async f => {
      await f.settle(); f.press('final-open-received'); await f.settle(); f.press('final-open-delivery-A'); await f.settle();
      assert.equal(f.calls.filter(call => call.path.endsWith('/read')).length, 0);
    });
  }
});

test('opening the received list and returning home revalidates deliveries that stopped waiting', async () => {
  const waiting = [receivedDelivery()];
  await withReceivedFixture({ waiting, notifications: [receivedNotice('stale')] }, async f => {
    await f.settle(); assert.equal(f.find('final-bottle-icon-received').props.count, 1);
    waiting.length = 0;
    f.press('final-open-received'); await f.settle();
    assert.ok(f.nodes().some(node => node.props?.children === 'No questions waiting for you'));
    f.back(); await f.settle();
    assert.equal(f.find('final-bottle-icon-received').props.count, 0);
    assert.ok(f.find('final-open-received').props.accessibilityLabel.includes('No new questions'));
    assert.equal(f.calls.filter(call => call.path.endsWith('/read')).length, 0);
  });
});

test('failed focus revalidation and late account snapshots cannot retain or revive a received badge', async () => {
  let fail = false;
  await withReceivedFixture({ notifications: [receivedNotice('unread')], transport: { waitingRequest: async () => {
    if (fail) throw Error('Delivery read failed');
    return { items: [receivedDelivery()], has_more: false };
  } } }, async f => {
    await f.settle(); assert.equal(f.find('final-bottle-icon-received').props.count, 1);
    fail = true; f.blur(); f.focus(); await f.settle();
    assert.equal(f.find('final-bottle-icon-received').props.count, 0);
    assert.ok(f.find('final-open-received').props.accessibilityLabel.includes('Couldn’t load preview'));
  });
  const late = deferred();
  await withReceivedFixture({ notifications: [receivedNotice('unread')], transport: { waitingRequest: (_path, generation) => generation === 1 ? late.promise : { items: [], has_more: false } } }, async f => {
    await f.settle(); f.switchAccount(); await f.settle();
    late.resolve({ items: [receivedDelivery()], has_more: false }); await f.settle();
    assert.equal(f.find('final-bottle-icon-received').props.count, 0);
    assert.ok(f.find('final-open-received').props.accessibilityLabel.includes('No new questions'));
  });
});

test('unread global-thread comments clear only after the visible thread finished loading', async () => {
  const previousFlavor = process.env.EXPO_PUBLIC_RELEASE_FLAVOR;
  process.env.EXPO_PUBLIC_RELEASE_FLAVOR = 'live-alpha';
  const comments = deferred(), notifications = [{ notification_id: 'global-event', read_at: null,
    target: { kind: 'community_reply', question_id: 'bottle-A', thread_id: 'all' } }];
  const f = uiFixture({ bottle: { ...bottleFixture(), allCommentCount: 1 }, notifications, transport: { holdComments: comments } });
  try {
    await f.settle();
    assert.equal(f.find('final-my-bottle-bottle-A').props.count, 1);
    f.press('final-question-bottle-A'); await f.settle();
    assert.equal(f.calls.filter(call => call.path.endsWith('/read')).length, 0);
    comments.resolve(); await f.settle();
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/read')).map(call => call.path), ['/community/v1/me/notifications/global-event/read']);
  } finally { f.unmount(); if (previousFlavor === undefined) delete process.env.EXPO_PUBLIC_RELEASE_FLAVOR; else process.env.EXPO_PUBLIC_RELEASE_FLAVOR = previousFlavor; }
});

test('private reply comments stay unread on the question overview and clear after opening their thread', async () => {
  const previousFlavor = process.env.EXPO_PUBLIC_RELEASE_FLAVOR;
  process.env.EXPO_PUBLIC_RELEASE_FLAVOR = 'live-alpha';
  const notifications = [{ notification_id: 'private-event', read_at: null,
    target: { kind: 'community_reply', question_id: 'bottle-A', thread_id: 'reply-0' } }];
  const f = uiFixture({ bottle: bottleFixture(), notifications });
  try {
    await f.settle(); f.press('final-question-bottle-A'); await f.settle();
    assert.equal(f.calls.filter(call => call.path.endsWith('/read')).length, 0);
    f.press('final-reply-reply-0'); await f.settle();
    assert.equal(f.calls.filter(call => call.path.endsWith('/read')).length, 1);
  } finally { f.unmount(); if (previousFlavor === undefined) delete process.env.EXPO_PUBLIC_RELEASE_FLAVOR; else process.env.EXPO_PUBLIC_RELEASE_FLAVOR = previousFlavor; }
});

test('Reply All focuses one editor and keeps the draft and Send through keyboard transitions', async () => {
  const f = uiFixture({ bottle: bottleFixture() });
  try {
    await f.settle();
    f.press('final-question-bottle-A');
    await f.settle();
    assert.ok(f.nodes().some(node => node.props.children === '1 parent replied'));
    assert.equal(f.find('final-comment-input').type, 'Pressable');
    assert.equal(f.find('final-input-comment:bottle-A:all'), undefined);
    f.press('final-comment-input');

    const id = 'final-input-comment:bottle-A:all';
    const editor = f.find(id), editorRef = editor.props.ref;
    assert.equal(f.nodes().filter(node => node.type === 'Input').length, 1);
    let focusCalls = 0;
    editorRef.current = { focus() { focusCalls++; } };
    f.flushFrame();
    assert.equal(focusCalls, 1);
    f.keyboard(true);
    assert.equal(f.find(id).props.ref, editorRef);
    assert.equal(f.find('final-community-replyExpanded').props.style.flexShrink, 0);
    assert.equal(nodes(f.find('final-reply-all-context-scroll')).some(node => node.props.testID === id), false);
    assert.equal(f.find('final-send-experience').props.disabled, true);
    f.find(id).props.onChangeText('谢谢大家');
    f.keyboard(false);
    assert.equal(f.find(id).props.value, '谢谢大家');
    f.keyboard(true);
    assert.equal(f.find(id).props.ref, editorRef);
    f.press('final-send-experience');
    await f.settle();
    assert.equal(f.find(id), undefined);
    assert.ok(f.find('final-comment-input'));
    assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body.body]), [
      ['/community/v1/questions/bottle-A/reply-threads/all/comments', '谢谢大家'],
    ]);
  } finally { f.unmount(); }
});

test('private reply keeps the draft and Send docked below the scrollable thread when the keyboard opens', async () => {
  const f = uiFixture({ bottle: bottleFixture(2) });
  try {
    await f.settle();
    f.press('final-question-bottle-A');
    await f.settle();
    assert.ok(f.nodes().some(node => node.props.children === '2 parents replied'));
    f.press('final-reply-reply-0');
    await f.settle();
    f.keyboard(true);
    const id = 'final-input-comment:bottle-A:reply-0';
    const context = nodes(f.find('final-reply-thread-scroll'));
    const dock = f.find('final-private-reply-dock');
    assert.ok(context.some(node => node.props.children === 'One step at a time.'));
    assert.equal(context.some(node => node.props.testID === id), false);
    assert.equal(dock.props.style.flexShrink, 0);
    assert.ok(nodes(dock).some(node => node.props.testID === 'final-send-experience'));
    f.find(id).props.onChangeText('Thank you.');
    f.render();
    f.press('final-send-experience');
    await f.settle();
    assert.equal(f.find(id).props.value, '');
    assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body.body]), [
      ['/community/v1/questions/bottle-A/reply-threads/reply-0/comments', 'Thank you.'],
    ]);
  } finally { f.unmount(); }
});

test('actual chat executes P29 only with all three gates and renders only the verified translation', async () => {
  const f = uiFixture(); try { await f.settle(); assert.equal(f.translations().length, 1); assert.equal(f.find('final-parent-original-1'), undefined); assert.equal(f.find('final-parent-translation-1').props.children, 'Translated words'); assert.equal(f.find('final-parent-translation-2'), undefined);
    f.poll(); await f.settle(); f.poll(); await f.settle(); assert.equal(f.translations().length, 1); assert.equal(f.translations()[0].body.target_language, 'en'); assert.equal(f.translations()[0].body.ai_consent_version, APP_VERSION);
  } finally { f.unmount(); }
});

test('actual new-message polling translates only the new inbound text; language changes hide the old target before another render', async () => {
  const f = uiFixture(); try { await f.settle(); f.list.push(message('new-message', { seq: 3, text: 'New original' })); f.poll(); await f.settle();
    assert.equal(f.translations().length, 2); assert.equal(f.find('final-parent-original-3'), undefined); assert.equal(f.find('final-parent-translation-3').props.children, 'Translated words');
    f.locale('zh-TW'); assert.equal(f.find('final-parent-translation-1'), undefined); assert.equal(f.find('final-parent-original-1').props.children, 'Original words'); await f.settle();
    assert.equal(f.translations().length, 4); assert.ok(f.translations().slice(2).every(call => call.body.target_language === 'zh-TW')); assert.equal(f.find('final-parent-original-1'), undefined);
  } finally { f.unmount(); }
});

test('a translated bubble reveals the original on long press and retains the report action', async () => {
  const f = uiFixture();
  try {
    await f.settle();
    assert.equal(f.find('final-parent-original-1'), undefined);
    const longPress = f.find('final-parent-message-press-1').props.onLongPress;
    longPress();
    f.render();
    const reportProps = f.nodes().find(node => node.type === 'Report' && node.props.visible).props;
    assert.equal(reportProps.originalText, 'Original words');

    let cursor = 0;
    const values = [];
    const { CommunityReportSheet } = load('src/uiuxfinal/CommunityReportSheet.tsx', {
      react: { useState: initial => {
        const slot = cursor++;
        if (!(slot in values)) values[slot] = initial;
        return [values[slot], next => { values[slot] = next; }];
      }, useEffect() {} },
      'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
      'react-native': { Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View' },
      'expo-image': { Image: 'Image' }, 'expo-blur': { BlurView: 'BlurView' },
      '@/src/i18n': { useT: () => ({ locale: 'en' }) },
      '@/src/keyboard/AppKeyboard': { NuriTextInput: 'Input' },
      './Primitives': { FinalButton: 'Button', FinalSurface: 'Surface', FinalText: 'Text', FINAL_COLOR: {} },
    });
    const sheet = () => { cursor = 0; return nodes(CommunityReportSheet(reportProps)); };
    const preview = sheet();
    assert.equal(preview.find(node => node.props?.testID === 'community-original-message').props.children, 'Original words');
    assert.equal(preview.find(node => node.props?.testID === 'community-report-submit'), undefined);
    preview.find(node => node.props?.testID === 'community-original-report').props.onPress();
    const report = sheet();
    const surface = report.find(node => node.type === 'Surface');
    const scroll = report.find(node => node.type === 'ScrollView');
    assert.equal(surface.props.contentStyle.padding, undefined);
    assert.ok(scroll.props.scrollIndicatorInsets.right < scroll.props.contentContainerStyle.paddingHorizontal);
    const scrollContent = nodes(scroll.props.children);
    assert.ok(scrollContent.some(node => node.props?.testID === 'community-report-note'));
    assert.ok(!scrollContent.some(node => node.type === 'Button'));
    assert.equal(report.find(node => node.props?.testID === 'community-report-submit').props.disabled, true);
    assert.equal(f.calls.filter(call => call.path.endsWith('/reports')).length, 0);

    const other = f.addChat();
    f.navigateChat(other.conversation.conversation_id, other.conversation.parent.parent_id);
    await f.settle();
    longPress();
    f.render();
    assert.equal(f.nodes().find(node => node.type === 'Report' && node.props.visible), undefined);
  } finally { f.unmount(); }
});

test('chat has no translation permission entry and fails closed without any of the required gates', async () => {
  const notesOnly = participation({ requests: { conversation_notes: grant('conversation_notes'), translation: null } });
  for (const options of [{ preference: false }, { allowed: false }, { ai: notesOnly }]) {
    const f = uiFixture(options);
    try {
      await f.settle();
      assert.equal(f.translations().length, 0);
      assert.equal(f.find('final-parent-original-1').props.children, 'Original words');
      assert.equal(f.find('final-parent-translation-controls'), undefined);
      assert.equal(f.find('final-parent-consent-agree'), undefined);
      assert.equal(requestCalls(f).length, 0);
    } finally { f.unmount(); }
  }
});

test('legacy pending translation requests open no sheet or status and create no consent write', async () => {
  for (const initiatedBy of ['me', 'parent']) {
    const ai = participation();
    ai.requests.translation = grant('translation', { initiated_by: initiatedBy, state: 'pending', effective: false, my_decision: 'pending' });
    const f = uiFixture({ ai });
    try {
      await f.settle(); f.poll(); await f.settle();
      for (const id of ['final-parent-translation-controls', 'final-parent-translation-request', 'final-parent-translation-revoke', 'final-parent-consent-agree', 'final-community-notice']) {
        assert.equal(f.find(id), undefined);
      }
      assert.equal(f.find('final-parent-original-1').props.children, 'Original words');
      assert.equal(requestCalls(f).length, 0);
      assert.equal(f.calls.filter(c => c.path.endsWith('/my-decision')).length, 0);
      assert.equal(f.translations().length, 0);
    } finally { f.unmount(); }
  }
});

test('actual local withdrawal/unmount discard an in-flight result and do not automatically retry a failed attempt', async () => {
  for (const boundary of ['withdraw', 'unmount']) { const hold = deferred(), f = uiFixture({ holdTranslation: hold }); await f.settle(); assert.equal(f.translations().length, 1);
    if (boundary === 'withdraw') { f.local.status = 'not_allowed'; f.render(); } else f.unmount(); hold.resolve();
    if (boundary === 'withdraw') { await f.settle(); assert.equal(f.find('final-parent-translation-1'), undefined); f.local.status = 'allowed'; await f.settle(); assert.equal(f.translations().length, 1); f.unmount(); }
    else await tick();
  }
});

test('notes withdrawal hides cached translations when the backend advances the shared epoch', async () => {
  const f = uiFixture(); try { await f.settle(); assert.ok(f.find('final-parent-translation-1')); parentHeader(f).props.onToggle(false); await f.settle();
    assert.equal(f.find('final-parent-translation-1'), undefined); assert.ok(f.find('final-parent-original-1')); assert.equal(f.ai.epoch, 1);
    assert.ok(f.calls.some(c => c.path.endsWith('/ai-participation?purpose=conversation_notes'))); f.poll(); await f.settle(); assert.equal(f.translations().length, 1);
  } finally { f.unmount(); }
});

test('actual stale consent callback cannot decide a replacement epoch/request', async () => {
  const ai = participation(); ai.requests.conversation_notes = grant('conversation_notes', { initiated_by: 'parent', state: 'pending', effective: false, my_decision: 'pending' });
  const f = uiFixture({ ai }); try { await f.settle(); const old = f.find('final-parent-consent-agree').props.onPress;
    f.ai.epoch++; f.ai.requests.conversation_notes = grant('conversation_notes', { epoch: 1, request_id: 'replacement', initiated_by: 'parent', state: 'pending', effective: false, my_decision: 'pending' }); f.poll(); await f.settle();
    old(); await f.settle(); assert.equal(f.calls.filter(c => c.path.endsWith('/my-decision')).length, 0); assert.equal(f.find('final-parent-consent-agree').props.disabled, true);
  } finally { f.unmount(); }
});

test('actual blur and refocus cannot revive a prior consent-sheet action lease in the same conversation', async () => {
  const ai = participation(); ai.requests.conversation_notes = grant('conversation_notes', { initiated_by: 'parent', state: 'pending', effective: false, my_decision: 'pending' });
  const f = uiFixture({ ai }); try { await f.settle(); const old = f.find('final-parent-consent-agree').props.onPress;
    f.blur(); f.focus(); await f.settle(); old(); await f.settle();
    assert.equal(f.calls.filter(c => c.path.endsWith('/my-decision')).length, 0); assert.equal(f.find('final-parent-consent-agree').props.disabled, true);
  } finally { f.unmount(); }
});

const parentHeader = f => f.nodes().find(node => node.type === 'ParentChatHeader');
const requestCalls = f => f.calls.filter(call => call.path.endsWith('/ai-consent-requests'));
const freshNotesOffer = (patch = {}) => participation({
  effective: false, notes_offer_eligible: true, requests: { conversation_notes: null, translation: null }, ...patch,
});
async function withAlphaNotesFixture(options, run) {
  const previous = process.env.EXPO_PUBLIC_RELEASE_FLAVOR;
  process.env.EXPO_PUBLIC_RELEASE_FLAVOR = 'live-alpha';
  const f = uiFixture(options);
  try { await run(f); }
  finally {
    f.unmount();
    if (previous === undefined) delete process.env.EXPO_PUBLIC_RELEASE_FLAVOR;
    else process.env.EXPO_PUBLIC_RELEASE_FLAVOR = previous;
  }
}
async function openTranslationPermissions(f) {
  await f.settle();
  f.press('final-community-translation-permissions');
  await f.settle();
  f.press('final-translation-conversation-' + conversationId);
  await f.settle();
}
test('Alpha settings can request translation, then translate the first received message only after both grants', async () => {
  const ai = participation(); ai.requests.translation = null;
  await withAlphaNotesFixture({ initialScreen: 'preferences', ai, preferenceVersion: 0 }, async f => {
    f.list[0].language = 'en';
    f.locale('zh-CN');
    await openTranslationPermissions(f);
    assert.equal(requestCalls(f).length, 0);
    f.press('final-translation-permission-request'); await f.settle();
    assert.equal(requestCalls(f).length, 1);
    assert.equal(requestCalls(f)[0].body.purpose, 'translation');
    assert.equal(ai.requests.translation.my_decision, 'allow');
    assert.equal(ai.requests.translation.parent_decision, 'pending');
    f.navigateChat(conversationId, 'parent-A'); await f.settle();
    assert.equal(f.translations().length, 0);
    assert.equal(f.find('final-parent-original-1').props.children, 'Original words');
    Object.assign(ai.requests.translation, { parent_decision: 'allow', state: 'effective', effective: true });
    f.poll(); await f.settle();
    assert.equal(f.translations().length, 1);
    assert.equal(f.translations()[0].body.target_language, 'zh-CN');
    assert.equal(f.find('final-parent-translation-1').props.children, 'Translated words');
  });
});
test('Alpha settings explicitly approves or declines the other parent’s exact translation request', async () => {
  for (const action of ['approve', 'decline']) {
    const ai = participation();
    ai.requests.translation = grant('translation', { version: 7, state: 'pending', effective: false, initiated_by: 'parent', my_decision: 'pending' });
    await withAlphaNotesFixture({ initialScreen: 'preferences', ai }, async f => {
      await openTranslationPermissions(f);
      assert.equal(f.calls.filter(c => c.path.endsWith('/my-decision')).length, 0);
      f.press('final-translation-permission-' + action); await f.settle();
      const decisions = f.calls.filter(c => c.path.endsWith('/my-decision'));
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].body.decision, action === 'approve' ? 'allow' : 'decline');
      assert.equal(decisions[0].body.expected_version, 7);
    });
  }
});
test('Alpha translation settings can revoke while device AI is off and stale callbacks never consent for another account', async () => {
  await withAlphaNotesFixture({ initialScreen: 'preferences', allowed: false }, async f => {
    await openTranslationPermissions(f);
    f.press('final-translation-permission-revoke'); await f.settle();
    assert.ok(f.calls.some(c => c.path.endsWith('/ai-participation?purpose=translation')));
    assert.equal(f.ai.requests.translation, null);
  });
  const ai = participation(); ai.requests.translation = null;
  await withAlphaNotesFixture({ initialScreen: 'preferences', ai }, async f => {
    await openTranslationPermissions(f);
    const stale = f.find('final-translation-permission-request').props.onPress;
    f.switchAccount();
    stale(); await f.settle();
    assert.equal(requestCalls(f).length, 0);
  });
});
test('a verified fresh Alpha chat proactively asks without opting in either parent', async () => {
  await withAlphaNotesFixture({ ai: freshNotesOffer() }, async f => {
    await f.settle();
    assert.equal(parentHeader(f).props.participating, false);
    assert.match(f.find('final-parent-consent-purpose').props.children, /after both parents agree/);
    assert.equal(f.find('final-parent-consent-decline').props.label, 'Keep off');
    assert.equal(requestCalls(f).length, 0);
    f.press('final-parent-consent-agree'); await f.settle();
    assert.equal(requestCalls(f).length, 1);
    assert.equal(requestCalls(f)[0].body.purpose, 'conversation_notes');
    assert.equal(f.find('final-parent-consent-agree'), undefined);
    assert.equal(parentHeader(f).props.participating, false);
    assert.equal(parentHeader(f).props.status, 'Waiting for them');
    assert.equal(f.calls.filter(call => call.path.endsWith('/my-decision')).length, 0);
  });
});
test('keeping an eligible conversation off survives remounts and is scoped to that account and chat', async () => {
  const localItems = new Map();
  await withAlphaNotesFixture({ ai: freshNotesOffer(), localItems }, async f => {
    await f.settle(); f.press('final-parent-consent-decline'); await f.settle();
    f.poll(); await f.settle();
    assert.equal(f.find('final-parent-consent-agree'), undefined);
    assert.equal(requestCalls(f).length, 0);
    f.addChat('conversation-B', 'parent-B', freshNotesOffer({ conversation_id: 'conversation-B' }));
    f.navigateChat('conversation-B', 'parent-B'); await f.settle();
    assert.ok(f.find('final-parent-consent-agree'), 'A different chat can make its own choice');
  });
  await withAlphaNotesFixture({ ai: freshNotesOffer(), localItems }, async f => {
    await f.settle(); assert.equal(f.find('final-parent-consent-agree'), undefined);
    openNotesConsent(f); assert.ok(f.find('final-parent-consent-agree'), 'The user can still manually enable it');
  });
  await withAlphaNotesFixture({ ai: freshNotesOffer(), localItems, localOwner: 'another-account' }, async f => {
    await f.settle(); assert.ok(f.find('final-parent-consent-agree'), 'Another account has its own choice');
  });
});
test('auto-offer requires affirmative server eligibility, a connected chat and current AI permission', async () => {
  for (const options of [
    { ai: freshNotesOffer({ notes_offer_eligible: false }), reason: 'previously declined or withdrawn' },
    { ai: freshNotesOffer({ notes_offer_eligible: undefined }), reason: 'older backend' },
    { ai: freshNotesOffer({ conversation_id: 'another-conversation' }), reason: 'foreign record' },
    { ai: freshNotesOffer(), allowed: false, reason: 'app-level permission withdrawn' },
    { ai: freshNotesOffer(), connected: false, reason: 'disconnected chat' },
  ]) await withAlphaNotesFixture(options, async f => {
    await f.settle(); assert.equal(f.find('final-parent-consent-agree'), undefined, options.reason);
    assert.equal(requestCalls(f).length, 0);
  });
});
test('the fresh sheet does not submit after app-level AI permission was withdrawn', async () => {
  await withAlphaNotesFixture({ ai: freshNotesOffer() }, async f => {
    await f.settle();
    const approve = f.find('final-parent-consent-agree').props.onPress;
    f.local.status = 'not_allowed';
    approve(); await f.settle();
    assert.equal(requestCalls(f).length, 0);
    assert.ok(f.find('final-community-ai-permission'), 'Shows the app AI permission settings after the explicit tap');
  });
});
test('a late offer-preference read cannot make a different conversation show permission', async () => {
  const holdOfferRead = deferred();
  await withAlphaNotesFixture({ ai: freshNotesOffer(), transport: { holdOfferRead } }, async f => {
    await f.settle();
    assert.equal(f.find('final-parent-consent-agree'), undefined);
    f.addChat('conversation-B', 'parent-B', freshNotesOffer({ conversation_id: 'conversation-B', notes_offer_eligible: false }));
    f.navigateChat('conversation-B', 'parent-B'); await f.settle();
    holdOfferRead.resolve(); await f.settle();
    assert.equal(f.find('final-parent-consent-agree'), undefined);
    assert.equal(requestCalls(f).length, 0);
  });
});
const revokeCalls = f => f.calls.filter(call => call.path.includes('/ai-participation?purpose='));
function openNotesConsent(f) {
  parentHeader(f).props.onToggle(true);
  f.render();
  assert.ok(f.find('final-parent-consent-agree'), 'Notes consent sheet must be shown');
}

test('saved notes OFF callbacks cannot revoke another chat or revive after any ownership boundary', async () => {
  for (const boundary of ['chat', 'round-trip', 'blur', 'epoch', 'notice', 'account']) {
    const f = uiFixture(); try {
      await f.settle(); const oldToggle = parentHeader(f).props.onToggle;
      const b = f.addChat();
      if (boundary === 'chat' || boundary === 'round-trip') { f.navigateChat(b.conversation.conversation_id, b.conversation.parent.parent_id); await f.settle(); }
      if (boundary === 'round-trip') { f.navigateChat(conversationId, 'parent-A'); await f.settle(); }
      if (boundary === 'blur') { f.blur(); f.focus(); await f.settle(); }
      if (boundary === 'epoch') { f.ai.epoch++; for (const request of Object.values(f.ai.requests)) request.epoch++; f.poll(); await f.settle(); }
      if (boundary === 'notice') { f.ai.notice_version = 'new-notice'; for (const request of Object.values(f.ai.requests)) request.notice_version = 'new-notice'; f.poll(); await f.settle(); }
      if (boundary === 'account') { f.switchAccount(); await f.settle(); }
      oldToggle(false); await f.settle(); assert.equal(revokeCalls(f).length, 0, boundary);
      assert.equal(f.find('final-community-notice'), undefined, boundary);
      if (boundary === 'chat') {
        assert.equal(f.find('final-parent-original-1'), undefined); assert.ok(f.find('final-parent-translation-1'));
        parentHeader(f).props.onToggle(false); await f.settle(); assert.equal(revokeCalls(f).length, 1);
        assert.ok(revokeCalls(f)[0].path.includes('/conversation-B/')); assert.equal(f.ai.epoch, 0, 'A was not withdrawn by B’s current button');
      }
    } finally { f.unmount(); }
  }
});

test('in-flight withdrawal success or failure stays with its original chat and never reloads, pauses or notices the next chat', async () => {
  for (const fails of [false, true]) {
    const hold = deferred(), transport = { holdRevoke: hold, revokeError: fails ? Error('A withdrawal failed') : null }, f = uiFixture({ transport });
    try {
      await f.settle(); const oldToggle = parentHeader(f).props.onToggle;
      oldToggle(false); oldToggle(false); oldToggle(true); await f.settle(); assert.equal(revokeCalls(f).length, 1); assert.equal(f.find('final-parent-consent-agree'), undefined, 'A cached ON callback cannot race an in-flight withdrawal');
      const b = f.addChat(); f.navigateChat(b.conversation.conversation_id, b.conversation.parent.parent_id); await f.settle();
      assert.equal(f.find('final-parent-original-1'), undefined); assert.ok(f.find('final-parent-translation-1'));
      const bReads = f.calls.filter(call => call.path.includes('/conversation-B/messages?')).length;
      hold.resolve(); await f.settle(); assert.equal(f.calls.filter(call => call.path.includes('/conversation-B/messages?')).length, bReads);
      assert.equal(f.find('final-community-notice'), undefined); assert.ok(f.find('final-parent-translation-1')); assert.equal(b.ai.epoch, 0);
    } finally { hold.resolve(); f.unmount(); }
  }
});

test('saved notes consent callbacks cannot reopen a later chat, including A to B to A and blur/refocus', async () => {
  for (const boundary of ['chat', 'round-trip', 'blur']) {
    const f = uiFixture({ ai: participation({ effective: false, requests: { conversation_notes: null, translation: null } }) });
    try {
      await f.settle(); const oldNotes = parentHeader(f).props.onToggle;
      const b = f.addChat('conversation-B', 'parent-B', participation({ conversation_id: 'conversation-B', effective: false, requests: { conversation_notes: null, translation: null } }));
      if (boundary !== 'blur') { f.navigateChat(b.conversation.conversation_id, b.conversation.parent.parent_id); await f.settle(); }
      if (boundary === 'round-trip') { f.navigateChat(conversationId, 'parent-A'); await f.settle(); }
      if (boundary === 'blur') { f.blur(); f.focus(); await f.settle(); }
      oldNotes(true); await f.settle(); assert.equal(f.find('final-parent-consent-agree'), undefined, boundary); assert.equal(requestCalls(f).length, 0);
      openNotesConsent(f); assert.match(f.find('final-parent-consent-purpose').props.children, /only saves notes consent/);
    } finally { f.unmount(); }
  }
});

test('old notes Agree, Decline and Close cannot consent to or dismiss a new notes sheet in another chat', async () => {
  const f = uiFixture({ ai: participation({ effective: false, requests: { conversation_notes: null, translation: null } }) });
  try {
    await f.settle(); openNotesConsent(f);
    const oldAgree = f.find('final-parent-consent-agree').props.onPress, oldDecline = f.find('final-parent-consent-decline').props.onPress, oldClose = f.find('final-parent-consent-close').props.onPress;
    const b = f.addChat('conversation-B', 'parent-B', participation({ conversation_id: 'conversation-B', effective: false, requests: { conversation_notes: null, translation: null } }));
    f.navigateChat(b.conversation.conversation_id, b.conversation.parent.parent_id); await f.settle(); openNotesConsent(f);
    const expectedAgree = f.find('final-parent-consent-agree').props.onPress;
    oldAgree(); oldDecline(); oldClose(); await f.settle();
    assert.equal(requestCalls(f).length, 0); assert.equal(f.calls.filter(call => call.path.endsWith('/my-decision')).length, 0);
    assert.match(f.find('final-parent-consent-purpose').props.children, /only saves notes consent/); assert.equal(f.find('final-parent-consent-agree').props.disabled, false);
    expectedAgree(); await f.settle(); assert.equal(requestCalls(f).length, 1); assert.equal(requestCalls(f)[0].body.purpose, 'conversation_notes'); assert.ok(requestCalls(f)[0].path.includes('/conversation-B/'));
    assert.equal(f.ai.requests.conversation_notes, null); assert.equal(b.ai.requests.conversation_notes.my_decision, 'allow');
  } finally { f.unmount(); }
});

test(`confirmed notes consent request retires its logical key so a refusal can be followed by a fresh explicit request in the same epoch`, async () => {
  const f = uiFixture({ ai: participation({ effective: false, requests: { conversation_notes: null, translation: null } }) });
  try {
    await f.settle(); openNotesConsent(f); f.press('final-parent-consent-agree'); await f.settle();
    const first = f.ai.requests.conversation_notes; first.state = 'declined'; first.parent_decision = 'decline'; first.effective = false;
    f.poll(); await f.settle(); assert.equal(f.ai.epoch, 0); openNotesConsent(f); f.press('final-parent-consent-agree'); await f.settle();
    assert.equal(requestCalls(f).length, 2); assert.notEqual(requestCalls(f)[0].body.client_request_id, requestCalls(f)[1].body.client_request_id);
    assert.notEqual(f.ai.requests.conversation_notes.request_id, first.request_id); assert.equal(f.ai.requests.conversation_notes.state, 'pending'); assert.equal(f.ai.epoch, 0);
    f.poll(); await f.settle(); assert.equal(requestCalls(f).length, 2, 'No automatic new consent request');
  } finally { f.unmount(); }
});

test(`unknown-outcome notes consent request retries its original key; a terminal response never claims consent was requested`, async () => {
  for (const terminal of [false, true]) {
    const transport = terminal ? { nextRequestState: 'declined' } : { failRequestOnce: true };
    const f = uiFixture({ transport, ai: participation({ effective: false, requests: { conversation_notes: null, translation: null } }) });
    try {
      await f.settle(); openNotesConsent(f); f.press('final-parent-consent-agree'); await f.settle();
      assert.equal(requestCalls(f).length, 1); assert.ok(f.find('final-parent-consent-agree'), 'Unknown or terminal response cannot report success');
      assert.ok(f.find('final-community-notice'), 'Show the failure or stale response');
      f.press('final-parent-consent-agree'); await f.settle(); assert.equal(requestCalls(f).length, 2);
      if (terminal) assert.notEqual(requestCalls(f)[0].body.client_request_id, requestCalls(f)[1].body.client_request_id);
      else assert.equal(requestCalls(f)[0].body.client_request_id, requestCalls(f)[1].body.client_request_id);
      assert.equal(f.ai.requests.conversation_notes.state, 'pending'); assert.equal(f.find('final-parent-consent-agree'), undefined);
    } finally { f.unmount(); }
  }
});
