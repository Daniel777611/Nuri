import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import ts from 'typescript';

// Actual production model/components with a local-calendar clock and isolated
// React/AppState/timers. No API, device settings or filesystem persistence.
const jsx = (type, props, key) => ({ type, props, key });
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
function hooks() {
  let cursor = 0, tree, live = true, stale = 0;
  const slots = [], effects = [], pending = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      slots[i].set ??= value => { if (!live) stale++; slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; };
      return [slots[i].value, slots[i].set];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!same(effects[i]?.deps, deps)) pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); },
  };
  return {
    react, render(Component, props) {
      cursor = 0; tree = Component(props);
      for (const node of nodes(tree)) if (node.type === 'ScrollView' && node.props.ref) node.props.ref.current = { scrollTo() {} };
      pending.splice(0).forEach(fn => fn()); return tree;
    },
    nodes: () => nodes(tree), find: id => nodes(tree).find(n => n.props?.testID === id), stale: () => stale,
    unmount() { live = false; for (const effect of effects) effect?.cleanup?.(); },
  };
}
function fixture({ expecting = false, row, date = [2026, 11, 7, 12], locale = 'en' } = {}) {
  let now, currentLocale = locale, sequence = 0;
  const setNow = ([year, month, day, hour = 12, minute = 0]) => {
    const value = new Date(0); value.setFullYear(year, month - 1, day); value.setHours(hour, minute, 0, 0); now = value.getTime();
  };
  setNow(date);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const timers = new Map(), listeners = new Set(), h = hooks(), changes = [];
  const timerApi = { set(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; }, clear(id) { timers.delete(id); } };
  function load(path, dependencies = {}) {
    const module = { exports: {} }, source = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    new Function('require', 'module', 'exports', 'Date', 'setTimeout', 'clearTimeout', ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText)(name => { assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency ' + name); return dependencies[name]; }, module, module.exports, Clock, timerApi.set, timerApi.clear);
    return module.exports;
  }
  const dates = load('src/child-age.ts'), inline = load('src/onboardingInlineDate.ts', { './child-age': dates });
  const children = load('src/onboardingChildren.ts', { './child-age': dates });
  const model = load('src/simplifiedOnboarding.ts', { './child-age': dates, './onboardingChildren': children, './onboardingInlineDate': inline });
  const components = load('src/uiuxfinal/InlineChildDate.tsx', {
    react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', Platform: { OS: 'ios' }, StyleSheet: { create: v => v },
      AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
      AppState: { addEventListener: (_event, listener) => { listeners.add(listener); return { remove: () => listeners.delete(listener) }; } } },
    '@/src/uiux48/Primitives': { NuriText: 'NuriText' }, '@/src/uiux48/Theme': { useNuriTheme: () => ({ outline: 'fixture', ink: 'fixture', secondary: 'fixture' }) },
    '@/src/i18n': { useT: () => ({ locale: currentLocale }), translate: (_locale, value) => value }, '@/src/child-age': dates, '@/src/onboardingInlineDate': inline,
  });
  const props = { row: row ?? model.blankChildDraft('fixture', expecting), disabled: false, onChange: next => { changes.push(structuredClone(next)); props.row = next; } };
  return { ...h, dates, inline, children, model, components, props, changes, timers, listeners, setNow,
    render: () => h.render(components.InlineChildDate, props), renderWheel: props => h.render(components.InlineDateWheel, props), column: part => h.nodes().find(node => node.type === components.InlineDateWheel && node.props.part === part),
    active(state = 'active') { for (const listener of [...listeners]) listener(state); }, setLocale(value) { currentLocale = value; },
    midnight() { const [id, timer] = [...timers].find(([, item]) => item.delay > 1000) ?? []; assert.ok(timer, 'expected scheduled local midnight'); timers.delete(id); timer.callback(); },
  };
}

test('new born and expecting cards display complete numeric today/tomorrow without mount writes or null options', () => {
  for (const expecting of [false, true]) {
    const f = fixture({ expecting }); try {
      f.render(); assert.ok(f.find('onboarding-date-default')); assert.deepEqual(f.changes, []);
      const expected = expecting ? '2026-11-08' : '2026-11-07'; assert.equal(f.props.row.birth_date, expected);
      assert.equal(f.model.isBlankChildDraft(f.props.row), true); assert.deepEqual(f.model.committableChildDrafts([f.props.row]), []);
      for (const part of ['year', 'month', 'day']) { const column = f.column(part); assert.equal(column.props.value, f.dates.parseDateOnly(expected)[part]); assert.ok(column.props.values.every(Number.isInteger)); assert.ok(!column.props.values.includes(null)); }
      assert.ok(!f.nodes().some(node => node.props?.children === '—'));
    } finally { f.unmount(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0); }
  }
});

test('naming a new row accepts exactly its displayed default, while marker/parts never enter the API payload', () => {
  for (const expecting of [false, true]) {
    const f = fixture({ expecting }); try {
      f.props.row.nickname = 'Named fixture'; f.render(); const original = structuredClone(f.props.row);
      const [ready] = f.model.committableChildDrafts([f.props.row]); assert.equal(ready.birth_date, original.birth_date); assert.equal(f.children.validChildDraft(ready), true);
      assert.equal(Object.hasOwn(ready, 'date_default'), false); assert.deepEqual(f.children.childPayload(ready), { nickname: 'Named fixture', birth_date: original.birth_date, gender: 'other', allergies: [], notes: '' });
      assert.deepEqual(f.changes, []); assert.deepEqual(f.props.row, original);
    } finally { f.unmount(); }
  }
});

test('ten new cards in each category remain discardable; default values never create phantom siblings', () => {
  const f = fixture(); try {
    let rows = []; for (const expecting of [false, true]) for (let i = 0; i < 12; i++) rows = f.model.appendChildDraft(rows, `${expecting}-${i}`, expecting);
    assert.equal(rows.length, 24); assert.equal(f.model.childDraftsInCategory(rows, false).length, 12); assert.equal(f.model.childDraftsInCategory(rows, true).length, 12);
    assert.ok(rows.every(f.model.isBlankChildDraft)); assert.deepEqual(f.model.committableChildDrafts(rows), []);
    rows[5].nickname = 'One real fixture'; assert.equal(f.model.committableChildDrafts(rows).length, 1);
  } finally { f.unmount(); }
});

test('default tomorrow survives leap years, Dec31, Gregorian year0001 and exact due-date bounds', () => {
  const f = fixture(); try {
    for (const [today, tomorrow] of [[{ year: 1, month: 1, day: 1 }, '0001-01-02'], [{ year: 2024, month: 2, day: 28 }, '2024-02-29'], [{ year: 2024, month: 2, day: 29 }, '2024-03-01'], [{ year: 2026, month: 12, day: 31 }, '2027-01-01']]) {
      assert.equal(f.dates.formatDateOnly(f.inline.defaultInlineDate(true, today)), tomorrow); assert.equal(f.dates.isValidDueDate(tomorrow, today), true);
      const row = f.model.blankChildDraft('boundary', true, today); row.nickname = 'Boundary fixture'; assert.equal(f.model.committableChildDrafts([row], today)[0].birth_date, tomorrow);
      assert.equal(f.inline.inlineDateOptions(f.inline.defaultInlineDate(true, today), true, today).days[0], f.dates.parseDateOnly(tomorrow).day);
    }
    assert.throws(() => f.inline.defaultInlineDate(true, { year: 9999, month: 12, day: 31 }), RangeError);
  } finally { f.unmount(); }
});

test('midnight refreshes untouched displayed defaults and Continue uses that same new local date, without mutating rows on a timer', () => {
  for (const expecting of [false, true]) {
    const f = fixture({ expecting, date: [2026, 12, 31, 23, 59] }); try {
      f.props.row.nickname = 'Midnight fixture'; const before = structuredClone(f.props.row); f.render();
      f.setNow([2027, 1, 1, 0, 0]); f.midnight(); f.render();
      const expected = expecting ? '2027-01-02' : '2027-01-01';
      assert.deepEqual(['year', 'month', 'day'].map(part => f.column(part).props.value), Object.values(f.dates.parseDateOnly(expected)));
      assert.equal(f.model.committableChildDrafts([f.props.row])[0].birth_date, expected); assert.deepEqual(f.props.row, before); assert.deepEqual(f.changes, []);
    } finally { f.unmount(); }
  }
});

test('foreground refresh advances untouched defaults, ignores background events, cleans all timers and listeners', async () => {
  const f = fixture({ date: [2026, 11, 7, 12] }); f.render(); const oldListener = [...f.listeners][0];
  f.setNow([2026, 11, 9, 12]); f.active('background'); f.render(); assert.equal(f.column('day').props.value, 7);
  f.active(); f.render(); assert.equal(f.column('day').props.value, 9); assert.deepEqual(f.changes, []); assert.equal(f.timers.size, 1);
  f.unmount(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0); oldListener('active'); await Promise.resolve(); assert.equal(f.stale(), 0);
});

test('manual wheel selection removes the default marker and survives locale changes, midnight and foreground without resetting', () => {
  const f = fixture(); try {
    f.props.row.nickname = 'Manual fixture'; f.render(); f.column('year').props.onSelect(2024); f.render(); f.column('month').props.onSelect(2); f.render(); f.column('day').props.onSelect(29); f.render();
    assert.equal(f.props.row.birth_date, '2024-02-29'); assert.equal(Object.hasOwn(f.props.row, 'date_default'), false); assert.equal(f.find('onboarding-date-default'), undefined);
    const before = structuredClone(f.props.row), count = f.changes.length;
    f.setLocale('zh-TW'); f.render(); f.setNow([2026, 11, 10, 0, 0]); f.midnight(); f.active(); f.render();
    assert.deepEqual(f.props.row, before); assert.equal(f.changes.length, count); assert.equal(f.column('year').props.value, 2024); assert.equal(f.column('day').props.value, 29);
  } finally { f.unmount(); }
});

test('existing valid dates, including year0001, retain identity, private fields and calendar value without defaults', () => {
  for (const birth_date of ['0001-01-01', '0099-12-31', '2000-02-29']) {
    const row = { key: 'existing', id: 'server-id', nickname: 'Existing fixture', expecting: false, birth_date, gender: 'other', allergies: ['fixture'], notes: 'private fixture' };
    const f = fixture({ row }); try {
      f.render(); assert.equal(f.find('onboarding-date-default'), undefined); assert.deepEqual(f.changes, []); assert.deepEqual(f.model.committableChildDrafts([row]), [row]);
      assert.deepEqual(['year', 'month', 'day'].map(part => f.column(part).props.value), Object.values(f.dates.parseDateOnly(birth_date)));
    } finally { f.unmount(); }
  }
});

test('invalid/partial legacy records get numeric repair presentation, never silent stored-date repair or a default marker', () => {
  for (const patch of [{ birth_date: '2026-02-29' }, { birth_date: '', date_parts: { year: 2017, month: null, day: 18 } }, { birth_date: '2017-01-18', date_parts: { year: 2017, month: null, day: 18 } }]) {
    const row = { key: 'existing', id: 'server-id', nickname: 'Legacy fixture', expecting: false, birth_date: '', gender: 'other', allergies: ['fixture'], notes: 'private fixture', ...patch };
    const before = structuredClone(row), f = fixture({ row }); try {
      f.render(); assert.equal(f.find('onboarding-date-default'), undefined); assert.ok(f.find('onboarding-date-needs-confirmation-existing'));
      assert.ok(['year', 'month', 'day'].every(part => Number.isInteger(f.column(part).props.value))); assert.deepEqual(f.props.row, before); assert.deepEqual(f.changes, []);
      assert.throws(() => f.model.committableChildDrafts([row]), { code: 'invalid' });
      f.column('day').props.onSelect(6); f.render(); assert.equal(f.children.validChildDraft(f.props.row), true); assert.equal(f.props.row.id, before.id); assert.deepEqual(f.props.row.allergies, before.allergies); assert.equal(f.props.row.notes, before.notes);
    } finally { f.unmount(); }
  }
});

test('altering or clearing any default field invalidates its marker, and review copies cannot alias original partial fields', () => {
  const f = fixture(); try {
    const row = { ...f.props.row, nickname: 'Named fixture' };
    for (const patch of [{ id: 'server-id' }, { birth_date: '' }, { date_parts: { year: 2026, month: null, day: 7 } }]) assert.equal(f.inline.usesInlineDateDefault({ ...row, ...patch }), false);
    const partial = { ...row, birth_date: '', date_parts: { year: 2017, month: null, day: 18 } };
    const copied = f.model.editableChildDraft([partial], row.key); copied.date_parts.month = 2; copied.allergies.push('local'); assert.equal(partial.date_parts.month, null); assert.deepEqual(partial.allergies, []);
    assert.throws(() => f.model.committableChildDrafts([partial]), { code: 'invalid' });
  } finally { f.unmount(); }
});

test('actual year wheel has only numeric options and a small rendering window; unmount cancels pending selection', () => {
  const f = fixture(), selected = [], props = { part: 'year', label: 'Year', values: Array.from({ length: 2026 }, (_, i) => i + 1), value: 2026, onSelect: value => selected.push(value), disabled: false, reducedMotion: true, testID: 'years' };
  try {
    f.renderWheel(props); assert.equal(f.find('years').props.accessibilityValue.text, '2026');
    assert.ok(f.nodes().filter(node => node.props?.testID?.startsWith('years-option-')).length <= 9);
    assert.ok(!f.nodes().some(node => node.props?.children === '—' || node.props?.testID === 'years-option-null'));
    const old = f.find('years').props, event = { nativeEvent: { contentOffset: { y: 11 } } };
    old.onScrollBeginDrag(); old.onScroll(event); f.renderWheel(props); assert.ok(f.find('years-option-1'));
    f.find('years').props.onScrollEndDrag(event); assert.equal(f.timers.size, 1); const lateTimer = [...f.timers.values()][0].callback;
    f.unmount(); assert.equal(f.timers.size, 0); lateTimer(); old.onMomentumScrollEnd(event); assert.deepEqual(selected, []); assert.equal(f.stale(), 0);
  } finally { f.unmount(); }
});

test('local-calendar defaults agree across UTC offsets and DST transitions without a UTC birthday shift', () => {
  const childSource = ts.transpileModule(readFileSync(new URL('../src/child-age.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const inlineSource = ts.transpileModule(readFileSync(new URL('../src/onboardingInlineDate.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const code = `const child={exports:{}};new Function('module','exports',${JSON.stringify(childSource)})(child,child.exports);const inline={exports:{}};new Function('require','module','exports',${JSON.stringify(inlineSource)})(()=>child.exports,inline,inline.exports);const values=[[2026,10,1,0,5],[2026,2,8,0,5],[2024,1,28,23,59]].map(args=>{const today=child.exports.localDateOnly(new Date(...args));return [child.exports.formatDateOnly(inline.exports.defaultInlineDate(false,today)),child.exports.formatDateOnly(inline.exports.defaultInlineDate(true,today))];});process.stdout.write(JSON.stringify(values));`;
  const outputs = ['America/Chicago', 'Pacific/Auckland', 'Pacific/Honolulu', 'UTC'].map(TZ => { const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, TZ } }); assert.equal(result.status, 0, result.stderr); return result.stdout; });
  assert.equal(new Set(outputs).size, 1); assert.deepEqual(JSON.parse(outputs[0]), [['2026-11-01', '2026-11-02'], ['2026-03-08', '2026-03-09'], ['2024-02-28', '2024-02-29']]);
});
