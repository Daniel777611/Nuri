import { useRef } from "react";
import { Linking, Modal, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useT } from "@/src/i18n";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { SAFETY_CONTACT, SAFETY_REASONS, safetyReportMailto, type SafetyReason } from "@/src/contentSafety";
import { AuthFrame, ChoiceChip, NuriButton, NuriField, NuriText } from "./Primitives";

const reasonCopy: Record<SafetyReason, [string, string, string]> = {
  unsafe: ["危险或有害建议", "危險或有害建議", "Dangerous or harmful advice"],
  sexual: ["色情内容或儿童安全", "色情內容或兒童安全", "Sexual content or child safety"],
  hate: ["骚扰、仇恨或威胁", "騷擾、仇恨或威脅", "Harassment, hate or threats"],
  privacy: ["个人信息或隐私", "個人資訊或隱私", "Personal information or privacy"],
  other: ["其他内容问题", "其他內容問題", "Other content concern"],
};

export function SafetyReportCard({ conversationId, messageId, onClose }: {
  conversationId?: string;
  messageId?: string;
  onClose: () => void;
}) {
  const { locale } = useT();
  const { capture, current } = useAccountScope();
  const copy = (cn: string, tw: string, en: string) => locale === "en" ? en : locale === "zh-TW" ? tw : cn;
  const [reason, setReason] = useAccountState<SafetyReason>("unsafe");
  const [note, setNote] = useAccountState("");
  const [includeReferences, setIncludeReferences] = useAccountState(false);
  const [status, setStatus] = useAccountState<"idle" | "opened" | "error">("idle");
  const [busy, setBusy] = useAccountState(false);
  const opening = useRef(false);
  const openDraft = async () => {
    const ticket = capture();
    if (ticket === null || opening.current) return;
    opening.current = true;
    setBusy(true);
    setStatus("idle");
    try {
      await Linking.openURL(safetyReportMailto({ reason, note, includeReferences, conversationId, messageId }));
      if (current(ticket)) setStatus("opened");
    } catch {
      if (current(ticket)) setStatus("error");
    } finally {
      opening.current = false;
      if (current(ticket)) setBusy(false);
    }
  };
  return <Modal transparent animationType="fade" onRequestClose={onClose} visible>
    <View style={{ flex: 1, backgroundColor: "rgba(20,16,29,0.45)" }}>
      <SafeAreaView style={{ flex: 1 }}>
            <AuthFrame contentGap={16} testID="safety-report-card">
              <NuriText style={{ fontSize: 20, fontWeight: "500" }}>{copy("报告不当内容", "回報不當內容", "Report inappropriate content")}</NuriText>
              <NuriText secondary>{copy("请选择原因。邮件由你检查并发送；Nuri不会自动发送，也无法确认送达。请勿加入密码、儿童照片或不必要的个人信息。", "請選擇原因。郵件由你檢查並傳送；Nuri 不會自動傳送，也無法確認送達。請勿加入密碼、兒童照片或不必要的個人資訊。", "Choose a concern. You review and send the email; Nuri does not send it automatically or confirm delivery. Do not include passwords, children's photos or unnecessary personal information.")}</NuriText>
              {SAFETY_REASONS.map(value => <ChoiceChip key={value} label={copy(...reasonCopy[value])} selected={reason === value} onPress={() => { setReason(value); setStatus("idle"); }} testID={`safety-reason-${value}`} />)}
              <NuriField label={copy("补充说明（选填，最多500字）", "補充說明（選填，最多500字）", "Details (optional, up to 500 characters)")} value={note} onChangeText={setNote} multiline maxLength={500} style={{height:112,textAlignVertical:"top",paddingTop:12}} testID="safety-note" />
              <ChoiceChip label={copy("允许附上对话和回复编号（不含原文）", "允許附上對話和回覆編號（不含原文）", "Include conversation and response references (not their text)")} selected={includeReferences} onPress={() => setIncludeReferences(value => !value)} testID="safety-include-references" />
              <NuriText secondary>{SAFETY_CONTACT}</NuriText>
              {status !== "idle" ? <NuriText accessibilityLiveRegion="polite" testID="safety-report-status">{status === "opened"
                ? copy("已请求打开邮件草稿，请在邮件应用中检查并发送。这不是送达确认。", "已請求開啟郵件草稿，請在郵件 App 中檢查並傳送。這不是送達確認。", "The mail draft was requested. Review and send it in your mail app. This is not delivery confirmation.")
                : copy("无法打开邮件应用。你可以自行联系上方邮箱；本次未发送举报。", "無法開啟郵件 App。你可以自行聯絡上方信箱；此次未傳送回報。", "The mail app could not be opened. Contact the address above directly; this report was not sent.")}</NuriText> : null}
              <NuriButton label={copy("打开邮件草稿", "開啟郵件草稿", "Open mail draft")} onPress={() => void openDraft()} busy={busy} disabled={busy} testID="safety-open-draft" />
              <NuriButton secondary label={copy("关闭", "關閉", "Close")} onPress={onClose} disabled={busy} testID="safety-close" />
            </AuthFrame>
      </SafeAreaView>
    </View>
  </Modal>;
}
