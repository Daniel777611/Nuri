import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { api } from "@/src/api";
import {
  TaskItem,
  taskColors as c,
  taskTypeMeta,
  formatSlashDate,
  progressRatio,
  toTaskItem,
} from "@/src/taskMeta";
import CheckinSheet from "@/src/components/CheckinSheet";
import Toast from "@/src/components/Toast";

export default function TaskDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [task, setTask] = useState<TaskItem | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      // No single-task fetch on the backend — list + find by id.
      api
        .listTasks()
        .then((all: any[]) => {
          const raw = all.find((t) => t.id === id);
          setTask(raw ? toTaskItem(raw) : null);
        })
        .catch(() => {});
    }, [id])
  );

  if (!task) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loading}>
          <Text style={{ color: c.textSecondary }}>加载中...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const meta = taskTypeMeta(task.task_type);
  const ratio = progressRatio(task);
  const completed = !!task.completed_at;

  const checkin = async () => {
    if (completed) return;
    const updated = await api.updateTask(task.id, { done: true });
    setTask(toTaskItem(updated));
    setSheetOpen(true);
  };

  const onSheetDone = (rating: string | null) => {
    setSheetOpen(false);
    if (rating && task) {
      api.updateTask(task.id, { mood: rating });
      setToastMsg("已记录你的感受 ✓");
      setTimeout(() => setToastMsg(null), 2000);
    }
    // 任务全部完成 → 回到列表（卡片归入已完成区）
    if (task?.completed_at) {
      setTimeout(() => router.back(), rating ? 900 : 400);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      {/* 顶部：返回「任务卡」 */}
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={styles.backRow}
          testID="task-detail-back"
        >
          <Ionicons name="chevron-back" size={24} color={c.text} />
          <Text style={styles.topTitle}>任务卡</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          {/* 任务名 + 类型 pill */}
          <View style={styles.titleRow}>
            <Text style={styles.title} testID="task-detail-title">
              {task.title}
            </Text>
            <View style={styles.pill}>
              <Text style={styles.pillText}>{meta.label}</Text>
            </View>
          </View>

          {/* 三栏信息行：开始日期 / 结束日期 / 任务频率 */}
          <View style={styles.infoRow} testID="task-detail-info">
            <View style={styles.infoCol}>
              <Text style={styles.infoLabel}>开始日期</Text>
              <Text style={styles.infoValue}>{formatSlashDate(task.created_at)}</Text>
            </View>
            <View style={styles.infoDivider} />
            <View style={styles.infoCol}>
              <Text style={styles.infoLabel}>结束日期</Text>
              <Text style={styles.infoValue}>{formatSlashDate(task.due_date)}</Text>
            </View>
            <View style={styles.infoDivider} />
            <View style={styles.infoCol}>
              <Text style={styles.infoLabel}>任务频率</Text>
              <Text style={styles.infoValueSmall}>
                {task.is_recurring ? task.frequency_label || "重复性" : "一次性"}
              </Text>
            </View>
          </View>

          {/* 当前进度 */}
          <Text style={styles.sectionTitle}>当前进度</Text>
          <View style={styles.progressWrap}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${ratio * 100}%` }]} />
            </View>
            <Text style={styles.progressNum}>
              {completed && !task.is_recurring
                ? "1/1"
                : `${task.completed_count}/${task.total_count}`}
            </Text>
          </View>

          {/* 任务介绍 */}
          {task.description ? (
            <>
              <Text style={styles.sectionTitle}>任务介绍</Text>
              <Text style={styles.desc}>{task.description}</Text>
            </>
          ) : null}

          {/* 指引 */}
          {task.steps?.length ? (
            <>
              <Text style={styles.sectionTitle}>指引</Text>
              {task.steps.map((s, i) => (
                <View key={i} style={styles.stepRow}>
                  <Text style={styles.stepNum}>{i + 1}.</Text>
                  <Text style={styles.stepText}>{s}</Text>
                </View>
              ))}
            </>
          ) : null}
        </View>
      </ScrollView>

      {/* 底部固定区：导出 icon（左）+ 打卡完成（右） */}
      <View style={styles.footer}>
        <Pressable
          onPress={() => {
            setToastMsg("图片已保存到相册");
            setTimeout(() => setToastMsg(null), 2000);
          }}
          style={styles.exportBtn}
          hitSlop={6}
          testID="task-detail-export"
        >
          <Ionicons name="download-outline" size={20} color={c.textSecondary} />
        </Pressable>
        <Pressable
          onPress={checkin}
          disabled={completed}
          style={[styles.cta, completed && styles.ctaDone]}
          testID="task-detail-checkin"
        >
          <Ionicons
            name="checkmark-circle-outline"
            size={18}
            color={completed ? c.textSecondary : "#fff"}
          />
          <Text style={[styles.ctaText, completed && { color: c.textSecondary }]}>
            {completed ? "已完成" : "打卡完成"}
          </Text>
        </Pressable>
      </View>

      <CheckinSheet visible={sheetOpen} taskType={task.task_type} onDone={onSheetDone} />
      <Toast message={toastMsg} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  topTitle: { fontSize: 20, fontWeight: "700", color: c.text },
  scroll: { paddingHorizontal: 16, paddingBottom: 24 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  title: { flex: 1, fontSize: 20, fontWeight: "700", color: c.text, lineHeight: 28 },
  pill: {
    backgroundColor: c.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
  },
  pillText: { fontSize: 12, fontWeight: "700", color: c.primary },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    paddingVertical: 10,
  },
  infoCol: { flex: 1, gap: 4 },
  infoDivider: { width: 1, height: 30, backgroundColor: c.track, marginHorizontal: 10 },
  infoLabel: { fontSize: 12, color: c.textSecondary },
  infoValue: { fontSize: 18, fontWeight: "800", color: c.text },
  infoValueSmall: { fontSize: 13, fontWeight: "700", color: c.text, lineHeight: 18 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: c.text,
    marginTop: 18,
    marginBottom: 8,
  },
  progressWrap: { flexDirection: "row", alignItems: "center", gap: 10 },
  progressTrack: {
    flex: 1,
    height: 10,
    borderRadius: 5,
    backgroundColor: c.track,
    overflow: "hidden",
  },
  progressFill: { height: 10, borderRadius: 5, backgroundColor: c.primary },
  progressNum: { fontSize: 13, fontWeight: "700", color: c.text },
  desc: { fontSize: 14, color: "#4A4A4E", lineHeight: 22 },
  stepRow: { flexDirection: "row", gap: 6, marginBottom: 8 },
  stepNum: { fontSize: 14, color: "#4A4A4E", lineHeight: 22 },
  stepText: { flex: 1, fontSize: 14, color: "#4A4A4E", lineHeight: 22 },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    backgroundColor: c.bg,
  },
  exportBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  cta: {
    flex: 1,
    height: 46,
    borderRadius: 8,
    backgroundColor: c.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  ctaDone: { backgroundColor: c.track },
  ctaText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
