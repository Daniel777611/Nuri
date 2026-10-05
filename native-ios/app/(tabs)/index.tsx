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
import { useT } from "@/src/i18n";
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

type HomeNavigationIconName = "knowledge" | "chat" | "tasks" | "community";

const HOME_NAVIGATION_ICONS: Record<
  HomeNavigationIconName,
  { asset: string; fallback: keyof typeof Ionicons.glyphMap }
> = {
  knowledge: { asset: "navigation-knowledge.svg", fallback: "library-outline" },
  chat: { asset: "navigation-chat.svg", fallback: "sparkles-outline" },
  tasks: { asset: "navigation-tasks.svg", fallback: "calendar-outline" },
  community: { asset: "navigation-community.svg", fallback: "people-outline" },
};

function HomeNavigationIcon({ name }: { name: HomeNavigationIconName }) {
  const icon = HOME_NAVIGATION_ICONS[name];
  if (Platform.OS === "web") {
    return (
      <Image
        source={{ uri: `/homepage/${icon.asset}` }}
        style={styles.navigationIcon}
        resizeMode="contain"
      />
    );
  }
  return <Ionicons name={icon.fallback} size={25} color={C.text} />;
}

// 待开发占位 bottom sheet（统一规范）
function DevSheet({
  visible,
  emoji,
  name,
  onClose,
}: {
  visible: boolean;
  emoji: string;
  name: string;
  onClose: () => void;
}) {
  // Its own hook call: this sheet is a sibling of Home, not a child, so it
  // cannot borrow the translator from there.
  const { t } = useT();
  if (!visible) return null;
  return (
    <View style={styles.sheetRoot}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.sheet} testID="dev-sheet">
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetEmoji}>{emoji}</Text>
        <Text style={styles.sheetTitle}>{t("{name}即将上线，敬请期待", { name })}</Text>
        <Pressable onPress={onClose} style={styles.sheetBtn} testID="dev-sheet-close">
          <Text style={styles.sheetBtnText}>{t("我知道了")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function Home() {
  const { generation, capture, current } = useAccountScope();
  const { t, locale } = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isHomeFocused = useIsFocused();
  const { width: viewportWidth } = useWindowDimensions();
  // Keep the same content geometry as the 402px Figma phone frame. On a real
  // phone the frame shrinks with the viewport; on desktop it remains centered.
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const dailyCardWidth = Math.max(0, phoneWidth - 60);
  const [nickname, setNickname] = useState("Momo妈妈");
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
      const result = await api.getDailyVideo();
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
  }, [capture, current, setDailyVideo, setDailyVideoStatus, setVideoFailure]);

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
  }, [capture, current, setNuriPreview, setNuriPreviewStatus, setNuriFailure]);

  const handleFailure = (failure: RequestFailureKind | null, retry: () => void) => {
    if (failure === "permission") router.push(aiPermissionHref("/(tabs)"));
    else if (failure === "session") router.push("/login");
    else retry();
  };

  const openNuriChat = async () => {
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
    : checkin?.state === "ready" && checkin.line
      ? checkin.line
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
        <ScrollView
          style={styles.scroll}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 94 + insets.bottom }}
        >
          <View style={styles.topBar}>
            <Image
              source={
                Platform.OS === "web"
                  ? { uri: "/homepage/nuri-mark.svg" }
                  : nativeLogoImage
              }
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.welcome} numberOfLines={1}>
              {t("欢迎！{nickname}", { nickname })}
            </Text>
            <Pressable
              onPress={() => router.push("/(tabs)/profile")}
              testID="home-avatar"
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t("个人资料")}
            >
              <View style={styles.avatar}>
                {avatarUrl ? (
                  <Image source={{ uri: avatarUrl }} style={styles.avatarImage} resizeMode="cover" />
                ) : (
                  <Text style={styles.avatarText}>{nickname.slice(0, 1)}</Text>
                )}
              </View>
            </Pressable>
          </View>

          {dailyPostStatus !== "disabled" || dailyVideoStatus !== "disabled" ? (
            <>
              <View style={styles.sectionHeading}>
                {Platform.OS === "web" ? (
                  <Image
                    source={{ uri: "/homepage/daily-selection-icon.svg" }}
                    style={styles.dailySectionIcon}
                    resizeMode="contain"
                  />
                ) : (
                  <Ionicons name="stats-chart" size={25} color={C.text} />
                )}
                <Text style={styles.sectionHeadingText}>{t("每日精选")}</Text>
              </View>

              <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={dailyCardWidth + 17}
                decelerationRate="fast" contentContainerStyle={{ paddingRight: 17 }}
                onScroll={(event) => setDailyPage(Math.round(event.nativeEvent.contentOffset.x / (dailyCardWidth + 17)))} scrollEventThrottle={80}
                testID="home-daily-carousel">
              {dailyPostStatus !== "disabled" ? <DailyPostCard
                width={dailyCardWidth}
                nickname={dailyPost?.nickname ?? ""}
                status={dailyPostStatus}
                card={dailyPost}
                onPress={openDailyPost}
                onRetry={() => handleFailure(dailyFailure, () => void loadDailyPost())}
                failureText={dailyFailure ? requestFailureCopy(locale, dailyFailure).title : undefined}
                failureAction={dailyFailure ? requestFailureCopy(locale, dailyFailure).action : undefined}
              /> : null}
              {dailyVideoStatus !== "disabled" ? <DailyVideoCard width={dailyCardWidth} status={dailyVideoStatus} card={dailyVideo}
                onPress={openDailyVideo} onRetry={() => handleFailure(videoFailure, () => void loadDailyVideo())}
                failureText={videoFailure ? requestFailureCopy(locale, videoFailure).title : undefined}
                failureAction={videoFailure ? requestFailureCopy(locale, videoFailure).action : undefined} /> : null}
              </ScrollView>
              {dailyPostStatus !== "disabled" && dailyVideoStatus !== "disabled" ? <View style={styles.dailyDots}>
                {[0, 1].map((page) => <View key={page} style={[styles.dailyDot, dailyPage === page && styles.dailyDotActive]} />)}
              </View> : null}
            </>
          ) : null}

          <View style={[styles.sectionHeading, styles.nuriSectionHeading]}>
            {Platform.OS === "web" ? (
              <Image
                source={{ uri: "/homepage/nuri-home-icon.svg" }}
                style={styles.nuriSectionIcon}
                resizeMode="contain"
              />
            ) : (
              <Ionicons name="home-outline" size={22} color={C.text} />
            )}
            <Text style={styles.sectionHeadingText}>{t("NURI之家")}</Text>
          </View>

          <Pressable
            onPress={openNuriChat}
            disabled={nuriPreviewStatus === "loading" || openingNuriChat.current}
            style={({ pressed }) => [styles.nuriStage, pressed && styles.nuriStagePressed]}
            testID="home-nuri-card"
            accessibilityRole="button"
            accessibilityLabel={nuriActionText}
            accessibilityState={{ busy: nuriPreviewStatus === "loading" }}
          >
            <LinearGradient
              colors={[C.purpleLight, C.purpleDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={styles.nuriCard}
            >
              {checkin?.state === "ready" && checkin.topic && !nuriFailure ? <View style={styles.nuriTopicPill}><Text style={styles.nuriTopicText} numberOfLines={1}>{t("上次聊到")} · {checkin.topic}</Text></View> : null}
              <Text style={styles.nuriMemo} numberOfLines={3} testID="home-nuri-memo">
                {nuriMemo}
              </Text>
              <View
                style={styles.nuriButton}
                testID="home-nuri-action"
                pointerEvents="none"
              >
                <Text style={styles.nuriButtonText} testID="home-nuri-action-label">
                  {nuriActionText}
                </Text>
              </View>
              <View pointerEvents="none" style={styles.mascotCrop} testID="home-mascot-crop">
                <Image source={mascotImage} style={styles.mascot} resizeMode="contain" testID="home-mascot-image" />
              </View>
            </LinearGradient>
          </Pressable>
          {checkinFailure ? <RequestFailureNotice error={checkinFailure} onRetry={() => void loadCheckin()}
            onPermission={() => router.push(aiPermissionHref("/(tabs)"))} onLogin={() => router.push("/login")} /> : null}
        </ScrollView>

        <View
          style={[
            styles.bottomNavigation,
            {
              minHeight: 74 + insets.bottom,
              paddingBottom:
                Platform.OS === "web"
                  ? ("env(safe-area-inset-bottom)" as unknown as number)
                  : insets.bottom,
            },
          ]}
          testID="home-bottom-navigation"
        >
          <Pressable
            style={styles.navigationItem}
            onPress={() => router.push("/knowledge" as never)}
            accessibilityRole="button"
            accessibilityLabel={t("知识图书馆")}
          >
            <HomeNavigationIcon name="knowledge" />
          </Pressable>
          <Pressable
            style={styles.navigationItem}
            onPress={() => router.push("/(tabs)/chats")}
            accessibilityRole="button"
            accessibilityLabel={t("对话")}
          >
            <HomeNavigationIcon name="chat" />
          </Pressable>
          <Pressable
            style={styles.navigationItem}
            onPress={() => router.push("/(tabs)/tasks")}
            accessibilityRole="button"
            accessibilityLabel={t("任务")}
          >
            <HomeNavigationIcon name="tasks" />
          </Pressable>
          <Pressable
            style={styles.navigationItem}
            onPress={() => router.push("/community")}
            accessibilityRole="button"
            accessibilityLabel={t("社区")}
          >
            <HomeNavigationIcon name="community" />
          </Pressable>
        </View>
      </View>

      <DevSheet
        visible={!!devSheet}
        emoji={devSheet?.emoji || ""}
        name={devSheet?.name || ""}
        onClose={() => setDevSheet(null)}
      />
      <Toast message={toastMsg} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#F4F1F9",
  },
  phoneCanvas: {
    alignSelf: "center",
    flex: 1,
    position: "relative",
    overflow: "hidden",
    backgroundColor: C.canvas,
  },
  scroll: {
    flex: 1,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 78,
    paddingHorizontal: 17,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 18,
  },
  logo: { width: 39, height: 46 },
  welcome: {
    flex: 1,
    color: C.text,
    fontFamily: "NotoSansSC_500Medium",
    fontSize: 20,
    lineHeight: 28,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: "hidden",
    backgroundColor: "#7355E7",
    borderWidth: 1,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarText: {
    color: "#FFFFFF",
    fontFamily: "NotoSansSC_700Bold",
    fontSize: 17,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 26,
    marginLeft: 17,
    marginTop: 6,
    marginBottom: 12,
  },
  dailySectionIcon: {
    width: 25,
    height: 24,
  },
  dailyDots: { flexDirection: "row", alignSelf: "center", gap: 6, marginTop: 10 },
  dailyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#DDD6EC" },
  dailyDotActive: { width: 18, backgroundColor: C.purple },
  nuriTopicPill: { alignSelf: "flex-start", maxWidth: "100%", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.22)", marginBottom: 8 },
  nuriTopicText: { color: "#FFFFFF", fontFamily: "NotoSansSC_600SemiBold", fontSize: 12, lineHeight: 18 },
  nuriSectionIcon: {
    width: 22,
    height: 22,
  },
  sectionHeadingText: {
    color: C.text,
    fontFamily: "NotoSansSC_700Bold",
    fontSize: 14,
    lineHeight: 22,
  },
  nuriSectionHeading: {
    marginTop: 25,
    marginBottom: 15,
  },
  nuriStage: {
    height: 312,
    marginHorizontal: 16,
    marginBottom: 8,
    position: "relative",
  },
  nuriStagePressed: { opacity: 0.94 },
  nuriCard: {
    height: 312,
    borderRadius: 36,
    paddingHorizontal: 28,
    paddingTop: 22,
    paddingBottom: 20,
    overflow: "hidden",
  },
  nuriMemo: {
    maxWidth: 326,
    color: "#FFFFFF",
    fontFamily: "NotoSansSC_600SemiBold",
    fontSize: 24,
    lineHeight: 34,
    letterSpacing: 0.2,
  },
  nuriButton: {
    position: "absolute",
    left: 28,
    bottom: 27,
    width: 145,
    minHeight: 56,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  nuriButtonText: {
    color: C.text,
    fontFamily: "NotoSansSC_700Bold",
    fontSize: 13,
    lineHeight: 20,
    letterSpacing: 0.5,
  },
  mascotCrop: {
    position: "absolute",
    left: "50%",
    right: -13,
    top: 150,
  },
  mascot: {
    width: "100%",
    // RN Image otherwise supplies the bundled source's intrinsic pixel height.
    height: undefined,
    aspectRatio: MASCOT_ASPECT_RATIO,
    transform: [{ scaleX: -1 }],
  },
  bottomNavigation: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    backgroundColor: C.canvas,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(38,27,69,0.14)",
    paddingTop: 9,
  },
  navigationItem: {
    flex: 1,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  navigationIcon: {
    width: 25,
    height: 26,
  },
  sheetRoot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.32)",
    justifyContent: "flex-end",
    zIndex: 50,
  },
  sheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 32,
    alignItems: "center",
    gap: 10,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: "#E0E0E8",
    borderRadius: 2,
    marginBottom: 4,
  },
  sheetEmoji: { fontSize: 36 },
  sheetTitle: { fontSize: 16, fontWeight: "700", color: C.text },
  sheetBtn: {
    marginTop: 10,
    backgroundColor: C.purple,
    borderRadius: 10,
    paddingVertical: 12,
    alignSelf: "stretch",
    alignItems: "center",
  },
  sheetBtnText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
});
