import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

import type {
  PreparedLearningResource,
  PreparedResourcePair,
  ResourceReadiness,
} from "@/src/api";
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
export type DailySelectionResource = PreparedLearningResource & { url: string };

const EMPTY_CARDS: HeroCard[] = [];
const CARD_GAP = 10;

// Used only when the personalized feed cannot produce a complete package. The
// direct-link interaction remains usable without changing the backend shape.
const FALLBACK_CARDS: HeroCard[] = [
  {
    id: "learn_serve_and_return",
    title: "用五个步骤理解亲子来回互动",
    publisher: "哈佛大学儿童发展中心",
    content_category: "authority",
    content_category_label: "权威来源",
    resource_readiness: "ready",
    resource_pair_complete: false,
    resources: [
      {
        id: "fallback-harvard-serve-return",
        kind: "article",
        title: "促进大脑发育的“发球与回球”互动：五个步骤",
        publisher: "哈佛大学儿童发展中心",
        language: "英文文章",
        url: "https://developingchild.harvard.edu/resources/briefs/5-steps-for-brain-building-serve-and-return/",
      },
    ],
  },
  {
    id: "learn_emotion_regulation",
    title: "孩子崩溃尖叫时，父母可以怎么回应",
    publisher: "亲子天下",
    content_category: "featured",
    content_category_label: "精选内容",
    resource_readiness: "ready",
    resource_pair_complete: false,
    resources: [
      {
        id: "fallback-parenting-tantrum",
        kind: "article",
        title: "小孩崩溃尖叫怎么办？四句诀处理幼儿尖叫",
        publisher: "亲子天下",
        language: "繁体中文",
        url: "https://www.parenting.com.tw/article/5087348",
      },
    ],
  },
  {
    id: "learn_child_connection",
    title: "在家就能开始的亲子互动游戏",
    publisher: "创作型育儿家庭",
    content_category: "case",
    content_category_label: "真实案例",
    resource_readiness: "ready",
    resource_pair_complete: false,
    resources: [
      {
        id: "fallback-family-play-video",
        kind: "video",
        title: "在家玩什么？一到六岁孩子发展游戏",
        publisher: "创作型育儿家庭",
        language: "普通话视频",
        url: "https://www.youtube.com/watch?v=6oEc7lrSTeA",
      },
    ],
  },
];

function cardIdentity(card: HeroCard): string {
  return card.recommendation_id || `${card.id}:${card.content_category || "topic"}`;
}

function safeResources(card: HeroCard): DailySelectionResource[] {
  return (card.resources || []).filter(
    (resource): resource is DailySelectionResource =>
      typeof resource?.url === "string" && /^https:\/\//i.test(resource.url),
  );
}

/**
 * A prepared recommendation currently contains one article and one video. The
 * homepage card represents one external item, so alternate the preferred
 * format by lane while preserving a deterministic single-kind fallback.
 */
export function dailySelectionResource(
  card: HeroCard,
  index: number,
): DailySelectionResource | undefined {
  const resources = safeResources(card);
  if (!resources.length) return undefined;
  const preferredKind = index % 2 === 1 ? "video" : "article";
  return resources.find((resource) => resource.kind === preferredKind) || resources[0];
}

function ArrowIcon() {
  if (Platform.OS === "web") {
    return (
      <Image
        source={{ uri: "/homepage/daily-card-arrow.svg" }}
        style={styles.arrowAsset}
        resizeMode="contain"
      />
    );
  }
  return <Ionicons name="chevron-forward" size={28} color="#3A2F5A" />;
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
  onCardPress: (
    card: HeroCard,
    resource: DailySelectionResource | undefined,
    position: number,
  ) => void;
  onCardVisible?: (card: HeroCard, position: number) => void;
  visibilityScope?: string;
  initialContentCategory?: "authority" | "featured" | "case";
}) {
  const { t } = useT();
  const isRefreshing = feedState === "refreshing";
  const visibleCards =
    feedState === "curated" && cards.length === 0 ? FALLBACK_CARDS : cards;
  const selections = useMemo(
    () =>
      visibleCards.map((card, index) => ({
        card,
        resource: dailySelectionResource(card, index),
      })),
    [visibleCards],
  );
  const cardSignature = useMemo(
    () =>
      selections
        .map(({ card, resource }) => `${cardIdentity(card)}:${resource?.id || "pending"}`)
        .join("|"),
    [selections],
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
    setPageState((current) =>
      current.signature === exposureSignature && current.index === index
        ? current
        : { signature: exposureSignature, index },
    );
  const scrollRef = useRef<ScrollView>(null);
  const onCardVisibleRef = useRef(onCardVisible);
  const lastVisibilityKeyRef = useRef("");
  const visibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageWidth = width + CARD_GAP;

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
    const visibilityKey = `${visibilityScope}:${cardSignature}:${page}:${cardIdentity(visibleCard)}`;
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

  if (feedState === "loading") {
    return (
      <View
        style={styles.loadingWrap}
        accessibilityLiveRegion="polite"
        accessibilityLabel={t("正在根据最近对话准备推荐")}
        testID="home-hero-loading"
      >
        <LinearGradient
          colors={["#FFE1D6", "#FFF9F3", "#DFE3FF"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.loadingCard, { width }]}
        >
          <View style={[styles.skeletonLine, styles.skeletonTag]} />
          <View style={[styles.skeletonLine, styles.skeletonTitle]} />
          <View style={[styles.skeletonLine, styles.skeletonTitleShort]} />
          <View style={{ flex: 1 }} />
          <Text style={styles.loadingText}>{t("正在根据最近对话挑选内容…")}</Text>
        </LinearGradient>
      </View>
    );
  }

  if (visibleCards.length === 0) return null;

  return (
    <View style={styles.carouselWrap}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={pageWidth}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        contentContainerStyle={styles.carouselContent}
        onScroll={(event) =>
          setPage(
            Math.max(
              0,
              Math.min(
                visibleCards.length - 1,
                Math.round(event.nativeEvent.contentOffset.x / pageWidth),
              ),
            ),
          )
        }
        scrollEventThrottle={16}
        testID="home-daily-selection-carousel"
      >
        {selections.map(({ card, resource }, index) => {
          const cardReady = Boolean(resource);
          const title = resource?.title || card.delivery_title || card.title;
          const tag = resource
            ? resource.kind === "video"
              ? t("精选视频")
              : t("精选文章")
            : t("内容准备中");
          return (
            <Pressable
              key={`${cardIdentity(card)}:${resource?.id || "pending"}`}
              onPress={() => onCardPress(card, resource, index + 1)}
              disabled={!cardReady}
              style={{ width }}
              accessibilityRole="link"
              accessibilityLabel={
                cardReady ? `${tag}：${title}` : `${t("内容准备中")}：${title}`
              }
              accessibilityState={{ disabled: !cardReady, busy: !cardReady }}
              testID={`home-hero-card-${card.id}-${card.content_category || "topic"}`}
            >
              <LinearGradient
                colors={["#FFE0D4", "#FFF9F3", "#DDE2FF"]}
                locations={[0, 0.56, 1]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.heroCard}
              >
                <View style={styles.tagPill}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
                <Text style={styles.heroTitle} numberOfLines={3}>
                  {title}
                </Text>
                <View style={{ flex: 1 }} />
                <View style={styles.cardFooter}>
                  <Text style={styles.ctaText}>
                    {cardReady ? t("点击查看更多") : t("正在准备内容")}
                  </Text>
                  <View style={[styles.arrowButton, !cardReady && styles.arrowButtonDisabled]}>
                    {cardReady ? (
                      <ArrowIcon />
                    ) : (
                      <Ionicons name="hourglass-outline" size={22} color="#8A839F" />
                    )}
                  </View>
                </View>
              </LinearGradient>
            </Pressable>
          );
        })}
      </ScrollView>
      {isRefreshing ? (
        <View
          pointerEvents="none"
          style={styles.refreshPill}
          accessibilityLiveRegion="polite"
          testID="home-hero-refreshing"
        >
          <Text style={styles.refreshText}>{t("正在更新每日精选…")}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  carouselWrap: {
    width: "100%",
    overflow: "visible",
  },
  carouselContent: {
    paddingLeft: 17,
    paddingRight: 17,
    gap: CARD_GAP,
  },
  loadingWrap: {
    paddingLeft: 17,
  },
  loadingCard: {
    height: 236,
    borderRadius: 36,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.10)",
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 8,
    overflow: "hidden",
  },
  skeletonLine: {
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.78)",
  },
  skeletonTag: { width: 107, height: 34 },
  skeletonTitle: { width: "88%", height: 24, marginTop: 18 },
  skeletonTitleShort: { width: "62%", height: 24, marginTop: 8 },
  loadingText: {
    color: "#5B5272",
    fontFamily: "NotoSansSC_600SemiBold",
    fontSize: 13,
  },
  heroCard: {
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
    minHeight: 34,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFF9F3",
  },
  tagText: {
    color: "#261B45",
    fontFamily: "NotoSansSC_400Regular",
    fontSize: 12,
    lineHeight: 18,
  },
  heroTitle: {
    marginTop: 12,
    color: "#261B45",
    fontFamily: "NotoSansSC_400Regular",
    fontSize: 20,
    lineHeight: 28,
  },
  cardFooter: {
    minHeight: 55,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  ctaText: {
    flex: 1,
    color: "#3A2F5A",
    fontFamily: "NotoSansSC_700Bold",
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.56,
  },
  arrowButton: {
    width: 55,
    height: 55,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  arrowButtonDisabled: {
    opacity: 0.66,
  },
  arrowAsset: {
    width: 12,
    height: 27,
  },
  refreshPill: {
    position: "absolute",
    left: 38,
    bottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(255,249,243,0.92)",
  },
  refreshText: {
    color: "#5B5272",
    fontFamily: "NotoSansSC_600SemiBold",
    fontSize: 10,
  },
});
