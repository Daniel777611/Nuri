import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Modal, PanResponder, Platform, Pressable, StatusBar, StyleSheet, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import * as WebBrowser from "expo-web-browser";
import YouTubePlayer, { isYouTubeVideoId } from "@/src/components/YouTubePlayer";
import { externalSourceUrl } from "@/src/externalContent";
import { useT } from "@/src/i18n";
import { FinalText } from "@/src/uiuxfinal/Primitives";

export type ChatMediaViewerItem = {
  id: string;
  kind: "image" | "video" | "article" | "product";
  url: string;
  title: string;
  thumbnail?: string;
};

type Props = {
  items: readonly ChatMediaViewerItem[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
};

const copy = {
  en: { close: "Close preview", previous: "Previous media", next: "Next media", image: "Photo", video: "Video", play: "Play video", open: "Open source", failedImage: "This image could not be opened.", failedVideo: "This video could not be played here.", failedLink: "This link could not be opened." },
  "zh-CN": { close: "关闭预览", previous: "上一个媒体", next: "下一个媒体", image: "照片", video: "视频", play: "播放视频", open: "打开来源", failedImage: "无法打开这张图片。", failedVideo: "这个视频暂时无法在这里播放。", failedLink: "暂时无法打开链接。" },
  "zh-TW": { close: "關閉預覽", previous: "上一個媒體", next: "下一個媒體", image: "照片", video: "影片", play: "播放影片", open: "開啟來源", failedImage: "無法開啟這張圖片。", failedVideo: "這部影片暫時無法在這裡播放。", failedLink: "暫時無法開啟連結。" },
} as const;

const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"]);

export function chatMediaYouTubeId(value: unknown): string | null {
  const source = externalSourceUrl(value);
  if (!source || source.length > 4096) return null;
  const url = new URL(source);
  let id = "";
  if (url.hostname === "youtu.be") id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? "";
  else if (youtubeHosts.has(url.hostname)) {
    id = url.pathname === "/watch" ? url.searchParams.get("v") ?? ""
      : /^\/(?:embed|shorts|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? "";
  }
  return isYouTubeVideoId(id) ? id : null;
}

function isDirectVideo(url: string): boolean {
  return /\.(?:mp4|m4v|mov|m3u8)$/i.test(new URL(url).pathname);
}

function imageUrl(value: string): string | null {
  // Existing sent photos are small local data URIs. Limit this path to raster
  // formats; remote images and links still require public HTTPS.
  if (value.length <= 12 * 1024 * 1024 && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  return value.length <= 4096 ? externalSourceUrl(value) : null;
}

export async function openChatMediaLink(value: string): Promise<void> {
  const url = value.length <= 4096 ? externalSourceUrl(value) : null;
  if (!url || AppState.currentState !== "active") throw new Error("Chat media source unavailable");
  if (Platform.OS === "web") await Linking.openURL(url);
  else await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: "close" });
}

function pause(player: VideoPlayer | null) {
  try { player?.pause(); } catch { /* Native player is already released. */ }
}

function DirectVideo({ url, active, onError }: { url: string; active: boolean; onError: (failed: boolean) => void }) {
  const { locale } = useT();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const playerRef = useRef<VideoPlayer | null>(null);
  // Pause before expo-video releases the native object when a gallery item closes.
  useEffect(() => () => { pause(playerRef.current); playerRef.current = null; }, []);
  const player = useVideoPlayer({ uri: url, useCaching: false }, current => {
    current.staysActiveInBackground = false;
    current.showNowPlayingNotification = false;
    current.allowsExternalPlayback = false;
  });
  playerRef.current = player;
  useEffect(() => { if (!active) pause(player); }, [active, player]);
  useEffect(() => {
    const status = player.addListener("statusChange", event => {
      const failedNow = event.status === "error";
      setFailed(failedNow);
      onError(failedNow);
    });
    const playback = player.addListener("playingChange", event => setPlaying(event.isPlaying));
    if (player.status === "error") { setFailed(true); onError(true); }
    return () => { try { status.remove(); playback.remove(); } catch { /* Native player is already released. */ } };
  }, [onError, player]);
  const play = () => {
    if (!active) return;
    try { player.play(); } catch { setFailed(true); onError(true); }
  };
  return <View style={styles.viewerBody}>
    <VideoView testID="chat-media-native-video" player={player} nativeControls
      contentFit="contain" fullscreenOptions={{ enable: false }} allowsPictureInPicture={false}
      allowsVideoFrameAnalysis={false} playsInline style={StyleSheet.absoluteFill} />
    {!playing && !failed ? <View pointerEvents="box-none" style={styles.playOverlay}>
      <Pressable style={styles.playButton} accessibilityRole="button" accessibilityLabel={copy[locale].play}
        testID="chat-media-native-play" onPress={play}>
        <Ionicons name="play" color="white" size={30} />
      </Pressable>
    </View> : null}
  </View>;
}

function GalleryPreview({ item, previous, next, onClose }: {
  item: ChatMediaViewerItem;
  previous?: () => void;
  next?: () => void;
  onClose: () => void;
}) {
  const { locale } = useT();
  const { width } = useWindowDimensions();
  const strings = copy[locale];
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const mounted = useRef(true);
  const [openFailed, setOpenFailed] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", state => setForeground(state === "active"));
    return () => { mounted.current = false; subscription.remove(); };
  }, []);

  const image = item.kind === "image" ? imageUrl(item.url) : null;
  const url = item.kind !== "image" && item.url.length <= 4096 ? externalSourceUrl(item.url) : null;
  const youtubeId = item.kind === "video" ? chatMediaYouTubeId(url) : null;
  const direct = item.kind === "video" && url && isDirectVideo(url) ? url : null;
  const swipe = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => {
      const horizontal = Math.abs(gesture.dx) > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.3;
      return horizontal || gesture.dy > 14 && gesture.dy > Math.abs(gesture.dx) * 1.3;
    },
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dy > 70 && gesture.dy > Math.abs(gesture.dx)) onClose();
      else if (gesture.dx > 50) previous?.();
      else if (gesture.dx < -50) next?.();
    },
  }), [next, onClose, previous]);
  const open = async () => {
    if (!url || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setOpenFailed(false);
    try { await openChatMediaLink(url); }
    catch { if (mounted.current) setOpenFailed(true); }
    finally {
      openingRef.current = false;
      if (mounted.current) setOpening(false);
    }
  };
  const openSource = url ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: opening, busy: opening }}
    testID="chat-media-open-source" disabled={opening} onPress={() => void open()} style={styles.sourceButton}>
    <FinalText style={styles.sourceText}>{strings.open}</FinalText>
    <Ionicons name="arrow-forward-outline" size={17} color="white" />
  </Pressable> : null;

  return <SafeAreaView accessibilityViewIsModal onAccessibilityEscape={onClose} style={styles.screen} testID="chat-media-viewer">
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={strings.close} onPress={onClose} testID="chat-media-close" style={styles.iconButton}>
        <Ionicons name="close" color="white" size={26} />
      </Pressable>
      <FinalText accessibilityRole="header" numberOfLines={1} size={16} style={styles.title}>
        {item.title || (item.kind === "image" ? strings.image : item.kind === "video" ? strings.video : "")}
      </FinalText>
    </View>
    {item.kind === "image" ? <View {...swipe.panHandlers} style={styles.viewerBody}>
      {!image || mediaFailed ? <FinalText style={styles.failure}>{strings.failedImage}</FinalText> : <Image
        testID="chat-media-full-image" source={{ uri: image }} contentFit="contain" cachePolicy="memory" accessible
        accessibilityLabel={item.title || strings.image} onError={() => setMediaFailed(true)} style={StyleSheet.absoluteFill} />}
    </View> : <View style={styles.viewerBody}>
      {youtubeId ? <YouTubePlayer videoId={youtubeId} width={Math.max(1, width - 32)} active={foreground && !opening} /> : null}
      {direct ? <DirectVideo url={direct} active={foreground && !opening} onError={setMediaFailed} /> : null}
      {item.kind === "video" && (!youtubeId && !direct || mediaFailed) ? <FinalText accessibilityLiveRegion="polite" style={styles.failure}>{strings.failedVideo}</FinalText> : null}
      {openSource}
      {openFailed ? <FinalText accessibilityLiveRegion="polite" style={styles.failure}>{strings.failedLink}</FinalText> : null}
    </View>}
    {previous || next ? <View style={styles.navigation}>
      <Pressable accessibilityRole="button" accessibilityLabel={strings.previous} accessibilityState={{ disabled: !previous }}
        testID="chat-media-previous" disabled={!previous} style={[styles.iconButton, !previous && styles.dimmed]} onPress={previous}>
        <Ionicons name="chevron-back" color="white" size={24} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={strings.next} accessibilityState={{ disabled: !next }}
        testID="chat-media-next" disabled={!next} style={[styles.iconButton, !next && styles.dimmed]} onPress={next}>
        <Ionicons name="chevron-forward" color="white" size={24} />
      </Pressable>
    </View> : null}
  </SafeAreaView>;
}

export function ChatMediaViewer({ items, index, onIndexChange, onClose }: Props) {
  const item = index === null ? undefined : items[index];
  if (!item || index === null) return null;
  const isMedia = (entry: ChatMediaViewerItem) => entry.kind === "image" || entry.kind === "video";
  let previous = index - 1;
  while (previous >= 0 && !isMedia(items[previous])) previous -= 1;
  const next = items.findIndex((entry, position) => position > index && isMedia(entry));
  return <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose}>
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <GalleryPreview key={item.id} item={item} onClose={onClose}
        previous={previous >= 0 ? () => onIndexChange(previous) : undefined}
        next={next >= 0 ? () => onIndexChange(next) : undefined} />
    </SafeAreaProvider>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0B0A0D" },
  header: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  title: { flex: 1, color: "white", marginRight: 12 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  viewerBody: { flex: 1, minHeight: 0, alignSelf: "stretch", justifyContent: "center" },
  playOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  playButton: { width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,.66)" },
  sourceButton: { alignSelf: "center", minHeight: 44, paddingHorizontal: 16, marginVertical: 10, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  sourceText: { color: "white" },
  failure: { color: "white", padding: 17, textAlign: "center" },
  navigation: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 12 },
  dimmed: { opacity: .28 },
});
