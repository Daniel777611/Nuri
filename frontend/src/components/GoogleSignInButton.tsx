// "Continue with Google" — one tap to sign in, or to sign up.
//
// Google Identity Services draws the button itself (its branding rules ask
// for the official one) and hands back a signed ID token, which the server
// checks and turns into a NURI session (POST /api/auth/google).
//
// Shown only where it can work, and only when EXPO_PUBLIC_GOOGLE_CLIENT_ID is
// set at build time:
// - a browser: Google's own button (Google Identity Services);
// - the Android shell (0.2.0+): Google refuses to sign in inside a WebView
//   (403 disallowed_useragent), so this button asks the shell, which shows the
//   system's Google account sheet and hands back the same kind of ID token;
// - the iOS shell: hidden until it signs in natively too.
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { api, apiErrorDetail, auth } from "@/src/api";
import { useT } from "@/src/i18n";
import { isNativeShell, shellSignsInWithGoogle } from "@/src/nativeShell";
import { colors, spacing, type } from "@/src/theme";

const CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || "";
const GSI_SRC = "https://accounts.google.com/gsi/client";

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
export function googleSignInMode(): "browser" | "shell" | null {
  if (Platform.OS !== "web" || !CLIENT_ID) return null;
  if (!isNativeShell()) return "browser";
  return shellSignsInWithGoogle() ? "shell" : null;
}

/** Whether this page can offer Google sign-in at all. */
export function googleSignInAvailable(): boolean {
  return googleSignInMode() !== null;
}

const SHELL_CREDENTIAL_EVENT = "nuri:google-credential";

/** Google's four-colour "G", as its branding guidelines draw it. */
function GoogleLogo() {
  return createElement(
    "svg",
    { width: 18, height: 18, viewBox: "0 0 48 48", "aria-hidden": true },
    createElement("path", { fill: "#EA4335", d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" }),
    createElement("path", { fill: "#4285F4", d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" }),
    createElement("path", { fill: "#FBBC05", d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" }),
    createElement("path", { fill: "#34A853", d: "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" }),
  );
}

const GSI_LOCALE: Record<string, string> = { "zh-CN": "zh_CN", "zh-TW": "zh_TW", en: "en" };

export default function GoogleSignInButton({ width }: { width: number }) {
  const router = useRouter();
  const { t, locale, setLocale } = useT();
  const slot = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mode = googleSignInMode();
  const available = mode !== null;

  const onCredential = useCallback(
    async (response: { credential?: string }) => {
      if (!response?.credential) return;
      setError(null);
      setBusy(true);
      try {
        const res = await api.googleLogin({ credential: response.credential, language: locale });
        await auth.setToken(res.access_token);
        if (res.user?.language) await setLocale(res.user.language);
        const onboarded = !!res.user?.onboarding_completed;
        await auth.setOnboarded(onboarded);
        router.replace(onboarded ? "/(tabs)" : "/onboarding");
      } catch (e) {
        const detail = apiErrorDetail(e);
        setError(
          detail === "GOOGLE_SIGNIN_UNAVAILABLE"
            ? t("Google 登录暂时不可用，请用邮箱登录。")
            : detail === "GOOGLE_EMAIL_USE_PASSWORD"
              ? t("这个邮箱已经注册过 NURI，请用邮箱和密码登录。")
              : t("Google 登录没有成功，请再试一次。"),
        );
        setBusy(false);
      }
    },
    [locale, router, setLocale, t],
  );

  // In the shell, the answer to "nuri:google-sign-in" comes back as an event.
  useEffect(() => {
    if (mode !== "shell") return;
    const onShellCredential = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (typeof detail.credential === "string" && detail.credential) {
        void onCredential({ credential: detail.credential });
        return;
      }
      setBusy(false);
      if (detail.error === "cancelled") return; // the parent closed the sheet
      setError(
        detail.error === "no_account"
          ? t("这台手机上还没有 Google 账号，可以先在系统设置里添加，或用邮箱登录。")
          : t("Google 登录没有成功，请再试一次。"),
      );
    };
    window.addEventListener(SHELL_CREDENTIAL_EVENT, onShellCredential);
    return () => window.removeEventListener(SHELL_CREDENTIAL_EVENT, onShellCredential);
  }, [mode, onCredential, t]);

  const askShell = useCallback(() => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      (window as any).ReactNativeWebView?.postMessage(JSON.stringify({ type: "nuri:google-sign-in" }));
    } catch {
      setBusy(false);
      setError(t("Google 登录没有成功，请再试一次。"));
    }
  }, [busy, t]);

  useEffect(() => {
    if (mode !== "browser") return;
    let cancelled = false;
    loadGsi()
      .then(() => {
        const gsi = (window as any).google?.accounts?.id;
        if (cancelled || !gsi || !slot.current) return;
        gsi.initialize({
          client_id: CLIENT_ID,
          callback: onCredential,
          ux_mode: "popup",
          // FedCM is how Chrome will show the account chooser from now on.
          use_fedcm_for_prompt: true,
        });
        slot.current.innerHTML = "";
        gsi.renderButton(slot.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "pill",
          logo_alignment: "center",
          width: Math.min(400, Math.max(200, Math.round(width))),
          locale: GSI_LOCALE[locale] || "zh_CN",
        });
      })
      .catch(() => !cancelled && setError(t("Google 登录加载失败，请检查网络或用邮箱登录。")));
    return () => {
      cancelled = true;
    };
  }, [mode, locale, onCredential, t, width]);

  if (!available) return null;
  return (
    <View style={styles.wrap} testID="google-signin">
      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>{t("或")}</Text>
        <View style={styles.dividerLine} />
      </View>
      {mode === "shell" ? (
        <Pressable
          onPress={askShell}
          disabled={busy}
          style={({ pressed }) => [
            styles.shellButton,
            { width: Math.min(400, Math.max(200, Math.round(width))) },
            (pressed || busy) && { opacity: 0.6 },
          ]}
          accessibilityRole="button"
          testID="google-signin-shell"
        >
          <GoogleLogo />
          <Text style={styles.shellButtonText}>{t("使用 Google 账号继续")}</Text>
        </Pressable>
      ) : (
        <View style={[styles.slot, busy && { opacity: 0.5 }]}>
          {createElement("div", { ref: slot, style: { display: "flex", justifyContent: "center", minHeight: 44 } })}
        </View>
      )}
      {busy ? <Text style={styles.note}>{t("正在登录…")}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.lg },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.muted, fontSize: type.sm },
  slot: { alignItems: "center" },
  // Google's light button: white, grey outline, pill, logo then label.
  shellButton: {
    alignSelf: "center",
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#747775",
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 12,
  },
  shellButtonText: { color: "#1F1F1F", fontSize: 14, fontWeight: "500" },
  note: { color: colors.muted, fontSize: type.sm, textAlign: "center", marginTop: spacing.sm },
  error: { color: colors.error, fontSize: type.sm, textAlign: "center", marginTop: spacing.sm },
});
