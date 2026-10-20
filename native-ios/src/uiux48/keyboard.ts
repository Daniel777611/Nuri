/** Figma48 KeyboardPanel: the native keyboard owns the keys, suggestions and
 * dictation. Its accessory uses the panel material, never the chat glass fill.
 * Sources: chatKeyboard Day 1066:17682 / Night 1066:18329. */
export const IOS_KEYBOARD48 = {
  day: { appearance: "light", surface: "#e6e9ed", ink: "#3d3340" },
  night: { appearance: "dark", surface: "#262626", ink: "#f8f2f8" },
} as const;

export function iosKeyboard48(night: boolean) {
  return night ? IOS_KEYBOARD48.night : IOS_KEYBOARD48.day;
}

/** Keyboard events report screen coordinates, while the shell can start below
 * a native container. Do not paint a docked panel for a floating/hardware
 * keyboard, and never add a fixed keyboard bottom margin. */
export function keyboardPanelTop(frame: {screenY:number;height:number;width:number}|null, root: {y:number;height:number;width:number}) {
  if (!frame || frame.height <= 0 || root.height <= 0 || frame.width < root.width - 1) return null;
  const top = Math.max(0, frame.screenY - root.y);
  return top < root.height ? top : null;
}
