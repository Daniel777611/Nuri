/** Automatic editing gets the old roomy panel; explicit expansion fills the
 * keyboard-avoiding viewport instead of using a fixed-height text area. */
export const COMPOSER_PANEL_CHROME = 76;
/** Match the single-line editor's real content width, not the wider middle
 * editor. A stable measuring width prevents expand/collapse oscillation. */
export function compactComposerTextWidth(width: number, sendVisible: boolean) {
  // Separate 60pt attachment circle + 16pt gap; pill starts with 20pt text
  // inset and reserves 44pt each for mic and the optional independent Send.
  return Number.isFinite(width) && width > 0 ? Math.max(0, width - 76 - 20 - 8 - (sendVisible ? 88 : 44)) : 0;
}
export function composerLayout(fontScale: number, availableHeight: number) {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const lineHeight = Math.ceil(24 * scale);
  const available = Number.isFinite(availableHeight) ? Math.max(0, availableHeight) : 0;
  const roomyAllowed = available >= 2 * lineHeight + COMPOSER_PANEL_CHROME;
  // Leave a message-sized glimpse above the normal editor when possible.
  // Small/landscape viewports keep native scrolling rather than overflow.
  const roomyInputHeight = Math.min(5 * lineHeight, Math.max(2 * lineHeight, Math.floor(available - COMPOSER_PANEL_CHROME - 44)));
  return { lineHeight, roomyAllowed, roomyInputHeight, roomyCardHeight: roomyInputHeight + COMPOSER_PANEL_CHROME };
}
