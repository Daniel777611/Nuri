import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

export type HeroCard = {
  id: string;
  title: string;
  summary?: string;
  publisher?: string;
  topic?: string;
  topic_label?: string;
  personalization_reason?: string;
  is_conversation_match?: boolean;
  related_session_id?: string | null;
  context_created_at?: string | null;
  recommendation_id?: string | null;
  rank?: number;
  resource_status?: string;
  resource_summary?: {
    preferred_locale?: string;
    categories?: Record<string, Record<string, number>>;
  };
  colors?: readonly [string, string, ...string[]];
};

export type HeroFeedState = "loading" | "personalized" | "curated";

const EMPTY_CARDS: HeroCard[] = [];

// These IDs all exist in the backend's reviewed content library. They are only
// shown after personalization fails; loading has its own neutral skeleton so a
// parent never sees an unrelated recommendation flash before the real result.
const FALLBACK_CARDS: HeroCard[] = [
  {
    id: "learn_big_feelings",
    title: "孩子有“大情绪”时，先共调节，再教他表达",
    publisher: "AAP 与 UNICEF",
    topic: "emotion",
    topic_label: "情绪调节",
    personalization_reason: "个性化推荐暂时未完成，这是 NURI 的可信来源精选",
    resource_status: "reviewed",
  },
  {
    id: "learn_sleep_routine",
    title: "孩子夜醒或入睡困难，可以先从固定睡前节奏开始",
    publisher: "AAP 美国儿科学会",
    topic: "sleep",
    topic_label: "睡眠与作息",
    personalization_reason: "个性化推荐暂时未完成，这是 NURI 的可信来源精选",
    resource_status: "reviewed",
  },
  {
    id: "learn_picky_eating",
    title: "面对挑食，先减少餐桌压力，再增加接触机会",
    publisher: "AAP 与 UNICEF",
    topic: "food",
    topic_label: "挑食与营养",
    personalization_reason: "个性化推荐暂时未完成，这是 NURI 的可信来源精选",
    resource_status: "reviewed",
  },
  {
    id: "learn_serve_and_return",
    title: "不知道怎么高质量陪伴？试试“发球与回应”",
    publisher: "哈佛大学儿童发展中心",
    topic: "connection",
    topic_label: "亲子互动",
    personalization_reason: "个性化推荐暂时未完成，这是 NURI 的可信来源精选",
    resource_status: "reviewed",
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
  if (feedState === "curated") return "已审校 · 可信精选";
  if (card.resource_status === "research_on_open") return "打开后为你实时精选";
  if (card.resource_status === "consent_required") return "已审校资源 · 可直接阅读";
  if (card.resource_status === "urgent_suppressed") return "优先查看安全建议";
  if (card.resource_status === "unavailable") return "已审校资源 · 可直接阅读";
  const reviewedCount = reviewedResourceCount(card);
  return reviewedCount > 0 ? `已审校 ${reviewedCount} 项资源` : "可信文章与视频";
}

export default function HeroCarousel({
  width,
  cards = EMPTY_CARDS,
  feedState = "personalized",
  onCardPress,
  onCardVisible,
  visibilityScope = "",
}: {
  width: number;
  cards?: HeroCard[];
  feedState?: HeroFeedState;
  onCardPress: (card: HeroCard) => void;
  onCardVisible?: (card: HeroCard, position: number) => void;
  visibilityScope?: string;
}) {
  const visibleCards =
    feedState === "curated" && cards.length === 0 ? FALLBACK_CARDS : cards;
  const cardSignature = useMemo(
    () => visibleCards.map((card) => card.id).join("|"),
    [visibleCards]
  );
  const [pageState, setPageState] = useState({ signature: cardSignature, index: 0 });
  const page = pageState.signature === cardSignature ? pageState.index : 0;
  const setPage = (index: number) => setPageState({ signature: cardSignature, index });
  const scrollRef = useRef<ScrollView>(null);
  const onCardVisibleRef = useRef(onCardVisible);
  const lastVisibilityKeyRef = useRef("");
  const visibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageWidth = width + 12;

  useEffect(() => {
    onCardVisibleRef.current = onCardVisible;
  }, [onCardVisible]);

  useEffect(() => {
    setPageState({ signature: cardSignature, index: 0 });
    scrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [cardSignature]);

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
        accessibilityLabel="正在根据最近对话准备推荐"
        testID="home-hero-loading"
      >
        <View style={[styles.loadingCard, { width }]}>
          <View style={[styles.skeletonLine, styles.skeletonEyebrow]} />
          <View style={[styles.skeletonLine, styles.skeletonTitle]} />
          <View style={[styles.skeletonLine, styles.skeletonTitleShort]} />
          <View style={[styles.skeletonLine, styles.skeletonReason]} />
          <View style={{ flex: 1 }} />
          <Text style={styles.loadingText}>正在根据最近对话挑选内容…</Text>
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
          const colors =
            card.colors ||
            TOPIC_COLORS[card.topic || ""] ||
            FALLBACK_COLORS[index % FALLBACK_COLORS.length];
          return (
            <Pressable
              key={card.id}
              onPress={() => onCardPress(card)}
              style={{ width }}
              accessibilityRole="button"
              accessibilityLabel={`浏览内容：${card.title}`}
              testID={`home-hero-card-${card.id}`}
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
                <Text style={styles.eyebrow}>
                  {feedState === "personalized" && card.is_conversation_match
                    ? "为你推荐"
                    : "NURI 可信来源精选"}
                  {card.topic_label ? ` · ${card.topic_label}` : ""}
                </Text>
                <Text style={styles.heroTitle} numberOfLines={3}>
                  {card.title}
                </Text>
                <Text style={styles.heroSub} numberOfLines={2}>
                  {card.personalization_reason || card.summary || card.publisher}
                </Text>
                <View style={{ flex: 1 }} />
                <View style={styles.cardFooter}>
                  <View style={styles.resourceStatus}>
                    <Text style={styles.resourceStatusText} numberOfLines={1}>
                      {resourceStatusText(card, feedState)}
                    </Text>
                  </View>
                  <View style={styles.heroBtn}>
                    <Text style={styles.heroBtnText}>浏览详情</Text>
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
            style={[styles.arrowButton, page === 0 && styles.arrowButtonDisabled]}
            accessibilityRole="button"
            accessibilityLabel="上一条推荐"
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
              page === visibleCards.length - 1 && styles.arrowButtonDisabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel="下一条推荐"
            accessibilityState={{ disabled: page === visibleCards.length - 1 }}
            testID="hero-carousel-next"
          >
            <Ionicons name="chevron-forward" size={18} color="#302A56" />
          </Pressable>
        </View>
      ) : null}
      <View style={styles.dots}>
        {visibleCards.map((card, index) => (
          <View key={card.id} style={[styles.dot, page === index && styles.dotActive]} />
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
    height: 213,
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
    height: 213,
    borderRadius: 12,
    padding: 23,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 2, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  arrowLayer: {
    position: "absolute",
    top: 84,
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
    color: "rgba(255,255,255,0.88)",
    fontSize: 10,
    fontWeight: "700",
    maxWidth: 235,
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 26,
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
  heroBtn: {
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  heroBtnText: { color: "#1A1A2E", fontSize: 12, fontWeight: "700" },
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
