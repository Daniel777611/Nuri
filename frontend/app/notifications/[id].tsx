// Where a tapped notification lands.
//
// A lock screen may only carry a vague line (no child's name, no detail the
// parent shared), so this screen is where the note is read in full, behind the
// signed-in session, together with the piece of NURI content chosen for it.
// The server answers 404 for a notification that belongs to someone else, which
// this screen shows exactly like one that never existed.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { api, ApiError, isAuthError, type NotificationDetail } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { useT } from "@/src/i18n";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: NotificationDetail }
  | { kind: "missing" }
  | { kind: "error" };

export default function NotificationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useT();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "missing" });
      return;
    }
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", data: await api.getNotification(String(id)) });
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setState(err instanceof ApiError && err.status === 404 ? { kind: "missing" } : { kind: "error" });
    }
  }, [id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

  const card =
    state.kind === "ready" && state.data.target.kind === "learning_card"
      ? (state.data.target as Extract<NotificationDetail["target"], { kind: "learning_card" }>)
      : null;

  const post =
    state.kind === "ready" && state.data.target.kind === "daily_post"
      ? (state.data.target as Extract<NotificationDetail["target"], { kind: "daily_post" }>)
      : null;

  // The server's `content` repeats the card's title and summary after a blank
  // line, for clients that cannot render the card. This screen renders the
  // card itself, so it shows only the note.
  const note =
    state.kind === "ready"
      ? card || post
        ? state.data.content.split(/\n\s*\n/)[0]
        : state.data.content
      : "";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={back} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("返回")}>
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("来自 NURI")}</Text>
        <View style={{ width: 24 }} />
      </View>

      {state.kind === "loading" && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      )}

      {state.kind === "missing" && (
        <View style={styles.center}>
          <Text style={styles.stateText}>{t("这条通知不存在或已过期")}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => router.replace("/")}>
            <Text style={styles.secondaryButtonText}>{t("回到首页")}</Text>
          </Pressable>
        </View>
      )}

      {state.kind === "error" && (
        <View style={styles.center}>
          <Text style={styles.stateText}>{t("加载失败，请稍后再试")}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => void load()}>
            <Text style={styles.secondaryButtonText}>{t("重试")}</Text>
          </Pressable>
        </View>
      )}

      {state.kind === "ready" && (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.title}>{state.data.title}</Text>
          <Text style={styles.note}>{note}</Text>

          {card && (
            <View style={styles.cardSection}>
              <Text style={styles.cardEyebrow}>{t("为你挑的一篇内容")}</Text>
              <Pressable
                style={styles.card}
                onPress={() => router.push(`/detail/${card.id}` as never)}
                accessibilityRole="button"
              >
                {!!card.topic_label && <Text style={styles.cardTopic}>{card.topic_label}</Text>}
                <Text style={styles.cardTitle}>{card.title}</Text>
                {!!card.summary && <Text style={styles.cardSummary}>{card.summary}</Text>}
                <View style={styles.cardCta}>
                  <Text style={styles.cardCtaText}>{card.cta || t("浏览详情")}</Text>
                  <Ionicons name="arrow-forward" size={16} color={colors.brandPrimary} />
                </View>
              </Pressable>
            </View>
          )}

          {post && (
            <View style={styles.cardSection}>
              <Text style={styles.cardEyebrow}>{t("为你挑的一篇内容")}</Text>
              <Pressable
                style={styles.card}
                onPress={() => router.push(post.route as never)}
                accessibilityRole="button"
                testID="notification-daily-post"
              >
                <Text style={styles.cardTopic}>{t("每日精选")}</Text>
                <Text style={styles.cardTitle}>{post.title}</Text>
                {!!post.summary && <Text style={styles.cardSummary}>{post.summary}</Text>}
                <View style={styles.cardCta}>
                  <Text style={styles.cardCtaText}>{t("点击查看更多")}</Text>
                  <Ionicons name="arrow-forward" size={16} color={colors.brandPrimary} />
                </View>
              </Pressable>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerTitle: { fontSize: type.lg, fontWeight: "600", color: colors.onSurface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg, padding: spacing.xl },
  stateText: { fontSize: type.base, color: colors.muted, textAlign: "center" },
  secondaryButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  secondaryButtonText: { fontSize: type.base, color: colors.onSurface },
  body: { padding: spacing.xl, gap: spacing.lg },
  title: { fontSize: type.xxl, fontWeight: "700", color: colors.onSurface, lineHeight: 32 },
  note: { fontSize: type.lg, color: colors.onSurfaceTertiary, lineHeight: 26 },
  cardSection: { marginTop: spacing.lg, gap: spacing.sm },
  cardEyebrow: { fontSize: type.sm, color: colors.muted, letterSpacing: 0.5 },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardTopic: {
    alignSelf: "flex-start",
    fontSize: type.sm,
    color: colors.onBrandTertiary,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    overflow: "hidden",
  },
  cardTitle: { fontSize: type.lg, fontWeight: "600", color: colors.onSurface, lineHeight: 24 },
  cardSummary: { fontSize: type.base, color: colors.muted, lineHeight: 22 },
  cardCta: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.xs },
  cardCtaText: { fontSize: type.base, fontWeight: "600", color: colors.brandPrimary },
});
