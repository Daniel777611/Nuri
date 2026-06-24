import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";

import { api } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

// 1x1 transparent pixel placeholder + a tiny mocked "thermometer" data URL
// We use a small base64 image so payloads stay small and don't break upload paths.
const MOCK_IMAGE_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQUlEQVR42u3OMQEAAAQDMKr6V2N4DYBz1xCWxKsQKAQKgUKgECgECoFCoBAoBAqBQqAQKAQKgUKgECgECsHRBVbsAAGoVgrhAAAAAElFTkSuQmCC";

type Msg = {
  id: string;
  role: "ai" | "user";
  text: string;
  image_base64?: string | null;
  quick_replies?: string[];
  transition?: any;
};

export default function ChatDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [title, setTitle] = useState("和育儿助手聊天");
  const scrollRef = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const msgs = await api.getMessages(id);
    setMessages(msgs);
    const sessions = await api.listSessions();
    const cur = sessions.find((s: any) => s.id === id);
    if (cur) setTitle(cur.title);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages, typing]);

  const send = async (textOverride?: string, imageBase64?: string | null) => {
    if (!id) return;
    const text = (textOverride ?? input).trim();
    if (!text && !imageBase64) return;
    setInput("");
    setSending(true);

    // Optimistic user bubble
    const optimistic: Msg = {
      id: `tmp-${Date.now()}`,
      role: "user",
      text: text || "[图片]",
      image_base64: imageBase64 || null,
    };
    setMessages((p) => [...p, optimistic]);

    setTyping(true);
    try {
      // 1s simulated thinking delay
      await new Promise((r) => setTimeout(r, 900));
      const res = await api.sendMessage(id, {
        text,
        image_base64: imageBase64 || null,
      });
      setMessages((p) => [
        ...p.filter((m) => m.id !== optimistic.id),
        res.user_message,
        ...res.ai_messages,
      ]);
    } finally {
      setTyping(false);
      setSending(false);
    }
  };

  const sendImage = () => {
    // Prototype: simulate a photo upload from camera
    send("（上传了一张照片）", MOCK_IMAGE_BASE64);
  };

  const goTasks = () => router.push("/(tabs)/tasks");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backBtn}
          testID="chat-back-btn"
        >
          <Ionicons name="chevron-back" size={20} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={{ width: 36 }} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
        style={{ flex: 1 }}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          testID="chat-scroll"
        >
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              onQuick={(q) => send(q)}
              onTasks={goTasks}
              onCommunity={() => router.push("/community")}
            />
          ))}
          {typing ? <TypingDots /> : null}
        </ScrollView>

        <View style={styles.composer} testID="chat-composer">
          <Pressable
            onPress={sendImage}
            style={styles.iconBtn}
            disabled={sending}
            testID="chat-image-btn"
          >
            <Ionicons name="camera-outline" size={22} color={colors.brand} />
          </Pressable>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="说点什么..."
            placeholderTextColor={colors.muted}
            style={styles.input}
            multiline
            testID="chat-input"
          />
          <Pressable
            onPress={() => send()}
            disabled={sending || (!input.trim() && !sending)}
            style={[
              styles.sendBtn,
              (!input.trim() || sending) && { opacity: 0.5 },
            ]}
            testID="chat-send-btn"
          >
            <Ionicons name="arrow-up" size={18} color="#fff" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageBubble({
  msg,
  onQuick,
  onTasks,
  onCommunity,
}: {
  msg: Msg;
  onQuick: (q: string) => void;
  onTasks: () => void;
  onCommunity: () => void;
}) {
  const isAI = msg.role === "ai";

  if (msg.transition?.kind === "tasks_generated") {
    return (
      <View style={[styles.row, { justifyContent: "flex-start" }]}>
        <View style={styles.transitionCard} testID="chat-transition-tasks">
          <View style={styles.transitionTop}>
            <Ionicons
              name="checkmark-circle"
              size={18}
              color={colors.success}
            />
            <Text style={styles.transitionTitle}>
              已为你生成 {msg.transition.count} 个任务
            </Text>
          </View>
          <Text style={styles.transitionSub}>
            涵盖今日小动作和本周追踪，AI会持续帮你检查进度。
          </Text>
          <Pressable
            onPress={onTasks}
            style={styles.transitionBtn}
            testID="chat-go-tasks"
          >
            <Text style={styles.transitionBtnText}>查看任务清单</Text>
            <Ionicons name="arrow-forward" size={14} color="#fff" />
          </Pressable>
        </View>
      </View>
    );
  }

  if (msg.transition?.kind === "hospital_card") {
    return (
      <View style={[styles.row, { justifyContent: "flex-start" }]}>
        <View style={styles.hospitalCard} testID="chat-hospital-card">
          <Text style={styles.hospitalText}>{msg.text}</Text>
          <View style={styles.hospitalDivider} />
          <View style={styles.hospitalRow}>
            <Ionicons name="medkit-outline" size={16} color={colors.error} />
            <View style={{ flex: 1 }}>
              <Text style={styles.hospitalName}>Stanford Children's ER</Text>
              <Text style={styles.hospitalMeta}>2.4 mi · 24h · (650) 555-0911</Text>
            </View>
          </View>
          <View style={styles.hospitalRow}>
            <Ionicons name="call-outline" size={16} color={colors.brand} />
            <View style={{ flex: 1 }}>
              <Text style={styles.hospitalName}>Nurse Hotline</Text>
              <Text style={styles.hospitalMeta}>免费 · 24h · (800) 555-0144</Text>
            </View>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.row,
        { justifyContent: isAI ? "flex-start" : "flex-end" },
      ]}
    >
      <View
        style={[
          styles.bubble,
          isAI ? styles.bubbleAI : styles.bubbleUser,
        ]}
        testID={`bubble-${msg.role}`}
      >
        {msg.image_base64 ? (
          <Image
            source={{ uri: msg.image_base64 }}
            style={styles.bubbleImage}
            contentFit="cover"
          />
        ) : null}
        {msg.text ? (
          <Text style={[styles.bubbleText, !isAI && { color: "#fff" }]}>
            {msg.text}
          </Text>
        ) : null}
        {isAI && msg.quick_replies && msg.quick_replies.length > 0 ? (
          <View style={styles.quickReplies}>
            {msg.quick_replies.map((q) => (
              <Pressable
                key={q}
                onPress={() => onQuick(q)}
                style={styles.qrBtn}
                testID={`quick-${q}`}
              >
                <Text style={styles.qrText}>{q}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={onCommunity}
              style={[styles.qrBtn, { backgroundColor: "#fff" }]}
              testID="chat-go-community"
            >
              <Ionicons name="people-outline" size={12} color={colors.muted} />
              <Text style={[styles.qrText, { color: colors.muted }]}>
                看看社群
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function TypingDots() {
  return (
    <View style={[styles.row, { justifyContent: "flex-start" }]}>
      <View style={[styles.bubble, styles.bubbleAI]}>
        <Text style={{ color: colors.muted, fontSize: type.lg, letterSpacing: 2 }}>
          ···
        </Text>
      </View>
    </View>
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
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flex: 1,
    fontSize: type.lg,
    fontWeight: "600",
    color: colors.onSurface,
    textAlign: "center",
  },
  scroll: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  row: { flexDirection: "row", marginBottom: spacing.sm },
  bubble: {
    maxWidth: "80%",
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
  },
  bubbleAI: {
    backgroundColor: colors.surfaceTertiary,
    borderTopLeftRadius: 4,
  },
  bubbleUser: {
    backgroundColor: colors.brand,
    borderTopRightRadius: 4,
  },
  bubbleText: { color: colors.onSurface, fontSize: type.lg, lineHeight: 22 },
  bubbleImage: {
    width: 160,
    height: 120,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
  },
  quickReplies: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: spacing.sm,
  },
  qrBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    borderWidth: 1,
  },
  qrText: { color: colors.onSurface, fontSize: type.sm, fontWeight: "600" },
  transitionCard: {
    backgroundColor: "#fff",
    borderColor: colors.brand,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    width: "85%",
  },
  transitionTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  transitionTitle: { fontSize: type.lg, fontWeight: "700", color: colors.onSurface },
  transitionSub: {
    fontSize: type.sm,
    color: colors.muted,
    marginTop: spacing.sm,
    lineHeight: 18,
  },
  transitionBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.brand,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.sm,
  },
  transitionBtnText: { color: "#fff", fontWeight: "700", fontSize: type.base },
  hospitalCard: {
    backgroundColor: "#fff",
    borderColor: colors.error,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    width: "92%",
    gap: spacing.sm,
  },
  hospitalText: { fontSize: type.base, color: colors.onSurface, lineHeight: 20 },
  hospitalDivider: {
    height: 1,
    backgroundColor: colors.divider,
    marginVertical: spacing.xs,
  },
  hospitalRow: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    paddingVertical: 4,
  },
  hospitalName: { fontSize: type.base, fontWeight: "600", color: colors.onSurface },
  hospitalMeta: { fontSize: type.sm, color: colors.muted, marginTop: 2 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: "#fff",
    borderTopColor: colors.divider,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 110,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.pill,
    fontSize: type.base,
    color: colors.onSurface,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
});
