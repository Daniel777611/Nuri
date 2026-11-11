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
const SUPPORTED_IOS_BUNDLES = new Set(["com.ordashtech.nuri.nativelab", "com.ordashtech.nuri.beta", "com.ordashtech.nuri.earlyaccess"]);
const PRODUCTION_IOS_CLIENT_ID = "22059260132-gpd9u7gra897fs9p7ue6n62sa0nppfuv.apps.googleusercontent.com";
const BETA_IOS_CLIENT_ID = "22059260132-d1bj5842fjq1f4g6v097flm5ubn6fsdo.apps.googleusercontent.com";
let providerBusy = false;

export function validNativeGoogleConfiguration(value: unknown): value is NativeGoogleConfiguration {
  const config = value as Partial<NativeGoogleConfiguration> | null;
  return !!config && typeof config.bundleId === "string" && SUPPORTED_IOS_BUNDLES.has(config.bundleId)
    && typeof config.iosClientId === "string" && CLIENT_ID.test(config.iosClientId)
    && typeof config.webClientId === "string" && CLIENT_ID.test(config.webClientId)
    && (config.bundleId !== "com.ordashtech.nuri.beta" || config.iosClientId === BETA_IOS_CLIENT_ID)
    && (config.bundleId !== "com.ordashtech.nuri.earlyaccess"
      || ![PRODUCTION_IOS_CLIENT_ID, BETA_IOS_CLIENT_ID, config.webClientId].includes(config.iosClientId))
    && (config.bundleId === "com.ordashtech.nuri.nativelab" || config.iosClientId !== config.webClientId)
    && config.callbackRegistered === true;
}

/** Google's public Web client: the audience of every ID token NURI's backend
 *  accepts. Android needs nothing else; its OAuth client is matched by the
 *  package name and signing certificate registered in Google Cloud. */
const ANDROID_WEB_CLIENT_ID = "22059260132-e9njjaftvdn0farumni9b67p6l17nfgt.apps.googleusercontent.com";

const hasGoogleSDK = () => (Platform.OS === "ios" || Platform.OS === "android") && !!TurboModuleRegistry.get("RNGoogleSignin");

/** Inspect the installed binary, not JS env guesses or the original app's ID. */
export async function getNativeGoogleConfiguration(): Promise<NativeGoogleConfiguration | null> {
  if (Platform.OS === "android") {
    return hasGoogleSDK()
      ? { bundleId: "com.ordashtech.nuri", iosClientId: "", webClientId: ANDROID_WEB_CLIENT_ID, callbackRegistered: true }
      : null;
  }
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
  if (!hasGoogleSDK()) {
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
    sdk.GoogleSignin.configure({ ...(config.iosClientId ? { iosClientId: config.iosClientId } : {}), webClientId: config.webClientId, offlineAccess: false });
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
