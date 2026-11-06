/** UTF-16 selections match UIKit/RN/DOM. Edits never split a grapheme. */
export type KeyboardSelection = { start: number; end: number };
export type KeyboardEdit = { value: string; selection: KeyboardSelection; inserted: string };

type Segment = { segment: string; index: number };
type Segmenter = { segment(value: string): Iterable<Segment> };
const SegmenterClass = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter }).Segmenter;
const segmenter = SegmenterClass ? new SegmenterClass(undefined, { granularity: "grapheme" }) : null;
const mark = /\p{Mark}/u;
const extend = (value: string) => mark.test(value) || /[\uFE00-\uFE0F]/u.test(value) || (() => {
  const point = value.codePointAt(0)!;
  return point >= 0x1f3fb && point <= 0x1f3ff || point >= 0xe0020 && point <= 0xe007f || point >= 0xe0100 && point <= 0xe01ef;
})();
const regional = (value: string) => { const point = value.codePointAt(0)!; return point >= 0x1f1e6 && point <= 0x1f1ff; };

/** Intl is preferred. The fallback covers combining marks, emoji modifiers,
 * variation selectors, ZWJ families, flags, tag sequences and CRLF on Hermes
 * builds without Intl.Segmenter; it does not guess from UTF-16 code units. */
export function keyboardGraphemes(value: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(value), item => item.segment);
  const output: string[] = [];
  let previous = "", regionalRun = 0;
  for (const point of value) {
    const last = output.length - 1;
    const join = last >= 0 && (extend(point) || point === "\u200d" || previous === "\u200d" || previous === "\r" && point === "\n" || regional(point) && regionalRun % 2 === 1);
    if (join) output[last] += point; else output.push(point);
    regionalRun = regional(point) ? regionalRun + 1 : 0;
    previous = point;
  }
  return output;
}

function boundary(value: string, offset: number, forward: boolean) {
  let cursor = 0;
  for (const grapheme of keyboardGraphemes(value)) {
    const next = cursor + grapheme.length;
    if (offset > cursor && offset < next) return forward ? next : cursor;
    cursor = next;
  }
  return offset;
}

export function keyboardSelection(value: string, selection: KeyboardSelection): KeyboardSelection {
  const clamp = (position: number) => Number.isFinite(position) ? Math.max(0, Math.min(value.length, Math.trunc(position))) : value.length;
  const a = clamp(selection.start), b = clamp(selection.end);
  if (a === b) { const point = boundary(value, a, false); return { start: point, end: point }; }
  return { start: boundary(value, Math.min(a, b), false), end: boundary(value, Math.max(a, b), true) };
}

export function replaceKeyboardSelection(value: string, selection: KeyboardSelection, insert: string, maxLength?: number): KeyboardEdit {
  const range = keyboardSelection(value, selection);
  const limit = typeof maxLength === "number" && Number.isFinite(maxLength) ? Math.max(0, Math.trunc(maxLength)) : Infinity;
  const available = Math.max(0, limit - (value.length - (range.end - range.start)));
  let inserted = "";
  for (const grapheme of keyboardGraphemes(insert)) { if (inserted.length + grapheme.length > available) break; inserted += grapheme; }
  const text = value.slice(0, range.start) + inserted + value.slice(range.end);
  const caret = range.start + inserted.length;
  return { value: text, selection: { start: caret, end: caret }, inserted };
}

export function deleteKeyboardSelection(value: string, selection: KeyboardSelection): KeyboardEdit {
  const range = keyboardSelection(value, selection);
  if (range.start !== range.end || range.start === 0) return replaceKeyboardSelection(value, range, "");
  let cursor = 0, previous = 0;
  for (const grapheme of keyboardGraphemes(value)) { if (cursor >= range.start) break; previous = cursor; cursor += grapheme.length; }
  return replaceKeyboardSelection(value, { start: previous, end: range.end }, "");
}
