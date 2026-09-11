// Today's daily card, in full: what another parent did, in their own words
// where we could verify them, why it was picked for this family, and two ways
// on — the original post, or talking it through with NURI.
//
// Reads the same GET /feed/daily-post as Home; by the time a parent gets here
// the card exists, so this is a row read, not a second generation.
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";

import { api, type DailyPostCard } from "@/src/api";
import { dailyPostGreeting, dailyPostTag } from "@/src/components/DailyPostCard";
import { useT } from "@/src/i18n";

const C = {
  canvas: "#FFF9F3",
  text: "#261B45",
  soft: "#5B5272",
  purple: "#4C368C",
  line: "rgba(38,27,69,0.12)",
  quote: "#F3EEFF",
  caution: "#FFF1E6",
};

export default function DailyPostScreen() {
  const { t, locale } = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const pageWidth = Math.min(width, 402);
  const [card, setCard] = useState<DailyPostCard | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [openingChat, setOpeningChat] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getDailyPost()
      .then((res) => {
        if (cancelled) return;
        if (res.state === "ready" && res.card) {
          setCard(res.card);
          setState("ready");
        } else {
          setState("missing");
        }
      })
      .catch(() => !cancelled && setState("missing"));
    return () => {
      cancelled = true;
    };
  }, []);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)"));

  const openSource = useCallback(() => {
    if (!card || !/^https:\/\//i.test(card.source_url)) return;
    void api.dailyPostEvent(card.id, "source_click").catch(() => {});
    // Opened inside the tap's own call stack so browsers don't treat the new
    // tab as an unsolicited popup.
    const opening =
      Platform.OS === "web" ? Linking.openURL(card.source_url) : WebBrowser.openBrowserAsync(card.source_url);
    void opening.catch(() => {});
  }, [card]);

  const talkItThrough = useCallback(async () => {
    if (!card || openingChat) return;
    setOpeningChat(true);
    try {
      // The server records the chat and drops a marker into the one
      // conversation, so NURI's next reply knows which post this is about.
      const session = await api.startSession({ card_id: card.card_id });
      router.push(`/chat/${session.id}`);
    } catch {
      setOpeningChat(false);
    }
  }, [card, openingChat, router]);

  if (state === "loading") {
    return (
      <View style={[styles.safe, styles.center]}>
        <ActivityIndicator color={C.purple} />
      </View>
    );
  }

  if (state === "missing" || !card) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={[styles.page, { width: pageWidth }]}>
          <BackButton onPress={goBack} label={t("返回")} />
          <Text style={styles.body}>{t("今天的家长经验暂时打不开，回首页再试试。")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const quoteNote =
    card.excerpt_lang === "en" && locale !== "en"
      ? t("原帖摘录（英文原文）")
      : card.excerpt_lang === "zh" && locale === "en"
        ? t("原帖摘录（中文原文）")
        : t("原帖摘录");
  const basisNote =
    card.basis === "conversation"
      ? locale === "en"
        ? t("根据你最近和NURI聊的内容找到")
        : t("根据你最近和NURI聊的「{concern}」找到", { concern: card.concern })
      : locale === "en"
        ? t("根据孩子现在的阶段找到")
        : t("根据孩子现在的阶段（{concern}）找到", { concern: card.concern });

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={{ alignItems: "center", paddingBottom: 40 }}>
        <View style={[styles.page, { width: pageWidth }]}>
          <BackButton onPress={goBack} label={t("返回")} />

          <Text style={styles.greeting} testID="daily-post-greeting">
            {dailyPostGreeting(t, card.nickname, card.audience)}
          </Text>
          <View style={styles.tagRow}>
            <View style={styles.tagPill}>
              <Text style={styles.tagText}>{dailyPostTag(t, card)}</Text>
            </View>
            <Text style={styles.basis} numberOfLines={2}>{basisNote}</Text>
          </View>

          <Text style={styles.headline} testID="daily-post-headline">{card.headline}</Text>

          <Text style={styles.sectionLabel}>
            {card.author_kind === "parent_group_answers" ? t("大家的建议") : t("这位家长的做法")}
          </Text>
          {card.takeaways.map((item, index) => (
            <View key={`${index}:${item}`} style={styles.bulletRow}>
              <View style={styles.bulletDot} />
              <Text style={styles.body}>{item}</Text>
            </View>
          ))}

          {card.excerpt ? (
            <View style={styles.quoteBox} testID="daily-post-excerpt">
              <Text style={styles.quoteLabel}>{quoteNote}</Text>
              <Text style={styles.quoteText}>“{card.excerpt}”</Text>
            </View>
          ) : null}
          {card.summary_source === "facebook_ai_summary" ? (
            <Text style={styles.small}>
              {t("这条内容来自 Facebook 对这篇讨论的自动摘要，不是发帖人的原话。")}
            </Text>
          ) : null}

          {card.why_this ? (
            <>
              <Text style={styles.sectionLabel}>{t("为什么推荐给你")}</Text>
              <Text style={styles.body}>{card.why_this}</Text>
            </>
          ) : null}

          {card.caution ? (
            <View style={styles.cautionBox}>
              <Ionicons name="alert-circle-outline" size={18} color="#B4541A" />
              <Text style={[styles.body, { flex: 1 }]}>{card.caution}</Text>
            </View>
          ) : null}

          <Text style={styles.small}>
            {t("这是其他家长的个人经验，不是专业建议。每个孩子都不一样，拿不准的地方可以问问NURI或医生。")}
          </Text>
          <Text style={styles.source} numberOfLines={2}>
            {t("来源：{source}", { source: card.source_label })}
          </Text>

          <Pressable
            onPress={talkItThrough}
            disabled={openingChat}
            style={({ pressed }) => [styles.primary, (pressed || openingChat) && styles.pressed]}
            accessibilityRole="button"
            testID="daily-post-chat"
          >
            <Text style={styles.primaryText}>
              {openingChat ? t("正在打开…") : t("和NURI聊聊这个")}
            </Text>
          </Pressable>
          <Pressable
            onPress={openSource}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            accessibilityRole="link"
            testID="daily-post-source"
          >
            <Text style={styles.secondaryText}>{t("查看原帖")}</Text>
            <Ionicons name="open-outline" size={16} color={C.purple} />
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function BackButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable onPress={onPress} style={styles.back} hitSlop={8} accessibilityRole="button" testID="daily-post-back">
      <Ionicons name="chevron-back" size={20} color={C.text} />
      <Text style={styles.backText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  center: { alignItems: "center", justifyContent: "center" },
  page: { alignSelf: "center", paddingHorizontal: 20 },
  back: { flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 12, alignSelf: "flex-start" },
  backText: { color: C.text, fontFamily: "NotoSansSC_600SemiBold", fontSize: 14 },
  greeting: { color: C.text, fontFamily: "NotoSansSC_700Bold", fontSize: 22, lineHeight: 30, marginTop: 4 },
  tagRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" },
  tagPill: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999,
    backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: C.line,
  },
  tagText: { color: C.text, fontFamily: "NotoSansSC_400Regular", fontSize: 12 },
  basis: { flex: 1, minWidth: 140, color: C.soft, fontFamily: "NotoSansSC_400Regular", fontSize: 12 },
  headline: { color: C.text, fontFamily: "NotoSansSC_600SemiBold", fontSize: 18, lineHeight: 26, marginTop: 18 },
  sectionLabel: {
    color: C.soft, fontFamily: "NotoSansSC_700Bold", fontSize: 13, letterSpacing: 0.5,
    marginTop: 22, marginBottom: 8,
  },
  bulletRow: { flexDirection: "row", gap: 10, alignItems: "flex-start", marginBottom: 8 },
  bulletDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.purple, marginTop: 9 },
  body: { color: C.text, fontFamily: "NotoSansSC_400Regular", fontSize: 15, lineHeight: 23, flexShrink: 1 },
  quoteBox: { backgroundColor: C.quote, borderRadius: 16, padding: 16, marginTop: 18 },
  quoteLabel: { color: C.soft, fontFamily: "NotoSansSC_600SemiBold", fontSize: 12, marginBottom: 6 },
  quoteText: { color: C.text, fontFamily: "NotoSansSC_400Regular", fontSize: 15, lineHeight: 24 },
  cautionBox: {
    flexDirection: "row", gap: 8, alignItems: "flex-start", backgroundColor: C.caution,
    borderRadius: 14, padding: 12, marginTop: 18,
  },
  small: { color: C.soft, fontFamily: "NotoSansSC_400Regular", fontSize: 12, lineHeight: 18, marginTop: 18 },
  source: { color: C.soft, fontFamily: "NotoSansSC_400Regular", fontSize: 12, marginTop: 6 },
  primary: {
    marginTop: 26, borderRadius: 999, backgroundColor: C.purple, paddingVertical: 15, alignItems: "center",
  },
  primaryText: { color: "#FFFFFF", fontFamily: "NotoSansSC_700Bold", fontSize: 15 },
  secondary: {
    marginTop: 12, borderRadius: 999, borderWidth: 1, borderColor: C.purple, paddingVertical: 13,
    alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 6,
  },
  secondaryText: { color: C.purple, fontFamily: "NotoSansSC_700Bold", fontSize: 15 },
  pressed: { opacity: 0.75 },
});
