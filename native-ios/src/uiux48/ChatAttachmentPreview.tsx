import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import { useT } from "@/src/i18n";
import type { ChatDraftAttachment } from "@/src/chatAttachments";
import { FinalText } from "@/src/uiuxfinal/Primitives";
import { ButtonBackdrop } from "@/src/uiuxfinal/ButtonMaterial";

export type ChatAttachmentPreviewProps = {
  attachment: ChatDraftAttachment | null;
  onClose: () => void;
};

function pauseSafely(player: VideoPlayer | null) {
  // Expo may already have released a SharedObject during refresh/native
  // teardown. Closing a preview must remain safe in either cleanup order.
  try { player?.pause(); } catch { /* No private URI/error details are logged. */ }
}

function PreviewFrame({ children, video, onClose, onDismiss }: { children: ReactNode; video: boolean; onClose: () => void; onDismiss?: () => void }) {
  const { locale } = useT();
  const title = locale === "en" ? video ? "Video preview" : "Photo preview" : locale === "zh-TW" ? video ? "影片預覽" : "照片預覽" : video ? "视频预览" : "照片预览";
  const close = locale === "en" ? "Close preview" : locale === "zh-TW" ? "關閉預覽" : "关闭预览";
  return <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} onDismiss={onDismiss}>
    <SafeAreaView testID="chat-attachment-preview" edges={["top", "bottom", "left", "right"]} onAccessibilityEscape={onClose} style={{ flex: 1, backgroundColor: "black" }}>
      <View style={{ height: 52, paddingHorizontal: 12, flexDirection: "row", alignItems: "center" }}>
        <FinalText size={16} accessibilityRole="header" style={{ flex: 1, color: "white", paddingLeft: 8 }}>{title}</FinalText>
        <Pressable testID="chat-attachment-preview-close" accessibilityRole="button" accessibilityLabel={close} onPress={onClose} style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Image source={require("@/assets/final-flow-20261101/chat-attachment-remove-20.svg")} style={{ width: 20, height: 20 }} tintColor="white" contentFit="contain" accessible={false} accessibilityElementsHidden />
        </Pressable>
      </View>
      <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
    </SafeAreaView>
  </Modal>;
}

function ImagePreview({ attachment, onClose }: { attachment: ChatDraftAttachment; onClose: () => void }) {
  const { locale } = useT(), [failed, setFailed] = useState(false);
  return <PreviewFrame video={false} onClose={onClose}>
    {failed ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}><FinalText style={{ color: "white", textAlign: "center" }}>{locale === "en" ? "This photo could not be opened." : locale === "zh-TW" ? "無法開啟這張照片。" : "无法打开这张照片。"}</FinalText></View> : <Image testID="chat-attachment-preview-image" source={{ uri: attachment.image?.previewUri ?? attachment.uri }} contentFit="contain" cachePolicy="memory" style={{ width: "100%", height: "100%" }} onError={() => setFailed(true)} accessibilityLabel={locale === "en" ? "Selected photo" : locale === "zh-TW" ? "已選照片" : "已选照片"} accessible />}
  </PreviewFrame>;
}

function VideoPreview({ attachment, onClose }: { attachment: ChatDraftAttachment; onClose: () => void }) {
  const { locale } = useT(), [playing, setPlaying] = useState(false), [failed, setFailed] = useState(false);
  const playerRef = useRef<VideoPlayer | null>(null);
  // Register pause cleanup before useVideoPlayer registers its auto-release.
  // A new keyed child is mounted for a different id/URI or media kind.
  useEffect(() => () => { pauseSafely(playerRef.current); playerRef.current = null; }, []);
  const player = useVideoPlayer({ uri: attachment.uri, useCaching: false }, created => {
    created.loop = false;
    created.staysActiveInBackground = false;
    created.showNowPlayingNotification = false;
    created.allowsExternalPlayback = false;
    created.pause();
  });
  playerRef.current = player;
  useEffect(() => {
    let active = true;
    const state = AppState.addEventListener("change", next => { if (next !== "active") { pauseSafely(player); if (active) setPlaying(false); } });
    const playback = player.addListener("playingChange", event => { if (active) setPlaying(event.isPlaying); });
    const status = player.addListener("statusChange", event => { if (active) { setFailed(event.status === "error"); if (event.status === "error") { pauseSafely(player); setPlaying(false); } } });
    return () => {
      active = false;
      state.remove();
      try { playback.remove(); status.remove(); } catch { /* SharedObject already disposed. */ }
    };
  }, [player]);
  const close = () => { pauseSafely(player); onClose(); };
  const play = () => {
    try { setFailed(false); player.play(); setPlaying(true); } catch { setFailed(true); setPlaying(false); }
  };
  return <PreviewFrame video onClose={close} onDismiss={() => pauseSafely(player)}>
    <VideoView testID="chat-attachment-preview-video" player={player} nativeControls contentFit="contain" fullscreenOptions={{ enable: false }} allowsPictureInPicture={false} startsPictureInPictureAutomatically={false} allowsVideoFrameAnalysis={false} playsInline style={{ width: "100%", height: "100%" }} />
    {!playing ? <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 16 }}>
      {failed ? <FinalText accessibilityLiveRegion="polite" style={{ color: "white", textAlign: "center", paddingHorizontal: 24 }}>{locale === "en" ? "This video could not be played." : locale === "zh-TW" ? "無法播放這部影片。" : "无法播放这个视频。"}</FinalText> : null}
      <Pressable testID="chat-attachment-preview-play" accessibilityRole="button" accessibilityLabel={locale === "en" ? "Play video" : locale === "zh-TW" ? "播放影片" : "播放视频"} onPress={play} style={{ width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" }}>
        <ButtonBackdrop testID="chat-attachment-preview-play-material" color="rgba(255,255,255,.2)" radius={32} blurRadius={40}/>
        <Image source={require("@/assets/final-flow-20261101/chat-attachment-play-20.svg")} style={{ width: 20, height: 20 }} tintColor="white" contentFit="contain" accessible={false} accessibilityElementsHidden />
      </Pressable>
    </View> : null}
  </PreviewFrame>;
}

/** Controlled local media preview. The caller clears attachment on account
 * changes; null unmounts the child and releases any native video resource. */
export function ChatAttachmentPreview({ attachment, onClose }: ChatAttachmentPreviewProps) {
  if (!attachment) return null;
  const key = attachment.id + ":" + attachment.uri;
  return attachment.kind === "video" ? <VideoPreview key={key} attachment={attachment} onClose={onClose} /> : <ImagePreview key={key} attachment={attachment} onClose={onClose} />;
}
