import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import ConfirmDialog from "@/src/components/ConfirmDialog";
import Toast from "@/src/components/Toast";
import { useT } from "@/src/i18n";
import { colors, radius, spacing, type } from "@/src/theme";

type Memory = Awaited<ReturnType<typeof api.listMemories>>[number];

// What NURI has kept from the conversation. Every row shapes replies and the
// daily cards, so the parent can see each one and make NURI forget it.
export default function Memories() {
  const { t } = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const phoneWidth = Math.min(width, 402);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [pendingForget, setPendingForget] = useState<Memory | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToastMsg(message);
    setTimeout(() => setToastMsg(null), 2000);
  };

  const load = useCallback(async () => {
    setState("loading");
    try {
      setMemories(await api.listMemories());
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const forget = async () => {
    const memory = pendingForget;
    setPendingForget(null);
    if (!memory) return;
    const before = memories;
    setMemories((current) => current.filter((m) => m.id !== memory.id));
    try {
      await api.forgetMemory(memory.id);
      showToast(t("NURI 已经忘记这一条"));
    } catch {
      setMemories(before);
      showToast(t("删除失败，请重试"));
    }
  };

  const standing = memories.filter((m) => m.standing);
  const background = memories.filter((m) => !m.standing);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={[styles.canvas, { width: phoneWidth }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8} testID="memories-back">
            <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.title}>{t("NURI 记得的事")}</Text>
          <View style={styles.back} />
        </View>

        {state === "loading" ? (
          <View style={styles.center}><ActivityIndicator color={colors.brand} /></View>
        ) : state === "error" ? (
          <Pressable style={styles.center} onPress={() => void load()} testID="memories-retry">
            <Ionicons name="refresh" size={22} color={colors.brand} />
            <Text style={styles.muted}>{t("没能加载，点此重试")}</Text>
          </Pressable>
        ) : (
          <ScrollView contentContainerStyle={styles.scroll}>
            <Text style={styles.intro}>
              {t("这些是 NURI 从你们的对话里记下的家庭情况，用来让回复和每日精选更贴合你家。觉得不对或不想被记住的，可以直接删除。")}
            </Text>
            {memories.length === 0 ? (
              <View style={styles.empty} testID="memories-empty">
                <Ionicons name="albums-outline" size={28} color={colors.muted} />
                <Text style={styles.muted}>{t("NURI 还没有记下什么。多聊几次，它会慢慢了解你家。")}</Text>
              </View>
            ) : null}
            {standing.length ? (
              <Group
                title={t("每次都会遵守")}
                hint={t("例如过敏、饮食限制。NURI 的每一次回复和推荐都会照顾到这些。")}
                items={standing}
                onForget={setPendingForget}
              />
            ) : null}
            {background.length ? (
              <Group
                title={t("聊天时参考")}
                hint={t("NURI 了解到的近况，和你聊相关话题时会想起来。")}
                items={background}
                onForget={setPendingForget}
              />
            ) : null}
          </ScrollView>
        )}

        <ConfirmDialog
          visible={!!pendingForget}
          title="让 NURI 忘记这一条？"
          message={pendingForget?.text || ""}
          confirmText="忘记"
          danger
          onConfirm={() => void forget()}
          onCancel={() => setPendingForget(null)}
        />
        <Toast message={toastMsg} />
      </View>
    </SafeAreaView>
  );
}

function Group({
  title,
  hint,
  items,
  onForget,
}: {
  title: string;
  hint: string;
  items: Memory[];
  onForget: (memory: Memory) => void;
}) {
  const { t } = useT();
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      <Text style={styles.groupHint}>{hint}</Text>
      <View style={styles.card}>
        {items.map((memory, index) => (
          <View
            key={memory.id}
            style={[styles.row, index === items.length - 1 && { borderBottomWidth: 0 }]}
            testID={`memory-${memory.id}`}
          >
            <Text style={styles.rowText}>{memory.text}</Text>
            <Pressable
              onPress={() => onForget(memory)}
              hitSlop={8}
              style={styles.forget}
              accessibilityRole="button"
              accessibilityLabel={t("删除这一条")}
              testID={`memory-forget-${memory.id}`}
            >
              <Ionicons name="trash-outline" size={18} color={colors.muted} />
            </Pressable>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  canvas: { flex: 1, alignSelf: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  back: { width: 40, height: 40, justifyContent: "center" },
  title: { flex: 1, textAlign: "center", fontSize: type.lg, fontWeight: "700", color: colors.onSurface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  muted: { color: colors.muted, fontSize: type.base, textAlign: "center", lineHeight: 20 },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  intro: { color: colors.onSurfaceTertiary, fontSize: type.sm, lineHeight: 19, marginBottom: spacing.lg },
  empty: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xl, paddingHorizontal: spacing.lg },
  group: { marginBottom: spacing.xl },
  groupTitle: { fontSize: type.base, fontWeight: "700", color: colors.onSurface },
  groupHint: { fontSize: type.sm, color: colors.muted, marginTop: 2, marginBottom: spacing.sm, lineHeight: 18 },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowText: { flex: 1, fontSize: type.base, color: colors.onSurface, lineHeight: 20 },
  forget: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
});
