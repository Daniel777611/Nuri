// Web build of "Sign in with Google" (browsers and the WebView shells). The
// native app uses GoogleSignInButton.tsx and Google's iOS SDK instead.
//
// Shown only where it can work, and only when EXPO_PUBLIC_GOOGLE_CLIENT_ID is
// set at build time:
// - a browser: Google's own button (Google Identity Services), whose branding
//   rules ask for the official one;
// - the Android shell (0.2.0+): Google refuses to sign in inside a WebView
//   (403 disallowed_useragent), so the button asks the shell, which shows the
//   system's Google account sheet and hands back the same kind of ID token;
// - the iOS WebView shell: hidden, it can't sign in with Google yet.
// Either way the token goes through signInWithNativeGoogle, the same session
// contract as the native app (POST /api/auth/google).
import { createElement, useCallback, useEffect, useRef, useState as useLocalState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useNuriTheme } from "@/src/uiux48/Theme";
import { apiErrorDetail, auth } from "@/src/api";
import { useT, translate } from "@/src/i18n";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { signInWithNativeGoogle, type GoogleStorageFailure } from "@/src/googleSignInSession";
import { safeNotificationRoute } from "@/src/nativePushRuntime";
import { isNativeShell, shellSignsInWithGoogle } from "@/src/nativeShell.web";
import { colors, spacing, type } from "@/src/theme";

const CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || "";
const GSI_SRC = "https://accounts.google.com/gsi/client";
const SHELL_CREDENTIAL_EVENT = "nuri:google-credential";
const GSI_LOCALE: Record<string, string> = { "zh-CN": "zh_CN", "zh-TW": "zh_TW", en: "en" };

let gsiLoading: Promise<void> | null = null;

function loadGsi(): Promise<void> {
  if ((window as any).google?.accounts?.id) return Promise.resolve();
  if (gsiLoading) return gsiLoading;
  gsiLoading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gsiLoading = null;
      reject(new Error("gsi load failed"));
    };
    document.head.appendChild(script);
  });
  return gsiLoading;
}

/** How this page signs in with Google: Google's button in a browser, the
 *  shell's account sheet in a shell that can, otherwise not at all. */
function googleSignInMode(): "browser" | "shell" | null {
  if (Platform.OS !== "web" || !CLIENT_ID) return null;
  if (!isNativeShell()) return "browser";
  return shellSignsInWithGoogle() ? "shell" : null;
}

class ShellSignInError extends Error {
  constructor(public readonly code: string) {
    super("Shell Google sign-in did not complete.");
  }
}

/** Ask the Android shell for an ID token; null when the parent closes the sheet. */
function credentialFromShell(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const onAnswer = (event: Event) => {
      window.removeEventListener(SHELL_CREDENTIAL_EVENT, onAnswer);
      const detail = (event as CustomEvent).detail || {};
      if (typeof detail.credential === "string" && detail.credential) resolve(detail.credential);
      else if (detail.error === "cancelled") resolve(null);
      else reject(new ShellSignInError(typeof detail.error === "string" ? detail.error : "failed"));
    };
    window.addEventListener(SHELL_CREDENTIAL_EVENT, onAnswer);
    try {
      (window as any).ReactNativeWebView?.postMessage(JSON.stringify({ type: "nuri:google-sign-in" }));
    } catch {
      window.removeEventListener(SHELL_CREDENTIAL_EVENT, onAnswer);
      reject(new ShellSignInError("failed"));
    }
  });
}

export default function GoogleSignInButton({ disabled = false, returnTo, acquire, release, onBusyChange }: {
  disabled?: boolean;
  returnTo?: string;
  acquire?: () => boolean;
  release?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const router = useRouter();
  const theme = useNuriTheme();
  const { t, locale, setLocale } = useT();
  const { generation, capture, current, isMounted } = useAccountScope();
  const [busy, setBusy] = useAccountState(false);
  const [error, setError] = useAccountState<string | null>(null);
  const [localFailure, setLocalFailure] = useLocalState<GoogleStorageFailure | null>(null);
  const [width, setWidth] = useLocalState(312);
  const slot = useRef<HTMLDivElement | null>(null);
  const active = useRef(false);
  const mode = googleSignInMode();
  const failure = localFailure?.identity === auth.getIdentityGeneration() && localFailure.generation === generation ? localFailure.kind : null;
  const localFailureCopy = {
    save: t("本机未能安全保存 Google 登录凭据。请重试 Google 或使用邮箱；本次登录尚未确认完成。"),
    read: t("本机未能读回安全保存的登录凭据。请重试 Google 或使用邮箱；登录尚未确认完成。"),
    onboarding: t("本机未能保存登录设置。请重试 Google 或使用邮箱；登录设置尚未完成。"),
  };

  const submit = useCallback(async (obtainCredential: () => Promise<string | null>) => {
    const ticket = capture();
    if (ticket === null || disabled || active.current) return;
    if (acquire && !acquire()) return;
    active.current = true;
    setBusy(true); setError(null); setLocalFailure(null); onBusyChange?.(true);
    try {
      const result = await signInWithNativeGoogle({ ticket, current, isMounted, language: locale, setLocale,
        retryLocalFailure: !!failure,
        obtainCredential,
        navigate: (onboarded) => {
          const candidate = safeNotificationRoute(returnTo);
          const notification = candidate && /^\/notifications\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
          router.replace(onboarded ? (notification ?? "/(tabs)") as never : "/onboarding");
        },
      });
      if (typeof result === "object" && isMounted() && result.identity === auth.getIdentityGeneration() && result.generation === auth.getSessionGeneration()) {
        setLocalFailure(result);
      }
    } catch (reason) {
      if (!current(ticket)) return;
      if (reason instanceof ShellSignInError && reason.code === "no_account") {
        setError(t("这台手机上还没有 Google 账号，可以先在系统设置里添加，或用邮箱登录。"));
      } else {
        setError(apiErrorDetail(reason) === "GOOGLE_SIGNIN_UNAVAILABLE"
          ? t("Google 登录暂时不可用，请用邮箱登录。") : t("Google 登录没有成功，请再试一次。"));
      }
    } finally {
      active.current = false; release?.(); setBusy(false); onBusyChange?.(false);
    }
  }, [acquire, capture, current, disabled, failure, isMounted, locale, onBusyChange, release, returnTo, router, setBusy, setError, setLocale, setLocalFailure, t]);

  // GIS calls back with the token; keep the latest submit for it.
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    if (mode !== "browser") return;
    let cancelled = false;
    loadGsi()
      .then(() => {
        const gsi = (window as any).google?.accounts?.id;
        if (cancelled || !gsi || !slot.current) return;
        gsi.initialize({
          client_id: CLIENT_ID,
          callback: (response: { credential?: string }) => {
            if (response?.credential) void submitRef.current(async () => response.credential!);
          },
          ux_mode: "popup",
          // FedCM is how Chrome will show the account chooser from now on.
          use_fedcm_for_prompt: true,
        });
        slot.current.innerHTML = "";
        gsi.renderButton(slot.current, {
          type: "standard",
          theme: theme.night ? "filled_black" : "outline",
          size: "large",
          text: "continue_with",
          shape: "pill",
          logo_alignment: "center",
          width: Math.min(400, Math.max(200, Math.round(width))),
          locale: GSI_LOCALE[locale] || "zh_CN",
        });
      })
      .catch(() => { if (!cancelled) setError(t("Google 登录加载失败，请检查网络或用邮箱登录。")); });
    return () => { cancelled = true; };
  }, [mode, locale, setError, t, theme.night, width]);

  if (!mode) return null;
  return <View style={styles.wrap} testID="google-signin" onLayout={(e) => setWidth(Math.min(312, e.nativeEvent.layout.width))}>
    <Text style={[styles.dividerText,{color:theme.secondary,marginBottom:12}]}>{locale==="en"?"Or sign in with":translate(locale, "或使用以下方式登录")}</Text>
    {mode === "shell" ? (
      <Pressable style={{minHeight:44,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:10,opacity:disabled||busy?.5:1}} disabled={disabled||busy} onPress={() => void submit(credentialFromShell)} testID="google-signin-shell" accessibilityRole="button" accessibilityLabel={t("用 Google 继续")}>
        <Image source={require("@/assets/uiux48/google-sdk-logo.png")} style={{width:20,height:20}} contentFit="contain" />
        <Text style={{fontSize:16,lineHeight:22,color:theme.ink}}>{locale==="en"?"Sign in with Google":translate(locale, "使用 Google 登录")}</Text>
      </Pressable>
    ) : (
      <View style={[styles.slot, (disabled || busy) && { opacity: 0.5 }]} pointerEvents={disabled || busy ? "none" : "auto"}>
        {createElement("div", { ref: slot, style: { display: "flex", justifyContent: "center", minHeight: 44 } })}
      </View>
    )}
    {busy ? <ActivityIndicator style={styles.note} accessibilityLabel={t("正在登录…")} /> : null}
    {failure || error ? <Text style={styles.error} testID="google-signin-error" accessibilityLiveRegion="polite">{failure ? localFailureCopy[failure] : error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", alignSelf: "stretch" },
  dividerText: { color: colors.muted, fontSize: type.sm },
  slot: { alignItems: "center", alignSelf: "stretch" },
  note: { color: colors.muted, fontSize: type.sm, textAlign: "center", marginTop: spacing.sm },
  error: { color: colors.error, fontSize: type.sm, textAlign: "center", marginTop: spacing.sm },
});
