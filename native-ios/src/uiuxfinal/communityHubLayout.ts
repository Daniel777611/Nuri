/** Figma 188:65051 / 188:64966: 9pt dots at x=0 and x=21 in a 30pt group.
 * Separate 44pt-wide hit regions must never determine the visual spacing.
 * Their 32pt height uses the card's empty bottom padding, not the footer. */
export const HUB_PAGINATION = { width:30, height:9, dotSize:9, centerDistance:21, targetSize:44, targetHeight:32 } as const;
export const HUB_CARD_BOTTOM_GUTTER = 4;
export const HUB_PAGER_GAP = 4; // + the card gutter = Figma's 8pt visible gap.

/** Only decorative top space yields on short screens. The real text, assets
 * and row sizes stay intact; oversized text can still scroll within the card. */
export function communityHubTopPadding(pagerHeight:number, page:0|1) {
  const top=page===1?88:68;
  // Friends: intro240 + CTA50 + messages198 + 2 gaps12 + bottom16.
  // Questions: intro260 + CTA50 + divider1 + 2 rows80 + 4 gaps12 + bottom16.
  const rest=page===1?528:535;
  if(!Number.isFinite(pagerHeight)||pagerHeight<=0)return top;
  return Math.max(16,Math.min(top,pagerHeight-HUB_CARD_BOTTOM_GUTTER-rest));
}
