import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { usePathname, useRootNavigationState, useRouter, useSegments } from "expo-router";
import { api, auth, PUSH_INSTALLATION_KEY } from "./api";
import { storage } from "./utils/storage";
import { isPreviewMode } from "./preview-api";
import { getNativePushBridge, subscribeNativePush } from "./nativePush";
import { getAppNativePushRuntime, type NativePushRuntime, parseNativeToken } from "./nativePushRuntime";

export { parseNativeToken, safeNotificationRoute } from "./nativePushRuntime";

const authRoutes = new Set(["login", "register", "verify-email", "forgot-password", "onboarding", "welcome"]);

export function usePushBridge() {
  const router = useRouter();
  const pathname = usePathname();
  const segments = useSegments();
  const navigation = useRootNavigationState();
  const ready = Boolean(navigation?.key && segments.length && !authRoutes.has(segments[0]));
  const runtimeRef = useRef<NativePushRuntime | null>(null);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  useEffect(() => {
    const bridge = getNativePushBridge();
    if (!bridge || isPreviewMode) return;
    let disposed = false;
    let sessionRead = 0;
    let lastSession: string | null = null;
    let stateRevision = 0;
    let hasPermissionSnapshot = false;
    let permissionRevision = 0;
    const runtime = getAppNativePushRuntime({
      register: (device, session) => api.registerPushDevice(device, session),
      deactivate: (installation, session) => api.deactivatePushDevice(installation, session),
      rememberInstallation: (installation) => storage.setItem(PUSH_INSTALLATION_KEY, installation),
      storedInstallation: async () => (await storage.getItem<string | null>(PUSH_INSTALLATION_KEY, null)) || null,
      forgetInstallation: () => storage.removeItem(PUSH_INSTALLATION_KEY),
      openRoute: (route) => router.push(route as never),
    });
    runtimeRef.current = runtime;
    runtime.setNavigationReady(readyRef.current);

    const acceptState = (state: unknown, read?: number, preservePermission = false) => {
      if (disposed || (read !== undefined && read !== stateRevision) || !parseNativeToken(state)) return;
      stateRevision += 1;
      void runtime.acceptState(state, preservePermission);
    };

    const refreshSession = async () => {
      const read = ++sessionRead;
      const [session, locale] = await Promise.all([
        auth.getToken(), storage.getItem("ui_language", "zh-CN"),
      ]);
      if (!disposed && read === sessionRead) {
        runtime.setLocale(locale || "zh-CN");
        lastSession = session;
        void runtime.setSession(session);
      }
    };
    const refresh = async () => {
      await refreshSession();
      if (disposed) return;
      void auth.retryPendingPushCleanup();
      const read = stateRevision;
      const permissionRead = permissionRevision;
      await Promise.allSettled([
        bridge.requestPushRegistration().then((state) => {
          acceptState(state, read, permissionRead !== permissionRevision);
        }),
        bridge.getReminderSettings().then((settings) => {
          if (!disposed && read === stateRevision) {
            hasPermissionSnapshot = true;
            permissionRevision += 1;
            void runtime.setPermission(settings.permissionStatus);
          }
        }),
      ]);
    };
    refreshRef.current = refresh;
    const removeNative = subscribeNativePush(
      (state) => {
        acceptState(state);
      },
      (route) => runtime.receiveRoute(route),
    );
    const removeSession = auth.subscribeSessionChange((session) => {
      sessionRead += 1;
      if (lastSession && !session) {
        void bridge.clearDeliveredNotifications?.().catch(() => {});
      }
      lastSession = session;
      void runtime.setSession(session);
    });
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });

    const initialRead = stateRevision;
    void bridge.getInitialState().then((initial) => {
      if (disposed) return;
      runtime.receiveRoute(initial?.route, true);
      acceptState(initial?.pushState, initialRead, hasPermissionSnapshot);
    }).catch(() => {});
    void refresh();

    return () => {
      disposed = true;
      sessionRead += 1;
      runtime.dispose();
      removeNative();
      removeSession();
      foreground.remove();
      runtimeRef.current = null;
      refreshRef.current = null;
    };
  }, [router]);

  useEffect(() => {
    runtimeRef.current?.setNavigationReady(ready);
    void refreshRef.current?.();
  }, [pathname, ready]);
}
