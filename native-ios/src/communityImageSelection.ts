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
