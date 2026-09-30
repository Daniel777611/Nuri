import { Linking, NativeEventEmitter, NativeModules, Platform } from "react-native";
import { parseNativeToken, type NativePushState } from "./nativePushRuntime";

export type { NativePushState } from "./nativePushRuntime";
export const MAX_LOCAL_REMINDER_INTERVAL_SECONDS = 31_536_000;
export type NativeReminderSettings = {
  enabled: boolean;
  intervalSeconds: number;
  permissionStatus: NativePushState["permissionStatus"];
  scheduled: boolean;
  mode: "limited" | "repeating";
  pendingCount: number;
  coverageSeconds: number;
};

export type NativePushBridge = {
  getInitialState(): Promise<{ pushState: NativePushState | null; route: string | null }>;
  refreshPushState(): Promise<NativePushState | null>;
  requestPushRegistration(): Promise<NativePushState | null>;
  clearDeliveredNotifications(): Promise<void>;
  getReminderSettings(): Promise<NativeReminderSettings>;
  updateReminderSettings(enabled: boolean, intervalSeconds: number): Promise<NativeReminderSettings>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

export function getNativePushBridge(): NativePushBridge | null {
  return Platform.OS === "ios" ? NativeModules.NuriPushBridge || null : null;
}

function requireBridge(): NativePushBridge {
  const bridge = getNativePushBridge();
  if (!bridge) throw new Error("原生通知模块尚未加载，请使用 NURI iOS 测试版本。");
  return bridge;
}

export function subscribeNativePush(
  onState: (state: unknown) => void,
  onRoute: (route: unknown) => void,
): () => void {
  const bridge = requireBridge();
  const emitter = new NativeEventEmitter(bridge);
  const state = emitter.addListener("nuriPushStateChanged", onState);
  const route = emitter.addListener("nuriNotificationRouteOpened", (event) => onRoute(event?.route));
  return () => { state.remove(); route.remove(); };
}

export async function requestNotificationPermission(): Promise<NativePushState | null> {
  const state = await requireBridge().requestPushRegistration();
  return parseNativeToken(state) ? state : null;
}

export async function openNotificationSettings(): Promise<void> {
  await Linking.openSettings();
}

/** These settings control local tester reminders, never backend APNs cadence. */
export async function getReminderSettings(): Promise<NativeReminderSettings> {
  return requireBridge().getReminderSettings();
}

export async function setReminderSettings(enabled: boolean, intervalSeconds: number): Promise<NativeReminderSettings> {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > MAX_LOCAL_REMINDER_INTERVAL_SECONDS) {
    throw new Error("本地测试提醒间隔须为 1 至 31536000 秒的整数。");
  }
  return requireBridge().updateReminderSettings(enabled, intervalSeconds);
}
