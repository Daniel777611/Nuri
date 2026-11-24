export type TestFlightChannel = "alpha" | "beta";

// Public metadata only. App Store Connect credentials stay in the release tool.
export const testFlightUpdateManifestURL = "https://raw.githubusercontent.com/Daniel777611/Nuri/nuri-ios-release-feed/releases/ios.json";
export const testFlightChannels = {
  alpha: {
    appId: "6831012896", bundleId: "com.ordashtech.nuri.beta",
    flavor: "live-alpha", releaseChannel: "live-alpha", invite: "CUkJknCQ",
  },
  beta: {
    appId: "6831131920", bundleId: "com.ordashtech.nuri.earlyaccess",
    flavor: "early-access", releaseChannel: "testflight-external", invite: "HbTR66kY",
  },
} as const;

export type TestFlightUpdate = { channel: TestFlightChannel; version: string; build: string };
export type InstalledTestFlightApp = { bundleId: string; version: string; build: string };

export function testFlightChannelForFlavor(flavor: unknown): TestFlightChannel | null {
  return flavor === "live-alpha" ? "alpha" : flavor === "early-access" ? "beta" : null;
}

export function testFlightUpdateURLs(channel: TestFlightChannel) {
  const invite = testFlightChannels[channel].invite;
  return {
    native: `itms-beta://testflight.apple.com/join/${invite}`,
    https: `https://testflight.apple.com/join/${invite}`,
  };
}

function components(value: unknown): number[] | null {
  if (typeof value !== "string" || value.length > 64 || !/^\d+(?:\.\d+){0,3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compare(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export async function findTestFlightUpdate(
  channel: TestFlightChannel,
  installed: InstalledTestFlightApp,
  osVersion: string,
  signal: AbortSignal,
  now = Date.now(),
): Promise<TestFlightUpdate | null> {
  const trusted = testFlightChannels[channel];
  const installedVersion = components(installed.version);
  const installedBuild = components(installed.build);
  const os = components(osVersion);
  if (signal.aborted || !trusted || installed.bundleId !== trusted.bundleId
      || !installedVersion || !installedBuild || !os || !Number.isFinite(now)) return null;

  try {
    const response = await fetch(testFlightUpdateManifestURL, {
      credentials: "omit", cache: "no-store", headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal,
    });
    // GitHub Raw serves JSON files as text/plain. Parsing still rejects HTML
    // error pages; MIME alone cannot establish a valid channel publication.
    if (!response.ok || signal.aborted) return null;
    const payload: unknown = await response.json();
    if (signal.aborted || !record(payload) || payload.schemaVersion !== 1 || !record(payload.channels)) return null;
    const release = payload.channels[channel];
    if (!record(release) || release.installable !== true || release.appId !== trusted.appId
        || release.bundleId !== trusted.bundleId) return null;

    const version = components(release.version), build = components(release.build);
    const minimumOS = components(release.minimumOSVersion);
    const published = timestamp(release.publishedAt);
    // A stale publication cannot keep advertising an expired TestFlight build.
    if (!version || !build || !minimumOS || published === null || published > now + 5 * 60 * 1000
        || now - published >= 90 * 24 * 60 * 60 * 1000 || compare(os, minimumOS) < 0) return null;
    if (release.expiresAt !== undefined) {
      const expires = timestamp(release.expiresAt);
      if (expires === null || expires <= now || expires <= published) return null;
    }

    const versionDifference = compare(version, installedVersion);
    if (versionDifference < 0 || (versionDifference === 0 && compare(build, installedBuild) <= 0)) return null;
    // URLs are deliberately absent: the client uses only its trusted channel link.
    return { channel, version: release.version as string, build: release.build as string };
  } catch {
    return null;
  }
}
