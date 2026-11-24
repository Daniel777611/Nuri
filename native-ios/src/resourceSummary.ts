// Presentation only: normalize the explicitly supplied short summary. This
// module never selects titles, excerpts, source bodies or metadata, never calls
// an AI/network service, and never invents a source statement.
// A length cap is not proof of permission, accuracy, or copyright compliance.

export type ResourceSummaryOptions = { limit?: number; locale?: string };

/** Existing daily-post API discriminator. Missing/unknown provenance must not
 * turn arbitrary legacy fields into an AI summary. This is not a permission,
 * copyright, or factual-accuracy certification. */
export function hasPostSummarySource(card: {summary_source?: unknown} | null | undefined): boolean {
  return card?.summary_source === "post" || card?.summary_source === "facebook_ai_summary" || card?.summary_source === "summary";
}

/** Detect a known mismatch, not a language/translation certification. Unknown
 * cache metadata stays unknown; the CJK check only catches the observed English
 * UI + Chinese generated-preview regression. Never rewrite chat/source text. */
export function resourceLanguageMismatch(text: unknown, contentLocale: unknown, uiLocale: string): boolean {
  const known=typeof contentLocale==="string"&&/^(en|zh-CN|zh-TW)$/.test(contentLocale)?contentLocale:null;
  return known ? known!==uiLocale : uiLocale==="en"&&typeof text==="string"&&/[\u3400-\u9fff]/.test(text);
}

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

function sentenceEnd(text: string, index: number): number {
  const char = text[index];
  if (!/[。！？.!?]/.test(char)) return 0;
  if (char === ".") {
    if (/\d/.test(text[index - 1] || "") && /\d/.test(text[index + 1] || "")) return 0;
    if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|U\.S|U\.K|[A-Z])\.$/i.test(text.slice(0, index + 1))) return 0;
  }
  let end = index + 1;
  while (end < text.length && /[。！？.!?"'”’」』）)]/.test(text[end])) end++;
  // English punctuation inside a word/domain is not a sentence boundary.
  return /[.!?]/.test(char) && end < text.length && !/\s/.test(text[end]) ? 0 : end;
}

function completePrefix(text: string, limit: number): string | null {
  const prefix = Array.from(text).slice(0, limit).join("");
  if (prefix.length === text.length) return text;
  let lastEnd = 0;
  for (let index = 0; index < prefix.length; index++) {
    if (prefix[index] === "\n") { lastEnd = index; continue; }
    const end = sentenceEnd(text, index);
    if (end && end <= prefix.length) lastEnd = end;
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

function splitSummaryPoints(text: string | null): string[] {
  if (!text) return [];
  return text.split("\n").flatMap((paragraph) => {
    const line = paragraph.replace(/^(?:[-*+]\s+|[•・]\s*|\d{1,2}[.)]\s+|\d{1,2}[、．）]\s*)/, "");
    const points: string[] = [];
    let start = 0;
    let parentheses = 0;
    for (let index = 0; index < line.length; index++) {
      if (/[（(\[【]/.test(line[index])) parentheses++;
      if (/[）)\]】]/.test(line[index])) parentheses = Math.max(0, parentheses - 1);
      const end = parentheses === 0 ? sentenceEnd(line, index) : 0;
      if (!end) continue;
      points.push(line.slice(start, end).trim());
      start = end;
      index = end - 1;
    }
    return [...points, line.slice(start).trim()].filter(Boolean);
  });
}

function duplicateKey(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").replace(/[.。]$/, "");
}

function rangeKeys(text: string): string {
  return Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*(?:[-‐‑–—~～到至]|to)\s*(\d+(?:\.\d+)?)/gi),
    ([, start, end]) => `${start}-${end}`).join(",");
}

function matchTerms(text: string): Set<string> {
  const terms = new Set(text.toLowerCase().match(/\b[a-z]{4,}\b/g) || []);
  for (const part of text.match(/[\u3400-\u9fff]{3,}/g) || []) {
    for (let index = 0; index <= part.length - 3; index++) terms.add(part.slice(index, index + 3));
  }
  return terms;
}

function relatedDetailIndexes(preview: string[], detail: string[]): number[] | null {
  const detailTerms = detail.map((text) => ({ ranges: rangeKeys(text), terms: matchTerms(text) }));
  const indexes: number[] = [];
  for (const text of preview) {
    const ranges = rangeKeys(text);
    if (!ranges) return null;
    const terms = matchTerms(text);
    const matches = detailTerms.flatMap((candidate, index) =>
      ranges === candidate.ranges && [...terms].filter((term) => candidate.terms.has(term)).length >= 3
        ? [index] : []);
    // Keep both original phrasings, and group only when the excerpts have an
    // unambiguous reading order. A shared range alone does not establish that.
    if (matches.length !== 1 || matches[0] <= (indexes.at(-1) ?? -1)) return null;
    indexes.push(matches[0]);
  }
  return indexes;
}

const AAP_NAMES = {
  en: "American Academy of Pediatrics",
  "zh-CN": "美国儿科学会",
  "zh-TW": "美國兒科學會",
};

type ReadingSummaryPoint = { kind: "preview" | "detail"; text: string };

/** Organize the already bounded, supplied excerpts in display order. */
export function readingSummaryPoints(
  preview: string | null,
  detail: string | null,
  locale: string,
  { detailFirst = false, groupRelated = false }: { detailFirst?: boolean; groupRelated?: boolean } = {},
): ReadingSummaryPoint[] {
  const detailPoints = splitSummaryPoints(detail);
  const seen = new Set(detailPoints.map(duplicateKey));
  const previewPoints = splitSummaryPoints(preview).filter((text) => {
    const key = duplicateKey(text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const previewRows = previewPoints.map((text): ReadingSummaryPoint => ({ kind: "preview", text }));
  const detailRows = detailPoints.map((text): ReadingSummaryPoint => ({ kind: "detail", text }));
  const relatedIndexes = groupRelated && previewPoints.length > 0 ? relatedDetailIndexes(previewPoints, detailPoints) : null;
  if (relatedIndexes) {
    relatedIndexes.forEach((index, previewIndex) => { detailRows[index].text += `\n\n${previewPoints[previewIndex]}`; });
  }
  const rows = relatedIndexes ? detailRows : detailFirst ? [...detailRows, ...previewRows] : [...previewRows, ...detailRows];
  const language = locale === "zh-TW" ? "zh-TW" : locale === "zh-CN" ? "zh-CN" : "en";
  const fullName = AAP_NAMES[language];
  const expansion = language === "en" ? `${fullName} (AAP)` : `${fullName}（AAP）`;
  let explainedAap = false;
  return rows.map((row) => {
    if (explainedAap) return row;
    const index = row.text.search(/\bAAP\b/);
    if (index < 0) return row;
    explainedAap = true;
    const before = row.text.slice(0, index);
    const after = row.text.slice(index + 3);
    const alreadyExpanded = Object.values(AAP_NAMES).some((name) =>
      before.replace(/[\s(（]+$/, "").endsWith(name) || after.replace(/^[\s(（]+/, "").startsWith(name));
    return alreadyExpanded ? row : { ...row, text: before + expansion + after };
  });
}

export function resourceSummaryDisclosure(t: (source: string) => string = (source) => source): string {
  return t(RESOURCE_SUMMARY_DISCLOSURE);
}
