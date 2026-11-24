import { externalSourceUrl } from "./externalContent";

export type ActivityLocale = "en" | "zh-CN" | "zh-TW";
export type ActivityArea = { city: string; region: string; country: string };
export type ActivityPreferences = {
  enabled: boolean;
  city: string | null;
  region: string | null;
  country: string | null;
};
export type ActivityPreferencesPatch = ({ enabled: true } & ActivityArea) | { enabled: false };
export type LocalActivity = {
  id: string;
  kind: "dated_event";
  event_source_verified: true;
  title: string;
  summary: string;
  source_url: string;
  source_label: string;
  start_date: string;
  end_date: string | null;
  location_label: string;
  venue_name: string;
  address: string;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  age_label: string;
  match_reason: string;
  description: string;
  registration_required: boolean | null;
  registration_url?: string | null;
  registration_notes?: string | null;
  cost?: string | null;
};
export type LocalActivities = {
  state: "disabled" | "ready" | "empty" | "unavailable";
  items: LocalActivity[];
};

export const localActivitiesEnabled = process.env.EXPO_PUBLIC_LOCAL_ACTIVITIES_TEST === "1";

export function localActivityId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function localActivityNotificationId(value: { kind?: unknown; local_activity_id?: unknown }): string | null {
  return value.kind === "local_activity" ? localActivityId(value.local_activity_id) : null;
}

export function activityCopy(locale: ActivityLocale, simplified: string, english: string, traditional: string) {
  return locale === "en" ? english : locale === "zh-TW" ? traditional : simplified;
}

export function localActivityTitle(locale: ActivityLocale) {
  return activityCopy(locale, "附近亲子活动", "Nearby family activities", "附近親子活動");
}

export function normalizedActivityArea(area: ActivityArea): ActivityArea | null {
  const city = area.city.trim().normalize("NFC");
  const region = area.region.trim().normalize("NFC");
  const country = area.country.trim().toUpperCase();
  const isPlace = (value: string, max: number) =>
    value.length <= max && /\p{L}/u.test(value) && /^[\p{L}\p{M} .'’\-]+$/u.test(value);
  if (!isPlace(city, 80) || (region && !isPlace(region, 70)) || !/^[A-Z]{2}$/.test(country)) return null;
  return { city, region, country };
}

function dateOnly(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const stamp = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === date;
}

const activityDateTimePattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;
const hasUtcOffset = /(?:Z|[+-]\d{2}:\d{2})$/;

function asEventDate(value: unknown): Date | null {
  if (typeof value !== "string" || !activityDateTimePattern.test(value) || !dateOnly(value.slice(0, 10))) return null;
  const stamp = new Date(hasUtcOffset.test(value) ? value : `${value}Z`);
  return Number.isFinite(stamp.getTime()) ? stamp : null;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

export function validLocalActivity(value: unknown): value is LocalActivity {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalActivity>;
  if (item.kind !== "dated_event" || item.event_source_verified !== true || !localActivityId(item.id) ||
      !officialActivityUrl(item.source_url) || !dateOnly(item.start_date) ||
      (item.end_date !== null && (!dateOnly(item.end_date) || item.end_date < item.start_date)) ||
      ![item.title, item.venue_name, item.address, item.time_zone, item.age_label, item.match_reason,
        item.description].every(nonBlank) || typeof item.summary !== "string" ||
      (item.cost != null && typeof item.cost !== "string") ||
      (item.registration_notes != null && typeof item.registration_notes !== "string")) return false;
  const start = asEventDate(item.starts_at);
  const end = asEventDate(item.ends_at);
  return start !== null && end !== null && end.getTime() > start.getTime();
}

export function officialActivityUrl(value: unknown): string | null {
  const safe = externalSourceUrl(value);
  if (!safe) return null;
  const { pathname, searchParams } = new URL(safe);
  const genericPage = /^\/(?:|events?|calendar|programs?|activities?|visit|home|index\.html)\/?$/i;
  let hasEventId = false;
  searchParams.forEach((id, key) => {
    if (id.trim() && /^(?:event_?id|eid|registration_?id|session_?id|id)$/i.test(key)) hasEventId = true;
  });
  return genericPage.test(pathname) && !hasEventId ? null : safe;
}

export function formatActivitySchedule(item: LocalActivity, locale: ActivityLocale): string {
  const render = (value: string) => {
    // Explicit offsets identify an instant. A local ISO value instead records
    // the organizer's wall-clock time, so it must not shift to the phone's zone.
    const stamp = asEventDate(value);
    if (!stamp) return null;
    const dayOptions: Intl.DateTimeFormatOptions = {
      month: "short", day: "numeric", year: "numeric", weekday: "short",
    };
    const timeOptions: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
    const timeZone = hasUtcOffset.test(value) ? item.time_zone : "UTC";
    try {
      return {
        day: new Intl.DateTimeFormat(locale, { ...dayOptions, timeZone }).format(stamp),
        time: new Intl.DateTimeFormat(locale, { ...timeOptions, timeZone }).format(stamp),
      };
    } catch {
      const wallClock = asEventDate(value.replace(hasUtcOffset, "")) ?? stamp;
      return {
        day: new Intl.DateTimeFormat(locale, { ...dayOptions, timeZone: "UTC" }).format(wallClock),
        time: new Intl.DateTimeFormat(locale, { ...timeOptions, timeZone: "UTC" }).format(wallClock),
      };
    }
  };
  const start = render(item.starts_at);
  const end = render(item.ends_at);
  if (!start || !end) return "";
  return start.day === end.day
    ? `${start.day} · ${start.time} – ${end.time}`
    : `${start.day} · ${start.time} – ${end.day} · ${end.time}`;
}
