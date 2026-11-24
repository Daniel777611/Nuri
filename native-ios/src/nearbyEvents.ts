import { AppState, NativeModules, Platform } from "react-native";
import { api, apiRequest, auth, type NotificationPreferences } from "./api";
import { storage } from "./utils/storage";

export type NearbyLocale = "en" | "zh-CN" | "zh-TW";
export type NearbyLocality = { city: string; region: string; country: string };
export type NearbyEvent = {
  id: string;
  title: string;
  date: string;
  url: string;
  source: string;
  category: "library" | "family";
};
type Permission = "authorized" | "denied" | "not_determined" | "unavailable";
type LocationResult = { status: Permission | "cancelled"; locality?: NearbyLocality };
type NativeNearbyBridge = {
  getLocationPermission(): Promise<Permission>;
  resolveNearbyLocality(askPermission: boolean): Promise<LocationResult>;
  cancelLocality(): Promise<void>;
  requestNearbyNotificationPermission(): Promise<boolean>;
  cancelNearbyReminders(): Promise<void>;
  scheduleNearbyReminder(id: string, dateMs: number, title: string, body: string): Promise<boolean>;
};
export type NearbyPreference = {
  mode: "device" | "manual";
  locality: NearbyLocality;
  reminders: boolean;
  locatedAt: number;
};
type NearbyAccountSettings = {
  preference: NearbyPreference | null;
  // Missing means the account has not yet been offered automatic location.
  deviceEnabled?: boolean;
  manualPreference?: NearbyPreference;
};
type DeviceLocationResult = "enabled" | "disabled" | "settings_required" | "unavailable";
type LocationOperation = {
  owner: string;
  generation: number;
  enable: boolean;
  task: Promise<DeviceLocationResult>;
};

const prefKey = "nuri-alpha-nearby-events-v1";
const areaRefreshInterval = 6 * 60 * 60 * 1000;
const requestCooldown = 30 * 60 * 1000;
let settingsRevision = 0;
let locationOperation: LocationOperation | null = null;
let settingsWrites = Promise.resolve();
let refreshInFlight: { key: string; task: Promise<NearbyEvent[]> } | null = null;
let cache: { key: string; expires: number; events: NearbyEvent[] } | null = null;
let lastAutomaticCheck = 0;

function bridge(): NativeNearbyBridge | null {
  return process.env.EXPO_PUBLIC_RELEASE_FLAVOR === "live-alpha" && Platform.OS === "ios"
    ? NativeModules.NuriNearbyEventsBridge ?? null
    : null;
}

export const nearbyEventsAvailable = () => Boolean(bridge());

function areaName(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().normalize("NFC");
  return normalized.length <= max && /^[\p{L}\p{M} .,'’\-]+$/u.test(normalized) &&
    /\p{L}/u.test(normalized) ? normalized : "";
}

export function manualArea(value: string): NearbyLocality | null {
  const [city, region, country, ...extra] = value.split(/[,，]/u);
  const area = {
    city: areaName(city, 80),
    region: areaName(region, 70),
    country: country?.trim().toUpperCase() || "",
  };
  return area.city.length >= 2 && extra.length === 0 &&
    (!region?.trim() || !!area.region) && /^(?:[A-Z]{2})?$/.test(area.country) ? area : null;
}

export function areaLabel(area: NearbyLocality) {
  return [area.city, area.region, area.country].filter(Boolean).join(", ");
}

function validPreference(stored: NearbyPreference | null | undefined): stored is NearbyPreference {
  return Boolean(stored && ["manual", "device"].includes(stored.mode) &&
    typeof stored.reminders === "boolean" && Number.isFinite(stored.locatedAt) &&
    stored.locality && areaName(stored.locality.city, 80) &&
    typeof stored.locality.region === "string" &&
    (!stored.locality.region || areaName(stored.locality.region, 70)) &&
    typeof stored.locality.country === "string" && /^(?:[A-Z]{2})?$/.test(stored.locality.country));
}

function accountSettingsKey(owner: string) {
  const encoded = Array.from(owner, value => value.codePointAt(0)!.toString(16)).join("-");
  return `${prefKey}.${encoded}`;
}

async function readAccountSettings(owner: string): Promise<NearbyAccountSettings> {
  const key = accountSettingsKey(owner);
  const raw = await storage.secureGet(key, "");
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      return {
        preference: validPreference(saved?.preference) ? saved.preference : null,
        deviceEnabled: typeof saved?.deviceEnabled === "boolean" ? saved.deviceEnabled : undefined,
        manualPreference: validPreference(saved?.manualPreference) && saved.manualPreference.mode === "manual"
          ? saved.manualPreference : undefined,
      };
    } catch { return { preference: null }; }
  }
  const legacy = await storage.secureGet(prefKey, "");
  try {
    const saved = legacy ? JSON.parse(legacy) : null;
    return { preference: saved?.owner === owner && validPreference(saved) ? saved : null };
  } catch { return { preference: null }; }
}

function updateAccountSettings(
  owner: string, current: () => boolean, update: (stored: NearbyAccountSettings) => NearbyAccountSettings,
) {
  const task = settingsWrites.then(async () => {
    if (!current()) return false;
    const next = update(await readAccountSettings(owner));
    if (!current()) return false;
    if (!await storage.secureSet(accountSettingsKey(owner), JSON.stringify(next))) {
      throw new Error("Nearby activity preferences were not saved");
    }
    if (!current()) return false;
    cache = null;
    return true;
  });
  settingsWrites = task.then(() => undefined, () => undefined);
  return task;
}

export async function readNearbyPreference(owner: string): Promise<NearbyPreference | null> {
  if (!bridge() || !owner) return null;
  return (await readAccountSettings(owner)).preference;
}

export async function setNearbyPreference(owner: string, preference: NearbyPreference | null) {
  const native = bridge();
  if (!native || !owner) return;
  const revision = ++settingsRevision;
  const generation = auth.getSessionGeneration();
  const current = () => revision === settingsRevision && generation === auth.getSessionGeneration();
  if (preference?.mode !== "device") await native.cancelLocality();
  await native.cancelNearbyReminders();
  await updateAccountSettings(owner, current, saved => ({
    ...saved,
    preference,
    manualPreference: preference?.mode === "manual" ? preference : preference?.mode === "device" ? saved.manualPreference : undefined,
    deviceEnabled: preference?.mode === "device" ? true : false,
  }));
}

async function resolveDeviceLocality(native: NativeNearbyBridge, askPermission: boolean): Promise<LocationResult> {
  const result = await native.resolveNearbyLocality(askPermission);
  const locality = result.locality;
  if (locality) {
    const city = areaName(locality.city, 80);
    if (city.length < 2 || !/^[A-Z]{2}$/.test(locality.country)) return { status: "unavailable" };
    return { ...result, locality: { city, region: areaName(locality.region, 70), country: locality.country } };
  }
  return result;
}

export async function enableNearbyDeviceLocation(): Promise<LocationResult> {
  const native = bridge();
  return native ? resolveDeviceLocality(native, true) : { status: "unavailable" };
}

export async function readNearbyLocationSetting(owner: string): Promise<{ enabled: boolean; permission: Permission }> {
  const native = bridge();
  if (!native || !owner) return { enabled: false, permission: "unavailable" };
  const generation = auth.getSessionGeneration();
  const [saved, permission] = await Promise.all([readAccountSettings(owner), native.getLocationPermission()]);
  if (generation !== auth.getSessionGeneration()) return { enabled: false, permission: "unavailable" };
  const pending = locationOperation?.owner === owner && locationOperation.generation === generation
    ? locationOperation.enable : undefined;
  return {
    enabled: permission === "authorized" && (pending ?? (saved.deviceEnabled ?? (saved.preference?.mode === "device"))),
    permission,
  };
}

function changeDeviceLocation(
  owner: string, enable: boolean,
  automatic?: { active: () => boolean; onLocationSettingsRequired?: () => void },
): Promise<DeviceLocationResult> {
  const native = bridge();
  if (!native || !owner) return Promise.resolve("unavailable");
  const generation = auth.getSessionGeneration();
  if (locationOperation?.owner === owner && locationOperation.generation === generation &&
      locationOperation.enable === enable) return locationOperation.task;
  const revision = ++settingsRevision;
  const current = () => revision === settingsRevision && generation === auth.getSessionGeneration() &&
    (!automatic || automatic.active());
  const task = (async (): Promise<DeviceLocationResult> => {
    if (!enable) await native.cancelLocality().catch(() => undefined);
    const saved = await readAccountSettings(owner);
    if (!current()) return "unavailable";
    if (!enable) {
      if (saved.preference?.mode === "device") await native.cancelNearbyReminders().catch(() => undefined);
      const wrote = await updateAccountSettings(owner, current, latest => ({
        ...latest, deviceEnabled: false,
        preference: latest.preference?.mode === "device" ? latest.manualPreference ?? null : latest.preference,
      }));
      return wrote ? "disabled" : "unavailable";
    }
    // If the owner already chose off, the automatic path must not read the device.
    if (automatic && saved.deviceEnabled === false) return "disabled";
    if (AppState.currentState !== "active") return "unavailable";
    const permission = await native.getLocationPermission();
    if (!current() || AppState.currentState !== "active") return "unavailable";
    const firstOffer = saved.deviceEnabled === undefined;
    if (automatic && !firstOffer && permission !== "authorized") return "unavailable";
    if (permission === "unavailable") return "unavailable";
    const rememberOffer = () => updateAccountSettings(owner, current, latest => ({ ...latest, deviceEnabled: true }));
    if (permission === "denied") {
      if ((firstOffer || saved.deviceEnabled === false) && !await rememberOffer()) return "unavailable";
      if (automatic && firstOffer && AppState.currentState === "active") automatic.onLocationSettingsRequired?.();
      return "settings_required";
    }
    if (permission === "authorized" && saved.preference?.mode === "device") {
      if ((firstOffer || saved.deviceEnabled === false) && !await rememberOffer()) return "unavailable";
      return "enabled";
    }
    // Persist after an actual OS response. Leaving the foreground before iOS
    // can answer must not consume the account's first automatic offer.
    const result = await resolveDeviceLocality(native, permission === "not_determined");
    if (!current()) return "unavailable";
    if (result.status !== "authorized" || !result.locality) {
      const settled = result.status === "denied" ? "denied" : await native.getLocationPermission();
      if (!current()) return "unavailable";
      if ((firstOffer || saved.deviceEnabled === false) && (settled === "denied" || settled === "authorized")) {
        if (!await rememberOffer()) return "unavailable";
      }
      return settled === "denied" ? "settings_required" : "unavailable";
    }
    const locality = result.locality;
    // The manual city remains available if the device setting is turned off later.
    const wrote = await updateAccountSettings(owner, current, latest => ({
      deviceEnabled: true,
      manualPreference: latest.preference?.mode === "manual" ? latest.preference : latest.manualPreference,
      preference: { mode: "device", locality, reminders: latest.preference?.reminders ?? false, locatedAt: Date.now() },
    }));
    if (!wrote) return "unavailable";
    // A device and manual area should never leave two scheduled reminders behind.
    await native.cancelNearbyReminders();
    return current() ? "enabled" : "unavailable";
  })().catch((): DeviceLocationResult => "unavailable").finally(() => {
    if (locationOperation?.task === task) locationOperation = null;
  });
  locationOperation = { owner, generation, enable, task };
  return task;
}

export async function setNearbyLocationEnabled(
  owner: string, enabled: boolean, locale: NearbyLocale,
): Promise<DeviceLocationResult> {
  const result = await changeDeviceLocation(owner, enabled);
  if (result === "enabled" || result === "disabled") void refreshNearbyEvents(owner, locale).catch(() => undefined);
  return result;
}

export async function enableNearbyReminders(): Promise<boolean> {
  return await bridge()?.requestNearbyNotificationPermission() ?? false;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function validNearbyEvents(value: unknown): NearbyEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NearbyEvent => {
    if (!item || typeof item !== "object" || typeof item.title !== "string" || !item.title.trim() ||
        !/^[a-f0-9]{24}$/.test(item.id) || !validDate(item.date) || typeof item.url !== "string" ||
        typeof item.source !== "string" || !["library", "family"].includes(item.category)) return false;
    try {
      const url = new URL(item.url);
      return url.protocol === "https:" && !url.username && !url.password && url.hostname === item.source;
    } catch { return false; }
  }).slice(0, 8);
}

export function chooseNearbyReminder(
  events: NearbyEvent[], settings: NotificationPreferences, now = Date.now(),
): { event: NearbyEvent; at: number } | null {
  if (settings.enabled !== true || settings.reminders_enabled !== true) return null;
  const clockPart = (part: string | undefined) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(part ?? "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const quietStart = clockPart(settings.quiet_hours_start);
  const quietEnd = clockPart(settings.quiet_hours_end);
  if (quietStart === null || quietEnd === null) return null;
  const isQuiet = (time: number) => quietStart === quietEnd ? false :
    quietStart < quietEnd ? time >= quietStart && time < quietEnd : time >= quietStart || time < quietEnd;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: settings.time_zone || undefined,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      hourCycle: "h23",
    });
  } catch { return null; }
  const tentative = [...events].sort((a, b) => a.date.localeCompare(b.date));
  for (const event of tentative) {
    if (!validDate(event.date)) continue;
    const start = Date.parse(event.date);
    const prior = new Date(start - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Search in UTC for a half-hour on the previous local calendar date.
    // This avoids guessing UTC offsets or a nonexistent DST clock time.
    for (let time = start - 38 * 3600_000; time < start + 14 * 3600_000; time += 30 * 60_000) {
      if (time < now + 30_000 || time > now + 28 * 86400_000) continue;
      const local = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type, p.value]));
      if (`${local.year}-${local.month}-${local.day}` !== prior) continue;
      const minute = Number(local.hour) * 60 + Number(local.minute);
      if (minute >= 10 * 60 && minute < 19 * 60 && !isQuiet(minute)) return { event, at: time };
    }
  }
  return null;
}

const notifications = {
  en: ["Nearby family activity", "Open Nuri for the source and event details."],
  "zh-CN": ["附近的亲子活动", "打开 Nuri 查看活动详情和来源。"],
  "zh-TW": ["附近的親子活動", "開啟 Nuri 查看活動詳情和來源。"],
} as const;

async function fetchAndScheduleNearbyEvents(
  owner: string, locale: NearbyLocale, force: boolean,
): Promise<NearbyEvent[]> {
  const native = bridge();
  if (!native || AppState.currentState !== "active") return [];
  const revision = settingsRevision;
  const generation = auth.getSessionGeneration();
  const current = () => revision === settingsRevision && generation === auth.getSessionGeneration() &&
    AppState.currentState === "active";
  const settings = await readAccountSettings(owner);
  const stored = settings.preference;
  if (!stored || !current()) return [];
  let preference = stored;
  if (preference.mode === "device") {
    if (settings.deviceEnabled === false || locationOperation?.owner === owner) return [];
    if (await native.getLocationPermission() !== "authorized") {
      if (!current()) return [];
      await native.cancelNearbyReminders();
      await updateAccountSettings(owner, current, saved => ({
        ...saved, preference: saved.manualPreference ?? null,
      }));
      return [];
    }
    if (!current()) return [];
    if (Date.now() - preference.locatedAt >= areaRefreshInterval) {
      const resolved = await resolveDeviceLocality(native, false);
      if (!current()) return [];
      if (resolved.status !== "authorized" || !resolved.locality) {
        await native.cancelNearbyReminders();
        return [];
      }
      preference = { ...preference, locality: resolved.locality, locatedAt: Date.now() };
      if (areaLabel(preference.locality) !== areaLabel(stored.locality)) {
        await native.cancelNearbyReminders();
        if (!current()) return [];
      }
      if (!await updateAccountSettings(owner, current, saved => ({ ...saved, preference }))) return [];
    }
  }
  if (!current()) return [];
  const key = JSON.stringify([owner, locale, preference.locality]);
  let events: NearbyEvent[];
  if (!force && cache?.key === key && cache.expires > Date.now()) {
    events = cache.events;
  } else {
    const response = await apiRequest<{ events?: unknown }>("/alpha/nearby-events", {
      method: "POST", body: JSON.stringify({ ...preference.locality, locale }),
    }, 18_000);
    if (!current()) return [];
    events = validNearbyEvents(response?.events);
    cache = { key, expires: Date.now() + requestCooldown, events };
  }
  if (preference.reminders) {
    try {
      const prefs = await api.getNotificationPreferences();
      if (!current()) return events;
      const reminder = prefs ? chooseNearbyReminder(events, prefs) : null;
      const [title, body] = notifications[locale];
      if (reminder) await native.scheduleNearbyReminder(reminder.event.id, reminder.at, title, body);
      else await native.cancelNearbyReminders();
    } catch {
      if (current()) await native.cancelNearbyReminders().catch(() => undefined);
    }
  }
  return events;
}

export function refreshNearbyEvents(owner: string, locale: NearbyLocale, force = false) {
  const key = JSON.stringify([owner, locale, settingsRevision, auth.getSessionGeneration()]);
  if (refreshInFlight?.key === key) return refreshInFlight.task;
  const task = fetchAndScheduleNearbyEvents(owner, locale, force).finally(() => {
    if (refreshInFlight?.task === task) refreshInFlight = null;
  });
  refreshInFlight = { key, task };
  return task;
}

export async function nearbyNotificationSettingsChanged(locale: NearbyLocale) {
  const native = bridge();
  if (!native) return;
  const generation = auth.getSessionGeneration();
  settingsRevision += 1;
  await native.cancelNearbyReminders();
  const me = await api.me();
  if (!me?.id || generation !== auth.getSessionGeneration()) return;
  const preference = await readNearbyPreference(me.id);
  if (preference?.reminders && generation === auth.getSessionGeneration()) await refreshNearbyEvents(me.id, locale);
}

export function startNearbyForegroundRefresh(
  getLocale: () => NearbyLocale, options?: { onLocationSettingsRequired?: () => void },
) {
  const native = bridge();
  if (!native) return () => {};
  let disposed = false;
  let ownerGeneration = auth.getIdentityGeneration();
  let resolvedOwner: { generation: number; id: string } | null = null;
  let foregroundTask: Promise<void> | null = null;
  let recheck = false;

  async function foreground() {
    const generation = auth.getSessionGeneration();
    const active = () => !disposed && generation === auth.getSessionGeneration() && AppState.currentState === "active";
    if (!active()) return;
    if (!await auth.getToken() || !active()) return;
    if (resolvedOwner?.generation !== generation) {
      const me = await api.me();
      if (!me?.id || !active()) return;
      resolvedOwner = { generation, id: me.id };
    }
    const owner = resolvedOwner.id;
    const saved = await readAccountSettings(owner);
    if (!active()) return;
    const device = saved.preference?.mode === "device";
    let activated = false;
    if (saved.deviceEnabled !== false && (!device || saved.deviceEnabled === undefined)) {
      const result = await changeDeviceLocation(owner, true, {
        active: () => !disposed,
        onLocationSettingsRequired: () => {
          if (active()) options?.onLocationSettingsRequired?.();
        },
      });
      activated = result === "enabled" && !device;
    }
    if (!active()) return;
    // Detect revoked authorization even during the usual refresh cooldown.
    const revoked = device && await native!.getLocationPermission() !== "authorized";
    if (!active() || (!revoked && !activated && Date.now() - lastAutomaticCheck < requestCooldown)) return;
    lastAutomaticCheck = Date.now();
    await refreshNearbyEvents(owner, getLocale());
  }

  function check() {
    if (disposed || AppState.currentState !== "active") return;
    if (foregroundTask) { recheck = true; return; }
    const task = foreground().catch(() => undefined).finally(() => {
      if (foregroundTask !== task) return;
      foregroundTask = null;
      if (recheck) { recheck = false; check(); }
    });
    foregroundTask = task;
  }

  const appState = AppState.addEventListener("change", state => { if (state === "active") check(); });
  const sessionBoundary = auth.subscribeSessionBoundary(() => {
    const next = auth.getIdentityGeneration();
    if (next === ownerGeneration) return;
    ownerGeneration = next;
    settingsRevision += 1;
    lastAutomaticCheck = 0;
    cache = null;
    foregroundTask = null;
    recheck = false;
    void native.cancelLocality().catch(() => undefined);
    void native.cancelNearbyReminders().catch(() => undefined);
  });
  const sessionChange = auth.subscribeSessionChange(token => {
    if (token) { check(); return; }
    settingsRevision += 1;
    lastAutomaticCheck = 0;
    cache = null;
    foregroundTask = null;
    recheck = false;
    void native.cancelLocality().catch(() => undefined);
    void native.cancelNearbyReminders().catch(() => undefined);
  });
  check();
  return () => { disposed = true; appState.remove(); sessionBoundary(); sessionChange(); };
}
