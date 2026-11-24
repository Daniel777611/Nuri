export type RouteMotionSnapshot = {
  path: string;
  communityScreen?: string;
  communityDepth?: number;
};

export type RouteMotionPlan = {
  key: string;
  direction: -1 | 0 | 1;
  animate: boolean;
};

function tabIndex(path: string): number | null {
  if (path === "/") return 0;
  if (path === "/chats") return 1;
  if (path === "/community") return 2;
  return null;
}

export function routeMotionKey(snapshot: RouteMotionSnapshot): string {
  return snapshot.path === "/community"
    ? `${snapshot.path}:${snapshot.communityScreen ?? "hub"}`
    : snapshot.path;
}

/** Native Stack keeps ordinary push/pop and interactive Back. Only the
 * app's tab changes and Community's local pages need a custom direction. */
export function routeMotionPlan(
  previous: RouteMotionSnapshot,
  next: RouteMotionSnapshot,
): RouteMotionPlan {
  const key = routeMotionKey(next);
  if (key === routeMotionKey(previous)) return { key, direction: 0, animate: false };
  const from = tabIndex(previous.path);
  const to = tabIndex(next.path);
  if (previous.path !== next.path && from !== null && to !== null) {
    return { key, direction: to > from ? 1 : -1, animate: true };
  }
  if (previous.path === "/community" && next.path === "/community") {
    // Hub/friends already use the real horizontal pager, which owns its motion.
    const pagerScreens = new Set(["hub", "friends", "inbox"]);
    if (pagerScreens.has(previous.communityScreen ?? "hub") && pagerScreens.has(next.communityScreen ?? "hub")) {
      return { key, direction: 0, animate: false };
    }
    const returning = (next.communityDepth ?? 0) < (previous.communityDepth ?? 0);
    return { key, direction: returning ? -1 : 1, animate: true };
  }
  return { key, direction: 0, animate: false };
}
