// Report an AI reply: pick a reason, optionally say more, submit. Google
// Play's AI-generated content policy requires this in-app flag; the report
// lands in chat_message_reports for review in /admin.

import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import type { ChatReportReason } from "@/src/api";
import { useT } from "@/src/i18n";
import { colors } from "@/src/theme";
import { GlassSurface, NuriButton, NuriField, NuriText } from "@/src/uiux48/Primitives";

const REASONS: { key: ChatReportReason; label: string }[] = [
  { key: "harmful", label: "可能造成伤害或不安全" },
  { key: "offensive", label: "冒犯、歧视或不当内容" },
  { key: "misleading", label: "错误或误导性信息" },
  { key: "other", label: "其他问题" },
];

export function ChatReportSheet({
  visible,
  busy,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: ChatReportReason, note: string) => void;
}) {
  const { t } = useT();
  const [reason, setReason] = useState<ChatReportReason | null>(null);
  const [note, setNote] = useState("");

  // Each report starts blank, so a second report never inherits the first.
  useEffect(() => {
    if (visible) { setReason(null); setNote(""); }
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop} testID="chat-report-sheet">
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={t("取消")} onPress={busy ? undefined : onClose} />
        <GlassSurface contentStyle={styles.card}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <NuriText role="H2">{t("举报这条回复")}</NuriText>
            <NuriText secondary>{t("请选择原因。我们会审核被举报的 AI 回复，并用于改进内容安全。")}</NuriText>
            {REASONS.map((item) => {
              const selected = reason === item.key;
              return (
                <Pressable
                  key={item.key}
                  onPress={() => setReason(item.key)}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: busy }}
                  style={[styles.reason, selected && styles.reasonSelected]}
                  testID={`chat-report-reason-${item.key}`}
                >
                  <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.brand : colors.onSurfaceTertiary} />
                  <NuriText style={{ flex: 1 }}>{t(item.label)}</NuriText>
                </Pressable>
              );
            })}
            <NuriField
              label={t("补充说明（可选）")}
              value={note}
              onChangeText={setNote}
              maxLength={500}
              multiline
              editable={!busy}
              style={{ minHeight: 72, textAlignVertical: "top" }}
              testID="chat-report-note"
            />
            <NuriButton label={t("提交举报")} disabled={!reason || busy} busy={busy} onPress={() => reason && onSubmit(reason, note)} testID="chat-report-submit" />
            <NuriButton secondary label={t("取消")} disabled={busy} onPress={onClose} testID="chat-report-cancel" />
          </ScrollView>
        </GlassSurface>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "center", paddingHorizontal: 24, backgroundColor: "rgba(20,16,24,.28)" },
  card: { padding: 24, maxHeight: 560 },
  reason: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingHorizontal: 12, borderRadius: 14 },
  reasonSelected: { backgroundColor: "rgba(108, 79, 214, 0.12)" },
});
