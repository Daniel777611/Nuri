import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { api, auth } from "@/src/api";
import { authErrorMessage, cleanCode, useCountdown } from "@/src/authFlow";
import { useT } from "@/src/i18n";
import { colors, radius, spacing, type } from "@/src/theme";

// Two steps on one screen: ask for the address, then take the mailed code and
// the new password together. The server answers "sent" whether or not the
// address has an account, so this screen never says which it was either.
export default function ForgotPassword() {
  const router = useRouter();
  const { t, locale } = useT();
  const [step, setStep] = useState<"email" | "reset">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const secondsLeft = useCountdown(resendAt);

  const normalizedEmail = email.trim().toLowerCase();
  const emailLooksValid = /\S+@\S+\.\S+/.test(normalizedEmail);

  const sendCode = async () => {
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const res = await api.forgotPassword({ email: normalizedEmail, language: locale });
      setResendAt(Date.now() + res.resend_after * 1000);
      setStep("reset");
      setNotice(t("如果这个邮箱注册过 NURI，验证码已经发过去了。"));
    } catch (e) {
      setError(authErrorMessage(e, t) || t("发送失败，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = async () => {
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const res = await api.resetPassword({
        email: normalizedEmail,
        code,
        new_password: password,
      });
      await auth.setToken(res.access_token);
      const onboarded = !!res.user?.onboarding_completed;
      await auth.setOnboarded(onboarded);
      router.replace(onboarded ? "/(tabs)" : "/onboarding");
    } catch (e) {
      setError(authErrorMessage(e, t) || t("重置失败，请重试"));
    } finally {
      setSubmitting(false);
    }
  };

  const canSend = emailLooksValid && !submitting;
  const canReset = code.length === 6 && password.length >= 6 && !submitting;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            onPress={() => router.replace("/login")}
            style={styles.back}
            testID="forgot-back"
          >
            <Ionicons name="arrow-back" size={18} color={colors.onSurface} />
            <Text style={styles.backText}>{t("返回登录")}</Text>
          </Pressable>

          <Text style={styles.h1}>{t("重置密码")}</Text>
          <Text style={styles.sub}>
            {step === "email"
              ? t("输入注册时用的邮箱，我们会发一个 6 位验证码。")
              : t("输入邮件里的验证码，并设置新密码。")}
          </Text>

          <Text style={styles.label}>{t("邮箱")}</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            editable={step === "email"}
            placeholder="you@example.com"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            style={[styles.input, step === "reset" && styles.inputLocked]}
            testID="forgot-email"
          />

          {step === "reset" ? (
            <>
              <Text style={[styles.label, { marginTop: spacing.lg }]}>{t("验证码")}</Text>
              <TextInput
                value={code}
                onChangeText={(value) => setCode(cleanCode(value))}
                placeholder="000000"
                placeholderTextColor={colors.muted}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                maxLength={6}
                style={[styles.input, styles.codeInput]}
                testID="forgot-code"
              />
              <Text style={[styles.label, { marginTop: spacing.lg }]}>{t("新密码（至少6位）")}</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="••••••"
                placeholderTextColor={colors.muted}
                secureTextEntry
                autoComplete="new-password"
                style={styles.input}
                testID="forgot-new-password"
              />
              <Pressable
                onPress={sendCode}
                disabled={secondsLeft > 0 || submitting}
                style={styles.resend}
                testID="forgot-resend"
              >
                <Text style={[styles.resendText, (secondsLeft > 0 || submitting) && { opacity: 0.5 }]}>
                  {secondsLeft > 0
                    ? t("{n} 秒后可重新发送", { n: secondsLeft })
                    : t("重新发送验证码")}
                </Text>
              </Pressable>
            </>
          ) : null}

          {notice ? <Text style={styles.notice} testID="forgot-notice">{notice}</Text> : null}
          {error ? (
            <View style={styles.errorBox} testID="forgot-error">
              <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {step === "email" ? (
            <Pressable
              onPress={sendCode}
              disabled={!canSend}
              style={[styles.cta, !canSend && { opacity: 0.5 }]}
              testID="forgot-send-btn"
            >
              <Text style={styles.ctaText}>{submitting ? t("发送中...") : t("发送验证码")}</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={reset}
              disabled={!canReset}
              style={[styles.cta, !canReset && { opacity: 0.5 }]}
              testID="forgot-reset-btn"
            >
              <Text style={styles.ctaText}>{submitting ? t("保存中...") : t("重置密码并登录")}</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  content: { flexGrow: 1, justifyContent: "center", padding: spacing.lg },
  back: { alignItems: "center", alignSelf: "flex-start", flexDirection: "row", gap: spacing.xs, marginBottom: spacing.xl, paddingVertical: spacing.xs },
  backText: { color: colors.onSurface, fontSize: type.base },
  h1: { fontSize: type.xxl, fontWeight: "700", color: colors.onSurface },
  sub: { fontSize: type.base, color: colors.muted, marginTop: spacing.sm, marginBottom: spacing.xl },
  label: { fontSize: type.base, color: colors.onSurfaceSecondary, marginBottom: spacing.sm, fontWeight: "600" },
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
  inputLocked: { backgroundColor: colors.surfaceTertiary, color: colors.muted },
  codeInput: { fontSize: type.xl, letterSpacing: 8, textAlign: "center" },
  resend: { alignSelf: "flex-start", marginTop: spacing.md, paddingVertical: spacing.xs },
  resendText: { color: colors.brand, fontSize: type.base },
  notice: { color: colors.onSurfaceSecondary, fontSize: type.sm, marginTop: spacing.lg },
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
  cta: {
    marginTop: spacing.xl,
    backgroundColor: colors.brand,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.md,
    alignItems: "center",
  },
  ctaText: { color: "#fff", fontSize: type.lg, fontWeight: "700" },
});
