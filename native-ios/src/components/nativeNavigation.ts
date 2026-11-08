export type NativeNavigationAction = "back" | "home" | "notifications" | "chat" | "community" | "profile";

type RouteRecord = { name?: unknown; params?: unknown; state?: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function chatBackPair(value: unknown, depth = 0): { current: RouteRecord; previous: RouteRecord } | null {
  const state = record(value);
  if (!state || depth > 8 || !Array.isArray(state.routes) || !Number.isInteger(state.index)) return null;
  const index = state.index as number;
  if (index < 0 || index >= state.routes.length) return null;
  const current = record(state.routes[index]);
  if (!current) return null;
  const nested = chatBackPair(current.state, depth + 1);
  if (nested) return nested;
  // A tab's previous item is not necessarily where native Back will pop.
  if (state.type !== "stack" || index === 0) return null;
  const previous = record(state.routes[index - 1]);
  return previous ? { current, previous } : null;
}

/** A generic history entry may still be Welcome/login after a chat Redirect.
 * Only an explicit reading context keeps native Back; everything else uses
 * the existing chat Home guard (recording/save/account checks stay in charge).
 * This function observes navigation only and never reads or changes auth. */
export function chatHeaderBackAction(pathname: string, rootState: unknown): "back" | "home" {
  const match = /^\/chat\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  if (!match) return "home";
  const pair = chatBackPair(rootState);
  if (!pair || pair.current.name !== "chat/[id]" || record(pair.current.params)?.id !== match[1]) return "home";
  const source = pair.previous;
  if (!["daily-post", "daily-video", "detail/[id]", "saved/[id]"].includes(String(source.name))) return "home";
  const params = source.params === undefined ? {} : record(source.params);
  if (!params) return "home";
  const id = params.id;
  if (id === undefined && (source.name === "daily-post" || source.name === "daily-video")) return "back";
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? "back" : "home";
}

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
