import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import { useState as useLocalState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { useHeaderHeight } from "@react-navigation/elements";
import { Ionicons } from "@expo/vector-icons";

import { api, apiErrorDetail, auth, isAuthError } from "@/src/api";
import { savePendingVerification } from "@/src/authFlow";
import { useT } from "@/src/i18n";
import { safeNotificationRoute } from "@/src/nativePushRuntime";
import { colors, radius, spacing, type } from "@/src/theme";

export default function Login() {
  const { generation, capture, current, isMounted } = useAccountScope();
  const router = useRouter();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string | string[] }>();
  const notificationReturn = safeNotificationRoute(returnTo);
  const safeReturnTo = notificationReturn && /^\/notifications\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notificationReturn) ? notificationReturn : null;
  const headerHeight = useHeaderHeight();
  const { t, locale, setLocale } = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Keychain replacement invalidates the form's old epoch even when its write
  // fails. Keep only this non-sensitive error outside account state, and bind
  // it to the exact identity/phase so a new session never inherits it.
  const [localFailure, setLocalFailure] = useLocalState<{ identity: number; generation: number; kind: "save" | "read" | "onboarding" } | null>(null);
  const failureKind = localFailure?.identity === auth.getIdentityGeneration() && localFailure.generation === generation ? localFailure.kind : null;
  const localFailureCopy = locale === "en" ? {
    save: "Your sign-in credentials could not be saved securely on this device. Re-enter your email and password, then retry. This sign-in has not been confirmed.",
    read: "This device could not read back your securely saved sign-in credentials. Re-enter your email and password, then retry. Sign-in has not been confirmed.",
    onboarding: "This device could not save your sign-in setup state. Re-enter your email and password, then retry. Sign-in setup has not been completed.",
  } : locale === "zh-TW" ? {
    save: "本機未能安全保存登入憑據。請重新填寫電子郵件和密碼後重試；本次登入尚未確認完成。",
    read: "本機未能讀回安全保存的登入憑據。請重新填寫電子郵件和密碼後重試；登入尚未確認完成。",
    onboarding: "本機未能保存登入設定狀態。請重新填寫電子郵件和密碼後重試；登入設定尚未完成。",
  } : {
    save: "本机未能安全保存登录凭据。请重新填写邮箱和密码后重试；本次登录尚未确认完成。",
    read: "本机未能读回安全保存的登录凭据。请重新填写邮箱和密码后重试；登录尚未确认完成。",
    onboarding: "本机未能保存登录设置状态。请重新填写邮箱和密码后重试；登录设置尚未完成。",
  };
  const visibleError = failureKind ? localFailureCopy[failureKind] : error;

  const submit = async () => {
    const ticket = capture();
    if (ticket === null || submitting) return;
    let ownerIdentity: number | null = null;
    let ownerGeneration: number | null = null;
    const ownsStoragePhase = () => isMounted() && ownerIdentity === auth.getIdentityGeneration()
      && ownerGeneration === auth.getSessionGeneration();
    const showLocalFailure = (kind: "save" | "read" | "onboarding") => {
      if (!ownsStoragePhase()) return;
      setLocalFailure((previous) => ownsStoragePhase()
        ? { identity: ownerIdentity!, generation: ownerGeneration!, kind } : previous);
    };
    const ownsLogin = async (token: string) => {
      if (!ownsStoragePhase()) return false;
      const live = await auth.getToken();
      if (!ownsStoragePhase()) return false;
      if (live !== token) { showLocalFailure("read"); return false; }
      return true;
    };
    setLocalFailure(null);
    setError(null);
    setSubmitting(true);
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const res = await api.login({
        email: normalizedEmail,
        password,
        language: locale,
      });
      if (!current(ticket)) return;
      ownerIdentity = auth.getIdentityGeneration() + 1;
      const saved = await auth.setToken(res.access_token, { expectedGeneration: ticket });
      // A failed secure write advances the boundary at replacement start/end,
      // but a CAS mismatch does not. A successful intervening B login advances
      // it again at publish; neither mismatch may display A's storage error.
      ownerGeneration = saved ? auth.getSessionGeneration() : ticket + 2;
      if (!saved) { showLocalFailure("save"); return; }
      if (!await ownsLogin(res.access_token)) return;
      // Old users must also complete the basic-info flow before entering tabs
      if (res.user?.language) await setLocale(res.user.language);
      if (!await ownsLogin(res.access_token)) return;
      const onboarded = !!res.user?.onboarding_completed;
      const stored = await auth.setOnboarded(onboarded, { expectedToken: res.access_token, expectedGeneration: ownerGeneration });
      if (!stored) { if (await ownsLogin(res.access_token)) showLocalFailure("onboarding"); return; }
      if (!await ownsLogin(res.access_token)) return;
      router.replace(onboarded ? (safeReturnTo ?? "/(tabs)") as never : "/onboarding");
    } catch (e: any) {
      if (!current(ticket)) return;
      // Right password, address never confirmed: the server has just mailed
      // a fresh code, so go straight to the screen that takes it.
      if (apiErrorDetail(e) === "EMAIL_NOT_VERIFIED") {
        await savePendingVerification(normalizedEmail, 60);
        if (!current(ticket)) return;
        router.push("/verify-email");
        return;
      }
      const msg = String(e?.message || "");
      if (isAuthError(e) || msg.includes("401")) setError(t("邮箱或密码错误"));
      else setError(t("登录失败，请重试"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={headerHeight}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, padding: spacing.lg, justifyContent: "center" }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.logo}>
            <Ionicons name="leaf-outline" size={28} color={colors.brand} />
          </View>
          <Text style={styles.h1}>{t("欢迎回来")}</Text>
          <Text style={styles.sub}>
            {t("登录继续你和 AI 育儿助手的对话。")}
          </Text>

          <Text style={styles.label}>{t("邮箱")}</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            keyboardType="email-address"
            style={styles.input}
            testID="login-email"
          />

          <Text style={[styles.label, { marginTop: spacing.lg }]}>{t("密码")}</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••"
            placeholderTextColor={colors.muted}
            secureTextEntry
            style={styles.input}
            testID="login-password"
          />
          <Pressable
            onPress={() => router.push("/forgot-password")}
            style={styles.forgot}
            testID="login-forgot-password"
          >
            <Text style={styles.forgotText}>{t("忘记密码？")}</Text>
          </Pressable>

          {visibleError ? (
            <View style={styles.errorBox} testID="login-error" accessibilityLiveRegion="polite">
              <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
              <Text style={styles.errorText}>{visibleError}</Text>
            </View>
          ) : null}

          <Pressable
            onPress={submit}
            disabled={!email || !password || submitting}
            style={[
              styles.cta,
              (!email || !password || submitting) && { opacity: 0.5 },
            ]}
            testID="login-submit-btn"
          >
            <Text style={styles.ctaText}>{submitting ? t("登录中...") : t("登录")}</Text>
          </Pressable>

          <Pressable
            onPress={() => router.replace("/register")}
            style={styles.altBtn}
            testID="login-go-register"
          >
            <Text style={styles.altBtnText}>
              {t("还没有账号？")}<Text style={{ color: colors.brand }}>{t("立即注册")}</Text>
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  logo: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  h1: { fontSize: type.xxl, fontWeight: "700", color: colors.onSurface },
  sub: {
    fontSize: type.base,
    color: colors.muted,
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  label: {
    fontSize: type.base,
    color: colors.onSurfaceSecondary,
    marginBottom: spacing.sm,
    fontWeight: "600",
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: type.lg,
    color: colors.onSurface,
  },
  errorBox: {
    marginTop: spacing.lg,
    backgroundColor: "#FEF2F2",
    borderColor: "#FCA5A5",
    borderWidth: 1,
    padding: spacing.md,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
  errorText: { color: colors.error, flex: 1 },
  forgot: { alignSelf: "flex-end", marginTop: spacing.sm, paddingVertical: spacing.xs },
  forgotText: { color: colors.brand, fontSize: type.base },
  cta: {
    marginTop: spacing.xl,
    backgroundColor: colors.brand,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.md,
    alignItems: "center",
  },
  ctaText: { color: "#fff", fontSize: type.lg, fontWeight: "700" },
  altBtn: { marginTop: spacing.lg, alignItems: "center", paddingVertical: spacing.sm },
  altBtnText: { color: colors.muted, fontSize: type.base },
});
