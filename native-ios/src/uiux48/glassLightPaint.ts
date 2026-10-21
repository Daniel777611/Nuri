/** Material lighting, not artwork. Continuous gradients have transparent
 * tails: no opaque white border, hard fog stripe, bitmap or looping shimmer.
 * The real backdrop blur remains a separate native BlurView beneath this. */
export function glassLightingSvg(width: number, height: number, radius: number, night: boolean, control = false): string {
  const w = Math.max(1, Math.round(width * 2) / 2);
  const h = Math.max(1, Math.round(height * 2) / 2);
  const r = Math.max(0, Math.min(radius, w / 2, h / 2) - .65);
  const rim = night ? [.46, .16, .015, .10, .34] : [.62, .22, .025, .08, .42];
  const haze = control ? .06 : night ? .12 : .10;
  const stops = (alphas: number[], color: string, offsets: number[]) => alphas.map((a, i) => `<stop offset="${offsets[i]}" stop-color="${color}" stop-opacity="${a}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="rim" x1="${night ? 0 : 1}" y1="0" x2="${night ? 1 : 0}" y2="1">${stops(rim, "#fffaf5", [0, .22, .52, .72, 1])}</linearGradient>
      <radialGradient id="light" cx="${night ? .12 : .88}" cy=".04" r=".9">${stops([haze, haze * .32, 0], "#fffaf6", [0, .42, 1])}</radialGradient>
      <radialGradient id="shade" cx="${night ? .95 : .05}" cy=".88" r=".9">${stops([night ? .085 : .06, .025, 0], "#66527c", [0, .45, 1])}</radialGradient>
      <linearGradient id="mist" x1="0" y1="1" x2="1" y2="0">${stops([0, .006, night ? .065 : .045, .012, 0], "#f7efff", [0, .24, .52, .74, 1])}</linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#light)"/>
    <rect width="${w}" height="${h}" fill="url(#shade)"/>
    <rect width="${w}" height="${h}" fill="url(#mist)"/>
    <rect x=".65" y=".65" width="${Math.max(0, w - 1.3)}" height="${Math.max(0, h - 1.3)}" rx="${r}" fill="none" stroke="url(#rim)" stroke-width="3" opacity=".13"/>
    <rect x=".65" y=".65" width="${Math.max(0, w - 1.3)}" height="${Math.max(0, h - 1.3)}" rx="${r}" fill="none" stroke="url(#rim)" stroke-width="1.1"/>
  </svg>`;
}

export const GLASS_INNER_LIGHT = {
  day: "inset 3px 5px 16px -3px rgba(102,82,124,0.075), inset -2px -3px 9px -3px rgba(255,250,245,0.22)",
  night: "inset 3px 5px 18px -3px rgba(24,19,43,0.14), inset -2px -3px 10px -3px rgba(255,250,245,0.15)",
} as const;
