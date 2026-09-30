import { useEffect, useRef, useState } from "react";
import { AppState, NativeModules, Platform } from "react-native";

export type ShellKind = "ios" | "android" | null;

/** Native builds identify themselves directly; no browser bridge is involved. */
export function shellKind(): ShellKind {
  return Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : null;
}

export function isNativeShell(): boolean {
  return shellKind() !== null;
}

type StorefrontBridge = { getStorefront?: () => Promise<unknown> };

/** Read StoreKit's country through the existing native bridge, failing closed. */
export async function getStorefront(): Promise<string | null> {
  if (shellKind() !== "ios") return null;
  const bridge = NativeModules.NuriPushBridge as StorefrontBridge | undefined;
  if (!bridge?.getStorefront) return null;
  try {
    const country = await bridge.getStorefront();
    if (typeof country !== "string") return null;
    const normalized = country.trim().toUpperCase();
    return /^[A-Z]{2,3}$/.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

/** Preserve the existing US storefront gate for external membership purchases. */
export function usePurchaseAllowed(): boolean {
  const kind = shellKind();
  const [storefront, setStorefront] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "ios") return;
    let disposed = false;
    let generation = 0;
    let previousState = AppState.currentState;
    const refresh = () => {
      const request = ++generation;
      setStorefront(null);
      void getStorefront().then((country) => {
        if (!disposed && request === generation) setStorefront(country);
      });
    };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previousState !== "active") refresh();
      previousState = state;
    });
    return () => {
      disposed = true;
      subscription.remove();
    };
  }, [kind]);

  if (kind === "ios") return storefront === "USA" || storefront === "US";
  return kind === "android" || Platform.OS === "web";
}

/** Refresh a screen after returning from an external browser or system UI. */
export function useOnReturnToApp(onReturn: () => void) {
  const callback = useRef(onReturn);
  callback.current = onReturn;
  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previousState !== "active") callback.current();
      previousState = state;
    });
    return () => subscription.remove();
  }, []);
}
