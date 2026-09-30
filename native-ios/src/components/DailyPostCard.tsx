// Home's daily card: one real post from another parent, fixed for the day.
//
// The home card keeps the Figma hierarchy: source tag, today's headline, then
// one clear action. The personal greeting remains in the accessible label and
// in the detail screen, so the compact card stays readable without losing its
// parent-specific context. Tapping opens the full card (app/daily-post.tsx).
import { Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

import type { DailyPostCard as Card } from "@/src/api";
import { useT } from "@/src/i18n";

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
  if (audience === "mom") {
    return name
      ? t("{nickname}你好呀，其他妈妈可能会这么处理", { nickname: name })
      : t("你好呀，其他妈妈可能会这么处理");
  }
  return name
    ? t("{nickname}你好呀，其他家长可能会这么处理", { nickname: name })
    : t("你好呀，其他家长可能会这么处理");
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

export default function DailyPostCard({
  width,
  nickname,
  status,
  card,
  onPress,
  onRetry,
}: {
  width: number;
  nickname: string;
  status: DailyPostStatus;
  card: Card | null;
  onPress: (card: Card) => void;
  onRetry: () => void;
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
                ? t("今天的家长经验暂时没加载出来，点一下再试试。")
                : t("今天还没找到合适的家长经验。和NURI多聊聊你的情况，明天会更贴近你。")}
            </Text>
            <View style={{ flex: 1 }} />
            {failed ? (
              <View style={styles.footer}>
                <Text style={styles.cta}>{t("重试")}</Text>
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
  // Figma defines this compact home tag by material type. Platform provenance
  // remains available in the accessible label and the detail screen.
  const tag = t("精选文章");
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => onPress(card)}
        style={{ width }}
        accessibilityRole="button"
        accessibilityLabel={`${sourceTag}。${greeting}。${card.headline}`}
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
          <Text style={styles.headline} numberOfLines={3}>
            {card.headline}
          </Text>
          <View style={{ flex: 1 }} />
          <View style={styles.footer}>
            <Text style={styles.cta}>{t("点击查看更多")}</Text>
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
    width: 107,
    height: 32,
    paddingHorizontal: 4,
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
  footer: { minHeight: 55, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cta: {
    flex: 1,
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
