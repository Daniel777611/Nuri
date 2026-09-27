import { Platform } from "react-native";

/** True inside the iOS/Android shells, which inject a `ReactNativeWebView`
 *  bridge into the page (see usePushBridge.ts). A native (non-web) build of
 *  this app counts too: it can't hand off to a browser checkout either. */
export function isNativeShell(): boolean {
  if (Platform.OS !== "web") return true;
  return typeof window !== "undefined" && !!(window as any).ReactNativeWebView;
}
