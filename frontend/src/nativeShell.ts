import { useEffect, useState } from "react";
import { Platform } from "react-native";

/** True inside the iOS/Android shells, which inject a `ReactNativeWebView`
 *  bridge into the page (see usePushBridge.ts). A native (non-web) build of
 *  this app counts too: it can't hand off to a browser checkout either. */
export function isNativeShell(): boolean {
  if (Platform.OS !== "web") return true;
  return typeof window !== "undefined" && !!(window as any).ReactNativeWebView;
}

export type ShellKind = "ios" | "android" | null;

/** Which shell this page runs in, from the user agent each shell appends. */
export function shellKind(): ShellKind {
  if (!isNativeShell() || typeof navigator === "undefined") return null;
  const ua = navigator.userAgent || "";
  if (ua.includes("NuriAndroid/")) return "android";
  if (ua.includes("NURI-Mobile-Shell/")) return "ios";
  return null;
}

/** The shell's version from its user agent, e.g. [0, 2, 10]; null in a browser. */
export function shellVersion(): number[] | null {
  if (!isNativeShell() || typeof navigator === "undefined") return null;
  const match = (navigator.userAgent || "").match(/(?:NURI-Mobile-Shell|NuriAndroid)\/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function atLeast(version: number[] | null, wanted: number[]): boolean {
  if (!version) return false;
  for (let i = 0; i < wanted.length; i += 1) {
    if ((version[i] || 0) !== wanted[i]) return (version[i] || 0) > wanted[i];
  }
  return true;
}

/**
 * Whether a YouTube player embedded in the page can play here.
 *
 * Up to 0.2.9 the iOS shell sent every non-NURI address — the player's frame
 * included — to Safari, where YouTube refuses an embed opened on its own
 * (Error 153). 0.2.10 lets the player load in place. Browsers and the Android
 * shell were never affected.
 */
export function canEmbedVideo(): boolean {
  if (shellKind() !== "ios") return true;
  return atLeast(shellVersion(), [0, 2, 10]);
}

// The shells answer `nuri:request-storefront` with a `nuri:storefront` event.
// Only the iOS shell (0.2.9+) does; the Android APK doesn't need to.
const STOREFRONT_EVENT = "nuri:storefront";
let lastStorefront: string | null = null;
if (typeof window !== "undefined") {
  window.addEventListener(STOREFRONT_EVENT, (event: Event) => {
    const code = (event as CustomEvent).detail?.countryCode;
    lastStorefront = typeof code === "string" ? code.toUpperCase() : null;
  });
}

function requestStorefront() {
  try {
    (window as any).ReactNativeWebView?.postMessage(
      JSON.stringify({ type: "nuri:request-storefront" }),
    );
  } catch {
    // An older shell ignores the request; purchases then stay hidden.
  }
}

/**
 * Whether this page may show a way to buy a membership.
 *
 * - Browser: always.
 * - iOS shell: only on the United States App Store storefront. Apple allows a
 *   button that links out to another purchase method there (App Review
 *   Guidelines 3.1.1(a)), and nowhere else without in-app purchase. The
 *   storefront comes from StoreKit via the shell; an older shell that can't
 *   say counts as "not allowed".
 * - Android shell: yes. It is distributed as an APK, outside Google Play. If it
 *   ever ships through Play, this must follow Play's US external content links
 *   program instead (enrolment, its disclosure API, reporting).
 */
export function usePurchaseAllowed(): boolean {
  const kind = shellKind();
  const [storefront, setStorefront] = useState<string | null>(lastStorefront);

  useEffect(() => {
    if (kind !== "ios") return;
    const onStorefront = (event: Event) => {
      const code = (event as CustomEvent).detail?.countryCode;
      setStorefront(typeof code === "string" ? code.toUpperCase() : null);
    };
    window.addEventListener(STOREFRONT_EVENT, onStorefront);
    requestStorefront();
    return () => window.removeEventListener(STOREFRONT_EVENT, onStorefront);
  }, [kind]);

  if (!isNativeShell()) return true;
  if (kind === "android") return true;
  if (kind === "ios") return storefront === "USA" || storefront === "US";
  return false;
}

/** Run `onReturn` whenever the parent comes back to the app or tab — after
 *  finishing a Stripe checkout in the phone's browser, for instance. */
export function useOnReturnToApp(onReturn: () => void) {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") onReturn();
    };
    document.addEventListener("visibilitychange", onVisible);
    // The iOS shell also says so explicitly: WKWebView doesn't always fire
    // visibilitychange when the whole app returns to the foreground.
    window.addEventListener("nuri:app-active", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("nuri:app-active", onReturn);
    };
  }, [onReturn]);
}
