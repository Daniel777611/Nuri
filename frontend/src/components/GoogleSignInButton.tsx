// "Continue with Google" — one tap to sign in, or to sign up.
//
// Google Identity Services draws the button itself (its branding rules ask
// for the official one) and hands back a signed ID token, which the server
// checks and turns into a NURI session (POST /api/auth/google).
//
// Shown only where it can work:
// - a browser on the web build — Google refuses to sign in inside embedded
//   WebViews (403 disallowed_useragent), so the iOS/Android shells hide it
//   until they sign in natively;
// - when EXPO_PUBLIC_GOOGLE_CLIENT_ID is set at build time.
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { api, apiErrorDetail, auth } from "@/src/api";
import { useT } from "@/src/i18n";
import { isNativeShell } from "@/src/nativeShell";
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

/** Whether this page can offer Google sign-in at all. */
export function googleSignInAvailable(): boolean {
  return Platform.OS === "web" && !!CLIENT_ID && !isNativeShell();
}

const GSI_LOCALE: Record<string, string> = { "zh-CN": "zh_CN", "zh-TW": "zh_TW", en: "en" };

export default function GoogleSignInButton({ width }: { width: number }) {
  const router = useRouter();
  const { t, locale, setLocale } = useT();
  const slot = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const available = googleSignInAvailable();

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
        setError(
          apiErrorDetail(e) === "GOOGLE_SIGNIN_UNAVAILABLE"
            ? t("Google 登录暂时不可用，请用邮箱登录。")
            : t("Google 登录没有成功，请再试一次。"),
        );
        setBusy(false);
      }
    },
    [locale, router, setLocale, t],
  );

  useEffect(() => {
    if (!available) return;
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
  }, [available, locale, onCredential, t, width]);

  if (!available) return null;
  return (
    <View style={styles.wrap} testID="google-signin">
      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>{t("或")}</Text>
        <View style={styles.dividerLine} />
      </View>
      <View style={[styles.slot, busy && { opacity: 0.5 }]}>
        {createElement("div", { ref: slot, style: { display: "flex", justifyContent: "center", minHeight: 44 } })}
      </View>
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
  note: { color: colors.muted, fontSize: type.sm, textAlign: "center", marginTop: spacing.sm },
  error: { color: colors.error, fontSize: type.sm, textAlign: "center", marginTop: spacing.sm },
});
