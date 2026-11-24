const CHINESE_NAME_LIMIT = 8;
export const CHINESE_NAME_TOO_LONG = "CHINESE_DISPLAY_NAME_TOO_LONG";
// Keep these Han ranges in step with backend/display_name.py. Explicit ranges
// also work on native JavaScript runtimes that lack Unicode property escapes.
const HAN = /[\u2e80-\u2e99\u2e9b-\u2ef3\u2f00-\u2fd5\u3005\u3007\u3021-\u3029\u3038-\u303b\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufa6d\ufa70-\ufad9\u{16fe2}-\u{16fe3}\u{16ff0}-\u{16ff6}\u{20000}-\u{2a6df}\u{2a700}-\u{2b81d}\u{2b820}-\u{2cead}\u{2ceb0}-\u{2ebe0}\u{2ebf0}-\u{2ee5d}\u{2f800}-\u{2fa1d}\u{30000}-\u{3134a}\u{31350}-\u{33479}]/u;

export function isChineseDisplayNameTooLong(value: string): boolean {
  const name = value.trim();
  return HAN.test(name) && Array.from(name).length > CHINESE_NAME_LIMIT;
}

export function shortChineseDisplayName(value: string): string {
  return isChineseDisplayNameTooLong(value)
    ? `${Array.from(value.trim()).slice(0, CHINESE_NAME_LIMIT).join("")}…`
    : value;
}

export function chineseDisplayNameLimitMessage(locale: string): string {
  if (locale === "zh-TW") return "含中文字的稱呼最多 8 個字。";
  if (locale === "zh-CN") return "含中文的称呼最多 8 个字。";
  return "Names containing Chinese characters can have up to 8 characters.";
}
