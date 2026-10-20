import ChatConversation from "../chat/[id]";
import { GlassSurface, IconAction, NuriIcon, NuriText, NuriKeyboardFrame } from "@/src/uiux48/Primitives";
import { NuriComposer } from "@/src/uiux48/Composer";
import { NuriAvatar } from "@/src/uiux48/Scene";
import { useNuriTheme } from "@/src/uiux48/Theme";
import { readChatDraft, writeChatDraft } from "@/src/uiux48/chatDraft";
import { requestGuardedNativeNavigation } from "@/src/components/nativeNavigation";
import { nuriResourceGuide } from "@/src/nuriResourceGuide";
import { resourceLanguageMismatch, hasPostSummarySource } from "@/src/resourceSummary";
import { KeyboardAvoidingView } from "react-native";
import { useCallback, useEffect, useRef } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Image,
  Platform,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";

import {
  api,
  type DailyPostCard as DailyPost,
  type DailyVideoCard as DailyVideo,
  type MainCheckin,
  type MainConversationPreview,
} from "@/src/api";
import Toast from "@/src/components/Toast";
import DailyPostCard, { type DailyPostStatus } from "@/src/components/DailyPostCard";
import DailyVideoCard from "@/src/components/DailyVideoCard";
import RequestFailureNotice from "@/src/components/RequestFailureNotice";
import { useT, translate } from "@/src/i18n";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { requestFailureCopy, requestFailureKind, type RequestFailureKind } from "@/src/requestFailure";

const mascotImage = require("@/assets/images/homepage/figma-mascot.png");
const nativeLogoImage = require("@/assets/images/nuri-logo.png");
// This bundled PNG is 598 × 831. Size from one axis so a different
// viewport cannot stretch the character inside the card's crop window.
const MASCOT_ASPECT_RATIO = 598 / 831;

const C = {
  canvas: "#FFF9F3",
  text: "#261B45",
  purple: "#4C368C",
  purpleLight: "#C0B3E4",
  purpleDark: "#71629B",
};

const FIGMA_FRAME_WIDTH = 402;
// While today's card is being built elsewhere, look again this often, for at
// most this long before showing the empty state.
const DAILY_POST_POLL_MS = 5000;
const DAILY_POST_POLL_LIMIT = 12;

type NuriPreview = {
  sessionId: string | null;
  hasLastUserMessage: boolean;
  lastUserMessage: string;
  memoryText: string;
  hasPersonalContext: boolean;
};

type NuriPreviewStatus = "loading" | "ready" | "empty" | "error";

const conversationExcerpt = (text: string, maxLength = 18) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized === "[图片]") return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
};

export default function Home() {
  const { generation, capture, current } = useAccountScope();
  const { t, locale } = useT();
  const router = useRouter();
  const theme48 = useNuriTheme();
  const [homeDraft,setHomeDraft] = useState("");
  const homeDraftHydration=useRef(true);
  const [inlineSessionId,setInlineSessionId] = useState<string|null>(null);
  const [inlineAction,setInlineAction] = useState<"send"|"attach"|"mic"|"focus"|undefined>(undefined);
  const [inlineActive,setInlineActive] = useState(false);
  const [bodyHeight,setBodyHeight] = useState(500);
  const insets = useSafeAreaInsets();
  const isHomeFocused = useIsFocused();
  const { width: viewportWidth } = useWindowDimensions();
  // Keep the same content geometry as the 402px Figma phone frame. On a real
  // phone the frame shrinks with the viewport; on desktop it remains centered.
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const dailyCardWidth = Math.max(0, phoneWidth - 60);
  const [nickname, setNickname] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [devSheet, setDevSheet] = useState<{ emoji: string; name: string } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [nuriPreview, setNuriPreview] = useState<NuriPreview | null>(null);
  const [nuriPreviewStatus, setNuriPreviewStatus] =
    useState<NuriPreviewStatus>("loading");
  const [nuriFailure, setNuriFailure] = useState<RequestFailureKind | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nuriPreviewRequest = useRef(0);
  const openingNuriChat = useRef(false);
  const homeActive = useRef(false);
  const chatOperation = useRef(0);
  // Today's card. Built once per local day on the server; every focus just
  // re-reads it, which is also how a new day's card appears after midnight.
  const [dailyPost, setDailyPost] = useState<DailyPost | null>(null);
  const [dailyPostStatus, setDailyPostStatus] = useState<DailyPostStatus>("loading");
  const [dailyFailure, setDailyFailure] = useState<RequestFailureKind | null>(null);
  const dailyPostRequest = useRef(0);
  const dailyPostPolls = useRef(0);
  const [dailyPostPollCycle, setDailyPostPollCycle] = useState(0);
  const [dailyVideo, setDailyVideo] = useState<DailyVideo | null>(null);
  const [dailyVideoStatus, setDailyVideoStatus] = useState<DailyPostStatus>("loading");
  const [videoFailure, setVideoFailure] = useState<RequestFailureKind | null>(null);
  const [dailyPage, setDailyPage] = useState(0);
  const dailyVideoRequest = useRef(0), dailyVideoPolls = useRef(0);
  const [dailyVideoPollCycle, setDailyVideoPollCycle] = useState(0);
  const [checkin, setCheckin] = useState<MainCheckin | null>(null);
  const [checkinFailure, setCheckinFailure] = useState<RequestFailureKind | null>(null);
  const checkinRequest = useRef(0);

  useEffect(() => {
    dailyPostRequest.current++;
    nuriPreviewRequest.current++;
    openingNuriChat.current = false;
    chatOperation.current++;
    dailyPostPolls.current = 0;
    dailyVideoRequest.current++;
    dailyVideoPolls.current = 0;
    checkinRequest.current++;
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, [generation]);

  const showToast = useCallback((m: string) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2000);
  }, [setToastMsg]);

  const loadDailyPost = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    const ticket = capture();
    if (ticket === null) return;
    const requestId = ++dailyPostRequest.current;
    setDailyFailure(null);
    // A warm focus keeps the card on screen while it is re-read.
    if (!quiet) setDailyPostStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const res = await api.getDailyPost();
      if (!current(ticket) || requestId !== dailyPostRequest.current) return;
      if (res.state === "ready" && res.card) {
        setDailyPost(res.card);
        setDailyPostStatus("ready");
        dailyPostPolls.current = 0;
      } else if (res.state === "pending") {
        setDailyPostStatus("pending");
      } else if (res.state === "disabled") {
        // Switched off, or its table not migrated yet: no section at all,
        // rather than a daily "nothing found" that isn't true.
        setDailyPost(null);
        setDailyPostStatus("disabled");
      } else {
        setDailyPost(null);
        setDailyPostStatus(res.state === "unavailable" ? "error" : "empty");
      }
    } catch (error) {
      if (current(ticket) && requestId === dailyPostRequest.current) {
        setDailyFailure(requestFailureKind(error));
        setDailyPostStatus((current) => (current === "ready" ? current : "error"));
      }
    }
  }, [capture, current, setDailyPost, setDailyPostStatus, setDailyFailure]);

  const loadDailyVideo = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    const ticket = capture();
    if (ticket === null) return;
    const request = ++dailyVideoRequest.current;
    setVideoFailure(null);
    if (!quiet) setDailyVideoStatus((previous) => previous === "ready" ? previous : "loading");
    try {
      const result = await api.getDailyVideo(locale);
      if (!current(ticket) || request !== dailyVideoRequest.current) return;
      if (result.state === "ready" && result.card) { setDailyVideo(result.card); setDailyVideoStatus("ready"); dailyVideoPolls.current = 0; }
      else if (result.state === "pending") setDailyVideoStatus("pending");
      else { setDailyVideo(null); setDailyVideoStatus(result.state === "disabled" ? "disabled" : result.state === "unavailable" ? "error" : "empty"); }
    } catch (error) {
      if (current(ticket) && request === dailyVideoRequest.current) {
        setVideoFailure(requestFailureKind(error));
        setDailyVideoStatus((previous) => previous === "ready" ? previous : "error");
      }
    }
  }, [capture, current, locale, setDailyVideo, setDailyVideoStatus, setVideoFailure]);

  useEffect(() => {
    if (dailyVideoStatus !== "pending" || !isHomeFocused) return;
    const ticket = capture();
    if (ticket === null) return;
    if (dailyVideoPolls.current >= DAILY_POST_POLL_LIMIT) { setDailyVideoStatus("empty"); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled || !current(ticket) || !homeActive.current) return;
      dailyVideoPolls.current++;
      await loadDailyVideo({ quiet: true });
      // A second pending response has the same status. Explicitly advance
      // the cycle after it settles so the next bounded poll is scheduled.
      if (!cancelled && current(ticket) && homeActive.current) setDailyVideoPollCycle((cycle) => cycle + 1);
    }, DAILY_POST_POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [dailyVideoStatus, dailyVideoPollCycle, isHomeFocused, loadDailyVideo, setDailyVideoStatus, capture, current, setDailyVideoPollCycle]);

  const loadCheckin = useCallback(async () => {
    const ticket = capture();
    if (ticket === null) return;
    const request = ++checkinRequest.current;
    setCheckinFailure(null);
    try {
      const result = await api.getMainCheckin();
      if (current(ticket) && request === checkinRequest.current) setCheckin(result);
    } catch (error) {
      if (current(ticket) && request === checkinRequest.current) {
        setCheckin(null); setCheckinFailure(requestFailureKind(error));
      }
    }
  }, [capture, current, setCheckin, setCheckinFailure]);

  const openDailyVideo = useCallback((card: DailyVideo) => {
    if (capture() === null || !homeActive.current) return;
    void api.dailyVideoEvent(card.id, "open").catch(() => {});
    router.push({ pathname: "/daily-video", params: { id: card.id } });
  }, [capture, router]);

  useEffect(() => {
    if (dailyPostStatus !== "pending" || !isHomeFocused) return;
    const ticket = capture();
    if (ticket === null) return;
    if (dailyPostPolls.current >= DAILY_POST_POLL_LIMIT) {
      setDailyPostStatus("empty");
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled || !current(ticket) || !homeActive.current) return;
      dailyPostPolls.current += 1;
      await loadDailyPost({ quiet: true });
      if (!cancelled && current(ticket) && homeActive.current) setDailyPostPollCycle((cycle) => cycle + 1);
    }, DAILY_POST_POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [dailyPostStatus, dailyPostPollCycle, isHomeFocused, loadDailyPost, capture, current, setDailyPostPollCycle, setDailyPostStatus]);

  const openDailyPost = useCallback(
    (card: DailyPost) => {
      if (capture() === null) return;
      void api.dailyPostEvent(card.id, "open").catch(() => {});
      router.push("/daily-post");
    },
    [router, capture],
  );

  const loadNuriPreview = useCallback(async () => {
    const ticket = capture();
    if (ticket === null) return;
    const requestId = ++nuriPreviewRequest.current;
    setNuriFailure(null);
    setNuriPreviewStatus("loading");
    try {
      const preview: MainConversationPreview = await api.getMainConversationPreview();
      if (!current(ticket) || requestId !== nuriPreviewRequest.current) return;
      const sessionId =
        preview?.has_conversation && typeof preview.session_id === "string"
          ? preview.session_id
          : null;
      if(homeDraftHydration.current){
        homeDraftHydration.current=false;
        setHomeDraft(sessionId?readChatDraft(sessionId):"");
      }
      const lastUserMessage = preview?.last_user_message?.text || "";
      // Only the backend-authored display text is shown. category/key remain
      // internal provenance and must never leak into parent-facing copy.
      const memoryText =
        typeof preview?.memory_preview?.text === "string"
          ? preview.memory_preview.text.trim()
          : "";
      const hasPersonalContext = Boolean(lastUserMessage || memoryText);
      setNuriPreview({
        sessionId,
        hasLastUserMessage: !!preview.last_user_message,
        lastUserMessage,
        memoryText,
        hasPersonalContext,
      });
      setNuriPreviewStatus(hasPersonalContext ? "ready" : "empty");
    } catch (error) {
      if (current(ticket) && requestId === nuriPreviewRequest.current) {
        setNuriFailure(requestFailureKind(error));
        setNuriPreviewStatus("error");
      }
    }
  }, [capture, current, setNuriPreview, setNuriPreviewStatus, setNuriFailure, setHomeDraft]);

  const handleFailure = (failure: RequestFailureKind | null, retry: () => void) => {
    if (failure === "permission") router.push(aiPermissionHref("/(tabs)"));
    else if (failure === "session") router.push("/login");
    else retry();
  };

  const openNuriChat = async () => {
    if(inlineActive&&requestGuardedNativeNavigation("/","chat"))return;
    const ticket = capture();
    if (ticket === null || !homeActive.current) return;
    if (nuriPreviewStatus === "loading" || openingNuriChat.current) return;
    if (nuriPreviewStatus === "error" && (!nuriPreview || nuriFailure === "permission" || nuriFailure === "session")) {
      handleFailure(nuriFailure, () => void loadNuriPreview());
      return;
    }

    openingNuriChat.current = true;
    const operation = ++chatOperation.current;
    const acceptsResult = () => current(ticket) && homeActive.current && operation === chatOperation.current;
    let navigated = false;
    try {
      // Re-read the server's canonical preview at tap time. Opening existing
      // history is a pure read; only creating/greeting a conversation needs AI.
      const preview = await api.getMainConversationPreview();
      if (!acceptsResult()) return;
      const session = checkin?.state === "ready" && checkin.id
        ? { id: (await api.openMainCheckin(checkin.id)).session_id }
        : preview.has_conversation && preview.session_id
          ? { id: preview.session_id }
          : await api.getOrStartMainSession();
      if (!acceptsResult()) return;
      if (!inlineActive) writeChatDraft(session.id, homeDraft, generation);
      router.push(`/chat/${session.id}`);
      navigated = true;
    } catch (error) {
      if (!acceptsResult()) return;
      const failure = requestFailureKind(error);
      setNuriFailure(failure);
      setNuriPreviewStatus("error");
      if (failure === "permission" || failure === "session") handleFailure(failure, () => {});
      else showToast(requestFailureCopy(locale, failure).title);
    } finally {
      if (acceptsResult() && !navigated) openingNuriChat.current = false;
    }
  };

  useFocusEffect(
    useCallback(() => {
      const ticket = capture();
      if (ticket === null) return;
      api
        .me()
        .then((me: any) => {
          if (!current(ticket)) return;
          if (me?.nickname) setNickname(me.nickname);
          const candidate = me?.avatar_url || me?.photo_url || me?.picture;
          setAvatarUrl(
            typeof candidate === "string" && /^https:\/\//i.test(candidate)
              ? candidate
              : null,
          );
        })
        .catch(() => {});
    }, [capture, current, setNickname, setAvatarUrl])
  );

  useFocusEffect(
    useCallback(() => {
      dailyPostPolls.current = 0;
      dailyVideoPolls.current = 0;
      void loadDailyPost();
      void loadDailyVideo();
      return () => {
        dailyPostRequest.current += 1;
        dailyVideoRequest.current += 1;
      };
    }, [loadDailyPost, loadDailyVideo])
  );

  useFocusEffect(
    useCallback(() => {
      homeActive.current = true;
      homeDraftHydration.current=true;
      void loadNuriPreview();
      void loadCheckin();
      return () => {
        homeActive.current = false;
        chatOperation.current++;
        nuriPreviewRequest.current += 1;
        checkinRequest.current += 1;
        openingNuriChat.current = false;
      };
    }, [loadNuriPreview, loadCheckin])
  );

  const hasLoadedPreview = !!nuriPreview;
  const memoryExcerpt = nuriPreview?.memoryText
    ? conversationExcerpt(nuriPreview.memoryText)
    : "";
  const hasPersonalContext = !!nuriPreview?.hasPersonalContext;
  const nuriMemo =
    nuriPreviewStatus === "error" && nuriFailure
      ? requestFailureCopy(locale, nuriFailure).title
    : checkin?.state === "ready" && checkin.line && !resourceLanguageMismatch(checkin.line,undefined,locale)
      ? checkin.line
    : checkin?.state === "ready" && checkin.line
      ? t("欢迎回来。想从哪里聊起？")
    : checkin?.state === "active"
      ? t("刚才的话还没聊完，要接着聊吗？")
    : hasLoadedPreview && nuriPreview?.hasLastUserMessage
      ? t("欢迎回来。宝宝这几天怎么样？想聊的时候我都在。")
      : hasLoadedPreview && memoryExcerpt
        ? t("我记得你提过“{excerpt}”。最近有新变化吗？", {
            excerpt: memoryExcerpt,
          })
      : nuriPreviewStatus === "error"
        ? t("上次的对话暂时没能加载，点一下再试试。")
        : nuriPreviewStatus === "loading"
          ? t("正在整理我们上次的对话…")
          : t("今天想聊聊什么？我在这里陪你。");
  const nuriActionText =
    nuriPreviewStatus === "loading" && !nuriPreview
      ? t("正在加载")
      : nuriPreviewStatus === "error" && nuriFailure
        ? requestFailureCopy(locale, nuriFailure).action
      : checkin?.state === "ready" && !checkin.opened
        ? t("回复NURI")
      : nuriPreviewStatus === "error" && !hasPersonalContext
      ? t("重试加载")
      : nuriPreview?.sessionId
        ? t("继续对话")
        : hasPersonalContext
          ? t("从这里聊起")
          : t("和我聊聊");

  const beginInline = async (action:"send"|"attach"|"mic"|"focus") => {
    const ticket = capture();
    if (ticket === null || !homeActive.current || openingNuriChat.current) return;
    openingNuriChat.current = true;
    const operation = ++chatOperation.current;
    try {
      const preview = await api.getMainConversationPreview();
      if (!current(ticket) || !homeActive.current || operation !== chatOperation.current) return;
      const session = preview.has_conversation && preview.session_id ? {id:preview.session_id} : await api.getOrStartMainSession();
      if (!current(ticket) || !homeActive.current || operation !== chatOperation.current) return;
      setInlineSessionId(session.id);setInlineAction(action);setInlineActive(true);
    } catch (error) {
      if (current(ticket) && homeActive.current && operation === chatOperation.current) {
        const failure=requestFailureKind(error);setNuriFailure(failure);setNuriPreviewStatus("error");
        if(failure==="permission"||failure==="session")handleFailure(failure,()=>{});else showToast(requestFailureCopy(locale,failure).title);
      }
    } finally { if(current(ticket)&&operation===chatOperation.current)openingNuriChat.current=false; }
  };
  const en=locale==="en";
  const statusTitle=(status:DailyPostStatus,failure:RequestFailureKind|null)=>failure?requestFailureCopy(locale,failure).title:status==="loading"||status==="pending"?(en?"Finding something for you…":translate(locale, "正在为你整理推荐…")):status==="disabled"?(en?"This recommendation is not available":translate(locale, "这项推荐暂未开放")):status==="error"?(en?"Could not load — tap to retry":translate(locale, "加载失败，点此重试")):(en?"No recommendation yet":translate(locale, "暂时没有新的推荐"));
  const greeting=theme48.mode==="Morning"?(en?"Good morning":translate(locale, "早上好")):theme48.mode==="Afternoon"?(en?"Good afternoon":translate(locale, "下午好")):(en?"Good evening":translate(locale, "晚上好"));
  return <View style={{flex:1,minHeight:0}} testID="home-screen">
    <View style={{height:60,paddingHorizontal:24,flexDirection:"row",alignItems:"center",gap:10}}>
      <NuriAvatar /><NuriText style={{fontSize:20,lineHeight:28,fontWeight:"600",flex:1}}>{en?`Welcome, ${nickname}!`:t("欢迎，{nickname}！",{nickname})}</NuriText>
      <IconAction name="settings" label={en?"Profile & settings":translate(locale, "个人资料与设置")} onPress={()=>{if(!requestGuardedNativeNavigation("/","profile"))router.push("/(tabs)/profile");}} testID="home-settings" />
    </View>
    <NuriKeyboardFrame>
      <View style={{flex:1,minHeight:0}} onLayout={e=>setBodyHeight(e.nativeEvent.layout.height)}>
        <View style={{height:156}}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={342} decelerationRate="fast" contentContainerStyle={{paddingLeft:24,paddingRight:24,paddingTop:22,paddingBottom:22,gap:12}} testID="home-recommendations">
            <Pressable onPress={()=>dailyPost?openDailyPost(dailyPost):handleFailure(dailyFailure,()=>void loadDailyPost())} accessibilityRole="button" testID={dailyPost?"home-daily-post-card":"home-daily-post-empty"}>
              <GlassSurface style={{width:330}} contentStyle={{height:112,paddingHorizontal:20,paddingVertical:12,justifyContent:"space-between"}}>
                <NuriText secondary style={{fontSize:12,lineHeight:16}}>{en?"Social picks":translate(locale, "社交推荐")}</NuriText>
                <NuriText style={{fontSize:17,lineHeight:22,fontWeight:"600"}}>{dailyPost?(!hasPostSummarySource(dailyPost)||resourceLanguageMismatch(dailyPost.headline,dailyPost.locale,locale)?t("为你找到的育儿话题"):dailyPost.headline):statusTitle(dailyPostStatus,dailyFailure)}</NuriText>
                <NuriText secondary style={{fontSize:12,lineHeight:16}}>Facebook · Threads</NuriText>
              </GlassSurface>
            </Pressable>
            <Pressable onPress={()=>dailyVideo?openDailyVideo(dailyVideo):handleFailure(videoFailure,()=>void loadDailyVideo())} accessibilityRole="button" testID={dailyVideo?"home-daily-video-card":"home-daily-video-empty"}>
              <GlassSurface style={{width:330}} contentStyle={{height:112,padding:12,flexDirection:"row",gap:12}}>
                <View style={{width:72,height:80,borderRadius:16,overflow:"hidden"}}><Image source={require("@/assets/uiux48/imgThumbnailAfternoonScene.png")} style={{width:72,height:80}} resizeMode="cover" /><View style={{position:"absolute",left:4,bottom:4,width:30,height:30,borderRadius:15,backgroundColor:"rgba(161,139,182,.32)",alignItems:"center",justifyContent:"center"}}><NuriIcon name="play" /></View></View>
                <View style={{flex:1,justifyContent:"space-between"}}><NuriText secondary style={{fontSize:12,lineHeight:16}}>YouTube {en?"video":translate(locale, "视频")}</NuriText><NuriText style={{fontSize:16,lineHeight:20,fontWeight:"600"}} testID="home-daily-video-external-title">{dailyVideo?nuriResourceGuide({concern:dailyVideo.concern},t,locale).headline:statusTitle(dailyVideoStatus,videoFailure)}</NuriText><NuriText secondary style={{fontSize:12,lineHeight:16}}>{en?"Parenting picks":translate(locale, "育儿精选")}</NuriText></View>
              </GlassSurface>
            </Pressable>
          </ScrollView>
        </View>
        <GlassSurface kind="message" style={{position:"absolute",left:24,right:24,bottom:16,...(inlineActive?{height:Math.max(160,Math.min(360,bodyHeight-24))}:{})}} contentStyle={{paddingHorizontal:20,paddingVertical:16,...(inlineActive?{flex:1,minHeight:0}:{gap:8})}} testID="home-inline-chat-card">
          <View style={{flexDirection:"row",alignItems:"center"}}><NuriText style={{fontSize:17,lineHeight:22,fontWeight:"500",flex:1}}>{en?`${greeting}, ${nickname}`:`${greeting}，${nickname}`}</NuriText><IconAction name="expand" label={nuriFailure?requestFailureCopy(locale,nuriFailure).action:en?"Open full conversation":translate(locale, "展开完整对话")} onPress={openNuriChat} testID="home-nuri-action" /></View>
          {inlineActive&&inlineSessionId?<ChatConversation sessionId={inlineSessionId} embedded initialDraft={homeDraft} initialAction={inlineAction} onExpand={()=>void openNuriChat()} />:<>
            <NuriText secondary style={{fontSize:17,lineHeight:22}} testID="home-nuri-memo">{nuriMemo}</NuriText>
            <NuriComposer value={homeDraft} onChangeText={v=>{homeDraftHydration.current=false;setHomeDraft(v);if(nuriPreview?.sessionId)writeChatDraft(nuriPreview.sessionId,v,generation);}} onSend={()=>void beginInline("send")} onAttach={()=>void beginInline("attach")} onMic={()=>void beginInline("mic")} testID="home" />
          </>}
        </GlassSurface>
      </View>
    </NuriKeyboardFrame>
    <Toast message={toastMsg} />
  </View>;
}
