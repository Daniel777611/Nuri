import { api, auth } from "./api";
import { obtainNativeGoogleCredential, NativeGoogleAuthError } from "./googleNativeAuth";

export type GoogleStorageFailure = {
  kind: "save" | "read" | "onboarding";
  identity: number;
  generation: number;
};
export type GoogleSignInOutcome = "cancelled" | "stale" | "signed-in" | GoogleStorageFailure;
let loginBusy = false;

/** The same CAS / Keychain write-read / owner epoch contract as email login.
 * `created` is not account identity: only the verified server response is used. */
export async function signInWithNativeGoogle(options: {
  ticket: number;
  current: (ticket: number) => boolean;
  isMounted: () => boolean;
  language: string;
  setLocale: (locale: string) => Promise<unknown>;
  navigate: (onboarded: boolean) => void;
  retryLocalFailure?: boolean;
}): Promise<GoogleSignInOutcome> {
  if (loginBusy) throw new NativeGoogleAuthError("in-progress");
  if (!options.current(options.ticket)) return "stale";
  loginBusy = true;
  try {
    const existing = await auth.getToken();
    if (!options.current(options.ticket) || existing && !options.retryLocalFailure) return "stale";
    const credential = await obtainNativeGoogleCredential(() => options.current(options.ticket));
    if (!options.current(options.ticket)) return "stale";
    if (!credential) return "cancelled";
    const response = await api.googleLogin({ credential, language: options.language });
    if (!options.current(options.ticket)) return "stale";
    if (!response.access_token || !response.user?.id) throw new NativeGoogleAuthError("failed");
    const identity = auth.getIdentityGeneration() + 1;
    const saved = await auth.setToken(response.access_token, { expectedGeneration: options.ticket });
    const generation = saved ? auth.getSessionGeneration() : options.ticket + 2;
    const ownsPhase = () => options.isMounted() && identity === auth.getIdentityGeneration()
      && generation === auth.getSessionGeneration();
    const failure = (kind: GoogleStorageFailure["kind"]): GoogleSignInOutcome => ownsPhase()
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
  } catch (error) {
    // Actual API requests reject stale epochs rather than returning a result.
    // The obsolete chooser/exchange must not show an error over account B.
    if (!options.current(options.ticket)) return "stale";
    throw error;
  } finally { loginBusy = false; }
}
