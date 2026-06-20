import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Pressable,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

type FeedCard = {
  id: string;
  type: "tip" | "news" | "product";
  type_label: string;
  title: string;
  summary: string;
  image_url?: string;
};

const ICON_BY_TYPE: Record<FeedCard["type"], any> = {
  tip: "bulb-outline",
  news: "flame-outline",
  product: "pricetag-outline",
};

const TAG_BG: Record<FeedCard["type"], string> = {
  tip: "#EEF6F1",
  news: "#FFF1EE",
  product: "#FEF9E7",
};
const TAG_FG: Record<FeedCard["type"], string> = {
  tip: "#2F7A4B",
  news: colors.onBrandTertiary,
  product: "#8A6D1B",
};

export default function Home() {
  const router = useRouter();
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [child, setChild] = useState<any>(null);

  const load = useCallback(async (shuffle = false) => {
    const [feed, children] = await Promise.all([
      api.getFeed(shuffle),
      api.listChildren(),
    ]);
    setCards(feed);
    setChild(children[0] || null);
    // Track impressions
    feed.forEach((c: FeedCard) =>
      api.trackEvent("impression", { card_id: c.id, card_type: c.type }).catch(() => {})
    );
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await load(false);
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const askAI = async (card: FeedCard) => {
    api
      .trackEvent("click_ask_ai", { card_id: card.id, card_type: card.type })
      .catch(() => {});
    const session = await api.startSession({
      card_id: card.id,
      title: card.title,
    });
    router.push(`/chat/${session.id}`);
  };

  const onScroll = (e: any) => {
    const y = e.nativeEvent.contentOffset.y;
    const idx = Math.floor(y / 220);
    api.trackEvent("scroll_depth", { value: idx }).catch(() => {});
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header} testID="home-header">
        <View>
          <Text style={styles.hello}>你好{child ? `，${child.nickname}的家长` : ""}</Text>
          <Text style={styles.headerSub}>
            {child
              ? `${monthsOf(child.birth_date)}月龄 · 今天为你准备了 ${cards.length} 条`
              : "今天为你准备了一些内容"}
          </Text>
        </View>
        <Pressable
          testID="home-free-chat-btn"
          onPress={async () => {
            const s = await api.startSession({ script_key: "free" });
            router.push(`/chat/${s.id}`);
          }}
          style={styles.headerBtn}
        >
          <Ionicons name="sparkles-outline" size={18} color={colors.brand} />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.brand}
            />
          }
          onScroll={onScroll}
          scrollEventThrottle={200}
          showsVerticalScrollIndicator={false}
          testID="home-feed-scroll"
        >
          {cards.map((card) => (
            <View
              key={card.id}
              style={styles.card}
              testID={`feed-card-${card.id}`}
            >
              <View style={styles.cardTopRow}>
                <View
                  style={[
                    styles.typeChip,
                    { backgroundColor: TAG_BG[card.type] },
                  ]}
                  testID={`feed-card-tag-${card.type}`}
                >
                  <Ionicons
                    name={ICON_BY_TYPE[card.type]}
                    size={12}
                    color={TAG_FG[card.type]}
                  />
                  <Text style={[styles.typeChipText, { color: TAG_FG[card.type] }]}>
                    {card.type_label}
                  </Text>
                </View>
                {card.type === "product" && (
                  <Text style={styles.sponsored}>赞助</Text>
                )}
              </View>

              {card.image_url ? (
                <Image
                  source={{ uri: card.image_url }}
                  style={styles.cardImg}
                  contentFit="cover"
                  transition={200}
                />
              ) : null}

              <Text style={styles.cardTitle}>{card.title}</Text>
              <Text style={styles.cardSummary}>{card.summary}</Text>

              <Pressable
                onPress={() => askAI(card)}
                style={styles.askBtn}
                testID={`feed-card-ask-${card.id}`}
              >
                <Text style={styles.askBtnText}>问问AI</Text>
                <Ionicons name="arrow-forward" size={14} color={colors.brand} />
              </Pressable>
            </View>
          ))}
          <View style={{ height: spacing.xxxl }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function monthsOf(birth: string) {
  try {
    const b = new Date(birth);
    const n = new Date();
    return Math.max(
      0,
      (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth())
    );
  } catch {
    return 0;
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  hello: { fontSize: type.xl, fontWeight: "700", color: colors.onSurface },
  headerSub: { fontSize: type.sm, color: colors.muted, marginTop: 2 },
  headerBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  typeChip: {
    flexDirection: "row",
    gap: 4,
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  typeChipText: { fontSize: type.sm, fontWeight: "600" },
  sponsored: { fontSize: 10, color: colors.muted, fontStyle: "italic" },
  cardImg: {
    width: "100%",
    height: 140,
    borderRadius: radius.sm,
    marginBottom: spacing.md,
    backgroundColor: colors.surfaceTertiary,
  },
  cardTitle: {
    fontSize: type.lg,
    fontWeight: "700",
    color: colors.onSurface,
    lineHeight: 22,
  },
  cardSummary: {
    fontSize: type.base,
    color: colors.muted,
    lineHeight: 20,
    marginTop: spacing.sm,
  },
  askBtn: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    backgroundColor: colors.brandTertiary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
  askBtnText: { color: colors.brand, fontWeight: "700", fontSize: type.base },
});
