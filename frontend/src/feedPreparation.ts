import {
  api,
  type PrepareFeedResponse,
} from "./api";

export type FeedPreparationItem = {
  card_id: string;
  recommendation_id: string;
};

// Home and Detail can briefly overlap while a route transition is happening.
// Reuse the same request so one tap never launches a second expensive research
// job for the identical frozen recommendation set.
const inFlightFeedPreparations = new Map<string, Promise<PrepareFeedResponse>>();

function preparationKey(items: FeedPreparationItem[]): string {
  return [...items]
    .sort((left, right) =>
      left.recommendation_id.localeCompare(right.recommendation_id),
    )
    .map((item) => `${item.recommendation_id}:${item.card_id}`)
    .join("|");
}

export function preparePersonalizedFeedOnce(items: FeedPreparationItem[]) {
  const normalized = [...items].sort((left, right) =>
    left.recommendation_id.localeCompare(right.recommendation_id),
  );
  const key = preparationKey(normalized);
  const existing = inFlightFeedPreparations.get(key);
  if (existing) return existing;

  const pending = api.preparePersonalizedFeed(normalized);
  inFlightFeedPreparations.set(key, pending);
  const clear = () => {
    if (inFlightFeedPreparations.get(key) === pending) {
      inFlightFeedPreparations.delete(key);
    }
  };
  pending.then(clear, clear);
  return pending;
}
