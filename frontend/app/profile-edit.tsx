import { useEffect, useState } from "react";
import {
  ActivityIndicator,
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
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import Toast from "@/src/components/Toast";
import { useT } from "@/src/i18n";
import { CONCERNS, FREQUENCIES, HELP_PREFS, INFO_SOURCES, PARENT_ROLES } from "@/src/profileOptions";
import { colors, radius, spacing, type } from "@/src/theme";

type Options = readonly (readonly [string, string])[];

// Everything onboarding asked about the parent, editable after the fact.
export default function ProfileEdit() {
  const { t } = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const phoneWidth = Math.min(width, 402);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [nickname, setNickname] = useState("");
  const [city, setCity] = useState("");
  const [parentRole, setParentRole] = useState("");
  const [concerns, setConcerns] = useState<string[]>([]);
  const [concernOther, setConcernOther] = useState("");
  const [helpPref, setHelpPref] = useState("");
  const [infoSource, setInfoSource] = useState("");
  const [frequency, setFrequency] = useState("");

  const load = async () => {
    setState("loading");
    try {
      const me = await api.me();
      setNickname(me?.nickname || "");
      setCity(me?.city || "");
      setParentRole(me?.parent_role || "");
      setConcerns((me?.top_concerns || []).filter((key: string) => CONCERNS.some(([k]) => k === key)));
      setConcernOther(me?.concern_other || "");
      setHelpPref(me?.help_preference || "");
      setInfoSource(me?.info_source || "");
      setFrequency(me?.content_frequency || "");
      setState("ready");
    } catch {
      setState("error");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const showToast = (message: string) => {
    setToastMsg(message);
    setTimeout(() => setToastMsg(null), 2000);
  };

  const canSave = state === "ready" && !!nickname.trim() && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await api.updateMe({
        nickname: nickname.trim(),
        city: city.trim(),
        parent_role: parentRole || undefined,
        top_concerns: concerns,
        concern_other: concerns.includes("other") ? concernOther.trim() : "",
        help_preference: helpPref || undefined,
        info_source: infoSource || undefined,
        content_frequency: frequency || undefined,
      });
      router.back();
    } catch {
      showToast(t("保存失败，请检查网络后重试"));
    } finally {
      setSaving(false);
    }
  };

  const toggleConcern = (key: string) =>
    setConcerns((old) => (old.includes(key) ? old.filter((k) => k !== key) : [...old, key]));

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={[styles.canvas, { width: phoneWidth }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.headerBtn} hitSlop={8} testID="profile-edit-back">
            <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.title}>{t("编辑资料")}</Text>
          <Pressable
            onPress={() => void save()}
            disabled={!canSave}
            style={[styles.headerBtn, styles.saveBtn]}
            testID="profile-edit-save"
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.brand} />
            ) : (
              <Text style={[styles.saveText, !canSave && styles.saveTextDisabled]}>{t("保存")}</Text>
            )}
          </Pressable>
        </View>

        {state === "loading" ? (
          <View style={styles.center}><ActivityIndicator color={colors.brand} /></View>
        ) : state === "error" ? (
          <Pressable style={styles.center} onPress={() => void load()} testID="profile-edit-retry">
            <Ionicons name="refresh" size={22} color={colors.brand} />
            <Text style={styles.muted}>{t("资料没能加载，点此重试")}</Text>
          </Pressable>
        ) : (
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
              <Field label={t("我应该怎么称呼你？")}>
                <TextInput
                  value={nickname}
                  onChangeText={setNickname}
                  placeholder={t("例如：小满妈")}
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                  testID="profile-edit-nickname"
                />
              </Field>
              <Field label={t("您是孩子的？")}>
                <Chips options={PARENT_ROLES} isActive={(k) => parentRole === k} onPress={setParentRole} />
              </Field>
              <Field label={t("您目前居住在哪里？")}>
                <TextInput
                  value={city}
                  onChangeText={setCity}
                  placeholder={t("例如：San Francisco／多伦多")}
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />
              </Field>
              <Field label={t("目前最困扰你的事情是什么？（可多选）")}>
                <Chips options={CONCERNS} isActive={(k) => concerns.includes(k)} onPress={toggleConcern} />
                {concerns.includes("other") ? (
                  <TextInput
                    value={concernOther}
                    onChangeText={setConcernOther}
                    placeholder={t("请描述你的困扰...")}
                    placeholderTextColor={colors.muted}
                    style={[styles.input, { marginTop: spacing.sm }]}
                  />
                ) : null}
              </Field>
              <Field label={t("你希望 NURI 提供什么样的帮助？")}>
                <Chips options={HELP_PREFS} isActive={(k) => helpPref === k} onPress={setHelpPref} />
              </Field>
              <Field label={t("你平常比较信任哪些信息来源？")}>
                <Chips options={INFO_SOURCES} isActive={(k) => infoSource === k} onPress={setInfoSource} />
              </Field>
              <Field label={t("希望多久收到一次育儿内容？")}>
                <Chips options={FREQUENCIES} isActive={(k) => frequency === k} onPress={setFrequency} />
              </Field>
            </ScrollView>
          </KeyboardAvoidingView>
        )}
        <Toast message={toastMsg} />
      </View>
    </SafeAreaView>
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

function Chips({
  options,
  isActive,
  onPress,
}: {
  options: Options;
  isActive: (key: string) => boolean;
  onPress: (key: string) => void;
}) {
  const { t } = useT();
  return (
    <View style={styles.chips}>
      {options.map(([key, label]) => {
        const active = isActive(key);
        return (
          <Pressable
            key={key}
            onPress={() => onPress(key)}
            style={[styles.chip, active && styles.chipActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{t(label)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  canvas: { flex: 1, alignSelf: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerBtn: { minWidth: 44, height: 40, justifyContent: "center" },
  saveBtn: { alignItems: "flex-end" },
  title: { flex: 1, textAlign: "center", fontSize: type.lg, fontWeight: "700", color: colors.onSurface },
  saveText: { color: colors.brand, fontSize: type.lg, fontWeight: "700" },
  saveTextDisabled: { color: colors.muted },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  muted: { color: colors.muted, fontSize: type.base },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  field: { marginBottom: spacing.xl },
  label: { fontSize: type.base, fontWeight: "700", color: colors.onSurface, marginBottom: spacing.sm },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    // 16px or more: iOS zooms the page when a smaller field takes focus.
    fontSize: 16,
    color: colors.onSurface,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSecondary,
  },
  chipActive: { backgroundColor: "#3A2F5A", borderColor: "#3A2F5A" },
  chipText: { fontSize: type.base, color: colors.onSurface },
  chipTextActive: { color: "#FFFFFF", fontWeight: "600" },
});
