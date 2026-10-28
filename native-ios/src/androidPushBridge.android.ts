// Android's half of the native push bridge, the same contract as the iOS
// NuriPushBridge (native/NuriPushBridge.swift) so usePushBridge.native.ts and
// the push runtime need no branch. FCM supplies the token through
// expo-notifications. The backend's FCM messages name the "nuri_care" channel
// and carry the tapped page as `route` in their data.
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import type { NativePushBridge, NativeReminderSettings } from "./nativePush";
import type { NativePushState } from "./nativePushRuntime";
import { storage } from "./utils/storage";

export const ANDROID_PACKAGE = "com.ordashtech.nuri";
/** Must match backend/push_fcm.py CARE_CHANNEL_ID. */
const CARE_CHANNEL_ID = "nuri_care";
const INSTALLATION_KEY = "android_push_installation_id";

let channelReady: Promise<unknown> | null = null;
function ensureChannel() {
  channelReady ??= Notifications.setNotificationChannelAsync(CARE_CHANNEL_ID, {
    name: "NURI",
    importance: Notifications.AndroidImportance.HIGH,
  }).catch(() => { channelReady = null; });
  return channelReady;
}

function uuid(): string {
  const bytes = new Uint8Array(16);
  (globalThis.crypto ?? { getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) })
    .getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function installationId(): Promise<string> {
  const saved = await storage.getItem<string | null>(INSTALLATION_KEY, null);
  if (saved) return saved;
  const created = uuid();
  await storage.setItem(INSTALLATION_KEY, created);
  return created;
}

function permissionOf(p: Notifications.NotificationPermissionsStatus): NativePushState["permissionStatus"] {
  if (p.granted) return "authorized";
  return p.canAskAgain ? "not_determined" : "denied";
}

async function stateFor(permission: Notifications.NotificationPermissionsStatus): Promise<(NativePushState & { platform: "android" }) | null> {
  if (!permission.granted) return null;
  await ensureChannel();
  const token = await Notifications.getDevicePushTokenAsync();
  if (typeof token.data !== "string" || !token.data) return null;
  return {
    platform: "android",
    token: token.data,
    environment: "production",
    installationId: await installationId(),
    bundleId: ANDROID_PACKAGE,
    permissionStatus: permissionOf(permission),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    appVersion: Constants.expoConfig?.version ?? "",
    buildNumber: String(Constants.expoConfig?.android?.versionCode ?? ""),
  };
}

function routeOf(response: Notifications.NotificationResponse | null | undefined): string | null {
  const route = response?.notification.request.content.data?.route;
  return typeof route === "string" ? route : null;
}

async function reminderSettings(): Promise<NativeReminderSettings> {
  // Local test reminders are an iOS tester feature; Android only reports access.
  return {
    enabled: false, intervalSeconds: 0, scheduled: false, mode: "limited", pendingCount: 0, coverageSeconds: 0,
    permissionStatus: permissionOf(await Notifications.getPermissionsAsync()),
  };
}

export const androidPushBridge: NativePushBridge = {
  async getInitialState() {
    const [pushState, response] = await Promise.all([
      Notifications.getPermissionsAsync().then(stateFor).catch(() => null),
      Notifications.getLastNotificationResponseAsync().catch(() => null),
    ]);
    return { pushState, route: routeOf(response) };
  },
  refreshPushState: () => Notifications.getPermissionsAsync().then(stateFor),
  async requestPushRegistration() {
    await ensureChannel();
    const current = await Notifications.getPermissionsAsync();
    const permission = current.granted || !current.canAskAgain ? current : await Notifications.requestPermissionsAsync();
    return stateFor(permission);
  },
  clearDeliveredNotifications: () => Notifications.dismissAllNotificationsAsync(),
  getReminderSettings: reminderSettings,
  updateReminderSettings: async () => { throw new Error("本地测试提醒只在 iOS 测试版提供。"); },
  addListener: () => {},
  removeListeners: () => {},
};

/** Token rotations and tapped notifications, as the iOS bridge emits them. */
export function subscribeAndroidPush(onState: (state: unknown) => void, onRoute: (route: unknown) => void): () => void {
  const token = Notifications.addPushTokenListener(() => {
    void androidPushBridge.refreshPushState().then(onState).catch(() => {});
  });
  const tapped = Notifications.addNotificationResponseReceivedListener((response) => onRoute(routeOf(response)));
  return () => { token.remove(); tapped.remove(); };
}
