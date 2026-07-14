import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { api, auth } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

export default function Register() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canNext = () => /\S+@\S+\.\S+/.test(email) && password.length >= 6;

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
      if (msg.includes("已注册")) setError("该邮箱已注册，请直接登录");
      else setError("注册失败，请检查信息后重试");
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
        <View style={styles.header}>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => router.push("/login")} testID="register-go-login">
            <Text style={styles.linkText}>已有账号 登录 →</Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View testID="register-step-account">
            <Text style={styles.h1}>创建账号</Text>
            <Text style={styles.sub}>
              邮箱+密码，保护你和家人的隐私数据。注册后还需 1 分钟完善基本信息。
            </Text>
              <Field label="邮箱">
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  style={styles.input}
                  testID="register-email"
                />
              </Field>
              <Field label="密码（至少 6 位）">
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••"
                  placeholderTextColor={colors.muted}
                  secureTextEntry
                  style={styles.input}
                  testID="register-password"
                />
              </Field>
          </View>

          {error ? (
            <View style={styles.errorBox} testID="register-error">
              <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          <View />
          <Pressable
            onPress={submit}
            disabled={!canNext() || submitting}
            style={[styles.cta, (!canNext() || submitting) && { opacity: 0.5 }]}
            testID="register-next-btn"
          >
            <Text style={styles.ctaText}>
              {submitting ? "创建中..." : "创建账号"}
            </Text>
            <Ionicons name="arrow-forward" color="#fff" size={18} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  linkText: { color: colors.brand, fontSize: type.sm, fontWeight: "600" },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl, flexGrow: 1 },
  h1: { fontSize: type.xxl, fontWeight: "700", color: colors.onSurface },
  sub: {
    fontSize: type.base,
    color: colors.muted,
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
    lineHeight: 20,
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
  errorText: { color: colors.error, fontSize: type.base, flex: 1 },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopColor: colors.divider,
    borderTopWidth: 1,
    backgroundColor: "#fff",
  },
  cta: {
    flexDirection: "row",
    backgroundColor: colors.brand,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    alignItems: "center",
    gap: spacing.sm,
  },
  ctaText: { color: "#fff", fontSize: type.lg, fontWeight: "700" },
});
