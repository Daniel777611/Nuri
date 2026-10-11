// Home's daily resource with a NURI-authored reading guide.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

import type { DailyPostCard as Card } from "@/src/api";
import { useT } from "@/src/i18n";
import { nuriResourceGuide } from "@/src/nuriResourceGuide";
import { shortResourceSummary } from "@/src/resourceSummary";
import { externalSourceUrl } from "@/src/externalContent";

export type DailyPostStatus = "loading" | "pending" | "ready" | "empty" | "error" | "disabled";

const PLATFORM_NAMES: Record<Card["platform"], string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
};

/** The greeting on the card and at the top of the detail screen. */
export function dailyPostGreeting(
  t: (s: string, v?: Record<string, string | number>) => string,
  nickname: string,
  audience: Card["audience"] | undefined,
): string {
  const name = nickname.trim();
  // Do not attribute our reading prompts to a parent whose post we haven't read.
  void audience;
  return name
    ? t("{nickname}你好呀，一起看看这个育儿话题", { nickname: name })
    : t("你好呀，一起看看这个育儿话题");
}

/** "Facebook 家长群讨论" / "Instagram 家长分享" */
export function dailyPostTag(
  t: (s: string, v?: Record<string, string | number>) => string,
  card: Card,
): string {
  const platform = PLATFORM_NAMES[card.platform] || card.platform;
  return card.author_kind === "parent_group_answers"
    ? t("{platform} 家长群讨论", { platform })
    : t("{platform} 家长分享", { platform });
}

export function dailyPostPreview(card: Card): string | null {
  // These are the backend's AI-written search previews, not a verbatim quote.
  return externalSourceUrl(card.source_url)
    ? shortResourceSummary(card.question, 110) || shortResourceSummary(card.headline, 110)
    : null;
}

export function dailyPostQuestion(t: (s: string, v?: Record<string, string | number>) => string, card: Card): string {
  const preview = dailyPostPreview(card);
  return preview || nuriResourceGuide({ concern: card.concern }, t).headline;
}

export function dailyPostAsker(t: (s: string) => string, card: Card): string {
  return card.author_kind === "parent_group_answers" ? t("家长群里有人问") : t("一位家长的经历");
}

export default function DailyPostCard({
  width,
  nickname,
  status,
  card,
  onPress,
  onRetry,
  failureText,
  failureAction,
}: {
  width: number;
  nickname: string;
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
      <View style={styles.wrap} accessibilityLiveRegion="polite" testID="home-daily-post-loading">
        <LinearGradient
          colors={["#FFE1D6", "#FFF9F3", "#DFE3FF"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.card, { width }]}
        >
          <View style={[styles.skeleton, styles.skeletonTag]} />
          <View style={[styles.skeleton, styles.skeletonTitle]} />
          <View style={[styles.skeleton, styles.skeletonTitleShort]} />
          <View style={{ flex: 1 }} />
          <Text style={styles.waitText}>{t("正在为你找其他家长的经验…")}</Text>
        </LinearGradient>
      </View>
    );
  }

  if (status !== "ready" || !card) {
    // Nothing usable today (or the request failed): say so plainly, and let a
    // failure be retried. Never an empty gap where the card was.
    const failed = status === "error";
    return (
      <View style={styles.wrap}>
        <Pressable
          onPress={failed ? onRetry : undefined}
          disabled={!failed}
          style={{ width }}
          accessibilityRole={failed ? "button" : undefined}
          testID="home-daily-post-empty"
        >
          <LinearGradient
            colors={["#FFE0D4", "#FFF9F3", "#DDE2FF"]}
            locations={[0, 0.56, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.card}
          >
            <Text style={styles.greeting} numberOfLines={2}>
              {nickname.trim() ? t("{nickname}你好呀", { nickname: nickname.trim() }) : t("你好呀")}
            </Text>
            <Text style={styles.headline} numberOfLines={3}>
              {failed
                ? failureText || t("今天的家长经验暂时没加载出来，点一下再试试。")
                : t("今天还没找到合适的家长经验。和NURI多聊聊你的情况，明天会更贴近你。")}
            </Text>
            <View style={{ flex: 1 }} />
            {failed ? (
              <View style={styles.footer}>
                <Text style={styles.cta}>{failureAction || t("重试")}</Text>
                <View style={styles.arrow}>
                  <Ionicons name="refresh" size={22} color="#3A2F5A" />
                </View>
              </View>
            ) : null}
          </LinearGradient>
        </Pressable>
      </View>
    );
  }

  const greeting = dailyPostGreeting(t, card.nickname || nickname, card.audience);
  const sourceTag = dailyPostTag(t, card);
  const tag = sourceTag;
  const question = dailyPostQuestion(t, card);
  const summaryLabel = dailyPostPreview(card) ? t("AI 检索摘要") : t("NURI 导读");
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => onPress(card)}
        style={{ width }}
        accessibilityRole="button"
        accessibilityLabel={`${sourceTag}。${greeting}。${summaryLabel}。${question}`}
        testID="home-daily-post-card"
      >
        <LinearGradient
          colors={["#FFE0D4", "#FFF9F3", "#DDE2FF"]}
          locations={[0, 0.56, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.card}
        >
          <View style={styles.tagPill}>
            <Text style={styles.tagText} numberOfLines={1}>{tag}</Text>
          </View>
          <Text style={styles.question} numberOfLines={3} testID="home-daily-post-question">
            {question}
          </Text>
          <View style={{ flex: 1 }} />
          <View style={styles.footer}>
            <View style={styles.footerText}>
              <Text style={styles.summaryLabel} testID="home-daily-post-summary-label">{summaryLabel}</Text>
              <Text style={styles.cta}>{t("查看摘要与来源")}</Text>
            </View>
            <View style={styles.arrow}>
              <Ionicons name="arrow-forward" size={22} color="#3A2F5A" />
            </View>
          </View>
        </LinearGradient>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryLabel: { color: "#5B5272", fontFamily: "NotoSansSC_400Regular", fontSize: 11, lineHeight: 18, marginBottom: 4 },
  footerText: { flex: 1 },
  wrap: { paddingLeft: 17 },
  card: {
    height: 236,
    borderRadius: 36,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.10)",
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 8,
    overflow: "hidden",
    shadowColor: "#000000",
    shadowOffset: { width: -2, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 5,
    elevation: 2,
  },
  tagPill: {
    alignSelf: "flex-start",
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFF9F3",
  },
  tagText: { color: "#261B45", fontFamily: "NotoSansSC_400Regular", fontSize: 12, lineHeight: 18 },
  greeting: {
    marginTop: 12,
    color: "#261B45",
    fontFamily: "NotoSansSC_700Bold",
    fontSize: 19,
    lineHeight: 26,
  },
  headline: {
    marginTop: 12,
    color: "#261B45",
    fontFamily: "NotoSansSC_400Regular",
    fontSize: 20,
    lineHeight: 28,
  },
  question: { marginTop: 12, color: "#261B45", fontFamily: "NotoSansSC_700Bold", fontSize: 20, lineHeight: 29 },
  footer: { minHeight: 55, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cta: {
    color: "#3A2F5A",
    fontFamily: "NotoSansSC_700Bold",
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.56,
  },
  arrow: {
    width: 55,
    height: 55,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  skeleton: { borderRadius: 999, backgroundColor: "rgba(255,255,255,0.78)" },
  skeletonTag: { width: 120, height: 30 },
  skeletonTitle: { width: "88%", height: 24, marginTop: 18 },
  skeletonTitleShort: { width: "62%", height: 20, marginTop: 10 },
  waitText: { color: "#5B5272", fontFamily: "NotoSansSC_600SemiBold", fontSize: 13, paddingBottom: 12 },
});
