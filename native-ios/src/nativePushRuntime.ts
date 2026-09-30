import type { PushDeviceRegistration } from "./api";

export type NativePushState = {
  token: string;
  environment: "sandbox" | "production";
  installationId: string;
  bundleId: string;
  permissionStatus: PushDeviceRegistration["permission_status"];
  timeZone: string;
  appVersion: string;
  buildNumber: string;
};

const permissions = new Set(["not_determined", "denied", "authorized", "provisional"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseNativeToken(detail: unknown): PushDeviceRegistration | null {
  if (!detail || typeof detail !== "object") return null;
  const value = detail as Partial<NativePushState>;
  if (typeof value.token !== "string" || !/^[0-9a-f]{32,256}$/i.test(value.token)) return null;
  if (typeof value.installationId !== "string" || !uuid.test(value.installationId)) return null;
  if (value.bundleId !== "com.ordashtech.nuri") return null;
  if (value.environment !== "sandbox" && value.environment !== "production") return null;
  if (!value.permissionStatus || !permissions.has(value.permissionStatus)) return null;
  return {
    installation_id: value.installationId,
    platform: "ios",
    apns_token: value.token.toLowerCase(),
    apns_environment: value.environment,
    bundle_id: value.bundleId,
    permission_status: value.permissionStatus,
    time_zone: typeof value.timeZone === "string" ? value.timeZone.slice(0, 64) : undefined,
    app_version: typeof value.appVersion === "string" ? value.appVersion.slice(0, 32) : undefined,
    build_number: typeof value.buildNumber === "string" ? value.buildNumber.slice(0, 32) : undefined,
  };
}

export function safeNotificationRoute(route: unknown): string | null {
  if (typeof route !== "string" || !route.startsWith("/notifications/")) return null;
  const id = route.slice("/notifications/".length);
  return /^[0-9a-f-]{8,64}$/i.test(id) ? route : null;
}

type RuntimeDependencies = {
  register: (device: PushDeviceRegistration, session: string) => Promise<unknown>;
  deactivate: (installationId: string, session: string) => Promise<unknown>;
  rememberInstallation: (installationId: string) => Promise<unknown>;
  storedInstallation: () => Promise<string | null>;
  forgetInstallation: () => Promise<unknown>;
  openRoute: (route: string) => void;
  now?: () => number;
};

/** One serial writer owns APNs registration across permission/account changes. */
export class NativePushRuntime {
  private device: PushDeviceRegistration | null = null;
  private permission: NativePushState["permissionStatus"] | null = null;
  private locale = "zh-CN";
  private session: string | null = null;
  private revision = 0;
  private registeredKey = "";
  private cleanups: { installation: string; session: string }[] = [];
  private dirty = false;
  private running: Promise<void> | null = null;
  private disposed = false;
  private navigationReady = false;
  private pendingRoute: string | null = null;
  private pendingForLogin = false;
  private lastOpened: { route: string; time: number } | null = null;

  constructor(private readonly deps: RuntimeDependencies) {}

  setSession(session: string | null) {
    if (this.session !== session) {
      if (this.session && this.device) {
        this.enqueueCleanup(this.device.installation_id, this.session);
      }
      if (this.session && !session && !this.pendingForLogin) this.pendingRoute = null;
      this.session = session;
      this.revision += 1;
      this.registeredKey = "";
    }
    this.flushRoute();
    return this.sync();
  }

  private enqueueCleanup(installation: string, session: string) {
    if (!this.cleanups.some((entry) => entry.installation === installation && entry.session === session)) {
      this.cleanups.push({ installation, session });
    }
  }

  attachRouteHandler(openRoute: (route: string) => void) {
    this.deps.openRoute = openRoute;
    this.disposed = false;
  }

  setNavigationReady(ready: boolean) {
    this.navigationReady = ready;
    this.flushRoute();
  }

  setLocale(locale: string) {
    if (["zh-CN", "zh-TW", "en"].includes(locale)) this.locale = locale;
  }

  acceptState(state: unknown, preservePermission = false) {
    const device = parseNativeToken(state);
    if (!device) return Promise.resolve();
    this.device = device;
    if (!preservePermission) this.permission = device.permission_status;
    return this.sync();
  }

  setPermission(permission: NativePushState["permissionStatus"]) {
    if (!permissions.has(permission)) return Promise.resolve();
    this.permission = permission;
    return this.sync();
  }

  receiveRoute(value: unknown, waitForLogin = !this.session) {
    const route = safeNotificationRoute(value);
    if (!route || this.disposed) return;
    const now = (this.deps.now || Date.now)();
    if (this.lastOpened?.route === route && now - this.lastOpened.time < 2000) return;
    this.pendingRoute = route;
    this.pendingForLogin = waitForLogin;
    this.flushRoute();
  }

  private flushRoute() {
    if (this.disposed || !this.session || !this.navigationReady || !this.pendingRoute) return;
    const route = this.pendingRoute;
    this.pendingRoute = null;
    this.pendingForLogin = false;
    this.lastOpened = { route, time: (this.deps.now || Date.now)() };
    this.deps.openRoute(route);
  }

  sync(): Promise<void> {
    this.dirty = true;
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
        if (this.dirty) void this.sync();
      });
    }
    return this.running;
  }

  private async drain() {
    while (this.dirty) {
      this.dirty = false;
      try { await this.syncOnce(); } catch {
        // Retry on the next session, route, token or foreground event.
      }
    }
  }

  private async flushCleanups() {
    while (this.cleanups.length) {
      // The API owns bounded failed-cleanup retries for the whole app. Drop
      // this local copy before awaiting so old JWTs do not live in two queues.
      const cleanup = this.cleanups.shift()!;
      try {
        await this.deps.deactivate(cleanup.installation, cleanup.session);
      } catch (error) {
        const status = (error as { status?: number } | null)?.status;
        // A retired JWT or an installation already reassigned to the next
        // account cannot be deleted by this owner. Allow its next upsert.
        if (status !== 401 && status !== 403 && status !== 404) throw error;
      }
    }
  }

  private async syncOnce() {
    await this.flushCleanups();
    const session = this.session;
    const revision = this.revision;
    const device = this.device;
    const permission = this.permission;
    if (!session) return;
    if (permission === "denied") {
      const id = device?.installation_id || await this.deps.storedInstallation();
      if (!id || revision !== this.revision) return;
      const key = JSON.stringify([session, id, "denied"]);
      if (key === this.registeredKey) return;
      await this.deps.deactivate(id, session);
      if (revision === this.revision && this.permission === "denied") {
        await this.deps.forgetInstallation();
        this.registeredKey = key;
      }
      return;
    }
    if (!device || (permission !== "authorized" && permission !== "provisional")) return;
    const registration = { ...device, permission_status: permission, locale: this.locale };
    const key = JSON.stringify([session, registration]);
    if (key === this.registeredKey) return;
    // Save before posting: logout can retire the installation even while the
    // registration is in flight. Never persist its JWT in ordinary storage.
    await this.deps.rememberInstallation(device.installation_id);
    if (revision !== this.revision) return;
    try {
      await this.deps.register(registration, session);
    } finally {
      if (revision !== this.revision || this.permission === "denied") {
        // Even a lost POST response can hide a completed registration. Retire
        // it with its captured owner before registering the next account.
        this.enqueueCleanup(device.installation_id, session);
        await this.flushCleanups();
      }
    }
    if (revision !== this.revision || this.permission === "denied") return;
    this.registeredKey = key;
  }

  dispose() {
    this.disposed = true;
    this.navigationReady = false;
    // Only UI delivery detaches. Started writes and the app-lifetime queue
    // survive navigation remounts and still observe the next owning session.
  }
}

let appRuntime: NativePushRuntime | null = null;

export function getAppNativePushRuntime(deps: RuntimeDependencies): NativePushRuntime {
  if (!appRuntime) appRuntime = new NativePushRuntime(deps);
  appRuntime.attachRouteHandler(deps.openRoute);
  return appRuntime;
}
