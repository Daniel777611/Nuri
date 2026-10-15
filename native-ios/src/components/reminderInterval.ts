export type ReminderIntervalResult =
  | { ok: true; intervalSeconds: number; minutes: string; seconds: string }
  | { ok: false; reason: "integer" | "zero" | "range" };

/** Seconds may exceed 59; normalize them without changing the chosen duration. */
export function parseReminderInterval(
  minutesInput: string,
  secondsInput: string,
  maximumSeconds = 31_536_000,
): ReminderIntervalResult {
  const minutesText = minutesInput.trim();
  const secondsText = secondsInput.trim();
  if (!/^\d*$/.test(minutesText) || !/^\d*$/.test(secondsText)) {
    return { ok: false, reason: "integer" };
  }
  const minutes = Number(minutesText || "0");
  const seconds = Number(secondsText || "0");
  const intervalSeconds = minutes * 60 + seconds;
  if (!Number.isSafeInteger(minutes) || !Number.isSafeInteger(seconds)
    || !Number.isSafeInteger(intervalSeconds) || intervalSeconds > maximumSeconds) {
    return { ok: false, reason: "range" };
  }
  if (intervalSeconds < 1) return { ok: false, reason: "zero" };
  return {
    ok: true,
    intervalSeconds,
    minutes: String(Math.floor(intervalSeconds / 60)),
    seconds: String(intervalSeconds % 60),
  };
}

/** Preserve the latest privacy preferences when changing the push opt-in. */
export function withDailyPushPreference<T extends Record<string, unknown>>(
  privacy: T,
  enabled: boolean,
): T & { daily_push: boolean } {
  return { ...privacy, daily_push: enabled };
}
