import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Pin calendar validation independently of the machine's date/time zone.
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : [2026, 10, 6, 12])); }
}
function load(path, dependencies = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', 'Date', compiled)(name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected model dependency: ' + name);
    return dependencies[name];
  }, module, module.exports, FixtureDate);
  return module.exports;
}
const dates = load('src/child-age.ts');
const children = load('src/onboardingChildren.ts', { './child-age': dates });
const inline = load('src/onboardingInlineDate.ts', { './child-age': dates });
const model = load('src/simplifiedOnboarding.ts', { './onboardingChildren': children, './child-age': dates, './onboardingInlineDate': inline });
const filled = (key, expecting = false) => {
  const row = model.blankChildDraft(key, expecting), birth_date = expecting ? '2027-02-18' : '2017-01-18';
  delete row.date_default;
  return { ...row, nickname: (expecting ? 'Expected ' : 'Born ') + key, birth_date, date_parts: inline.inlineDateDraft(birth_date) };
};
const freeze = rows => Object.freeze(rows.map(row => Object.freeze({ ...row, allergies: Object.freeze([...row.allergies]) })));

test('initial placeholders show valid local defaults but have no sample nickname and are not persisted on Continue or skipped setup', () => {
  const born = model.blankChildDraft('born-1', false);
  const expected = model.blankChildDraft('expected-1', true);
  assert.equal(born.nickname, '');
  assert.equal(born.birth_date, '2026-11-06');
  assert.equal(expected.birth_date, '2026-11-07');
  assert.equal(born.expecting, false);
  assert.equal(expected.expecting, true);
  assert.equal(model.isBlankChildDraft(born), true);
  assert.equal(model.isBlankChildDraft(expected), true);
  assert.deepEqual(model.committableChildDrafts([born, expected]), []);
  assert.deepEqual(model.committableChildDrafts([]), []);
  assert.throws(() => model.blankChildDraft(' ', false), { code: 'invalid' });
});

test('plus adds 10+ independent cards to the selected category, with no implicit category switch or child cap', () => {
  let rows = [];
  for (let index = 1; index <= 24; index++) {
    rows = model.appendChildDraft(freeze(rows), 'born-' + index, false);
    rows = rows.map(row => row.key === 'born-' + index ? filled(row.key) : row);
  }
  const beforeExpected = structuredClone(rows);
  for (let index = 1; index <= 24; index++) {
    rows = model.appendChildDraft(freeze(rows), 'expected-' + index, true);
    rows = rows.map(row => row.key === 'expected-' + index ? filled(row.key, true) : row);
  }
  assert.deepEqual(model.childDraftsInCategory(rows, false), beforeExpected);
  assert.equal(model.childDraftsInCategory(rows, true).length, 24);
  assert.equal(rows.length, 48);
  assert.equal(new Set(rows.map(row => row.key)).size, 48);
  assert.ok(model.childDraftsInCategory(rows, false).every(row => !row.expecting && row.birth_date === '2017-01-18'));
  assert.ok(model.childDraftsInCategory(rows, true).every(row => row.expecting && row.birth_date === '2027-02-18'));
  assert.equal(model.committableChildDrafts(freeze(rows)).length, 48);
  assert.throws(() => model.appendChildDraft(rows, 'born-1', true), { code: 'invalid' });
});

test('new card is blank rather than copied from previous sibling; arrays are not aliased', () => {
  const existing = { ...filled('one'), id: 'server-one', allergies: ['fixture allergy'], notes: 'fixture note' };
  const rows = freeze([existing]);
  const added = model.appendChildDraft(rows, 'two', false);
  assert.deepEqual(added[0], existing);
  assert.equal(model.isBlankChildDraft(added[1]), true);
  assert.notEqual(added[0].allergies, rows[0].allergies);
  assert.notEqual(added[0].allergies, added[1].allergies);
  const isolated = model.childDraftsInCategory(added, false);
  isolated[0].allergies.push('local only');
  assert.deepEqual(added[0].allergies, ['fixture allergy']);
});

test('blank filtering cannot silently erase partial data, existing incomplete records, or private fields', () => {
  const blank = model.blankChildDraft('blank', false);
  for (const patch of [
    { nickname: 'Partial name', birth_date: '', date_parts: { year: 2017, month: null, day: null } },
    { birth_date: '2017-01-18' },
    { date_parts: { year: 2017, month: null, day: null } },
    { gender: 'boy' },
    { allergies: ['fixture allergy'] },
    { notes: 'fixture note' },
    { id: 'server-blank' },
  ]) {
    const row = { ...blank, ...patch };
    assert.equal(model.isBlankChildDraft(row), false, JSON.stringify(patch));
    assert.throws(() => model.committableChildDrafts([row]), { code: 'invalid' });
  }
  const original = { ...filled('one'), id: 'server-one', allergies: ['fixture allergy'], notes: 'fixture note' };
  const result = model.committableChildDrafts(freeze([blank, original]));
  assert.deepEqual(result, [original]);
  result[0].allergies.push('result only');
  assert.deepEqual(original.allergies, ['fixture allergy']);
});

test('born birthday and unborn due date reuse existing calendar validation, never category/date inference', () => {
  assert.equal(model.committableChildDrafts([filled('born'), filled('expected', true)]).length, 2);
  assert.throws(() => model.committableChildDrafts([{ ...filled('born'), birth_date: '2027-02-18' }]), { code: 'invalid' });
  assert.throws(() => model.committableChildDrafts([{ ...filled('expected', true), birth_date: '2017-01-18' }]), { code: 'invalid' });
  assert.throws(() => model.committableChildDrafts([{ ...filled('expected', true), birth_date: '2099-02-18' }]), { code: 'invalid' });
  assert.equal(model.committableChildDrafts([{ ...filled('older'), birth_date: '0001-01-01', date_parts: { year: 1, month: 1, day: 1 } }]).length, 1);
  assert.throws(() => model.committableChildDrafts([{ ...filled('leap'), birth_date: '1900-02-29' }]), { code: 'invalid' });
});

test('inline partial dates survive category copies without aliasing or inventing a committed date', () => {
  const partial = { ...model.blankChildDraft('partial', false), birth_date: '', date_parts: { year: 2017, month: null, day: null } };
  const rows = model.appendChildDraft([partial], 'expected', true);
  assert.deepEqual(rows[0].date_parts, partial.date_parts);
  assert.notEqual(rows[0].date_parts, partial.date_parts);
  const copy = model.childDraftsInCategory(rows, false)[0];
  copy.date_parts.month = 2;
  assert.equal(rows[0].date_parts.month, null);
  assert.equal(rows[0].birth_date, '');
  assert.throws(() => model.committableChildDrafts(rows), { code: 'invalid' });
  const untouched = { ...model.blankChildDraft('blank-date', false), birth_date: '', date_parts: { year: null, month: null, day: null } };
  assert.equal(model.isBlankChildDraft(untouched), true);
  assert.deepEqual(model.committableChildDrafts([untouched]), []);
});

test('review inline edit copies date parts on Save and discards them on Back without changing siblings', () => {
  const rows = [{ ...filled('one'), date_parts: { year: 2017, month: 1, day: 18 } }, filled('two')];
  const edit = model.editableChildDraft(rows, 'one');
  edit.date_parts.year = 2016;
  assert.equal(rows[0].date_parts.year, 2017);
  const saved = model.commitChildDraftEdit(rows, { ...edit, birth_date: '2016-01-18' });
  assert.deepEqual(saved[0].date_parts, { year: 2016, month: 1, day: 18 });
  assert.notEqual(saved[0].date_parts, edit.date_parts);
  assert.deepEqual(saved[1], rows[1]);
  const payload = children.childPayload(saved[0]);
  assert.equal(Object.hasOwn(payload, 'date_parts'), false);
  assert.equal(payload.birth_date, '2016-01-18');
});

test('review edit is isolated until Save; discarding Back/Skip draft leaves all committed cards intact', () => {
  const rows = freeze([
    { ...filled('one'), id: 'server-one', allergies: ['fixture allergy'], notes: 'fixture note' },
    filled('expected', true),
    filled('three'),
  ]);
  const before = structuredClone(rows);
  const edit = model.editableChildDraft(rows, 'expected');
  assert.ok(edit);
  assert.equal(edit.expecting, true);
  edit.nickname = 'Unsaved correction';
  edit.allergies.push('unsaved');
  assert.deepEqual(rows, before);
  assert.deepEqual(model.editableChildDraft(rows, 'expected'), before[1]);
  assert.equal(model.editableChildDraft(rows, 'missing'), undefined);
});

test('Save edits only selected card while retaining identity, category, hidden metadata, and sibling order', () => {
  const rows = freeze([
    { ...filled('one'), id: 'server-one', allergies: ['fixture allergy'], notes: 'fixture note' },
    filled('expected', true),
    filled('three'),
  ]);
  const edit = model.editableChildDraft(rows, 'one');
  const result = model.commitChildDraftEdit(rows, {
    ...edit,
    id: 'incorrect-new-id', expecting: true, allergies: [], notes: '',
    nickname: 'Corrected fixture', gender: 'girl', birth_date: '2010-05-06', date_parts: { year: 2010, month: 5, day: 6 },
  });
  assert.deepEqual(result.map(row => row.key), ['one', 'expected', 'three']);
  assert.deepEqual(result[0], { ...rows[0], nickname: 'Corrected fixture', gender: 'girl', birth_date: '2010-05-06', date_parts: { year: 2010, month: 5, day: 6 } });
  assert.deepEqual(result.slice(1), rows.slice(1));
  assert.equal(rows[0].nickname, 'Born one');
  assert.notEqual(result[0].allergies, rows[0].allergies);
  assert.throws(() => model.commitChildDraftEdit(rows, { ...edit, nickname: '' }), { code: 'invalid' });
  assert.throws(() => model.commitChildDraftEdit(rows, { ...edit, key: 'deleted' }), { code: 'stale' });
});

test('deleting local card and re-adding preserves siblings and appends a new blank card at the end', () => {
  const rows = [filled('one'), filled('two'), filled('three', true)];
  const afterRemove = rows.filter(row => row.key !== 'two');
  const afterAdd = model.appendChildDraft(afterRemove, 'four', false);
  assert.deepEqual(afterAdd.slice(0, 2), afterRemove);
  assert.deepEqual(afterAdd.map(row => row.key), ['one', 'three', 'four']);
  assert.equal(model.isBlankChildDraft(afterAdd[2]), true);
  assert.equal(afterAdd[2].expecting, false);
});

test('duplicate keys/identities reject before saving instead of overwriting one sibling', () => {
  assert.throws(() => model.committableChildDrafts([filled('one'), filled('one', true)]), { code: 'invalid' });
  assert.throws(() => model.committableChildDrafts([
    { ...filled('one'), id: 'same-server-id' }, { ...filled('two'), id: 'same-server-id' },
  ]), { code: 'invalid' });
  assert.throws(() => model.committableChildDrafts([{ ...filled('one'), id: '' }]), { code: 'invalid' });
  assert.throws(() => model.committableChildDrafts([{ ...filled('one'), key: ' ' }]), { code: 'invalid' });
});
