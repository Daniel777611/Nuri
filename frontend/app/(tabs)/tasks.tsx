import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";

import { api } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

// ── Types & constants ────────────────────────────────────────────────────────
type Task = {
  id: string;
  title: string;
  scope: "today" | "week";
  source: string;
  done: boolean;
  progress_done: number;
  progress_total: number;
};

const MOODS = ["😊", "😐", "😣"];

// ── Main screen ────────────────────────────────────────────────────────────────
export default function Tasks() {
  const [scope, setScope] = useState<"today" | "week">("today");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [insight, setInsight] = useState<string | null>(null);
  const [feedbackTask, setFeedbackTask] = useState<Task | null>(null);
  const [mood, setMood] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const all = await api.listTasks();
    setTasks(all);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const toggle = async (t: Task) => {
    if (t.done) {
      const updated = await api.updateTask(t.id, { done: false });
      setTasks((prev) => prev.map((x) => (x.id === t.id ? updated : x)));
      return;
    }
    const updated = await api.updateTask(t.id, { done: true });
    setTasks((prev) => prev.map((x) => (x.id === t.id ? updated : x)));
    setFeedbackTask(updated);
    setMood(null);
    setNote("");
  };

  const submitFeedback = async () => {
    if (!feedbackTask) return;
    if (mood) {
      await api.updateTask(feedbackTask.id, { mood, note });
      const ins = await api.taskInsights();
      if (ins.streak_days > 1) {
        setInsight(
          `我们记下了——你已经连续 ${ins.streak_days} 天完成任务啦`
        );
      } else {
        setInsight("我们记下了——明天继续，慢慢就有规律了。");
      }
      setTimeout(() => setInsight(null), 4000);
    }
    setFeedbackTask(null);
  };

  const list = tasks.filter((t) => t.scope === scope);
  const active = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>任务</Text>
        <View style={styles.seg}>
          <Pressable
            onPress={() => setScope("today")}
            style={[styles.segBtn, scope === "today" && styles.segActive]}
            testID="tasks-tab-today"
          >
            <Text
              style={[
                styles.segText,
                scope === "today" && styles.segTextActive,
              ]}
            >
              今日
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setScope("week")}
            style={[styles.segBtn, scope === "week" && styles.segActive]}
            testID="tasks-tab-week"
          >
            <Text
              style={[
                styles.segText,
                scope === "week" && styles.segTextActive,
              ]}
            >
              本周
            </Text>
          </Pressable>
        </View>
      </View>

      {insight ? (
        <View style={styles.insight} testID="task-insight-banner">
          <Ionicons name="sparkles" size={14} color={colors.brand} />
          <Text style={styles.insightText}>{insight}</Text>
        </View>
      ) : null}

      <FlatList
        data={[...active, ...done]}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.xxxl,
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons
              name="leaf-outline"
              size={36}
              color={colors.muted}
            />
            <Text style={styles.emptyTitle}>还没有任务</Text>
            <Text style={styles.emptySub}>
              先去和AI聊一聊，TA会帮你生成清单
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => toggle(item)}
            style={[styles.task, item.done && { opacity: 0.55 }]}
            testID={`task-${item.id}`}
          >
            <View
              style={[
                styles.check,
                item.done && {
                  backgroundColor: colors.brand,
                  borderColor: colors.brand,
                },
              ]}
              testID={`task-check-${item.id}`}
            >
              {item.done ? (
                <Ionicons name="checkmark" size={14} color="#fff" />
              ) : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.taskTitle,
                  item.done && {
                    textDecorationLine: "line-through",
                    color: colors.muted,
                  },
                ]}
              >
                {item.title}
              </Text>
              <Text style={styles.taskSrc}>{item.source}</Text>
              {item.scope === "week" ? (
                <View style={styles.progressOuter}>
                  <View
                    style={[
                      styles.progressInner,
                      {
                        width: `${
                          Math.min(
                            100,
                            (item.progress_done / item.progress_total) * 100
                          )
                        }%`,
                      },
                    ]}
                  />
                  <Text style={styles.progressText}>
                    {item.progress_done}/{item.progress_total} 天已完成
                  </Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        )}
      />

      <Modal
        animationType="slide"
        transparent
        visible={!!feedbackTask}
        onRequestClose={() => setFeedbackTask(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalRoot}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setFeedbackTask(null)}
          />
          <View style={styles.sheet} testID="task-feedback-sheet">
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>做得好！坚持是最难的部分</Text>
            <Text style={styles.sheetSub}>今天感觉怎么样？（可选）</Text>
            <View style={styles.moodRow}>
              {MOODS.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setMood(m)}
                  testID={`mood-${m}`}
                  style={[
                    styles.moodBtn,
                    mood === m && {
                      borderColor: colors.brand,
                      backgroundColor: colors.brandTertiary,
                    },
                  ]}
                >
                  <Text style={{ fontSize: 28 }}>{m}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="想留点什么记录？"
              placeholderTextColor={colors.muted}
              style={styles.noteInput}
              testID="reflection-note-input"
              multiline
            />
            <Pressable
              onPress={submitFeedback}
              style={styles.sheetCta}
              testID="task-feedback-submit"
            >
              <Text style={styles.sheetCtaText}>记下</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  h1: {
    fontSize: type.xxl,
    fontWeight: "700",
    color: colors.onSurface,
    marginBottom: spacing.md,
  },
  seg: {
    flexDirection: "row",
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.pill,
    padding: 4,
  },
  segBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: "center",
    borderRadius: radius.pill,
  },
  segActive: { backgroundColor: "#FFFFFF" },
  segText: { color: colors.muted, fontSize: type.base, fontWeight: "600" },
  segTextActive: { color: colors.onSurface },
  insight: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  insightText: { color: colors.onBrandTertiary, fontSize: type.base, flex: 1 },
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
  },
  task: {
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderColor: colors.border,
    borderWidth: 1,
    marginBottom: spacing.sm,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  taskTitle: { fontSize: type.lg, color: colors.onSurface, fontWeight: "600" },
  taskSrc: { fontSize: type.sm, color: colors.muted, marginTop: 4 },
  progressOuter: {
    marginTop: spacing.sm,
    height: 18,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceTertiary,
    overflow: "hidden",
    justifyContent: "center",
  },
  progressInner: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.brand,
    opacity: 0.85,
  },
  progressText: {
    fontSize: 11,
    color: colors.onSurfaceSecondary,
    paddingLeft: spacing.sm,
    fontWeight: "600",
  },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.32)" },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.xl,
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
    fontSize: type.xl,
    fontWeight: "700",
    color: colors.onSurface,
    textAlign: "center",
  },
  sheetSub: {
    fontSize: type.base,
    color: colors.muted,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  moodRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  moodBtn: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  noteInput: {
    marginTop: spacing.lg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 70,
    fontSize: type.base,
    color: colors.onSurface,
  },
  sheetCta: {
    marginTop: spacing.lg,
    backgroundColor: colors.brand,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
  sheetCtaText: { color: "#fff", fontWeight: "700", fontSize: type.lg },
});
