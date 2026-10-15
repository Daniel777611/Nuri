export type ChatClientContext = {
  timezone: string;
  utc_offset_minutes: number;
  locale: string;
  local_datetime: string;
};

export type ChatMessagePayload = {
  text: string;
  image_base64: string | null;
  client_message_id: string;
  client_context: ChatClientContext;
};

export function resolveClientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function formatLocalDateTime(now: Date): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const localWallClock = new Date(now.getTime() + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 19);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${localWallClock}${sign}${hours}:${minutes}`;
}

export function buildChatMessagePayload(
  text: string,
  imageBase64: string | null,
  locale: string,
  now = new Date(),
): ChatMessagePayload {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${now.getTime()}-${Math.random().toString(36).slice(2, 14)}`;
  return {
    text,
    image_base64: imageBase64,
    client_message_id: `client-${randomId}`,
    client_context: {
      timezone: resolveClientTimezone(),
      utc_offset_minutes: -now.getTimezoneOffset(),
      locale,
      local_datetime: formatLocalDateTime(now),
    },
  };
}
