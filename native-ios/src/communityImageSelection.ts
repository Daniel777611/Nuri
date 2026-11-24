/** Async picker/decoding never retargets an image to a later chat or account.
 * The caller captures the account + navigation lease before opening a picker. */
export async function selectCommunityImage<A, P>(
  current: () => boolean,
  pick: () => Promise<A | null>,
  prepare: (asset: A) => Promise<P>,
): Promise<P | null> {
  if (!current()) return null;
  const asset = await pick();
  if (!asset || !current()) return null;
  const prepared = await prepare(asset);
  return current() ? prepared : null;
}

export const COMMUNITY_CHAT_PHOTO_LIMIT = 10;
const LEGACY_MESSAGE_MEDIA_LIMIT = 9;

export async function selectCommunityImages<A, P>(
  current: () => boolean,
  pick: () => Promise<readonly A[]>,
  prepare: (asset: A) => Promise<P>,
  limit: number,
): Promise<P[]> {
  if (!current() || limit < 1) return [];
  const assets = (await pick()).slice(0, limit);
  const selected: P[] = [];
  for (const asset of assets) {
    if (!current()) return [];
    selected.push(await prepare(asset));
  }
  return current() ? selected : [];
}

/** Preserve picker order if the connected server needs multiple messages. */
export async function sendCommunityChatPhotos<Photo>(
  photos: readonly Photo[],
  caption: string,
  current: () => boolean,
  upload: (photo: Photo) => Promise<string>,
  send: (caption: string, mediaIds: string[]) => Promise<unknown>,
  accepted: (photos: readonly Photo[], caption: string) => void,
  serverMediaLimit?: number,
): Promise<void> {
  const chunkSize = typeof serverMediaLimit === "number" && serverMediaLimit >= COMMUNITY_CHAT_PHOTO_LIMIT
    ? COMMUNITY_CHAT_PHOTO_LIMIT : LEGACY_MESSAGE_MEDIA_LIMIT;
  for (let offset = 0; offset < Math.max(photos.length, 1); offset += chunkSize) {
    const chunk = photos.slice(offset, offset + chunkSize);
    const mediaIds: string[] = [];
    for (const photo of chunk) {
      if (!current()) return;
      mediaIds.push(await upload(photo));
    }
    if (!current()) return;
    const text = offset === 0 ? caption : "";
    await send(text, mediaIds);
    accepted(chunk, text);
  }
}
