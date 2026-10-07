import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { colors, radius, spacing, type } from "@/src/theme";
import { useT } from "@/src/i18n";

type Post = { name: string; meta: string; body: string; likes: number };

// No posts yet. The three that used to sit here were phase-one placeholders
// written about a feed card that no longer exists.
const POSTS: Post[] = [];

export default function Community() {
  const { t } = useT();
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.back}
          testID="community-back-btn"
        >
          <Ionicons name="chevron-back" size={20} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>{t("家长们的经验")}</Text>
        <View style={{ width: 36 }} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.note} testID="community-mock-banner">
          <Ionicons name="information-circle-outline" size={16} color={colors.muted} />
          <Text style={styles.noteText}>
            {t("这是社群的预览版本，仅展示其他家长匿名分享的经验，暂不开放互动。")}
          </Text>
        </View>
        {POSTS.length === 0 ? (
          <View style={styles.empty} testID="community-empty">
            <Ionicons name="people-outline" size={28} color={colors.muted} />
            <Text style={styles.emptyText}>{t("还没有家长分享经验")}</Text>
          </View>
        ) : null}
        {POSTS.map((p, i) => (
          <View key={i} style={styles.card} testID={`community-post-${i}`}>
            <View style={styles.cardTop}>
              <View style={styles.avatar}>
                <Ionicons name="person-outline" size={14} color={colors.brand} />
              </View>
              <View>
                <Text style={styles.name}>{p.name}</Text>
                <Text style={styles.meta}>{p.meta}</Text>
              </View>
            </View>
            <Text style={styles.body}>{p.body}</Text>
            <View style={styles.cardFoot}>
              <Ionicons name="heart-outline" size={14} color={colors.muted} />
              <Text style={styles.foot}>{p.likes}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomColor: colors.divider,
    borderBottomWidth: 1,
    backgroundColor: "#fff",
  },
  back: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  title: { flex: 1, textAlign: "center", fontSize: type.lg, fontWeight: "600" },
  scroll: { padding: spacing.lg },
  note: {
    flexDirection: "row",
    gap: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    alignItems: "flex-start",
  },
  noteText: { flex: 1, color: colors.muted, fontSize: type.sm, lineHeight: 18 },
  empty: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xl },
  emptyText: { color: colors.muted, fontSize: type.base },
  card: {
    backgroundColor: "#fff",
    borderRadius: radius.md,
    borderColor: colors.border,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: type.base, fontWeight: "600", color: colors.onSurface },
  meta: { fontSize: type.sm, color: colors.muted, marginTop: 2 },
  body: {
    marginTop: spacing.sm,
    fontSize: type.base,
    color: colors.onSurfaceSecondary,
    lineHeight: 20,
  },
  cardFoot: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  foot: { fontSize: type.sm, color: colors.muted },
});
