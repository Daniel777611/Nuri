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

type Role = "mom" | "dad" | "grandparent" | "other";
type Concern = "sleep" | "food" | "emotion" | "health" | "education";

const ROLES: { key: Role; label: string }[] = [
  { key: "mom", label: "妈妈" },
  { key: "dad", label: "爸爸" },
  { key: "grandparent", label: "祖辈" },
  { key: "other", label: "其他" },
];

const CONCERNS: { key: Concern; label: string }[] = [
  { key: "sleep", label: "睡眠" },
  { key: "food", label: "吃饭" },
  { key: "emotion", label: "情绪" },
  { key: "health", label: "健康" },
  { key: "education", label: "教育" },
];

export default function Register() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [city, setCity] = useState("");
  const [role, setRole] = useState<Role>("mom");
  const [concerns, setConcerns] = useState<Concern[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggleConcern = (k: Concern) =>
    setConcerns((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const canNext = () => {
    if (step === 0) return /\S+@\S+\.\S+/.test(email) && password.length >= 6;
    if (step === 1) return nickname.trim().length >= 1;
    if (step === 2) return city.trim().length >= 1;
    return true;
  };

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.register({
        email: email.trim().toLowerCase(),
        password,
        nickname: nickname.trim(),
        city: city.trim(),
        parent_role: role,
        top_concerns: concerns,
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

  const next = () => {
    if (step < 3) setStep(step + 1);
    else submit();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={styles.header}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${((step + 1) / 4) * 100}%` }]} />
          </View>
          <Pressable onPress={() => router.push("/login")} testID="register-go-login">
            <Text style={styles.linkText}>已有账号 登录 →</Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {step === 0 && (
            <View testID="register-step-account">
              <Text style={styles.h1}>创建账号</Text>
              <Text style={styles.sub}>邮箱+密码，保护你和家人的隐私数据。</Text>
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
          )}

          {step === 1 && (
            <View testID="register-step-name">
              <Text style={styles.h1}>怎么称呼你？</Text>
              <Text style={styles.sub}>AI 会用这个名字和你打招呼。</Text>
              <Field label="家长昵称">
                <TextInput
                  value={nickname}
                  onChangeText={setNickname}
                  placeholder="例如：小满妈"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                  testID="register-nickname"
                />
              </Field>
              <Field label="你的身份">
                <View style={styles.chips}>
                  {ROLES.map((r) => (
                    <Pressable
                      key={r.key}
                      onPress={() => setRole(r.key)}
                      style={[styles.chip, role === r.key && styles.chipActive]}
                      testID={`register-role-${r.key}`}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          role === r.key && styles.chipTextActive,
                        ]}
                      >
                        {r.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Field>
            </View>
          )}

          {step === 2 && (
            <View testID="register-step-city">
              <Text style={styles.h1}>你住在哪里？</Text>
              <Text style={styles.sub}>用于推荐周边资源和符合本地的建议。</Text>
              <Field label="所在城市">
                <TextInput
                  value={city}
                  onChangeText={setCity}
                  placeholder="例如：San Francisco / 多伦多"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                  testID="register-city"
                />
              </Field>
            </View>
          )}

          {step === 3 && (
            <View testID="register-step-concerns">
              <Text style={styles.h1}>最让你头疼的是哪一类？</Text>
              <Text style={styles.sub}>多选。我们会优先给你推送相关的内容。</Text>
              <View style={styles.concerns}>
                {CONCERNS.map((c) => (
                  <Pressable
                    key={c.key}
                    onPress={() => toggleConcern(c.key)}
                    style={[
                      styles.concernChip,
                      concerns.includes(c.key) && styles.concernActive,
                    ]}
                    testID={`register-concern-${c.key}`}
                  >
                    <Ionicons
                      name={
                        concerns.includes(c.key)
                          ? "checkmark-circle"
                          : "ellipse-outline"
                      }
                      size={16}
                      color={concerns.includes(c.key) ? colors.brand : colors.muted}
                    />
                    <Text
                      style={[
                        styles.concernText,
                        concerns.includes(c.key) && {
                          color: colors.onBrandTertiary,
                          fontWeight: "700",
                        },
                      ]}
                    >
                      {c.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {error ? (
            <View style={styles.errorBox} testID="register-error">
              <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          {step > 0 ? (
            <Pressable
              onPress={() => setStep(step - 1)}
              style={styles.backBtn}
              testID="register-back-btn"
            >
              <Ionicons name="chevron-back" size={18} color={colors.onSurface} />
              <Text style={styles.backText}>上一步</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <Pressable
            onPress={next}
            disabled={!canNext() || submitting}
            style={[styles.cta, (!canNext() || submitting) && { opacity: 0.5 }]}
            testID="register-next-btn"
          >
            <Text style={styles.ctaText}>
              {step < 3 ? "下一步" : submitting ? "创建中..." : "完成注册"}
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
  progressTrack: {
    flex: 1,
    height: 4,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: { height: 4, backgroundColor: colors.brand },
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surfaceSecondary,
  },
  chipActive: { backgroundColor: colors.brandTertiary, borderColor: colors.brand },
  chipText: { color: colors.onSurfaceTertiary, fontSize: type.base },
  chipTextActive: { color: colors.onBrandTertiary, fontWeight: "600" },
  concerns: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  concernChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surfaceSecondary,
  },
  concernActive: { backgroundColor: colors.brandTertiary, borderColor: colors.brand },
  concernText: { color: colors.onSurfaceTertiary, fontSize: type.base },
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
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  backText: { color: colors.onSurfaceSecondary, fontSize: type.base, fontWeight: "600" },
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
