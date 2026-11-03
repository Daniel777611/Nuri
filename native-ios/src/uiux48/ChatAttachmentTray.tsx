import { Pressable, ScrollView, View } from "react-native";
import { Image } from "expo-image";
import { useT } from "@/src/i18n";
import type { ChatDraftAttachment } from "@/src/chatAttachments";
import { FinalSurface, FinalText } from "@/src/uiuxfinal/Primitives";

export type ChatAttachmentTrayProps = {
  attachments: readonly ChatDraftAttachment[];
  onRemove: (id: string) => void;
  onPreview: (attachment: ChatDraftAttachment) => void;
  disabled?: boolean;
  testID?: string;
};

/** Expand only away from the video play circle. A centered44pt delete target
 * would cover the play center at(36,32), causing accidental deletion. */
export const CHAT_ATTACHMENT_REMOVE_HIT_SLOP = { top: 4, right: 4, bottom: 0, left: 0 } as const;

export function formatChatAttachmentDuration(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "--:--";
  const totalSeconds = Math.floor(durationMs / 1000), minutes = Math.floor(totalSeconds / 60), seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Controlled draft thumbnails only. No picker, decoder, upload, send, storage
 * or playback lifecycle belongs here; preview/remove are explicit callbacks. */
export function ChatAttachmentTray({ attachments, onRemove, onPreview, disabled = false, testID = "chat-attachment-tray" }: ChatAttachmentTrayProps) {
  const { locale } = useT();
  const label = (cn: string, en: string, tw: string) => locale === "en" ? en : locale === "zh-TW" ? tw : cn;
  if (!attachments.length) return null;
  return <ScrollView testID={testID} horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" removeClippedSubviews={false} style={{ height: 72, minWidth: 0, flexShrink: 1 }} contentContainerStyle={{ height: 72, gap: 12, alignItems: "flex-start" }}>
    {attachments.map((attachment, index) => {
      const video = attachment.kind === "video", duration = formatChatAttachmentDuration(attachment.durationMs);
      // A video URI is not an image. Show its supplied real thumbnail when
      // available; otherwise retain the neutral play surface, not sample art.
      const previewSource = attachment.previewSource ?? (!video ? { uri: attachment.image?.previewUri ?? attachment.uri } : undefined);
      const kindLabel = video ? label("视频", "video", "影片") : label("照片", "photo", "照片");
      const previewLabel = label("预览", "Preview ", "預覽") + kindLabel + ` ${index + 1}`;
      const removeLabel = label("移除", "Remove ", "移除") + kindLabel + ` ${index + 1}`;
      return <View key={attachment.id} testID={`${testID}-item-${attachment.id}`} style={{ width: 72, height: 72, flexShrink: 0, borderRadius: 12, overflow: "hidden", backgroundColor: "rgba(255,250,242,.64)", opacity: disabled ? .5 : 1 }}>
        <Pressable testID={`${testID}-preview-${attachment.id}`} accessibilityRole="button" accessibilityLabel={previewLabel} accessibilityState={{ disabled }} accessibilityActions={[{ name: "remove", label: removeLabel }]} onAccessibilityAction={event => { if (!disabled && event.nativeEvent.actionName === "remove") onRemove(attachment.id); }} disabled={disabled} onPress={() => { if (!disabled) onPreview(attachment); }} style={{ width: 72, height: 72 }}>
          {previewSource ? <Image testID={`${testID}-thumbnail-${attachment.id}`} source={previewSource} style={{ width: 72, height: 72, borderRadius: 12 }} contentFit="cover" cachePolicy="memory" accessible={false} accessibilityElementsHidden /> : null}
          {video ? <>
            <View testID={`${testID}-play-${attachment.id}`} pointerEvents="none" style={{ position: "absolute", left: 21, top: 17, width: 30, height: 30, borderRadius: 15, backgroundColor: "rgba(227,214,237,.96)", alignItems: "center", justifyContent: "center" }}>
              <Image source={require("@/assets/final-flow-20261101/chat-attachment-play-20.svg")} style={{ width: 20, height: 20 }} contentFit="contain" accessible={false} accessibilityElementsHidden />
            </View>
            <FinalSurface testID={`${testID}-duration-${attachment.id}`} radius={6} surfaceColor="rgba(255,250,242,.64)" style={{ position: "absolute", top: 50, right: 4, width: 42, height: 18 }} contentStyle={{ height: 18, alignItems: "center", justifyContent: "center" }}>
              <FinalText size={10} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={.8} style={{ width: duration.length > 4 ? 34 : 22, lineHeight: 14, fontWeight: "500", textAlign: "center" }}>{duration}</FinalText>
            </FinalSurface>
          </> : null}
        </Pressable>
        <Pressable testID={`${testID}-remove-${attachment.id}`} accessibilityRole="button" accessibilityLabel={removeLabel} accessibilityState={{ disabled }} disabled={disabled} hitSlop={CHAT_ATTACHMENT_REMOVE_HIT_SLOP} onPress={() => { if (!disabled) onRemove(attachment.id); }} style={{ position: "absolute", top: 4, right: 4, width: 24, height: 24 }}>
          {/* The24pt visual and28pt safe hit extent intentionally do not claim
              44pt. Screen readers can also remove from the full72pt preview. */}
          <FinalSurface radius={12} surfaceColor="rgba(255,250,242,.64)" style={{ width: 24, height: 24 }} contentStyle={{ height: 24, alignItems: "center", justifyContent: "center" }}>
            <Image source={require("@/assets/final-flow-20261101/chat-attachment-remove-20.svg")} style={{ width: 20, height: 20 }} contentFit="contain" accessible={false} accessibilityElementsHidden />
          </FinalSurface>
        </Pressable>
      </View>;
    })}
  </ScrollView>;
}
