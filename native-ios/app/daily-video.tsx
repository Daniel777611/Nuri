import { useCallback, useRef } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { api, aiConsent, type DailyVideoCard } from "@/src/api";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import RequestFailureNotice from "@/src/components/RequestFailureNotice";
import { isYouTubeVideoId, openYouTubeLink } from "@/src/components/YouTubePlayer";
import { requestFailureKind, type RequestFailureKind } from "@/src/requestFailure";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { useT } from "@/src/i18n";
import { nuriResourceGuide } from "@/src/nuriResourceGuide";
import { resourceSummary } from "@/src/resourceSummary";
import { useAIConsent } from "@/src/useAIConsent";

export default function DailyVideoScreen() {
  const { capture, current } = useAccountScope();
  const { t } = useT();
  const { state: permission } = useAIConsent();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === "string" ? params.id : undefined;
  const permissionReturn = id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? `/daily-video?id=${encodeURIComponent(id)}` : "/daily-video";
  const { width } = useWindowDimensions();
  const pageWidth = Math.min(width, 402);
  const [card, setCard] = useState<DailyVideoCard | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [failure, setFailure] = useState<RequestFailureKind | null>(null);
  const [failureSource, setFailureSource] = useState<"load" | "chat">("load");
  const [retry, setRetry] = useState(0);
  const [openingChat, setOpeningChat] = useState(false);
  const [openingSource, setOpeningSource] = useState(false);
  const [sourceFailure, setSourceFailure] = useState(false);
  const [summaryResult, setSummaryResult] = useState<{ cardId: string; text: string } | null>(null);
  const [summaryState, setSummaryState] = useState<"idle" | "loading" | "ready" | "empty" | "failed">("idle");
  const [summaryFailure, setSummaryFailure] = useState<RequestFailureKind | null>(null);
  const [summaryRetry, setSummaryRetry] = useState(0);
  const summaryOperation = useRef(0), summaryBusy = useRef(false);
  const summaryCardId = card?.id, summaryLocale = card?.locale, savedSummary = card?.summary;
  const focused = useRef(false), operation = useRef(0), chatBusy = useRef(false), sourceOperation = useRef(0), sourceBusy = useRef(false);

  useFocusEffect(useCallback(() => {
    const ticket = capture();
    if (ticket === null) return;
    let cancelled = false;
    focused.current = true; chatBusy.current = false; sourceBusy.current = false; operation.current++; sourceOperation.current++;
    setOpeningChat(false); setOpeningSource(false); setFailure(null); setSourceFailure(false);
    setState((previous) => retry === 0 && previous === "ready" ? "ready" : "loading");
    const accepts = () => current(ticket) && !cancelled && focused.current;
    void (async () => {
      if (id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        if (accepts()) { setCard(null); setState("missing"); } return;
      }
      try {
        const result = await (id ? api.getDailyVideoById(id) : api.getDailyVideo());
        if (!accepts()) return;
        if (result.state === "ready" && result.card && (id === undefined || result.card.id === id) && isYouTubeVideoId(result.card.video_id)) {
          setCard(result.card); setState("ready");
        } else { setCard(null); setState("missing"); }
      } catch (error) {
        if (accepts()) { setCard(null); setFailureSource("load"); setFailure(requestFailureKind(error)); setState("missing"); }
      }
    })();
    return () => { cancelled = true; focused.current = false; operation.current++; sourceOperation.current++; chatBusy.current = false; sourceBusy.current = false; };
  }, [capture, current, id, retry, setOpeningChat, setOpeningSource, setFailure, setState, setCard, setFailureSource, setSourceFailure]));

  // A saved summary is read-only. Only a missing one uses the existing,
  // consent-gated shared-backend generation route. Never turn a user's topic
  // guide into a purported source summary, or keep a late result across focus,
  // route, permission or account changes.
  useFocusEffect(useCallback(() => {
    // The retry counter intentionally invalidates only this summary effect.
    void summaryRetry;
    const ticket = capture();
    const request = ++summaryOperation.current;
    let cancelled = false;
    setSummaryResult(null); setSummaryFailure(null);
    const accepts = () => !cancelled && focused.current && current(ticket) && request === summaryOperation.current;
    const cleanup = () => { cancelled = true; summaryOperation.current++; summaryBusy.current = false; };
    if (ticket === null || !summaryCardId || (id !== undefined && summaryCardId !== id)) {
      setSummaryState("idle"); return cleanup;
    }
    const limit = summaryLocale === "en" ? 750 : 190;
    const cached = resourceSummary(savedSummary, { limit, locale: summaryLocale });
    if (cached) {
      setSummaryResult({ cardId: summaryCardId, text: cached }); setSummaryState("ready"); return cleanup;
    }
    if (permission.status !== "allowed") {
      const waiting = permission.status === "unknown" || permission.status === "loading";
      setSummaryState(waiting ? "loading" : "failed");
      if (!waiting) setSummaryFailure(permission.status === "signed_out" ? "session" : permission.status === "error" ? "service" : "permission");
      return cleanup;
    }
    summaryBusy.current = true; setSummaryState("loading");
    void (async () => {
      try {
        const result = await api.getDailyVideoSummary(summaryCardId);
        const latestPermission = aiConsent.getState();
        if (!accepts() || latestPermission.status !== "allowed" || latestPermission.session !== permission.session) return;
        const text = resourceSummary(result.summary, { limit, locale: summaryLocale });
        setSummaryResult(text ? { cardId: summaryCardId, text } : null);
        setSummaryState(text ? "ready" : "empty");
      } catch (error) {
        if (accepts()) { setSummaryFailure(requestFailureKind(error)); setSummaryState("failed"); }
      } finally { if (accepts()) summaryBusy.current = false; }
    })();
    // Ignoring a late response does not claim to cancel backend work already
    // started; the API owns its timeout/account abort and permission lease.
    return cleanup;
  }, [capture, current, summaryCardId, summaryLocale, savedSummary, id, permission.status, permission.session, summaryRetry, setSummaryResult, setSummaryFailure, setSummaryState]));

  const retrySummary = () => { if (!summaryBusy.current && focused.current) setSummaryRetry((value) => value + 1); };

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
    if (ticket === null || !focused.current || !card || !isYouTubeVideoId(card.video_id) || sourceBusy.current) return;
    const request = ++sourceOperation.current;
    // Build from the validated ID, not an arbitrary backend-provided URL.
    sourceBusy.current = true; setOpeningSource(true); setSourceFailure(false);
    void api.dailyVideoEvent(card.id, "source_click").catch(() => {});
    const opened = await openYouTubeLink(`https://www.youtube.com/watch?v=${card.video_id}`);
    if (current(ticket) && focused.current && request === sourceOperation.current) {
      sourceBusy.current = false; setOpeningSource(false); setSourceFailure(!opened);
    }
  };
  const notice = failure ? <RequestFailureNotice error={failure}
    onRetry={() => failureSource === "chat" ? void talk() : setRetry((n) => n + 1)}
    onPermission={() => router.push(aiPermissionHref(permissionReturn))}
    onLogin={() => router.push("/login")} /> : null;
  // NURI's own reading prompts depend on the user's topic only. Do not
  // repurpose source metadata or fetched summaries as a supposed video guide.
  const guide = card ? nuriResourceGuide({ concern: card.concern }, t) : null;
  const shortPoints = card ? resourceSummary(card.key_points, { limit: card.locale === "en" ? 280 : 90, locale: card.locale }) : null;
  const summary = card && summaryResult?.cardId === card.id ? summaryResult.text : null;

  if (state === "loading" || (card && id !== undefined && card.id !== id)) return <SafeAreaView style={[styles.safe, styles.center]}><ActivityIndicator color="#4C368C" /></SafeAreaView>;
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
    <View style={[styles.page, { width: pageWidth }]}>
      {notice}
      {!card ? !failure ? <View style={styles.missing}><Text style={styles.body}>{t("这个视频暂时打不开，回首页再试试。")}</Text>
        <Pressable onPress={() => setRetry((n) => n + 1)} style={styles.secondary} testID="daily-video-load-retry"><Text style={styles.secondaryText}>{t("重试")}</Text></Pressable></View> : null : <>
        <View style={styles.linkIcon} testID="daily-video-external-icon"><Ionicons name="videocam-outline" size={44} color="#4C368C" /></View>
        <Text style={styles.title} testID="daily-video-external-title">{t("YouTube 育儿资源链接")}</Text>
        <Text style={styles.body} testID="daily-video-external-notice">{t("视频请在 YouTube 原站观看。NURI 不在应用内播放或下载视频。")}</Text>
        <Pressable onPress={() => void openSource()} disabled={openingSource} style={styles.primary} accessibilityRole="link" accessibilityState={{ disabled: openingSource }} testID="daily-video-source"><Text style={styles.primaryText}>{openingSource ? t("正在打开…") : t("在YouTube打开")}</Text><Ionicons name="open-outline" size={18} color="#FFFFFF" /></Pressable>
        {sourceFailure ? <Text style={styles.small} accessibilityLiveRegion="polite" testID="daily-video-source-error">{t("外部内容暂时无法打开，请稍后再试")}</Text> : null}
        <View style={styles.summary} testID="daily-video-summary-section">
          <Text style={styles.guideLabel}>{t("AI 检索摘要")}</Text>
          {shortPoints ? <Text style={[styles.body, styles.summaryText]} testID="daily-video-key-points">{shortPoints}</Text> : null}
          {summary ? <Text style={[styles.body, styles.summaryText]} testID="daily-video-summary">{summary}</Text> : null}
          {summaryState === "loading" ? <View style={styles.summaryLoading} accessibilityLiveRegion="polite" testID="daily-video-summary-loading"><ActivityIndicator color="#4C368C" /><Text style={styles.body}>{t("正在整理检索摘要…")}</Text></View> : null}
          {summaryState === "empty" ? <Text style={[styles.body, styles.summaryText]} testID="daily-video-summary-empty">{t("暂无可用摘要，请到原站查看。")}</Text> : null}
          {summaryFailure ? <View testID="daily-video-summary-error"><RequestFailureNotice error={summaryFailure}
            onRetry={retrySummary}
            onPermission={() => router.push(aiPermissionHref(permissionReturn))}
            onLogin={() => router.push("/login")} /></View> : null}
          {summaryState === "empty" ? <Pressable onPress={retrySummary} style={styles.secondary} accessibilityRole="button" testID="daily-video-summary-retry"><Text style={styles.secondaryText}>{t("重试摘要")}</Text></Pressable> : null}
          <Text style={styles.guideDisclosure} testID="daily-video-summary-disclosure">{t("根据标题和公开检索片段整理，未观看完整视频或获取字幕。请到原站核对。")}</Text>
        </View>
        {guide ? <LinearGradient colors={["#FFE9DD", "#EEE9FF"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.guide} testID="daily-video-nuri-guide">
          <Text style={styles.guideLabel}>{t("NURI 导读")}</Text>
          <Text style={styles.guideHeadline} testID="daily-video-guide-headline">{guide.headline}</Text>
          <Text style={styles.body} testID="daily-video-guide-intro">{guide.intro}</Text>
          {guide.actions.slice(0, 3).map((action, index) => <View key={`${index}:${action}`} style={styles.guideAction} testID={`daily-video-guide-action-${index}`}>
            <Text style={styles.guideNumber}>{index + 1}</Text><Text style={[styles.body, styles.guideActionText]}>{action}</Text>
          </View>)}
          <Text style={styles.guideDisclosure} testID="daily-video-guide-disclosure">{guide.disclosure}</Text>
        </LinearGradient> : null}
        <Text style={styles.small}>{t("外部视频内容不属于 NURI。请在原站判断内容是否适合你的情况。")}</Text>
        <Pressable onPress={() => void talk()} disabled={openingChat} style={styles.secondary} accessibilityRole="button" accessibilityState={{ disabled: openingChat }} testID="daily-video-chat"><Text style={styles.secondaryText}>{openingChat ? t("正在打开…") : t("和 NURI 聊聊育儿问题")}</Text></Pressable>
      </>}
    </View>
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#FFF9F3" }, center: { alignItems: "center", justifyContent: "center" },
  page: { alignSelf: "center", paddingHorizontal: 20 }, missing: { paddingTop: 36 },
  linkIcon: { marginTop: 24, width: 88, height: 88, borderRadius: 28, backgroundColor: "#EDE7FC", alignItems: "center", justifyContent: "center" },
  title: { color: "#261B45", fontFamily: "NotoSansSC_700Bold", fontSize: 22, lineHeight: 30, marginTop: 20, marginBottom: 14 },
  body: { color: "#261B45", fontFamily: "NotoSansSC_400Regular", fontSize: 15, lineHeight: 24 },
  small: { color: "#5B5272", fontFamily: "NotoSansSC_400Regular", fontSize: 12, lineHeight: 18, marginTop: 16 },
  guide: { marginTop: 24, borderRadius: 28, padding: 22, borderWidth: 1, borderColor: "#E6DEEF" },
  summary: { marginTop: 24, borderRadius: 24, padding: 20, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E6DEEF" },
  summaryText: { marginTop: 12 }, summaryLoading: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16 },
  guideLabel: { color: "#4C368C", fontFamily: "NotoSansSC_700Bold", fontSize: 13, lineHeight: 20 },
  guideHeadline: { color: "#261B45", fontFamily: "NotoSansSC_700Bold", fontSize: 20, lineHeight: 29, marginTop: 8, marginBottom: 14 },
  guideAction: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 16 },
  guideNumber: { color: "#4C368C", fontFamily: "NotoSansSC_700Bold", fontSize: 14, lineHeight: 24, minWidth: 20 },
  guideActionText: { flex: 1 },
  guideDisclosure: { color: "#5B5272", fontFamily: "NotoSansSC_400Regular", fontSize: 12, lineHeight: 19, marginTop: 20 },
  primary: { marginTop: 26, minHeight: 48, borderRadius: 999, backgroundColor: "#4C368C", alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, padding: 12 },
  primaryText: { color: "#FFFFFF", fontFamily: "NotoSansSC_700Bold", fontSize: 15 },
  secondary: { marginTop: 12, minHeight: 48, borderRadius: 999, borderWidth: 1, borderColor: "#4C368C", alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6, padding: 12 },
  secondaryText: { color: "#4C368C", fontFamily: "NotoSansSC_700Bold", fontSize: 15 },
});
