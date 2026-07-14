import { useEffect, useState } from "react";
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

const TOTAL_STEPS = 4;

const CONCERNS = [
  { key: "sleep", label: "睡眠" },
  { key: "food", label: "饮食／副食品" },
  { key: "emotion", label: "情绪与哭闹" },
  { key: "development", label: "发展与学习" },
  { key: "parenting", label: "教养方式" },
  { key: "health", label: "生病与健康" },
  { key: "childcare", label: "托育／幼儿园" },
  { key: "family", label: "家人教养观念不同" },
  { key: "unknown", label: "我不知道从哪开始" },
  { key: "other", label: "其他" },
];

const HELP_PREFS = [
  { key: "research", label: "专业研究与知识" },
  { key: "experience", label: "真实家长经验分享" },
  { key: "analysis", label: "一步一步分析原因" },
  { key: "actionable", label: "直接给我可执行的方法" },
];

const INFO_SOURCES = [
  { key: "research", label: "专业研究／论文" },
  { key: "expert", label: "医师或专家" },
  { key: "parents", label: "其他家长经验" },
  { key: "all", label: "都会参考" },
];

const FREQUENCIES = [
  { key: "daily", label: "每天一次" },
  { key: "weekly_2_3", label: "每周 2～3 次" },
  { key: "weekly", label: "每周一次" },
  { key: "on_demand", label: "有需要时再推播" },
];

const THIS_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 9 }, (_, i) => THIS_YEAR - i);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  // ① child
  const [childName, setChildName] = useState("");
  const [birthYear, setBirthYear] = useState<number | null>(null);
  const [birthMonth, setBirthMonth] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [existingChild, setExistingChild] = useState<any>(null);
  // ② parent
  const [nickname, setNickname] = useState("");
  const [city, setCity] = useState("");
  // ③ concerns (skippable)
  const [concerns, setConcerns] = useState<string[]>([]);
  const [concernOther, setConcernOther] = useState("");
  // ④ parenting style (skippable)
  const [hobbies, setHobbies] = useState("");
  const [helpPref, setHelpPref] = useState("");
  const [infoSource, setInfoSource] = useState("");
  const [frequency, setFrequency] = useState("");

  const [saving, setSaving] = useState(false);

  // Prefill for returning users (老用户下次登录补填)
  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        if (me?.nickname) setNickname(me.nickname);
        if (me?.city) setCity(me.city);
        if (me?.top_concerns?.length) setConcerns(me.top_concerns);
        if (me?.concern_other) setConcernOther(me.concern_other);
        if (me?.hobbies) setHobbies(me.hobbies);
        if (me?.help_preference) setHelpPref(me.help_preference);
        if (me?.info_source) setInfoSource(me.info_source);
        if (me?.content_frequency) setFrequency(me.content_frequency);
        const children = await api.listChildren();
        if (children?.length) {
          const c = children[0];
          setExistingChild(c);
          setChildName(c.nickname || "");
          const d = new Date(c.birth_date);
          if (!isNaN(d.getTime())) {
            setBirthYear(d.getFullYear());
            setBirthMonth(d.getMonth() + 1);
          }
        }
      } catch {
        // not fatal — user fills manually
      }
    })();
  }, []);

  const toggleConcern = (k: string) =>
    setConcerns((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const canNext = () => {
    if (step === 0) return childName.trim().length >= 1 && !!birthYear && !!birthMonth;
    if (step === 1) return nickname.trim().length >= 1 && city.trim().length >= 1;
    return true;
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const birth_date = `${birthYear}-${String(birthMonth).padStart(2, "0")}-01`;
      const childBody = {
        nickname: childName.trim(),
        birth_date,
        gender: existingChild?.gender ?? "other",
        allergies: existingChild?.allergies ?? [],
        notes: existingChild?.notes ?? "",
      };
      if (existingChild?.id) await api.updateChild(existingChild.id, childBody);
      else await api.addChild(childBody);

      await api.updateMe({
        nickname: nickname.trim(),
        city: city.trim(),
        top_concerns: concerns,
        concern_other: concerns.includes("other") ? concernOther.trim() : "",
        hobbies: hobbies.trim(),
        help_preference: helpPref,
        info_source: infoSource,
        content_frequency: frequency,
        onboarding_completed: true,
      });
      router.replace("/(tabs)");
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    if (step < TOTAL_STEPS - 1) setStep(step + 1);
    else submit();
  };

  const skip = () => {
    if (step === 2) setStep(3);
    else if (step === 3) submit();
  };

  const birthLabel =
    birthYear && birthMonth ? `${birthYear} 年 ${birthMonth} 月` : "选择出生年月";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View style={styles.header}>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${((step + 1) / TOTAL_STEPS) * 100}%` },
              ]}
            />
          </View>
          {step >= 2 ? (
            <Pressable onPress={skip} testID="onboarding-skip-btn" hitSlop={8}>
              <Text style={styles.skipText}>跳过</Text>
            </Pressable>
          ) : (
            <Text style={styles.stepText}>
              {step + 1}/{TOTAL_STEPS}
            </Text>
          )}
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {step === 0 && (
            <View testID="onboarding-step-child">
              <Text style={styles.h1}>孩子基本资料</Text>
              <Text style={styles.sub}>
                这些信息只用来给你更个性化的建议，永远不会分享给第三方。
              </Text>
              <Field label="孩子怎么称呼呢？">
                <TextInput
                  testID="onboarding-child-name"
                  value={childName}
                  onChangeText={setChildName}
                  placeholder="例如：小满"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />
              </Field>
              <Field label="孩子的出生日期">
                <Pressable
                  testID="onboarding-birth-picker"
                  onPress={() => setPickerOpen(true)}
                  style={[styles.input, styles.pickerField]}
                >
                  <Text
                    style={[
                      styles.pickerText,
                      !(birthYear && birthMonth) && { color: colors.muted },
                    ]}
                  >
                    {birthLabel}
                  </Text>
                  <Ionicons name="calendar-outline" size={18} color={colors.muted} />
                </Pressable>
              </Field>
            </View>
          )}

          {step === 1 && (
            <View testID="onboarding-step-parent">
              <Text style={styles.h1}>家长基本资料</Text>
              <Text style={styles.sub}>AI 会用这个名字和你打招呼。</Text>
              <Field label="我应该怎么称呼你？">
                <TextInput
                  testID="onboarding-nickname"
                  value={nickname}
                  onChangeText={setNickname}
                  placeholder="例如：小满妈"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />
              </Field>
              <Field label="你目前居住在哪里？（城市）">
                <TextInput
                  testID="onboarding-city"
                  value={city}
                  onChangeText={setCity}
                  placeholder="例如：San Francisco / 多伦多"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />
              </Field>
            </View>
          )}

          {step === 2 && (
            <View testID="onboarding-step-concerns">
              <Text style={styles.h1}>目前最想解决的育儿问题</Text>
              <Text style={styles.sub}>目前最困扰你的事情是什么？（可多选）</Text>
              <View style={styles.chips}>
                {CONCERNS.map((c) => {
                  const active = concerns.includes(c.key);
                  return (
                    <Pressable
                      key={c.key}
                      onPress={() => toggleConcern(c.key)}
                      style={[styles.chip, active && styles.chipActive]}
                      testID={`onboarding-concern-${c.key}`}
                    >
                      <Ionicons
                        name={active ? "checkbox" : "square-outline"}
                        size={16}
                        color={active ? colors.brand : colors.muted}
                      />
                      <Text
                        style={[styles.chipText, active && styles.chipTextActive]}
                      >
                        {c.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {concerns.includes("other") ? (
                <TextInput
                  testID="onboarding-concern-other-input"
                  value={concernOther}
                  onChangeText={setConcernOther}
                  placeholder="请描述你的困扰..."
                  placeholderTextColor={colors.muted}
                  style={[styles.input, { marginTop: spacing.md }]}
                />
              ) : null}
            </View>
          )}

          {step === 3 && (
            <View testID="onboarding-step-style">
              <Text style={styles.h1}>了解你的教养方式</Text>
              <Text style={styles.sub}>帮 AI 用你喜欢的方式陪你带娃。</Text>

              <Field label="平常没带小孩时喜欢做的事">
                <TextInput
                  testID="onboarding-hobbies"
                  value={hobbies}
                  onChangeText={setHobbies}
                  placeholder="例如：看剧、健身、和朋友聚会..."
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />
              </Field>

              <Field label="遇到教养问题时，你希望我提供什么？">
                <OptionGroup
                  options={HELP_PREFS}
                  value={helpPref}
                  onChange={setHelpPref}
                  testPrefix="onboarding-help"
                />
              </Field>

              <Field label="你平常比较信任哪些信息来源？">
                <OptionGroup
                  options={INFO_SOURCES}
                  value={infoSource}
                  onChange={setInfoSource}
                  testPrefix="onboarding-source"
                />
              </Field>

              <Field label="希望多久收到一次育儿知识或有帮助的内容？">
                <OptionGroup
                  options={FREQUENCIES}
                  value={frequency}
                  onChange={setFrequency}
                  testPrefix="onboarding-freq"
                />
              </Field>
            </View>
          )}
        </ScrollView>

        <View style={styles.footer}>
          {step > 0 ? (
            <Pressable
              onPress={() => setStep(step - 1)}
              style={styles.backBtn}
              testID="onboarding-back-btn"
            >
              <Ionicons name="chevron-back" size={18} color={colors.onSurface} />
              <Text style={styles.backText}>上一步</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <Pressable
            onPress={next}
            disabled={!canNext() || saving}
            style={[styles.cta, (!canNext() || saving) && { opacity: 0.5 }]}
            testID="onboarding-next-btn"
          >
            <Text style={styles.ctaText}>
              {step < TOTAL_STEPS - 1 ? "下一步" : saving ? "保存中..." : "完成"}
            </Text>
            <Ionicons name="arrow-forward" color="#fff" size={18} />
          </Pressable>
        </View>

        {pickerOpen ? (
          <View style={styles.overlay}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => setPickerOpen(false)}
            />
            <View style={styles.sheet} testID="onboarding-birth-sheet">
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>选择出生年月</Text>
              <Pressable
                onPress={() => setPickerOpen(false)}
                disabled={!birthYear || !birthMonth}
                testID="onboarding-birth-confirm"
                hitSlop={8}
              >
                <Text
                  style={[
                    styles.sheetDone,
                    (!birthYear || !birthMonth) && { opacity: 0.4 },
                  ]}
                >
                  确定
                </Text>
              </Pressable>
            </View>
            <View style={styles.pickerCols}>
              <ScrollView style={styles.pickerCol} showsVerticalScrollIndicator={false}>
                {YEARS.map((y) => (
                  <Pressable
                    key={y}
                    onPress={() => setBirthYear(y)}
                    style={[styles.pickerItem, birthYear === y && styles.pickerItemActive]}
                    testID={`onboarding-year-${y}`}
                  >
                    <Text
                      style={[
                        styles.pickerItemText,
                        birthYear === y && styles.pickerItemTextActive,
                      ]}
                    >
                      {y} 年
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <ScrollView style={styles.pickerCol} showsVerticalScrollIndicator={false}>
                {MONTHS.map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => setBirthMonth(m)}
                    style={[styles.pickerItem, birthMonth === m && styles.pickerItemActive]}
                    testID={`onboarding-month-${m}`}
                  >
                    <Text
                      style={[
                        styles.pickerItemText,
                        birthMonth === m && styles.pickerItemTextActive,
                      ]}
                    >
                      {m} 月
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function OptionGroup({
  options,
  value,
  onChange,
  testPrefix,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  testPrefix: string;
}) {
  return (
    <View style={{ gap: spacing.sm }}>
      {options.map((o) => {
        const active = value === o.key;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(active ? "" : o.key)}
            style={[styles.option, active && styles.optionActive]}
            testID={`${testPrefix}-${o.key}`}
          >
            <Ionicons
              name={active ? "radio-button-on" : "radio-button-off"}
              size={18}
              color={active ? colors.brand : colors.muted}
            />
            <Text style={[styles.optionText, active && styles.optionTextActive]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
  stepText: { color: colors.muted, fontSize: type.sm, fontWeight: "600" },
  skipText: { color: colors.brand, fontSize: type.base, fontWeight: "700" },
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
  pickerField: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pickerText: { fontSize: type.lg, color: colors.onSurface },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
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
  chipActive: { backgroundColor: colors.brandTertiary, borderColor: colors.brand },
  chipText: { color: colors.onSurfaceTertiary, fontSize: type.base },
  chipTextActive: { color: colors.onBrandTertiary, fontWeight: "700" },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surfaceSecondary,
  },
  optionActive: { backgroundColor: colors.brandTertiary, borderColor: colors.brand },
  optionText: { color: colors.onSurfaceTertiary, fontSize: type.base, flex: 1 },
  optionTextActive: { color: colors.onBrandTertiary, fontWeight: "700" },
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
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
    zIndex: 10,
  },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: spacing.xl,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomColor: colors.divider,
    borderBottomWidth: 1,
  },
  sheetTitle: { fontSize: type.lg, fontWeight: "700", color: colors.onSurface },
  sheetDone: { fontSize: type.lg, fontWeight: "700", color: colors.brand },
  pickerCols: { flexDirection: "row", height: 260 },
  pickerCol: { flex: 1 },
  pickerItem: {
    paddingVertical: spacing.md,
    alignItems: "center",
    marginHorizontal: spacing.md,
    marginVertical: 2,
    borderRadius: radius.md,
  },
  pickerItemActive: { backgroundColor: colors.brandTertiary },
  pickerItemText: { fontSize: type.lg, color: colors.onSurfaceTertiary },
  pickerItemTextActive: { color: colors.onBrandTertiary, fontWeight: "700" },
});
