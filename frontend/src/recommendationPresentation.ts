import type {
  PersonalizedContentCategory,
  PreparedLearningResource,
} from "./api";

export type RecommendationPresentationCard = {
  content_category?: PersonalizedContentCategory;
  publisher?: string;
  source_label?: string;
  language_label?: string;
  estimated_time_label?: string;
  applicable_stage?: string;
  development_stage?: string;
  child_age_context?: string;
  preferred_locale?: string;
  resources?: PreparedLearningResource[];
};

export const DELIVERY_CATEGORY_META: Record<
  PersonalizedContentCategory,
  { label: string; promise: string; icon: "shield-checkmark-outline" | "bulb-outline" | "people-outline" }
> = {
  authority: {
    label: "权威答案",
    promise: "看懂当前阶段和观察重点",
    icon: "shield-checkmark-outline",
  },
  featured: {
    label: "精选方法",
    promise: "找到今天就能尝试的方法",
    icon: "bulb-outline",
  },
  case: {
    label: "相似案例",
    promise: "看看相似家庭怎样实践",
    icon: "people-outline",
  },
};

const LOCALE_LABELS: Record<string, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  en: "English",
};

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function resourceMinutes(resource: PreparedLearningResource): number | null {
  const candidates = [
    resource.estimated_minutes,
    resource.reading_minutes,
    resource.duration_minutes,
  ];
  for (const value of candidates) {
    const minutes = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(minutes) && minutes > 0 && minutes <= 180) {
      return Math.ceil(minutes);
    }
  }
  return null;
}

export function deliveryCategoryMeta(
  category?: PersonalizedContentCategory,
) {
  return DELIVERY_CATEGORY_META[category || "authority"];
}

export function recommendationSourceLabel(
  card: RecommendationPresentationCard,
): string {
  return cleanText(card.source_label) || cleanText(card.publisher) || "NURI 严选来源";
}

export function recommendationLanguageLabel(
  card: RecommendationPresentationCard,
): string {
  const explicit = cleanText(card.language_label);
  if (explicit) return explicit;

  const article = card.resources?.find((resource) => resource.kind === "article");
  const video = card.resources?.find((resource) => resource.kind === "video");
  const articleLanguage = cleanText(article?.language);
  const spokenLanguage = cleanText(video?.spoken_language);
  if (articleLanguage && spokenLanguage === "mandarin") {
    return `${articleLanguage} · 普通话`;
  }
  if (articleLanguage && spokenLanguage === "english") {
    return `${articleLanguage} · 英语视频`;
  }
  if (articleLanguage) return articleLanguage;
  return LOCALE_LABELS[card.preferred_locale || ""] || "偏好语言";
}

export function recommendationTimeLabel(
  card: RecommendationPresentationCard,
): string {
  const explicit = cleanText(card.estimated_time_label);
  if (explicit) return explicit;
  const minutes = (card.resources || [])
    .map(resourceMinutes)
    .filter((value): value is number => value !== null)
    .reduce((total, value) => total + value, 0);
  return minutes > 0 ? `约 ${minutes} 分钟` : "约 6–10 分钟";
}

export function recommendationStageLabel(
  card: RecommendationPresentationCard,
): string {
  const explicit =
    cleanText(card.applicable_stage) ||
    cleanText(card.development_stage) ||
    cleanText(card.child_age_context).replace(/^孩子当前年龄[：:]\s*/, "");
  return explicit || "当前发展阶段";
}

export function recommendationActionSteps(detail: Record<string, unknown>): string[] {
  const raw =
    detail.action_steps ||
    detail.today_actions ||
    detail.next_actions ||
    detail.actions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) =>
      typeof item === "string"
        ? cleanText(item)
        : item && typeof item === "object"
          ? cleanText(
              (item as Record<string, unknown>).text ||
                (item as Record<string, unknown>).title ||
                (item as Record<string, unknown>).action,
            )
          : "",
    )
    .filter(Boolean)
    .slice(0, 3);
}
