import { AuthFrame, NuriField, NuriText, NuriButton } from "@/src/uiux48/Primitives";
import { useEffect } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
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
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { useHeaderHeight } from "@react-navigation/elements";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFonts } from "expo-font";
import { TEXT_FONTS } from "@/src/textFonts";

import { api, apiErrorDetail, auth } from "@/src/api";
import {
  authErrorMessage,
  cleanCode,
  clearPendingVerification,
  loadPendingVerification,
  savePendingVerification,
  useCountdown,
} from "@/src/authFlow";
import { useT, translate } from "@/src/i18n";

const wordmark = require("@/assets/images/nuri-wordmark.png");

// Reached from register, and from login when the password was right but the
// address was never confirmed. Either way the server has already mailed a
// code; this screen trades it for the session.
export default function VerifyEmail() {
  const { capture, current, isMounted } = useAccountScope();
  const { t, locale } = useT();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const [fontsLoaded] = useFonts(TEXT_FONTS);
  const [email, setEmail] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const secondsLeft = useCountdown(resendAt);

  useEffect(() => {
    const ticket = capture();
    (async () => {
      const pending = await loadPendingVerification();
      if (!current(ticket)) return;
      if (!pending) {
        router.replace("/register");
        return;
      }
      setEmail(pending.email);
      setResendAt(pending.resendAt);
    })();
  }, [router, capture, current, setEmail, setResendAt]);

  const submit = async () => {
    const ticket = capture();
    if (ticket === null || submitting) return;
    let ownerIdentity: number | null = null;
    const ownsLogin = async (token: string) => {
      const live = await auth.getToken();
      return isMounted() && ownerIdentity === auth.getIdentityGeneration() && live === token;
    };
    if (!email) return;
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const res = await api.verifyEmail({ email, code });
      if (!current(ticket)) return;
      ownerIdentity = auth.getIdentityGeneration() + 1;
      const saved = await auth.setToken(res.access_token, { expectedGeneration: ticket });
      if (!saved || !await ownsLogin(res.access_token)) return;
      const onboarded = !!res.user?.onboarding_completed;
      const stored = await auth.setOnboarded(onboarded, { expectedToken: res.access_token, expectedGeneration: auth.getSessionGeneration() });
      if (!stored || !await ownsLogin(res.access_token)) return;
      await clearPendingVerification();
      if (!await ownsLogin(res.access_token)) return;
      router.replace(onboarded ? "/(tabs)" : "/onboarding");
    } catch (e) {
      if (!current(ticket)) return;
      if (apiErrorDetail(e) === "EMAIL_ALREADY_VERIFIED") {
        await clearPendingVerification();
        if (!current(ticket)) return;
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
    const ticket = capture();
    if (ticket === null) return;
    if (!email || secondsLeft > 0) return;
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      const res = await api.resendVerification({ email, language: locale });
      if (!current(ticket)) return;
      await savePendingVerification(email, res.resend_after);
      if (!current(ticket)) return;
      setResendAt(Date.now() + res.resend_after * 1000);
      setCode("");
      setNotice(t("新的验证码已发送"));
    } catch (e: any) {
      if (!current(ticket)) return;
      if (e?.retryAfterMs) setResendAt(Date.now() + e.retryAfterMs);
      setError(authErrorMessage(e, t) || t("发送失败，请稍后重试"));
    } finally {
      setResending(false);
    }
  };

  const switchEmail = async () => {
    const ticket = capture();
    if (ticket === null) return;
    await clearPendingVerification();
    if (!current(ticket)) return;
    router.replace("/register");
  };

  if (!fontsLoaded || !email) {
    return <View style={styles.loading}><ActivityIndicator color="#3A2F5A" /></View>;
  }

  const canSubmit = code.length === 6 && !submitting;

  return <AuthFrame testID="verify-email-step">
    <NuriText>{t("我们已向 {email} 发送了 6 位验证码，10 分钟内有效。",{email})}</NuriText>
    <NuriField label={t("验证码")} value={code} onChangeText={value=>setCode(cleanCode(value))} placeholder={locale==="en"?"6-digit code":translate(locale, "6 位验证码")} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} onSubmitEditing={()=>canSubmit&&submit()} testID="verify-code" />
    <Pressable onPress={resend} disabled={secondsLeft>0||resending} style={{minHeight:44,justifyContent:"center"}} testID="verify-resend"><NuriText style={{fontSize:16,opacity:secondsLeft>0?.5:1}}>{resending?t("发送中..."):secondsLeft>0?t("{n} 秒后可重新发送",{n:secondsLeft}):t("重新发送验证码")}</NuriText></Pressable>
    {error?<NuriText style={{color:"#9a606a",fontSize:13}} testID="verify-error">{error}</NuriText>:null}
    {notice?<NuriText secondary style={{fontSize:13}} testID="verify-notice">{notice}</NuriText>:null}
    <NuriButton label={submitting?t("验证中..."):(locale==="en"?"Verify and continue":translate(locale, "验证并继续"))} busy={submitting} disabled={!canSubmit} onPress={submit} testID="verify-submit-btn" />
    <Pressable onPress={switchEmail} style={{minHeight:44,justifyContent:"center"}} testID="verify-use-another-email"><NuriText secondary style={{fontSize:13}}>{t("换一个邮箱")}</NuriText></Pressable>
  </AuthFrame>;
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
