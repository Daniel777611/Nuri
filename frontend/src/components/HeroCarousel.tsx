import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

export type HeroCard = {
  id: string;
  source: string;
  title: string;
  sub: string;
  colors: readonly [string, string, ...string[]];
};

// 首页知识卡片轮播 mock：六页均为前端演示，不依赖后端或外部链接。
const CAROUSEL: HeroCard[] = [
  {
    id: "c1",
    source: "来自Amber的育儿播客分享",
    title: "如何培养孩子的\n情绪管理能力？",
    sub: "探索属于你的家庭策略",
    colors: ["#4F4B9C", "#ADD2FD"] as const,
  },
  {
    id: "c2",
    source: "来自丁香妈妈的科普文章",
    title: "18个月宝宝挑食怎么办？\n专家这样说",
    sub: "食物新恐惧期的应对指南",
    colors: ["#4B72B9", "#9ED8F0"] as const,
  },
  {
    id: "c3",
    source: "来自北美儿科医生播客",
    title: "睡眠训练到底\n有没有用？",
    sub: "聊聊哭声免疫法的争议",
    colors: ["#8861B1", "#E8B7D1"] as const,
  },
  { id: "c4", source: "来自NURI精选文章", title: "宝宝总说“不”？\n试试这样回应", sub: "把对抗变成一次合作练习", colors: ["#9A5B83", "#F3B992"] as const },
  { id: "c5", source: "来自家庭成长通讯", title: "给自己留一点\n不被打扰的时间", sub: "照顾孩子前，先照顾好自己", colors: ["#385E87", "#9FC5DD"] as const },
  { id: "c6", source: "来自真实家长经验", title: "出门总是拖很久？\n试试出发仪式", sub: "让每天的小事更有掌控感", colors: ["#52685E", "#B7D6AF"] as const },
];

// PC 端没有滑动手势，左右各留出 1/4 卡片宽度的无形点击区（避开底部的
// "浏览详情" 按钮），点一下翻到上一页/下一页。原生端保留手势滑动，不受影响。
const CLICK_ZONE_HEIGHT = 140;
const CLICK_ZONE_RATIO = 0.25;

export default function HeroCarousel({
  width,
  onCardPress,
}: {
  width: number;
  onCardPress: (card: HeroCard) => void;
}) {
  const [page, setPage] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const pageWidth = width + 12;

  const goToPage = (index: number) => {
    const clamped = Math.max(0, Math.min(CAROUSEL.length - 1, index));
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
        onScroll={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / pageWidth))}
        onMomentumScrollEnd={(e) => {
          // react-native-web doesn't reliably honor snapToInterval, so force
          // an exact snap after every drag — a card should never end up
          // straddling the viewport edge.
          if (Platform.OS === "web") {
            goToPage(Math.round(e.nativeEvent.contentOffset.x / pageWidth));
          }
        }}
        scrollEventThrottle={16}
      >
        {CAROUSEL.map((c, i) => (
          <LinearGradient
            key={c.id}
            colors={c.colors}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.heroCard, { width }]}
          >
            {Platform.OS === "web" && (
              <>
                <Pressable
                  onPress={() => goToPage(i - 1)}
                  style={[styles.clickZone, { left: 0, width: width * CLICK_ZONE_RATIO }]}
                  testID={`hero-carousel-prev-${c.id}`}
                />
                <Pressable
                  onPress={() => goToPage(i + 1)}
                  style={[styles.clickZone, { right: 0, width: width * CLICK_ZONE_RATIO }]}
                  testID={`hero-carousel-next-${c.id}`}
                />
              </>
            )}
            {/* 前端模拟的云朵/树冠装饰；不绑定后端内容。 */}
            <View style={styles.decoCloudOne} />
            <View style={styles.decoCloudTwo} />
            <View style={styles.decoCloudThree} />
            <Text style={styles.heroTitle}>{c.title}</Text>
            <Text style={styles.heroSub}>
              {c.source}，{c.sub}
            </Text>
            <View style={{ flex: 1 }} />
            <Pressable
              onPress={() => onCardPress(c)}
              style={styles.heroBtn}
              testID={`home-hero-cta-${c.id}`}
            >
              <Text style={styles.heroBtnText}>浏览详情</Text>
            </Pressable>
          </LinearGradient>
        ))}
      </ScrollView>
      {/* 分页指示器 */}
      <View style={styles.dots}>
        {CAROUSEL.map((_, i) => (
          <View key={i} style={[styles.dot, page === i && styles.dotActive]} />
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
    zIndex: 1,
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
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 24,
    fontWeight: "700",
    lineHeight: 27,
    marginTop: 18,
  },
  heroSub: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
    maxWidth: 205,
  },
  heroBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 12,
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
