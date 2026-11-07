// Report community content or a parent: pick a reason, optionally say more,
// optionally block. Google Play's user-generated content policy requires this
// in-app flag; the report lands in community_reports for a person to review
// at /admin (it is not judged by AI and is not anonymous to the backend).
import { NuriTextInput } from "@/src/keyboard/AppKeyboard";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import { useT, translate } from "@/src/i18n";
import type { ReportReason } from "@/src/communityApi";
import { FinalButton, FinalSurface, FinalText, FINAL_COLOR } from "./Primitives";

export const REPORT_REASONS: readonly { key: ReportReason; cn: string; en: string }[] = [
  { key: "harassment", cn: "骚扰、辱骂或欺凌", en: "Harassment or bullying" },
  { key: "sexual", cn: "色情或性暗示内容", en: "Sexual content" },
  { key: "hate", cn: "仇恨或歧视", en: "Hate or discrimination" },
  { key: "child_safety", cn: "危害儿童安全", en: "Endangers a child" },
  { key: "self_harm", cn: "自伤或危险行为", en: "Self-harm or dangerous acts" },
  { key: "spam", cn: "广告、诈骗或垃圾信息", en: "Spam or scam" },
  { key: "other", cn: "其他问题", en: "Something else" },
];

export function CommunityReportSheet({ visible, busy, title, allowBlock, onClose, onSubmit }: {
  visible: boolean;
  busy: boolean;
  title: string;
  /** Offer "also block": not for anonymous content, whose author must stay unknown. */
  allowBlock: boolean;
  onClose: () => void;
  onSubmit: (reason: ReportReason, note: string, block: boolean) => void;
}) {
  const { locale } = useT();
  const c = (cn: string, en: string) => locale === "en" ? en : translate(locale, cn);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [block, setBlock] = useState(false);
  // Each report starts blank, so a second report never inherits the first.
  useEffect(() => { if (visible) { setReason(null); setNote(""); setBlock(false); } }, [visible]);

  return <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? undefined : onClose}>
    <BlurView tint="light" intensity={40} style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(254,250,247,.5)" }} testID="community-report-sheet">
      <Pressable style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} accessibilityRole="button" accessibilityLabel={c("取消", "Cancel")} onPress={busy ? undefined : onClose} />
      <FinalSurface surfaceColor="rgba(255,255,255,.96)" style={{ width: 354, maxWidth: "100%", maxHeight: 620, alignSelf: "center", boxShadow: "0px 4px 8px rgba(89,71,92,.14)" }} contentStyle={{ padding: 24 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
          <FinalText size={20} style={{ lineHeight: 28, fontWeight: "500" }}>{title}</FinalText>
          <FinalText size={14} secondary>{c("请选择原因。举报会由 NURI 团队人工审核，对方不会知道是你举报的。", "Choose a reason. The NURI team reviews every report by hand; they won't know it was you.")}</FinalText>
          {REPORT_REASONS.map(item => {
            const selected = reason === item.key;
            return <Pressable key={item.key} onPress={() => setReason(item.key)} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled: busy }} testID={`community-report-reason-${item.key}`} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, borderRadius: 14, backgroundColor: selected ? "rgba(115,92,132,.12)" : "transparent" }}>
              <Image source={selected ? require("@/assets/final-flow-20261101/community-radio-selected.svg") : require("@/assets/final-flow-20261101/community-radio-empty.svg")} style={{ width: 16, height: 16 }} contentFit="contain" accessible={false} />
              <FinalText style={{ flex: 1 }}>{c(item.cn, item.en)}</FinalText>
            </Pressable>;
          })}
          <NuriTextInput testID="community-report-note" accessibilityLabel={c("补充说明（可选）", "More detail (optional)")} multiline maxLength={500} editable={!busy} value={note} onChangeText={setNote} placeholder={c("补充说明（可选）", "More detail (optional)")} placeholderTextColor="#918896" style={{ minHeight: 72, borderRadius: 18, borderWidth: 1, borderColor: "rgba(93,80,96,.25)", backgroundColor: "rgba(255,250,245,.9)", padding: 12, fontSize: 14, lineHeight: 20, color: FINAL_COLOR.ink, textAlignVertical: "top" }} />
          {allowBlock ? <Pressable onPress={() => setBlock(v => !v)} disabled={busy} accessibilityRole="checkbox" accessibilityState={{ checked: block, disabled: busy }} testID="community-report-block" style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12 }}>
            <Image source={block ? require("@/assets/final-flow-20261101/community-checkbox-selected.svg") : require("@/assets/final-flow-20261101/community-checkbox-empty.svg")} style={{ width: 20, height: 20 }} contentFit="contain" accessible={false} />
            <FinalText style={{ flex: 1 }}>{c("同时屏蔽这位家长", "Also block this parent")}</FinalText>
          </Pressable> : null}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <FinalButton small secondary label={c("取消", "Cancel")} disabled={busy} onPress={onClose} />
            <FinalButton small label={c("提交举报", "Report")} disabled={!reason || busy} onPress={() => reason && onSubmit(reason, note.trim(), allowBlock && block)} testID="community-report-submit" />
          </View>
        </ScrollView>
      </FinalSurface>
    </BlurView>
  </Modal>;
}
