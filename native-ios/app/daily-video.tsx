import { useCallback, useRef } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, type DailyVideoCard } from "@/src/api";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import RequestFailureNotice from "@/src/components/RequestFailureNotice";
import YouTubePlayer, { isYouTubeVideoId, openYouTubeLink } from "@/src/components/YouTubePlayer";
import { requestFailureKind, type RequestFailureKind } from "@/src/requestFailure";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { useT } from "@/src/i18n";

export default function DailyVideoScreen() {
  const { capture, current } = useAccountScope();
  const { t } = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === "string" ? params.id : undefined;
  const { width } = useWindowDimensions();
  const pageWidth = Math.min(width, 402);
  const [card, setCard] = useState<DailyVideoCard | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [summary, setSummary] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [failure, setFailure] = useState<RequestFailureKind | null>(null);
  const [failureSource, setFailureSource] = useState<"load" | "summary" | "chat">("load");
  const [retry, setRetry] = useState(0);
  const [active, setActive] = useState(false);
  const [openingChat, setOpeningChat] = useState(false);
  const [sourceFailure, setSourceFailure] = useState(false);
  const focused = useRef(false), operation = useRef(0), chatBusy = useRef(false), summaryOperation = useRef(0), sourceOperation = useRef(0);

  const loadSummary = useCallback(async (video: DailyVideoCard) => {
    const ticket = capture();
    if (ticket === null || !focused.current) return;
    const request = ++summaryOperation.current;
    const accepts = () => current(ticket) && focused.current && request === summaryOperation.current;
    if (video.summary?.trim()) { setSummary(video.summary); setSummaryLoading(false); return; }
    setSummaryLoading(true);
    setFailure(null);
    try {
      const result = await api.getDailyVideoSummary(video.id);
      if (accepts()) setSummary(result.summary || "");
    } catch (error) {
      if (accepts()) { setFailureSource("summary"); setFailure(requestFailureKind(error)); }
    } finally { if (accepts()) setSummaryLoading(false); }
  }, [capture, current, setSummary, setSummaryLoading, setFailure, setFailureSource]);

  useFocusEffect(useCallback(() => {
    const ticket = capture();
    if (ticket === null) return;
    let cancelled = false;
    focused.current = true; setActive(true); chatBusy.current = false; operation.current++; sourceOperation.current++;
    setOpeningChat(false); setFailure(null); setSummaryLoading(false); setSourceFailure(false);
    setState((previous) => retry === 0 && previous === "ready" ? "ready" : "loading");
    const accepts = () => current(ticket) && !cancelled && focused.current;
    void (async () => {
      if (id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        if (accepts()) { setCard(null); setState("missing"); } return;
      }
      try {
        const result = await (id ? api.getDailyVideoById(id) : api.getDailyVideo());
        if (!accepts()) return;
        if (result.state === "ready" && result.card && isYouTubeVideoId(result.card.video_id)) {
          setCard(result.card); setState("ready"); setSummary(result.card.summary || "");
          void loadSummary(result.card);
        } else { setCard(null); setState("missing"); }
      } catch (error) {
        if (accepts()) { setFailureSource("load"); setFailure(requestFailureKind(error)); setState("missing"); }
      }
    })();
    return () => { cancelled = true; focused.current = false; setActive(false); operation.current++; summaryOperation.current++; sourceOperation.current++; chatBusy.current = false; };
  }, [capture, current, id, retry, loadSummary, setActive, setOpeningChat, setFailure, setSummaryLoading, setState, setCard, setSummary, setFailureSource, setSourceFailure]));

  const talk = async () => {
    const ticket = capture();
    if (ticket === null || !focused.current || !card || chatBusy.current) return;
    chatBusy.current = true; setOpeningChat(true); setFailure(null);
    const request = ++operation.current;
    const accepts = () => current(ticket) && focused.current && request === operation.current;
    try {
      const session = await api.startSession({ card_id: card.card_id });
      if (!accepts()) return;
      void api.dailyVideoEvent(card.id, "chat").catch(() => {});
      router.push(`/chat/${session.id}`);
    } catch (error) {
      if (accepts()) { setFailureSource("chat"); setFailure(requestFailureKind(error)); }
    } finally { if (accepts()) { chatBusy.current = false; setOpeningChat(false); } }
  };
  const openSource = async () => {
    const ticket = capture();
    if (ticket === null || !focused.current || !card || !isYouTubeVideoId(card.video_id)) return;
    const request = ++sourceOperation.current;
    // Build from the validated ID, not an arbitrary backend-provided URL.
    setSourceFailure(false);
    void api.dailyVideoEvent(card.id, "source_click").catch(() => {});
    const opened = await openYouTubeLink(`https://www.youtube.com/watch?v=${card.video_id}`);
    if (current(ticket) && focused.current && request === sourceOperation.current) setSourceFailure(!opened);
  };
  const notice = failure ? <RequestFailureNotice error={failure}
    onRetry={() => failureSource === "chat" ? void talk() : failureSource === "summary" && card ? void loadSummary(card) : setRetry((n) => n + 1)}
    onPermission={() => router.push(aiPermissionHref("/daily-video"))}
    onLogin={() => router.push("/login")} /> : null;

  if (state === "loading") return <SafeAreaView style={[styles.safe, styles.center]}><ActivityIndicator color="#4C368C" /></SafeAreaView>;
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
    <View style={[styles.page, { width: pageWidth }]}>
      {notice}
      {!card ? !failure ? <View style={styles.missing}><Text style={styles.body}>{t("这个视频暂时打不开，回首页再试试。")}</Text>
        <Pressable onPress={() => setRetry((n) => n + 1)} style={styles.secondary} testID="daily-video-load-retry"><Text style={styles.secondaryText}>{t("重试")}</Text></Pressable></View> : null : <>
        <Text style={styles.intro} testID="daily-video-intro">{card.intro}</Text>
        <YouTubePlayer videoId={card.video_id} width={Math.max(0, pageWidth - 40)} active={active} />
        <Text style={styles.title} testID="daily-video-title">{card.title}</Text>
        <Text style={styles.meta}>YouTube · {card.channel} · {card.video_lang === "zh" ? t("中文视频") : t("英文视频")}</Text>
        <Text style={styles.label}>{t("NURI帮你看了视频简介")}</Text>
        {card.display_title && card.display_title !== card.title ? <Text style={styles.guideTitle} testID="daily-video-guide-title">{card.display_title}</Text> : null}
        {summaryLoading ? <View style={styles.summaryLoading}><ActivityIndicator color="#4C368C" /><Text style={styles.small}>{t("正在整理视频要点…")}</Text></View>
          : summary ? <Text style={styles.body} testID="daily-video-summary">{summary}</Text> : null}
        <Text style={styles.small}>{t("要点根据视频标题和简介整理，NURI没有看视频画面，具体以视频为准。视频是外部内容，不是专业诊断。")}</Text>
        <Pressable onPress={() => void talk()} disabled={openingChat} style={styles.primary} accessibilityRole="button" testID="daily-video-chat"><Text style={styles.primaryText}>{openingChat ? t("正在打开…") : t("和NURI聊聊这个")}</Text></Pressable>
        <Pressable onPress={() => void openSource()} style={styles.secondary} accessibilityRole="link" testID="daily-video-source"><Text style={styles.secondaryText}>{t("在YouTube打开")}</Text><Ionicons name="open-outline" size={16} color="#4C368C" /></Pressable>
        {sourceFailure ? <Text style={styles.small} accessibilityLiveRegion="polite" testID="daily-video-source-error">{t("外部内容暂时无法打开，请稍后再试")}</Text> : null}
      </>}
    </View>
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#FFF9F3" }, center: { alignItems: "center", justifyContent: "center" },
  page: { alignSelf: "center", paddingHorizontal: 20 }, missing: { paddingTop: 36 },
  intro: { color: "#261B45", fontFamily: "NotoSansSC_700Bold", fontSize: 22, lineHeight: 30, marginTop: 12 },
  title: { color: "#261B45", fontFamily: "NotoSansSC_700Bold", fontSize: 19, lineHeight: 27, marginTop: 18 },
  guideTitle: { color: "#261B45", fontFamily: "NotoSansSC_600SemiBold", fontSize: 16, lineHeight: 24, marginBottom: 12 },
  meta: { color: "#5B5272", fontSize: 12, marginTop: 8 }, label: { color: "#5B5272", fontFamily: "NotoSansSC_700Bold", fontSize: 13, marginTop: 24, marginBottom: 10 },
  body: { color: "#261B45", fontFamily: "NotoSansSC_400Regular", fontSize: 15, lineHeight: 24 },
  small: { color: "#5B5272", fontFamily: "NotoSansSC_400Regular", fontSize: 12, lineHeight: 18, marginTop: 16 },
  summaryLoading: { flexDirection: "row", gap: 12, alignItems: "center" },
  primary: { marginTop: 26, minHeight: 48, borderRadius: 999, backgroundColor: "#4C368C", alignItems: "center", justifyContent: "center", padding: 12 },
  primaryText: { color: "#FFFFFF", fontFamily: "NotoSansSC_700Bold", fontSize: 15 },
  secondary: { marginTop: 12, minHeight: 48, borderRadius: 999, borderWidth: 1, borderColor: "#4C368C", alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6, padding: 12 },
  secondaryText: { color: "#4C368C", fontFamily: "NotoSansSC_700Bold", fontSize: 15 },
});
