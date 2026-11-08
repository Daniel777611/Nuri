import { ChildSaveError, validChildDraft, type ChildDraft } from "./onboardingChildren";
import { formatDateOnly, localDateOnly, type DateOnly } from "./child-age";
import { defaultInlineDate, usesInlineDateDefault } from "./onboardingInlineDate";

/** The UI supplies a stable, session-local key. A placeholder is never a child. */
export function blankChildDraft(key: string, expecting: boolean, today: DateOnly = localDateOnly()): ChildDraft {
  if (!key.trim()) throw new ChildSaveError("invalid");
  const date_parts = defaultInlineDate(expecting, today), birth_date = formatDateOnly(date_parts);
  return { key, expecting, nickname: "", birth_date, date_parts, date_default: birth_date, gender: "other", allergies: [], notes: "" };
}

export function cloneChildDraft(row: ChildDraft): ChildDraft {
  return { ...row, allergies: [...row.allergies], ...(row.date_parts ? { date_parts: { ...row.date_parts } } : {}) };
}

/** Existing records and partially entered details must remain visible for repair. */
export function isBlankChildDraft(row: ChildDraft): boolean {
  const untouchedDefault = usesInlineDateDefault(row);
  return !row.id && !row.nickname.trim() && (!row.birth_date || untouchedDefault) && row.gender === "other"
    && row.allergies.length === 0 && !row.notes.trim()
    && (untouchedDefault || !row.date_parts || Object.values(row.date_parts).every(value => value === null));
}

function assertUniqueDrafts(rows: readonly ChildDraft[]): void {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.key.trim() || keys.has(row.key) || (row.id !== undefined && (!row.id || ids.has(row.id)))) {
      throw new ChildSaveError("invalid");
    }
    keys.add(row.key);
    if (row.id) ids.add(row.id);
  }
}

/** Ignore only untouched new placeholders; never silently drop an invalid edit. */
export function committableChildDrafts(rows: readonly ChildDraft[], today: DateOnly = localDateOnly()): ChildDraft[] {
  assertUniqueDrafts(rows);
  const children = rows.filter(row => !isBlankChildDraft(row)).map(row => {
    const child = cloneChildDraft(row);
    if (usesInlineDateDefault(row)) {
      const date = defaultInlineDate(row.expecting, today);
      child.date_parts = date;
      child.birth_date = formatDateOnly(date);
    }
    delete child.date_default;
    return child;
  });
  if (children.some(row => !validChildDraft(row, today))) throw new ChildSaveError("invalid");
  return children;
}

/** Append in the selected category without changing any sibling or imposing a cap. */
export function appendChildDraft(rows: readonly ChildDraft[], key: string, expecting: boolean): ChildDraft[] {
  assertUniqueDrafts(rows);
  if (rows.some(row => row.key === key)) throw new ChildSaveError("invalid");
  return [...rows.map(cloneChildDraft), blankChildDraft(key, expecting)];
}

export function childDraftsInCategory(rows: readonly ChildDraft[], expecting: boolean): ChildDraft[] {
  return rows.filter(row => row.expecting === expecting).map(cloneChildDraft);
}

/** Editing takes a detached copy; Back/Skip can discard it without any writes. */
export function editableChildDraft(rows: readonly ChildDraft[], key: string): ChildDraft | undefined {
  const row = rows.find(child => child.key === key);
  return row ? cloneChildDraft(row) : undefined;
}

/** Save only the selected card's editable fields. Identity/private fields survive. */
export function commitChildDraftEdit(rows: readonly ChildDraft[], edited: ChildDraft): ChildDraft[] {
  assertUniqueDrafts(rows);
  const original = rows.find(row => row.key === edited.key);
  if (!original) throw new ChildSaveError("stale");
  const committed: ChildDraft = {
    ...original,
    nickname: edited.nickname,
    birth_date: edited.birth_date,
    ...(edited.date_parts ? { date_parts: { ...edited.date_parts } } : {}),
    ...(edited.date_default ? { date_default: edited.date_default } : {}),
    gender: edited.gender,
    allergies: [...original.allergies],
  };
  if (!edited.date_parts) delete committed.date_parts;
  if (!edited.date_default) delete committed.date_default;
  if (!validChildDraft(committed)) throw new ChildSaveError("invalid");
  return rows.map(row => row.key === edited.key ? committed : cloneChildDraft(row));
}
