/** Figma 188:64737: 24pt vertical padding, 44pt header and tools, two 8pt gaps.
 * Only the input scrolls; explicit expansion fills its keyboard-safe viewport. */
export const COMPOSER_PANEL_CHROME = 128;
export function composerDockBottomInset(safeBottom: number, keyboardVisible: boolean) {
  const inset = Number.isFinite(safeBottom) ? Math.max(0, safeBottom) : 0;
  return keyboardVisible ? 12 : Math.max(27,12+inset);
}
/** Match the single-line editor's real content width, not the wider middle
 * editor. A stable measuring width prevents expand/collapse oscillation. */
export function compactComposerTextWidth(width: number, sendVisible: boolean) {
  // Typed single-line frame: attachment60 + gap16; capsule H20/8,
  // 44pt mic/send targets and two 6pt gaps leave 150pt at reference width354.
  // Empty state is 8pt narrower, with gap14 and a 22pt text inset.
  return Number.isFinite(width) && width > 0
    ? Math.max(0, sendVisible ? width - 76 - 20 - 8 - 88 - 12 : width - 8 - 74 - 22 - 44 - 6)
    : 0;
}
export function composerLayout(fontScale: number, availableHeight: number) {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const lineHeight = Math.ceil(24 * scale);
  const available = Number.isFinite(availableHeight) ? Math.max(0, availableHeight) : 0;
  const roomyAllowed = available >= 2 * lineHeight + COMPOSER_PANEL_CHROME;
  // The design uses half the available area (416 -> card208/input80).
  // Large accessibility text may need more than half for two visible lines;
  // a shorter viewport stays single-line with native caret scrolling.
  const roomyCardHeight = Math.min(available, Math.max(COMPOSER_PANEL_CHROME + 2 * lineHeight, Math.floor(available / 2)));
  const roomyInputHeight = Math.max(lineHeight, roomyCardHeight - COMPOSER_PANEL_CHROME);
  return { lineHeight, roomyAllowed, roomyInputHeight, roomyCardHeight };
}
