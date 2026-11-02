// Role/theme calibration from Figma48's Card/Day (55), Card/Night (100),
// Input (100), and Control (70) material hierarchy. Expo intensity is not a
// physical Figma blur radius: final native appearance still needs acceptance.
export const GLASS_BLUR48 = {
  Morning: { card: 55, message: 55, user: 55, composer: 100, pill: 70 },
  Afternoon: { card: 55, message: 55, user: 55, composer: 100, pill: 70 },
  Night: { card: 100, message: 100, user: 100, composer: 100, pill: 70 },
} as const;

// Border-box shadows stay rounded independently of translucent/blurred children.
// Legacy iOS shadow* props on transparent views derive a pixel mask from their
// descendants; nested glass controls then accumulate a conspicuous grey slab.
// Only floating surfaces/CTAs cast a subtle, outward-fading shadow. In-card
// choices are flat and express selection with their existing tint and outline.
export const GLASS_SHADOW48 = {
  surface: "0px 8px 28px -5px rgba(58,43,83,0.08)",
  floating: "0px 10px 28px -5px rgba(58,43,83,0.09)",
  button: "0px 4px 14px -3px rgba(58,43,83,0.07)",
} as const;
