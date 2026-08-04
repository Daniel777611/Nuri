import type { HeroCard } from "./components/HeroCarousel";
import type { FeedPreparationItem } from "./feedPreparation";

export type RecommendationDetailHandoff = {
  card: HeroCard;
  preparationItems: FeedPreparationItem[];
  createdAt: number;
};

const HANDOFF_TTL_MS = 15 * 60 * 1000;
const MAX_HANDOFFS = 12;
const handoffs = new Map<string, RecommendationDetailHandoff>();

export function recommendationDetailHandoffKey(card: HeroCard): string {
  return card.recommendation_id || `${card.id}:${card.content_category || "topic"}`;
}

export function storeRecommendationDetailHandoff(
  card: HeroCard,
  preparationItems: FeedPreparationItem[],
): string {
  const key = recommendationDetailHandoffKey(card);
  handoffs.delete(key);
  handoffs.set(key, {
    card: { ...card, resources: card.resources ? [...card.resources] : [] },
    preparationItems: preparationItems.map((item) => ({ ...item })),
    createdAt: Date.now(),
  });
  while (handoffs.size > MAX_HANDOFFS) {
    const oldestKey = handoffs.keys().next().value;
    if (typeof oldestKey !== "string") break;
    handoffs.delete(oldestKey);
  }
  return key;
}

export function getRecommendationDetailHandoff(
  key: string | undefined,
): RecommendationDetailHandoff | null {
  if (!key) return null;
  const handoff = handoffs.get(key);
  if (!handoff) return null;
  if (Date.now() - handoff.createdAt > HANDOFF_TTL_MS) {
    handoffs.delete(key);
    return null;
  }
  return handoff;
}
