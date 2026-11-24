import { auth, type AuthResponse } from "./api";

export type ProviderStorageFailure = {
  kind: "save" | "read" | "onboarding";
  identity: number;
  generation: number;
};
export type ProviderSignInOutcome = "cancelled" | "stale" | "signed-in" | ProviderStorageFailure;
export type ProviderSessionOptions = {
  ticket: number;
  current: (ticket: number) => boolean;
  isMounted: () => boolean;
  language: string;
  setLocale: (locale: string) => Promise<unknown>;
  navigate: (onboarded: boolean) => void;
  retryLocalFailure?: boolean;
};

/** Install only the server-verified NURI token and compare-and-swap its owner. */
export async function installProviderSession(response: AuthResponse, options: ProviderSessionOptions): Promise<ProviderSignInOutcome> {
  if (!options.current(options.ticket)) return "stale";
  if (!response.access_token || !response.user?.id) throw new Error("INVALID_PROVIDER_RESPONSE");
  const identity = auth.getIdentityGeneration() + 1;
  const saved = await auth.setToken(response.access_token, { expectedGeneration: options.ticket });
  const generation = saved ? auth.getSessionGeneration() : options.ticket + 2;
  const ownsPhase = () => options.isMounted() && identity === auth.getIdentityGeneration()
    && generation === auth.getSessionGeneration();
  const failure = (kind: ProviderStorageFailure["kind"]): ProviderSignInOutcome => ownsPhase()
    ? { kind, identity, generation } : "stale";
  if (!saved) return failure("save");
  const ownsToken = async () => {
    if (!ownsPhase()) return false;
    const token = await auth.getToken();
    return ownsPhase() && token === response.access_token;
  };
  if (!await ownsToken()) return failure("read");
  if (typeof response.user.language === "string" && response.user.language) {
    try { await options.setLocale(response.user.language); }
    catch { return failure("onboarding"); }
  }
  if (!await ownsToken()) return failure("read");
  const onboarded = !!response.user.onboarding_completed;
  const stored = await auth.setOnboarded(onboarded, { expectedToken: response.access_token, expectedGeneration: generation });
  if (!stored) return await ownsToken() ? failure("onboarding") : "stale";
  if (!await ownsToken()) return failure("read");
  options.navigate(onboarded);
  return "signed-in";
}
