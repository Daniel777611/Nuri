import {
  BLOCKED_SCHEMES,
  EMBED_FRAME_HOSTS,
  EXTERNAL_SCHEMES,
  TRUSTED_HOSTS,
} from './config';

export type NavigationDecision =
  | { action: 'allow' }
  | { action: 'external'; url: string }
  | { action: 'block'; reason: string };

/**
 * `isTopFrame` is false for a frame inside the page (an <iframe>). Only the
 * video players in EMBED_FRAME_HOSTS may load there; any other frame follows
 * the same rules as a top-level navigation.
 */
export function decideNavigation(rawUrl: string, isTopFrame = true): NavigationDecision {
  if (
    rawUrl === 'about:blank' ||
    rawUrl.startsWith('blob:') ||
    rawUrl.startsWith('data:')
  ) {
    return { action: 'allow' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { action: 'block', reason: 'invalid_url' };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (BLOCKED_SCHEMES.has(scheme)) {
    return { action: 'block', reason: 'blocked_scheme' };
  }

  if (scheme === 'https:' && TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())) {
    if (parsed.port && parsed.port !== '443') {
      return { action: 'block', reason: 'unexpected_port' };
    }
    if (parsed.username || parsed.password) {
      return { action: 'block', reason: 'url_credentials' };
    }
    return { action: 'allow' };
  }

  if (
    !isTopFrame &&
    scheme === 'https:' &&
    EMBED_FRAME_HOSTS.has(parsed.hostname.toLowerCase()) &&
    parsed.pathname.startsWith('/embed/') &&
    !parsed.port &&
    !parsed.username &&
    !parsed.password
  ) {
    return { action: 'allow' };
  }

  if (EXTERNAL_SCHEMES.has(scheme)) {
    return { action: 'external', url: parsed.toString() };
  }

  return { action: 'block', reason: 'unknown_scheme_or_host' };
}
