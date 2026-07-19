import { useState } from "react";
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

import { api, auth } from "@/src/api";
import { isPreviewMode } from "@/src/preview-api";

const wordmark = require("@/assets/images/nuri-wordmark.png");

export default function Register() {
  const router = useRouter();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const [email, setEmail] = useState(isPreviewMode ? "preview@nuri.app" : "");
  const [password, setPassword] = useState(isPreviewMode ? "preview" : "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [fontsLoaded] = useFonts({ NotoSansSC_400Regular, NotoSansSC_900Black });

  const canNext = /\S+@\S+\.\S+/.test(email) && password.length >= 6;

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.register({
        email: email.trim().toLowerCase(),
        password,
      });
      await auth.setToken(res.access_token);
      router.replace("/onboarding");
    } catch (e: any) {
      const msg = String(e?.message || "");
      setError(msg.includes("已注册") ? "该邮箱已注册，请直接登录" : "注册失败，请检查信息后重试");
    } finally {
      setSubmitting(false);
    }
  };

  if (!fontsLoaded) {
    return <View style={styles.loading}><ActivityIndicator color="#3A2F5A" /></View>;
  }

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
              onPress={() => router.push("/login")}
              style={({ pressed }) => [styles.loginLink, pressed && styles.pressed]}
              testID="register-go-login"
            >
              <Text style={styles.loginText}>已有账号，登陆</Text>
              <Ionicons name="arrow-forward" size={14} color="#3A2F5A" />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Image source={wordmark} style={styles.wordmark} resizeMode="contain" />
            <Text style={styles.welcome}>欢迎来到NURI: <Text style={styles.village}>Village</Text>大家庭</Text>
            <Text style={styles.tagline}>让我们一起探索孩子的未来。</Text>

            <View style={styles.form} testID="register-step-account">
              <Text style={styles.title}>创建账号</Text>
              <Text style={styles.description}>邮箱+密码，保护你的家人和隐私数据。注册后还需要一分钟完善基本信息。</Text>

              <Field label="邮箱">
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor="rgba(58, 47, 90, 0.6)"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  style={styles.input}
                  testID="register-email"
                />
              </Field>
              <Field label="密码（至少6位）">
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="******"
                  placeholderTextColor="rgba(58, 47, 90, 0.6)"
                  secureTextEntry
                  autoComplete="new-password"
                  style={styles.input}
                  testID="register-password"
                />
              </Field>

              {error ? (
                <View style={styles.errorBox} testID="register-error">
                  <Ionicons name="alert-circle-outline" size={16} color="#C3454C" />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              <View style={styles.ctaRow}>
                <Pressable
                  onPress={submit}
                  disabled={!canNext || submitting}
                  style={({ pressed }) => [
                    styles.cta,
                    canNext && !submitting && styles.ctaActive,
                    pressed && canNext && styles.pressed,
                  ]}
                  testID="register-next-btn"
                >
                  <Text style={styles.ctaText}>{submitting ? "创建中..." : "下一步"}</Text>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
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
