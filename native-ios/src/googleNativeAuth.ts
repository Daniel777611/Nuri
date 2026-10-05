import { NativeModules, Platform, TurboModuleRegistry } from "react-native";
import type * as GoogleSDK from "@react-native-google-signin/google-signin";

export type NativeGoogleConfiguration = {
  bundleId: string;
  iosClientId: string;
  webClientId: string;
  callbackRegistered: boolean;
};

export class NativeGoogleAuthError extends Error {
  constructor(public readonly code: "unavailable" | "in-progress" | "invalid-token" | "failed") {
    super("Native Google sign-in did not complete.");
    this.name = "NativeGoogleAuthError";
  }
}

const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
let providerBusy = false;

export function validNativeGoogleConfiguration(value: unknown): value is NativeGoogleConfiguration {
  const config = value as Partial<NativeGoogleConfiguration> | null;
  return !!config && config.bundleId === "com.ordashtech.nuri.nativelab"
    && typeof config.iosClientId === "string" && CLIENT_ID.test(config.iosClientId)
    && typeof config.webClientId === "string" && CLIENT_ID.test(config.webClientId)
    && config.callbackRegistered === true;
}

/** Inspect the installed binary, not JS env guesses or the original app's ID. */
export async function getNativeGoogleConfiguration(): Promise<NativeGoogleConfiguration | null> {
  if (Platform.OS !== "ios" || !TurboModuleRegistry.get("RNGoogleSignin")) return null;
  const bridge = NativeModules.NuriGoogleAuthBridge;
  if (!bridge?.getConfiguration) return null;
  try {
    const config: unknown = await bridge.getConfiguration();
    return validNativeGoogleConfiguration(config) ? config : null;
  } catch { return null; }
}

/** Lazy loading keeps an older / unconfigured binary from crashing at import. */
export function getNativeGoogleSDK(): typeof GoogleSDK {
  if (Platform.OS !== "ios" || !TurboModuleRegistry.get("RNGoogleSignin")) {
    throw new NativeGoogleAuthError("unavailable");
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@react-native-google-signin/google-signin") as typeof GoogleSDK;
}

/** Interactive native SDK only. No GIS DOM, embedded WebView, silent restore,
 * offline grants, or client-side trust of email/user-id claims. */
export async function obtainNativeGoogleCredential(shouldContinue: () => boolean = () => true): Promise<string | null> {
  if (providerBusy) throw new NativeGoogleAuthError("in-progress");
  providerBusy = true;
  let sdk: typeof GoogleSDK | null = null;
  try {
    const config = await getNativeGoogleConfiguration();
    if (!shouldContinue()) return null;
    if (!config) throw new NativeGoogleAuthError("unavailable");
    sdk = getNativeGoogleSDK();
    sdk.GoogleSignin.configure({ iosClientId: config.iosClientId, webClientId: config.webClientId, offlineAccess: false });
    // Do not resurrect a cached provider account after a NURI logout/switch.
    await sdk.GoogleSignin.signOut();
    if (!shouldContinue()) return null;
    const response = await sdk.GoogleSignin.signIn();
    if (response.type === "cancelled") return null;
    const credential = response.data.idToken;
    if (typeof credential !== "string" || credential.length < 20 || credential.length > 8000 || credential.split(".").length !== 3) {
      throw new NativeGoogleAuthError("invalid-token");
    }
    return credential;
  } catch (error) {
    if (error instanceof NativeGoogleAuthError) throw error;
    if (sdk?.isErrorWithCode(error) && error.code === sdk.statusCodes.SIGN_IN_CANCELLED) return null;
    // Do not put SDK error messages, provider tokens, or profiles in logs/UI.
    throw new NativeGoogleAuthError("failed");
  } finally {
    // Sign out the provider's app-local cache, never revoke Google's grants.
    // NURI persists only its own server-issued JWT through existing SecureStore.
    try { await sdk?.GoogleSignin.signOut(); } catch { /* No token fallback. */ }
    providerBusy = false;
  }
}
