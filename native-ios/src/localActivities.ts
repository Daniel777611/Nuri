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
  kind: "dated_event" | "ongoing_resource";
  title: string;
  summary: string;
  source_url: string;
  source_label: string;
  start_date: string | null;
  end_date: string | null;
  location_label: string;
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

export function validLocalActivity(value: unknown): value is LocalActivity {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LocalActivity>;
  if (!localActivityId(item.id) || !externalSourceUrl(item.source_url) ||
      typeof item.title !== "string" || !item.title.trim() || typeof item.summary !== "string" ||
      typeof item.source_label !== "string" || typeof item.location_label !== "string") return false;
  if (item.kind === "ongoing_resource") return item.start_date === null && item.end_date === null;
  return item.kind === "dated_event" && dateOnly(item.start_date) &&
    (item.end_date === null || (dateOnly(item.end_date) && item.end_date >= item.start_date));
}

export function formatActivityDate(item: LocalActivity, locale: ActivityLocale): string {
  const start = item.start_date;
  if (!dateOnly(start)) return "";
  const formatter = new Intl.DateTimeFormat(locale, {
    month: "short", day: "numeric", year: "numeric", weekday: "short", timeZone: "UTC",
  });
  const format = (day: string) => formatter.format(new Date(`${day}T12:00:00Z`));
  const end = item.end_date;
  return dateOnly(end) && end !== start ? `${format(start)} – ${format(end)}` : format(start);
}
