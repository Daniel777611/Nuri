// The web half of iOS remote push.
//
// NURI's session lives in this page, not in the native shell, so the shell never
// calls the backend. It only does two things, both through DOM events:
//
//   native → web  `nuri:apns-token`  "here is this phone's APNs token"
//   native → web  `nuri:open-route`  "the parent tapped a notification"
//   web → native  `nuri:request-apns-token` (postMessage) "send it again"
//
// The contract is private/handoff/NURI_iOS_Push_Handoff_2026-09-10.md §3.
// Registration needs both a token from the phone and a signed-in session, and
// the two arrive in either order — the token usually at launch, the session
// minutes later — so the latest token is kept and retried whenever either side
// changes. The backend upserts on the install id, so a repeat is harmless.

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { usePathname, useRouter } from "expo-router";

import { api, auth, PUSH_INSTALLATION_KEY, type PushDeviceRegistration } from "./api";
import { isPreviewMode } from "./preview-api";
import { storage } from "./utils/storage";

type NativeTokenDetail = {
  token?: unknown;
  environment?: unknown;
  installationId?: unknown;
  bundleId?: unknown;
  permissionStatus?: unknown;
  timeZone?: unknown;
  appVersion?: unknown;
  buildNumber?: unknown;
};

const TOKEN_RE = /^[0-9a-f]{32,256}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSIONS = new Set(["not_determined", "denied", "authorized", "provisional"]);

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** Turn the native event into a registration, or nothing if it is malformed. */
export function parseNativeToken(detail: NativeTokenDetail | null | undefined): PushDeviceRegistration | null {
  if (!detail) return null;
  const token = str(detail.token, 256);
  const installationId = str(detail.installationId, 64);
  const bundleId = str(detail.bundleId, 128);
  const environment = detail.environment;
  if (!token || !TOKEN_RE.test(token)) return null;
  if (!installationId || !UUID_RE.test(installationId)) return null;
  if (!bundleId) return null;
  if (environment !== "sandbox" && environment !== "production") return null;
  const permission = str(detail.permissionStatus, 32);
  let timeZone = str(detail.timeZone, 64);
  if (!timeZone) {
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timeZone = undefined;
    }
  }
  return {
    installation_id: installationId,
    platform: "ios",
    apns_token: token.toLowerCase(),
    apns_environment: environment,
    bundle_id: bundleId,
    app_version: str(detail.appVersion, 32),
    build_number: str(detail.buildNumber, 32),
    locale: typeof navigator !== "undefined" ? str(navigator.language, 32) : undefined,
    time_zone: timeZone,
    // An older shell that predates the field is treated as authorized: it only
    // obtains a token after the parent granted permission.
    permission_status: (permission && PERMISSIONS.has(permission)
      ? permission
      : "authorized") as PushDeviceRegistration["permission_status"],
  };
}

/**
 * Only `/notifications/<id>` may be opened from a notification. A payload is
 * data from outside the page, so anything else — a scheme, a traversal, a
 * different section — is refused rather than followed.
 */
export function safeNotificationRoute(route: unknown): string | null {
  if (typeof route !== "string") return null;
  if (!route.startsWith("/notifications/")) return null;
  if (route.includes("..") || route.includes("://") || route.includes("\\")) return null;
  const id = route.slice("/notifications/".length);
  return /^[0-9a-f-]{8,64}$/i.test(id) ? route : null;
}

function requestTokenFromShell() {
  const bridge = (window as unknown as { ReactNativeWebView?: { postMessage: (m: string) => void } })
    .ReactNativeWebView;
  try {
    bridge?.postMessage(JSON.stringify({ type: "nuri:request-apns-token" }));
  } catch {
    // Not inside the shell, or the shell does not listen. Nothing to do.
  }
}

export function usePushBridge() {
  const router = useRouter();
  const pathname = usePathname() || "";
  const latest = useRef<PushDeviceRegistration | null>(null);
  const registeredKey = useRef<string>("");
  const inFlight = useRef(false);
  const syncRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || isPreviewMode) return;

    const sync = async () => {
      const device = latest.current;
      if (!device || inFlight.current) return;
      const session = await auth.getToken();
      if (!session) return;
      const key = [
        session, device.installation_id, device.apns_token,
        device.apns_environment, device.permission_status, device.time_zone,
      ].join("|");
      if (key === registeredKey.current) return;
      inFlight.current = true;
      try {
        await api.registerPushDevice(device);
        registeredKey.current = key;
        await storage.setItem(PUSH_INSTALLATION_KEY, device.installation_id);
      } catch {
        // Leave the key unset so the next navigation or token retries.
      } finally {
        inFlight.current = false;
      }
    };
    syncRef.current = sync;

    const onToken = (event: Event) => {
      const parsed = parseNativeToken((event as CustomEvent<NativeTokenDetail>).detail);
      if (!parsed) return;
      latest.current = parsed;
      void sync();
    };

    const onOpenRoute = (event: Event) => {
      const route = safeNotificationRoute(
        (event as CustomEvent<{ route?: unknown }>).detail?.route,
      );
      if (route) router.push(route as never);
    };

    window.addEventListener("nuri:apns-token", onToken);
    window.addEventListener("nuri:open-route", onOpenRoute);
    // Ask once on mount in case the shell sent its token before this listener
    // existed; a shell without a token simply stays silent.
    void auth.getToken().then((t) => {
      if (t) requestTokenFromShell();
    });
    return () => {
      window.removeEventListener("nuri:apns-token", onToken);
      window.removeEventListener("nuri:open-route", onOpenRoute);
      syncRef.current = null;
    };
  }, [router]);

  // Login, logout and account switches all navigate, so a route change is the
  // moment a session may have appeared or changed hands.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || isPreviewMode) return;
    if (!latest.current) {
      void auth.getToken().then((t) => {
        if (t) requestTokenFromShell();
      });
      return;
    }
    void syncRef.current?.();
  }, [pathname]);
}
