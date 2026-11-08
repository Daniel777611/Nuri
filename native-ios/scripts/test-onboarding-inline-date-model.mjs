import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function load(path, dependencies = {}) {
  const module = { exports: {} };
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected model dependency: ' + name);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const age = load('src/child-age.ts');
const model = load('src/onboardingInlineDate.ts', { './child-age': age });
const today = Object.freeze({ year: 2026, month: 11, day: 7 });
const empty = () => model.inlineDateDraft('');
const select = (draft, part, value, expecting = false, date = today) => model.selectInlineDatePart(draft, part, value, expecting, date);

test('empty, malformed and impossible source dates never fabricate default values', () => {
  for (const value of ['', 'garbage', '2026-02-29', '0000-01-01', '2026-13-01', '2026-01-00']) {
    const draft = model.inlineDateDraft(value);
    assert.deepEqual(draft, { year: null, month: null, day: null });
    assert.equal(model.inlineDateValue(draft, false, today), null);
  }
  assert.deepEqual(model.inlineDateDraft('2017-01-18'), { year: 2017, month: 1, day: 18 });
  assert.deepEqual(model.inlineDateDraft('0001-01-01'), { year: 1, month: 1, day: 1 });
});

test('every partial column order remains editable and cannot commit until all three values were selected', () => {
  for (const order of [
    ['year', 'month', 'day'], ['year', 'day', 'month'], ['month', 'year', 'day'],
    ['month', 'day', 'year'], ['day', 'year', 'month'], ['day', 'month', 'year'],
  ]) {
    let state = empty();
    const values = { year: 2017, month: 1, day: 18 };
    order.forEach((part, index) => {
      const before = structuredClone(state);
      state = select(Object.freeze(state), part, values[part]);
      assert.notEqual(state, before);
      assert.equal(model.inlineDateValue(state, false, today), index === 2 ? '2017-01-18' : null);
      for (const unselected of order.slice(index + 1)) assert.equal(state[unselected], null);
    });
  }
});

test('birthday years cover the entire Gregorian range through today with no arbitrary age cutoff', () => {
  const options = model.inlineDateOptions(empty(), false, today);
  assert.equal(options.years[0], 1);
  assert.equal(options.years.at(-1), 2026);
  assert.equal(options.years.length, 2026);
  assert.ok(options.years.includes(1900));
  assert.ok(options.years.includes(2010));
  for (const value of ['0001-01-01', '0099-12-31', '1900-02-28', '2010-05-06', '2026-11-07']) {
    assert.equal(model.inlineDateValue(model.inlineDateDraft(value), false, today), value);
  }
  assert.equal(model.inlineDateValue(model.inlineDateDraft('2026-11-08'), false, today), null);
});

test('current-year birthday columns stop at today and calendar months have their real day counts', () => {
  assert.deepEqual(model.inlineDateOptions({ year: 2026, month: null, day: null }, false, today).months, [1,2,3,4,5,6,7,8,9,10,11]);
  assert.deepEqual(model.inlineDateOptions({ year: 2026, month: 11, day: null }, false, today).days, [1,2,3,4,5,6,7]);
  assert.equal(model.inlineDateOptions({ year: 2024, month: 2, day: null }, false, today).days.at(-1), 29);
  assert.equal(model.inlineDateOptions({ year: 1900, month: 2, day: null }, false, today).days.at(-1), 28);
  assert.equal(model.inlineDateOptions({ year: 2000, month: 2, day: null }, false, today).days.at(-1), 29);
  assert.equal(model.inlineDateOptions({ year: 2017, month: 4, day: null }, false, today).days.at(-1), 30);
  assert.equal(model.inlineDateOptions({ year: null, month: 2, day: null }, false, today).days.at(-1), 29);
});

test('changing year/month clamps only selected month/day, including leap and today boundaries', () => {
  assert.deepEqual(select(model.inlineDateDraft('2024-02-29'), 'year', 2025), { year: 2025, month: 2, day: 28 });
  assert.deepEqual(select(model.inlineDateDraft('2017-01-31'), 'month', 4), { year: 2017, month: 4, day: 30 });
  assert.deepEqual(select(model.inlineDateDraft('2017-12-31'), 'year', 2026), { year: 2026, month: 11, day: 7 });
  assert.deepEqual(select({ year: null, month: 2, day: null }, 'year', 1900), { year: 1900, month: 2, day: null });
  assert.deepEqual(select(empty(), 'year', 2026), { year: 2026, month: null, day: null });
  assert.deepEqual(select({ year: 2026, month: null, day: null }, 'month', 11), { year: 2026, month: 11, day: null });
  assert.deepEqual(select(model.inlineDateDraft('2017-01-31'), 'month', null), { year: 2017, month: null, day: 31 });
  assert.equal(model.inlineDateValue(select(model.inlineDateDraft('2017-01-31'), 'day', null), false, today), null);
});

test('due-date columns permit tomorrow through exactly 280 days and only intersecting current/next years', () => {
  assert.deepEqual(model.inlineDateOptions(empty(), true, today).years, [2026,2027]);
  assert.deepEqual(model.inlineDateOptions({ year: 2026, month: null, day: null }, true, today).months, [11,12]);
  assert.deepEqual(model.inlineDateOptions({ year: 2027, month: null, day: null }, true, today).months, [1,2,3,4,5,6,7,8]);
  assert.deepEqual(model.inlineDateOptions({ year: 2026, month: 11, day: null }, true, today).days, Array.from({ length: 23 }, (_, i) => i + 8));
  assert.deepEqual(model.inlineDateOptions({ year: 2027, month: 8, day: null }, true, today).days, Array.from({ length: 14 }, (_, i) => i + 1));
  for (const value of ['2026-11-08', '2027-02-18', '2027-08-14']) assert.equal(model.inlineDateValue(model.inlineDateDraft(value), true, today), value);
  for (const value of ['2026-11-07', '2026-11-06', '2027-08-15', '2099-01-01']) assert.equal(model.inlineDateValue(model.inlineDateDraft(value), true, today), null);
  assert.deepEqual(model.inlineDateOptions(empty(), true, { year: 2026, month: 1, day: 1 }).years, [2026]);
  assert.deepEqual(model.inlineDateOptions(empty(), true, { year: 2026, month: 12, day: 31 }).years, [2027]);
});

test('due-date selections preserve partial state and clamp previously chosen fields without guessing missing fields', () => {
  const bornBoundary = model.inlineDateDraft('2026-11-30');
  assert.deepEqual(select(bornBoundary, 'year', 2027, true), { year: 2027, month: 8, day: 14 });
  assert.deepEqual(select(model.inlineDateDraft('2027-01-01'), 'year', 2026, true), { year: 2026, month: 11, day: 8 });
  let state = select(empty(), 'day', 18, true);
  assert.deepEqual(state, { year: null, month: null, day: 18 });
  state = select(state, 'month', 2, true);
  assert.equal(model.inlineDateValue(state, true, today), null);
  state = select(state, 'year', 2027, true);
  assert.equal(model.inlineDateValue(state, true, today), '2027-02-18');
  const withYear = select(empty(), 'year', 2027, true);
  assert.deepEqual(withYear, { year: 2027, month: null, day: null });
});

test('explicit calendar boundaries survive DST, leap days and literal years below100 without UTC/local shifts', () => {
  for (const [date, tomorrow, latest] of [
    [{ year: 2026, month: 3, day: 7 }, '2026-03-08', '2026-12-12'],
    [{ year: 2024, month: 2, day: 28 }, '2024-02-29', '2024-12-04'],
    [{ year: 99, month: 12, day: 31 }, '0100-01-01', '0100-10-07'],
  ]) {
    assert.equal(model.inlineDateValue(model.inlineDateDraft(tomorrow), true, date), tomorrow);
    assert.equal(model.inlineDateValue(model.inlineDateDraft(latest), true, date), latest);
    assert.equal(age.isValidDueDate(latest, date), true);
  }
});

test('out-of-range/noninteger choices reject and helpers never mutate the original partial draft', () => {
  const source = Object.freeze({ year: 2026, month: 11, day: 7 });
  for (const [part, value] of [['year',0], ['year',2027], ['year',NaN], ['month',12], ['month',1.5], ['day',8]]) {
    assert.throws(() => select(source, part, value), RangeError);
    assert.deepEqual(source, { year: 2026, month: 11, day: 7 });
  }
  assert.equal(model.inlineDateValue({ year: 2026, month: 11, day: 7.5 }, false, today), null);
  assert.throws(() => model.inlineDateOptions(empty(), false, { year: 2026, month: 2, day: 30 }), RangeError);
  assert.throws(() => model.inlineDateValue(empty(), true, { year: 0, month: 1, day: 1 }), RangeError);
});

test('upper Gregorian limit has no fabricated unsupported due-date year', () => {
  const last = { year: 9999, month: 12, day: 31 };
  assert.deepEqual(model.inlineDateOptions(empty(), true, last), { years: [], months: [], days: [] });
  assert.equal(model.inlineDateValue(model.inlineDateDraft('9999-12-31'), true, last), null);
  assert.equal(model.inlineDateOptions(empty(), false, last).years.length, 9999);
});
