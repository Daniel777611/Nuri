// Role/theme calibration from Figma48's Card/Day (55), Card/Night (100),
// Input (100), and Control (70) material hierarchy. Expo intensity is not a
// physical Figma blur radius: final native appearance still needs acceptance.
export const GLASS_BLUR48 = {
  Morning: { card: 55, message: 55, user: 55, composer: 100, pill: 70 },
  Afternoon: { card: 55, message: 55, user: 55, composer: 100, pill: 70 },
  Night: { card: 100, message: 100, user: 100, composer: 100, pill: 70 },
} as const;
