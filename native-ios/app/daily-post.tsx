// Short AI search previews are distinct from NURI's own reading prompts.
import { useCallback, useRef } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
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
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { Ionicons } from "@expo/vector-icons";

import { api, type DailyPostCard } from "@/src/api";
import { dailyPostGreeting, dailyPostTag } from "@/src/components/DailyPostCard";
import { externalSourceUrl, externalSourceHost } from "@/src/externalContent";
import { nuriResourceGuide } from "@/src/nuriResourceGuide";
import { shortResourceSummary, RESOURCE_SUMMARY_DISCLOSURE } from "@/src/resourceSummary";
import { useT } from "@/src/i18n";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { requestFailureKind, type RequestFailureKind } from "@/src/requestFailure";
import RequestFailureNotice from "@/src/components/RequestFailureNotice";

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
  const { capture, current } = useAccountScope();
  const { t } = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const pageWidth = Math.min(width, 402);
  const [card, setCard] = useState<DailyPostCard | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [openingChat, setOpeningChat] = useState(false);
  const [failure, setFailure] = useState<RequestFailureKind | null>(null);
  const [failureSource, setFailureSource] = useState<"load" | "chat">("load");
  const [retry, setRetry] = useState(0);
  const [sourceFailure, setSourceFailure] = useState(false);
  const focused = useRef(false);
  const chatOperation = useRef(0);
  const chatBusy = useRef(false);
  // Set when a care notification opens a specific card; otherwise today's.
  const { id } = useLocalSearchParams<{ id?: string }>();

  useFocusEffect(useCallback(() => {
    const ticket = capture();
    if (ticket === null) return;
    let cancelled = false;
    focused.current = true;
    chatOperation.current++;
    chatBusy.current = false;
    setFailure(null);
    setSourceFailure(false);
    setOpeningChat(false);
    setState((previous) => previous === "ready" && retry === 0 ? previous : "loading");
    (id ? api.getDailyPostById(String(id)) : api.getDailyPost())
      .then((res) => {
        if (cancelled || !current(ticket)) return;
        setFailureSource("load");
        if (res.state === "ready" && res.card) {
          setCard(res.card);
          setState("ready");
        } else {
          setState("missing");
        }
      })
      .catch((error) => {
        if (cancelled || !current(ticket)) return;
        setFailureSource("load");
        setFailure(requestFailureKind(error));
        setState("missing");
      });
    return () => {
      cancelled = true;
      focused.current = false;
      chatOperation.current++;
      chatBusy.current = false;
    };
  }, [id, retry, capture, current, setCard, setState, setFailure, setOpeningChat, setFailureSource, setSourceFailure]));

  const goBack = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)"));

  const openSource = useCallback(async () => {
    const ticket = capture();
    if (ticket === null || !focused.current || !card) return;
    const source = externalSourceUrl(card.source_url);
    if (!source) { setSourceFailure(true); return; }
    setSourceFailure(false);
    void api.dailyPostEvent(card.id, "source_click").catch(() => {});
    try { await Linking.openURL(source); }
    catch { if (current(ticket) && focused.current) setSourceFailure(true); }
  }, [card, capture, current, setSourceFailure]);

  const talkItThrough = useCallback(async () => {
    const ticket = capture();
    if (ticket === null) return;
    if (!card || !focused.current || chatBusy.current) return;
    const operation = ++chatOperation.current;
    const acceptsResult = () => current(ticket) && focused.current && operation === chatOperation.current;
    chatBusy.current = true;
    setFailure(null);
    setOpeningChat(true);
    try {
      // The server records the chat and drops a marker into the one
      // conversation, so NURI's next reply knows which post this is about.
      const session = await api.startSession({ card_id: card.card_id });
      if (!acceptsResult()) return;
      router.push(`/chat/${session.id}`);
    } catch (error) {
      if (!acceptsResult()) return;
      setFailureSource("chat");
      setFailure(requestFailureKind(error));
      chatBusy.current = false;
      setOpeningChat(false);
    }
  }, [card, router, capture, current, setOpeningChat, setFailure, setFailureSource]);

  const failureNotice = failure ? <RequestFailureNotice error={failure}
    onRetry={() => failureSource === "chat" ? void talkItThrough() : setRetry((value) => value + 1)}
    onPermission={() => router.push(aiPermissionHref("/daily-post"))}
    onLogin={() => router.push("/login")} /> : null;

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
          {failureNotice || <Text style={styles.body}>{t("今天的家长经验暂时打不开，回首页再试试。")}</Text>}
        </View>
      </SafeAreaView>
    );
  }

  const basisNote = card.basis === "conversation"
    ? t("根据你最近和NURI聊的内容找到") : t("根据孩子现在的阶段找到");
  const guide = nuriResourceGuide({ concern: card.concern }, t);
  const sourceAvailable = Boolean(externalSourceUrl(card.source_url));
  const question = sourceAvailable ? shortResourceSummary(card.question, 110) || shortResourceSummary(card.headline, 110) : null;
  const situation = sourceAvailable ? shortResourceSummary(card.situation, 240) : null;
  const takeaways = sourceAvailable && Array.isArray(card.takeaways)
    ? card.takeaways.slice(0, 2).map((value) => shortResourceSummary(value, 120)).filter((value): value is string => Boolean(value)) : [];
  const reason = sourceAvailable ? shortResourceSummary(card.why_this, 200) : null;
  const caution = sourceAvailable ? shortResourceSummary(card.caution, 240) : null;
  const hasSummary = Boolean(question || situation || takeaways.length);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={{ alignItems: "center", paddingBottom: 40 }}>
        <View style={[styles.page, { width: pageWidth }]}>
          <BackButton onPress={goBack} label={t("返回")} />
          {failureNotice}

          <Text style={styles.greeting} testID="daily-post-greeting">
            {dailyPostGreeting(t, card.nickname, card.audience)}
          </Text>
          <View style={styles.tagRow}>
            <View style={styles.tagPill}>
              <Text style={styles.tagText}>{dailyPostTag(t, card)}</Text>
            </View>
            <Text style={styles.basis} numberOfLines={2}>{basisNote}</Text>
          </View>

          <View style={styles.askBox} testID="daily-post-ai-summary">
            <Text style={styles.guideLabel}>{t("AI 检索摘要")}</Text>
            {hasSummary ? <>
              {question ? <Text style={styles.question} testID="daily-post-summary-question">{question}</Text> : null}
              {situation ? <Text style={styles.situation} testID="daily-post-summary-situation">{situation}</Text> : null}
              {takeaways.map((value, index) => <View key={`${index}:${value}`} style={styles.guideAction} testID={`daily-post-summary-point-${index}`}>
                <Text style={styles.guideNumber}>{index + 1}</Text><Text style={styles.body}>{value}</Text>
              </View>)}
            </> : <Text style={styles.body} testID="daily-post-summary-empty">{t("这条资源暂时没有可用摘要，请打开原站查看。")}</Text>}
            <Text style={styles.small} testID="daily-post-summary-disclosure">{t(RESOURCE_SUMMARY_DISCLOSURE)}</Text>
            {card.summary_source === "facebook_ai_summary" ? <Text style={styles.small} testID="daily-post-summary-basis">{t("此摘要根据检索到的 Facebook AI 摘要再整理，不是原帖逐字引用。")}</Text> : null}
          </View>
          {reason ? <View testID="daily-post-recommendation-reason"><Text style={styles.sectionLabel}>{t("为什么推荐给你")}</Text><Text style={styles.body}>{reason}</Text></View> : null}
          {caution ? <Text style={styles.small} testID="daily-post-summary-caution">{caution}</Text> : null}

          <View style={styles.askBox} testID="daily-post-question">
            <Text style={styles.guideLabel}>{t("NURI 导读")}</Text>
            <Text style={styles.question} testID="daily-post-guide-headline">{guide.headline}</Text>
            <Text style={[styles.body, styles.guideIntro]} testID="daily-post-guide-intro">{guide.intro}</Text>
            {guide.actions.map((action, index) => (
              <View key={`${index}:${action}`} style={styles.guideAction} testID={`daily-post-guide-action-${index}`}>
                <Text style={styles.guideNumber}>{index + 1}</Text>
                <Text style={styles.body}>{action}</Text>
              </View>
            ))}
            <Text style={styles.small} testID="daily-post-guide-disclosure">{guide.disclosure}</Text>
          </View>

          <Text style={styles.small}>
            {t("原站的家长经验不代替专业建议。每个孩子都不一样，涉及健康或安全的问题请咨询合适的专业人员。")}
          </Text>
          <Text style={styles.source} numberOfLines={2}>
            {t("来源：{source}", { source: externalSourceHost(card.source_url) || dailyPostTag(t, card) })}
          </Text>

          <Pressable onPress={() => void openSource()} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            accessibilityRole="link" testID="daily-post-source">
            <Text style={styles.primaryText}>{t("打开原站链接")}</Text>
          </Pressable>
          {sourceFailure ? <Text style={styles.small} accessibilityLiveRegion="polite" testID="daily-post-source-error">
            {t("外部内容暂时无法打开，请稍后再试")}
          </Text> : null}

          <Pressable
            onPress={talkItThrough}
            disabled={openingChat}
            style={({ pressed }) => [styles.secondary, (pressed || openingChat) && styles.pressed]}
            accessibilityRole="button"
            testID="daily-post-chat"
          >
            <Text style={styles.secondaryText}>
              {openingChat ? t("正在打开…") : t("和NURI聊聊这个")}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function BackButton({ onPress, label }: { onPress: () => void; label: string }) {
  if (Platform.OS !== "web") return null;
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
  askBox: { backgroundColor: "#FFFFFF", padding: 18, borderRadius: 20, borderWidth: 1, borderColor: C.line, marginTop: 18 },
  guideLabel: { color: C.purple, fontFamily: "NotoSansSC_700Bold", fontSize: 13, lineHeight: 20, marginBottom: 8 },
  guideIntro: { marginTop: 14 },
  guideAction: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 16 },
  guideNumber: { color: C.purple, fontFamily: "NotoSansSC_700Bold", fontSize: 14, lineHeight: 23, minWidth: 20 },
  asker: { color: C.soft, fontFamily: "NotoSansSC_600SemiBold", fontSize: 12, marginBottom: 8 },
  question: { color: C.text, fontFamily: "NotoSansSC_700Bold", fontSize: 19, lineHeight: 27 },
  situation: { color: C.soft, fontFamily: "NotoSansSC_400Regular", fontSize: 14, lineHeight: 22, marginTop: 10 },
  headline: { color: C.text, fontFamily: "NotoSansSC_600SemiBold", fontSize: 17, lineHeight: 25, marginBottom: 10 },
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
