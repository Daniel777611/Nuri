/** Fixed public product scope for the formal-release line, for every account.
 * This is not a reviewer/account/remote-config switch. The full TestFlight
 * product remains on its separate release branch. */
export const APP_STORE_TABS = [
  { name: "home", cn: "首页", en: "Home", route: "/(tabs)" },
  { name: "chat", cn: "对话", en: "Chat", route: "/(tabs)/chats" },
] as const;

// Push-by-ID and notification preferences have existing contracts; the history
// list does not. Exclude the list, not actual delivered system notifications.
export const APP_STORE_BLOCKED_STACK_ROUTES = [
  "community", "notifications/index", "billing", "admin", "admin/logs",
  "task/[id]", "uiux48-gallery",
] as const;

export function isAppStorePathAllowed(path: string): boolean {
  const normalized = path.split(/[?#]/)[0].replace(/^\/\(tabs\)(?=\/|$)/, "") || "/";
  return !/^(?:\/community(?:\/|$)|\/notifications\/?$|\/billing(?:\/|$)|\/admin(?:\/|$)|\/tasks?(?:\/|$)|\/uiux48-gallery(?:\/|$))/.test(normalized);
}

export function appStoreNavigationRoute(action: string): string | null {
  switch (action) {
    case "home": return "/(tabs)";
    case "chat": return "/(tabs)/chats";
    case "profile": return "/(tabs)/profile";
    case "notifications": return "/notification-settings";
    default: return null;
  }
}
