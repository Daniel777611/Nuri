import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Image,
  Linking,
  Platform,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";

import {
  api,
  type MainConversationPreview,
  type PersonalizedFeedItem,
  type PreparedFeedItem,
  type PreparedLearningResource,
  type ResourceReadiness,
} from "@/src/api";
import Toast from "@/src/components/Toast";
import HeroCarousel, {
  type DailySelectionResource,
  type HeroCard,
  type HeroFeedState,
} from "@/src/components/HeroCarousel";
import { preparePersonalizedFeedOnce } from "@/src/feedPreparation";
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
const PREPARATION_RETRY_BASE_DELAY_MS = 30000;
const PREPARATION_RETRY_MAX_DELAY_MS = 300000;
const PREPARATION_RETRY_MAX_EXPONENT = 7;

type NuriPreview = {
  sessionId: string | null;
  hasLastUserMessage: boolean;
  lastUserMessage: string;
  memoryText: string;
  hasPersonalContext: boolean;
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
    delivery_title: prepared.delivery_title || card.delivery_title,
    publisher: pair.article.publisher,
    source_label: prepared.source_label || card.source_label || pair.article.publisher,
    language_label: prepared.language_label || card.language_label,
    estimated_time_label:
      prepared.estimated_time_label || card.estimated_time_label,
    applicable_stage: prepared.applicable_stage || card.applicable_stage,
    child_age_context: prepared.child_age_context || card.child_age_context,
    guide: prepared.guide || card.guide,
    action_steps: prepared.action_steps || card.action_steps,
    summary: pair.article.description || card.summary,
    resource_readiness: "ready",
    resource_pair_complete: true,
    prepared_content_set_id: prepared.prepared_content_set_id || null,
    active_pair_id: prepared.active_pair_id || null,
    alternate_count: prepared.alternate_count || 0,
    alternate_resource_pairs: prepared.alternate_resource_pairs || [],
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
  const { feed_refresh: feedRefreshParam } = useLocalSearchParams<{
    feed_refresh?: string;
  }>();
  const feedRefresh = typeof feedRefreshParam === "string" ? feedRefreshParam : "";
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
  const [heroCards, setHeroCards] = useState<HeroCard[]>([]);
  const [heroFeedState, setHeroFeedState] = useState<HeroFeedState>("loading");
  const [heroFeedRefreshing, setHeroFeedRefreshing] = useState(false);
  const [heroPublicationState, setHeroPublicationState] =
    useState<"idle" | "preparing">("idle");
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
  const publicationPollInFlight = useRef(false);

  const showToast = useCallback((m: string) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2000);
  }, []);

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
      setHeroPublicationState("idle");
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
      if (preserveExisting && response.publication_state === "preparing") {
        // The server keeps returning the last published package while it builds
        // the next complete three-lane set. Never replace or block that old
        // package; a focus-aware poll below atomically picks up the new one.
        setHeroFeedRefreshing(true);
        setHeroPublicationState("preparing");
        if (activeFeedRefresh.current === clientRefresh) {
          activeFeedRefresh.current = null;
        }
        return;
      }
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
        (card) =>
          Boolean(card.recommendation_id) &&
          (!isReadyHeroCard(card) ||
            !card.prepared_content_set_id),
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
            if (
              preserveExisting &&
              (prepared?.publication_state === "preparing" ||
                prepared?.upgrade_state === "preparing")
            ) {
              setHeroPublicationState("preparing");
            }
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
      setHeroPublicationState("idle");
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
        if (
          preserveExisting &&
          heroCardsPresent.current &&
          (status === undefined ||
            status === 408 ||
            status === 409 ||
            status === 425 ||
            status === 429 ||
            status >= 500)
        ) {
          // A warm refresh always keeps the last published package usable.
          // Retry in the background even when /feed/personalized itself does
          // not expose publication_state (older deployments omit that field).
          setHeroPublicationState("preparing");
        }
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
    if (
      heroPublicationState !== "preparing" ||
      !isHomeFocused ||
      !heroCardsPresent.current
    ) {
      return;
    }
    const poll = () => {
      if (publicationPollInFlight.current) return;
      publicationPollInFlight.current = true;
      void loadPersonalizedFeed({ preserveExisting: true }).finally(() => {
        publicationPollInFlight.current = false;
      });
    };
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [heroPublicationState, isHomeFocused, loadPersonalizedFeed]);

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
      : hasPersonalContext
        ? t("继续对话")
        : t("和我聊聊");

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
    (
      card: HeroCard,
      resource: DailySelectionResource | undefined,
      carouselPosition: number,
    ) => {
      if (!resource || !/^https:\/\//i.test(resource.url)) {
        showToast(t("这项每日精选还在准备中，请稍后再试"));
        return;
      }
      const position = card.rank || carouselPosition;
      // Open inside the original user-activation call stack. Awaiting analytics
      // first makes Safari/Chrome treat the new tab as an unsolicited popup.
      try {
        const opening =
          Platform.OS === "web"
            ? Linking.openURL(resource.url)
            : WebBrowser.openBrowserAsync(resource.url);
        void opening.catch(() => showToast(t("这个外部链接暂时不可用")));
      } catch {
        showToast(t("这个外部链接暂时不可用"));
        return;
      }
      void api
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
      void api
        .trackRecommendationEvent({
          event: "external_resource_click",
          card_id: card.id,
          recommendation_id: card.recommendation_id || undefined,
          feed_request_id: heroFeedMeta.feedRequestId,
          resource_id: resource.id,
          resource_kind: resource.kind,
          locale: card.resource_summary?.preferred_locale,
          content_category: card.content_category,
          position,
        })
        .catch(() => {});
    },
    [heroFeedMeta.feedRequestId, showToast, t],
  );

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

          <HeroCarousel
            width={dailyCardWidth}
            cards={heroCards}
            feedState={
              heroFeedRefreshing || heroPublicationState === "preparing"
                ? "refreshing"
                : heroFeedState
            }
            onCardPress={openHeroCard}
            onCardVisible={trackHeroImpression}
            visibilityScope={heroFeedMeta.feedRequestId || heroFeedMeta.generatedAt}
            initialContentCategory={heroFeedMeta.initialContentCategory}
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
