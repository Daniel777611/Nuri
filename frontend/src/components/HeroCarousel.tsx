import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import type {
  PreparedLearningResource,
  PreparedResourcePair,
  ResourceReadiness,
} from "@/src/api";
import {
  deliveryCategoryMeta,
  recommendationLanguageLabel,
  recommendationSourceLabel,
  recommendationStageLabel,
  recommendationTimeLabel,
} from "@/src/recommendationPresentation";
import { useT } from "@/src/i18n";

export type HeroCard = {
  id: string;
  title: string;
  summary?: string;
  publisher?: string;
  topic?: string;
  topic_label?: string;
  content_category?: "authority" | "featured" | "case";
  content_category_label?: string;
  content_category_eyebrow?: string;
  content_category_description?: string;
  delivery_title?: string;
  source_label?: string;
  language_label?: string;
  estimated_time_label?: string;
  applicable_stage?: string;
  development_stage?: string;
  child_age_context?: string;
  preferred_locale?: string;
  guide?: string;
  action_steps?: string[];
  personalization_reason?: string;
  is_conversation_match?: boolean;
  related_session_id?: string | null;
  context_created_at?: string | null;
  recommendation_id?: string | null;
  rank?: number;
  resource_status?: string;
  resource_readiness?: ResourceReadiness;
  resource_pair_complete?: boolean;
  prepared_content_set_id?: string | null;
  active_pair_id?: string | null;
  alternate_count?: number;
  alternate_resource_pairs?: PreparedResourcePair[];
  resources?: PreparedLearningResource[];
  research_status?: string;
  resource_summary?: {
    preferred_locale?: string;
    categories?: Record<string, Record<string, number>>;
  };
  colors?: readonly [string, string, ...string[]];
};

export type HeroFeedState = "loading" | "refreshing" | "personalized" | "curated";

const EMPTY_CARDS: HeroCard[] = [];
const FALLBACK_REASON =
  "个性化推荐暂时不可用，以下是不限定孩子月龄的通用育儿资料";

// These IDs all exist in the backend's reviewed content library. They are only
// shown after personalization fails; loading has its own neutral skeleton so a
// parent never sees an unrelated recommendation flash before the real result.
const FALLBACK_CARDS: HeroCard[] = [
  {
    id: "learn_serve_and_return",
    title: "从观察和回应开始，建立日常亲子互动",
    publisher: "哈佛大学儿童发展中心",
    topic: "connection",
    topic_label: "亲子互动",
    content_category: "authority",
    content_category_label: "权威来源",
    personalization_reason: FALLBACK_REASON,
    resource_status: "reviewed",
    resource_readiness: "unavailable",
    resource_pair_complete: false,
  },
  {
    id: "learn_serve_and_return",
    title: "把高质量陪伴放进每天的小片段",
    publisher: "NURI 编辑精选",
    topic: "connection",
    topic_label: "亲子互动",
    content_category: "featured",
    content_category_label: "精选内容",
    personalization_reason: FALLBACK_REASON,
    resource_status: "reviewed",
    resource_readiness: "unavailable",
    resource_pair_complete: false,
  },
  {
    id: "learn_serve_and_return",
    title: "看看其他家庭怎样在日常里回应孩子",
    publisher: "NURI 真实家庭案例",
    topic: "connection",
    topic_label: "亲子互动",
    content_category: "case",
    content_category_label: "真实案例",
    personalization_reason: FALLBACK_REASON,
    resource_status: "reviewed",
    resource_readiness: "unavailable",
    resource_pair_complete: false,
  },
];

const TOPIC_COLORS: Record<string, readonly [string, string]> = {
  emotion: ["#4F4B9C", "#ADD2FD"],
  sleep: ["#4B72B9", "#9ED8F0"],
  food: ["#9A5B83", "#F3B992"],
  language: ["#8861B1", "#E8B7D1"],
  behavior: ["#52685E", "#B7D6AF"],
  connection: ["#385E87", "#9FC5DD"],
  safety: ["#7B526A", "#E7A8A8"],
};

const CATEGORY_COLORS: Record<string, readonly [string, string]> = {
  authority: ["#426FA8", "#8AC9E2"],
  featured: ["#6256A8", "#A5BCEF"],
  case: ["#A55D74", "#F0A58F"],
};

const FALLBACK_COLORS: readonly [readonly [string, string], ...readonly [string, string][]] = [
  ["#4F4B9C", "#ADD2FD"],
  ["#4B72B9", "#9ED8F0"],
  ["#8861B1", "#E8B7D1"],
  ["#52685E", "#B7D6AF"],
];

function reviewedResourceCount(card: HeroCard): number {
  const categories = card.resource_summary?.categories;
  if (!categories) return 0;
  return Object.values(categories).reduce(
    (total, formats) =>
      total + Object.values(formats).reduce((subtotal, count) => subtotal + count, 0),
    0,
  );
}

function resourceStatusText(card: HeroCard, feedState: HeroFeedState): string {
  if (card.resource_readiness === "preparing") {
    return "正在为你准备文章与视频";
  }
  if (card.resource_readiness === "retryable") {
    return "准备稍有延迟，正在自动重试";
  }
  if (card.resource_readiness === "unavailable") {
    return "暂未找到完整的文章与视频";
  }
  if (
    card.resource_readiness === "ready" &&
    card.resource_pair_complete === true
  ) {
    return "已准备 · 1 篇文章 · 1 个视频";
  }
  if (card.content_category) {
    const formats = card.resource_summary?.categories?.[card.content_category];
    if ((formats?.article || 0) > 0 && (formats?.video || 0) > 0) {
      return "1 篇文章 · 1 个视频";
    }
    return card.resource_status === "research_on_open"
      ? "打开后为你核验文章与视频"
      : "正在补齐文章与视频";
  }
  if (feedState === "curated") return "已审校 · 可信精选";
  if (card.resource_status === "research_on_open") return "打开后为你实时精选";
  if (card.resource_status === "consent_required") return "已审校资源 · 可直接阅读";
  if (card.resource_status === "urgent_suppressed") return "优先查看安全建议";
  if (card.resource_status === "unavailable") return "已审校资源 · 可直接阅读";
  const reviewedCount = reviewedResourceCount(card);
  return reviewedCount > 0 ? `已审校 ${reviewedCount} 项资源` : "可信文章与视频";
}

function isCardReady(card: HeroCard): boolean {
  return (
    card.resource_readiness === "ready" &&
    card.resource_pair_complete === true
  );
}

function deliveryStatusText(card: HeroCard, feedState: HeroFeedState): string {
  if (card.resource_readiness === "ready" && card.resource_pair_complete === true) {
    return "内容已准备好 · 文章 + 视频";
  }
  if (card.resource_readiness === "preparing") return "正在准备文章与视频";
  if (card.resource_readiness === "retryable") return "旧内容可读 · 新内容后台重试";
  if (card.resource_readiness === "unavailable") return "暂未找到完整内容包";
  return resourceStatusText(card, feedState);
}

function cardIdentity(card: HeroCard): string {
  return card.recommendation_id || `${card.id}:${card.content_category || "topic"}`;
}

export default function HeroCarousel({
  width,
  cards = EMPTY_CARDS,
  feedState = "personalized",
  onCardPress,
  onCardVisible,
  visibilityScope = "",
  initialContentCategory,
}: {
  width: number;
  cards?: HeroCard[];
  feedState?: HeroFeedState;
  onCardPress: (card: HeroCard) => void;
  onCardVisible?: (card: HeroCard, position: number) => void;
  visibilityScope?: string;
  initialContentCategory?: "authority" | "featured" | "case";
}) {
  const { t } = useT();
  const isRefreshing = feedState === "refreshing";
  // Only the fallbacks are translated. A real card's title and publisher
  // arrive from the server already in the family's language, and they take
  // the same render path, so this is the one place the two can be told apart.
  const visibleCards =
    feedState === "curated" && cards.length === 0
      ? FALLBACK_CARDS.map((card) => ({
          ...card,
          title: t(card.title),
          publisher: card.publisher ? t(card.publisher) : card.publisher,
          topic_label: card.topic_label ? t(card.topic_label) : card.topic_label,
          content_category_label: card.content_category_label
            ? t(card.content_category_label)
            : card.content_category_label,
          personalization_reason: card.personalization_reason
            ? t(card.personalization_reason)
            : card.personalization_reason,
        }))
      : cards;
  const cardSignature = useMemo(
    () => visibleCards.map(cardIdentity).join("|"),
    [visibleCards]
  );
  const initialIndex = Math.max(
    0,
    visibleCards.findIndex((card) => card.content_category === initialContentCategory),
  );
  const exposureSignature = `${cardSignature}:${initialContentCategory || "authority"}`;
  const [pageState, setPageState] = useState({
    signature: exposureSignature,
    index: initialIndex,
  });
  const page =
    pageState.signature === exposureSignature ? pageState.index : initialIndex;
  const setPage = (index: number) =>
    setPageState({ signature: exposureSignature, index });
  const scrollRef = useRef<ScrollView>(null);
  const onCardVisibleRef = useRef(onCardVisible);
  const lastVisibilityKeyRef = useRef("");
  const visibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageWidth = width + 12;

  useEffect(() => {
    onCardVisibleRef.current = onCardVisible;
  }, [onCardVisible]);

  useEffect(() => {
    setPageState({ signature: exposureSignature, index: initialIndex });
    scrollRef.current?.scrollTo({ x: initialIndex * pageWidth, animated: false });
  }, [exposureSignature, initialIndex, pageWidth]);

  useEffect(() => {
    if (visibilityTimerRef.current) {
      clearTimeout(visibilityTimerRef.current);
      visibilityTimerRef.current = null;
    }
    if (feedState === "loading") return;
    const visibleCard = visibleCards[page];
    if (!visibleCard) return;
    const visibilityKey = `${visibilityScope}:${cardSignature}:${page}:${visibleCard.recommendation_id || visibleCard.id}`;
    if (lastVisibilityKeyRef.current === visibilityKey) return;
    visibilityTimerRef.current = setTimeout(() => {
      lastVisibilityKeyRef.current = visibilityKey;
      visibilityTimerRef.current = null;
      onCardVisibleRef.current?.(visibleCard, page + 1);
    }, 500);
    return () => {
      if (visibilityTimerRef.current) {
        clearTimeout(visibilityTimerRef.current);
        visibilityTimerRef.current = null;
      }
    };
  }, [cardSignature, feedState, page, visibilityScope, visibleCards]);

  const goToPage = (index: number) => {
    const clamped = Math.max(0, Math.min(visibleCards.length - 1, index));
    scrollRef.current?.scrollTo({ x: clamped * pageWidth, animated: true });
    setPage(clamped);
  };

  if (feedState === "loading") {
    return (
      <View
        style={styles.loadingWrap}
        accessibilityLiveRegion="polite"
        accessibilityLabel={t("正在根据最近对话准备推荐")}
        testID="home-hero-loading"
      >
        <View style={[styles.loadingCard, { width }]}>
          <View style={[styles.skeletonLine, styles.skeletonEyebrow]} />
          <View style={[styles.skeletonLine, styles.skeletonTitle]} />
          <View style={[styles.skeletonLine, styles.skeletonTitleShort]} />
          <View style={[styles.skeletonLine, styles.skeletonReason]} />
          <View style={{ flex: 1 }} />
          <Text style={styles.loadingText}>{t("正在根据最近对话挑选内容…")}</Text>
        </View>
        <View style={styles.dots}>
          <View style={[styles.dot, styles.dotLoading]} />
        </View>
      </View>
    );
  }

  if (visibleCards.length === 0) return null;

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={pageWidth}
        decelerationRate="fast"
        disableIntervalMomentum
        scrollEnabled
        contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
        onScroll={(event) =>
          setPage(
            Math.max(
              0,
              Math.min(
                visibleCards.length - 1,
                Math.round(event.nativeEvent.contentOffset.x / pageWidth)
              )
            )
          )
        }
        onMomentumScrollEnd={(event) => {
          if (Platform.OS === "web") {
            goToPage(Math.round(event.nativeEvent.contentOffset.x / pageWidth));
          }
        }}
        scrollEventThrottle={16}
      >
        {visibleCards.map((card, index) => {
          const cardReady = isCardReady(card);
          const cardPreparing = card.resource_readiness === "preparing";
          const cardRetryable = card.resource_readiness === "retryable";
          const categoryMeta = deliveryCategoryMeta(card.content_category);
          // These four return the Simplified source as a key; they are
          // module-level and cannot reach the hook themselves.
          const sourceLabel = t(recommendationSourceLabel(card));
          const languageLabel = recommendationLanguageLabel(card, t);
          const timeLabel = recommendationTimeLabel(card, t);
          const stageLabel = t(recommendationStageLabel(card));
          const colors =
            card.colors ||
            CATEGORY_COLORS[card.content_category || ""] ||
            TOPIC_COLORS[card.topic || ""] ||
            FALLBACK_COLORS[index % FALLBACK_COLORS.length];
          return (
            <Pressable
              key={cardIdentity(card)}
              onPress={() => onCardPress(card)}
              style={{ width }}
              accessibilityRole="button"
              accessibilityLabel={
                isRefreshing
                  ? `打开当前显示的内容：${card.title}`
                  : cardPreparing
                    ? `正在准备内容：${card.title}`
                    : cardRetryable
                      ? `重试准备内容：${card.title}`
                    : cardReady
                      ? `浏览内容：${card.title}`
                      : `内容暂不可用：${card.title}`
              }
              accessibilityState={{
                busy: cardPreparing,
              }}
              testID={`home-hero-card-${card.id}-${card.content_category || "topic"}`}
            >
              <LinearGradient
                colors={colors}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.heroCard}
              >
                <View style={styles.decoCloudOne} />
                <View style={styles.decoCloudTwo} />
                <View style={styles.decoCloudThree} />
                <View style={styles.categoryRow}>
                  <Ionicons name={categoryMeta.icon} size={14} color="#FFFFFF" />
                  <Text style={styles.eyebrow}>{t(categoryMeta.label)}</Text>
                  <Text style={styles.categoryPromise} numberOfLines={1}>
                    {t(categoryMeta.promise)}
                  </Text>
                </View>
                <Text style={styles.heroTitle} numberOfLines={2}>
                  {card.delivery_title || card.title}
                </Text>
                <Text style={styles.heroSub} numberOfLines={2}>
                  {card.personalization_reason || card.summary || card.publisher}
                </Text>
                <View style={styles.sourceRow}>
                  <Ionicons
                    name="business-outline"
                    size={12}
                    color="rgba(255,255,255,0.9)"
                  />
                  <Text style={styles.sourceText} numberOfLines={1}>
                    {sourceLabel}
                  </Text>
                </View>
                <View style={styles.metaChips}>
                  {[languageLabel, timeLabel, stageLabel].map((label) => (
                    <View key={label} style={styles.metaChip}>
                      <Text style={styles.metaChipText} numberOfLines={1}>
                        {label}
                      </Text>
                    </View>
                  ))}
                </View>
                <View style={{ flex: 1 }} />
                <View style={styles.cardFooter}>
                  <View style={styles.resourceStatus}>
                    <Text style={styles.resourceStatusText} numberOfLines={1}>
                      {t(deliveryStatusText(card, feedState))}
                    </Text>
                  </View>
                  <View style={[styles.heroBtn, !cardReady && styles.heroBtnDisabled]}>
                    <Text style={[styles.heroBtnText, !cardReady && styles.heroBtnTextDisabled]}>
                      {cardPreparing
                        ? t("查看导读")
                        : card.resource_readiness === "retryable"
                          ? t("打开当前内容")
                          : card.resource_readiness === "unavailable"
                            ? t("查看内容导读")
                            : t("打开学习胶囊")}
                    </Text>
                  </View>
                </View>
              </LinearGradient>
            </Pressable>
          );
        })}
      </ScrollView>
      {visibleCards.length > 1 ? (
        <View pointerEvents="box-none" style={styles.arrowLayer}>
          <Pressable
            onPress={() => goToPage(page - 1)}
            disabled={page === 0}
            hitSlop={8}
            style={[
              styles.arrowButton,
              page === 0 && styles.arrowButtonDisabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t("上一条推荐")}
            accessibilityState={{ disabled: page === 0 }}
            testID="hero-carousel-prev"
          >
            <Ionicons name="chevron-back" size={18} color="#302A56" />
          </Pressable>
          <Pressable
            onPress={() => goToPage(page + 1)}
            disabled={page === visibleCards.length - 1}
            hitSlop={8}
            style={[
              styles.arrowButton,
              page === visibleCards.length - 1 &&
                styles.arrowButtonDisabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t("下一条推荐")}
            accessibilityState={{
              disabled: page === visibleCards.length - 1,
            }}
            testID="hero-carousel-next"
          >
            <Ionicons name="chevron-forward" size={18} color="#302A56" />
          </Pressable>
        </View>
      ) : null}
      {isRefreshing ? (
        <View
          pointerEvents="none"
          style={styles.backgroundUpdatePill}
          accessibilityLiveRegion="polite"
          testID="home-hero-refreshing"
        >
          <Ionicons name="sync-outline" size={13} color="#4F4B9C" />
          <Text style={styles.backgroundUpdateText}>
            {t("正在后台准备最新推荐，当前内容仍可打开")}
          </Text>
        </View>
      ) : null}
      <View style={styles.dots}>
        {visibleCards.map((card, index) => (
          <View key={cardIdentity(card)} style={[styles.dot, page === index && styles.dotActive]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    paddingHorizontal: 16,
  },
  loadingCard: {
    minHeight: 252,
    borderRadius: 12,
    padding: 23,
    backgroundColor: "#DCE2F0",
    overflow: "hidden",
  },
  skeletonLine: {
    borderRadius: 5,
    backgroundColor: "rgba(255,255,255,0.68)",
  },
  skeletonEyebrow: { width: 118, height: 9 },
  skeletonTitle: { width: "76%", height: 22, marginTop: 15 },
  skeletonTitleShort: { width: "56%", height: 22, marginTop: 7 },
  skeletonReason: { width: "68%", height: 11, marginTop: 14 },
  loadingText: {
    color: "#555A78",
    fontSize: 12,
    fontWeight: "600",
  },
  dotLoading: { width: 41, backgroundColor: "rgba(90,92,130,0.28)" },
  heroCard: {
    minHeight: 252,
    borderRadius: 12,
    padding: 23,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 2, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  backgroundUpdatePill: {
    minHeight: 28,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 7,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#D8D2F2",
    backgroundColor: "rgba(247,245,255,0.96)",
  },
  backgroundUpdateText: {
    color: "#4F4B9C",
    fontSize: 10,
    fontWeight: "700",
  },
  arrowLayer: {
    position: "absolute",
    top: 104,
    left: 8,
    right: 8,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  arrowButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.92)",
    shadowColor: "#241F48",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.16,
    shadowRadius: 4,
    elevation: 3,
  },
  arrowButtonDisabled: { opacity: 0.32 },
  decoCloudOne: {
    position: "absolute",
    right: -20,
    top: -4,
    width: 132,
    height: 96,
    borderRadius: 52,
    backgroundColor: "rgba(50,72,175,0.28)",
  },
  decoCloudTwo: {
    position: "absolute",
    right: 18,
    top: 32,
    width: 110,
    height: 100,
    borderRadius: 55,
    backgroundColor: "rgba(56,64,160,0.32)",
  },
  decoCloudThree: {
    position: "absolute",
    right: 46,
    top: 15,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  eyebrow: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "800",
  },
  categoryRow: {
    maxWidth: 286,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  categoryPromise: {
    flexShrink: 1,
    paddingLeft: 6,
    borderLeftWidth: 1,
    borderLeftColor: "rgba(255,255,255,0.45)",
    color: "rgba(255,255,255,0.82)",
    fontSize: 9,
    fontWeight: "600",
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 24,
    marginTop: 8,
    maxWidth: 270,
  },
  heroSub: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
    maxWidth: 235,
  },
  sourceRow: {
    maxWidth: 254,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 6,
  },
  sourceText: {
    flexShrink: 1,
    color: "rgba(255,255,255,0.92)",
    fontSize: 10,
    fontWeight: "700",
  },
  metaChips: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 7,
    maxWidth: 300,
  },
  metaChip: {
    minWidth: 0,
    maxWidth: 108,
    flexShrink: 1,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.17)",
  },
  metaChipText: {
    color: "rgba(255,255,255,0.94)",
    fontSize: 9,
    fontWeight: "600",
  },
  heroBtn: {
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  heroBtnDisabled: {
    backgroundColor: "rgba(255,255,255,0.66)",
  },
  heroBtnText: { color: "#1A1A2E", fontSize: 12, fontWeight: "700" },
  heroBtnTextDisabled: { color: "#555A78" },
  cardFooter: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  resourceStatus: {
    flexShrink: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: "rgba(255,255,255,0.17)",
  },
  resourceStatusText: {
    color: "rgba(255,255,255,0.94)",
    fontSize: 10,
    fontWeight: "600",
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 2,
    marginTop: 8,
    marginBottom: 2,
  },
  dot: {
    width: 41,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(218,218,218,0.63)",
  },
  dotActive: { backgroundColor: "#3A2F5A" },
});
