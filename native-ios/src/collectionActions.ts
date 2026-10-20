// The existing /favorites/save endpoint is a TOGGLE, not an idempotent move.
// Confirm current ownership/state before acting; never repeat an uncertain write.
type Favorite = { id: string; collection_id?: string | null };
type FavoriteTransport = {
  listFavorites: () => Promise<Favorite[]>;
  saveFavorite: (id: string, collectionId: string) => Promise<unknown>;
  toggleFavorite: (id: string) => Promise<unknown>;
};

export function validCollectionName(value: string): string | null {
  const name = value.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 20 ? name : null;
}

export async function assignFavoriteCollection(id: string, collectionId: string, transport: FavoriteTransport, isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error("SESSION_CHANGED");
  const item = (await transport.listFavorites()).find(item => item.id === id);
  if (!isCurrent()) throw new Error("SESSION_CHANGED");
  if (!item) throw new Error("FAVORITE_NO_LONGER_SAVED");
  if (item.collection_id === collectionId) return; // A second toggle would REMOVE it.
  const result = await transport.saveFavorite(id, collectionId);
  if (!result || typeof result !== "object" || !("saved" in result) || result.saved !== true
    || !("card_id" in result) || result.card_id !== id
    || !("collection_id" in result) || result.collection_id !== collectionId) {
    throw new Error("FAVORITE_ASSIGNMENT_UNCONFIRMED");
  }
}

export async function removeSavedFavorite(id: string, transport: FavoriteTransport, isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error("SESSION_CHANGED");
  const exists = (await transport.listFavorites()).some(item => item.id === id);
  if (!isCurrent()) throw new Error("SESSION_CHANGED");
  if (!exists) return;
  const result = await transport.toggleFavorite(id);
  if (!result || typeof result !== "object" || !("favorited" in result) || result.favorited !== false
    || !("card_id" in result) || result.card_id !== id) {
    throw new Error("FAVORITE_REMOVAL_UNCONFIRMED");
  }
}
