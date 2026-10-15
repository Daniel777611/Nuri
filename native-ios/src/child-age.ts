export type DateOnly = {
  year: number;
  month: number;
  day: number;
};

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return 0;
  }
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parse an ISO calendar date without going through JavaScript's Date parser.
 * `new Date("YYYY-MM-DD")` is interpreted as UTC and can shift to the previous
 * day in North American time zones, which makes a child's age change early.
 */
export function parseDateOnly(value: string): DateOnly | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maxDay = daysInMonth(year, month);
  if (year < 1 || maxDay === 0 || day < 1 || day > maxDay) return null;
  return { year, month, day };
}

export function formatDateOnly(value: DateOnly): string {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

export function localDateOnly(now = new Date()): DateOnly {
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  };
}

export function compareDateOnly(left: DateOnly, right: DateOnly): number {
  if (left.year !== right.year) return left.year - right.year;
  if (left.month !== right.month) return left.month - right.month;
  return left.day - right.day;
}

export function isValidBirthDate(value: string, today = localDateOnly()): boolean {
  const birth = parseDateOnly(value);
  return birth !== null && compareDateOnly(birth, today) <= 0;
}

/** Return completed calendar months, or null for an invalid/future birthday. */
export function completedAgeMonths(value: string, today = localDateOnly()): number | null {
  const birth = parseDateOnly(value);
  if (!birth || compareDateOnly(birth, today) > 0) return null;

  let months = (today.year - birth.year) * 12 + today.month - birth.month;
  // A child born on the 29th-31st completes the next calendar month on that
  // month's final day when the same day number does not exist (for example,
  // Jan 31 -> Feb 28 and Feb 29 -> Feb 28 in a non-leap year).
  const anniversaryDay = Math.min(birth.day, daysInMonth(today.year, today.month));
  if (today.day < anniversaryDay) months -= 1;
  return Math.max(0, months);
}
