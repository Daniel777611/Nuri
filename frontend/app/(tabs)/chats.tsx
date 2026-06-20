import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";

import { api } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

export default function Chats() {
  const router = useRouter();
  const [sessions, setSessions] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const list = await api.listSessions();
    setSessions(list);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const startNew = async () => {
    const s = await api.startSession({ script_key: "free" });
    router.push(`/chat/${s.id}`);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>对话</Text>
        <Pressable
          onPress={startNew}
          style={styles.newBtn}
          testID="chats-new-btn"
        >
          <Ionicons name="add" size={20} color="#fff" />
        </Pressable>
      </View>

      <FlatList
        data={sessions}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.xxxl,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={colors.brand}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons
              name="chatbubbles-outline"
              size={36}
              color={colors.muted}
            />
            <Text style={styles.emptyTitle}>还没有对话</Text>
            <Text style={styles.emptySub}>
              点击右上角按钮，或在首页对任意一条内容“问问AI”
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            testID={`session-${item.id}`}
            onPress={() => router.push(`/chat/${item.id}`)}
            style={styles.row}
          >
            <View style={styles.avatar}>
              <Ionicons name="leaf-outline" size={18} color={colors.brand} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {new Date(item.created_at).toLocaleString("zh-CN", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  h1: { fontSize: type.xxl, fontWeight: "700", color: colors.onSurface },
  newBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  empty: { alignItems: "center", paddingTop: spacing.xxxl },
  emptyTitle: {
    fontSize: type.lg,
    fontWeight: "600",
    color: colors.onSurface,
    marginTop: spacing.md,
  },
  emptySub: {
    fontSize: type.base,
    color: colors.muted,
    marginTop: spacing.sm,
    textAlign: "center",
    paddingHorizontal: spacing.xl,
    lineHeight: 20,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { fontSize: type.lg, color: colors.onSurface, fontWeight: "600" },
  rowSub: { fontSize: type.sm, color: colors.muted, marginTop: 2 },
});
