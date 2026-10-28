// iOS and web: no Android push. The real bridge is androidPushBridge.android.ts,
// which Metro picks for Android builds only, so expo-notifications never loads
// (or links) into the iOS app, whose own APNs bridge owns notifications.
import type { NativePushBridge } from "./nativePush";

export const ANDROID_PACKAGE = "com.ordashtech.nuri";
export const androidPushBridge: NativePushBridge | null = null;
export function subscribeAndroidPush(_onState: (state: unknown) => void, _onRoute: (route: unknown) => void): () => void {
  return () => {};
}
