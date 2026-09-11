import { useCallback, useEffect, useRef, useState } from "react";
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
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";

import {
  api,
  type DailyPostCard as DailyPost,
  type MainConversationPreview,
} from "@/src/api";
import Toast from "@/src/components/Toast";
import DailyPostCard, { type DailyPostStatus } from "@/src/components/DailyPostCard";
import { useT } from "@/src/i18n";

const mascotImage = require("@/assets/images/homepage/mascot.png");
const nativeLogoImage = require("@/assets/images/nuri-logo.png");

const C = {
  canvas: "#FFF9F3",
  text: "#261B45",
  purple: "#4C368C",
  purpleLight: "#7751E4",
  purpleDark: "#422D7E",
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
  const { t } = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isHomeFocused = useIsFocused();
  const { width: viewportWidth } = useWindowDimensions();
  // Keep the same content geometry as the 402px Figma phone frame. On a real
  // phone the frame shrinks with the viewport; on desktop it remains centered.
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const dailyCardWidth = Math.max(280, phoneWidth - 60);
  const [nickname, setNickname] = useState("Momo妈妈");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [devSheet, setDevSheet] = useState<{ emoji: string; name: string } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [nuriPreview, setNuriPreview] = useState<NuriPreview | null>(null);
  const [nuriPreviewStatus, setNuriPreviewStatus] =
    useState<NuriPreviewStatus>("loading");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nuriPreviewRequest = useRef(0);
  const openingNuriChat = useRef(false);
  // Today's card. Built once per local day on the server; every focus just
  // re-reads it, which is also how a new day's card appears after midnight.
  const [dailyPost, setDailyPost] = useState<DailyPost | null>(null);
  const [dailyPostStatus, setDailyPostStatus] = useState<DailyPostStatus>("loading");
  const dailyPostRequest = useRef(0);
  const dailyPostPolls = useRef(0);

  const showToast = useCallback((m: string) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2000);
  }, []);

  const loadDailyPost = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    const requestId = ++dailyPostRequest.current;
    // A warm focus keeps the card on screen while it is re-read.
    if (!quiet) setDailyPostStatus((current) => (current === "ready" ? current : "loading"));
    try {
      const res = await api.getDailyPost();
      if (requestId !== dailyPostRequest.current) return;
      if (res.state === "ready" && res.card) {
        setDailyPost(res.card);
        setDailyPostStatus("ready");
        dailyPostPolls.current = 0;
      } else if (res.state === "pending") {
        setDailyPostStatus("pending");
      } else {
        setDailyPost(null);
        setDailyPostStatus(res.state === "unavailable" ? "error" : "empty");
      }
    } catch {
      if (requestId === dailyPostRequest.current) {
        setDailyPostStatus((current) => (current === "ready" ? current : "error"));
      }
    }
  }, []);

  useEffect(() => {
    if (dailyPostStatus !== "pending" || !isHomeFocused) return;
    if (dailyPostPolls.current >= DAILY_POST_POLL_LIMIT) {
      setDailyPostStatus("empty");
      return;
    }
    const timer = setTimeout(() => {
      dailyPostPolls.current += 1;
      void loadDailyPost({ quiet: true });
    }, DAILY_POST_POLL_MS);
    return () => clearTimeout(timer);
  }, [dailyPostStatus, isHomeFocused, loadDailyPost]);

  const openDailyPost = useCallback(
    (card: DailyPost) => {
      void api.dailyPostEvent(card.id, "open").catch(() => {});
      router.push("/daily-post");
    },
    [router],
  );

  const loadNuriPreview = useCallback(async () => {
    const requestId = ++nuriPreviewRequest.current;
    setNuriPreviewStatus("loading");
    try {
      const preview: MainConversationPreview = await api.getMainConversationPreview();
      if (requestId !== nuriPreviewRequest.current) return;
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
    } catch {
      if (requestId === nuriPreviewRequest.current) {
        setNuriPreviewStatus("error");
      }
    }
  }, []);

  const openNuriChat = async () => {
    if (nuriPreviewStatus === "loading" || openingNuriChat.current) return;
    if (nuriPreviewStatus === "error" && !nuriPreview) {
      await loadNuriPreview();
      return;
    }

    openingNuriChat.current = true;
    let navigated = false;
    try {
      // Preview is display data and can outlive a deleted legacy session in a
      // mounted browser tab. Always ask the idempotent server endpoint for the
      // account's current canonical conversation immediately before routing.
      const session = await api.getOrStartMainSession();
      router.push(`/chat/${session.id}`);
      navigated = true;
    } catch {
      showToast(t("对话暂时无法打开，请稍后再试"));
    } finally {
      if (!navigated) openingNuriChat.current = false;
    }
  };

  useFocusEffect(
    useCallback(() => {
      api
        .me()
        .then((me: any) => {
          if (me?.nickname) setNickname(me.nickname);
          const candidate = me?.avatar_url || me?.photo_url || me?.picture;
          setAvatarUrl(
            typeof candidate === "string" && /^https:\/\//i.test(candidate)
              ? candidate
              : null,
          );
        })
        .catch(() => {});
    }, [])
  );

  useFocusEffect(
    useCallback(() => {
      dailyPostPolls.current = 0;
      void loadDailyPost();
      return () => {
        dailyPostRequest.current += 1;
      };
    }, [loadDailyPost])
  );

  useFocusEffect(
    useCallback(() => {
      void loadNuriPreview();
      return () => {
        nuriPreviewRequest.current += 1;
        openingNuriChat.current = false;
      };
    }, [loadNuriPreview])
  );

  const hasLoadedPreview = !!nuriPreview;
  const lastUserExcerpt = nuriPreview?.hasLastUserMessage
    ? conversationExcerpt(nuriPreview.lastUserMessage)
    : "";
  const memoryExcerpt = nuriPreview?.memoryText
    ? conversationExcerpt(nuriPreview.memoryText)
    : "";
  const hasPersonalContext = !!nuriPreview?.hasPersonalContext;
  const nuriMemo =
    hasLoadedPreview && nuriPreview?.hasLastUserMessage
      ? lastUserExcerpt
        ? t("你还记得我们上次谈到“{excerpt}”吗？最近怎么样？", {
            excerpt: lastUserExcerpt,
          })
        : t("你还记得我们上次分享的那张图片吗？最近怎么样？")
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
                  <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
                ) : (
                  <Text style={styles.avatarText}>{nickname.slice(0, 1)}</Text>
                )}
              </View>
            </Pressable>
          </View>

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

          <DailyPostCard
            width={dailyCardWidth}
            nickname={dailyPost?.nickname ?? ""}
            status={dailyPostStatus}
            card={dailyPost}
            onPress={openDailyPost}
            onRetry={() => void loadDailyPost()}
          />

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
              end={{ x: 1, y: 1 }}
              style={styles.nuriCard}
            >
              <Text style={styles.nuriMemo} numberOfLines={4} testID="home-nuri-memo">
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
            </LinearGradient>
            <View pointerEvents="none" style={styles.mascotCrop}>
              <Image source={mascotImage} style={styles.mascot} resizeMode="contain" />
            </View>
          </Pressable>
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
            onPress={() => setDevSheet({ emoji: "🌱", name: t("知识图书馆") })}
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
    height: 322,
    marginHorizontal: 16,
    marginBottom: 8,
    position: "relative",
    overflow: "visible",
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
    right: -2,
    top: 126,
    width: 170,
    height: 201,
    overflow: "hidden",
  },
  mascot: {
    position: "absolute",
    right: 0,
    top: 0,
    width: 170,
    height: 255,
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
