export type NativeNavigationAction = "back" | "home" | "notifications";

type NavigationGuard = {
  pathname: string;
  navigate: (action: NativeNavigationAction) => void;
};

let currentGuard: NavigationGuard | null = null;

/** A screen with an in-flight save can finish it before leaving. */
export function registerNativeNavigationGuard(
  pathname: string,
  navigate: NavigationGuard["navigate"],
): () => void {
  const guard = { pathname, navigate };
  currentGuard = guard;
  return () => {
    if (currentGuard === guard) currentGuard = null;
  };
}

export function requestGuardedNativeNavigation(
  pathname: string,
  action: NativeNavigationAction,
): boolean {
  if (!currentGuard || currentGuard.pathname !== pathname) return false;
  currentGuard.navigate(action);
  return true;
}
