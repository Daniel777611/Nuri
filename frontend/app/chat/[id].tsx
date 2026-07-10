import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";

import { api } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";

// ── Types & mock data ────────────────────────────────────────────────────────
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

// ── Sub-component: avatar ────────────────────────────────────────────────────
function NuriAvatar({ size = 34 }: { size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.brand,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        shadowColor: colors.brand,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 3,
      }}
    >
      <Text
        style={{
          color: "#fff",
          fontSize: size * 0.42,
          fontWeight: "800",
          letterSpacing: -0.5,
        }}
      >
        N
      </Text>
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────
export default function ChatDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const msgs = await api.getMessages(id);
    setMessages(msgs);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-delete session if user leaves without sending any message
  useEffect(() => {
    return () => {
      setMessages((current) => {
        const hasUserMsg = current.some((m) => m.role === "user");
        if (!hasUserMsg && id) {
          api.deleteSession(id).catch(() => {});
        }
        return current;
      });
    };
  }, [id]);

  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages, typing]);

  const send = async (textOverride?: string, imageBase64?: string | null) => {
    if (!id) return;
    const text = (textOverride ?? input).trim();
    if (!text && !imageBase64) return;
    setInput("");
    setSending(true);

    const optimistic: Msg = {
      id: `tmp-${Date.now()}`,
      role: "user",
      text: text || "[图片]",
      image_base64: imageBase64 || null,
    };
    setMessages((p) => [...p, optimistic]);

    setTyping(true);
    try {
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

  const sendImage = () => send("（上传了一张照片）", MOCK_IMAGE_BASE64);
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
        <View style={styles.headerCenter}>
          <NuriAvatar size={36} />
          <View style={{ marginLeft: spacing.sm }}>
            <Text style={styles.headerName}>NURI</Text>
            <View style={styles.onlineRow}>
              <View style={styles.onlineDot} />
              <Text style={styles.headerSub}>育儿助手 · 在线</Text>
            </View>
          </View>
        </View>
        <View style={{ width: 36 }} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
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
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={() => { if (input.trim() && !sending) send(); }}
            onKeyPress={(e: any) => {
              if (e.nativeEvent?.key === "Enter" && !e.nativeEvent?.shiftKey) {
                e.preventDefault?.();
                if (input.trim() && !sending) send();
              }
            }}
            testID="chat-input"
          />
          <Pressable
            onPress={() => send()}
            disabled={sending || !input.trim()}
            style={[styles.sendBtn, (!input.trim() || sending) && styles.sendBtnDisabled]}
            testID="chat-send-btn"
          >
            <Ionicons name="arrow-up" size={18} color="#fff" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Sub-component: message bubble (text, image, quick replies, transitions) ──
function MessageBubble({
  msg,
  onQuick,
  onTasks,
}: {
  msg: Msg;
  onQuick: (q: string) => void;
  onTasks: () => void;
}) {
  const isAI = msg.role === "ai";

  if (msg.transition?.kind === "tasks_generated") {
    return (
      <View style={[styles.row, { justifyContent: "flex-start" }]}>
        <View style={styles.avatarSlot}>
          <NuriAvatar size={30} />
        </View>
        <View style={styles.transitionCard} testID="chat-transition-tasks">
          <View style={styles.transitionTop}>
            <Ionicons name="checkmark-circle" size={18} color={colors.success} />
            <Text style={styles.transitionTitle}>
              已为你生成 {msg.transition.count} 个任务
            </Text>
          </View>
          <Text style={styles.transitionSub}>
            涵盖今日小动作和本周追踪，NURI 会持续帮你检查进度。
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
        <View style={styles.avatarSlot}>
          <NuriAvatar size={30} />
        </View>
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
      {isAI && (
        <View style={styles.avatarSlot}>
          <NuriAvatar size={30} />
        </View>
      )}
      <View
        style={[styles.bubble, isAI ? styles.bubbleAI : styles.bubbleUser]}
        testID={`bubble-${msg.role}`}
      >
        {isAI && <Text style={styles.senderLabel}>NURI</Text>}
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
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ── Sub-component: animated "typing…" indicator ─────────────────────────────
function TypingDots() {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const bounce = (dot: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, {
            toValue: -5,
            duration: 280,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0,
            duration: 280,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.delay(Math.max(0, 400 - delay)),
        ])
      );

    const a1 = bounce(dot1, 0);
    const a2 = bounce(dot2, 130);
    const a3 = bounce(dot3, 260);
    a1.start();
    a2.start();
    a3.start();
    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [dot1, dot2, dot3]);

  return (
    <View style={[styles.row, { justifyContent: "flex-start" }]}>
      <View style={styles.avatarSlot}>
        <NuriAvatar size={30} />
      </View>
      <View style={[styles.bubble, styles.bubbleAI, styles.typingBubble]}>
        <Text style={styles.senderLabel}>NURI</Text>
        <View style={styles.dotsRow}>
          {[dot1, dot2, dot3].map((dot, i) => (
            <Animated.View
              key={i}
              style={[styles.dot, { transform: [{ translateY: dot }] }]}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
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
  headerCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 36,
  },
  headerName: {
    fontSize: type.lg,
    fontWeight: "700",
    color: colors.onSurface,
    letterSpacing: 0.3,
  },
  onlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 1,
  },
  onlineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  headerSub: { fontSize: type.sm, color: colors.muted },

  scroll: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  row: { flexDirection: "row", marginBottom: spacing.sm, alignItems: "flex-end" },
  avatarSlot: { width: 38, marginRight: 6, alignItems: "center" },

  bubble: {
    maxWidth: "78%",
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
  },
  bubbleAI: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  bubbleUser: {
    backgroundColor: colors.brand,
    borderTopRightRadius: 4,
  },
  senderLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.brand,
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  bubbleText: { color: colors.onSurface, fontSize: type.lg, lineHeight: 23 },
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
    backgroundColor: colors.surfaceTertiary,
    borderColor: colors.border,
    borderWidth: 1,
  },
  qrText: { color: colors.onSurface, fontSize: type.sm, fontWeight: "600" },

  typingBubble: { paddingVertical: spacing.md },
  dotsRow: { flexDirection: "row", gap: 5, alignItems: "center", height: 16 },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.brand,
    opacity: 0.85,
  },

  transitionCard: {
    flex: 1,
    backgroundColor: "#fff",
    borderColor: colors.brand,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    shadowColor: colors.brand,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 3,
  },
  transitionTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
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
    flex: 1,
    backgroundColor: "#fff",
    borderColor: colors.error,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
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
  sendBtnDisabled: { opacity: 0.45 },
});
