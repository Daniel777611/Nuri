/** Same identity rule for every self-avatar; never substitute the mascot. */
export function userInitial(displayName: unknown): string {
  if (typeof displayName !== "string") return "";
  const first = Array.from(displayName.trim())[0] ?? "";
  return first.toLocaleUpperCase();
}
export function userPhotoURL(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return new URL(value).protocol === "https:" ? value : null; }
  catch { return null; }
}
