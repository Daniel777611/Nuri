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
