import {
  BLOCKED_SCHEMES,
  EXTERNAL_SCHEMES,
  TRUSTED_HOSTS,
} from './config';

export type NavigationDecision =
  | { action: 'allow' }
  | { action: 'external'; url: string }
  | { action: 'block'; reason: string };

export function decideNavigation(rawUrl: string): NavigationDecision {
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

  if (EXTERNAL_SCHEMES.has(scheme)) {
    return { action: 'external', url: parsed.toString() };
  }

  return { action: 'block', reason: 'unknown_scheme_or_host' };
}
