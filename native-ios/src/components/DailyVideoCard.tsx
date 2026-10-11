// Home's second daily card: one YouTube video, fixed for the day.
//
// This is a NURI-owned link card, not a copy of YouTube's video content.
// An original user-topic headline accompanies the backend's brief AI search
// preview. Watching/verification stays on YouTube; no source assets are copied.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

import type { DailyVideoCard as Card } from "@/src/api";
import { useT } from "@/src/i18n";
import { nuriResourceGuide } from "@/src/nuriResourceGuide";
import { resourceSummary } from "@/src/resourceSummary";
import type { DailyPostStatus } from "@/src/components/DailyPostCard";

export default function DailyVideoCard({
  width,
  status,
  card,
  onPress,
  onRetry,
  failureText,
  failureAction,
}: {
  width: number;
  status: DailyPostStatus;
  card: Card | null;
  onPress: (card: Card) => void;
  onRetry: () => void;
  failureText?: string;
  failureAction?: string;
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
                ? failureText || t("今天的视频暂时没加载出来，点一下再试试。")
                : t("今天还没找到合适的视频。和NURI多聊聊你的情况，明天会更贴近你。")}
            </Text>
            {failed ? <Text style={styles.waitText}>{failureAction || t("重试")}</Text> : null}
          </LinearGradient>
        </Pressable>
      </View>
    );
  }

  const guide = nuriResourceGuide({ concern: card.concern }, t);
  const summary = resourceSummary(card.key_points, { limit: card.locale === "en" ? 280 : 90, locale: card.locale })
    || resourceSummary(card.summary, { limit: card.locale === "en" ? 750 : 190, locale: card.locale });
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => onPress(card)}
        style={{ width }}
        accessibilityRole="button"
        accessibilityLabel={`${t("AI 检索摘要")}。${guide.headline}。${summary || t("暂无可用摘要，请到原站查看。")}。${t("查看摘要与导读")}`}
        testID="home-daily-video-card"
      >
        <LinearGradient colors={["#3A2F5A", "#5B4A8A"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.card, styles.padded]}>
          <View style={styles.tagPill}>
            <Ionicons name="videocam-outline" size={16} color="#4C368C" />
            <Text style={styles.tagText}>{t("精选视频")}</Text>
          </View>
          <Text style={styles.title} numberOfLines={2} testID="home-daily-video-external-title">{guide.headline}</Text>
          <Text style={styles.reason} numberOfLines={2} ellipsizeMode="tail" testID="home-daily-video-external-notice">{summary || t("暂无可用摘要，请到原站查看。")}</Text>
          <Text style={styles.disclosure} numberOfLines={1} testID="home-daily-video-summary-disclosure">{t("AI 检索摘要 · 非完整视频摘要")}</Text>
          <View style={styles.footer}>
            <Text style={styles.openText}>{t("查看摘要与导读")}</Text>
            <View style={styles.open}>
              <Ionicons name="arrow-forward" size={20} color="#3A2F5A" />
            </View>
          </View>
        </LinearGradient>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingLeft: 17 },
  card: {
    minHeight: 264,
    borderRadius: 36,
    overflow: "hidden",
    backgroundColor: "#3A2F5A",
    shadowColor: "#000000",
    shadowOffset: { width: -2, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 5,
    elevation: 2,
  },
  padded: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 10 },
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
  footer: { flex: 1, minHeight: 40, flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 10, paddingBottom: 6 },
  reason: {
    color: "rgba(255,255,255,0.85)",
    fontFamily: "NotoSansSC_400Regular",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
  },
  disclosure: { color: "rgba(255,255,255,0.8)", fontFamily: "NotoSansSC_400Regular", fontSize: 10, lineHeight: 15, marginTop: 5 },
  openText: { flex: 1, color: "#FFFFFF", fontFamily: "NotoSansSC_700Bold", fontSize: 13, lineHeight: 20, paddingBottom: 8 },
  open: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  skeleton: { borderRadius: 999, backgroundColor: "rgba(255,255,255,0.25)" },
  waitText: { color: "rgba(255,255,255,0.85)", fontFamily: "NotoSansSC_600SemiBold", fontSize: 13, paddingBottom: 12 },
});
