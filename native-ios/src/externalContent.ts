// External recommendations are links, not copies of the source. Never dispatch
// credentials, executable schemes, local-network targets or arbitrary URL ports.
export function externalSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[")
      || ["localhost", "local", "internal", "lan", "home"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
    let containsCredential = false;
    url.searchParams.forEach((_value, key) => {
      if (/^(access_token|refresh_token|authorization|password|api_key|apikey|jwt)$/i.test(key)) containsCredential = true;
    });
    if (containsCredential) return null;
    return url.href;
  } catch { return null; }
}

export function externalSourceHost(value: unknown): string {
  const source = externalSourceUrl(value);
  return source ? new URL(source).hostname : "";
}

const FACEBOOK_POST_ID = /^(?:\d+|pfbid[A-Za-z0-9_-]+)$/i;
const FACEBOOK_GROUP_POST_PATH = /^\/groups\/[^/]+\/(?:posts|permalink)\/([^/]+)\/?$/i;
const FACEBOOK_PAGE_POST_PATH = /^(?:\/[^/]+)?\/(?:posts?|videos)\/(?:[^/]+\/)?([^/]+)\/?$/i;

export function dailyPostSourceUrl(value: unknown): string | null {
  const source = externalSourceUrl(value);
  if (!source) return null;
  const url = new URL(source);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "facebook.com" && host !== "fb.com" && !host.endsWith(".facebook.com")) return source;

  const path = url.pathname.replace(/\/$/, "");
  if (/^\/groups(?:\/|$)/i.test(path)) {
    const postId = FACEBOOK_GROUP_POST_PATH.exec(path)?.[1] ?? "";
    return FACEBOOK_POST_ID.test(postId) ? source : null;
  }
  const postId = FACEBOOK_PAGE_POST_PATH.exec(path)?.[1] ?? "";
  if (FACEBOOK_POST_ID.test(postId) || /^\/(?:share\/[pvr]\/[A-Za-z0-9_-]+|reel\/\d+)$/i.test(path)) return source;

  // Query-based Facebook links need an identifier to resolve to a single item.
  if (/^\/(?:permalink|story)\.php$/i.test(path)) {
    return FACEBOOK_POST_ID.test(url.searchParams.get("story_fbid") ?? "") ? source : null;
  }
  if (/^\/photo(?:\.php)?$/i.test(path)) {
    return FACEBOOK_POST_ID.test(url.searchParams.get("fbid") ?? "") ? source : null;
  }
  if (/^\/watch$/i.test(path)) {
    return /^\d+$/.test(url.searchParams.get("v") ?? "") ? source : null;
  }
  return null;
}
