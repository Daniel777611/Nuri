import { useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";

import { ChatMediaViewer, openChatMediaLink } from "./ChatMediaViewer";
import { useAccountScope, useAccountState } from "@/src/useAccountState";
import { useT } from "@/src/i18n";
import type { ChatMediaItem, readChatMedia } from "@/src/replyMedia";
import { FinalText } from "@/src/uiuxfinal/Primitives";
import { useNuriTheme } from "@/src/uiux48/Theme";

const COPY = {
  en: { collection: "Media and links", image: "Photo", video: "Video", article: "Article", product: "Product", unavailable: "Could not open this link. Try again." },
  "zh-CN": { collection: "媒体和链接", image: "照片", video: "视频", article: "文章", product: "商品", unavailable: "暂时无法打开链接，请重试。" },
  "zh-TW": { collection: "媒體和連結", image: "照片", video: "影片", article: "文章", product: "商品", unavailable: "暫時無法開啟連結，請再試一次。" },
} as const;

const ICON = { image: "image-outline", video: "play", article: "document-text-outline", product: "bag-handle-outline" } as const;

function MediaThumbnail({ item, width, onPress }: { item: ChatMediaItem; width: number; onPress: () => void }) {
  const { locale } = useT();
  const theme = useNuriTheme();
  const [failedURI, setFailedURI] = useState<string>();
  const label = COPY[locale][item.kind];
  const showThumbnail = !!item.thumbnail && failedURI !== item.thumbnail;
  const detail = [item.source, item.detail].filter(Boolean).join(" · ");
  return (
    <Pressable
      style={({ pressed }) => [styles.tile, { width, backgroundColor: theme.glass, opacity: pressed ? .8 : 1 }]}
      accessibilityRole={item.kind === "article" || item.kind === "product" ? "link" : "button"}
      accessibilityLabel={[label, item.title, detail, item.badge, item.stock].filter(Boolean).join(", ")}
      onPress={onPress}
      testID="chat-media-thumbnail"
      accessible
    >
      <View style={[styles.thumbnail, { height: width * .72, backgroundColor: theme.composer }]}>
        {showThumbnail ? (
          <Image
            accessible={false}
            source={{ uri: item.thumbnail }}
            style={StyleSheet.absoluteFill}
            cachePolicy={item.thumbnail?.startsWith("data:") ? "none" : "memory"}
            recyclingKey={item.id}
            contentFit={item.kind === "product" ? "contain" : "cover"}
            onError={() => setFailedURI(item.thumbnail)}
          />
        ) : null}
        {item.kind === "video" ? (
          <View style={styles.play}><Ionicons name="play" size={22} color="white" /></View>
        ) : !showThumbnail ? (
          <Ionicons name={ICON[item.kind]} size={30} color={theme.secondary} />
        ) : null}
        {item.kind === "article" || item.kind === "product" ? (
          <View style={[styles.type, { backgroundColor: theme.composer }]}>
            <FinalText style={[styles.typeText, { color: theme.ink }]}>{label}</FinalText>
          </View>
        ) : null}
      </View>
      {item.kind === "image" ? null : (
        <View style={styles.caption}>
          <FinalText style={[styles.title, { color: theme.ink }]} numberOfLines={2}>{item.title || label}</FinalText>
          {detail ? <FinalText style={[styles.detail, { color: theme.secondary }]} numberOfLines={2}>{detail}</FinalText> : null}
          {item.badge ? <FinalText style={[styles.badge, { color: theme.ink }]} numberOfLines={2}>{item.badge}</FinalText> : null}
          {item.stock ? <FinalText style={[styles.detail, { color: theme.secondary }]} numberOfLines={2}>{item.stock}</FinalText> : null}
        </View>
      )}
    </Pressable>
  );
}

export function ChatMediaCarousel({ items, comparison, onOpen }: {
  items: readonly ChatMediaItem[];
  comparison: ReturnType<typeof readChatMedia>["comparison"];
  onOpen?: () => void;
}) {
  const { locale } = useT();
  const theme = useNuriTheme();
  const router = useRouter();
  const { capture, current } = useAccountScope();
  const { width } = useWindowDimensions();
  const [active, setActive] = useAccountState<string | null>(null);
  const [error, setError] = useAccountState(false);
  const viewerItems = items.filter((item) => !item.inNuri && (item.kind === "image" || item.kind === "video"));
  const index = active === null ? -1 : viewerItems.findIndex((item) => item.id === active);
  const copy = COPY[locale];
  const cardWidth = Math.min(220, Math.max(128, Math.round(width * .49)));

  function open(item: ChatMediaItem) {
    const ticket = capture();
    if (ticket === null) return;
    setError(false);
    onOpen?.();
    if (item.inNuri) {
      router.push({ pathname: item.inNuri.page, params: { id: item.inNuri.id } });
    } else if (item.kind === "image" || item.kind === "video") {
      setActive(item.id);
    } else {
      void openChatMediaLink(item.url).catch(() => { if (current(ticket)) setError(true); });
    }
  }

  return (
    <View style={styles.gallery} testID="chat-media-carousel">
      {comparison ? (
        <View style={styles.notes}>
          <FinalText accessibilityRole="header" style={[styles.title, { color: theme.ink }]}>{comparison.heading}</FinalText>
          <FinalText style={[styles.detail, { color: theme.secondary }]}>{comparison.checked}</FinalText>
        </View>
      ) : null}
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        directionalLockEnabled
        decelerationRate="fast"
        snapToInterval={cardWidth + 8}
        contentContainerStyle={styles.rail}
        accessibilityLabel={copy.collection}
        testID="chat-media-scroll"
      >
        {items.map((item) => <MediaThumbnail key={item.id} item={item} width={cardWidth} onPress={() => open(item)} />)}
      </ScrollView>
      {comparison || error ? (
        <View style={styles.notes}>
          {comparison?.notice.map((note) => <FinalText key={note} style={[styles.detail, { color: theme.secondary }]}>{note}</FinalText>)}
          {error ? <FinalText accessibilityLiveRegion="polite" style={[styles.detail, { color: theme.ink }]}>{copy.unavailable}</FinalText> : null}
        </View>
      ) : null}
      {index >= 0 ? <ChatMediaViewer items={viewerItems} index={index} onIndexChange={(next) => setActive(viewerItems[next]?.id ?? null)} onClose={() => setActive(null)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  gallery: { alignSelf: "stretch", minWidth: 0, gap: 6, marginTop: 6 },
  rail: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 2 },
  tile: { borderRadius: 16, overflow: "hidden" },
  thumbnail: { justifyContent: "center", alignItems: "center" },
  play: { backgroundColor: "rgba(30,23,35,0.8)", width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  type: { position: "absolute", left: 8, top: 8, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8 },
  typeText: { fontSize: 11, fontWeight: "600" },
  caption: { gap: 4, paddingHorizontal: 11, paddingVertical: 10 },
  notes: { gap: 3, paddingHorizontal: 2 },
  title: { fontSize: 14, lineHeight: 19, fontWeight: "600" },
  detail: { fontSize: 12, lineHeight: 17 },
  badge: { fontSize: 12, lineHeight: 17, fontWeight: "700" },
});
