import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFonts } from "expo-font";
import { NotoSansSC_400Regular } from "@expo-google-fonts/noto-sans-sc/400Regular";
import { NotoSansSC_900Black } from "@expo-google-fonts/noto-sans-sc/900Black";

import { api, apiErrorDetail, auth } from "@/src/api";
import {
  authErrorMessage,
  cleanCode,
  clearPendingVerification,
  loadPendingVerification,
  savePendingVerification,
  useCountdown,
} from "@/src/authFlow";
import { useT } from "@/src/i18n";

const wordmark = require("@/assets/images/nuri-wordmark.png");

// Reached from register, and from login when the password was right but the
// address was never confirmed. Either way the server has already mailed a
// code; this screen trades it for the session.
export default function VerifyEmail() {
  const { t, locale } = useT();
  const router = useRouter();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const [fontsLoaded] = useFonts({ NotoSansSC_400Regular, NotoSansSC_900Black });
  const [email, setEmail] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const secondsLeft = useCountdown(resendAt);

  useEffect(() => {
    (async () => {
      const pending = await loadPendingVerification();
      if (!pending) {
        router.replace("/register");
        return;
      }
      setEmail(pending.email);
      setResendAt(pending.resendAt);
    })();
  }, [router]);

  const submit = async () => {
    if (!email) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const res = await api.verifyEmail({ email, code });
      await auth.setToken(res.access_token);
      const onboarded = !!res.user?.onboarding_completed;
      await auth.setOnboarded(onboarded);
      await clearPendingVerification();
      router.replace(onboarded ? "/(tabs)" : "/onboarding");
    } catch (e) {
      if (apiErrorDetail(e) === "EMAIL_ALREADY_VERIFIED") {
        await clearPendingVerification();
        router.replace("/login");
        return;
      }
      setError(authErrorMessage(e, t) || t("验证失败，请重试"));
      if (["CODE_LOCKED", "CODE_EXPIRED"].includes(apiErrorDetail(e))) setCode("");
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    if (!email || secondsLeft > 0) return;
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      const res = await api.resendVerification({ email, language: locale });
      await savePendingVerification(email, res.resend_after);
      setResendAt(Date.now() + res.resend_after * 1000);
      setCode("");
      setNotice(t("新的验证码已发送"));
    } catch (e: any) {
      if (e?.retryAfterMs) setResendAt(Date.now() + e.retryAfterMs);
      setError(authErrorMessage(e, t) || t("发送失败，请稍后重试"));
    } finally {
      setResending(false);
    }
  };

  const switchEmail = async () => {
    await clearPendingVerification();
    router.replace("/register");
  };

  if (!fontsLoaded || !email) {
    return <View style={styles.loading}><ActivityIndicator color="#3A2F5A" /></View>;
  }

  const canSubmit = code.length === 6 && !submitting;

  return (
    <LinearGradient
      colors={["#FFFFFF", "#FFF8FB", "#C0AEF5"]}
      locations={[0, 0.38, 1]}
      style={styles.gradient}
    >
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.safe}>
            <View style={styles.header}>
              <Pressable
                onPress={switchEmail}
                style={({ pressed }) => [styles.headerLink, pressed && styles.pressed]}
                testID="verify-use-another-email"
              >
                <Ionicons name="arrow-back" size={14} color="#3A2F5A" />
                <Text style={styles.headerLinkText}>{t("换一个邮箱")}</Text>
              </Pressable>
            </View>

            <ScrollView
              contentContainerStyle={styles.content}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Image source={wordmark} style={styles.wordmark} resizeMode="contain" />

              <View style={styles.form} testID="verify-email-step">
                <Text style={styles.title}>{t("验证邮箱")}</Text>
                <Text style={styles.description}>
                  {t("我们已向 {email} 发送了 6 位验证码，10 分钟内有效。", { email })}
                </Text>

                <TextInput
                  value={code}
                  onChangeText={(value) => setCode(cleanCode(value))}
                  placeholder="000000"
                  placeholderTextColor="rgba(58, 47, 90, 0.3)"
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  onSubmitEditing={() => canSubmit && submit()}
                  style={styles.codeInput}
                  testID="verify-code"
                />

                {error ? (
                  <View style={styles.errorBox} testID="verify-error">
                    <Ionicons name="alert-circle-outline" size={16} color="#C3454C" />
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}
                {notice ? <Text style={styles.notice} testID="verify-notice">{notice}</Text> : null}

                <Pressable
                  onPress={resend}
                  disabled={secondsLeft > 0 || resending}
                  style={({ pressed }) => [styles.resend, pressed && styles.pressed]}
                  testID="verify-resend"
                >
                  <Text style={[styles.resendText, (secondsLeft > 0 || resending) && styles.resendDisabled]}>
                    {resending
                      ? t("发送中...")
                      : secondsLeft > 0
                        ? t("{n} 秒后可重新发送", { n: secondsLeft })
                        : t("重新发送验证码")}
                  </Text>
                </Pressable>
                <Text style={styles.hint}>{t("没收到？请检查垃圾邮件文件夹。")}</Text>

                <View style={styles.ctaRow}>
                  <Pressable
                    onPress={submit}
                    disabled={!canSubmit}
                    style={({ pressed }) => [
                      styles.cta,
                      canSubmit && styles.ctaActive,
                      pressed && canSubmit && styles.pressed,
                    ]}
                    testID="verify-submit-btn"
                  >
                    <Text style={styles.ctaText}>{submitting ? t("验证中...") : t("验证")}</Text>
                    <Ionicons name="arrow-forward" size={16} color="#3A2F5A" />
                  </Pressable>
                </View>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", backgroundColor: "#FFFFFF", flex: 1, justifyContent: "center" },
  gradient: { flex: 1 },
  safe: { flex: 1 },
  phoneCanvas: { alignSelf: "center", flex: 1, overflow: "hidden" },
  header: { alignItems: "flex-start", height: 54, justifyContent: "center", paddingHorizontal: 16 },
  headerLink: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 36 },
  headerLinkText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 12, letterSpacing: 0.48 },
  content: { flexGrow: 1, paddingBottom: 28, paddingHorizontal: 16 },
  wordmark: { height: 46, width: 121 },
  form: { marginTop: 96 },
  title: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 24 },
  description: { color: "#3A2F5A", fontFamily: "NotoSansSC_400Regular", fontSize: 16, lineHeight: 22, marginTop: 4, maxWidth: 368 },
  codeInput: {
    backgroundColor: "rgba(255, 255, 255, 0.4)",
    borderColor: "rgba(58, 47, 90, 0.6)",
    borderRadius: 12,
    borderWidth: 1.5,
    color: "#3A2F5A",
    fontFamily: "NotoSansSC_900Black",
    fontSize: 28,
    height: 64,
    letterSpacing: 12,
    marginTop: 28,
    textAlign: "center",
  },
  errorBox: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.58)", borderColor: "rgba(195,69,76,0.45)", borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 8, marginTop: 18, padding: 12 },
  errorText: { color: "#8C313A", flex: 1, fontFamily: "NotoSansSC_400Regular", fontSize: 12 },
  notice: { color: "#3A2F5A", fontFamily: "NotoSansSC_400Regular", fontSize: 12, marginTop: 14 },
  resend: { alignSelf: "flex-start", marginTop: 18, minHeight: 32, justifyContent: "center" },
  resendText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 13, textDecorationLine: "underline" },
  resendDisabled: { opacity: 0.5, textDecorationLine: "none" },
  hint: { color: "rgba(58, 47, 90, 0.75)", fontFamily: "NotoSansSC_400Regular", fontSize: 12, marginTop: 4 },
  ctaRow: { alignItems: "flex-end", marginTop: 48 },
  cta: { alignItems: "center", backgroundColor: "rgba(255, 255, 255, 0.6)", borderColor: "rgba(60, 34, 45, 0.3)", borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 8, height: 48, justifyContent: "center", width: 148 },
  ctaActive: { backgroundColor: "rgba(255, 255, 255, 0.86)", borderColor: "rgba(58, 47, 90, 0.48)" },
  ctaText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 14 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
