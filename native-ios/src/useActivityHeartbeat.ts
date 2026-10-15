// Presence for the /admin usage dashboard: one beat a minute while a signed-in
// parent has the app open and is using it. The server turns beats into visits
// (see backend/usage_dashboard.py record_heartbeat) and owns the visit id; this
// hook only keeps sending the one it was last given.
//
// "Using it" differs by platform. On web a tab can sit open all day, so beats
// stop after five minutes without a pointer, key, scroll or touch. On a phone
// the screen locks itself, so being in the foreground is enough.

import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { usePathname } from "expo-router";

import { api, auth } from "./api";
import { isPreviewMode } from "./preview-api";

const BEAT_MS = 60_000;
const WEB_IDLE_MS = 5 * 60_000;
// Navigation also beats, so a visit starts right after login rather than a
// minute later — but not more often than this.
const MIN_GAP_MS = 15_000;

export function useActivityHeartbeat() {
  const pathname = usePathname() || "";
  // Someone reading the dashboard is not a parent using the app.
  const onAdmin = pathname.startsWith("/admin");
  const beatRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    beatRef.current?.();
  }, [pathname]);

  useEffect(() => {
    if (isPreviewMode || onAdmin) return;

    const isWeb = Platform.OS === "web" && typeof document !== "undefined";
    const platform = isWeb ? "web" : Platform.OS === "ios" ? "ios" : "android";
    let visitId: string | null = null;
    let disabled = false;
    let inFlight = false;
    let lastInteraction = Date.now();
    let lastBeat = 0;
    let lastToken: string | null = null;

    const inForeground = () =>
      isWeb ? document.visibilityState === "visible" : AppState.currentState === "active";
    const recentlyUsed = () => !isWeb || Date.now() - lastInteraction <= WEB_IDLE_MS;

    const beat = async (closing = false, throttled = false) => {
      if (disabled || inFlight) return;
      if (!recentlyUsed() || (!closing && !inForeground())) return;
      const token = await auth.getToken();
      if (!token) {
        visitId = null;
        lastToken = null;
        return;
      }
      // A different account (login, switch) is a new visit, beaten at once:
      // neither the throttle nor the old visit id belong to it.
      if (token !== lastToken) {
        visitId = null;
      } else if (throttled && Date.now() - lastBeat < MIN_GAP_MS) {
        return;
      }
      lastToken = token;
      inFlight = true;
      lastBeat = Date.now();
      try {
        const res = await api.heartbeat({ visit_id: visitId, platform });
        visitId = res?.visit_id ?? null;
        if (res?.disabled) disabled = true;
      } catch {
        // A missed beat only shortens a measured visit; never bother the parent.
      } finally {
        inFlight = false;
      }
    };

    const timer = setInterval(() => beat(), BEAT_MS);
    beat();
    beatRef.current = () => beat(false, true);

    const cleanups: (() => void)[] = [
      () => clearInterval(timer),
      () => {
        beatRef.current = null;
      },
    ];

    if (isWeb) {
      const noteInteraction = () => {
        const wasIdle = !recentlyUsed();
        lastInteraction = Date.now();
        // Coming back from idle starts a visit now, not at the next tick.
        if (wasIdle) beat();
      };
      const events = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"] as const;
      events.forEach((name) => window.addEventListener(name, noteInteraction, { passive: true }));
      const onVisibility = () => {
        if (document.visibilityState === "visible") {
          lastInteraction = Date.now();
          beat();
        } else {
          // Closes the visit's tail: without it a visit ends at the last
          // whole-minute beat before the tab was hidden.
          beat(true);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      cleanups.push(() => {
        events.forEach((name) => window.removeEventListener(name, noteInteraction));
        document.removeEventListener("visibilitychange", onVisibility);
      });
    } else {
      const sub = AppState.addEventListener("change", (state) => {
        if (state === "active") beat();
        else beat(true);
      });
      cleanups.push(() => sub.remove());
    }

    return () => cleanups.forEach((fn) => fn());
  }, [onAdmin]);
}
