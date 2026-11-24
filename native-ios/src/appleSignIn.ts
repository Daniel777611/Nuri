import { useEffect, useState } from "react";
import { NativeModules, Platform, UIManager } from "react-native";
import { api, auth, type AppleChallengePurpose, type AppleCredential } from "./api";
import { installProviderSession, type ProviderSessionOptions, type ProviderSignInOutcome } from "./providerSignInSession";

type AppleBridge = { authorize: (nonce: string) => Promise<Omit<AppleCredential, "nonce"> | null> };
export const APPLE_CONTROL_NAME = "NuriAppleSignInControl";
const appleEnabled = process.env.EXPO_PUBLIC_ENABLE_APPLE_SIGN_IN === "1" && process.env.EXPO_PUBLIC_PREVIEW_MODE !== "1";
const bridge = () => NativeModules.NuriAppleAuthBridge as AppleBridge | undefined;
let authorizationBusy = false;
let signInBusy = false;

export function canUseNativeAppleSignIn(): boolean {
  return appleEnabled && Platform.OS === "ios"
    && typeof bridge()?.authorize === "function"
    && UIManager.hasViewManagerConfig?.(APPLE_CONTROL_NAME) === true;
}

export function useAppleSignInReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!canUseNativeAppleSignIn()) return;
    let active = true;
    void api.appleStatus().then(
      status => { if (active) setReady(status.enabled === true); },
      () => { if (active) setReady(false); },
    );
    return () => { active = false; };
  }, []);
  return ready;
}

export async function obtainAppleCredential(
  purpose: AppleChallengePurpose, current: () => boolean, expectedToken?: string,
): Promise<AppleCredential | null> {
  if (!canUseNativeAppleSignIn()) throw new Error("APPLE_SIGNIN_UNAVAILABLE");
  if (authorizationBusy || !current()) return null;
  authorizationBusy = true;
  try {
    const { nonce } = await api.appleChallenge(purpose, expectedToken);
    if (!current()) return null;
    if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error("APPLE_TOKEN_INVALID");
    const credential = await bridge()!.authorize(nonce);
    if (!current() || credential === null) return null;
    if (typeof credential.identity_token !== "string" || credential.identity_token.length > 8000
      || credential.identity_token.split(".").length !== 3 || typeof credential.authorization_code !== "string"
      || !credential.authorization_code || credential.authorization_code.length > 4096) throw new Error("APPLE_TOKEN_INVALID");
    const name = (value: string | undefined) => typeof value === "string" ? [...value].slice(0, 80).join("") || undefined : undefined;
    return {
      identity_token: credential.identity_token, authorization_code: credential.authorization_code, nonce,
      first_name: name(credential.first_name), last_name: name(credential.last_name),
    };
  } finally {
    authorizationBusy = false;
  }
}

export async function signInWithNativeApple(options: ProviderSessionOptions): Promise<ProviderSignInOutcome> {
  if (signInBusy || !options.current(options.ticket)) return "stale";
  signInBusy = true;
  const current = () => options.current(options.ticket);
  try {
    const existing = await auth.getToken();
    if (!current() || existing && !options.retryLocalFailure) return "stale";
    const credential = await obtainAppleCredential("signin", current);
    if (!current()) return "stale";
    if (!credential) return "cancelled";
    const response = await api.appleLogin({ ...credential, language: options.language });
    return await installProviderSession(response, options);
  } catch (error) {
    if (!current()) return "stale";
    throw error;
  } finally {
    signInBusy = false;
  }
}

export async function linkNativeAppleAccount(ticket: number, isCurrent: (ticket: number) => boolean): Promise<boolean> {
  const token = await auth.getToken();
  const current = () => isCurrent(ticket);
  if (!token || !current()) return false;
  const credential = await obtainAppleCredential("link", current, token);
  if (!credential || !current()) return false;
  const result = await api.linkApple(credential, token);
  // Linking does not replace the current NURI session.
  if (!current()) return false;
  if (result.user?.apple_sign_in_linked !== true) throw new Error("APPLE_LINK_UNCONFIRMED");
  return true;
}
