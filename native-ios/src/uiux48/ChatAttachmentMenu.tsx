import { Pressable, View, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { useT } from "@/src/i18n";
import type { ChatAttachmentAnchor } from "@/src/chatAttachments";
import { FinalSurface } from "@/src/uiuxfinal/Primitives";

export type ChatAttachmentMenuProps = {
  onCamera: () => void;
  onLibrary: () => void;
  onDismiss: () => void;
  /** Bounds in the containing overlay's coordinate space. */
  anchor?: ChatAttachmentAnchor;
  testID?: string;
};

export function chatAttachmentMenuPosition(anchor?: ChatAttachmentAnchor): ViewStyle {
  if (!anchor || ![anchor.x, anchor.y, anchor.width, anchor.height].every(Number.isFinite)) {
    return { position: "absolute", left: 0, bottom: 12 };
  }
  // Figma199:13638: menu656..760, plus772..832; keep the12pt gap.
  return { position: "absolute", left: Math.max(0, anchor.x + (anchor.width - 60) / 2), top: Math.max(0, anchor.y - 104 - 12) };
}

/** Menu body only. The caller owns the transparent Modal, outside-tap/back
 * dismissal and the iOS transition from that Modal to the system media picker.
 * Action callbacks do not grant permissions or pretend an upload occurred. */
export function ChatAttachmentMenu({ onCamera, onLibrary, onDismiss, anchor, testID = "chat-attachment-menu" }: ChatAttachmentMenuProps) {
  const { locale } = useT();
  const labels = locale === "en" ? ["Camera", "Photo library"] : locale === "zh-TW" ? ["相機", "相簿"] : ["相机", "相册"];
  return <View testID={testID} onAccessibilityEscape={onDismiss} accessibilityViewIsModal style={chatAttachmentMenuPosition(anchor)}>
    <FinalSurface radius={24} surfaceColor="rgba(255,250,242,.64)" style={{ width: 60, height: 104 }} contentStyle={{ height: 104, padding: 8, alignItems: "center", justifyContent: "center" }}>
      <Pressable testID={`${testID}-camera`} accessibilityRole="button" accessibilityLabel={labels[0]} onPress={onCamera} style={{ width: 44, height: 44, borderRadius: 16, alignItems: "center", justifyContent: "center" }}>
        <Image source={require("@/assets/final-flow-20261101/chat-attachment-camera-20.svg")} style={{ width: 20, height: 20 }} contentFit="contain" accessible={false} accessibilityElementsHidden />
      </Pressable>
      <Pressable testID={`${testID}-library`} accessibilityRole="button" accessibilityLabel={labels[1]} onPress={onLibrary} style={{ width: 44, height: 44, borderRadius: 16, alignItems: "center", justifyContent: "center" }}>
        <Image source={require("@/assets/final-flow-20261101/chat-attachment-album-20.svg")} style={{ width: 20, height: 20 }} contentFit="contain" accessible={false} accessibilityElementsHidden />
      </Pressable>
    </FinalSurface>
  </View>;
}
