import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

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
  colors?: readonly [string, string, ...string[]];
};

// These IDs all exist in the backend's reviewed content library. They are a
// safe visual fallback while the signed-in recommendation request is loading;
// unlike the old c1-c6 mock cards, they can always open a real detail page.
const FALLBACK_CARDS: HeroCard[] = [
  {
    id: "learn_big_feelings",
    title: "孩子有“大情绪”时，先共调节，再教他表达",
    publisher: "AAP 与 UNICEF",
    topic: "emotion",
    topic_label: "情绪调节",
    personalization_reason: "NURI 可信来源精选",
  },
  {
    id: "learn_sleep_routine",
    title: "孩子夜醒或入睡困难，可以先从固定睡前节奏开始",
    publisher: "AAP 美国儿科学会",
    topic: "sleep",
    topic_label: "睡眠与作息",
    personalization_reason: "NURI 可信来源精选",
  },
  {
    id: "learn_picky_eating",
    title: "面对挑食，先减少餐桌压力，再增加接触机会",
    publisher: "AAP 与 UNICEF",
    topic: "food",
    topic_label: "挑食与营养",
    personalization_reason: "NURI 可信来源精选",
  },
  {
    id: "learn_serve_and_return",
    title: "不知道怎么高质量陪伴？试试“发球与回应”",
    publisher: "哈佛大学儿童发展中心",
    topic: "connection",
    topic_label: "亲子互动",
    personalization_reason: "NURI 可信来源精选",
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

// PC has no touch gesture, so the upper left/right quarters remain invisible
// previous/next controls. The lower CTA area always opens the content page.
const CLICK_ZONE_HEIGHT = 140;
const CLICK_ZONE_RATIO = 0.25;

export default function HeroCarousel({
  width,
  cards = [],
  onCardPress,
}: {
  width: number;
  cards?: HeroCard[];
  onCardPress: (card: HeroCard) => void;
}) {
  const visibleCards = cards.length ? cards : FALLBACK_CARDS;
  const cardSignature = useMemo(
    () => visibleCards.map((card) => card.id).join("|"),
    [visibleCards]
  );
  const [page, setPage] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const pageWidth = width + 12;

  useEffect(() => {
    setPage(0);
    scrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [cardSignature]);

  const goToPage = (index: number) => {
    const clamped = Math.max(0, Math.min(visibleCards.length - 1, index));
    scrollRef.current?.scrollTo({ x: clamped * pageWidth, animated: true });
    setPage(clamped);
  };

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
                {Platform.OS === "web" && (
                  <>
                    <Pressable
                      onPress={() => goToPage(index - 1)}
                      style={[styles.clickZone, { left: 0, width: width * CLICK_ZONE_RATIO }]}
                      accessibilityLabel="上一条推荐"
                      testID={`hero-carousel-prev-${card.id}`}
                    />
                    <Pressable
                      onPress={() => goToPage(index + 1)}
                      style={[styles.clickZone, { right: 0, width: width * CLICK_ZONE_RATIO }]}
                      accessibilityLabel="下一条推荐"
                      testID={`hero-carousel-next-${card.id}`}
                    />
                  </>
                )}
                <View style={styles.decoCloudOne} />
                <View style={styles.decoCloudTwo} />
                <View style={styles.decoCloudThree} />
                <Text style={styles.eyebrow}>
                  {card.is_conversation_match ? "根据最近对话推荐" : "NURI 可信来源精选"}
                  {card.topic_label ? ` · ${card.topic_label}` : ""}
                </Text>
                <Text style={styles.heroTitle} numberOfLines={3}>
                  {card.title}
                </Text>
                <Text style={styles.heroSub} numberOfLines={2}>
                  {card.personalization_reason || card.summary || card.publisher}
                </Text>
                <View style={{ flex: 1 }} />
                <View style={styles.heroBtn}>
                  <Text style={styles.heroBtnText}>浏览详情</Text>
                </View>
              </LinearGradient>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.dots}>
        {visibleCards.map((card, index) => (
          <View key={card.id} style={[styles.dot, page === index && styles.dotActive]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  clickZone: {
    position: "absolute",
    top: 0,
    height: CLICK_ZONE_HEIGHT,
    zIndex: 2,
  },
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
    alignSelf: "flex-start",
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
  },
  heroBtnText: { color: "#1A1A2E", fontSize: 12, fontWeight: "700" },
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
