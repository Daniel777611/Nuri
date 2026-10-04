export const NURI_WEB_ORIGIN = 'https://nurifam.app' as const;
export const INITIAL_URL = `${NURI_WEB_ORIGIN}/` as const;
export const LOAD_TIMEOUT_MS = 20_000;

export const TRUSTED_HOSTS = new Set(['nurifam.app']);
// Video players NURI embeds inside its own pages (the daily video). Allowed
// only as a frame inside a trusted page and only on their /embed/ path; a tap
// that leaves the player ("Watch on YouTube") is a top-level navigation and
// still goes to the phone's YouTube app. Without this, iOS sent the player
// itself to Safari, where YouTube refuses it (Error 153: no embedding page).
export const EMBED_FRAME_HOSTS = new Set([
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'www.youtube.com',
  'youtube.com',
]);
export const EXTERNAL_SCHEMES = new Set([
  'https:',
  'mailto:',
  'tel:',
  'facetime:',
  'maps:',
]);
export const BLOCKED_SCHEMES = new Set([
  'http:',
  'javascript:',
  'file:',
  'content:',
]);
