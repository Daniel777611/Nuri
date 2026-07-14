import { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Pressable, Animated } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import {
  TaskItem,
  taskColors as c,
  taskTypeMeta,
  formatCNDate,
  isOverdue,
  progressRatio,
} from "@/src/taskMeta";

/**
 * 任务卡片（设计稿复刻）：
 * 任务名（类型前缀+标题）→ 频率小字 → 进度条 → 截止日期/已过期 → 删除icon + 立刻打卡/补全打卡按钮
 * 已完成卡片：浅紫底、删除线简化样式。
 */
export default function TaskCard({
  task,
  archiving = false,
  completedMode = false,
  onPressBody,
  onCheckin,
  onBackfill,
  onDelete,
}: {
  task: TaskItem;
  archiving?: boolean;
  completedMode?: boolean;
  onPressBody: () => void;
  onCheckin?: () => void;
  onBackfill?: () => void;
  onDelete?: () => void;
}) {
  const meta = taskTypeMeta(task.task_type);
  const overdue = isOverdue(task);
  const ratio = progressRatio(task);

  // 归档动效：淡出 + 轻微下移
  const opacity = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (archiving) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 320, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 14, duration: 320, useNativeDriver: true }),
      ]).start();
    } else {
      opacity.setValue(1);
      translateY.setValue(0);
    }
  }, [archiving, opacity, translateY]);

  // 已完成卡片：简化样式（浅紫底 + 删除线）
  if (completedMode) {
    return (
      <Pressable onPress={onPressBody} testID={`task-card-${task.id}`}>
        <View style={styles.doneCard}>
          <Text style={styles.doneTitle} numberOfLines={1}>
            {meta.prefix}：{task.title}
          </Text>
        </View>
      </Pressable>
    );
  }

  return (
    <Animated.View
      style={[
        styles.card,
        overdue && styles.cardOverdue,
        { opacity, transform: [{ translateY }] },
      ]}
      testID={`task-card-${task.id}`}
    >
      <Pressable onPress={onPressBody} testID={`task-body-${task.id}`}>
        {/* 任务名（类型前缀+标题） */}
        <Text style={styles.title} numberOfLines={2}>
          {meta.prefix}：{task.title}
        </Text>

        {/* 频率小字 */}
        {task.is_recurring && task.frequency_label ? (
          <Text style={styles.freq}>{task.frequency_label}</Text>
        ) : null}

        {/* 进度条 */}
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${ratio * 100}%` }]} />
        </View>

        {/* 截止日期 / 已过期 */}
        <View style={styles.statusRow}>
          {overdue ? (
            <Text style={styles.overdueText} testID={`task-overdue-${task.id}`}>
              已过期
            </Text>
          ) : task.due_date ? (
            <Text style={styles.dueText}>截止：{formatCNDate(task.due_date)}</Text>
          ) : null}
        </View>
      </Pressable>

      {/* 底部操作行：删除 icon（左，仅在传入 onDelete 时显示）+ 打卡按钮（右） */}
      <View style={styles.actionRow}>
        {onDelete ? (
          <Pressable
            onPress={onDelete}
            style={[styles.trashBtn, overdue && styles.trashBtnOverdue]}
            hitSlop={6}
            testID={`task-delete-${task.id}`}
          >
            <Ionicons
              name="trash-outline"
              size={18}
              color={overdue ? c.overdue : c.textSecondary}
            />
          </Pressable>
        ) : null}
        {overdue ? (
          <Pressable
            onPress={onBackfill}
            style={styles.backfillBtn}
            testID={`task-backfill-${task.id}`}
          >
            <Text style={styles.backfillText}>补全打卡</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={onCheckin}
            style={styles.checkinBtn}
            testID={`task-check-${task.id}`}
          >
            <Text style={styles.checkinText}>立刻打卡</Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: c.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardOverdue: {
    backgroundColor: c.overdueBg,
    borderLeftWidth: 3,
    borderLeftColor: c.overdue,
  },
  title: { fontSize: 16, fontWeight: "700", color: c.text, lineHeight: 22 },
  freq: { fontSize: 12, color: c.textSecondary, marginTop: 6 },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: c.track,
    overflow: "hidden",
    marginTop: 10,
  },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: c.primary },
  statusRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 6,
    minHeight: 16,
  },
  dueText: { fontSize: 12, color: c.textSecondary },
  overdueText: { fontSize: 12, color: c.overdue, fontWeight: "700" },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 8,
  },
  trashBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: c.track,
    alignItems: "center",
    justifyContent: "center",
  },
  trashBtnOverdue: { borderColor: "#F6C6C2" },
  checkinBtn: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    backgroundColor: c.primaryLight,
    alignItems: "center",
    justifyContent: "center",
  },
  checkinText: { color: c.primary, fontSize: 14, fontWeight: "600" },
  backfillBtn: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: c.overdue,
    alignItems: "center",
    justifyContent: "center",
  },
  backfillText: { color: c.overdue, fontSize: 14, fontWeight: "600" },
  doneCard: {
    backgroundColor: c.completedBg,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
  },
  doneTitle: {
    fontSize: 14,
    color: c.textSecondary,
    textDecorationLine: "line-through",
  },
});
