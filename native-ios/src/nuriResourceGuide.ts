// Optional NURI conversation invitation, not homework or a source digest.
// Only the family's topic and age/stage labels are accepted. No source text,
// source metadata, provider, storage or network dependency belongs here.

export type NuriResourceGuideInput = {
  concern?: unknown;
  stage?: unknown;
};

export type NuriResourceGuideTranslator = (
  source: string,
  vars?: Record<string, string | number>,
) => string;

export type NuriResourceGuide = {
  headline: string;
  intro: string;
  actions: string[];
  disclosure: string;
};

const interpolate: NuriResourceGuideTranslator = (source, vars) =>
  source.replace(/\{(concern|stage)\}/g, (whole, name: string) =>
    vars && name in vars ? String(vars[name]) : whole,
  );

function familyLabel(value: unknown, maxCharacters: number): string {
  if (typeof value !== "string") return "";
  const text = value.slice(0, 2048)
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z0-9]+);/gi, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/<(script|style|a)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<[^>]*(?:>|$)/g, " ")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\b(?:https?|ftp)%3a(?:%2f){2}[^\s<>]*/gi, " ")
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:javascript|data|mailto|tel):)[^\s<>]*/gi, " ")
    .replace(/(?:^|\s)\/\/[^\s<>]+/g, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,63}\b/gi, " ")
    .replace(/\b(?:www\.)?[a-z0-9](?:[a-z0-9.-]*\.)[a-z]{2,63}(?:[/:?#][^\s<>]*)?/gi, " ")
    .replace(/[<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Count Unicode code points so a short label never ends in half an emoji.
  return Array.from(text).slice(0, maxCharacters).join("").trim();
}

export function nuriResourceGuide(
  input: NuriResourceGuideInput = {},
  t: NuriResourceGuideTranslator = interpolate,
  locale?: string,
): NuriResourceGuide {
  // Translation dictionaries can translate known labels, not arbitrary family
  // text. For an untranslated Chinese label in English UI use the generic
  // invitation; never present a mixed-language template as a translation.
  const label=(value:unknown,limit:number)=>{
    const cleaned=familyLabel(value,limit);
    if(locale!=="en"||!/[\u3400-\u9fff]/.test(cleaned))return cleaned;
    const translated=t(cleaned);
    return /[\u3400-\u9fff]/.test(translated)?"":translated;
  };
  const concern = label(input?.concern, 48);
  const stage = label(input?.stage, 32);
  const headline = concern
    ? t("聊聊「{concern}」", { concern })
    : t("想聊的时候，Nuri 都在");
  const intro = concern && stage
    ? t("孩子正处在{stage}，关于「{concern}」，你最在意什么？可以从最近的一件事聊起。", { concern, stage })
    : concern
      ? t("关于「{concern}」，你最在意什么？想聊的时候可以直接告诉 Nuri，不需要先整理。", { concern })
      : stage
        ? t("孩子正处在{stage}，你最近感觉怎么样？不需要先准备问题。", { stage })
        : t("不需要先查资料或整理问题。想聊的时候，直接说说最近的情况就好。");
  return {
    headline,
    intro,
    // Retained in the shared shape for older callsites, but deliberately empty:
    // QA 2026-10-18 found the fixed three-step checklist repetitive and burdensome.
    actions: [],
    disclosure: t("这是可选的聊天邀请，不是原文或完整视频摘要。"),
  };
}
