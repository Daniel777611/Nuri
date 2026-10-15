// NURI-authored reading prompts, not a digest of an external resource.
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
): NuriResourceGuide {
  const concern = familyLabel(input?.concern, 48);
  const stage = familyLabel(input?.stage, 32);
  const headline = concern
    ? t("关于「{concern}」的 NURI 导读", { concern })
    : t("NURI 阅读导读");
  const intro = concern && stage
    ? t("你可以结合孩子目前的阶段（{stage}），围绕「{concern}」阅读原站内容，并核对哪些信息与你家有关。", { concern, stage })
    : concern
      ? t("围绕「{concern}」阅读原站内容，留意作者说明的适用情境，和你家的情况作比较。", { concern })
      : stage
        ? t("结合孩子目前的阶段（{stage}）阅读原站内容，留意作者说明的适用情境。", { stage })
        : t("阅读原站内容时，可以核对来源和适用情境，再决定是否继续了解。");
  return {
    headline,
    intro,
    actions: [
      t("到原站核对作者、发布日期和内容背景。"),
      t("记下与你家情况相关、还想进一步了解的问题。"),
      t("把你的问题和观察带回 NURI，一起梳理和讨论。"),
    ],
    disclosure: t("这是 NURI 根据你的关注点提供的导读，不是原文或完整视频摘要。"),
  };
}
