import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
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
import { useLocalSearchParams, useRouter } from "expo-router";

import { api } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

const USE_NATIVE_DRIVER = Platform.OS !== "web";
const DETAIL_FRAME_WIDTH = 402;
const RESOURCE_LOCALE_OPTIONS = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
] as const;
type ResourceLocale = (typeof RESOURCE_LOCALE_OPTIONS)[number]["value"];

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

const RESOURCE_CATEGORIES: {
  key: string;
  category: ResourceContentCategory;
  eyebrow: string;
  title: string;
  description: string;
}[] = [
  {
    key: "authority",
    category: "authority",
    eyebrow: "事实与安全底线",
    title: "权威来源",
    description: "政府、大学、医院、医学组织与专业期刊发布的文章和视频。",
  },
  {
    key: "featured",
    category: "featured",
    eyebrow: "专家与读者精选",
    title: "优秀精彩",
    description: "专业可信、讲解清楚，并适合家庭直接使用的文章和视频。",
  },
  {
    key: "case",
    category: "case",
    eyebrow: "真实经验与实践参考",
    title: "典型案例",
    description: "用具体家庭情境说明问题、过程和可借鉴做法的文章和视频。",
  },
];

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
  if (category === "featured") return "优秀精彩";
  if (category === "case") return "典型案例";
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

function resourceSelectionBasis(resource: LearningResource) {
  if (resource.selection_basis) return resource.selection_basis;
  const category = resourceContentCategory(resource);
  if (category === "case") return "lived_experience";
  if (category === "featured") return "expert_and_audience";
  return "official";
}

function resourceLocales(resource: LearningResource): ResourceLocale[] {
  const explicit = (resource.locales || []).filter((locale): locale is ResourceLocale =>
    RESOURCE_LOCALE_OPTIONS.some((option) => option.value === locale)
  );
  if (explicit.length) return explicit;
  if (resource.language?.includes("繁") || resource.language?.includes("粵")) return ["zh-TW"];
  if (resource.language?.includes("简") || resource.language?.includes("中文")) return ["zh-CN"];
  return ["en"];
}

export default function Detail() {
  const router = useRouter();
  const { width: viewportWidth } = useWindowDimensions();
  const {
    id,
    session_id: sessionId,
    context_created_at: contextCreatedAt,
    recommendation_id: recommendationId,
  } = useLocalSearchParams<{
    id: string;
    session_id?: string;
    context_created_at?: string;
    recommendation_id?: string;
  }>();
  const [card, setCard] = useState<any>(null);
  const [loadError, setLoadError] = useState<"expired" | "generic" | null>(null);
  const [reloadSequence, setReloadSequence] = useState(0);
  const [favorited, setFavorited] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [resourceLocale, setResourceLocale] = useState<ResourceLocale | null>(null);
  const [askBarHeight, setAskBarHeight] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const frameWidth = Math.min(viewportWidth, DETAIL_FRAME_WIDTH);

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

  useEffect(() => {
    if (!id) return;
    let active = true;
    setCard(null);
    setLoadError(null);

    api
      .getCardDetail(id as string, sessionId, contextCreatedAt, recommendationId)
      .then((detail: any) => {
        if (!active) return;
        setCard(detail);
        api
          .trackEvent("detail_view", { card_id: id, card_type: detail.type })
          .catch(() => {});
        if (detail.research_status === "pending") {
          api
            .getCardResearch(id as string, sessionId, contextCreatedAt, recommendationId)
            .then((research: any) => {
              if (!active) return;
              setCard((current: any) =>
                current ? { ...current, ...research } : current
              );
            })
            .catch(() => {
              if (!active) return;
              setCard((current: any) =>
                current
                  ? {
                      ...current,
                      research_status: current.is_dynamic_research_card
                        ? "unavailable"
                        : "reviewed_fallback",
                    }
                  : current
              );
            });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const status =
          error && typeof error === "object" ? (error as any).status : null;
        setLoadError(status === 404 && recommendationId ? "expired" : "generic");
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
    };
  }, [contextCreatedAt, id, recommendationId, reloadSequence, sessionId]);

  useEffect(() => {
    const resources: LearningResource[] = Array.isArray(card?.resources) ? card.resources : [];
    const firstLocale = resources.flatMap(resourceLocales)[0] || null;
    setResourceLocale(firstLocale);
  }, [card]);

  const toggleFavorite = async () => {
    if (!id) return;
    try {
      const result = await api.toggleFavorite(id as string);
      setFavorited(result.favorited);
      showToast(result.favorited ? "已收藏" : "已取消收藏");
      api
        .trackEvent("favorite", {
          card_id: id,
          card_type: card?.type,
          value: result.favorited ? 1 : 0,
        })
        .catch(() => {});
    } catch {
      showToast("收藏暂时没有保存，请稍后再试");
    }
  };

  const askAI = async () => {
    if (!card) return;
    api
      .trackEvent("click_ask_ai_detail", { card_id: card.id, card_type: card.type })
      .catch(() => {});
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

  const openResource = async (resource: LearningResource) => {
    if (!/^https:\/\//i.test(resource.url || "")) {
      showToast("这个外部链接暂时不可用");
      return;
    }
    api
      .trackEvent("external_resource_click", {
        card_id: card?.id,
        resource_id: resource.id,
        resource_kind: resource.kind,
        resource_locale: resourceLocales(resource)[0],
        source_tier: resourceSourceTier(resource),
        content_category: resourceContentCategory(resource),
        selection_basis: resourceSelectionBasis(resource),
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

  const renderBody = () => {
    if (loadError) {
      const recommendationExpired = loadError === "expired";
      return (
        <View style={styles.stateBox} testID="detail-error-state">
          <Ionicons
            name={recommendationExpired ? "time-outline" : "cloud-offline-outline"}
            size={28}
            color={colors.muted}
          />
          <Text style={styles.stateTitle}>
            {recommendationExpired ? "这条个性化推荐已更新" : "内容暂时没有加载出来"}
          </Text>
          <Text style={styles.stateText}>
            {recommendationExpired
              ? "可以根据你现在的对话，重新查看这个学习主题。"
              : "可以返回首页，或在网络恢复后重试。"}
          </Text>
          <Pressable
            onPress={() => {
              if (recommendationExpired) {
                router.replace({ pathname: "/detail/[id]", params: { id: id as string } });
                return;
              }
              setReloadSequence((value) => value + 1);
            }}
            style={styles.retryBtn}
            testID="detail-retry-btn"
          >
            <Text style={styles.retryBtnText}>
              {recommendationExpired ? "查看当前主题" : "重新加载"}
            </Text>
          </Pressable>
        </View>
      );
    }
    if (!card) {
      return (
        <View style={styles.stateBox}>
          <ActivityIndicator color={colors.brand} />
          <Text style={styles.stateText}>正在整理内容与可信学习资源…</Text>
        </View>
      );
    }

    const resources: LearningResource[] = Array.isArray(card.resources) ? card.resources : [];
    const availableResourceLocales = RESOURCE_LOCALE_OPTIONS.filter((option) =>
      resources.some((resource) => resourceLocales(resource).includes(option.value))
    );
    const selectedResourceLocale =
      availableResourceLocales.find((option) => option.value === resourceLocale)?.value ||
      availableResourceLocales[0]?.value;
    const visibleResources = selectedResourceLocale
      ? resources.filter((resource) => resourceLocales(resource).includes(selectedResourceLocale))
      : resources;
    const visibleResourceGroups = RESOURCE_CATEGORIES.map((group) => ({
      ...group,
      resources: visibleResources
        .filter((resource) => resourceContentCategory(resource) === group.category)
        .sort((left, right) => {
          if (left.kind === right.kind) return 0;
          return left.kind === "article" ? -1 : 1;
        }),
    }));
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
            <Text style={styles.sectionTitle}>来源与内容目录</Text>
            {card.research_status === "pending" ? (
              <View style={styles.researchStatusCard} testID="detail-research-status">
                <ActivityIndicator size="small" color="#4F4B9C" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.researchStatusLabel}>正在根据最近对话全网检索</Text>
                  <Text style={styles.researchStatusText}>
                    {resources.length
                      ? "你可以先阅读当前的审核资料；六项个性化内容核验完成后会自动更新。"
                      : "NURI 正在核验与你们刚才话题直接相关的来源；三类文章和视频全部准备好后才会一次性显示。"}
                  </Text>
                </View>
              </View>
            ) : card.research_status === "fresh" || card.research_status === "hybrid" ? (
              <View style={styles.researchStatusCard} testID="detail-research-status">
                <Ionicons name="search" size={16} color="#4F4B9C" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.researchStatusLabel}>
                    {card.research_status === "fresh"
                      ? "根据最近对话为你检索"
                      : "实时检索与审核资料组合"}
                  </Text>
                  <Text style={styles.researchStatusText}>
                    {card.research_status === "hybrid"
                      ? `本次采用 ${card.dynamic_resource_count || 0} 项实时核验结果，其余由人工审核资料补齐；不合格链接没有展示。`
                      : card.research_editor_note ||
                        "NURI 已结合你们刚聊到的情境，从公开网络中核验并整理这组内容。"}
                  </Text>
                </View>
              </View>
            ) : card.research_status === "reviewed_fallback" ||
              card.research_status === "unavailable" ? (
              <View style={styles.researchStatusCard} testID="detail-research-status">
                <Ionicons name="shield-checkmark-outline" size={17} color="#4F4B9C" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.researchStatusLabel}>
                    {resources.length ? "当前展示审核资料库" : "暂未找到完整且可核验的内容"}
                  </Text>
                  <Text style={styles.researchStatusText}>
                    {resources.length
                      ? "实时检索暂未取得完整且全部通过核验的六项结果，因此没有展示不确定链接。"
                      : "本次检索没有凑齐三类文章和视频，因此暂不展示空目录或不确定链接；稍后重新打开即可再试。"}
                  </Text>
                </View>
              </View>
            ) : card.research_status === "consent_required" ? (
              <View style={styles.researchStatusCard} testID="detail-research-status">
                <Ionicons name="lock-closed-outline" size={17} color="#4F4B9C" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.researchStatusLabel}>外部个性化检索尚未开启</Text>
                  <Text style={styles.researchStatusText}>
                    {resources.length
                      ? "当前六项均来自人工审核资料库。只有你在“我的”隐私设置中明确开启后，NURI 才会使用脱敏后的对话主题检索公开网页。"
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
            {resources.length ? (
              <Text style={styles.resourcesIntro}>
                NURI 按权威来源、优秀精彩与典型案例整理内容，并明确标注文章或视频。点击具体条目后，才会打开外部内容。
              </Text>
            ) : null}
            {resources.length && availableResourceLocales.length > 1 ? (
              <View style={styles.resourceLocaleTabs} testID="detail-resource-locale-tabs">
                {availableResourceLocales.map((option) => {
                  const selected = option.value === selectedResourceLocale;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setResourceLocale(option.value)}
                      hitSlop={6}
                      style={[
                        styles.resourceLocaleTab,
                        selected && styles.resourceLocaleTabSelected,
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      testID={`detail-resource-locale-${option.value}`}
                    >
                      <Text
                        style={[
                          styles.resourceLocaleTabText,
                          selected && styles.resourceLocaleTabTextSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            {resources.length ? visibleResourceGroups.map((group) => (
              <View
                key={group.key}
                style={styles.resourceGroup}
                testID={`detail-resource-group-${group.key}`}
              >
                <View style={styles.resourceGroupHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.resourceGroupEyebrow}>{group.eyebrow}</Text>
                    <Text style={styles.resourceGroupTitle}>{group.title}</Text>
                    <Text style={styles.resourceGroupDescription}>{group.description}</Text>
                  </View>
                  <View style={styles.resourceGroupCount}>
                    <Text
                      style={styles.resourceGroupCountText}
                      accessibilityLabel={`${group.resources.length} 项内容`}
                    >
                      {group.resources.length}
                    </Text>
                  </View>
                </View>

                {group.resources.length ? group.resources.map((resource) => (
                  <Pressable
                    key={resource.id}
                    onPress={() => openResource(resource)}
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
                      当前审核库在这个语言下暂无完整的文章和视频组合。
                    </Text>
                  </View>
                )}
              </View>
            )) : null}
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
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  resourceLocaleTab: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
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
