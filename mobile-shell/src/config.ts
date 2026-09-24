export const NURI_WEB_ORIGIN = 'https://nurifam.app' as const;
export const INITIAL_URL = `${NURI_WEB_ORIGIN}/` as const;
export const LOAD_TIMEOUT_MS = 20_000;

export const TRUSTED_HOSTS = new Set(['nurifam.app']);
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
