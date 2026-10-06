// Home's second daily card: one YouTube video, fixed for the day.
//
// Sits beside the featured post in the 每日精选 carousel. The video's own
// thumbnail is the card, so it reads as "a video" before a word is read; the
// title says what it is about and the keyword line says why it is here.
// Tapping opens the detail screen (app/daily-video.tsx), which plays it.
import { ImageBackground, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

import type { DailyVideoCard as Card } from "@/src/api";
import { useT } from "@/src/i18n";
import type { DailyPostStatus } from "@/src/components/DailyPostCard";

/** "和你聊过的「躺地哭闹」有关" / "适合 10个月 · 睡眠" */
export function dailyVideoReason(
  t: (s: string, v?: Record<string, string | number>) => string,
  card: Card,
): string {
  const concern = (card.concern || "").trim();
  if (!concern) return t("为你挑的育儿视频");
  return card.basis === "conversation"
    ? t("和你聊过的「{concern}」有关", { concern })
    : t("适合 {concern}", { concern });
}

export default function DailyVideoCard({
  width,
  status,
  card,
  onPress,
  onRetry,
}: {
  width: number;
  status: DailyPostStatus;
  card: Card | null;
  onPress: (card: Card) => void;
  onRetry: () => void;
}) {
  const { t } = useT();

  if (status === "loading" || status === "pending") {
    return (
      <View style={styles.wrap} accessibilityLiveRegion="polite" testID="home-daily-video-loading">
        <LinearGradient
          colors={["#3A2F5A", "#5B4A8A"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.card, styles.padded, { width }]}
        >
          <View style={[styles.skeleton, { width: 96, height: 28 }]} />
          <View style={[styles.skeleton, { width: "80%", height: 22, marginTop: 18 }]} />
          <View style={{ flex: 1 }} />
          <Text style={styles.waitText}>{t("正在为你找相关的育儿视频…")}</Text>
        </LinearGradient>
      </View>
    );
  }

  if (status !== "ready" || !card) {
    const failed = status === "error";
    return (
      <View style={styles.wrap}>
        <Pressable
          onPress={failed ? onRetry : undefined}
          disabled={!failed}
          style={{ width }}
          accessibilityRole={failed ? "button" : undefined}
          testID="home-daily-video-empty"
        >
          <LinearGradient
            colors={["#3A2F5A", "#5B4A8A"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.card, styles.padded]}
          >
            <View style={styles.tagPill}>
              <Text style={styles.tagText}>{t("精选视频")}</Text>
            </View>
            <Text style={styles.title} numberOfLines={3}>
              {failed
                ? t("今天的视频暂时没加载出来，点一下再试试。")
                : t("今天还没找到合适的视频。和NURI多聊聊你的情况，明天会更贴近你。")}
            </Text>
          </LinearGradient>
        </Pressable>
      </View>
    );
  }

  const title = card.display_title || card.title;
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => onPress(card)}
        style={{ width }}
        accessibilityRole="button"
        accessibilityLabel={`${t("精选视频")}。${title}。${card.key_points || ""}${dailyVideoReason(t, card)}`}
        testID="home-daily-video-card"
      >
        <ImageBackground
          source={{ uri: card.thumbnail_url }}
          style={styles.card}
          imageStyle={styles.image}
          resizeMode="cover"
        >
          {/* Dark at the top and bottom so white text stays legible on any thumbnail. */}
          <LinearGradient
            colors={["rgba(20,14,40,0.78)", "rgba(20,14,40,0.25)", "rgba(20,14,40,0.88)"]}
            locations={[0, 0.45, 1]}
            style={[StyleSheet.absoluteFill, styles.padded]}
          >
            <View style={styles.tagRow}>
              <View style={styles.tagPill}>
                <Ionicons name="logo-youtube" size={13} color="#FF3B30" />
                <Text style={styles.tagText}>{t("精选视频")}</Text>
              </View>
            </View>
            <Text style={styles.title} numberOfLines={2} testID="home-daily-video-title">
              {title}
            </Text>
            {card.key_points ? (
              <Text style={styles.points} numberOfLines={2} testID="home-daily-video-points">
                {card.key_points}
              </Text>
            ) : null}
            <View style={{ flex: 1 }} />
            <View style={styles.footer}>
              <Text style={styles.reason} numberOfLines={2}>{dailyVideoReason(t, card)}</Text>
              <View style={styles.play}>
                <Ionicons name="play" size={22} color="#3A2F5A" style={{ marginLeft: 3 }} />
              </View>
            </View>
          </LinearGradient>
        </ImageBackground>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingLeft: 17 },
  card: {
    height: 236,
    borderRadius: 36,
    overflow: "hidden",
    backgroundColor: "#3A2F5A",
    shadowColor: "#000000",
    shadowOffset: { width: -2, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 5,
    elevation: 2,
  },
  image: { borderRadius: 36 },
  padded: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 10 },
  tagRow: { flexDirection: "row" },
  tagPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 36,
    backgroundColor: "#FFF9F3",
  },
  tagText: { color: "#261B45", fontFamily: "NotoSansSC_400Regular", fontSize: 12, lineHeight: 18 },
  title: {
    marginTop: 14,
    color: "#FFFFFF",
    fontFamily: "NotoSansSC_700Bold",
    fontSize: 20,
    lineHeight: 28,
  },
  points: {
    marginTop: 6,
    color: "rgba(255,255,255,0.9)",
    fontFamily: "NotoSansSC_400Regular",
    fontSize: 13,
    lineHeight: 19,
  },
  footer: { minHeight: 55, flexDirection: "row", alignItems: "center", gap: 12 },
  reason: {
    flex: 1,
    color: "rgba(255,255,255,0.92)",
    fontFamily: "NotoSansSC_700Bold",
    fontSize: 13,
    lineHeight: 19,
  },
  play: {
    width: 55,
    height: 55,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  skeleton: { borderRadius: 999, backgroundColor: "rgba(255,255,255,0.25)" },
  waitText: { color: "rgba(255,255,255,0.85)", fontFamily: "NotoSansSC_600SemiBold", fontSize: 13, paddingBottom: 12 },
});
