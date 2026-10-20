// Short AI search previews are distinct from NURI's own reading prompts.
import { useCallback, useRef } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import {
  ActivityIndicator,
  Linking,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { CardList, CenteredCard, NuriButton, NuriText, MenuRow } from "@/src/uiux48/Primitives";
import { StateCard } from "@/src/uiux48/StateCard";
import { api, type DailyPostCard } from "@/src/api";
import { dailyPostGreeting, dailyPostTag } from "@/src/components/DailyPostCard";
import { externalSourceUrl } from "@/src/externalContent";
import { nuriResourceGuide } from "@/src/nuriResourceGuide";
import { shortResourceSummary, hasPostSummarySource, RESOURCE_SUMMARY_DISCLOSURE } from "@/src/resourceSummary";
import { useT } from "@/src/i18n";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { requestFailureCopy, requestFailureKind, type RequestFailureKind } from "@/src/requestFailure";
import RequestFailureNotice from "@/src/components/RequestFailureNotice";

export default function DailyPostScreen() {
  const { capture, current } = useAccountScope();
  const { t, locale } = useT();
  const router = useRouter();
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
  const { id, uiState, point } = useLocalSearchParams<{ id?: string; uiState?: string; point?: string }>();
  const validId = typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const requestedPoint = typeof point === "string" && /^[01]$/.test(point) ? Number(point) : null;
  const permissionReturn = validId ? `/daily-post?id=${id}${uiState === "takeaway" && requestedPoint !== null ? `&uiState=takeaway&point=${requestedPoint}` : ""}` : "/daily-post";

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
    if(id!==undefined&&!validId){setCard(null);setState("missing");return()=>{focused.current=false;};}
    setState((previous) => previous === "ready" && retry === 0 ? previous : "loading");
    (id ? api.getDailyPostById(String(id)) : api.getDailyPost())
      .then((res) => {
        if (cancelled || !current(ticket)) return;
        setFailureSource("load");
        if (res.state === "ready" && res.card && (!id||res.card.id===id)) {
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
  }, [id, validId, retry, capture, current, setCard, setState, setFailure, setOpeningChat, setFailureSource, setSourceFailure]));

  const openSource = useCallback(async () => {
    const ticket = capture();
    if (ticket === null || !focused.current || !card) return;
    const source = externalSourceUrl(card.source_url);
    if (!source) { setSourceFailure(true); router.push({pathname:"/content-unavailable",params:{kind:"post",...(id?{id:String(id)}:{})}}); return; }
    setSourceFailure(false);
    void api.dailyPostEvent(card.id, "source_click").catch(() => {});
    try { await Linking.openURL(source); if(current(ticket)&&focused.current)router.push({pathname:"/source-preview",params:{kind:"post",...(id?{id:String(id)}:{})}}); }
    catch { if (current(ticket) && focused.current) {setSourceFailure(true);router.push({pathname:"/content-unavailable",params:{kind:"post",...(id?{id:String(id)}:{})}});} }
  }, [card, capture, current, setSourceFailure, id, router]);

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


  if(state==="loading"||(state==="ready"&&id&&card?.id!==id))return <CenteredCard><ActivityIndicator /></CenteredCard>;
  if(state==="missing"||!card)return <CenteredCard>{failureNotice||<NuriText>{t("今天的家长经验暂时打不开，回首页再试试。")}</NuriText>}<NuriButton secondary label={t("回到首页")} onPress={()=>router.dismissTo("/(tabs)")} /></CenteredCard>;
  const guide=nuriResourceGuide({concern:card.concern},t,locale);
  const sourceAvailable=hasPostSummarySource(card)&&Boolean(externalSourceUrl(card.source_url));
  const question=sourceAvailable?shortResourceSummary(card.question,110)||shortResourceSummary(card.headline,110):null;
  const situation=sourceAvailable?shortResourceSummary(card.situation,240):null;
  const takeaways=sourceAvailable&&Array.isArray(card.takeaways)?card.takeaways.slice(0,2).map(v=>shortResourceSummary(v,120)).filter((v):v is string=>Boolean(v)):[];
  const reason=sourceAvailable?shortResourceSummary(card.why_this,200):null;
  const caution=sourceAvailable?shortResourceSummary(card.caution,240):null;
  const hasSummary=Boolean(question||situation||takeaways.length);
  const selectedPoint = validId && uiState === "takeaway" && requestedPoint !== null ? takeaways[requestedPoint] : undefined;
  if (selectedPoint) {
    const failureCopy = failure ? requestFailureCopy(locale, failure) : null;
    return <StateCard
      testID="social-takeaway-card"
      title={selectedPoint}
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
  return <CardList>
    {failureNotice}<NuriText secondary style={{fontSize:12}}>{dailyPostTag(t,card)}</NuriText>
    {card.locale&&card.locale!==locale?<NuriText secondary testID="daily-post-original-language">{t("此内容保留原语言，尚未提供当前语言的翻译。")}</NuriText>:null}
    <NuriText style={{fontSize:20,fontWeight:"500",lineHeight:28}}>{sourceAvailable?card.headline:guide.headline}</NuriText>
    <NuriText secondary testID="daily-post-greeting" style={{fontSize:12}}>{dailyPostGreeting(t,card.nickname,card.audience)}</NuriText>
    <View testID="daily-post-ai-summary" style={{gap:16}}>
      <NuriText secondary style={{fontSize:12}}>{t("AI 检索摘要")}</NuriText>
      {hasSummary?<>{question?<NuriText testID="daily-post-summary-question">{question}</NuriText>:null}{situation?<NuriText testID="daily-post-summary-situation">{situation}</NuriText>:null}{takeaways.map((text,index)=><MenuRow key={index} label={text} onPress={()=>router.push({pathname:"/daily-post",params:{id:card.id,uiState:"takeaway",point:String(index)}})} testID={`daily-post-summary-point-${index}`} />)}</>:<NuriText testID="daily-post-summary-empty">{t("这条资源暂时没有可用摘要，请打开原站查看。")}</NuriText>}
      <NuriText secondary style={{fontSize:12,lineHeight:18}} testID="daily-post-summary-disclosure">{t(RESOURCE_SUMMARY_DISCLOSURE)}</NuriText>
      {card.summary_source==="facebook_ai_summary"?<NuriText secondary style={{fontSize:12}} testID="daily-post-summary-basis">{t("此摘要根据检索到的 Facebook AI 摘要再整理，不是原帖逐字引用。")}</NuriText>:null}
    </View>
    {reason?<NuriText secondary testID="daily-post-recommendation-reason">{reason}</NuriText>:null}
    {caution?<NuriText secondary style={{fontSize:12}} testID="daily-post-summary-caution">{caution}</NuriText>:null}
    <View testID="daily-post-question" style={{gap:16}}>
      <NuriText>{t("一起想想")}</NuriText><NuriText testID="daily-post-guide-headline">{guide.headline}</NuriText><NuriText testID="daily-post-guide-intro">{guide.intro}</NuriText>
      {guide.actions.map((action,index)=><NuriText key={index} testID={`daily-post-guide-action-${index}`}>{action}</NuriText>)}
      <NuriText secondary style={{fontSize:12}} testID="daily-post-guide-disclosure">{guide.disclosure}</NuriText>
    </View>
    <NuriText secondary style={{fontSize:12}}>{t("原站的家长经验不代替专业建议。每个孩子都不一样，涉及健康或安全的问题请咨询合适的专业人员。")}</NuriText>
    <NuriButton label={t("和NURI聊聊这个")} disabled={openingChat} busy={openingChat} onPress={talkItThrough} testID="daily-post-chat" />
    <NuriButton secondary label={t("打开原站链接")} onPress={()=>void openSource()} accessibilityRole="link" testID="daily-post-source" />
    {sourceFailure?<NuriText secondary testID="daily-post-source-error">{t("外部内容暂时无法打开，请稍后再试")}</NuriText>:null}
  </CardList>;
}
