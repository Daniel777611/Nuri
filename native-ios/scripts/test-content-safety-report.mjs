import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function load(path, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, 'unexpected dependency: ' + name);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const policy = load('src/contentSafety.ts');
const conversationId = '10000000-0000-4000-8000-000000000001';
const messageId = '20000000-0000-4000-8000-000000000002';
const nodes = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(locale = 'en', open = async () => {}) {
  let hooks = [], cursor = 0, generation = 1, renders = 0;
  const calls = [], closes = [];
  const state = initial => {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
  };
  const ref = initial => {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = { current: initial };
    return hooks[index];
  };
  const jsx = (type, props) => ({ type, props });
  const Component = load('src/uiux48/SafetyReportCard.tsx', {
    react: { useRef: ref }, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ...Object.fromEntries(['KeyboardAvoidingView', 'Modal', 'Pressable', 'ScrollView', 'View'].map(v => [v, v])),
      Platform: { OS: 'ios' }, Linking: { openURL: async url => { calls.push(url); await open(url); } } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@/src/i18n': { useT: () => ({ locale }) },
    '@/src/useAccountState': { useAccountState: state, useAccountScope: () => {
      const owner = generation;
      return { capture: () => owner === generation ? owner : null, current: ticket => ticket === owner && owner === generation };
    } },
    '@/src/contentSafety': policy,
    './Primitives': Object.fromEntries(['AuthFrame', 'ChoiceChip', 'NuriButton', 'NuriField', 'NuriText'].map(v => [v, v])),
  }).SafetyReportCard;
  const render = () => { cursor = 0; renders++; return Component({ conversationId, messageId, onClose: () => closes.push(true) }); };
  const find = id => nodes(render()).find(n => n.props?.testID === id);
  return { render, find, calls, closes, changeAccount: () => { generation++; }, get renders() { return renders; } };
}

test('Google remains in both authentication entry points; no replacement by an inert Apple button', () => {
  for (const path of ['app/login.tsx', 'app/register.tsx']) assert.match(readFileSync(path, 'utf8'), /<GoogleSignInButton\b/);
});
test('report helper creates only a mail draft, defaults to no identifiers or conversation text', () => {
  const url = policy.safetyReportMailto({ reason: 'unsafe', note: '', includeReferences: false, conversationId, messageId });
  assert.ok(url.startsWith('mailto:contact@ordashteches.com?subject='));
  const body = decodeURIComponent(url);
  assert.doesNotMatch(body, /10000000|20000000|Bearer|access_token/);
  assert.match(body, /not automatically sent/);
});
test('references are opt-in and canonical IDs only; body and newlines cannot change recipient or subject', () => {
  const url = policy.safetyReportMailto({ reason: 'privacy', note: 'A & subject=other\nB'.repeat(100), includeReferences: true, conversationId, messageId });
  assert.match(decodeURIComponent(url), new RegExp(conversationId));
  assert.match(decodeURIComponent(url), new RegExp(messageId));
  assert.equal(url.split('&').length, 2);
  assert.ok(url.length < 1800);
  const invalid = policy.safetyReportMailto({ reason: 'other', note: '', includeReferences: true, conversationId: 'not-a-server-id', messageId: 'tmp-123' });
  assert.doesNotMatch(invalid, /not-a-server-id|tmp-123/);
  assert.throws(() => policy.safetyReportMailto({ reason: 'invented', note: '', includeReferences: false }));
});
for (const locale of ['zh-CN', 'zh-TW', 'en']) test(`${locale}: mounting, selecting, typing and closing never transmits anything`, async () => {
  const f = fixture(locale);
  f.render(); assert.deepEqual(f.calls, []);
  assert.equal(f.find('safety-include-references').props.selected, false);
  f.find('safety-reason-privacy').props.onPress();
  f.find('safety-note').props.onChangeText('isolated fixture concern');
  assert.deepEqual(f.calls, []);
  f.find('safety-close').props.onPress(); assert.equal(f.closes.length, 1);
  assert.deepEqual(f.calls, []);
  f.find('safety-open-draft').props.onPress(); await tick();
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.calls[0], /10000000|20000000/);
  assert.ok(f.find('safety-report-status'));
  const text = String(f.find('safety-report-status').props.children);
  assert.match(text, /不是送达确认|不是送達確認|not delivery confirmation/);
  assert.equal(f.find('safety-report-card').type, 'AuthFrame');
});
test('double taps open one draft and no sent/received status is invented', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture('en', async () => pending);
  const send = f.find('safety-open-draft').props.onPress;
  send(); send(); assert.equal(f.calls.length, 1);
  assert.equal(f.find('safety-open-draft').props.disabled, true);
  resolve(); await tick();
  assert.match(f.find('safety-report-status').props.children, /not delivery confirmation/);
});
test('a denied/unconfigured mail app is an explicit failure, never a report success', async () => {
  const f = fixture('en', async () => { throw Error('fixture mail failure'); });
  f.find('safety-open-draft').props.onPress(); await tick();
  assert.match(f.find('safety-report-status').props.children, /could not be opened.*not sent/);
});
test('a stale account callback cannot open an email draft', async () => {
  const f = fixture(); const send = f.find('safety-open-draft').props.onPress;
  f.changeAccount(); send(); await tick(); assert.deepEqual(f.calls, []);
});
test('confirmed AI messages have a reachable report entry, not a render-time side effect', () => {
  const chat = readFileSync('app/chat/[id].tsx', 'utf8');
  assert.match(chat, /testID=\{`chat-report-\$\{msg.id\}`\}/);
  assert.match(chat, /capture\(\) !== null\) setReportVisible\(true\)/);
  assert.match(chat, /reportVisible \? <SafetyReportCard/);
});
