/** App-local return paths only; never turn a permission screen into an open redirect. */
export function aiPermissionReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "/") return "/(tabs)";
  if (["/(tabs)", "/(tabs)/chats", "/(tabs)/profile", "/(tabs)/tasks", "/knowledge", "/daily-post", "/daily-video"].includes(value)) return value;
  // Preserve only an owned-video locator, never arbitrary query parameters.
  if (/^\/daily-video\?id=[a-zA-Z0-9_-]{1,128}$/.test(value)) return value;
  if (/^\/(chat|detail)\/[a-zA-Z0-9_-]{1,128}$/.test(value)) return value;
  return null;
}

export function aiPermissionHref(returnTo: string) {
  return { pathname: "/ai-permission" as const, params: { returnTo: aiPermissionReturnPath(returnTo) || "/(tabs)" } };
}
