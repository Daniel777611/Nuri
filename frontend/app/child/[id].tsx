import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { api } from "@/src/api";
import {
  compareDateOnly,
  completedAgeMonths,
  localDateOnly,
  parseDateOnly,
} from "@/src/child-age";
import { colors, radius, spacing, type } from "@/src/theme";

const GENDERS: { key: "boy" | "girl" | "other"; label: string }[] = [
  { key: "boy", label: "男孩" },
  { key: "girl", label: "女孩" },
  { key: "other", label: "不愿透露" },
];

export default function ChildEdit() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";

  const [nickname, setNickname] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [gender, setGender] = useState<"boy" | "girl" | "other">("other");
  const [allergies, setAllergies] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    (async () => {
      if (isNew) return;
      const list = await api.listChildren();
      const c = list.find((x: any) => x.id === id);
      if (c) {
        setNickname(c.nickname);
        setBirthDate(c.birth_date || "");
        setGender(c.gender);
        setAllergies((c.allergies || []).join(", "));
        setNotes(c.notes || "");
      }
    })();
  }, [id, isNew]);

  const parsedBirthDate = parseDateOnly(birthDate);
  const birthDateError = !birthDate
    ? "请输入孩子的出生日期"
    : !parsedBirthDate
      ? "请按 YYYY-MM-DD 填写有效日期"
      : compareDateOnly(parsedBirthDate, localDateOnly()) > 0
        ? "出生日期不能晚于今天"
        : "";
  const ageMonths = completedAgeMonths(birthDate);
  const canSave = !!nickname.trim() && !birthDateError;

  const save = async () => {
    if (!canSave) return;
    const body = {
      nickname: nickname.trim(),
      birth_date: birthDate,
      gender,
      allergies: allergies
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      notes: notes.trim(),
    };
    if (isNew) await api.addChild(body);
    else await api.updateChild(id as string, body);
    router.back();
  };

  const remove = async () => {
    if (!isNew && id) {
      await api.deleteChild(id as string);
      router.back();
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.back}
          testID="child-back-btn"
        >
          <Ionicons name="chevron-back" size={20} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>
          {isNew ? "添加孩子" : "编辑信息"}
        </Text>
        <Pressable
          onPress={save}
          disabled={!canSave}
          style={[styles.save, !canSave && styles.disabled]}
          testID="child-save-btn"
        >
          <Text style={styles.saveText}>保存</Text>
        </Pressable>
      </View>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          <Field label="昵称">
            <TextInput
              value={nickname}
              onChangeText={setNickname}
              style={styles.input}
              placeholder="例如：小满"
              placeholderTextColor={colors.muted}
              testID="child-nickname"
            />
          </Field>
          <Field label="出生日期">
            <TextInput
              value={birthDate}
              onChangeText={setBirthDate}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={10}
              style={[styles.input, !!birthDateError && styles.inputError]}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.muted}
              testID="child-birth-date"
            />
            <Text
              style={[styles.fieldHint, !!birthDateError && styles.errorText]}
              accessibilityLiveRegion="polite"
            >
              {birthDateError || "保存完整生日，用于准确计算月龄"}
            </Text>
          </Field>
          <Field label="月龄（根据生日自动计算）">
            <View style={[styles.input, styles.readOnlyInput]} testID="child-months">
              <Text style={[styles.readOnlyText, ageMonths === null && styles.mutedText]}>
                {ageMonths === null ? "请先填写有效的出生日期" : `${ageMonths} 个月`}
              </Text>
            </View>
            <Text style={styles.fieldHint}>月龄会随日期自动更新，不能单独修改</Text>
          </Field>
          <Field label="性别">
            <View style={styles.row}>
              {GENDERS.map((g) => (
                <Pressable
                  key={g.key}
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
          <Field label="过敏史">
            <TextInput
              value={allergies}
              onChangeText={setAllergies}
              style={styles.input}
              placeholder="逗号分隔"
              placeholderTextColor={colors.muted}
              testID="child-allergies"
            />
          </Field>
          <Field label="特殊注意事项">
            <TextInput
              value={notes}
              onChangeText={setNotes}
              style={[styles.input, { height: 96, paddingTop: spacing.md }]}
              multiline
              placeholderTextColor={colors.muted}
              testID="child-notes"
            />
          </Field>
          {!isNew && (
            <Pressable
              onPress={remove}
              style={styles.delete}
              testID="child-delete-btn"
            >
              <Ionicons name="trash-outline" size={16} color={colors.error} />
              <Text style={styles.deleteText}>删除此孩子</Text>
            </Pressable>
          )}
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomColor: colors.divider,
    borderBottomWidth: 1,
    backgroundColor: "#fff",
  },
  back: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  title: { flex: 1, fontSize: type.lg, fontWeight: "600", textAlign: "center" },
  save: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  saveText: { color: colors.brand, fontWeight: "700", fontSize: type.base },
  scroll: { padding: spacing.lg },
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
  inputError: { borderColor: colors.error },
  readOnlyInput: { justifyContent: "center", backgroundColor: colors.surface },
  readOnlyText: { fontSize: type.lg, color: colors.onSurface },
  mutedText: { color: colors.muted },
  fieldHint: { marginTop: spacing.xs, fontSize: type.sm, color: colors.muted },
  errorText: { color: colors.error },
  disabled: { opacity: 0.45 },
  row: { flexDirection: "row", gap: spacing.sm },
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
  delete: {
    flexDirection: "row",
    justifyContent: "center",
    gap: spacing.sm,
    alignItems: "center",
    padding: spacing.md,
    marginTop: spacing.md,
  },
  deleteText: { color: colors.error, fontSize: type.base, fontWeight: "600" },
});
