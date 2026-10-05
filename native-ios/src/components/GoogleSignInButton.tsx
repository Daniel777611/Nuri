import { useEffect, useRef, useState as useLocalState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { apiErrorDetail, auth } from "@/src/api";
import { useT } from "@/src/i18n";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { getNativeGoogleConfiguration, getNativeGoogleSDK, NativeGoogleAuthError } from "@/src/googleNativeAuth";
import { signInWithNativeGoogle, type GoogleStorageFailure } from "@/src/googleSignInSession";
import { safeNotificationRoute } from "@/src/nativePushRuntime";
import { colors, spacing, type } from "@/src/theme";

export default function GoogleSignInButton({ disabled = false, returnTo, acquire, release, onBusyChange }: {
  disabled?: boolean;
  returnTo?: string;
  acquire?: () => boolean;
  release?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const router = useRouter();
  const { t, locale, setLocale } = useT();
  const { generation, capture, current, isMounted } = useAccountScope();
  const [available, setAvailable] = useLocalState(false);
  const [busy, setBusy] = useAccountState(false);
  const [error, setError] = useAccountState<string | null>(null);
  const [localFailure, setLocalFailure] = useLocalState<GoogleStorageFailure | null>(null);
  const active = useRef(false);
  const failure = localFailure?.identity === auth.getIdentityGeneration() && localFailure.generation === generation ? localFailure.kind : null;
  const localFailureCopy = {
    save: t("本机未能安全保存 Google 登录凭据。请重试 Google 或使用邮箱；本次登录尚未确认完成。"),
    read: t("本机未能读回安全保存的登录凭据。请重试 Google 或使用邮箱；登录尚未确认完成。"),
    onboarding: t("本机未能保存登录设置。请重试 Google 或使用邮箱；登录设置尚未完成。"),
  };

  useEffect(() => {
    let cancelled = false;
    void getNativeGoogleConfiguration().then((config) => { if (!cancelled) setAvailable(!!config); });
    return () => { cancelled = true; };
  }, [setAvailable]);

  const submit = async () => {
    const ticket = capture();
    if (ticket === null || disabled || !available || active.current) return;
    if (acquire && !acquire()) return;
    active.current = true;
    setBusy(true); setError(null); setLocalFailure(null); onBusyChange?.(true);
    try {
      const result = await signInWithNativeGoogle({ ticket, current, isMounted, language: locale, setLocale,
        retryLocalFailure: !!failure,
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
      setError(reason instanceof NativeGoogleAuthError && reason.code === "unavailable" || apiErrorDetail(reason) === "GOOGLE_SIGNIN_UNAVAILABLE"
        ? t("Google 登录暂时不可用，请用邮箱登录。") : t("Google 登录没有成功，请再试一次。"));
    } finally {
      active.current = false; release?.(); setBusy(false); onBusyChange?.(false);
    }
  };

  // This native lab intentionally does not load the web GIS script or DOM.
  if (Platform.OS !== "ios") return null;
  const NativeButton = available ? getNativeGoogleSDK().GoogleSigninButton : null;
  return <View style={styles.wrap} testID="google-signin">
    <View style={styles.dividerRow}><View style={styles.dividerLine} /><Text style={styles.dividerText}>{t("或")}</Text><View style={styles.dividerLine} /></View>
    {NativeButton ? <NativeButton style={styles.nativeButton} size={NativeButton.Size.Wide} color={NativeButton.Color.Light} disabled={disabled || busy} onPress={submit} testID="google-signin-native-button" accessibilityLabel={t("用 Google 继续")} />
      : <Text style={styles.note} testID="google-signin-unavailable">{t("Google 登录暂时不可用，请用邮箱登录。")}</Text>}
    {busy ? <ActivityIndicator style={styles.note} accessibilityLabel={t("正在登录…")} /> : null}
    {failure || error ? <Text style={styles.error} testID="google-signin-error" accessibilityLiveRegion="polite">{failure ? localFailureCopy[failure] : error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", marginTop: spacing.lg },
  dividerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md, alignSelf: "stretch" },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.muted, fontSize: type.sm },
  nativeButton: { width: "100%", maxWidth: 312, minHeight: 48 },
  note: { color: colors.muted, fontSize: type.sm, textAlign: "center", marginTop: spacing.sm },
  error: { color: colors.error, fontSize: type.sm, textAlign: "center", marginTop: spacing.sm },
});
