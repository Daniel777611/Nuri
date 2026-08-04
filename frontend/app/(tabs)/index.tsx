import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Image,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";

import {
  api,
  type PersonalizedFeedItem,
  type PreparedFeedItem,
  type PreparedLearningResource,
  type ResourceReadiness,
} from "@/src/api";
import { taskTypeMeta } from "@/src/taskMeta";
import Toast from "@/src/components/Toast";
import HeroCarousel, {
  type HeroCard,
  type HeroFeedState,
} from "@/src/components/HeroCarousel";
import { preparePersonalizedFeedOnce } from "@/src/feedPreparation";
import { storeRecommendationDetailHandoff } from "@/src/recommendationDetailHandoff";

const blurredTaskBackground = require("@/assets/images/tasks-blurred-background.png");

// 主页配色（复刻高保真设计稿）
const C = {
  bg: "#EEF0F8",
  text: "#1A1A2E",
  sub: "#5A5A7A",
  cardFrom: "#4B6FE8",
  cardTo: "#7B5CE7",
  taskBg: "#DCE8F8",
  nuriFrom: "#F5A855",
  nuriTo: "#F07A9A",
  btn: "#2D2080",
  taskPreview: "#3A3A5A",
  streak: "#5A7AC8",
};

const FIGMA_FRAME_WIDTH = 402;
const PREPARATION_RETRY_BASE_DELAY_MS = 30000;
const PREPARATION_RETRY_MAX_DELAY_MS = 300000;
const PREPARATION_RETRY_MAX_EXPONENT = 7;

// 坚持打卡天数（mock 默认 17）
const STREAK_DAYS = 17;

// 任务预览默认 mock（任务数据为空时展示）
const DEFAULT_TASKS = ["自我：今天给自己留30分钟独处", "亲子：每日户外活动20分钟"];

type NuriPreview = {
  sessionId: string;
  hasLastUserMessage: boolean;
  lastUserMessage: string;
};

type NuriPreviewStatus = "loading" | "ready" | "empty" | "error";

type HeroFeedMeta = {
  feedRequestId?: string;
  generatedAt?: string;
  initialContentCategory?: "authority" | "featured" | "case";
};

function exactPreparedPair(
  resources: PreparedLearningResource[] | undefined,
  category: HeroCard["content_category"],
) {
  if (!category || !Array.isArray(resources) || resources.length !== 2) return null;
  const article = resources.find(
    (resource) =>
      resource.kind === "article" && resource.content_category === category,
  );
  const video = resources.find(
    (resource) =>
      resource.kind === "video" && resource.content_category === category,
  );
  return article && video ? { article, video } : null;
}

function isReadyHeroCard(card: HeroCard): boolean {
  return (
    card.resource_readiness === "ready" &&
    card.resource_pair_complete === true &&
    exactPreparedPair(card.resources, card.content_category) !== null
  );
}

function awaitingPreparationCard(card: PersonalizedFeedItem): HeroCard {
  if (isReadyHeroCard(card as HeroCard)) return card as HeroCard;
  const resourceReadiness: ResourceReadiness = card.recommendation_id
    ? "preparing"
    : "unavailable";
  return {
    ...card,
    resource_readiness: resourceReadiness,
    resource_pair_complete: false,
    prepared_content_set_id: null,
  };
}

function mergePreparedCard(card: HeroCard, prepared: PreparedFeedItem | undefined): HeroCard {
  if (!prepared) {
    return {
      ...card,
      resource_readiness: "retryable",
      resource_pair_complete: false,
    };
  }
  const pair = exactPreparedPair(prepared.resources, card.content_category);
  const ready =
    prepared.resource_readiness === "ready" &&
    prepared.resource_pair_complete === true &&
    pair !== null;
  if (!ready) {
    return {
      ...card,
      resource_readiness:
        prepared.resource_readiness === "unavailable" ? "unavailable" : "retryable",
      resource_pair_complete: false,
      prepared_content_set_id: null,
      research_status: prepared.research_status,
    };
  }
  const category = card.content_category!;
  return {
    ...card,
    title: pair.article.title,
    publisher: pair.article.publisher,
    summary: pair.article.description || card.summary,
    resource_readiness: "ready",
    resource_pair_complete: true,
    prepared_content_set_id: prepared.prepared_content_set_id || null,
    resources: [pair.article, pair.video],
    research_status: prepared.research_status,
    resource_summary: {
      ...card.resource_summary,
      categories: {
        ...(card.resource_summary?.categories || {}),
        [category]: { article: 1, video: 1 },
      },
    },
  };
}

const conversationExcerpt = (text: string, maxLength = 26) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized === "[图片]") return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
};

const dayGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 11) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
};

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
  if (!visible) return null;
  return (
    <View style={styles.sheetRoot}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.sheet} testID="dev-sheet">
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetEmoji}>{emoji}</Text>
        <Text style={styles.sheetTitle}>{name}即将上线，敬请期待</Text>
        <Pressable onPress={onClose} style={styles.sheetBtn} testID="dev-sheet-close">
          <Text style={styles.sheetBtnText}>我知道了</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function Home() {
  const router = useRouter();
  const isHomeFocused = useIsFocused();
  const { feed_refresh: feedRefreshParam } = useLocalSearchParams<{
    feed_refresh?: string;
  }>();
  const feedRefresh = typeof feedRefreshParam === "string" ? feedRefreshParam : "";
  const { width: viewportWidth } = useWindowDimensions();
  // Keep the same content geometry as the 402px Figma phone frame. On a real
  // phone the frame shrinks with the viewport; on desktop it remains centered.
  const phoneWidth = Math.min(viewportWidth, FIGMA_FRAME_WIDTH);
  const carouselWidth = phoneWidth - 32;
  const [nickname, setNickname] = useState("Momo妈妈");
  const [pendingTasks, setPendingTasks] = useState<string[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [devSheet, setDevSheet] = useState<{ emoji: string; name: string } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [nuriPreview, setNuriPreview] = useState<NuriPreview | null>(null);
  const [nuriPreviewStatus, setNuriPreviewStatus] =
    useState<NuriPreviewStatus>("loading");
  const [heroCards, setHeroCards] = useState<HeroCard[]>([]);
  const [heroFeedState, setHeroFeedState] = useState<HeroFeedState>("loading");
  const [heroFeedRefreshing, setHeroFeedRefreshing] = useState(false);
  const [heroFeedMeta, setHeroFeedMeta] = useState<HeroFeedMeta>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nuriPreviewRequest = useRef(0);
  const heroRequest = useRef(0);
  // Distinguish a warm return from chat from a cold URL load that happens to
  // carry a refresh nonce. Only the warm path has real cards/fallback content
  // worth preserving while the replacement request is in flight.
  const heroCardsPresent = useRef(false);
  const consumedFeedRefreshes = useRef(new Set<string>());
  const activeFeedRefresh = useRef<string | null>(null);
  const heroImpressionKeys = useRef(new Set<string>());
  const openingNuriChat = useRef(false);
  const preparationRetryAttempt = useRef(0);
  const preparationRetrySet = useRef("");

  const showToast = useCallback((m: string) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2000);
  }, []);

  const loadNuriPreview = useCallback(async () => {
    const requestId = ++nuriPreviewRequest.current;
    setNuriPreviewStatus("loading");
    try {
      const preview: any = await api.getMainConversationPreview();
      if (requestId !== nuriPreviewRequest.current) return;
      if (!preview?.has_conversation || !preview?.session_id) {
        setNuriPreview(null);
        setNuriPreviewStatus("empty");
        return;
      }
      setNuriPreview({
        sessionId: preview.session_id,
        hasLastUserMessage: !!preview.last_user_message,
        lastUserMessage: preview.last_user_message?.text || "",
      });
      setNuriPreviewStatus(preview.last_user_message ? "ready" : "empty");
    } catch {
      if (requestId === nuriPreviewRequest.current) {
        setNuriPreviewStatus("error");
      }
    }
  }, []);

  const loadPersonalizedFeed = useCallback(async ({
    preserveExisting = false,
    clientRefresh,
  }: {
    preserveExisting?: boolean;
    clientRefresh?: string;
  } = {}) => {
    const requestId = ++heroRequest.current;
    if (clientRefresh) activeFeedRefresh.current = clientRefresh;
    if (preserveExisting) {
      setHeroFeedRefreshing(true);
    } else {
      setHeroFeedRefreshing(false);
      heroCardsPresent.current = false;
      setHeroCards([]);
      setHeroFeedState("loading");
      setHeroFeedMeta({});
    }
    try {
      const response = await api.getPersonalizedFeed(3, clientRefresh);
      if (requestId !== heroRequest.current) {
        if (clientRefresh) {
          consumedFeedRefreshes.current.delete(clientRefresh);
          if (activeFeedRefresh.current === clientRefresh) {
            activeFeedRefresh.current = null;
          }
        }
        return;
      }
      const items = Array.isArray(response?.items) ? response.items : [];
      const categoryOrder = { authority: 0, featured: 1, case: 2 } as const;
      const validItems = items
        .filter(
          (item): item is PersonalizedFeedItem =>
            typeof item?.id === "string" &&
            typeof item?.title === "string" &&
            item.content_category !== undefined &&
            item.content_category in categoryOrder,
        )
        .sort(
          (left, right) =>
            categoryOrder[left.content_category!] - categoryOrder[right.content_category!],
        );
      const uniqueCategories = new Set(validItems.map((item) => item.content_category));
      const categoryCards =
        validItems.length === 3 && uniqueCategories.size === 3 ? validItems : [];
      if (preserveExisting && categoryCards.length === 0) {
        throw new Error("personalized refresh returned no complete category set");
      }
      const nextFeedMeta: HeroFeedMeta = {
        feedRequestId: response.feed_request_id || undefined,
        generatedAt: response.generated_at || undefined,
        initialContentCategory: response.initial_content_category,
      };
      const nextFeedState: HeroFeedState =
        categoryCards.length > 0 &&
          ["conversation", "profile"].includes(response.personalization_mode)
          ? "personalized"
          : "curated";
      const candidateCards = categoryCards.map(awaitingPreparationCard);

      // A cold load may show honest per-card preparation states immediately.
      // A warm return from chat keeps the previous feed untouched until the
      // replacement cards and their exact article/video pairs are all resolved.
      if (!preserveExisting) {
        setHeroCards(candidateCards);
        setHeroFeedMeta(nextFeedMeta);
        setHeroFeedState(nextFeedState);
        heroCardsPresent.current = candidateCards.length > 0;
      }

      const needsPreparation = candidateCards.some(
        (card) => !isReadyHeroCard(card) && Boolean(card.recommendation_id),
      );
      // Prepare the complete three-lane set together. Sending only the missing
      // lane can produce a different content_set_id and mix two research runs.
      const cardsToPrepare = needsPreparation
        ? candidateCards.filter((card) => Boolean(card.recommendation_id))
        : [];
      let preparedCards = candidateCards;
      if (cardsToPrepare.length > 0) {
        try {
          const prepared = await preparePersonalizedFeedOnce(
            cardsToPrepare.map((card) => ({
              card_id: card.id,
              recommendation_id: card.recommendation_id!,
            })),
          );
          if (requestId !== heroRequest.current) return;
          const preparedItems = Array.isArray(prepared?.items) ? prepared.items : [];
          const preparedSetIds = new Set(
            preparedItems
              .map((item) => item.prepared_content_set_id)
              .filter((value): value is string => Boolean(value)),
          );
          const completePreparedSet =
            preparedItems.length === cardsToPrepare.length &&
            preparedItems.every(
              (item) =>
                item.resource_readiness === "ready" &&
                item.resource_pair_complete === true &&
                Boolean(item.prepared_content_set_id),
            ) &&
            preparedSetIds.size === 1;
          if (!completePreparedSet) {
            console.warn("[home-feed] preparation response incomplete", {
              requestedCount: cardsToPrepare.length,
              receivedCount: preparedItems.length,
              readyCount: preparedItems.filter(
                (item) =>
                  item.resource_readiness === "ready" &&
                  item.resource_pair_complete === true,
              ).length,
              contentSetCount: preparedSetIds.size,
            });
            throw new Error("prepared recommendation set was incomplete");
          }
          const preparedByRecommendation = new Map(
            preparedItems.map((item) => [
              item.recommendation_id,
              item,
            ]),
          );
          preparedCards = candidateCards.map((card) =>
            !card.recommendation_id
              ? card
              : mergePreparedCard(
                  card,
                  preparedByRecommendation.get(card.recommendation_id),
                ),
          );
        } catch (error) {
          if (requestId !== heroRequest.current) return;
          const status =
            error && typeof error === "object" && "status" in error
              ? Number((error as { status?: unknown }).status) || undefined
              : undefined;
          console.warn("[home-feed] preparation attempt failed", {
            errorName: error instanceof Error ? error.name : typeof error,
            status,
            requestedCount: cardsToPrepare.length,
            preserveExisting,
          });
          if (preserveExisting) {
            throw new Error("replacement recommendations were not fully prepared");
          }
          preparedCards = candidateCards.map((card) =>
            isReadyHeroCard(card) || !card.recommendation_id
              ? card
              : {
                  ...card,
                  resource_readiness: "retryable" as const,
                  resource_pair_complete: false,
                },
          );
        }
      }
      if (requestId !== heroRequest.current) return;
      if (
        preserveExisting &&
        (preparedCards.length !== 3 || !preparedCards.every(isReadyHeroCard))
      ) {
        throw new Error("replacement recommendations were not fully prepared");
      }

      // This is the only warm-refresh commit point: title, source, resources,
      // feed metadata and readiness switch together, so old/new feeds never mix.
      setHeroCards(preparedCards);
      setHeroFeedMeta(nextFeedMeta);
      setHeroFeedState(nextFeedState);
      heroCardsPresent.current = preparedCards.length > 0;
      if (activeFeedRefresh.current === clientRefresh) {
        activeFeedRefresh.current = null;
      }
      setHeroFeedRefreshing(false);
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status?: unknown }).status) || undefined
          : undefined;
      console.warn("[home-feed] load attempt failed", {
        errorName: error instanceof Error ? error.name : typeof error,
        status,
        preserveExisting,
        hasClientRefresh: Boolean(clientRefresh),
      });
      // A nonce is a single successful refresh, not a single network attempt.
      // Releasing it here lets the next focus recover from a transient failure
      // without requiring another chat turn or a document reload.
      if (clientRefresh) {
        consumedFeedRefreshes.current.delete(clientRefresh);
        if (activeFeedRefresh.current === clientRefresh) {
          activeFeedRefresh.current = null;
        }
      }
      if (requestId === heroRequest.current) {
        setHeroFeedRefreshing(false);
        if (!preserveExisting) {
          setHeroCards([]);
          setHeroFeedState("curated");
          setHeroFeedMeta({});
          heroCardsPresent.current = false;
        }
      }
    }
  }, []);

  useEffect(() => {
    const recommendationSetKey = heroCards
      .map((card) => card.recommendation_id || `${card.id}:${card.content_category || ""}`)
      .sort()
      .join("|");
    if (preparationRetrySet.current !== recommendationSetKey) {
      preparationRetrySet.current = recommendationSetKey;
      preparationRetryAttempt.current = 0;
    }
    const hasRetryableCard = heroCards.some(
      (card) => card.resource_readiness === "retryable" && card.recommendation_id,
    );
    if (!hasRetryableCard) {
      if (heroCards.length > 0 && heroCards.every(isReadyHeroCard)) {
        preparationRetryAttempt.current = 0;
      }
      return;
    }
    // A transient provider or network failure must never strand the carousel in
    // a terminal-looking state. Keep recovering while Home is visible, but
    // start at 30 seconds and back off to five minutes so rate limits or a
    // scarce high-quality result do not create an expensive request loop.
    if (!isHomeFocused || heroFeedRefreshing) return;

    const delayMs = Math.min(
      PREPARATION_RETRY_MAX_DELAY_MS,
      PREPARATION_RETRY_BASE_DELAY_MS *
        2 ** Math.min(preparationRetryAttempt.current, PREPARATION_RETRY_MAX_EXPONENT),
    );
    const timer = setTimeout(() => {
      preparationRetryAttempt.current = Math.min(
        preparationRetryAttempt.current + 1,
        PREPARATION_RETRY_MAX_EXPONENT + 1,
      );
      void loadPersonalizedFeed({ preserveExisting: true });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [heroCards, heroFeedRefreshing, isHomeFocused, loadPersonalizedFeed]);

  const openNuriChat = async () => {
    if (nuriPreviewStatus === "loading" || openingNuriChat.current) return;
    if (nuriPreviewStatus === "error" && !nuriPreview) {
      await loadNuriPreview();
      return;
    }

    openingNuriChat.current = true;
    let navigated = false;
    try {
      if (nuriPreview?.sessionId) {
        router.push(`/chat/${nuriPreview.sessionId}`);
        navigated = true;
        return;
      }
      const session = await api.getOrStartMainSession();
      router.push(`/chat/${session.id}`);
      navigated = true;
    } catch {
      showToast("对话暂时无法打开，请稍后再试");
    } finally {
      if (!navigated) openingNuriChat.current = false;
    }
  };

  useFocusEffect(
    useCallback(() => {
      api
        .me()
        .then((me: any) => me?.nickname && setNickname(me.nickname))
        .catch(() => {});
      api
        .listTasks()
        .then((ts: any[]) => {
          const pending = ts.filter((t) => !t.completed_at);
          setPendingCount(pending.length);
          setPendingTasks(
            pending.slice(0, 2).map((t) => `${taskTypeMeta(t.task_type).prefix}：${t.title}`)
          );
        })
        .catch(() => {});
    }, [])
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

  useFocusEffect(
    useCallback(() => {
      const isNewChatRefresh =
        !!feedRefresh && !consumedFeedRefreshes.current.has(feedRefresh);
      if (isNewChatRefresh) {
        consumedFeedRefreshes.current.add(feedRefresh);
      }
      void loadPersonalizedFeed({
        // Keep the last good cards visible while every warm-focus refresh is
        // resolved. This preserves profile/age edits as ranking inputs without
        // flashing an empty carousel, and the chat nonce still guarantees that
        // a just-completed turn bypasses intermediary caches.
        preserveExisting: heroCardsPresent.current,
        clientRefresh: isNewChatRefresh ? feedRefresh : undefined,
      });
      return () => {
        heroRequest.current += 1;
        if (
          isNewChatRefresh &&
          activeFeedRefresh.current === feedRefresh
        ) {
          activeFeedRefresh.current = null;
          consumedFeedRefreshes.current.delete(feedRefresh);
        }
      };
    }, [feedRefresh, loadPersonalizedFeed])
  );

  const previewTasks = pendingTasks.length ? pendingTasks : DEFAULT_TASKS;
  const previewCount = pendingTasks.length ? pendingCount : 3;
  const hasLoadedPreview = !!nuriPreview;
  const lastUserExcerpt = nuriPreview?.hasLastUserMessage
    ? conversationExcerpt(nuriPreview.lastUserMessage)
    : "";
  const nuriMemo =
    hasLoadedPreview && nuriPreview?.hasLastUserMessage
      ? lastUserExcerpt
        ? `Hi！${dayGreeting()}，${nickname}。上次你说：“${lastUserExcerpt}” 我们接着聊。`
        : `Hi！${dayGreeting()}，${nickname}。上次你分享了一张图片，我们可以从那里接着聊。`
      : nuriPreviewStatus === "error"
        ? `Hi！${dayGreeting()}，${nickname}。上次的对话暂时没能加载，点一下再试试。`
        : nuriPreviewStatus === "loading"
          ? `Hi！${dayGreeting()}，${nickname}。正在整理我们上次的对话…`
          : `Hi！${dayGreeting()}，${nickname}。今天想聊聊什么？我在这里陪你。`;
  const nuriActionText =
    nuriPreviewStatus === "error" && !nuriPreview
      ? "重试加载"
      : nuriPreview?.hasLastUserMessage
        ? "继续对话"
        : "开始对话";

  const trackHeroImpression = useCallback(
    (card: HeroCard, position: number) => {
      const feedKey = heroFeedMeta.feedRequestId || heroFeedMeta.generatedAt || "curated";
      const impressionKey = `${feedKey}:${card.recommendation_id || card.id}:${position}`;
      if (heroImpressionKeys.current.has(impressionKey)) return;
      heroImpressionKeys.current.add(impressionKey);
      api
        .trackRecommendationEvent({
          event: "feed_impression",
          card_id: card.id,
          recommendation_id: card.recommendation_id || undefined,
          feed_request_id: heroFeedMeta.feedRequestId,
          locale: card.resource_summary?.preferred_locale,
          content_category: card.content_category,
          position: card.rank || position,
        })
        .catch(() => {});
    },
    [heroFeedMeta.feedRequestId, heroFeedMeta.generatedAt],
  );

  const openHeroCard = useCallback(
    (card: HeroCard) => {
      const position =
        card.rank ||
        Math.max(
          1,
          heroCards.findIndex(
            (item) =>
              (item.recommendation_id || `${item.id}:${item.content_category}`) ===
              (card.recommendation_id || `${card.id}:${card.content_category}`),
          ) + 1,
        );
      const preparationItems = heroCards
        .filter(
          (item): item is HeroCard & { recommendation_id: string } =>
            Boolean(item.recommendation_id),
        )
        .map((item) => ({
          card_id: item.id,
          recommendation_id: item.recommendation_id,
        }));
      const handoffKey = storeRecommendationDetailHandoff(card, preparationItems);
      api
        .trackRecommendationEvent({
          event: "card_open",
          card_id: card.id,
          recommendation_id: card.recommendation_id || undefined,
          feed_request_id: heroFeedMeta.feedRequestId,
          locale: card.resource_summary?.preferred_locale,
          content_category: card.content_category,
          position,
        })
        .catch(() => {});
      router.push({
        pathname: "/detail/[id]",
        params: {
          id: card.id,
          ...(card.content_category
            ? { content_category: card.content_category }
            : {}),
          ...(card.related_session_id ? { session_id: card.related_session_id } : {}),
          ...(card.context_created_at
            ? { context_created_at: card.context_created_at }
            : {}),
          ...(card.recommendation_id
            ? { recommendation_id: card.recommendation_id }
            : {}),
          ...(card.prepared_content_set_id
            ? { prepared_content_set_id: card.prepared_content_set_id }
            : {}),
          ...(heroFeedMeta.feedRequestId
            ? { feed_request_id: heroFeedMeta.feedRequestId }
            : {}),
          handoff_key: handoffKey,
          rank: String(position),
        },
      });
      if (
        !isReadyHeroCard(card) &&
        card.resource_readiness !== "unavailable" &&
        preparationItems.length > 0
      ) {
        // Navigation is never held hostage by research. Detail immediately
        // paints the guide handoff and observes this shared request in place.
        preparationRetryAttempt.current = 0;
        void preparePersonalizedFeedOnce(preparationItems).catch((error) => {
          console.warn("[home-feed] background preparation after open failed", {
            errorName: error instanceof Error ? error.name : typeof error,
            requestedCount: preparationItems.length,
          });
        });
      }
    },
    [heroCards, heroFeedMeta.feedRequestId, router],
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
      <Image source={blurredTaskBackground} style={styles.backgroundImage} resizeMode="cover" />
      <View pointerEvents="none" style={styles.haloBlue} />
      <View pointerEvents="none" style={styles.haloRed} />
      <BlurView pointerEvents="none" intensity={100} tint="light" style={StyleSheet.absoluteFill} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {/* 顶部栏：logo + 欢迎语 + 头像 */}
        <View style={styles.topBar}>
          <Image
            source={require("../../assets/images/nuri-logo.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.welcome} numberOfLines={1}>
            欢迎，{nickname}！
          </Text>
          <Pressable
            onPress={() => router.push("/(tabs)/profile")}
            testID="home-avatar"
            hitSlop={6}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{nickname.slice(0, 1)}</Text>
            </View>
          </Pressable>
        </View>

        {/* 内容推荐轮播 */}
        <HeroCarousel
          width={carouselWidth}
          cards={heroCards}
          feedState={heroFeedRefreshing ? "refreshing" : heroFeedState}
          onCardPress={openHeroCard}
          onCardVisible={trackHeroImpression}
          visibilityScope={heroFeedMeta.feedRequestId || heroFeedMeta.generatedAt}
          initialContentCategory={heroFeedMeta.initialContentCategory}
        />

        {/* 第一行：今日任务 + Nuri的家 */}
        <View style={styles.row}>
          <Pressable
            style={[styles.moduleCard, { backgroundColor: C.taskBg }]}
            onPress={() => router.push("/(tabs)/tasks")}
            testID="home-tasks-card"
          >
            <Text style={styles.moduleTitle}>今日任务</Text>
            <Text style={styles.moduleSub}>
              您已坚持打卡{STREAK_DAYS}天！加油！
            </Text>
            <View style={[styles.innerCard, { flex: 1 }]}>
              <Text style={styles.taskCount}>{previewCount} 件任务正在进行</Text>
              {previewTasks.map((t, i) => (
                <View key={i} style={styles.taskRow}>
                  <View style={styles.checkbox} />
                  <Text style={styles.taskName} numberOfLines={1}>
                    {t}
                  </Text>
                </View>
              ))}
              <Text style={styles.taskEllipsis}>……</Text>
              <View style={{ flex: 1, minHeight: 8 }} />
              <Pressable
                onPress={() => showToast("提醒功能即将上线")}
                style={styles.primaryBtn}
                testID="home-remind-btn"
              >
                <Text style={styles.primaryBtnText}>开启提醒</Text>
              </Pressable>
            </View>
          </Pressable>

          <Pressable
            style={styles.moduleCardNoBg}
            onPress={openNuriChat}
            testID="home-nuri-card"
          >
            <LinearGradient
              colors={[C.nuriFrom, C.nuriTo]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.nuriCard}
            >
              <Text style={styles.moduleTitle}>Nuri的家</Text>
              <Text style={styles.nuriMemo} numberOfLines={5} testID="home-nuri-memo">
                {nuriMemo}
              </Text>
              <View style={{ flex: 1 }} />
              <View style={styles.continueCard}>
                <View style={styles.continueRow}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name="chatbox-ellipses-outline" size={18} color={C.text} />
                    <Text style={styles.continueText} testID="home-nuri-action-label">
                      {nuriActionText}
                    </Text>
                  </View>
                  <Ionicons name="arrow-forward" size={18} color={C.text} />
                </View>
              </View>
            </LinearGradient>
          </Pressable>
        </View>

        {/* 第二/三行：左列（知识图书馆 + 我的家）、右列（社区中心） */}
        <View style={styles.row}>
          <View style={{ flex: 1, gap: 12 }}>
            <Pressable
              style={[styles.moduleCard, styles.lightCard, { minHeight: 88 }]}
              onPress={() => setDevSheet({ emoji: "🌱", name: "知识图书馆" })}
              testID="home-library-card"
            >
              <Text style={styles.moduleTitle}>知识图书馆</Text>
            </Pressable>

            <Pressable
              style={[styles.moduleCard, styles.lightCard]}
              onPress={() => setDevSheet({ emoji: "🏡", name: "我的家" })}
              testID="home-myhome-card"
            >
              <Text style={styles.moduleTitle}>我的家</Text>
              <Text style={styles.moduleSub}>灵感：试着写下今天的心情。</Text>
              <View style={{ height: 12 }} />
              <Pressable
                onPress={() => setDevSheet({ emoji: "🏡", name: "我的家" })}
                style={styles.primaryBtn}
                testID="home-record-btn"
              >
                <Text style={styles.primaryBtnText}>记录当下</Text>
              </Pressable>
            </Pressable>
          </View>

          <Pressable
            style={[styles.moduleCard, { backgroundColor: C.taskBg, flex: 1 }]}
            onPress={() => setDevSheet({ emoji: "🌻", name: "社区中心" })}
            testID="home-community-card"
          >
            <Text style={styles.moduleTitle}>社区中心</Text>
            <Text style={styles.moduleSub}>您上次关于牙医的回答得到了17个人的赞！</Text>
            <View style={{ flex: 1 }} />
            <View style={styles.innerCard}>
              <Text style={styles.communityTopic}>
                “宝宝18个月饮食”的问题也许可以和他们交流
              </Text>
              <View style={styles.avatarRow}>
                {["#F5A855", "#7B8FE8", "#A87CC5"].map((color, i) => (
                  <View
                    key={i}
                    style={[
                      styles.miniAvatar,
                      { backgroundColor: color, marginLeft: i === 0 ? 0 : -10 },
                    ]}
                  />
                ))}
                <View style={styles.plusAvatar}>
                  <Ionicons name="add" size={18} color={C.btn} />
                </View>
              </View>
            </View>
          </Pressable>
        </View>
      </ScrollView>
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
  safe: { flex: 1, backgroundColor: "#F6F4FA" },
  phoneCanvas: { alignSelf: "center", flex: 1, overflow: "hidden" },
  backgroundImage: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  // 两枚居中的超大椭圆营造上蓝下红、带弧度的日落式背景。
  haloBlue: { position: "absolute", width: 520, height: 300, borderRadius: 260, backgroundColor: "rgba(123,166,255,0.68)", left: "50%", marginLeft: -260, top: -155 },
  haloRed: { position: "absolute", width: 520, height: 300, borderRadius: 260, backgroundColor: "rgba(255,118,139,0.62)", left: "50%", marginLeft: -260, bottom: -155 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 10,
  },
  logo: { width: 39, height: 46 },
  welcome: { flex: 1, fontSize: 24, fontWeight: "900", color: "#3A2F5A" },
  avatar: {
    width: 33,
    height: 33,
    borderRadius: 17,
    backgroundColor: "#7B5CE7",
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  row: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 12,
    marginTop: 12,
  },
  moduleCard: { flex: 1, borderRadius: 12, padding: 14, shadowColor: "#000", shadowOffset: { width: -2, height: 1 }, shadowOpacity: 0.08, shadowRadius: 5, elevation: 2 },
  moduleCardNoBg: { flex: 1 },
  lightCard: { backgroundColor: "#FFFFFF" },
  nuriCard: { flex: 1, borderRadius: 12, padding: 14, minHeight: 224 },
  moduleTitle: { fontSize: 14, fontWeight: "700", color: C.text },
  moduleSub: { fontSize: 10, color: C.sub, marginTop: 5, lineHeight: 15 },
  innerCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
  },
  taskCount: { fontSize: 11, fontWeight: "700", color: C.text },
  taskRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 7 },
  checkbox: {
    width: 11,
    height: 11,
    borderRadius: 3,
    borderWidth: 1.2,
    borderColor: "#9AA2B8",
  },
  taskName: { flex: 1, fontSize: 10, color: C.taskPreview, lineHeight: 14 },
  taskEllipsis: { fontSize: 10, color: C.taskPreview, marginTop: 3, marginLeft: 17 },
  primaryBtn: {
    backgroundColor: C.btn,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: "center",
    alignSelf: "flex-start",
  },
  primaryBtnText: { color: "#FFFFFF", fontSize: 11, fontWeight: "600" },
  nuriMemo: { fontSize: 10, color: "#3A2A3E", lineHeight: 15, marginTop: 7 },
  continueCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 12,
    marginTop: 10,
  },
  continueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  continueText: { fontSize: 12, fontWeight: "700", color: C.text },
  communityTopic: { fontSize: 10, color: C.taskPreview, lineHeight: 15 },
  avatarRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  miniAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  plusAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.2,
    borderColor: C.btn,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
    backgroundColor: "#FFFFFF",
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
    backgroundColor: C.btn,
    borderRadius: 10,
    paddingVertical: 12,
    alignSelf: "stretch",
    alignItems: "center",
  },
  sheetBtnText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
});
