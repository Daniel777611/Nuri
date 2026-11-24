const appStoreId = 6818022351;
const appStoreBundleId = "com.ordashtech.nuri.nativelab";

export const appStoreUpdateURL = `https://apps.apple.com/app/id${appStoreId}`;

// StoreKit reports ISO alpha-3 codes. Apple's lookup takes alpha-2 codes.
const storefrontCountries: Readonly<Record<string, string>> = {
  aus: "au",
  bel: "be",
  can: "ca",
  deu: "de",
  esp: "es",
  fra: "fr",
  gbr: "gb",
  isr: "il",
  ita: "it",
  jpn: "jp",
  kor: "kr",
  mys: "my",
  nld: "nl",
  sgp: "sg",
  twn: "tw",
  usa: "us",
};

function parseVersion(value: unknown): number[] | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)*$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export async function findAppStoreUpdate(
  storefront: string,
  installedVersion: string,
  osVersion: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted || !/^[A-Za-z]{2,3}$/.test(storefront)) return null;
  const storefrontCode = storefront.toLowerCase();
  const country = storefrontCode.length === 2 ? storefrontCode : storefrontCountries[storefrontCode];
  const installed = parseVersion(installedVersion);
  const os = parseVersion(osVersion);
  if (!country || !installed || !os) return null;

  try {
    const response = await fetch(`https://itunes.apple.com/lookup?id=${appStoreId}&country=${country}`, {
      credentials: "omit",
      signal,
    });
    if (!response.ok || signal.aborted) return null;
    const payload: unknown = await response.json();
    if (signal.aborted || !isRecord(payload) || payload.resultCount !== 1
      || !Array.isArray(payload.results) || payload.results.length !== 1) return null;
    const release: unknown = payload.results[0];
    if (!isRecord(release) || release.trackId !== appStoreId || release.bundleId !== appStoreBundleId) return null;

    const { version, minimumOsVersion } = release;
    if (typeof version !== "string") return null;
    const published = parseVersion(version);
    const minimumOS = parseVersion(minimumOsVersion);
    if (!published || !minimumOS || compareVersions(os, minimumOS) < 0) return null;
    return compareVersions(published, installed) > 0 ? version : null;
  } catch {
    return null;
  }
}
