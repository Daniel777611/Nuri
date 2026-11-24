export function isCurrentNativeRelease(): boolean {
  return ["live-alpha", "early-access", "app-store"].includes(process.env.EXPO_PUBLIC_RELEASE_FLAVOR ?? "");
}
