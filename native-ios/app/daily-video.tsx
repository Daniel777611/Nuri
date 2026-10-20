import { useCallback, useRef } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { CardList, CenteredCard, NuriButton, NuriText } from "@/src/uiux48/Primitives";
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
  const { t, locale } = useT();
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
        const result = await (id ? api.getDailyVideoById(id, locale) : api.getDailyVideo(locale));
        if (!accepts()) return;
        if (result.state === "ready" && result.card && (id === undefined || result.card.id === id) && isYouTubeVideoId(result.card.video_id)) {
          setCard(result.card); setState("ready");
        } else { setCard(null); setState("missing"); }
      } catch (error) {
        if (accepts()) { setCard(null); setFailureSource("load"); setFailure(requestFailureKind(error)); setState("missing"); }
      }
    })();
    return () => { cancelled = true; focused.current = false; operation.current++; sourceOperation.current++; chatBusy.current = false; sourceBusy.current = false; };
  }, [capture, current, id, locale, retry, setOpeningChat, setOpeningSource, setFailure, setState, setCard, setFailureSource, setSourceFailure]));

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
    const limit = locale === "en" ? 750 : 190;
    // Do not reuse an old-language summary while a new localized row loads.
    const cached = summaryLocale === locale ? resourceSummary(savedSummary, { limit, locale }) : null;
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
        const result = await api.getDailyVideoSummary(summaryCardId, locale);
        const latestPermission = aiConsent.getState();
        if (!accepts() || latestPermission.status !== "allowed" || latestPermission.session !== permission.session) return;
        const text = resourceSummary(result.summary, { limit, locale });
        setSummaryResult(text ? { cardId: summaryCardId, text } : null);
        setSummaryState(text ? "ready" : "empty");
      } catch (error) {
        if (accepts()) { setSummaryFailure(requestFailureKind(error)); setSummaryState("failed"); }
      } finally { if (accepts()) summaryBusy.current = false; }
    })();
    // Ignoring a late response does not claim to cancel backend work already
    // started; the API owns its timeout/account abort and permission lease.
    return cleanup;
  }, [capture, current, summaryCardId, summaryLocale, savedSummary, id, locale, permission.status, permission.session, summaryRetry, setSummaryResult, setSummaryFailure, setSummaryState]));

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
      router.push({pathname:opened?"/source-preview":"/content-unavailable",params:{kind:"video",...(id?{id}:{})}});
    }
  };
  const notice = failure ? <RequestFailureNotice error={failure}
    onRetry={() => failureSource === "chat" ? void talk() : setRetry((n) => n + 1)}
    onPermission={() => router.push(aiPermissionHref(permissionReturn))}
    onLogin={() => router.push("/login")} /> : null;
  // NURI's own reading prompts depend on the user's topic only. Do not
  // repurpose source metadata or fetched summaries as a supposed video guide.
  const guide = card ? nuriResourceGuide({ concern: card.concern }, t, locale) : null;
  const shortPoints = card ? resourceSummary(card.key_points, { limit: card.locale === "en" ? 280 : 90, locale: card.locale }) : null;
  const summary = card && summaryResult?.cardId === card.id ? summaryResult.text : null;

  if(state==="loading"||(card&&id!==undefined&&card.id!==id))return <CenteredCard><ActivityIndicator /></CenteredCard>;
  return <CardList>
    {notice}
    {!card?<>{!failure?<NuriText>{t("这个视频暂时打不开，回首页再试试。")}</NuriText>:null}<NuriButton label={t("重试")} onPress={()=>setRetry(n=>n+1)} testID="daily-video-load-retry" /></>:<>
      <NuriText style={{fontSize:20,lineHeight:28,fontWeight:"500"}} testID="daily-video-external-title">{guide?.headline||t("YouTube 育儿资源链接")}</NuriText>
      <NuriText secondary style={{fontSize:12}}>YouTube</NuriText>
      <NuriText secondary style={{fontSize:12}} testID="daily-video-external-notice">{t("视频请在 YouTube 原站观看。NURI 不在应用内播放或下载视频。")}</NuriText>
      <View testID="daily-video-summary-section" style={{gap:16}}>
        <NuriText>{t("AI 检索摘要")}</NuriText>
        {shortPoints?<NuriText testID="daily-video-key-points">{shortPoints}</NuriText>:null}
        {summary?<NuriText testID="daily-video-summary">{summary}</NuriText>:null}
        {summaryState==="loading"?<View testID="daily-video-summary-loading"><ActivityIndicator /><NuriText>{t("正在整理检索摘要…")}</NuriText></View>:null}
        {summaryState==="empty"?<><NuriText testID="daily-video-summary-empty">{t("暂无可用摘要，请到原站查看。")}</NuriText><NuriButton secondary label={t("重试摘要")} onPress={retrySummary} testID="daily-video-summary-retry" /></>:null}
        {summaryFailure?<View testID="daily-video-summary-error"><RequestFailureNotice error={summaryFailure} onRetry={retrySummary} onPermission={()=>router.push(aiPermissionHref(permissionReturn))} onLogin={()=>router.push("/login")} /></View>:null}
        <NuriText secondary style={{fontSize:12,lineHeight:18}} testID="daily-video-summary-disclosure">{t("根据标题和公开检索片段整理，未观看完整视频或获取字幕。请到原站核对。")}</NuriText>
      </View>
      {guide?<View testID="daily-video-nuri-guide" style={{gap:16}}><NuriText>{t("一起想想")}</NuriText><NuriText testID="daily-video-guide-headline">{guide.headline}</NuriText><NuriText testID="daily-video-guide-intro">{guide.intro}</NuriText>{guide.actions.slice(0,3).map((text,index)=><NuriText key={index} testID={`daily-video-guide-action-${index}`}>{text}</NuriText>)}<NuriText secondary style={{fontSize:12}} testID="daily-video-guide-disclosure">{guide.disclosure}</NuriText></View>:null}
      <NuriText secondary style={{fontSize:12}}>{t("外部视频内容不属于 NURI。请在原站判断内容是否适合你的情况。")}</NuriText>
      <NuriButton label={openingSource?t("正在打开…"):t("在YouTube打开")} busy={openingSource} disabled={openingSource} onPress={()=>void openSource()} accessibilityRole="link" testID="daily-video-source" />
      <NuriButton secondary label={openingChat?t("正在打开…"):t("和 NURI 聊聊育儿问题")} busy={openingChat} disabled={openingChat} onPress={()=>void talk()} testID="daily-video-chat" />
      {sourceFailure?<NuriText secondary testID="daily-video-source-error">{t("外部内容暂时无法打开，请稍后再试")}</NuriText>:null}
    </>}
  </CardList>;
}
