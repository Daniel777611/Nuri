// Pick the card's text in the language the parent is reading.
//
// The backend composes a card's own sentences — the title, the guide, the
// reason it was chosen — with the family's own words already inside them. The
// translation table cannot reach those: they arrive finished and match no key.
// So the backend now composes each of them in all three languages at generation
// time and ships them alongside.
//
// It generates rather than translates on demand for one reason: a prepared card
// is frozen into a snapshot. Without every language present from the start, a
// family that switches language keeps reading the old one until something
// re-prepares the card.
//
// Only what the app composes. A resource's title, publisher and description are
// the publisher's words, and the delivery gate already selects *different
// resources* per locale — so there is no single card to render three ways, only
// one wrapper around three selections.

import type { Locale } from "@/src/i18n";

type Variants = Record<string, Record<string, string> | undefined>;

type WithVariants = {
  text_i18n?: Variants;
  personalization_reason_i18n?: Record<string, string>;
  topic_label_i18n?: Record<string, string>;
} & Record<string, unknown>;

/** A composed field in `locale`, falling back to the flat field the backend has
 *  always sent — so a client reading an older card, or a card prepared before
 *  this shipped, still renders. */
export function cardText(
  card: WithVariants | null | undefined,
  field: string,
  locale: Locale,
): string {
  if (!card) return "";
  const variant = card.text_i18n?.[locale]?.[field];
  if (typeof variant === "string" && variant) return variant;
  const flat = card[field];
  return typeof flat === "string" ? flat : "";
}

export function cardReason(
  card: WithVariants | null | undefined,
  locale: Locale,
): string {
  if (!card) return "";
  const variant = card.personalization_reason_i18n?.[locale];
  if (variant) return variant;
  const flat = card.personalization_reason;
  return typeof flat === "string" ? flat : "";
}

export function cardTopicLabel(
  card: WithVariants | null | undefined,
  locale: Locale,
): string {
  if (!card) return "";
  const variant = card.topic_label_i18n?.[locale];
  if (variant) return variant;
  const flat = card.topic_label;
  return typeof flat === "string" ? flat : "";
}
