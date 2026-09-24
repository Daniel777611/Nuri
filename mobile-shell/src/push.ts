import { NURI_WEB_ORIGIN } from './config';

export const PUSH_STATE_EVENT = 'nuriPushStateChanged';
export const NOTIFICATION_ROUTE_EVENT = 'nuriNotificationRouteOpened';

export type PushPermissionStatus =
  | 'not_determined'
  | 'denied'
  | 'authorized'
  | 'provisional';

export type NuriPushState = {
  token: string;
  environment: 'sandbox' | 'production';
  installationId: string;
  bundleId: 'com.ordashtech.nuri';
  permissionStatus: PushPermissionStatus;
  timeZone: string;
  appVersion: string;
  buildNumber: string;
};

export type NuriPushInitialState = {
  pushState: NuriPushState | null;
  route: string | null;
};

export type NuriReminderSettings = {
  enabled: boolean;
  intervalSeconds: number;
  permissionStatus: PushPermissionStatus;
  scheduled: boolean;
  mode: 'limited' | 'repeating';
  pendingCount: number;
  coverageSeconds: number;
};

export type NuriPushNativeModule = {
  getInitialState(): Promise<NuriPushInitialState>;
  refreshPushState(): Promise<NuriPushState | null>;
  requestPushRegistration(): Promise<NuriPushState | null>;
  getReminderSettings(): Promise<NuriReminderSettings>;
  updateReminderSettings(
    enabled: boolean,
    intervalSeconds: number,
  ): Promise<NuriReminderSettings>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

const permissionStatuses = new Set<PushPermissionStatus>([
  'not_determined',
  'denied',
  'authorized',
  'provisional',
]);

export function isNuriPushState(value: unknown): value is NuriPushState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const state = value as Partial<NuriPushState>;
  return (
    typeof state.token === 'string' &&
    /^[0-9a-f]{32,256}$/.test(state.token) &&
    (state.environment === 'sandbox' || state.environment === 'production') &&
    typeof state.installationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      state.installationId,
    ) &&
    state.bundleId === 'com.ordashtech.nuri' &&
    typeof state.permissionStatus === 'string' &&
    permissionStatuses.has(state.permissionStatus as PushPermissionStatus) &&
    typeof state.timeZone === 'string' &&
    state.timeZone.length > 0 &&
    typeof state.appVersion === 'string' &&
    typeof state.buildNumber === 'string'
  );
}

export function isTrustedWebUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === NURI_WEB_ORIGIN;
  } catch {
    return false;
  }
}

export function isAllowedNotificationRoute(route: unknown): route is string {
  if (
    typeof route !== 'string' ||
    !route.startsWith('/notifications/') ||
    route.includes('..') ||
    route.includes('://') ||
    route.includes('\\')
  ) {
    return false;
  }

  let decodedRoute = route;
  try {
    decodedRoute = decodeURIComponent(route);
  } catch {
    return false;
  }

  return !decodedRoute.includes('..') && !decodedRoute.includes('://');
}

export function notificationRouteUrl(route: string): string {
  return new URL(route, NURI_WEB_ORIGIN).toString();
}

export function buildCustomEventScript(
  eventName:
    | 'nuri:apns-token'
    | 'nuri:open-route'
    | 'nuri:reminder-settings',
  detail: NuriPushState | { route: string } | NuriReminderSettings,
): string {
  const serializedDetail = JSON.stringify(detail)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `(() => {
    window.dispatchEvent(new CustomEvent(${JSON.stringify(eventName)}, {
      detail: ${serializedDetail}
    }));
  })(); true;`;
}

export function isPushTokenRequest(message: string): boolean {
  try {
    const parsed = JSON.parse(message) as { type?: unknown };
    return parsed?.type === 'nuri:request-apns-token';
  } catch {
    return false;
  }
}
