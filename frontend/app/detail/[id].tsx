import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import {
  api,
  type RecommendationEventInput,
  type RecommendationEventName,
  type RecommendationFeedbackReason,
} from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

const USE_NATIVE_DRIVER = Platform.OS !== "web";
const DETAIL_FRAME_WIDTH = 402;
const RESOURCE_LOCALE_LABELS: Record<string, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
};

const FEEDBACK_REASONS: {
  value: RecommendationFeedbackReason;
  label: string;
}[] = [
  { value: "topic_mismatch", label: "主题不对" },
  { value: "already_seen", label: "已经看过" },
  { value: "repetitive", label: "内容重复" },
  { value: "wrong_language", label: "中文或语言不好" },
  { value: "source_not_useful", label: "来源不适合" },
  { value: "not_now", label: "现在不需要" },
];

const TAG_BG: Record<string, string> = {
  tip: "#EEF6F1",
  news: "#FFF1EE",
  product: "#FEF9E7",
};
const TAG_FG: Record<string, string> = {
  tip: "#2F7A4B",
  news: colors.onBrandTertiary,
  product: "#8A6D1B",
};

type LearningResource = {
  id: string;
  kind: "article" | "video";
  title: string;
  publisher: string;
  language?: string;
  spoken_language?: "mandarin" | "english" | "not_applicable";
  spoken_language_evidence?: string;
  spoken_language_evidence_url?: string;
  locales?: string[];
  description?: string;
  source_tier?: "authority" | "curated";
  content_category?: "authority" | "featured" | "case";
  selection_basis?:
    | "official"
    | "expert_reviewed"
    | "audience_popular"
    | "expert_and_audience"
    | "lived_experience";
  trust_note?: string;
  recognition?: string;
  selection_reason?: string;
  audience_note?: string;
  url: string;
};

type ResourceSourceTier = NonNullable<LearningResource["source_tier"]>;
type ResourceContentCategory = NonNullable<LearningResource["content_category"]>;
type ResourceRefreshState = "idle" | "loading" | "exhausted";

const CONTENT_CATEGORY_META: Record<ResourceContentCategory, {
  eyebrow: string;
  title: string;
  description: string;
}> = {
  authority: {
    eyebrow: "事实与安全底线",
    title: "权威来源",
    description: "政府、大学、医院、医学组织与专业期刊发布的文章和视频。",
  },
  featured: {
    eyebrow: "专家与读者精选",
    title: "精选内容",
    description: "专业可信、讲解清楚，并适合家庭直接使用的文章和视频。",
  },
  case: {
    eyebrow: "真实经验与实践参考",
    title: "真实案例",
    description: "用具体家庭情境说明问题、过程和可借鉴做法的文章和视频。",
  },
};

function resourceSourceTier(resource: LearningResource): ResourceSourceTier {
  return resource.source_tier === "authority" ? "authority" : "curated";
}

function resourceContentCategory(resource: LearningResource): ResourceContentCategory {
  if (
    resource.content_category === "authority" ||
    resource.content_category === "featured" ||
    resource.content_category === "case"
  ) {
    return resource.content_category;
  }
  return resourceSourceTier(resource) === "curated" ? "featured" : "authority";
}

function resourceCategoryLabel(resource: LearningResource): string {
  const category = resourceContentCategory(resource);
  if (category === "featured") return "精选内容";
  if (category === "case") return "真实案例";
  return "权威来源";
}

function resourceKindLabel(resource: LearningResource): string {
  return resource.kind === "video" ? "视频" : "文章";
}

function resourceBadgeLabel(resource: LearningResource): string {
  const category = resourceContentCategory(resource);
  if (category === "case") return "真实案例";
  if (category === "featured") return "专业 / 口碑精选";
  return "权威发布";
}

function isReadyDetail(
  detail: any,
  requestedCategory?: ResourceContentCategory,
): boolean {
  const category: ResourceContentCategory | undefined =
    detail?.content_category === "authority" ||
    detail?.content_category === "featured" ||
    detail?.content_category === "case"
      ? detail.content_category
      : requestedCategory;
  const resources: LearningResource[] = Array.isArray(detail?.resources)
    ? detail.resources
    : [];
  if (
    !category ||
    detail?.resource_readiness !== "ready" ||
    detail?.resource_pair_complete !== true ||
    resources.length !== 2
  ) {
    return false;
  }
  return (
    resources.some(
      (resource) =>
        resource.kind === "article" &&
        resourceContentCategory(resource) === category,
    ) &&
    resources.some(
      (resource) =>
        resource.kind === "video" &&
        resourceContentCategory(resource) === category,
    )
  );
}

export default function Detail() {
  const router = useRouter();
  const { width: viewportWidth } = useWindowDimensions();
  const {
    id,
    session_id: sessionId,
    context_created_at: contextCreatedAt,
    recommendation_id: recommendationId,
    prepared_content_set_id: preparedContentSetId,
    feed_request_id: feedRequestId,
    content_category: contentCategory,
    rank: recommendationRank,
  } = useLocalSearchParams<{
    id: string;
    session_id?: string;
    context_created_at?: string;
    recommendation_id?: string;
    prepared_content_set_id?: string;
    feed_request_id?: string;
    content_category?: ResourceContentCategory;
    rank?: string;
  }>();
  const [card, setCard] = useState<any>(null);
  const [loadError, setLoadError] =
    useState<"expired" | "preparing" | "generic" | null>(null);
  const [reloadSequence, setReloadSequence] = useState(0);
  const [favorited, setFavorited] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [askBarHeight, setAskBarHeight] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [contentFeedback, setContentFeedback] = useState<"helpful" | "not_relevant" | null>(null);
  const [feedbackReasonOpen, setFeedbackReasonOpen] = useState(false);
  const [feedbackReason, setFeedbackReason] = useState<RecommendationFeedbackReason | null>(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [resourceRefreshState, setResourceRefreshState] =
    useState<ResourceRefreshState>("idle");
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const dwellStartedAt = useRef<number | null>(null);
  const dwellSent = useRef(false);
  const contentRequestId = useRef(0);
  const dwellContext = useRef<Omit<RecommendationEventInput, "event" | "duration_ms">>({});
  const frameWidth = Math.min(viewportWidth, DETAIL_FRAME_WIDTH);
  const parsedRecommendationRank = Number.parseInt(recommendationRank || "", 10);
  const recommendationPosition =
    Number.isFinite(parsedRecommendationRank) && parsedRecommendationRank > 0
      ? parsedRecommendationRank
      : undefined;

  const trackRecommendation = useCallback(
    (
      event: RecommendationEventName,
      payload: Omit<RecommendationEventInput, "event" | "card_id"> = {},
    ) =>
      api.trackRecommendationEvent({
        event,
        card_id: typeof id === "string" ? id : undefined,
        recommendation_id: recommendationId || undefined,
        feed_request_id: feedRequestId || undefined,
        position: recommendationPosition,
        content_category: contentCategory || undefined,
        ...payload,
      }),
    [contentCategory, feedRequestId, id, recommendationId, recommendationPosition],
  );

  const flushDwell = useCallback(() => {
    if (dwellSent.current || dwellStartedAt.current === null) return;
    const durationMs = Math.min(30 * 60 * 1000, Math.max(0, Date.now() - dwellStartedAt.current));
    dwellSent.current = true;
    if (durationMs === 0) return;
    api
      .trackRecommendationEvent({
        event: "detail_dwell",
        ...dwellContext.current,
        duration_ms: durationMs,
      })
      .catch(() => {});
  }, []);

  const showToast = useCallback(
    (msg: string) => {
      setToast(msg);
      Animated.sequence([
        Animated.timing(toastOpacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
        Animated.delay(1600),
        Animated.timing(toastOpacity, {
          toValue: 0,
          duration: 250,
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
      ]).start(() => setToast(null));
    },
    [toastOpacity]
  );

  useFocusEffect(
    useCallback(() => {
      return () => flushDwell();
    }, [flushDwell]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") flushDwell();
    });
    return () => subscription.remove();
  }, [flushDwell]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    const requestId = ++contentRequestId.current;
    setCard(null);
    setLoadError(null);
    setContentFeedback(null);
    setFeedbackReasonOpen(false);
    setFeedbackReason(null);
    setFeedbackSubmitting(false);
    setResourceRefreshState("idle");
    dwellStartedAt.current = null;
    dwellSent.current = false;

    api
      .getCardDetail(
        id as string,
        sessionId,
        contextCreatedAt,
        recommendationId,
        contentCategory,
        preparedContentSetId,
      )
      .then((detail: any) => {
        if (!active || contentRequestId.current !== requestId) return;
        if (!isReadyDetail(detail, contentCategory)) {
          setLoadError("preparing");
          return;
        }
        setCard(detail);
        dwellContext.current = {
          card_id: id as string,
          recommendation_id: recommendationId || undefined,
          feed_request_id: feedRequestId || undefined,
          position: recommendationPosition,
          content_category: detail.content_category || contentCategory || undefined,
          locale: detail.preferred_locale || undefined,
        };
        dwellStartedAt.current = Date.now();
        trackRecommendation("detail_view").catch(() => {});
      })
      .catch((error: unknown) => {
        if (!active || contentRequestId.current !== requestId) return;
        const status =
          error && typeof error === "object" ? (error as any).status : null;
        setLoadError(
          status === 409
            ? "preparing"
            : status === 404 && recommendationId
              ? "expired"
              : "generic",
        );
      });

    // A favorites outage must not prevent the article itself from rendering.
    api
      .listFavorites()
      .then((favorites: any[]) => {
        if (active) setFavorited(favorites.some((item: any) => item.id === id));
      })
      .catch(() => {});

    return () => {
      active = false;
      // Invalidate whichever detail or explicit-refresh request is current.
      contentRequestId.current += 1;
      flushDwell();
    };
  }, [
    contextCreatedAt,
    contentCategory,
    feedRequestId,
    flushDwell,
    id,
    preparedContentSetId,
    recommendationId,
    recommendationPosition,
    reloadSequence,
    sessionId,
    trackRecommendation,
  ]);

  const toggleFavorite = async () => {
    if (!id) return;
    try {
      const result = await api.toggleFavorite(id as string);
      setFavorited(result.favorited);
      showToast(result.favorited ? "已收藏" : "已取消收藏");
      trackRecommendation("favorite", { value: result.favorited ? 1 : 0 }).catch(() => {});
    } catch {
      showToast("收藏暂时没有保存，请稍后再试");
    }
  };

  const askAI = async () => {
    if (!card) return;
    trackRecommendation("continue_chat").catch(() => {});
    try {
      if (card.related_session_id) {
        router.push(`/chat/${card.related_session_id}`);
        return;
      }
      const session = await api.startSession({ card_id: card.id, title: card.title });
      router.push(`/chat/${session.id}`);
    } catch {
      showToast("对话暂时无法打开，请稍后再试");
    }
  };

  const openResource = async (resource: LearningResource, position: number) => {
    if (!/^https:\/\//i.test(resource.url || "")) {
      showToast("这个外部链接暂时不可用");
      return;
    }
    flushDwell();
    trackRecommendation("external_resource_click", {
        resource_id: resource.id,
        resource_kind: resource.kind,
        locale: card?.preferred_locale || resource.locales?.[0],
        content_category:
          card?.content_category || contentCategory || resourceContentCategory(resource),
        position,
      })
      .catch(() => {});
    try {
      if (Platform.OS === "web") {
        await Linking.openURL(resource.url);
      } else {
        await WebBrowser.openBrowserAsync(resource.url);
      }
    } catch {
      showToast("外部内容暂时无法打开，请稍后再试");
    }
  };

  const submitContentFeedback = async (
    value: "helpful" | "not_relevant",
    reason?: RecommendationFeedbackReason,
  ) => {
    if (contentFeedback || feedbackSubmitting) return;
    if (value === "not_relevant" && !reason) {
      setFeedbackReasonOpen(true);
      return;
    }
    setFeedbackSubmitting(true);
    try {
      const result = await trackRecommendation(value, {
        value: value === "helpful" ? 1 : 0,
        reason,
        locale: card?.preferred_locale || undefined,
        content_category: card?.content_category || contentCategory,
      });
      if (result?.accepted === false) {
        setFeedbackReasonOpen(false);
        showToast("个性化已关闭，这次选择不会保存");
        return;
      }
      setContentFeedback(value);
      setFeedbackReason(reason || null);
      setFeedbackReasonOpen(false);
    } catch {
      showToast("反馈暂时没有保存，请再试一次");
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  const refreshResourcePair = async () => {
    if (
      !card ||
      !id ||
      resourceRefreshState !== "idle" ||
      !card.refresh_available
    ) {
      return;
    }
    const activeCategory: ResourceContentCategory =
      card.content_category === "featured" ||
      card.content_category === "case" ||
      card.content_category === "authority"
        ? card.content_category
        : contentCategory || "authority";
    const currentResources: LearningResource[] = Array.isArray(card.resources)
      ? card.resources.filter(
          (resource: LearningResource) =>
            resourceContentCategory(resource) === activeCategory,
        )
      : [];
    if (currentResources.length < 2) return;

    // Invalidates an older explicit refresh so it can never overwrite the
    // user's latest requested resource pair.
    const requestId = ++contentRequestId.current;
    setResourceRefreshState("loading");
    try {
      const result: any = await api.getNextResourcePair(
        id as string,
        sessionId,
        contextCreatedAt,
        recommendationId,
        activeCategory,
        currentResources.map((resource) => resource.id),
      );
      if (contentRequestId.current !== requestId) return;
      const nextResources: LearningResource[] = Array.isArray(result?.resources)
        ? result.resources
        : [];
      const nextArticle = nextResources.find(
        (resource) =>
          resource.kind === "article" &&
          resourceContentCategory(resource) === activeCategory,
      );
      const nextVideo = nextResources.find(
        (resource) =>
          resource.kind === "video" &&
          resourceContentCategory(resource) === activeCategory,
      );
      if (
        result?.refresh_status === "refreshed" &&
        nextArticle &&
        nextVideo
      ) {
        setCard((current: any) =>
          current
            ? {
                ...current,
                ...result,
                resources: [nextArticle, nextVideo],
                refresh_available: result.has_more !== false,
              }
            : current,
        );
        setContentFeedback(null);
        setFeedbackReason(null);
        setFeedbackReasonOpen(false);
        setResourceRefreshState("idle");
        showToast("已为你换了一组");
        return;
      }
      if (result?.refresh_status === "no_alternative") {
        setResourceRefreshState("exhausted");
        return;
      }
      // A timeout, provider outage, incomplete response, or any other
      // retryable status must leave the currently reviewed pair untouched.
      setResourceRefreshState("idle");
      showToast("暂时没能换新内容，请稍后再试");
    } catch {
      if (contentRequestId.current !== requestId) return;
      setResourceRefreshState("idle");
      showToast("暂时没能换新内容，请稍后再试");
    }
  };

  const renderBody = () => {
    if (loadError) {
      const recommendationExpired = loadError === "expired";
      const recommendationPreparing = loadError === "preparing";
      return (
        <View style={styles.stateBox} testID="detail-error-state">
          <Ionicons
            name={
              recommendationPreparing
                ? "hourglass-outline"
                : recommendationExpired
                  ? "time-outline"
                  : "cloud-offline-outline"
            }
            size={28}
            color={colors.muted}
          />
          <Text style={styles.stateTitle}>
            {recommendationPreparing
              ? "内容仍在准备"
              : recommendationExpired
                ? "这条个性化推荐已更新"
                : "内容暂时没有加载出来"}
          </Text>
          <Text style={styles.stateText}>
            {recommendationPreparing
              ? "请返回首页稍后再试。NURI 会在文章和视频都准备好后再开放这张卡片。"
              : recommendationExpired
                ? "可以根据你现在的对话，重新查看这个学习主题。"
                : "可以返回首页，或在网络恢复后重试。"}
          </Text>
          <Pressable
            onPress={() => {
              if (recommendationPreparing) {
                router.replace("/(tabs)");
                return;
              }
              if (recommendationExpired) {
                router.replace({
                  pathname: "/detail/[id]",
                  params: {
                    id: id as string,
                    ...(contentCategory ? { content_category: contentCategory } : {}),
                  },
                });
                return;
              }
              setReloadSequence((value) => value + 1);
            }}
            style={styles.retryBtn}
            testID="detail-retry-btn"
          >
            <Text style={styles.retryBtnText}>
              {recommendationPreparing
                ? "返回首页"
                : recommendationExpired
                  ? "查看当前主题"
                  : "重新加载"}
            </Text>
          </Pressable>
        </View>
      );
    }
    if (!card) {
      return (
        <View style={styles.stateBox}>
          <ActivityIndicator color={colors.brand} />
          <Text style={styles.stateText}>正在打开已准备好的内容…</Text>
        </View>
      );
    }

    const resources: LearningResource[] = Array.isArray(card.resources) ? card.resources : [];
    const activeCategory: ResourceContentCategory =
      card.content_category === "featured" ||
      card.content_category === "case" ||
      card.content_category === "authority"
        ? card.content_category
        : contentCategory || "authority";
    const categoryMeta = CONTENT_CATEGORY_META[activeCategory];
    const categoryResources = resources.filter(
      (resource) => resourceContentCategory(resource) === activeCategory,
    );
    const visibleResources = (["article", "video"] as const)
      .map((kind) => categoryResources.find((resource) => resource.kind === kind))
      .filter((resource): resource is LearningResource => Boolean(resource));
    const resourcePairComplete = visibleResources.length === 2;
    const activeResourceLocaleLabel =
      RESOURCE_LOCALE_LABELS[card.preferred_locale] || "你的偏好语言";
    return (
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        testID="content-detail-scroll"
      >
        <View
          style={[
            styles.typeChip,
            { backgroundColor: TAG_BG[card.type] || TAG_BG.tip },
          ]}
        >
          <Text
            style={[
              styles.typeChipText,
              { color: TAG_FG[card.type] || TAG_FG.tip },
            ]}
          >
            {card.type_label || "育儿精选"}
          </Text>
        </View>
        <Text style={styles.title}>{card.title}</Text>
        {card.publisher ? (
          <Text style={styles.publisher}>内容导读：{card.publisher}</Text>
        ) : null}

        {card.personalization_reason ? (
          <View style={styles.reasonCard} testID="detail-personalization-reason">
            <View style={styles.reasonIcon}>
              <Ionicons name="sparkles" size={17} color="#4F4B9C" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.reasonLabel}>为什么推荐给你</Text>
              <Text style={styles.reasonText}>{card.personalization_reason}</Text>
            </View>
          </View>
        ) : null}

        {card.image_url ? (
          <Image
            source={{ uri: card.image_url }}
            style={styles.hero}
            contentFit="cover"
            transition={200}
          />
        ) : null}

        {card.summary ? <Text style={styles.lead}>{card.summary}</Text> : null}
        <Text style={styles.sectionTitle}>NURI 内容导读</Text>
        <Text style={styles.body}>{card.body}</Text>

        {resources.length || card.research_status ? (
          <View style={styles.resourcesSection} testID="detail-learning-resources">
            <View style={styles.resourcesTitleRow}>
              <Text style={[styles.sectionTitle, styles.resourcesTitle]}>
                推荐给你的文章与视频
              </Text>
              {(card.refresh_available || resourceRefreshState === "exhausted") &&
              resourcePairComplete ? (
                <Pressable
                  onPress={refreshResourcePair}
                  disabled={resourceRefreshState !== "idle"}
                  style={({ pressed }) => [
                    styles.refreshResourcesButton,
                    resourceRefreshState !== "idle" &&
                      styles.refreshResourcesButtonDisabled,
                    pressed &&
                      resourceRefreshState === "idle" &&
                      styles.refreshResourcesButtonPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="更换下面的一篇文章和一个视频"
                  accessibilityState={{
                    disabled: resourceRefreshState !== "idle",
                    busy: resourceRefreshState === "loading",
                  }}
                  testID="detail-refresh-resources"
                >
                  {resourceRefreshState === "loading" ? (
                    <ActivityIndicator size="small" color="#4F4B9C" />
                  ) : (
                    <Ionicons
                      name="refresh-outline"
                      size={16}
                      color={
                        resourceRefreshState === "exhausted"
                          ? colors.muted
                          : "#4F4B9C"
                      }
                    />
                  )}
                  <Text
                    style={[
                      styles.refreshResourcesButtonText,
                      resourceRefreshState === "exhausted" &&
                        styles.refreshResourcesButtonTextDisabled,
                    ]}
                  >
                    {resourceRefreshState === "loading"
                      ? "正在换一组…"
                      : resourceRefreshState === "exhausted"
                        ? "暂无更多"
                        : "换一组内容"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {resourceRefreshState === "exhausted" ? (
              <Text
                style={styles.refreshExhaustedText}
                accessibilityLiveRegion="polite"
                testID="detail-refresh-exhausted"
              >
                目前没有更多同时符合孩子阶段、当前话题、类别和语言的组合。
              </Text>
            ) : null}
            <View
              style={styles.resourceGroup}
              testID={`detail-resource-category-${activeCategory}`}
            >
              <View style={styles.resourceGroupHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.resourceGroupEyebrow}>{categoryMeta.eyebrow}</Text>
                  <Text style={styles.resourceGroupTitle}>{categoryMeta.title}</Text>
                  <Text style={styles.resourceGroupDescription}>{categoryMeta.description}</Text>
                </View>
                <View style={styles.preferenceBadge}>
                  <Ionicons name="sparkles-outline" size={14} color="#4F4B9C" />
                  <Text style={styles.preferenceBadgeText}>{activeResourceLocaleLabel}</Text>
                </View>
              </View>
            {card.research_status === "fresh" || card.research_status === "hybrid" ? (
              <View style={styles.researchStatusCard} testID="detail-research-status">
                <Ionicons name="search" size={16} color="#4F4B9C" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.researchStatusLabel}>
                    已按你的语言偏好选好文章和视频
                  </Text>
                  <Text style={styles.researchStatusText}>
                    {card.research_status === "hybrid"
                      ? "实时检索与人工审核资料共同组成这次推荐；不合格链接没有展示。"
                      : card.research_editor_note ||
                        "NURI 已结合你们刚聊到的情境，从公开网络中核验这一篇文章和一个视频。"}
                  </Text>
                </View>
              </View>
            ) : card.research_status === "reviewed_fallback" ||
              card.research_status === "unavailable" ? (
              <View style={styles.researchStatusCard} testID="detail-research-status">
                <Ionicons name="shield-checkmark-outline" size={17} color="#4F4B9C" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.researchStatusLabel}>
                    {resourcePairComplete ? "当前使用人工审核资料" : "暂未找到完整且可核验的组合"}
                  </Text>
                  <Text style={styles.researchStatusText}>
                    {resourcePairComplete
                      ? "这一篇文章和一个视频均来自审核资料库，并与当前卡片类别和语言一致。"
                      : "NURI 不会用错误类别或错误语言补位；稍后重新打开即可再试。"}
                  </Text>
                </View>
              </View>
            ) : card.research_status === "consent_required" ? (
              <View style={styles.researchStatusCard} testID="detail-research-status">
                <Ionicons name="lock-closed-outline" size={17} color="#4F4B9C" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.researchStatusLabel}>外部个性化检索尚未开启</Text>
                  <Text style={styles.researchStatusText}>
                    {resourcePairComplete
                      ? "当前文章和视频均来自人工审核资料库，并已使用你的账户语言偏好。"
                      : "这个新话题尚未对外检索。只有你在“我的”隐私设置中明确开启后，NURI 才会使用结构化、脱敏后的主题信息检索公开网页。"}
                  </Text>
                </View>
              </View>
            ) : card.research_status === "urgent_suppressed" ? (
              <View style={styles.researchStatusCard} testID="detail-research-status">
                <Ionicons name="alert-circle-outline" size={17} color={colors.error} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.researchStatusLabel}>紧急情境不会启动内容检索</Text>
                  <Text style={styles.researchStatusText}>
                    {resources.length
                      ? "请优先联系当地急救、医疗或紧急支持服务；这里仅保留审核资料，不用文章或案例延误求助。"
                      : "请优先联系当地急救、医疗或紧急支持服务；NURI 不会在此显示文章或案例，以免延误求助。"}
                  </Text>
                </View>
              </View>
            ) : null}
            {resourcePairComplete ? (
              <Text style={styles.resourcesIntro}>
                已自动使用最适合你的{activeResourceLocaleLabel}资源：1 篇文章和 1 个视频。点击具体条目后才会打开外部内容。
              </Text>
            ) : null}
                {resourcePairComplete ? visibleResources.map((resource, resourceIndex) => (
                  <Pressable
                    key={resource.id}
                    onPress={() => openResource(resource, resourceIndex + 1)}
                    style={({ pressed }) => [
                      styles.resourceCard,
                      pressed && styles.resourceCardPressed,
                    ]}
                    accessibilityRole="link"
                    accessibilityLabel={`${resourceCategoryLabel(resource)}，${resource.language ? `${resource.language}，` : ""}${resourceKindLabel(resource)}：${resource.title}，来源：${resource.publisher}`}
                    accessibilityHint={`将在新标签页打开外部${resourceKindLabel(resource)}`}
                    testID={`detail-resource-${resource.id}`}
                  >
                    <View
                      style={[
                        styles.resourceIcon,
                        resource.kind === "video" && styles.videoResourceIcon,
                      ]}
                    >
                      <Ionicons
                        name={resource.kind === "video" ? "play" : "document-text-outline"}
                        size={18}
                        color={resource.kind === "video" ? "#A34D63" : "#4F4B9C"}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.resourceMetaRow}>
                        <View
                          style={[
                            styles.resourceKindBadge,
                            resource.kind === "video" && styles.videoResourceKindBadge,
                          ]}
                        >
                          <Text
                            style={[
                              styles.resourceKindBadgeText,
                              resource.kind === "video" && styles.videoResourceKindBadgeText,
                            ]}
                          >
                            {resourceKindLabel(resource)}
                          </Text>
                        </View>
                        <View
                          style={[
                            styles.resourceTierBadge,
                            resourceSourceTier(resource) === "curated" &&
                              styles.curatedResourceTierBadge,
                          ]}
                        >
                          <Text
                            style={[
                              styles.resourceTierBadgeText,
                              resourceSourceTier(resource) === "curated" &&
                                styles.curatedResourceTierBadgeText,
                            ]}
                          >
                            {resourceBadgeLabel(resource)}
                          </Text>
                        </View>
                        {resource.language ? (
                          <Text style={styles.resourceLanguage}>{resource.language}</Text>
                        ) : null}
                      </View>
                      <Text style={styles.resourceTitle}>{resource.title}</Text>
                      <Text style={styles.resourcePublisher}>{resource.publisher}</Text>
                      {resource.description ? (
                        <Text style={styles.resourceDescription}>{resource.description}</Text>
                      ) : null}
                      {resource.kind === "video" && resource.spoken_language_evidence ? (
                        <Text style={styles.resourceLanguageEvidence}>
                          <Text style={styles.resourceTrustNoteLabel}>口语核验：</Text>
                          {resource.spoken_language_evidence}
                        </Text>
                      ) : null}
                      {resource.recognition ? (
                        <View style={styles.resourceEvidenceRow}>
                          <Ionicons
                            name={
                              resourceSourceTier(resource) === "authority"
                                ? "shield-checkmark-outline"
                                : "people-outline"
                            }
                            size={15}
                            color={
                              resourceSourceTier(resource) === "authority" ? "#4F4B9C" : "#9A4D63"
                            }
                          />
                          <Text style={styles.resourceEvidenceText}>
                            {[resource.recognition, resource.audience_note]
                              .filter(Boolean)
                              .join(" · ")}
                          </Text>
                        </View>
                      ) : null}
                      {resource.trust_note ? (
                        <Text style={styles.resourceTrustNote}>
                          <Text style={styles.resourceTrustNoteLabel}>可信依据：</Text>
                          {resource.trust_note}
                        </Text>
                      ) : null}
                      {resource.selection_reason ? (
                        <Text style={styles.resourceSelectionReason}>
                          <Text style={styles.resourceSelectionReasonLabel}>入选理由：</Text>
                          {resource.selection_reason}
                        </Text>
                      ) : null}
                      <View style={styles.resourceOpenRow}>
                        <Text style={styles.resourceOpenText}>
                          {resource.kind === "video" ? "打开外部视频" : "打开外部文章"}
                        </Text>
                        <Ionicons name="open-outline" size={16} color={colors.brand} />
                      </View>
                    </View>
                  </Pressable>
                )) : (
                <View style={styles.emptyResourceGroup}>
                  <Text style={styles.emptyResourceGroupText}>
                    暂时没有找到同时通过类别、语言与可信度核验的一篇文章和一个视频。
                  </Text>
                </View>
              )}
            </View>
          </View>
        ) : null}

        {resourcePairComplete ? (
          <View style={styles.feedbackCard} testID="detail-content-feedback">
            <Text style={styles.feedbackTitle}>这次推荐贴合吗？</Text>
            <Text style={styles.feedbackSubtitle}>你的选择只会帮助 NURI 调整后续推荐。</Text>
            <View style={styles.feedbackActions}>
              <Pressable
                onPress={() => submitContentFeedback("helpful")}
                disabled={contentFeedback !== null || feedbackSubmitting}
                style={[
                  styles.feedbackButton,
                  contentFeedback === "helpful" && styles.feedbackButtonSelected,
                  contentFeedback === "not_relevant" && styles.feedbackButtonMuted,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: contentFeedback === "helpful" }}
                testID="detail-feedback-helpful"
              >
                <Ionicons
                  name={contentFeedback === "helpful" ? "thumbs-up" : "thumbs-up-outline"}
                  size={16}
                  color={contentFeedback === "helpful" ? colors.brand : colors.onSurfaceSecondary}
                />
                <Text
                  style={[
                    styles.feedbackButtonText,
                    contentFeedback === "helpful" && styles.feedbackButtonTextSelected,
                  ]}
                >
                  有帮助
                </Text>
              </Pressable>
              <Pressable
                onPress={() => submitContentFeedback("not_relevant")}
                disabled={contentFeedback !== null || feedbackSubmitting}
                style={[
                  styles.feedbackButton,
                  (feedbackReasonOpen || contentFeedback === "not_relevant") &&
                    styles.feedbackButtonSelected,
                  contentFeedback === "helpful" && styles.feedbackButtonMuted,
                ]}
                accessibilityRole="button"
                accessibilityState={{
                  expanded: feedbackReasonOpen,
                  selected: contentFeedback === "not_relevant",
                }}
                testID="detail-feedback-not-relevant"
              >
                <Ionicons
                  name={
                    feedbackReasonOpen || contentFeedback === "not_relevant"
                      ? "thumbs-down"
                      : "thumbs-down-outline"
                  }
                  size={16}
                  color={
                    feedbackReasonOpen || contentFeedback === "not_relevant"
                      ? colors.brand
                      : colors.onSurfaceSecondary
                  }
                />
                <Text
                  style={[
                    styles.feedbackButtonText,
                    (feedbackReasonOpen || contentFeedback === "not_relevant") &&
                      styles.feedbackButtonTextSelected,
                  ]}
                >
                  需要调整
                </Text>
              </Pressable>
            </View>
            {feedbackReasonOpen && !contentFeedback ? (
              <View style={styles.feedbackReasons} testID="detail-feedback-reasons">
                <Text style={styles.feedbackReasonPrompt}>是哪一方面？</Text>
                <View style={styles.feedbackReasonOptions}>
                  {FEEDBACK_REASONS.map((option) => (
                    <Pressable
                      key={option.value}
                      onPress={() => submitContentFeedback("not_relevant", option.value)}
                      disabled={feedbackSubmitting}
                      style={styles.feedbackReasonButton}
                      accessibilityRole="button"
                      testID={`detail-feedback-reason-${option.value}`}
                    >
                      <Text style={styles.feedbackReasonButtonText}>{option.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            {contentFeedback ? (
              <Text style={styles.feedbackThanks} accessibilityLiveRegion="polite">
                {contentFeedback === "helpful"
                  ? "收到了，之后会多推荐这类内容。"
                  : `已记录“${
                      FEEDBACK_REASONS.find((option) => option.value === feedbackReason)?.label ||
                      "需要调整"
                    }”，之后会按这个原因调整推荐。`}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.tags}>
          {(card.tags || []).map((tag: string) => (
            <View key={tag} style={styles.tagChip}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
        {card.hook_line ? (
          <Text style={styles.hook} testID="detail-hook-line">
            {card.hook_line}
          </Text>
        ) : null}
        <View style={{ height: Math.max(104, askBarHeight + spacing.xl * 2) }} />
      </ScrollView>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={[styles.phoneCanvas, { width: frameWidth }]}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={styles.iconBtn}
            accessibilityLabel="返回"
            testID="detail-back-btn"
          >
            <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.headerTitle}>NURI 学习内容</Text>
          <View style={{ flex: 1 }} />
          {card ? (
            <>
              <Pressable
                onPress={toggleFavorite}
                style={styles.iconBtn}
                accessibilityLabel={favorited ? "取消收藏" : "收藏"}
                testID="detail-fav-btn"
              >
                <Ionicons
                  name={favorited ? "star" : "star-outline"}
                  size={21}
                  color={favorited ? colors.brand : colors.onSurface}
                />
              </Pressable>
              <Pressable
                onPress={() => setShareOpen(true)}
                style={styles.iconBtn}
                accessibilityLabel="分享"
                testID="detail-share-btn"
              >
                <Ionicons name="share-outline" size={21} color={colors.onSurface} />
              </Pressable>
            </>
          ) : null}
        </View>

        {renderBody()}

        {card ? (
          <View
            style={styles.askBar}
            onLayout={(event) => setAskBarHeight(event.nativeEvent.layout.height)}
          >
            <Pressable onPress={askAI} style={styles.askBtn} testID="detail-ask-ai-btn">
              <Ionicons name="sparkles" size={16} color="#fff" />
              <Text style={styles.askBtnText}>和 NURI 继续聊这个话题</Text>
            </Pressable>
          </View>
        ) : null}

        {toast ? (
          <Animated.View style={[styles.toast, { opacity: toastOpacity, pointerEvents: "none" }]}>
            <Text style={styles.toastText}>{toast}</Text>
          </Animated.View>
        ) : null}
      </View>

      <Modal
        visible={shareOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setShareOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setShareOpen(false)} />
        <View style={styles.shareSheet} testID="share-sheet">
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>分享到</Text>
          {[
            { label: "复制链接", icon: "link-outline" as const },
            { label: "微信", icon: "logo-wechat" as const },
            { label: "短信", icon: "chatbox-outline" as const },
            { label: "更多…", icon: "ellipsis-horizontal" as const },
          ].map((option) => (
            <Pressable
              key={option.label}
              onPress={() => {
                setShareOpen(false);
                showToast("分享功能即将完善");
                api
                  .trackEvent("share", { card_id: card?.id, card_type: card?.type })
                  .catch(() => {});
              }}
              style={styles.shareRow}
              testID={`share-${option.label}`}
            >
              <Ionicons name={option.icon} size={20} color={colors.onSurface} />
              <Text style={styles.shareLabel}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F6F4FA" },
  phoneCanvas: {
    flex: 1,
    alignSelf: "center",
    position: "relative",
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: "#fff",
    borderBottomColor: colors.divider,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: type.base, fontWeight: "700", color: colors.onSurface },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  stateBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.sm,
  },
  stateTitle: { fontSize: type.lg, fontWeight: "700", color: colors.onSurface },
  stateText: { fontSize: type.base, color: colors.muted, textAlign: "center" },
  retryBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.brand,
  },
  retryBtnText: { color: "#fff", fontWeight: "700" },
  scroll: { padding: spacing.lg },
  typeChip: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: radius.pill,
    marginBottom: spacing.md,
  },
  typeChipText: { fontSize: type.sm, fontWeight: "700" },
  title: {
    fontSize: type.xxl,
    fontWeight: "700",
    color: colors.onSurface,
    lineHeight: 32,
  },
  publisher: {
    fontSize: type.sm,
    color: colors.muted,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  reasonCard: {
    flexDirection: "row",
    gap: spacing.sm,
    backgroundColor: "#F0EEFC",
    borderColor: "#D8D2F2",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  reasonIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  reasonLabel: { fontSize: type.sm, color: "#4F4B9C", fontWeight: "700" },
  reasonText: { fontSize: type.base, lineHeight: 20, color: colors.onSurface, marginTop: 2 },
  hero: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    marginBottom: spacing.lg,
    backgroundColor: colors.surfaceTertiary,
  },
  lead: {
    fontSize: type.lg,
    lineHeight: 25,
    color: colors.onSurface,
    fontWeight: "600",
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: type.lg,
    fontWeight: "700",
    color: colors.onSurface,
    marginBottom: spacing.sm,
  },
  body: { fontSize: type.lg, color: colors.onSurfaceSecondary, lineHeight: 27 },
  resourcesSection: { marginTop: spacing.xl },
  resourcesTitleRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  resourcesTitle: { flex: 1, marginBottom: 0 },
  refreshResourcesButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    flexShrink: 0,
    paddingHorizontal: spacing.sm + 2,
    borderWidth: 1,
    borderColor: "#D8D2F2",
    borderRadius: radius.pill,
    backgroundColor: "#F7F5FF",
  },
  refreshResourcesButtonPressed: { opacity: 0.72 },
  refreshResourcesButtonDisabled: {
    borderColor: colors.border,
    backgroundColor: colors.surfaceTertiary,
  },
  refreshResourcesButtonText: {
    fontSize: type.sm,
    lineHeight: 18,
    color: "#4F4B9C",
    fontWeight: "700",
  },
  refreshResourcesButtonTextDisabled: { color: colors.muted },
  refreshExhaustedText: {
    marginTop: -spacing.xs,
    marginBottom: spacing.md,
    fontSize: type.sm,
    lineHeight: 19,
    color: colors.muted,
  },
  resourceLocaleBlock: {
    borderWidth: 1,
    borderColor: "#D8D2F2",
    borderRadius: radius.md,
    backgroundColor: "#F7F5FF",
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  resourceLocaleHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  resourceLocaleLabel: {
    fontSize: type.sm,
    color: "#4F4B9C",
    fontWeight: "700",
  },
  resourceLocaleLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  resourceLocaleLoadingText: {
    fontSize: 12,
    color: colors.muted,
  },
  researchStatusCard: {
    flexDirection: "row",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: "#D8D2F2",
    borderRadius: radius.md,
    backgroundColor: "#F7F5FF",
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  researchStatusLabel: {
    fontSize: type.sm,
    color: "#4F4B9C",
    fontWeight: "700",
  },
  researchStatusText: {
    fontSize: type.sm,
    lineHeight: 19,
    color: colors.onSurfaceSecondary,
    marginTop: 2,
  },
  resourcesIntro: {
    fontSize: type.sm,
    color: colors.muted,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  resourceLocaleTabs: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  resourceLocaleTab: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  resourceLocaleTabPressed: { opacity: 0.72 },
  resourceLocaleTabSelected: {
    borderColor: colors.brand,
    backgroundColor: colors.brandTertiary,
  },
  resourceLocaleTabText: {
    fontSize: type.sm,
    color: colors.onSurfaceSecondary,
    fontWeight: "600",
  },
  resourceLocaleTabTextSelected: { color: colors.onBrandTertiary, fontWeight: "700" },
  resourceGroup: { marginTop: spacing.lg },
  emptyResourceGroup: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  emptyResourceGroupText: {
    fontSize: type.sm,
    lineHeight: 19,
    color: colors.muted,
  },
  resourceGroupHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: 2,
  },
  resourceGroupEyebrow: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.brand,
    fontWeight: "700",
  },
  resourceGroupTitle: {
    fontSize: type.base,
    lineHeight: 21,
    color: colors.onSurface,
    fontWeight: "700",
    marginTop: 2,
  },
  resourceGroupDescription: {
    fontSize: type.sm,
    lineHeight: 18,
    color: colors.muted,
    marginTop: 2,
  },
  preferenceBadge: {
    maxWidth: 104,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
  },
  preferenceBadgeText: {
    flexShrink: 1,
    fontSize: 11,
    color: colors.onBrandTertiary,
    fontWeight: "700",
  },
  resourceGroupCount: {
    minWidth: 28,
    height: 28,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  resourceGroupCountText: {
    fontSize: type.sm,
    color: colors.onBrandTertiary,
    fontWeight: "700",
  },
  resourceCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    backgroundColor: "#FFFFFF",
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  resourceCardPressed: { opacity: 0.72 },
  resourceIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#EFEDFA",
    alignItems: "center",
    justifyContent: "center",
  },
  videoResourceIcon: { backgroundColor: "#FCECEF" },
  resourceMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  resourceKindBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: "#EFEDFA",
  },
  videoResourceKindBadge: { backgroundColor: "#FCECEF" },
  resourceKindBadgeText: { fontSize: 11, color: "#4F4B9C", fontWeight: "700" },
  videoResourceKindBadgeText: { color: "#9A4D63" },
  resourceTierBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: "#EFEDFA",
  },
  curatedResourceTierBadge: { backgroundColor: "#FCECEF" },
  resourceTierBadgeText: { fontSize: 11, color: "#4F4B9C", fontWeight: "700" },
  curatedResourceTierBadgeText: { color: "#9A4D63" },
  resourceLanguage: { fontSize: type.sm, color: colors.muted },
  resourceTitle: {
    fontSize: type.base,
    lineHeight: 20,
    fontWeight: "700",
    color: colors.onSurface,
    marginTop: 3,
  },
  resourcePublisher: { fontSize: type.sm, color: colors.muted, marginTop: 3 },
  resourceDescription: {
    fontSize: type.sm,
    lineHeight: 18,
    color: colors.onSurfaceSecondary,
    marginTop: spacing.sm,
  },
  resourceLanguageEvidence: {
    fontSize: type.sm,
    lineHeight: 18,
    color: "#4F4B9C",
    marginTop: spacing.sm,
  },
  resourceEvidenceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: spacing.sm,
  },
  resourceEvidenceText: {
    flex: 1,
    fontSize: type.sm,
    lineHeight: 17,
    color: colors.onSurfaceSecondary,
    fontWeight: "600",
  },
  resourceTrustNote: {
    fontSize: type.sm,
    lineHeight: 18,
    color: colors.muted,
    marginTop: spacing.sm,
  },
  resourceTrustNoteLabel: {
    color: colors.onSurfaceSecondary,
    fontWeight: "700",
  },
  resourceSelectionReason: {
    fontSize: type.sm,
    lineHeight: 18,
    color: colors.muted,
    marginTop: spacing.sm,
  },
  resourceSelectionReasonLabel: {
    color: colors.onSurfaceSecondary,
    fontWeight: "700",
  },
  resourceOpenRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
    marginTop: spacing.md,
  },
  resourceOpenText: { fontSize: type.sm, color: colors.brand, fontWeight: "700" },
  feedbackCard: {
    marginTop: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingTop: spacing.lg,
  },
  feedbackTitle: {
    fontSize: type.base,
    color: colors.onSurface,
    fontWeight: "700",
  },
  feedbackSubtitle: {
    marginTop: 3,
    fontSize: type.sm,
    lineHeight: 18,
    color: colors.muted,
  },
  feedbackActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  feedbackButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  feedbackButtonSelected: {
    borderColor: colors.brand,
    backgroundColor: colors.brandTertiary,
  },
  feedbackButtonMuted: { opacity: 0.48 },
  feedbackButtonText: {
    fontSize: type.sm,
    color: colors.onSurfaceSecondary,
    fontWeight: "600",
  },
  feedbackButtonTextSelected: { color: colors.onBrandTertiary, fontWeight: "700" },
  feedbackReasons: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceTertiary,
  },
  feedbackReasonPrompt: {
    fontSize: type.sm,
    color: colors.onSurfaceSecondary,
    fontWeight: "600",
  },
  feedbackReasonOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  feedbackReasonButton: {
    minHeight: 36,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  feedbackReasonButtonText: {
    fontSize: type.sm,
    color: colors.onSurfaceSecondary,
    fontWeight: "600",
  },
  feedbackThanks: {
    marginTop: spacing.sm,
    fontSize: type.sm,
    lineHeight: 18,
    color: colors.brand,
  },
  tags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  tagChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.pill,
  },
  tagText: { color: colors.onBrandTertiary, fontSize: type.sm, fontWeight: "600" },
  hook: {
    marginTop: spacing.xl,
    fontSize: type.base,
    color: colors.muted,
    fontStyle: "italic",
    textAlign: "center",
  },
  askBar: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.md,
  },
  askBtn: {
    flexDirection: "row",
    backgroundColor: colors.brand,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    shadowColor: "#21145F",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 4,
  },
  askBtnText: { color: "#fff", fontWeight: "700", fontSize: type.base },
  toast: {
    position: "absolute",
    top: 80,
    alignSelf: "center",
    backgroundColor: "rgba(28,25,23,0.92)",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
  },
  toastText: { color: "#fff", fontSize: type.base, fontWeight: "600" },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.32)" },
  shareSheet: {
    position: "absolute",
    bottom: 0,
    alignSelf: "center",
    width: "100%",
    maxWidth: DETAIL_FRAME_WIDTH,
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: spacing.md,
  },
  sheetTitle: {
    fontSize: type.lg,
    fontWeight: "700",
    color: colors.onSurface,
    marginBottom: spacing.md,
  },
  shareRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderTopColor: colors.divider,
    borderTopWidth: 1,
  },
  shareLabel: { fontSize: type.lg, color: colors.onSurface },
});
