import { daysInMonth, formatDateOnly, isValidBirthDate, isValidDueDate, parseDateOnly, PREGNANCY_DAYS, type DateOnly } from "./child-age";

export type InlineDateDraft = { year: number | null; month: number | null; day: number | null };
export type InlineDatePart = keyof InlineDateDraft;
export type InlineDateOptions = { years: number[]; months: number[]; days: number[] };

/** Parsing an existing calendar date does not silently choose a new one. */
export function inlineDateDraft(value: string): InlineDateDraft {
  return parseDateOnly(value) ?? { year: null, month: null, day: null };
}

/** New cards show an actual valid date, without treating a render as consent
 * to create a child. Expecting always begins at the nearest future date. */
export function defaultInlineDate(expecting: boolean, today: DateOnly): DateOnly {
  assertToday(today);
  const value = expecting ? plusDays(today, 1) : { ...today };
  const iso = formatDateOnly(value);
  if (!(expecting ? isValidDueDate(iso, today) : isValidBirthDate(iso, today))) throw new RangeError("No supported default date is available.");
  return value;
}

type DefaultDateRow = { id?: string; birth_date: string; date_parts?: InlineDateDraft; date_default?: string };
/** The marker is valid only while its original generated date is untouched.
 * Editing/clearing any column invalidates it, even in an older client draft. */
export function usesInlineDateDefault(row: DefaultDateRow): boolean {
  if (row.id || !row.date_default || row.birth_date !== row.date_default) return false;
  const date = parseDateOnly(row.date_default);
  return !!date && (!row.date_parts || row.date_parts.year === date.year && row.date_parts.month === date.month && row.date_parts.day === date.day);
}

/** Numeric presentation for an incomplete legacy draft. This does not mutate
 * the draft or make it committable; a real wheel gesture is required to repair. */
export function displayInlineDateDraft(draft: InlineDateDraft, expecting: boolean, today: DateOnly): DateOnly {
  const fallback = defaultInlineDate(expecting, today);
  const pick = (value: number | null, choices: number[], defaultValue: number) => {
    if (!choices.length) throw new RangeError("No supported date column is available.");
    return Math.max(choices[0], Math.min(choices[choices.length - 1], Number.isInteger(value) ? value! : defaultValue));
  };
  const year = pick(draft.year, inlineDateOptions({ year: null, month: null, day: null }, expecting, today).years, fallback.year);
  const month = pick(draft.month, inlineDateOptions({ year, month: null, day: null }, expecting, today).months, fallback.month);
  const day = pick(draft.day, inlineDateOptions({ year, month, day: null }, expecting, today).days, fallback.day);
  return { year, month, day };
}

function assertToday(today: DateOnly): void {
  const parsed = parseDateOnly(formatDateOnly(today));
  if (!parsed || parsed.year !== today.year || parsed.month !== today.month || parsed.day !== today.day) {
    throw new RangeError("A valid explicit calendar date is required.");
  }
}

function plusDays(value: DateOnly, count: number): DateOnly {
  // UTC is calendar arithmetic only, not a conversion from local midnight.
  // setUTCFullYear preserves literal Gregorian years 1–99.
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1, value.day + count);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

function bounds(expecting: boolean, today: DateOnly): { first: DateOnly; last: DateOnly } {
  assertToday(today);
  return expecting ? { first: plusDays(today, 1), last: plusDays(today, PREGNANCY_DAYS) }
    : { first: { year: 1, month: 1, day: 1 }, last: today };
}

/** Unselected columns stay editable. Once year/month are chosen, only the
 * calendar days inside the birthday/due-date interval are offered. */
export function inlineDateOptions(draft: InlineDateDraft, expecting: boolean, today: DateOnly): InlineDateOptions {
  const { first, last } = bounds(expecting, today);
  const years = range(Math.max(1, first.year), Math.min(9999, last.year));
  const validYear = draft.year === null || Number.isInteger(draft.year) && draft.year >= Math.max(1, first.year) && draft.year <= Math.min(9999, last.year);
  const months = !validYear || years.length === 0 ? [] : range(
    draft.year === first.year ? first.month : 1,
    draft.year === last.year ? last.month : 12,
  );
  let days: number[] = [];
  if (validYear && years.length > 0) {
    if (draft.month === null) days = range(1, 31);
    else if (Number.isInteger(draft.month) && months.includes(draft.month)) {
      // Without a selected year, February29 remains an editable possibility;
      // choosing a non-leap year later clamps an already-selected day.
      const calendarEnd = daysInMonth(draft.year ?? 2000, draft.month);
      const start = draft.year === first.year && draft.month === first.month ? first.day : 1;
      const end = draft.year === last.year && draft.month === last.month ? Math.min(calendarEnd, last.day) : calendarEnd;
      days = range(start, end);
    }
  }
  return { years, months, days };
}

function clampSelected(value: number | null, choices: number[]): number | null {
  if (value === null || choices.length === 0) return null;
  return Math.min(choices[choices.length - 1], Math.max(choices[0], value));
}

/** Pure wheel selection. Only already-selected dependent columns are clamped;
 * a null month/day never becomes an invented birthday or due date. */
export function selectInlineDatePart(draft: InlineDateDraft, part: InlineDatePart, value: number | null, expecting: boolean, today: DateOnly): InlineDateDraft {
  const options = inlineDateOptions(draft, expecting, today);
  const choices = part === "year" ? options.years : part === "month" ? options.months : options.days;
  if (value !== null && (!Number.isInteger(value) || !choices.includes(value))) throw new RangeError("Date selection is outside the available column.");
  const next = { ...draft, [part]: value };
  if (part === "year") next.month = clampSelected(next.month, inlineDateOptions(next, expecting, today).months);
  if (part === "year" || part === "month") next.day = clampSelected(next.day, inlineDateOptions(next, expecting, today).days);
  return next;
}

/** Only complete, valid calendar values may be committed to a child draft. */
export function inlineDateValue(draft: InlineDateDraft, expecting: boolean, today: DateOnly): string | null {
  assertToday(today);
  if (draft.year === null || draft.month === null || draft.day === null) return null;
  if (![draft.year, draft.month, draft.day].every(Number.isInteger)) return null;
  const value = formatDateOnly({ year: draft.year, month: draft.month, day: draft.day });
  return (expecting ? isValidDueDate(value, today) : isValidBirthDate(value, today)) ? value : null;
}
