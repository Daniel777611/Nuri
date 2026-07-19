import { useCallback, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { api } from "@/src/api";
import { TaskItem, taskColors as c, taskTypeMeta, formatSlashDate, progressRatio, toTaskItem } from "@/src/taskMeta";
import CheckinSheet from "@/src/components/CheckinSheet";
import Toast from "@/src/components/Toast";

const blurredTaskBackground = require("@/assets/images/tasks-blurred-background.png");

export default function TaskDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const [task, setTask] = useState<TaskItem | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    api.listTasks().then((all: any[]) => {
      const raw = all.find((item) => item.id === id);
      setTask(raw ? toTaskItem(raw) : null);
    }).catch(() => {});
  }, [id]));

  if (!task) return <SafeAreaView style={styles.safe}><View style={styles.loading}><Text style={styles.muted}>加载中...</Text></View></SafeAreaView>;

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
    if (rating) { api.updateTask(task.id, { mood: rating }); setToastMsg("已记录你的感受 ✓"); setTimeout(() => setToastMsg(null), 2000); }
    if (task.completed_at) setTimeout(() => router.back(), rating ? 900 : 400);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
        <Image source={blurredTaskBackground} style={styles.backgroundImage} resizeMode="cover" />
        <View pointerEvents="none" style={styles.haloBlue} />
        <View pointerEvents="none" style={styles.haloRed} />
        <BlurView pointerEvents="none" intensity={100} tint="light" style={StyleSheet.absoluteFill} />
        <View style={styles.topBar}>
          <Pressable onPress={() => router.replace("/tasks")} style={styles.backRow} testID="task-detail-back"><Ionicons name="chevron-back" size={26} color="#3A2F5A" /><Text style={styles.topTitle}>任务卡</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <View style={styles.card}>
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={2}>{task.title}</Text>
              <View style={styles.typePill}><Text style={styles.typeText}>{meta.label}</Text></View>
            </View>
            <View style={styles.infoRow}>
              <Info label="开始日期" value={formatSlashDate(task.created_at)} />
              <View style={styles.divider} />
              <Info label="结束日期" value={formatSlashDate(task.due_date)} />
              <View style={styles.divider} />
              <Info label="任务频率" value={task.is_recurring ? task.frequency_label || "重复性" : "一次性"} compact />
            </View>
            <Text style={styles.sectionTitle}>当前进度</Text>
            <View style={styles.progressTrack}><LinearGradient colors={["#422D7E", "#7751E4"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.progressFill, { width: `${ratio * 100}%` }]} /></View>
            <Text style={styles.progressNumber}>{completed && !task.is_recurring ? "1/1" : `${task.completed_count}/${task.total_count}`}</Text>
            {task.description ? <><Text style={styles.sectionTitle}>任务介绍</Text><Text style={styles.description}>{task.description}</Text></> : null}
            {task.steps?.length ? <><Text style={styles.sectionTitle}>指引</Text><View style={styles.steps}>{task.steps.map((step, index) => <Text key={step} style={styles.stepText}>{index + 1}. {step}</Text>)}</View></> : null}
            <Pressable onPress={() => { setToastMsg("图片已保存到相册"); setTimeout(() => setToastMsg(null), 2000); }} style={styles.download} testID="task-detail-export"><Ionicons name="download-outline" size={28} color="#3A2F5A" /></Pressable>
          </View>
        </ScrollView>
        <View style={styles.footer}>
          <Pressable onPress={checkin} disabled={completed} style={[styles.checkinBtn, completed && styles.checkinDone]} testID="task-detail-checkin"><Ionicons name="checkmark-circle-outline" size={25} color="#3A2F5A" /><Text style={styles.checkinText}>{completed ? "已完成" : "打卡完成"}</Text></Pressable>
        </View>
        <CheckinSheet visible={sheetOpen} taskType={task.task_type} onDone={onSheetDone} />
      </View>
      <Toast message={toastMsg} />
    </SafeAreaView>
  );
}

function Info({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) { return <View style={styles.infoCol}><Text style={styles.infoLabel}>{label}</Text><Text style={[styles.infoValue, compact && styles.infoValueCompact]}>{value}</Text></View>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#FCFAFC" }, phoneCanvas: { flex: 1, alignSelf: "center", overflow: "hidden" }, backgroundImage: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" }, haloBlue: { position: "absolute", width: 396, height: 396, borderRadius: 198, backgroundColor: "rgba(123,166,255,0.82)", left: -188, top: 142 }, haloRed: { position: "absolute", width: 384, height: 384, borderRadius: 192, backgroundColor: "rgba(255,118,139,0.74)", right: -204, bottom: -58 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" }, muted: { color: c.textSecondary },
  topBar: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 }, backRow: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 34 }, topTitle: { color: "#3A2F5A", fontSize: 24, fontWeight: "900" },
  scroll: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 114 },
  card: { minHeight: 551, backgroundColor: "rgba(255,255,255,0.68)", borderRadius: 24, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 18, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 15, elevation: 4 },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }, title: { flex: 1, color: "#3A2F5A", fontSize: 24, lineHeight: 29, fontWeight: "900" }, typePill: { backgroundColor: "#3A2F5A", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 }, typeText: { color: "#fff", fontSize: 11, fontWeight: "900" },
  infoRow: { flexDirection: "row", alignItems: "center", marginTop: 24, paddingRight: 8 }, infoCol: { flex: 1, minWidth: 0 }, infoLabel: { color: "#3A2F5A", fontSize: 12 }, infoValue: { color: "#3A2F5A", fontSize: 24, lineHeight: 28, fontWeight: "900" }, infoValueCompact: { fontSize: 12, lineHeight: 18, marginTop: 4, fontWeight: "900" }, divider: { width: 1, height: 38, backgroundColor: "rgba(58,47,90,0.45)", marginHorizontal: 12 },
  sectionTitle: { color: "#3A2F5A", fontSize: 16, fontWeight: "900", marginTop: 24 }, progressTrack: { height: 30, backgroundColor: "rgba(204,204,204,0.46)", borderRadius: 8, overflow: "hidden", marginTop: 12 }, progressFill: { height: 30, borderRadius: 2 }, progressNumber: { color: "#3A2F5A", fontSize: 16, fontWeight: "900", textAlign: "right", marginTop: -26, paddingRight: 8, height: 26 },
  description: { color: "#3A2F5A", fontSize: 16, lineHeight: 21, marginTop: 10 }, steps: { marginTop: 10, gap: 2 }, stepText: { color: "#3A2F5A", fontSize: 16, lineHeight: 20 }, download: { alignSelf: "center", marginTop: 18, padding: 6 },
  footer: { height: 102, alignItems: "center", justifyContent: "center" }, checkinBtn: { width: 245, height: 64, borderRadius: 33, backgroundColor: "#fff", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, shadowColor: "#000", shadowOffset: { width: 3, height: 3 }, shadowOpacity: 0.08, shadowRadius: 10, elevation: 4 }, checkinDone: { opacity: 0.56 }, checkinText: { color: "#3A2F5A", fontSize: 24, fontWeight: "900" },
});
