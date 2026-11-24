// Short AI search previews are distinct from NURI's own reading prompts.
import { useCallback, useRef } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import {
  ActivityIndicator,
  Linking,
  Platform,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { CardList, CenteredCard, NuriButton, NuriText, MenuRow } from "@/src/uiux48/Primitives";
import { FinalArticle, type ArticleSource } from "@/src/uiuxfinal/Article";
import { StateCard } from "@/src/uiux48/StateCard";
import { api, type DailyPostCard } from "@/src/api";
import { dailyPostGreeting, dailyPostSummarySources, dailyPostTag, isSummaryCard } from "@/src/components/DailyPostCard";
import { dailyPostSourceUrl, externalSourceUrl } from "@/src/externalContent";
import { socialPostThumbnail } from "@/src/recommendationMedia";
import { nuriResourceGuide } from "@/src/nuriResourceGuide";
import { shortResourceSummary, hasPostSummarySource, readingSummaryPoints, RESOURCE_SUMMARY_DISCLOSURE } from "@/src/resourceSummary";
import { useT } from "@/src/i18n";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { requestFailureCopy, requestFailureKind, type RequestFailureKind } from "@/src/requestFailure";
import RequestFailureNotice from "@/src/components/RequestFailureNotice";

export default function DailyPostScreen() {
  const { capture, current } = useAccountScope();
  const { t, locale } = useT();
  const router = useRouter();
  const [card, setCard] = useState<DailyPostCard | null>(null);
  const [cardLanguage, setCardLanguage] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [openingChat, setOpeningChat] = useState(false);
  const [openingSource, setOpeningSource] = useState(false);
  const [failure, setFailure] = useState<RequestFailureKind | null>(null);
  const [failureSource, setFailureSource] = useState<"load" | "chat">("load");
  const [retry, setRetry] = useState(0);
  const [sourceFailure, setSourceFailure] = useState(false);
  const [sourceActive,setSourceActive] = useState(false);
  const focused = useRef(false);
  const chatOperation = useRef(0);
  const chatBusy = useRef(false);
  const sourceOperation = useRef(0), sourceBusy = useRef(false);
  // Set when a care notification opens a specific card; otherwise today's.
  const { id, uiState, point } = useLocalSearchParams<{ id?: string; uiState?: string; point?: string }>();
  const validId = typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const requestedPoint = typeof point === "string" && /^[0-4]$/.test(point) ? Number(point) : null;
  const permissionReturn = validId ? `/daily-post?id=${id}${uiState === "takeaway" && requestedPoint !== null ? `&uiState=takeaway&point=${requestedPoint}` : ""}` : "/daily-post";

  useFocusEffect(useCallback(() => {
    const ticket = capture();
    if (ticket === null) return;
    let cancelled = false;
    focused.current = true;
    setSourceActive(true);
    chatOperation.current++;
    chatBusy.current = false;
    sourceOperation.current++;
    sourceBusy.current = false;
    setFailure(null);
    setSourceFailure(false);
    setOpeningChat(false);
    setOpeningSource(false);
    if(id!==undefined&&!validId){setCard(null);setState("missing");return()=>{focused.current=false;setSourceActive(false);};}
    setState((previous) => previous === "ready" && retry === 0 ? previous : "loading");
    (id ? api.getDailyPostById(String(id), locale) : api.getDailyPost(locale))
      .then((res) => {
        if (cancelled || !current(ticket)) return;
        setFailureSource("load");
        if (res.state === "ready" && res.card && (!id||res.card.id===id)) {
          setCard(res.card);
          setCardLanguage(locale);
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
      setSourceActive(false);
      chatOperation.current++;
      chatBusy.current = false;
      sourceOperation.current++;
      sourceBusy.current = false;
    };
  }, [id, validId, locale, retry, capture, current, setCard, setCardLanguage, setState, setFailure, setOpeningChat, setOpeningSource, setFailureSource, setSourceFailure,setSourceActive]));

  const sourceUrl = dailyPostSourceUrl(card?.source_url);
  const openSource = useCallback(async (source?: ArticleSource) => {
    const ticket = capture();
    if (ticket === null || !focused.current || !card || sourceBusy.current) return;
    const url = source
      ? dailyPostSummarySources(card).find((item) => item.n === source.n && item.url === source.url)?.url
      : sourceUrl;
    if (!url) return;
    const operation = ++sourceOperation.current;
    const accepts = () => current(ticket) && focused.current && operation === sourceOperation.current;
    sourceBusy.current = true; setOpeningSource(true);
    setSourceFailure(false);
    void api.dailyPostEvent(card.id, "source_click").catch(() => {});
    try { await Linking.openURL(url); }
    catch { if (accepts()) setSourceFailure(true); }
    finally { if (accepts()) { sourceBusy.current = false; setOpeningSource(false); } }
  }, [card, sourceUrl, capture, current, setSourceFailure, setOpeningSource]);

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
    onPermission={() => router.push(aiPermissionHref(permissionReturn))}
    onLogin={() => router.push("/login")} /> : null;


  if(state==="loading"||(state==="ready"&&(cardLanguage!==locale||(id&&card?.id!==id))))return <CenteredCard><ActivityIndicator /></CenteredCard>;
  if(state==="missing"||!card)return <CenteredCard>{failureNotice||<NuriText>{t("今天的家长经验暂时打不开，回首页再试试。")}</NuriText>}<NuriButton secondary label={t("回到首页")} onPress={()=>router.dismissTo("/(tabs)")} /></CenteredCard>;
  const guide=nuriResourceGuide({concern:card.concern},t,locale);
  const summaryCard = isSummaryCard(card);
  const summarySources = summaryCard ? dailyPostSummarySources(card) : [];
  const sourceAvailable = hasPostSummarySource(card) && (
    summaryCard ? summarySources.length > 0 : Boolean(externalSourceUrl(card.source_url))
  );
  const question=sourceAvailable?shortResourceSummary(card.question,110)||shortResourceSummary(card.headline,110):null;
  const situation=sourceAvailable?shortResourceSummary(card.situation,240):null;
  const summaryNumbers = new Set(summarySources.map((source) => source.n));
  const citedTakeaways = sourceAvailable && Array.isArray(card.takeaways)
    ? card.takeaways.slice(0, summaryCard ? 5 : 2).flatMap((value, index) => {
      const text = shortResourceSummary(value, summaryCard ? 500 : 120);
      if (!text) return [];
      const refs = card.takeaway_sources?.[index];
      const sources = Array.isArray(refs) ? [...new Set(refs.filter((n) => summaryNumbers.has(n)))] : [];
      return [{ text, sources, index }];
    }) : [];
  const takeaways = citedTakeaways.map(({ text }) => text);
  const reason = summaryCard && sourceAvailable ? shortResourceSummary(card.why_this, 200) : null;
  const summaryLocale = card.locale || locale;
  const organizeSummary = !summaryCard && Platform.OS === "ios" && ["live-alpha", "early-access", "app-store"].includes(process.env.EXPO_PUBLIC_RELEASE_FLAVOR ?? "");
  const summary = situation || question;
  const selectedPoint = validId && uiState === "takeaway" && requestedPoint !== null
    ? citedTakeaways.find(({ index }) => index === requestedPoint)?.text : undefined;
  if (selectedPoint) {
    const failureCopy = failure ? requestFailureCopy(locale, failure) : null;
    return <StateCard
      testID="social-takeaway-card"
      title={organizeSummary ? readingSummaryPoints(null, selectedPoint, summaryLocale).map(({text}) => text).join(" ") : selectedPoint}
      message={guide.intro}
      note={[card.locale && card.locale !== locale ? t("此内容保留原语言，尚未提供当前语言的翻译。") : "", t(RESOURCE_SUMMARY_DISCLOSURE)].filter(Boolean).join("\n")}
      error={failureCopy?.detail}
      busy={openingChat}
      primary={{
        label: failureCopy?.action ?? t("告诉 Nuri 我的情况"),
        onPress: () => {
          if (failure === "permission") router.push(aiPermissionHref(permissionReturn));
          else if (failure === "session") router.push("/login");
          else void talkItThrough();
        },
      }}
      secondary={{
        label: t("返回推荐"),
        onPress: () => {
          if (router.canGoBack()) router.back();
          else router.replace({ pathname: "/daily-post", params: { id: card.id } });
        },
      }}
    />;
  }
  const summaryPoints = organizeSummary ? readingSummaryPoints(takeaways.join("\n"), summary, summaryLocale, { detailFirst: true }) : [];
  return <FinalArticle key={card.id}
    title={sourceAvailable?card.headline:guide.headline}
    source={dailyPostTag(t,card)}
    sourceUrl={sourceUrl}
    mediaUrls={[card.thumbnail_url,card.image_url].map(value=>socialPostThumbnail(value,sourceUrl)).filter((value):value is string=>Boolean(value))}
    sourceActive={sourceActive}
    summary={organizeSummary ? summaryPoints.filter(({kind}) => kind === "detail").map(({text}) => text).join("\n\n") : summary}
    points={organizeSummary ? summaryPoints.filter(({kind}) => kind === "preview").map(({text}) => text) : takeaways}
    hideMedia={summaryCard}
    reason={reason}
    pointSources={summaryCard ? citedTakeaways.map(({ sources }) => sources) : undefined}
    sources={summarySources}
    onOpenSource={(source) => void openSource(source)}
    onSource={()=>void openSource()}
    onTalk={talkItThrough}
    busy={openingChat}
    sourceBusy={openingSource}
    notice={<>{failureNotice}{sourceFailure?<NuriText secondary testID="daily-post-source-error">{t("外部内容暂时无法打开，请稍后再试")}</NuriText>:null}</>}
    allowSavePreview={process.env.EXPO_PUBLIC_FLOW_PROTOTYPE==="1"}
  />;
}
