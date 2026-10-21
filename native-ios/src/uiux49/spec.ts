/** Nuri-UX current shared system, not a copy of the superseded Visual tokens.
 * File N8pVfumdP3n7maTazWsIWt, global37:12752 / handoff44:12008. */
export const TYPE49 = {
  H1: { fontSize: 24, lineHeight: 32, fontWeight: "500" },
  H2: { fontSize: 20, lineHeight: 28, fontWeight: "500" },
  H3: { fontSize: 18, lineHeight: 26, fontWeight: "500" },
  Body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  Caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
} as const;
export type TextRole49 = keyof typeof TYPE49;
export const ACTIVE_THEMES49 = ["Morning", "Night"] as const;
export function normalizeTheme49(value: unknown) {
  // Existing installations can contain Afternoon; migrate to the new day mode.
  return value === "Night" ? "Night" : "Morning";
}
export function hourTheme49(hour: number) { return hour >= 5 && hour < 19 ? "Morning" : "Night"; }
export const TAB49 = { height: 64, radius: 32, padding: 8, itemHeight: 48, itemRadius: 24, gap: 4 } as const;
