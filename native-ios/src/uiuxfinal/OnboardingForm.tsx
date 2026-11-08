import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { NuriField, NuriText } from "@/src/uiux48/Primitives";
import { useNuriTheme } from "@/src/uiux48/Theme";
import { useT, translate } from "@/src/i18n";
import type { ChildDraft } from "@/src/onboardingChildren";
import type { ParentGender } from "@/src/onboardingParentGender";
import { InlineChildDate } from "./InlineChildDate";

export type ParentDraft = { nickname: string; city: string; gender: ParentGender };
const artwork = {
  female: require("@/assets/onboarding-simplified/female.svg"), male: require("@/assets/onboarding-simplified/male.svg"), hidden: require("@/assets/onboarding-simplified/hidden.svg"),
  edit: require("@/assets/onboarding-simplified/edit.svg"), delete: require("@/assets/onboarding-simplified/delete.svg"),
};
function Glyph({ name }: { name: keyof typeof artwork }) {
  const theme = useNuriTheme();
  // Preserve the exported root SVG geometry inside the shared 20pt icon slot.
  const size = name === "female" ? { width: 8.5, height: 13.7083 } : name === "male" ? { width: 12.875, height: 12.875 } : { width: 20, height: 20 };
  return <View style={styles.icon}><Image source={artwork[name]} contentFit="contain" style={size} tintColor={theme.night && name !== "delete" ? theme.ink : undefined} /></View>;
}
function useCopy() { const { locale } = useT(); return (cn: string, en: string, vars?: Record<string, string | number>) => translate(locale, locale === "en" ? en : cn, vars); }
function Card({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const theme = useNuriTheme();
  return <View testID={testID} style={[styles.card, { backgroundColor: theme.night ? "rgba(48,39,60,.94)" : "rgba(255,250,245,.94)", borderColor: theme.night ? "rgba(236,220,245,.16)" : "rgba(93,80,96,.12)" }]}>{children}</View>;
}
function Field({ label, value, onChange, testID, disabled, maxLength = 120 }: { label: string; value: string; onChange: (value: string) => void; testID: string; disabled?: boolean; maxLength?: number }) {
  const theme = useNuriTheme();
  return <View style={styles.field}><NuriText role="Caption" secondary>{label}</NuriText><View style={[styles.inputRim, { borderColor: theme.outline }]}><NuriField accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled} maxLength={maxLength} testID={testID} style={{ borderRadius: 18, borderWidth: 0, textAlign: "auto", backgroundColor: "transparent" }} /></View></View>;
}
function GenderCards({ value, onChange, parent = false, disabled, prefix }: { value: string; onChange: (value: string) => void; parent?: boolean; disabled?: boolean; prefix: string }) {
  const copy = useCopy(), theme = useNuriTheme();
  const options = parent ? [{ key: "female", label: copy("女", "Female"), icon: "female" }, { key: "male", label: copy("男", "Male"), icon: "male" }, { key: "hidden", label: copy("隐藏", "Hidden"), icon: "hidden" }] : [{ key: "boy", label: copy("男孩", "Boy"), icon: "male" }, { key: "girl", label: copy("女孩", "Girl"), icon: "female" }, { key: "other", label: copy("不选择", "Not specified"), icon: "hidden" }];
  return <View style={styles.field}><NuriText secondary role="Caption">{parent ? copy("性别", "Gender") : copy("性别（可选）", "Gender (optional)")}</NuriText><View style={styles.choices}>{options.map(option => <Pressable key={option.key} accessibilityRole="radio" accessibilityState={{ checked: value === option.key, disabled }} accessibilityLabel={option.label} disabled={disabled} testID={`${prefix}-gender-${option.key}`} onPress={() => onChange(option.key)} style={[styles.choice, { borderColor: value === option.key ? "#C1A0DD" : theme.outline, borderWidth: value === option.key ? 1.5 : 1, backgroundColor: value === option.key ? "rgba(193,160,221,.13)" : "transparent" }]}><NuriText role="Caption" style={{ fontSize: 14, lineHeight: 20 }}>{option.label}</NuriText><View style={styles.genderIcon}><Glyph name={option.icon as "female" | "male" | "hidden"} /></View></Pressable>)}</View></View>;
}
export function OnboardingPrompt({ label }: { label: string }) {
  return <View style={styles.promptRow}><View style={styles.avatar}><Image source={require("@/assets/onboarding-simplified/mascot.png")} contentFit="cover" style={{ position: "absolute", left: -1, top: 3, width: 49, height: 61 }} /></View><View style={styles.prompt}><Image source={require("@/assets/onboarding-simplified/prompt.svg")} contentFit="contain" style={{ position: "absolute", left: -15, top: -14, width: 174, height: 74 }} /><NuriText style={{ color: "white" }}>{label}</NuriText></View></View>;
}
export function ParentProfileCard({ value, onChange, disabled }: { value: ParentDraft; onChange: (value: ParentDraft) => void; disabled: boolean }) {
  const copy = useCopy();
  return <Card testID="onboarding-parent-card"><NuriText role="H3" secondary>{copy("家长资料", "Parent profile")}</NuriText><Field label={copy("称呼", "Name")} value={value.nickname} onChange={nickname => onChange({ ...value, nickname })} disabled={disabled} testID="onboarding-parent-name" /><GenderCards parent prefix="onboarding-parent" value={value.gender} onChange={gender => onChange({ ...value, gender: gender as ParentGender })} disabled={disabled} /><NuriText secondary role="Caption" testID="onboarding-gender-local-note">{copy("性别选择仅保存在本机，可选隐藏。", "Gender is saved only on this device; you may keep it hidden.")}</NuriText><Field label={copy("地址（可选）", "City (optional)")} value={value.city} onChange={city => onChange({ ...value, city })} disabled={disabled} testID="onboarding-city" maxLength={200} /></Card>;
}
export function ChildProfileCard({ row, ordinal, onChange, onRemove, disabled }: { row: ChildDraft; ordinal: number; onChange: (row: ChildDraft) => void; onRemove: () => void; disabled: boolean }) {
  const copy = useCopy();
  const dateLabel = row.expecting ? copy("预产期", "Due date") : copy("出生日期", "Date of birth");
  return <Card testID={`onboarding-child-card-${row.key}`}><View style={styles.cardHeader}><NuriText role="H3" secondary style={{ flex: 1 }}>{row.expecting ? copy("未出生孩子 {ordinal}", "Expected child {ordinal}", { ordinal }) : copy("已出生孩子 {ordinal}", "Child {ordinal}", { ordinal })}</NuriText><Pressable accessibilityRole="button" accessibilityLabel={copy("移除此孩子", "Remove this child")} onPress={onRemove} disabled={disabled} testID={`onboarding-remove-${row.key}`} style={styles.cardAction}><Glyph name="delete" /></Pressable></View>
    <Field label={copy("昵称", "Nickname")} value={row.nickname} onChange={nickname => onChange({ ...row, nickname })} disabled={disabled} testID={`onboarding-child-name-${row.key}`} />
    <GenderCards prefix={`onboarding-child-${row.key}`} value={row.gender} onChange={gender => onChange({ ...row, gender: gender as ChildDraft["gender"] })} disabled={disabled} />
    <View style={styles.field}><NuriText secondary role="Caption">{dateLabel}</NuriText><InlineChildDate row={row} onChange={onChange} disabled={disabled} /></View>
  </Card>;
}
export function ChildReviewCard({ row, onEdit, disabled }: { row: ChildDraft; onEdit: () => void; disabled: boolean }) {
  const copy = useCopy();
  return <Card testID={`onboarding-review-${row.key}`}><View style={styles.cardHeader}><NuriText role="H3" secondary style={{ flexShrink: 1 }}>{row.nickname}</NuriText><View style={styles.badge}><NuriText secondary role="Caption">{row.expecting ? copy("未出生", "Expecting") : copy("已出生", "Born")}</NuriText></View><View style={{ flex: 1 }} /><Pressable onPress={onEdit} disabled={disabled} accessibilityRole="button" accessibilityLabel={copy("编辑 {nickname}", "Edit {nickname}", { nickname: row.nickname })} style={styles.cardAction} testID={`onboarding-edit-${row.key}`}><Glyph name="edit" /></Pressable></View>
    <View style={styles.reviewLine}><NuriText secondary role="Caption">{copy("性别", "Gender")}</NuriText><NuriText>{row.gender === "boy" ? copy("男孩", "Boy") : row.gender === "girl" ? copy("女孩", "Girl") : copy("不选择", "Not specified")}</NuriText></View>
    <View style={styles.reviewLine}><NuriText secondary role="Caption">{row.expecting ? copy("预产期", "Due date") : copy("出生日期", "Date of birth")}</NuriText><NuriText>{row.birth_date}</NuriText></View>
  </Card>;
}

const styles = StyleSheet.create({
  icon: { width: 20, height: 20, alignItems: "center", justifyContent: "center" }, card: { width: "100%", maxWidth: 500, alignSelf: "center", borderRadius: 24, borderWidth: 1, padding: 16, gap: 12, flexShrink: 0 },
  field: { gap: 8 }, inputRim: { borderWidth: 1, borderRadius: 18, overflow: "hidden" }, choices: { flexDirection: "row", gap: 8 }, choice: { flex: 1, minHeight: 82, borderRadius: 16, padding: 10, justifyContent: "space-between", gap: 8 }, genderIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(193,160,221,.21)", alignItems: "center", justifyContent: "center", alignSelf: "flex-end" },
  promptRow: { minHeight: 44, flexDirection: "row", gap: 10, alignItems: "center", paddingHorizontal: 24, paddingBottom: 4 }, avatar: { width: 44, height: 44, borderRadius: 22, overflow: "hidden", backgroundColor: "#BA94AC" }, prompt: { width: 144, height: 44, alignItems: "center", justifyContent: "center" },
  cardHeader: { flexDirection: "row", alignItems: "center", minHeight: 28, gap: 8 }, cardAction: { width: 44, height: 44, marginVertical: -8, marginRight: -8, alignItems: "center", justifyContent: "center" },
  badge: { paddingHorizontal: 12, minHeight: 28, borderRadius: 14, backgroundColor: "rgba(193,160,221,.18)", alignItems: "center" }, reviewLine: { minHeight: 44, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
});
