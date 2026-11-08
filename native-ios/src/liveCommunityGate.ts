/** Runtime UI gate uses only Expo's statically inlined public variables.
 * The matching channel/bundle/OAuth identity is separately enforced while
 * packaging; never read a non-public Node env var from a Hermes bundle. */
export function isLiveCommunityEnabled(): boolean {
  return process.env.EXPO_PUBLIC_RELEASE_FLAVOR === "live-alpha"
    && [
      process.env.EXPO_PUBLIC_PREVIEW_MODE,
      process.env.EXPO_PUBLIC_UIUX48_GALLERY,
      process.env.EXPO_PUBLIC_FLOW_PROTOTYPE,
      process.env.EXPO_PUBLIC_COMMUNITY_PROTOTYPE,
    ].every(value => value === undefined || value === "0");
}
