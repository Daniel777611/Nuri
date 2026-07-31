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
  locales?: string[];
  description?: string;
  url: string;
};

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
  const { id } = useLocalSearchParams<{ id: string }>();
  const [card, setCard] = useState<any>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadSequence, setReloadSequence] = useState(0);
  const [favorited, setFavorited] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [resourceLocale, setResourceLocale] = useState<ResourceLocale | null>(null);
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
    setLoadError(false);

    api
      .getCardDetail(id as string)
      .then((detail: any) => {
        if (!active) return;
        setCard(detail);
        api
          .trackEvent("detail_view", { card_id: id, card_type: detail.type })
          .catch(() => {});
      })
      .catch(() => {
        if (active) setLoadError(true);
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
  }, [id, reloadSequence]);

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
      return (
        <View style={styles.stateBox} testID="detail-error-state">
          <Ionicons name="cloud-offline-outline" size={28} color={colors.muted} />
          <Text style={styles.stateTitle}>内容暂时没有加载出来</Text>
          <Text style={styles.stateText}>可以返回首页，或在网络恢复后重试。</Text>
          <Pressable
            onPress={() => setReloadSequence((value) => value + 1)}
            style={styles.retryBtn}
            testID="detail-retry-btn"
          >
            <Text style={styles.retryBtnText}>重新加载</Text>
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

        {resources.length ? (
          <View style={styles.resourcesSection} testID="detail-learning-resources">
            <Text style={styles.sectionTitle}>继续学习</Text>
            <Text style={styles.resourcesIntro}>
              以下内容来自经过审核的官方机构，可切换语言并在外部网站打开。
            </Text>
            {availableResourceLocales.length > 1 ? (
              <View style={styles.resourceLocaleTabs} testID="detail-resource-locale-tabs">
                {availableResourceLocales.map((option) => {
                  const selected = option.value === selectedResourceLocale;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => setResourceLocale(option.value)}
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
            {visibleResources.map((resource) => (
              <Pressable
                key={resource.id}
                onPress={() => openResource(resource)}
                style={({ pressed }) => [styles.resourceCard, pressed && styles.resourceCardPressed]}
                accessibilityRole="link"
                accessibilityLabel={`${resource.language ? `${resource.language}，` : ""}${resource.kind === "video" ? "视频" : "文章"}：${resource.title}`}
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
                    <Text style={styles.resourceKind}>
                      {resource.kind === "video" ? "视频" : "文章"}
                    </Text>
                    {resource.language ? (
                      <Text style={styles.resourceLanguage}>{resource.language}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.resourceTitle}>{resource.title}</Text>
                  <Text style={styles.resourcePublisher}>{resource.publisher}</Text>
                  {resource.description ? (
                    <Text style={styles.resourceDescription}>{resource.description}</Text>
                  ) : null}
                </View>
                <Ionicons name="open-outline" size={18} color={colors.muted} />
              </Pressable>
            ))}
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
        <View style={{ height: 104 }} />
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
          <View style={styles.askBar}>
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
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#FFFFFF",
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
  resourceMetaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  resourceKind: { fontSize: type.sm, color: colors.brand, fontWeight: "700" },
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
