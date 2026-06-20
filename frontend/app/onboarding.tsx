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

import { api } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

const GENDERS: { key: "boy" | "girl" | "other"; label: string }[] = [
  { key: "boy", label: "男孩" },
  { key: "girl", label: "女孩" },
  { key: "other", label: "不愿透露" },
];

export default function Onboarding() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [months, setMonths] = useState("");
  const [gender, setGender] = useState<"boy" | "girl" | "other">("other");
  const [allergies, setAllergies] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!nickname.trim() || !months.trim()) return;
    setSaving(true);
    const monthsNum = parseInt(months, 10) || 0;
    const birth = new Date();
    birth.setMonth(birth.getMonth() - monthsNum);
    try {
      await api.addChild({
        nickname: nickname.trim(),
        birth_date: birth.toISOString().slice(0, 10),
        gender,
        allergies: allergies
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean),
        notes: notes.trim(),
      });
      router.replace("/(tabs)");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hero} testID="onboarding-hero">
            <View style={styles.heroBadge}>
              <Ionicons name="leaf-outline" size={20} color={colors.brand} />
            </View>
            <Text style={styles.h1}>先告诉我，你的小宝贝</Text>
            <Text style={styles.sub}>
              这些信息只用来给你更个性化的建议，永远不会分享给第三方。
            </Text>
          </View>

          <Field label="昵称">
            <TextInput
              testID="onboarding-nickname-input"
              value={nickname}
              onChangeText={setNickname}
              placeholder="例如：小满"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
          </Field>

          <Field label="当前月龄">
            <TextInput
              testID="onboarding-months-input"
              value={months}
              onChangeText={setMonths}
              keyboardType="number-pad"
              placeholder="例如：18"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
          </Field>

          <Field label="性别">
            <View style={styles.row}>
              {GENDERS.map((g) => (
                <Pressable
                  key={g.key}
                  testID={`onboarding-gender-${g.key}`}
                  onPress={() => setGender(g.key)}
                  style={[
                    styles.chip,
                    gender === g.key && styles.chipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      gender === g.key && styles.chipTextActive,
                    ]}
                  >
                    {g.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Field>

          <Field label="过敏史（可选，用逗号分隔）">
            <TextInput
              testID="onboarding-allergies-input"
              value={allergies}
              onChangeText={setAllergies}
              placeholder="例如：牛奶, 鸡蛋"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
          </Field>

          <Field label="特殊注意事项（可选）">
            <TextInput
              testID="onboarding-notes-input"
              value={notes}
              onChangeText={setNotes}
              placeholder="例如：晚上容易夜醒"
              placeholderTextColor={colors.muted}
              style={[styles.input, { height: 88, paddingTop: spacing.md }]}
              multiline
            />
          </Field>

          <Pressable
            testID="onboarding-submit-btn"
            disabled={saving || !nickname || !months}
            onPress={submit}
            style={[
              styles.cta,
              (!nickname || !months || saving) && { opacity: 0.5 },
            ]}
          >
            <Text style={styles.ctaText}>开始使用</Text>
            <Ionicons name="arrow-forward" color="#fff" size={18} />
          </Pressable>
        </ScrollView>
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
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  hero: { marginBottom: spacing.xl, marginTop: spacing.sm },
  heroBadge: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  h1: { fontSize: type.xxl, fontWeight: "700", color: colors.onSurface },
  sub: {
    fontSize: type.base,
    color: colors.muted,
    marginTop: spacing.sm,
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
  row: { flexDirection: "row", gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surfaceSecondary,
  },
  chipActive: {
    backgroundColor: colors.brandTertiary,
    borderColor: colors.brand,
  },
  chipText: { color: colors.onSurfaceTertiary, fontSize: type.base },
  chipTextActive: { color: colors.onBrandTertiary, fontWeight: "600" },
  cta: {
    flexDirection: "row",
    backgroundColor: colors.brand,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  ctaText: { color: "#fff", fontSize: type.lg, fontWeight: "700" },
});
