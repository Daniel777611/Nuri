import { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Image,
  Dimensions,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";

import { api } from "@/src/api";
import { taskTypeMeta } from "@/src/taskMeta";
import Toast from "@/src/components/Toast";

// 主页配色（复刻高保真设计稿）
const C = {
  bg: "#EEF0F8",
  text: "#1A1A2E",
  sub: "#5A5A7A",
  cardFrom: "#4B6FE8",
  cardTo: "#7B5CE7",
  taskBg: "#DCE8F8",
  nuriFrom: "#F5A855",
  nuriTo: "#F07A9A",
  btn: "#2D2080",
  taskPreview: "#3A3A5A",
  streak: "#5A7AC8",
};

const SCREEN_W = Dimensions.get("window").width;
const PAGE_W = Math.min(SCREEN_W, 430);
const CAROUSEL_W = PAGE_W - 32;

// 内容推荐轮播 mock（浏览详情跳外部链接）
const CAROUSEL = [
  {
    id: "c1",
    source: "来自Amber的育儿播客分享",
    title: "如何培养孩子的\n情绪管理能力？",
    sub: "探索属于你的家庭策略",
    url: "https://www.youtube.com",
  },
  {
    id: "c2",
    source: "来自丁香妈妈的科普文章",
    title: "18个月宝宝挑食怎么办？\n专家这样说",
    sub: "食物新恐惧期的应对指南",
    url: "https://www.dxy.cn",
  },
  {
    id: "c3",
    source: "来自北美儿科医生播客",
    title: "睡眠训练到底\n有没有用？",
    sub: "聊聊哭声免疫法的争议",
    url: "https://www.youtube.com",
  },
];

// 坚持打卡天数（mock 默认 17）
const STREAK_DAYS = 17;

// 任务预览默认 mock（任务数据为空时展示）
const DEFAULT_TASKS = ["自我：今天给自己留30分钟独处", "亲子：每日户外活动20分钟"];

// 待开发占位 bottom sheet（统一规范）
function DevSheet({
  visible,
  emoji,
  name,
  onClose,
}: {
  visible: boolean;
  emoji: string;
  name: string;
  onClose: () => void;
}) {
  if (!visible) return null;
  return (
    <View style={styles.sheetRoot}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.sheet} testID="dev-sheet">
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetEmoji}>{emoji}</Text>
        <Text style={styles.sheetTitle}>{name}即将上线，敬请期待</Text>
        <Pressable onPress={onClose} style={styles.sheetBtn} testID="dev-sheet-close">
          <Text style={styles.sheetBtnText}>我知道了</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function Home() {
  const router = useRouter();
  const [nickname, setNickname] = useState("Momo妈妈");
  const [pendingTasks, setPendingTasks] = useState<string[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [page, setPage] = useState(0);
  const [devSheet, setDevSheet] = useState<{ emoji: string; name: string } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (m: string) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2000);
  };

  useFocusEffect(
    useCallback(() => {
      api
        .me()
        .then((me: any) => me?.nickname && setNickname(me.nickname))
        .catch(() => {});
      api
        .listTasks()
        .then((ts: any[]) => {
          const pending = ts.filter((t) => !t.completed_at);
          setPendingCount(pending.length);
          setPendingTasks(
            pending.slice(0, 2).map((t) => `${taskTypeMeta(t.task_type).prefix}：${t.title}`)
          );
        })
        .catch(() => {});
    }, [])
  );

  const previewTasks = pendingTasks.length ? pendingTasks : DEFAULT_TASKS;
  const previewCount = pendingTasks.length ? pendingCount : 3;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {/* 顶部栏：logo + 欢迎语 + 头像 */}
        <View style={styles.topBar}>
          <Image
            source={require("../../assets/images/nuri-logo.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.welcome} numberOfLines={1}>
            欢迎，{nickname}！
          </Text>
          <Pressable
            onPress={() => router.push("/(tabs)/profile")}
            testID="home-avatar"
            hitSlop={6}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{nickname.slice(0, 1)}</Text>
            </View>
          </Pressable>
        </View>

        {/* 内容推荐轮播 */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={CAROUSEL_W + 12}
          decelerationRate="fast"
          contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}
          onScroll={(e) =>
            setPage(Math.round(e.nativeEvent.contentOffset.x / (CAROUSEL_W + 12)))
          }
          scrollEventThrottle={16}
        >
          {CAROUSEL.map((c) => (
            <LinearGradient
              key={c.id}
              colors={[C.cardFrom, C.cardTo]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.heroCard}
            >
              {/* 装饰性 3D 图形占位 */}
              <View style={styles.decoBig} />
              <View style={styles.decoSmall} />
              <Text style={styles.heroTitle}>{c.title}</Text>
              <Text style={styles.heroSub}>
                {c.source}，{c.sub}
              </Text>
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() => Linking.openURL(c.url)}
                style={styles.heroBtn}
                testID={`home-hero-cta-${c.id}`}
              >
                <Text style={styles.heroBtnText}>浏览详情</Text>
              </Pressable>
            </LinearGradient>
          ))}
        </ScrollView>
        {/* 分页指示器 */}
        <View style={styles.dots}>
          {CAROUSEL.map((_, i) => (
            <View key={i} style={[styles.dot, page === i && styles.dotActive]} />
          ))}
        </View>

        {/* 第一行：今日任务 + Nuri的家 */}
        <View style={styles.row}>
          <Pressable
            style={[styles.moduleCard, { backgroundColor: C.taskBg }]}
            onPress={() => router.push("/(tabs)/tasks")}
            testID="home-tasks-card"
          >
            <Text style={styles.moduleTitle}>今日任务</Text>
            <Text style={styles.moduleSub}>
              您已坚持打卡{STREAK_DAYS}天！加油！
            </Text>
            <View style={[styles.innerCard, { flex: 1 }]}>
              <Text style={styles.taskCount}>{previewCount} 件任务正在进行</Text>
              {previewTasks.map((t, i) => (
                <View key={i} style={styles.taskRow}>
                  <View style={styles.checkbox} />
                  <Text style={styles.taskName} numberOfLines={1}>
                    {t}
                  </Text>
                </View>
              ))}
              <Text style={styles.taskEllipsis}>……</Text>
              <View style={{ flex: 1, minHeight: 8 }} />
              <Pressable
                onPress={() => showToast("提醒功能即将上线")}
                style={styles.primaryBtn}
                testID="home-remind-btn"
              >
                <Text style={styles.primaryBtnText}>开启提醒</Text>
              </Pressable>
            </View>
          </Pressable>

          <Pressable
            style={styles.moduleCardNoBg}
            onPress={() => router.push("/(tabs)/chats")}
            testID="home-nuri-card"
          >
            <LinearGradient
              colors={[C.nuriFrom, C.nuriTo]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.nuriCard}
            >
              <Text style={styles.moduleTitle}>Nuri的家</Text>
              <Text style={styles.nuriMemo}>
                Hi！早上好，{nickname}，你还记得我们上次聊到了宝宝的睡眠策略吗？最新的进展如何？
              </Text>
              <View style={{ flex: 1 }} />
              <View style={styles.continueCard}>
                <View style={styles.continueRow}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name="chatbox-ellipses-outline" size={18} color={C.text} />
                    <Text style={styles.continueText}>继续对话</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={18} color={C.text} />
                </View>
              </View>
            </LinearGradient>
          </Pressable>
        </View>

        {/* 第二/三行：左列（知识图书馆 + 我的家）、右列（社区中心） */}
        <View style={styles.row}>
          <View style={{ flex: 1, gap: 12 }}>
            <Pressable
              style={[styles.moduleCard, styles.lightCard, { minHeight: 88 }]}
              onPress={() => setDevSheet({ emoji: "🌱", name: "知识图书馆" })}
              testID="home-library-card"
            >
              <Text style={styles.moduleTitle}>知识图书馆</Text>
            </Pressable>

            <Pressable
              style={[styles.moduleCard, styles.lightCard]}
              onPress={() => setDevSheet({ emoji: "🏡", name: "我的家" })}
              testID="home-myhome-card"
            >
              <Text style={styles.moduleTitle}>我的家</Text>
              <Text style={styles.moduleSub}>灵感：试着写下今天的心情。</Text>
              <View style={{ height: 12 }} />
              <Pressable
                onPress={() => setDevSheet({ emoji: "🏡", name: "我的家" })}
                style={styles.primaryBtn}
                testID="home-record-btn"
              >
                <Text style={styles.primaryBtnText}>记录当下</Text>
              </Pressable>
            </Pressable>
          </View>

          <Pressable
            style={[styles.moduleCard, { backgroundColor: C.taskBg, flex: 1 }]}
            onPress={() => setDevSheet({ emoji: "🌻", name: "社区中心" })}
            testID="home-community-card"
          >
            <Text style={styles.moduleTitle}>社区中心</Text>
            <Text style={styles.moduleSub}>您上次关于牙医的回答得到了17个人的赞！</Text>
            <View style={{ flex: 1 }} />
            <View style={styles.innerCard}>
              <Text style={styles.communityTopic}>
                “宝宝18个月饮食”的问题也许可以和他们交流
              </Text>
              <View style={styles.avatarRow}>
                {["#F5A855", "#7B8FE8", "#A87CC5"].map((color, i) => (
                  <View
                    key={i}
                    style={[
                      styles.miniAvatar,
                      { backgroundColor: color, marginLeft: i === 0 ? 0 : -10 },
                    ]}
                  />
                ))}
                <View style={styles.plusAvatar}>
                  <Ionicons name="add" size={18} color={C.btn} />
                </View>
              </View>
            </View>
          </Pressable>
        </View>
      </ScrollView>

      <DevSheet
        visible={!!devSheet}
        emoji={devSheet?.emoji || ""}
        name={devSheet?.name || ""}
        onClose={() => setDevSheet(null)}
      />
      <Toast message={toastMsg} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 10,
  },
  logo: { width: 30, height: 35 },
  welcome: { flex: 1, fontSize: 20, fontWeight: "700", color: C.text },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#7B5CE7",
    borderWidth: 2,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  heroCard: {
    width: CAROUSEL_W,
    minHeight: 172,
    borderRadius: 20,
    padding: 18,
    overflow: "hidden",
  },
  decoBig: {
    position: "absolute",
    right: -30,
    top: -14,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  decoSmall: {
    position: "absolute",
    right: 42,
    top: 84,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  heroTitle: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 27,
    marginTop: 2,
  },
  heroSub: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 6,
    maxWidth: "88%",
  },
  heroBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginTop: 12,
  },
  heroBtnText: { color: C.text, fontSize: 12, fontWeight: "700" },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginTop: 8,
    marginBottom: 2,
  },
  dot: {
    width: 18,
    height: 4,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: "#C6C9D8",
    backgroundColor: "transparent",
  },
  dotActive: { backgroundColor: "#3A3A5A", borderColor: "#3A3A5A" },
  row: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 12,
    marginTop: 12,
  },
  moduleCard: { flex: 1, borderRadius: 20, padding: 14 },
  moduleCardNoBg: { flex: 1 },
  lightCard: { backgroundColor: "#FFFFFF" },
  nuriCard: { flex: 1, borderRadius: 20, padding: 14 },
  moduleTitle: { fontSize: 14, fontWeight: "700", color: C.text },
  moduleSub: { fontSize: 10, color: C.sub, marginTop: 5, lineHeight: 15 },
  innerCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
  },
  taskCount: { fontSize: 11, fontWeight: "700", color: C.text },
  taskRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 7 },
  checkbox: {
    width: 11,
    height: 11,
    borderRadius: 3,
    borderWidth: 1.2,
    borderColor: "#9AA2B8",
  },
  taskName: { flex: 1, fontSize: 10, color: C.taskPreview, lineHeight: 14 },
  taskEllipsis: { fontSize: 10, color: C.taskPreview, marginTop: 3, marginLeft: 17 },
  primaryBtn: {
    backgroundColor: C.btn,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: "center",
    alignSelf: "flex-start",
  },
  primaryBtnText: { color: "#FFFFFF", fontSize: 11, fontWeight: "600" },
  nuriMemo: { fontSize: 10, color: "#3A2A3E", lineHeight: 15, marginTop: 7 },
  continueCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 12,
    marginTop: 10,
  },
  continueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  continueText: { fontSize: 12, fontWeight: "700", color: C.text },
  communityTopic: { fontSize: 10, color: C.taskPreview, lineHeight: 15 },
  avatarRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  miniAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  plusAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.2,
    borderColor: C.btn,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
    backgroundColor: "#FFFFFF",
  },
  sheetRoot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.32)",
    justifyContent: "flex-end",
    zIndex: 50,
  },
  sheet: {
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 32,
    alignItems: "center",
    gap: 10,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    backgroundColor: "#E0E0E8",
    borderRadius: 2,
    marginBottom: 4,
  },
  sheetEmoji: { fontSize: 36 },
  sheetTitle: { fontSize: 16, fontWeight: "700", color: C.text },
  sheetBtn: {
    marginTop: 10,
    backgroundColor: C.btn,
    borderRadius: 10,
    paddingVertical: 12,
    alignSelf: "stretch",
    alignItems: "center",
  },
  sheetBtnText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
});
