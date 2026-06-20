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
  const [months, setMonths] = useState("");
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
        const b = new Date(c.birth_date);
        const n = new Date();
        const m =
          (n.getFullYear() - b.getFullYear()) * 12 +
          (n.getMonth() - b.getMonth());
        setMonths(String(Math.max(0, m)));
        setGender(c.gender);
        setAllergies((c.allergies || []).join(", "));
        setNotes(c.notes || "");
      }
    })();
  }, [id, isNew]);

  const save = async () => {
    const monthsNum = parseInt(months, 10) || 0;
    const birth = new Date();
    birth.setMonth(birth.getMonth() - monthsNum);
    const body = {
      nickname: nickname.trim(),
      birth_date: birth.toISOString().slice(0, 10),
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
        <Pressable onPress={save} style={styles.save} testID="child-save-btn">
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
          <Field label="月龄">
            <TextInput
              value={months}
              onChangeText={setMonths}
              keyboardType="number-pad"
              style={styles.input}
              placeholderTextColor={colors.muted}
              testID="child-months"
            />
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
