import { AuthFrame, NuriField, NuriText, NuriButton } from "@/src/uiux48/Primitives";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
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
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { useHeaderHeight } from "@react-navigation/elements";
import { Ionicons } from "@expo/vector-icons";

import { api } from "@/src/api";
import { authErrorMessage, cleanCode, useCountdown } from "@/src/authFlow";
import { useT, translate } from "@/src/i18n";
import { colors, radius, spacing, type } from "@/src/theme";

// Two steps on one screen: ask for the address, then take the mailed code and
// the new password together. The server answers "sent" whether or not the
// address has an account, so this screen never says which it was either.
export default function ForgotPassword() {
  const { capture, current } = useAccountScope();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const { t, locale } = useT();
  const [step, setStep] = useState<"email" | "reset" | "done">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const secondsLeft = useCountdown(resendAt);

  const normalizedEmail = email.trim().toLowerCase();
  const emailLooksValid = /\S+@\S+\.\S+/.test(normalizedEmail);

  const sendCode = async () => {
    const ticket = capture();
    if (ticket === null || submitting) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const res = await api.forgotPassword({ email: normalizedEmail, language: locale });
      if (!current(ticket)) return;
      setResendAt(Date.now() + res.resend_after * 1000);
      setStep("reset");
      setNotice(t("如果这个邮箱注册过 NURI，验证码已经发过去了。"));
    } catch (e) {
      if (!current(ticket)) return;
      setError(authErrorMessage(e, t) || t("发送失败，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = async () => {
    const ticket = capture();
    if (ticket === null || submitting) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      await api.resetPassword({
        email: normalizedEmail,
        code,
        new_password: password,
      });
      if (!current(ticket)) return;
      // Figma48 ends at an explicit success card, then returns to login. A
      // successful reset response must not silently install a new session.
      setCode(""); setPassword(""); setConfirmPassword("");
      setStep("done");
      router.setParams({ uiState: "resetDone" });
    } catch (e) {
      if (!current(ticket)) return;
      setError(authErrorMessage(e, t) || t("重置失败，请重试"));
    } finally {
      setSubmitting(false);
    }
  };

  const canSend = emailLooksValid && !submitting;
  const canReset = code.length === 6 && password.length >= 6 && password === confirmPassword && !submitting;

  if (step === "done") return <AuthFrame testID="reset-done-card" contentGap={24}>
    <NuriText style={{fontSize:16,lineHeight:22}}>{locale==="en"?"You can now log in with your new password.":translate(locale, "现在可以使用新密码登录。")}</NuriText>
    <NuriButton label={locale==="en"?"Back to login":translate(locale, "返回登录")} onPress={()=>router.replace("/login")} testID="reset-done-login" />
  </AuthFrame>;

  return <AuthFrame testID="forgot-card">
    <NuriText>{step==="email"?t("输入注册时用的邮箱，我们会发一个 6 位验证码。"):t("输入邮件里的验证码，并设置新密码。")}</NuriText>
    {step==="email"?<NuriField label={t("邮箱")} value={email} onChangeText={setEmail} placeholder="parent@example.com" autoCapitalize="none" keyboardType="email-address" autoComplete="email" testID="forgot-email" />:<>
      <NuriField label={t("验证码")} value={code} onChangeText={value=>setCode(cleanCode(value))} placeholder={locale==="en"?"Code from your email":translate(locale, "输入邮箱中的验证码")} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} testID="forgot-code" />
      <NuriField label={t("新密码（至少6位）")} value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" testID="forgot-new-password" />
      <NuriField label={locale==="en"?"Confirm new password":translate(locale, "再次输入")} value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoComplete="new-password" testID="forgot-confirm-password" />
      {confirmPassword&&confirmPassword!==password?<NuriText style={{color:"#9a606a",fontSize:13}}>{locale==="en"?"Passwords do not match.":translate(locale, "两次输入的密码不一致。")}</NuriText>:null}
      <Pressable onPress={sendCode} disabled={secondsLeft>0||submitting} style={{minHeight:44,justifyContent:"center"}} testID="forgot-resend"><NuriText secondary style={{fontSize:13}}>{secondsLeft>0?t("{n} 秒后可重新发送",{n:secondsLeft}):t("重新发送验证码")}</NuriText></Pressable>
    </>}
    {notice?<NuriText secondary style={{fontSize:13}} testID="forgot-notice">{notice}</NuriText>:null}
    {error?<NuriText style={{color:"#9a606a",fontSize:13}} testID="forgot-error">{error}</NuriText>:null}
    <NuriButton label={submitting?t("保存中..."):step==="email"?t("发送验证码"):(locale==="en"?"Save new password":translate(locale, "保存新密码"))} busy={submitting} disabled={step==="email"?!canSend:!canReset} onPress={step==="email"?sendCode:reset} testID={step==="email"?"forgot-send-btn":"forgot-reset-btn"} />
  </AuthFrame>;
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
