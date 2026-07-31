import { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  ScrollView,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useFocusEffect, useRouter } from "expo-router";

import { api } from "@/src/api";
import { useT } from "@/src/i18n";
import {
  TaskItem,
  TASK_TYPES,
  FILTER_TYPES,
  taskColors as c,
  formatSlashDate,
  toTaskItem,
} from "@/src/taskMeta";
import TaskCard from "@/src/components/TaskCard";
import CheckinSheet from "@/src/components/CheckinSheet";
import ConfirmDialog from "@/src/components/ConfirmDialog";
import Toast from "@/src/components/Toast";

const blurredTaskBackground = require("@/assets/images/tasks-blurred-background.png");

export default function Tasks() {
  const router = useRouter();
  const { t } = useT();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filters, setFilters] = useState<string[]>([]); // 空 = 全部（支持多选）
  const [completedOpen, setCompletedOpen] = useState(false);

  // 打卡反馈流程状态
  const [sheetFor, setSheetFor] = useState<TaskItem | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const [confirm, setConfirm] = useState<
    { kind: "delete"; task: TaskItem } | { kind: "clear" } | null
  >(null);

  // 隐藏 debug toggle（长按标题切换）：自动清理阈值 7天 ↔ 30分钟，方便现场演示归档清理效果
  const [debugFastCleanup, setDebugFastCleanup] = useState(false);

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2000);
  };

  const load = useCallback(async () => {
    const all = await api.listTasks();
    setTasks(all.map(toTaskItem));
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const applyUpdate = (updated: TaskItem) =>
    setTasks((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));

  // ---- 打卡流程：立刻打卡 → API → bottom sheet 感想 → 归档动效 ----
  const checkin = async (task: TaskItem) => {
    if (task.completed_at) return;
    const updated = await api.updateTask(task.id, { done: true });
    setSheetFor(toTaskItem(updated)); // 卡片状态在 sheet 关闭后才更新，避免打卡瞬间跳区
  };

  const onSheetDone = async (rating: string | null) => {
    const updated = sheetFor;
    setSheetFor(null);
    if (!updated) return;
    if (rating) {
      api.updateTask(updated.id, { mood: rating });
      showToast(t("已记录你的感受 ✓"));
    }
    if (updated.completed_at) {
      // 淡出 + 轻微下移动效后归入「已完成」
      setArchivingId(updated.id);
      setTimeout(() => {
        applyUpdate(updated);
        setArchivingId(null);
      }, 380);
    } else {
      applyUpdate(updated); // 重复任务：进度 +1
    }
  };

  const backfill = async (task: TaskItem) => {
    const updated = await api.updateTask(task.id, { done: true, backfilled: true });
    applyUpdate(toTaskItem(updated));
    showToast(t("已补全打卡"));
  };

  const onConfirm = async () => {
    if (!confirm) return;
    if (confirm.kind === "delete") {
      await api.deleteTask(confirm.task.id);
      setTasks((prev) => prev.filter((item) => item.id !== confirm.task.id));
    } else {
      await api.clearCompletedTasks();
      await load();
    }
    setConfirm(null);
  };

  const toggleFilter = (key: string) =>
    setFilters((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]));

  // ---- 列表数据 ----
  const matchesFilter = (item: TaskItem) =>
    filters.length === 0 || filters.includes(item.task_type);

  // 归档清理规则：完成超过阈值且未收藏 → 不显示；已收藏 → 始终保留
  const cleanupThresholdMs = debugFastCleanup ? 30 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const pending = tasks.filter((item) => !item.completed_at && matchesFilter(item));
  const completed = tasks.filter(
    (item) =>
      item.completed_at &&
      matchesFilter(item) &&
      (item.is_favorited ||
        Date.now() - Date.parse(item.completed_at) <= cleanupThresholdMs)
  );
  const pendingTotal = tasks.filter((item) => !item.completed_at).length;

  const renderCompletedSection = () => (
    <View>
      {completed.length > 0 ? (
        <>
          <Pressable
            onPress={() => setCompletedOpen(!completedOpen)}
            style={styles.doneHeader}
            testID="tasks-completed-toggle"
          >
            <Text style={styles.doneHeaderText}>{t("已完成（{count}）", { count: completed.length })}</Text>
            <Ionicons
              name={completedOpen ? "chevron-up" : "chevron-down"}
              size={18}
              color={c.textSecondary}
            />
          </Pressable>
          {completedOpen
            ? completed.map((item) => (
                <TaskCard
                  key={item.id}
                  task={item}
                  completedMode
                  onPressBody={() => router.push(`/task/${item.id}` as any)}
                />
              ))
            : null}
          <Pressable
            onPress={() => setConfirm({ kind: "clear" })}
            style={styles.clearBtn}
            testID="tasks-clear-completed"
          >
            <Text style={styles.clearText}>{t("清空已完成任务")}</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );

  const today = new Date().toISOString().slice(0, 10);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
      <Image source={blurredTaskBackground} style={styles.backgroundImage} resizeMode="cover" />
      <View pointerEvents="none" style={styles.haloBlue} />
      <View pointerEvents="none" style={styles.haloRed} />
      <BlurView pointerEvents="none" intensity={100} tint="light" style={StyleSheet.absoluteFill} />
      {/* 顶部：返回 + 我的任务 */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.replace("/(tabs)")}
          hitSlop={8}
          testID="tasks-back-btn"
        >
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </Pressable>
        {/* 长按标题 = 隐藏 debug 开关：切换自动清理阈值（7天 ↔ 30分钟）用于演示 */}
        <Pressable
          onLongPress={() => {
            const next = !debugFastCleanup;
            setDebugFastCleanup(next);
            showToast(next ? t("演示模式：30分钟自动清理已完成") : t("已恢复：7天自动清理"));
          }}
          delayLongPress={600}
          testID="tasks-title"
        >
          <Text style={styles.h1}>{t("我的任务")}</Text>
        </Pressable>
      </View>

      {/* filter 横向滚动条 */}
      <View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <Pressable
            onPress={() => setFilters([])}
            style={[styles.filterChip, filters.length === 0 && styles.filterChipActive]}
            testID="tasks-filter-all"
          >
            <Text
              style={[styles.filterText, filters.length === 0 && styles.filterTextActive]}
            >
              {t("全部")}
            </Text>
          </Pressable>
          {FILTER_TYPES.map((k) => {
            const active = filters.includes(k);
            return (
              <Pressable
                key={k}
                onPress={() => toggleFilter(k)}
                style={[styles.filterChip, active && styles.filterChipActive]}
                testID={`tasks-filter-${k}`}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {t(TASK_TYPES[k].label)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* 日期行 */}
      <View style={styles.dateRow}>
        <Text style={styles.dateBig}>{formatSlashDate(today)}</Text>
        <View>
          <Text style={styles.dateSmall}>{t("今日")}</Text>
          <Text style={styles.dateSmall} testID="tasks-pending-count">
            {t("您有{count}项任务待办", { count: pendingTotal })}
          </Text>
        </View>
      </View>

      <FlatList
        data={pending}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48, paddingTop: 4 }}
        ListEmptyComponent={
          loaded ? (
            <View style={styles.empty}>
              <Image
                source={require("../../assets/images/nuri-logo.png")}
                style={{ width: 36, height: 36 }}
                resizeMode="contain"
              />
              <Text style={styles.emptyTitle}>{t("没有待办任务")}</Text>
              <Text style={styles.emptySub}>{t("先去和AI聊一聊，TA会帮你生成清单")}</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            archiving={archivingId === item.id}
            onPressBody={() => router.push(`/task/${item.id}` as any)}
            onCheckin={() => checkin(item)}
            onBackfill={() => backfill(item)}
            onDelete={() => setConfirm({ kind: "delete", task: item })}
          />
        )}
        ListFooterComponent={renderCompletedSection()}
      />
      {/* 记录任务感想 bottom sheet：与页面共用同一个手机画板。 */}
      <CheckinSheet
        visible={!!sheetFor}
        taskType={sheetFor?.task_type || "interaction"}
        onDone={onSheetDone}
      />
      </View>

      <ConfirmDialog
        visible={!!confirm}
        title={confirm?.kind === "delete" ? t("删除这个任务？") : t("清空已完成任务？")}
        message={
          confirm?.kind === "delete" ? t("删除后无法恢复") : t("已收藏的任务不会被清除")
        }
        confirmText={confirm?.kind === "delete" ? t("删除") : t("清空")}
        danger
        onConfirm={onConfirm}
        onCancel={() => setConfirm(null)}
      />

      <Toast message={toastMsg} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#FBF9FC" },
  phoneCanvas: { flex: 1, alignSelf: "center", overflow: "hidden" },
  backgroundImage: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%", opacity: 1 },
  haloBlue: { position: "absolute", width: 396, height: 396, borderRadius: 198, backgroundColor: "rgba(123,166,255,0.82)", left: -188, top: 142 },
  haloRed: { position: "absolute", width: 384, height: 384, borderRadius: 192, backgroundColor: "rgba(255,118,139,0.74)", right: -204, bottom: -58 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  h1: { fontSize: 24, fontWeight: "900", color: "#3A2F5A" },
  filterRow: { paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.2)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.6)",
  },
  filterChipActive: { backgroundColor: "#3A2F5A" },
  filterText: { fontSize: 14, fontWeight: "900", color: "#3A2F5A" },
  filterTextActive: { color: "#fff", fontWeight: "900" },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  dateBig: { fontSize: 24, fontWeight: "900", color: "#3A2F5A" },
  dateSmall: { fontSize: 12, color: "#3A2F5A", lineHeight: 14 },
  empty: { alignItems: "center", paddingTop: 64 },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: c.text, marginTop: 12 },
  emptySub: { fontSize: 13, color: c.textSecondary, marginTop: 6 },
  doneHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    marginTop: 4,
    marginBottom: 8,
  },
  doneHeaderText: { fontSize: 16, fontWeight: "900", color: "#3A2F5A" },
  clearBtn: { alignItems: "center", paddingVertical: 14, marginTop: 4 },
  clearText: {
    color: "#3A2F5A",
    fontSize: 16,
    textDecorationLine: "underline",
  },
});
