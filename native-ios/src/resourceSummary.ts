// Presentation only: normalize the explicitly supplied short summary. This
// module never selects titles, excerpts, source bodies or metadata, never calls
// an AI/network service, and never rewrites or invents a statement.
// A length cap is not proof of permission, accuracy, or copyright compliance.

export type ResourceSummaryOptions = { limit?: number; locale?: string };

export const RESOURCE_SUMMARY_DISCLOSURE =
  "AI 根据检索到的信息整理，可能仅包含部分内容，也可能有误；请打开原站核对，不代表完整原文或完整视频内容。";

function decodedText(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (whole, decimal, hex, named) => {
    if (decimal || hex) {
      const code = Number.parseInt(decimal || hex, decimal ? 10 : 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : "";
    }
    const entities: Record<string, string> = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
    return entities[String(named).toLowerCase()] ?? whole;
  });
}

function normalizedText(value: unknown): string | null {
  const segments = typeof value === "string" ? [value]
    : Array.isArray(value) && value.length <= 40 && value.every((item) => typeof item === "string") ? value : null;
  if (!segments || segments.some((item) => item.length > 100000)) return null;
  const text = decodedText(segments.join("\n"))
    .replace(/\r\n?/g, "\n")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?(?:p|div|li|br|h[1-6]|section|article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*(?:>|$)/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|ftp)%3a(?:%2f){2}[^\s<>"'，。！？；、）】》]*/gi, "")
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:javascript|data|mailto|tel):)[^\s<>"'，。！？；、）】》]*/gi,
      (url) => url.match(/[.!?]+$/)?.[0] || "")
    .replace(/(?:^|\s)\/\/[^\s<>"'，。！？；、）】》]+/g, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,63}\b/gi, "")
    .replace(/\b(?:www\.)?[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,63}\b(?:[/:?#][^\s<>"'，。！？；、）】》]*)?/gi,
      (url) => url.match(/[.!?]+$/)?.[0] || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .split("\n").map((paragraph) => paragraph.trim()).filter(Boolean).join("\n")
    .trim();
  return text || null;
}

function completePrefix(text: string, limit: number): string | null {
  const prefix = Array.from(text).slice(0, limit).join("");
  if (prefix.length === text.length) return text;
  let lastEnd = 0;
  for (let index = 0; index < prefix.length; index++) {
    const char = prefix[index];
    if (char === "\n") { lastEnd = index; continue; }
    if (!/[。！？.!?]/.test(char)) continue;
    if (char === ".") {
      if (/\d/.test(text[index - 1] || "") && /\d/.test(text[index + 1] || "")) continue;
      const preceding = text.slice(0, index + 1);
      if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|U\.S|U\.K|[A-Z])\.$/i.test(preceding)) continue;
    }
    let end = index + 1;
    while (/[。！？.!?"'”’」』）)]/.test(text[end] || "") && end < text.length) end++;
    // English punctuation inside a word/domain is not a sentence boundary.
    if (/[.!?]/.test(char) && end < text.length && !/\s/.test(text[end])) continue;
    if (end <= prefix.length) lastEnd = end;
  }
  return lastEnd ? prefix.slice(0, lastEnd).trim() || null : null;
}

export function resourceSummary(value: unknown, options: ResourceSummaryOptions = {}): string | null {
  const text = normalizedText(value);
  if (!text) return null;
  const locale = typeof options?.locale === "string" ? options.locale.toLowerCase() : "";
  const defaultLimit = locale.startsWith("en") ? 800
    : locale.startsWith("zh") || /[\u3400-\u9fff]/.test(text) ? 220 : 800;
  const requested = options?.limit;
  const limit = typeof requested === "number" && Number.isFinite(requested)
    ? Math.max(1, Math.min(2000, Math.floor(requested))) : defaultLimit;
  return completePrefix(text, limit);
}

export function shortResourceSummary(value: unknown, maxChars = 220): string | null {
  return resourceSummary(value, { limit: maxChars });
}

export function resourceSummaryDisclosure(t: (source: string) => string = (source) => source): string {
  return t(RESOURCE_SUMMARY_DISCLOSURE);
}
