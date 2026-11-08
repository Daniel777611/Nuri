import { AuthFrame, FormTabs, NuriField, NuriText, NuriButton } from "@/src/uiux48/Primitives";
import { useEffect, useRef } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import { useNativeAuthDraft } from "@/src/uiux48/useNativeAuthDraft";
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

import { api, auth, isAuthError } from "@/src/api";
import { ExpiredSessionRecoveryNotice, useExpiredSessionRecovery } from "@/src/authExpiredRecovery";
import { authErrorMessage, savePendingVerification } from "@/src/authFlow";
import { isPreviewMode } from "@/src/preview-api";
import { useT, translate } from "@/src/i18n";
import GoogleSignInButton from "@/src/components/GoogleSignInButton";

const wordmark = require("@/assets/images/nuri-wordmark.png");
const registrationReady = ({ email, password }: { email: string; password: string }) => /\S+@\S+\.\S+/.test(email) && password.length >= 6;

export default function Register() {
  const { capture, current } = useAccountScope();
  const { t, locale } = useT();
  const router = useRouter();
  const recovery = useExpiredSessionRecovery();
  const recoverExpiredCredentials = recovery.recover;
  const headerHeight = useHeaderHeight();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const draft = useNativeAuthDraft({ email: isPreviewMode ? "preview@nuri.app" : "", nickname: "", password: isPreviewMode ? "preview" : "" }, registrationReady);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const registerAction = useRef(false);
  const acquireRegistration = () => { if (registerAction.current) return false; registerAction.current = true; return true; };
  const releaseRegistration = () => { registerAction.current = false; };
  const [checkingSession, setCheckingSession] = useState(!isPreviewMode);
  const [fontsLoaded] = useFonts(TEXT_FONTS);

  // Someone who is already signed in must never reach this form. Submitting it
  // with a second email replaces the stored token, so the app silently lands on
  // a brand-new empty account while the real one — children included — stays in
  // the database under the old id. That is what "孩子没了" actually was.
  // Preview mode is exempt: it has no real session and exists to review screens.
  useEffect(() => {
    const ticket = capture();
    if (ticket === null) return;
    if (isPreviewMode) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await auth.getToken();
        if (!current(ticket)) return;
        if (!token) return;

        try {
          const me: any = await api.me();
          if (cancelled || await auth.getToken() !== token || !current(ticket)) return;
          if (!await auth.setOnboarded(!!me?.onboarding_completed, { expectedToken: token, expectedGeneration: ticket })) return;
          if (cancelled || await auth.getToken() !== token || !current(ticket)) return;
          router.replace(me?.onboarding_completed ? "/(tabs)" : "/onboarding");
          return;
        } catch (err) {
          if (cancelled || !current(ticket)) return;
          // Only a rejected token means the session is really gone; then the
          // form is legitimate. A timeout or a 5xx says nothing about the
          // credentials, so route on the last known state rather than handing
          // back a form that can strand the account.
          if (isAuthError(err)) {
            await recoverExpiredCredentials(err, token);
            return;
          }
          const onboarded = await auth.getOnboarded();
          if (cancelled || await auth.getToken() !== token || !current(ticket)) return;
          router.replace(onboarded ? "/(tabs)" : "/onboarding");
          return;
        }
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, [router, recoverExpiredCredentials, capture, current, setCheckingSession]);

  const submit = async () => {
    const ticket = capture();
    const values = draft.read();
    if (ticket === null || values === null || submitting || !acquireRegistration()) return;
    const { email, nickname, password } = values;
    setError(null);
    setSubmitting(true);
    try {
      // No token comes back: the server mails a code, and the next screen
      // trades it for the session.
      const res = await api.register({
        nickname: nickname.trim(),
        email: email.trim().toLowerCase(),
        password,
        language: locale,
      });
      if (!current(ticket)) return;
      await savePendingVerification(res.email, res.resend_after);
      if (!current(ticket)) return;
      router.replace("/verify-email");
    } catch (e: any) {
      if (!current(ticket)) return;
      const msg = String(e?.message || "");
      setError(
        msg.includes("已注册")
          ? t("该邮箱已注册，请直接登录")
          : authErrorMessage(e, t) || t("注册失败，请检查信息后重试"),
      );
    } finally {
      releaseRegistration();
      setSubmitting(false);
    }
  };

  if (recovery.blocked) return <ExpiredSessionRecoveryNotice pending={recovery.pending} onRetry={recoverExpiredCredentials} />;
  if (!fontsLoaded || checkingSession) {
    return <View style={styles.loading}><ActivityIndicator color="#3A2F5A" /></View>;
  }

  return <AuthFrame testID="register-step-account">
    <FormTabs active="register" />
    <NuriText style={{fontSize:14}}>{locale === "en" ? "Start with a lighter conversation." : translate(locale, "从一次轻松的对话开始。")}</NuriText>
    <View key={draft.generation} style={{gap:16}}>
      <NuriField label={locale === "en" ? "Your name" : translate(locale, "称呼")} defaultValue={draft.initial.nickname} onChangeText={text => draft.change("nickname", text)} placeholder={locale === "en"?"What should Nuri call you?":translate(locale, "希望 Nuri 怎么称呼你？")} testID="register-nickname" />
      <NuriField label={t("邮箱")} defaultValue={draft.initial.email} onChangeText={text => draft.change("email", text)} placeholder="parent@example.com" autoCapitalize="none" keyboardType="email-address" autoComplete="email" testID="register-email" />
      <NuriField label={t("密码")} defaultValue={draft.initial.password} onChangeText={text => draft.change("password", text)} placeholder={locale==="en"?"At least 6 characters":translate(locale, "至少 6 位")} secureTextEntry autoComplete="new-password" testID="register-password" />
    </View>
    <NuriText secondary style={{fontSize:12,lineHeight:18}}>{locale==="en"?"You can review the privacy policy before continuing. Your AI choice is separate from account registration and can be changed in Privacy & AI.":locale==="zh-TW"?"繼續前可查看隱私說明。AI 選擇與帳號註冊分開，可隨時在「隱私與 AI」更改。":"继续前可查看隐私说明。AI 选择与账号注册分开，可随时在“隐私与 AI”更改。"}</NuriText>
    {error?<NuriText style={{color:"#9a606a",fontSize:13}} testID="register-error">{error}</NuriText>:null}
    <NuriButton label={submitting?t("创建中..."):t("创建账号")} busy={submitting} disabled={!draft.ready||submitting} onPress={submit} testID="register-next-btn" />
    <GoogleSignInButton disabled={submitting} acquire={acquireRegistration} release={releaseRegistration} onBusyChange={setSubmitting} />
  </AuthFrame>;
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", backgroundColor: "#FFFFFF", flex: 1, justifyContent: "center" },
  gradient: { flex: 1 },
  safe: { flex: 1 },
  phoneCanvas: { alignSelf: "center", flex: 1, overflow: "hidden" },
  header: { alignItems: "flex-end", height: 54, justifyContent: "center", paddingHorizontal: 16 },
  loginLink: { alignItems: "center", flexDirection: "row", gap: 8, minHeight: 36 },
  loginText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 12, letterSpacing: 0.48 },
  content: { flexGrow: 1, paddingBottom: 28, paddingHorizontal: 16 },
  wordmark: { height: 46, marginTop: 0, width: 121 },
  welcome: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 24, marginTop: 9 },
  village: { color: "#FB8C50" },
  tagline: { color: "#3A2F5A", fontFamily: "NotoSansSC_400Regular", fontSize: 16, marginTop: 4 },
  form: { marginTop: 141 },
  title: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 24 },
  description: { color: "#3A2F5A", fontFamily: "NotoSansSC_400Regular", fontSize: 16, lineHeight: 21, marginTop: 4, maxWidth: 368 },
  field: { marginTop: 20 },
  label: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 16, marginBottom: 8 },
  input: {
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    borderColor: "rgba(58, 47, 90, 0.6)",
    borderRadius: 12,
    borderWidth: 1.5,
    color: "#3A2F5A",
    fontFamily: "NotoSansSC_900Black",
    fontSize: 12,
    height: 48,
    paddingHorizontal: 16,
  },
  errorBox: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.58)", borderColor: "rgba(195,69,76,0.45)", borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 8, marginTop: 18, padding: 12 },
  errorText: { color: "#8C313A", flex: 1, fontFamily: "NotoSansSC_400Regular", fontSize: 12 },
  ctaRow: { alignItems: "flex-end", marginTop: 62 },
  cta: { alignItems: "center", backgroundColor: "rgba(255, 255, 255, 0.6)", borderColor: "rgba(60, 34, 45, 0.3)", borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 8, height: 48, justifyContent: "center", width: 148 },
  ctaActive: { backgroundColor: "rgba(255, 255, 255, 0.86)", borderColor: "rgba(58, 47, 90, 0.48)" },
  ctaText: { color: "#3A2F5A", fontFamily: "NotoSansSC_900Black", fontSize: 14 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
