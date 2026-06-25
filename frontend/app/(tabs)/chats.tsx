import { useCallback, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
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
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

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
    if (creating) return;
    setCreating(true);
    try {
      const s = await api.startSession({ script_key: "free" });
      router.push(`/chat/${s.id}`);
    } finally {
      setCreating(false);
    }
  };

  const handleMinusTap = (id: string) => {
    if (confirmId === id) {
      doDelete(id);
    } else {
      setConfirmId(id);
      // Auto-cancel confirm after 3s
      setTimeout(() => setConfirmId((cur) => (cur === id ? null : cur)), 3000);
    }
  };

  const doDelete = async (id: string) => {
    setConfirmId(null);
    setDeleting(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    try {
      await api.deleteSession(id);
    } catch {
      await load();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>对话</Text>
        <View style={styles.headerActions}>
          {sessions.length > 0 && (
            <Pressable
              onPress={() => setEditing((e) => !e)}
              style={styles.editBtn}
              testID="chats-edit-btn"
            >
              <Text style={[styles.editBtnText, editing && { color: colors.brand, fontWeight: "700" }]}>
                {editing ? "完成" : "编辑"}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={startNew}
            disabled={creating}
            style={[styles.newBtn, creating && { opacity: 0.5 }]}
            testID="chats-new-btn"
          >
            <Ionicons name={creating ? "ellipsis-horizontal" : "add"} size={20} color="#fff" />
          </Pressable>
        </View>
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
            <Ionicons name="chatbubbles-outline" size={36} color={colors.muted} />
            <Text style={styles.emptyTitle}>还没有对话</Text>
            <Text style={styles.emptySub}>
              点击右上角按钮，或在首页对任意一条内容"问问AI"
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.rowWrap}>
            {editing && (
              <Pressable
                onPress={() => handleMinusTap(item.id)}
                disabled={deleting === item.id}
                style={[
                  styles.deleteBtn,
                  confirmId === item.id && styles.deleteBtnConfirm,
                ]}
                testID={`delete-session-${item.id}`}
              >
                {confirmId === item.id ? (
                  <Text style={styles.confirmText}>删除</Text>
                ) : (
                  <Ionicons
                    name="remove-circle"
                    size={22}
                    color={deleting === item.id ? colors.muted : colors.error}
                  />
                )}
              </Pressable>
            )}
            <Pressable
              testID={`session-${item.id}`}
              onPress={() => !editing && router.push(`/chat/${item.id}`)}
              onLongPress={() => setEditing(true)}
              style={[styles.row, { flex: 1 }]}
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
              {!editing && (
                <Ionicons name="chevron-forward" size={16} color={colors.muted} />
              )}
            </Pressable>
          </View>
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
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  editBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  editBtnText: { fontSize: type.base, color: colors.muted },
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
  rowWrap: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  deleteBtn: {
    width: 28,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  deleteBtnConfirm: {
    width: 44,
    backgroundColor: colors.error,
    borderRadius: radius.sm,
  },
  confirmText: {
    color: "#fff",
    fontSize: type.sm,
    fontWeight: "700",
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
