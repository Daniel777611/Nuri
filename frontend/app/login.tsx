import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { api, auth } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.login({
        email: email.trim().toLowerCase(),
        password,
      });
      await auth.setToken(res.access_token);
      // Decide next destination based on whether user has a child
      const children = await api.listChildren();
      if (children && children.length > 0) router.replace("/(tabs)");
      else router.replace("/onboarding");
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg.includes("401")) setError("邮箱或密码错误");
      else setError("登录失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, padding: spacing.lg, justifyContent: "center" }}>
          <View style={styles.logo}>
            <Ionicons name="leaf-outline" size={28} color={colors.brand} />
          </View>
          <Text style={styles.h1}>欢迎回来</Text>
          <Text style={styles.sub}>
            登录继续你和 AI 育儿助手的对话。
          </Text>

          <Text style={styles.label}>邮箱</Text>
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

          <Text style={[styles.label, { marginTop: spacing.lg }]}>密码</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••"
            placeholderTextColor={colors.muted}
            secureTextEntry
            style={styles.input}
            testID="login-password"
          />

          {error ? (
            <View style={styles.errorBox} testID="login-error">
              <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
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
            <Text style={styles.ctaText}>{submitting ? "登录中..." : "登录"}</Text>
          </Pressable>

          <Pressable
            onPress={() => router.replace("/register")}
            style={styles.altBtn}
            testID="login-go-register"
          >
            <Text style={styles.altBtnText}>
              还没有账号？<Text style={{ color: colors.brand }}>立即注册</Text>
            </Text>
          </Pressable>
        </View>
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
