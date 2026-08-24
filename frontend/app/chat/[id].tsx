import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import * as WebBrowser from "expo-web-browser";
import * as ImagePicker from "expo-image-picker";
import Toast from "@/src/components/Toast";
import { ApiError, api, isStreamUnsupported } from "@/src/api";
import { buildChatMessagePayload } from "@/src/chatClientContext";
import {
  ChatImageInputError,
  pickWebChatImageFile,
  prepareChatImage,
  type PreparedChatImage,
} from "@/src/chatImageInput";
import { taskTypeMeta } from "@/src/taskMeta";
import { colors, radius, spacing, type } from "@/src/theme";
import { useT } from "@/src/i18n";

const blurredTaskBackground = require("@/assets/images/tasks-blurred-background.png");
const taskApprovalId = (messageId: string, index: number) => `${messageId}-${index}`;
const taskSourceKey = (messageId: string, index: number) => `NURI 对话:${messageId}:${index}`;

// 对话背景渐变（复刻高保真设计稿的粉紫渐变）
const GRADIENT = ["#C5C8F0", "#F5E6F0"] as const;

// ── Types & mock data ────────────────────────────────────────────────────────
type Msg = {
  id: string;
  role: "ai" | "user";
  text: string;
  created_at?: string;
  image_base64?: string | null;
  quick_replies?: string[];
  transition?: any;
  sources?: Source[];
};

type MemoryContextItem = {
  category?: string;
  key?: string;
  text: string;
  updated_at?: string;
};

type MemoryContextTransition = {
  kind: "memory_context";
  items?: MemoryContextItem[];
  notice?: string;
};

// Built server-side from the search results the backend fetched, indexed by the
// citation numbers the model emitted — the model never writes a URL, so a link
// here can't be invented.
type Source = {
  n: number;
  title: string;
  url: string;
  site_name: string;
  lang: "en" | "zh";
  tier: "authority" | "good" | "neutral";
};

// ── Sub-component: inline markup ────────────────────────────────────────────
// The model writes two things a plain <Text> renders as literal characters:
// **bold** headings, which is how alternative approaches get their titles, and
// [1] citation markers. Both are handled in one pass so a heading containing a
// citation doesn't need either rule to know about the other.
//
// Segments are nested <Text>, not <Pressable> or <View>: anything else breaks
// wrapping mid-paragraph.
const MARKUP_RE = /(\*\*[^*\n]+\*\*)|(\[\d{1,2}\])/g;

function RichText({ text, sources }: { text: string; sources: Source[] }) {
  const byIndex = new Map(sources.map((s) => [s.n, s]));
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  MARKUP_RE.lastIndex = 0;
  while ((match = MARKUP_RE.exec(text)) !== null) {
    const token = match[0];
    const isBold = token.startsWith("**");
    // A citation number with no matching source stays literal: the model
    // occasionally writes [1] as list punctuation, and a dead tap target
    // would be worse than leaving it alone.
    const source = isBold ? undefined : byIndex.get(Number(token.slice(1, -1)));
    if (!isBold && !source) continue;

    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(
      isBold ? (
        <Text key={`b${match.index}`} style={styles.bold}>
          {token.slice(2, -2)}
        </Text>
      ) : (
        <Text
          key={`c${match.index}`}
          style={styles.citationMark}
          onPress={() => WebBrowser.openBrowserAsync(source!.url).catch(() => {})}
        >
          {` ${source!.n} `}
        </Text>
      ),
    );
    cursor = match.index + token.length;
  }
  if (!parts.length) return <>{text}</>;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

// ── Sub-component: cited sources ────────────────────────────────────────────
// Numbered to match the [1] [2] markers in the reply. Authority sources are
// marked because the institution is the trust signal — "AAP" tells a parent
// something that "healthychildren.org" does not.
function SourceChips({ sources }: { sources: Source[] }) {
  const { t } = useT();
  return (
    <View style={styles.sources}>
      <Text style={styles.sourcesLabel}>{t("参考来源")}</Text>
      <View style={styles.sourceRow}>
        {sources.map((s) => (
          <Pressable
            key={`${s.n}-${s.url}`}
            onPress={() => WebBrowser.openBrowserAsync(s.url).catch(() => {})}
            style={[styles.sourceChip, s.tier === "authority" && styles.sourceChipAuthority]}
            testID={`source-${s.n}`}
          >
            <Text style={styles.sourceIndex}>{s.n}</Text>
            <Text style={styles.sourceName} numberOfLines={1}>
              {s.site_name}
            </Text>
            {s.lang === "en" ? <Text style={styles.sourceLang}>EN</Text> : null}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

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

// Restored memories are context supplied to a new conversation, not messages
// that either the parent or NURI previously sent. Keep them visually separate
// from the chat transcript and show only the backend-authored display text;
// category/key are internal provenance used solely for stable React keys.
function MemoryContextCard({ transition }: { transition: MemoryContextTransition }) {
  const { t } = useT();
  const items: MemoryContextItem[] = Array.isArray(transition?.items)
    ? transition.items.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const candidate = item as Partial<MemoryContextItem>;
        const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
        return text
          ? [{
              text,
              category: typeof candidate.category === "string" ? candidate.category : undefined,
              key: typeof candidate.key === "string" ? candidate.key : undefined,
              updated_at:
                typeof candidate.updated_at === "string" ? candidate.updated_at : undefined,
            }]
          : [];
      })
    : [];
  const notice =
    typeof transition?.notice === "string" && transition.notice.trim()
      ? transition.notice.trim()
      : t("这些内容来自已恢复的家庭记忆，不是聊天记录。");

  return (
    <View style={styles.memoryContextCard} testID="chat-memory-context">
      <View style={styles.memoryContextHeader}>
        <View style={styles.memoryContextIcon}>
          <Ionicons name="albums-outline" size={18} color={colors.brand} />
        </View>
        <Text style={styles.memoryContextTitle}>{t("已恢复的家庭记忆")}</Text>
      </View>
      <Text style={styles.memoryContextNotice}>{notice}</Text>
      {items.length ? (
        <View style={styles.memoryContextItems}>
          {items.map((item, index) => (
            <View
              key={`${item.category || "memory"}:${item.key || index}`}
              style={styles.memoryContextItem}
              testID={`chat-memory-context-item-${index}`}
            >
              <View style={styles.memoryContextBullet} />
              <Text style={styles.memoryContextText}>{item.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────
export default function ChatDetail() {
  const { t, locale } = useT();
  const router = useRouter();
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const { id } = useLocalSearchParams<{ id: string }>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [historyLoadState, setHistoryLoadState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState<PreparedChatImage | null>(null);
  const [imageMenuVisible, setImageMenuVisible] = useState(false);
  const [processingImage, setProcessingImage] = useState(false);
  const pendingNativePickerRef = useRef<"camera" | "library" | null>(null);
  const nativePickerFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sending, setSending] = useState(false);
  // Mirrors `sending` for the re-entrancy check: state updates are async, so
  // rapid taps would otherwise all read the stale `false`.
  const sendingRef = useRef(false);
  // A timeout can hide a request that is still finishing on the server. Keep
  // the exact idempotency key with the failed draft so pressing Send again on
  // unchanged content replays that turn instead of starting a second one.
  const failedSendRef = useRef<{
    text: string;
    imageBase64: string | null;
    payload: ReturnType<typeof buildChatMessagePayload>;
  } | null>(null);
  // A parent may tap Back while the SSE turn is still being persisted.  Keep
  // that intent and navigate only after the server returns the durable turn;
  // otherwise the home feed can race the chat insert and rank stale context.
  const pendingHomeReturnRef = useRef(false);
  const completedTurnNonceRef = useRef<string | null>(null);
  const [typing, setTyping] = useState(false);
  // Reply text accumulated from the SSE stream, rendered as a live bubble until
  // the persisted message arrives and replaces it.
  const [streamingText, setStreamingText] = useState("");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [approvedTaskIds, setApprovedTaskIds] = useState<string[]>([]);
  const addingTaskIdsRef = useRef(new Set<string>());
  const scrollRef = useRef<ScrollView>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setHistoryLoadState("loading");
    try {
      const [msgs, tasks] = await Promise.all([
        api.getMessages(id),
        api.listTasks().catch(() => []),
      ]);
      setMessages(msgs);
      const savedSources = new Set(tasks.map((task: any) => task.source));
      setApprovedTaskIds(
        msgs.flatMap((msg: Msg) => {
          const suggested = msg.transition?.kind === "task_suggestion"
            ? (msg.transition.tasks || (msg.transition.task ? [msg.transition.task] : []))
            : [];
          return suggested.flatMap((_: any, index: number) =>
            savedSources.has(taskSourceKey(msg.id, index))
              ? [taskApprovalId(msg.id, index)]
              : []
          );
        })
      );
      setHistoryLoadState("ready");
    } catch (error) {
      // Old clients could keep a deleted session URL in navigation history.
      // A 404 is safe to heal because the authenticated, idempotent endpoint
      // returns only this account's current canonical conversation.
      if (error instanceof ApiError && error.status === 404) {
        try {
          const session = await api.getOrStartMainSession();
          if (session?.id && session.id !== id) {
            router.replace(`/chat/${session.id}`);
            return;
          }
        } catch {
          // Fall through to an explicit retry state; never render fake history.
        }
      }
      setHistoryLoadState("error");
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages, typing, streamingText]);

  const returnHome = () => {
    const feedRefresh = completedTurnNonceRef.current;
    router.dismissTo(
      feedRefresh
        ? {
            pathname: "/(tabs)",
            params: { feed_refresh: feedRefresh },
          }
        : "/(tabs)",
    );
  };

  const requestHomeReturn = () => {
    if (sendingRef.current) {
      if (!pendingHomeReturnRef.current) {
        pendingHomeReturnRef.current = true;
        showToast(t("正在保存这轮对话，完成后会自动返回首页"));
      }
      return;
    }
    returnHome();
  };

  const send = async (textOverride?: string, imageBase64?: string | null) => {
    if (!id || sendingRef.current) return;
    const text = (textOverride ?? input).trim();
    const selectedImage = imageBase64
      ? { previewUri: imageBase64, dataUri: imageBase64, width: 0, height: 0 }
      : pendingImage;
    const normalizedImage = selectedImage?.dataUri || null;
    if (!text && !normalizedImage) return;
    setInput("");
    setPendingImage(null);
    sendingRef.current = true;
    setSending(true);

    const optimistic: Msg = {
      id: `tmp-${Date.now()}`,
      role: "user",
      text: text || "[图片]",
      created_at: new Date().toISOString(),
      image_base64: normalizedImage,
    };
    setMessages((p) => [...p, optimistic]);

    setTyping(true);
    const failedSend = failedSendRef.current;
    const payload = failedSend
      && failedSend.text === text
      && failedSend.imageBase64 === normalizedImage
      ? failedSend.payload
      : buildChatMessagePayload(text, normalizedImage, locale);
    if (payload !== failedSend?.payload) failedSendRef.current = null;
    try {
      let res;
      try {
        res = await api.streamMessage(id, payload, (chunk) => {
          // First token replaces the typing dots with the live bubble.
          setTyping(false);
          setStreamingText((prev) => prev + chunk);
        });
      } catch (err) {
        if (!isStreamUnsupported(err)) throw err;
        // The stream never started, so nothing was persisted — the plain
        // endpoint can serve this turn instead.
        setTyping(true);
        res = await api.sendMessage(id, payload);
      }
      setMessages((p) => [
        ...p.filter((m) => m.id !== optimistic.id),
        res.user_message,
        ...res.ai_messages,
      ]);
      failedSendRef.current = null;
      completedTurnNonceRef.current = String(
        res.user_message?.id || res.user_message?.created_at || Date.now(),
      );
      if (pendingHomeReturnRef.current) {
        pendingHomeReturnRef.current = false;
        returnHome();
      }
    } catch {
      // Mid-stream failures may have already persisted the user message, so
      // preserve both the draft and its stable key. An unchanged retry then
      // asks the backend to replay the same durable turn rather than generating
      // a second response while the first request may still be running.
      failedSendRef.current = { text, imageBase64: normalizedImage, payload };
      if (text) setInput(text);
      if (selectedImage) setPendingImage(selectedImage);
      setMessages((p) => p.filter((m) => m.id !== optimistic.id));
      pendingHomeReturnRef.current = false;
      showToast(t("发送失败，请重试"));
      await load().catch(() => {});
    } finally {
      setStreamingText("");
      setTyping(false);
      setSending(false);
      sendingRef.current = false;
    }
  };

  const showToast = (message: string) => {
    setToastMsg(message);
    setTimeout(() => setToastMsg(null), 1800);
  };

  const explainImageError = (error: unknown) => {
    if (error instanceof ChatImageInputError && error.code === "too_large") {
      showToast(t("图片太大，请选择另一张图片"));
      return;
    }
    if (error instanceof ChatImageInputError && error.code === "unsupported") {
      showToast(t("暂时只支持图片格式"));
      return;
    }
    showToast(t("图片处理失败，请重试"));
  };

  const acceptPickerResult = async (result: ImagePicker.ImagePickerResult) => {
    if (result.canceled || !result.assets?.length) return;
    setProcessingImage(true);
    try {
      const asset = result.assets[0];
      const prepared = await prepareChatImage(asset);
      setPendingImage(prepared);
    } catch (error) {
      explainImageError(error);
    } finally {
      setProcessingImage(false);
    }
  };

  const openNativePicker = async (source: "camera" | "library") => {
    try {
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          showToast(t("需要相机权限才能拍照，请在系统设置中允许"));
          return;
        }
        await acceptPickerResult(await ImagePicker.launchCameraAsync({
          mediaTypes: ["images"],
          cameraType: ImagePicker.CameraType.back,
          allowsEditing: false,
          base64: false,
          exif: false,
          quality: 0.68,
        }));
        return;
      }

      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        showToast(t("需要相册权限才能选择图片，请在系统设置中允许"));
        return;
      }
      await acceptPickerResult(await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        allowsMultipleSelection: false,
        base64: false,
        exif: false,
        quality: 0.78,
      }));
    } catch {
      showToast(t(source === "camera" ? "无法打开相机，请重试" : "无法读取图片，请重试"));
    }
  };

  const flushNativePicker = () => {
    const source = pendingNativePickerRef.current;
    if (!source) return;
    pendingNativePickerRef.current = null;
    if (nativePickerFallbackTimerRef.current) {
      clearTimeout(nativePickerFallbackTimerRef.current);
      nativePickerFallbackTimerRef.current = null;
    }
    void openNativePicker(source);
  };

  const deferNativePickerUntilModalCloses = (source: "camera" | "library") => {
    pendingNativePickerRef.current = source;
    setImageMenuVisible(false);
    // onDismiss is reliable on iOS. Android does not consistently emit it for
    // every RN Modal implementation, so use a guarded fallback after the fade.
    if (Platform.OS === "android") {
      nativePickerFallbackTimerRef.current = setTimeout(flushNativePicker, 350);
    }
  };

  const openSafeWebPicker = async () => {
    try {
      // Do not force capture=environment or use Expo's eager Web metadata
      // decode. Safari owns the chooser transition and NURI validates the raw
      // file header before allocating any full-resolution image surface.
      const pendingAsset = pickWebChatImageFile();
      setImageMenuVisible(false);
      const asset = await pendingAsset;
      if (asset) await acceptPickerResult({ canceled: false, assets: [asset] });
    } catch (error) {
      explainImageError(error);
    }
  };

  const takePhoto = () => {
    if (Platform.OS === "web") {
      void openSafeWebPicker();
      return;
    }
    deferNativePickerUntilModalCloses("camera");
  };

  const choosePhoto = () => {
    if (Platform.OS === "web") {
      void openSafeWebPicker();
      return;
    }
    deferNativePickerUntilModalCloses("library");
  };

  useEffect(() => () => {
    if (nativePickerFallbackTimerRef.current) {
      clearTimeout(nativePickerFallbackTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    let active = true;
    void ImagePicker.getPendingResultAsync()
      .then((result) => {
        if (active && result && "canceled" in result) {
          void acceptPickerResult(result);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // Recovery is intentionally a one-time mount operation. The latest
    // acceptPickerResult implementation is sufficient for the recovered file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const addGeneratedTask = async (msg: Msg, task: any, index: number) => {
    const approvalId = taskApprovalId(msg.id, index);
    if (approvedTaskIds.includes(approvalId) || addingTaskIdsRef.current.has(approvalId)) return;
    addingTaskIdsRef.current.add(approvalId);
    try {
      await api.createTask({
        ...task,
        source_message_id: msg.id,
        suggestion_index: index,
      });
      setApprovedTaskIds((ids) => [...ids, approvalId]);
      showToast(t("已添加至“我的任务”"));
    } catch {
      showToast(t("任务添加失败，请重试"));
    } finally {
      addingTaskIdsRef.current.delete(approvalId);
    }
  };

  return (
    <LinearGradient
      colors={GRADIENT}
      start={{ x: 1, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={{ flex: 1 }}
    >
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={[styles.phoneCanvas, { width: phoneWidth }]}>
        <Image source={blurredTaskBackground} style={styles.backgroundImage} contentFit="cover" />
        <View pointerEvents="none" style={styles.haloBlue} />
        <View pointerEvents="none" style={styles.haloRed} />
        <BlurView pointerEvents="none" intensity={100} tint="light" style={StyleSheet.absoluteFill} />
        <Stack.Screen options={{ headerShown: false }} />

        <View style={styles.header}>
          <Pressable
            onPress={requestHomeReturn}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel={t("返回首页并更新推荐")}
            accessibilityState={{ busy: sending }}
            testID="chat-back-btn"
          >
            <Ionicons name="chevron-back" size={26} color="#3A2F5A" />
          </Pressable>
          <Text style={styles.headerName}>{t("我的对话")}</Text>
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
            {historyLoadState === "loading" ? (
              <View style={styles.historyStatus} testID="chat-history-loading">
                <ActivityIndicator color={colors.brand} />
                <Text style={styles.historyStatusText}>{t("正在加载对话…")}</Text>
              </View>
            ) : null}
            {historyLoadState === "error" ? (
              <Pressable
                onPress={() => void load()}
                style={styles.historyStatus}
                testID="chat-history-retry"
              >
                <Ionicons name="refresh" size={20} color={colors.brand} />
                <Text style={styles.historyStatusText}>
                  {t("对话未能打开，点此重试")}
                </Text>
              </Pressable>
            ) : null}
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                onAddTask={(task, index) => addGeneratedTask(m, task, index)}
                isTaskAdded={(index) => approvedTaskIds.includes(`${m.id}-${index}`)}
              />
            ))}
            {streamingText ? (
              <MessageBubble
                msg={{ id: "__streaming__", role: "ai", text: streamingText }}
                onAddTask={() => {}}
                isTaskAdded={() => false}
              />
            ) : null}
            {typing ? <TypingDots /> : null}
          </ScrollView>

          <View style={styles.composer} testID="chat-composer">
            {processingImage ? (
              <View style={styles.imageProcessing} testID="chat-image-processing">
                <ActivityIndicator size="small" color={colors.brand} />
                <Text style={styles.imageProcessingText}>{t("正在准备图片…")}</Text>
              </View>
            ) : null}
            {pendingImage ? (
              <View style={styles.imagePreview} testID="chat-image-preview">
                <Image
                  source={{ uri: pendingImage.previewUri }}
                  style={styles.imagePreviewThumb}
                  contentFit="cover"
                />
                <View style={styles.imagePreviewCopy}>
                  <Text style={styles.imagePreviewTitle}>{t("已添加图片")}</Text>
                  <Text style={styles.imagePreviewHint}>{t("可以补充文字，让 NURI 更准确地理解")}</Text>
                </View>
                <Pressable
                  onPress={() => setPendingImage(null)}
                  style={styles.imageRemove}
                  accessibilityRole="button"
                  accessibilityLabel={t("移除图片")}
                  testID="chat-image-remove"
                >
                  <Ionicons name="close" size={20} color="#3A2F5A" />
                </Pressable>
              </View>
            ) : null}
            <View style={styles.inputPill}>
              <Pressable
                onPress={() => setImageMenuVisible(true)}
                style={styles.iconBtn}
                disabled={sending || processingImage}
                accessibilityRole="button"
                accessibilityLabel={t("添加图片")}
                testID="chat-image-btn"
              >
                <Ionicons name="add" size={26} color="#3A2F5A" />
              </Pressable>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={t("说点什么...")}
                placeholderTextColor={colors.muted}
                style={styles.input}
                editable={historyLoadState === "ready" && !sending}
                multiline
                returnKeyType="send"
                blurOnSubmit={false}
                onSubmitEditing={() => {
                  if ((input.trim() || pendingImage) && !sending && !processingImage) void send();
                }}
                onKeyPress={(e: any) => {
                  if (e.nativeEvent?.key === "Enter" && !e.nativeEvent?.shiftKey) {
                    e.preventDefault?.();
                    if ((input.trim() || pendingImage) && !sending && !processingImage) void send();
                  }
                }}
                testID="chat-input"
              />
              <Pressable
                onPress={() => {
                  if (input.trim() || pendingImage) void send();
                  else showToast(t("语音输入功能即将上线"));
                }}
                disabled={sending || processingImage}
                style={[styles.micBtn, (input.trim() || pendingImage) && styles.sendBtn]}
                accessibilityRole="button"
                accessibilityLabel={(input.trim() || pendingImage) ? t("发送") : t("语音输入")}
                testID={(input.trim() || pendingImage) ? "chat-send-btn" : "chat-voice-btn"}
              >
                <Ionicons
                  name={(input.trim() || pendingImage) ? "send" : "mic-outline"}
                  size={21}
                  color={(input.trim() || pendingImage) ? "#fff" : "#3A2F5A"}
                />
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>

        <Modal
          visible={imageMenuVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setImageMenuVisible(false)}
          onDismiss={flushNativePicker}
        >
          <View style={styles.imageMenuOverlay}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => setImageMenuVisible(false)}
              accessibilityLabel={t("关闭图片菜单")}
            />
            <View style={[styles.imageMenu, { width: Math.min(phoneWidth - 32, 370) }]} accessibilityViewIsModal>
              <View style={styles.imageMenuHandle} />
              <Text style={styles.imageMenuTitle}>{t("添加图片")}</Text>
              <Text style={styles.imageMenuHint}>
                {Platform.OS === "web"
                  ? t("浏览器会打开设备支持的相机或图片文件选择器")
                  : t("选择一种添加方式")}
              </Text>
              <Text style={styles.imagePrivacyHint}>
                {t("你发送的图片会交给 NURI 的 AI 服务（OpenAI）分析，请不要上传不必要的隐私信息")}
              </Text>
              <Pressable
                onPress={() => void takePhoto()}
                style={styles.imageMenuAction}
                testID="chat-image-camera"
              >
                <View style={styles.imageMenuIcon}>
                  <Ionicons name="camera-outline" size={22} color={colors.brand} />
                </View>
                <Text style={styles.imageMenuActionText}>
                  {Platform.OS === "web" ? t("拍照或选择图片") : t("拍照")}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={colors.muted} />
              </Pressable>
              {Platform.OS !== "web" ? <Pressable
                onPress={() => void choosePhoto()}
                style={styles.imageMenuAction}
                testID="chat-image-library"
              >
                <View style={styles.imageMenuIcon}>
                  <Ionicons name="images-outline" size={22} color={colors.brand} />
                </View>
                <Text style={styles.imageMenuActionText}>
                  {t("从相册选择")}
                </Text>
                <Ionicons name="chevron-forward" size={18} color={colors.muted} />
              </Pressable> : null}
              <Pressable
                onPress={() => setImageMenuVisible(false)}
                style={styles.imageMenuCancel}
                testID="chat-image-cancel"
              >
                <Text style={styles.imageMenuCancelText}>{t("取消")}</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
        <Toast message={toastMsg} />
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

// ── Sub-component: message bubble (text, image, transitions) ────────────────
function MessageBubble({
  msg,
  onAddTask,
  isTaskAdded,
}: {
  msg: Msg;
  onAddTask: (task: any, index: number) => void;
  isTaskAdded: (index: number) => boolean;
}) {
  const { t } = useT();
  const isAI = msg.role === "ai";

  if (msg.transition?.kind === "memory_context") {
    return <MemoryContextCard transition={msg.transition as MemoryContextTransition} />;
  }

  // A parent opened a feed card. There is only ever one conversation, so this
  // marks where the subject changed instead of the card getting a chat of its
  // own. It carries no text — it is a separator, not something anyone said —
  // and without this branch it would render as an empty bubble.
  if (msg.transition?.kind === "card_opened") {
    return (
      <View style={styles.cardDivider} testID="chat-card-divider">
        <View style={styles.cardDividerLine} />
        <View style={styles.cardDividerLabel}>
          <Ionicons name="bookmark-outline" size={13} color={colors.brand} />
          <Text style={styles.cardDividerText} numberOfLines={1}>
            {msg.transition.title || t("学习胶囊")}
          </Text>
        </View>
        <View style={styles.cardDividerLine} />
      </View>
    );
  }

  if (msg.transition?.kind === "task_suggestion") {
    const suggestedTasks = msg.transition.tasks || (msg.transition.task ? [msg.transition.task] : []);
    return (
      <View style={[styles.row, { justifyContent: "flex-start" }]}>
        <View style={styles.transitionCard} testID="chat-transition-tasks">
          <Text style={styles.transitionPrompt}>{msg.text}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={276} decelerationRate="fast" contentContainerStyle={styles.taskCarousel}>
            {suggestedTasks.map((task: any, taskIndex: number) => {
              const added = isTaskAdded(taskIndex);
              const taskType = taskTypeMeta(task.task_type);
              return <View key={`${msg.id}-${taskIndex}`} style={styles.generatedSlide}>
                <LinearGradient colors={["#A6AEFF", "#FFD092"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.generatedCard}>
                  <Text style={styles.generatedType}>{taskType.prefix}：{task.title}</Text>
                  <View style={styles.generatedInner}>
                    <Text style={styles.generatedSection}>{t("任务介绍")}</Text>
                    <Text style={styles.generatedBody}>{task.description}</Text>
                    <Text style={styles.generatedSection}>{t("频率：")}</Text>
                    <Text style={styles.generatedBody}>{task.scope === "week" ? t("本周持续") : t("今天一次")}</Text>
                    <Text style={styles.generatedSection}>{t("做法：")}</Text>
                    {task.steps.map((step: string, index: number) => <Text key={step} style={styles.generatedBody}>{index + 1}. {step}</Text>)}
                    <Pressable onPress={() => onAddTask(task, taskIndex)} disabled={added} style={[styles.addTaskBtn, added && styles.addTaskDone]} testID={`chat-add-task-${taskIndex}`}>
                      <Text style={styles.addTaskText}>{added ? t("已添加至任务") : t("添加计划")}</Text>
                    </Pressable>
                  </View>
                </LinearGradient>
                {added ? <Text style={styles.addedHint}>{t("成功添加至“我的任务”")}</Text> : null}
              </View>;
            })}
          </ScrollView>
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
              <Text style={styles.hospitalName}>{"Stanford Children's ER"}</Text>
              <Text style={styles.hospitalMeta}>2.4 mi · 24h · (650) 555-0911</Text>
            </View>
          </View>
          <View style={styles.hospitalRow}>
            <Ionicons name="call-outline" size={16} color={colors.brand} />
            <View style={{ flex: 1 }}>
              <Text style={styles.hospitalName}>Nurse Hotline</Text>
              <Text style={styles.hospitalMeta}>{t("免费 · 24h · (800) 555-0144")}</Text>
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
            {isAI ? (
              <RichText text={msg.text} sources={msg.sources ?? []} />
            ) : (
              msg.text
            )}
          </Text>
        ) : null}
        {isAI && msg.sources?.length ? <SourceChips sources={msg.sources} /> : null}
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
  safe: { flex: 1, backgroundColor: "transparent" },
  phoneCanvas: { flex: 1, alignSelf: "center", overflow: "hidden" },
  backgroundImage: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  haloBlue: { position: "absolute", width: 396, height: 396, borderRadius: 198, backgroundColor: "rgba(123,166,255,0.82)", left: -188, top: 142 },
  haloRed: { position: "absolute", width: 384, height: 384, borderRadius: 192, backgroundColor: "rgba(255,118,139,0.74)", right: -204, bottom: -58 },

  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 14, gap: 4,
  },
  backBtn: {
    width: 28, height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerName: {
    fontSize: 24, fontWeight: "900", color: "#3A2F5A",
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

  scroll: { paddingHorizontal: 18, paddingVertical: 16, paddingBottom: 18, gap: 12 },
  historyStatus: {
    alignSelf: "center",
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    marginVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: "rgba(255,255,255,0.86)",
  },
  historyStatusText: { color: colors.onSurface, fontSize: type.sm, fontWeight: "600" },
  row: { flexDirection: "row", marginBottom: spacing.sm, alignItems: "flex-end" },
  avatarSlot: { width: 38, marginRight: 6, alignItems: "center" },

  bubble: {
    maxWidth: "88%", paddingVertical: 14, paddingHorizontal: 18, borderRadius: 25,
  },
  bubbleAI: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 25,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  bubbleUser: {
    borderTopRightRadius: 25,
    backgroundColor: "#5D86E8",
  },
  senderLabel: { display: "none" },
  bubbleText: { color: "#241C3F", fontSize: 16, lineHeight: 21 },
  bubbleImage: {
    width: 160,
    height: 120,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
  },

  bold: { fontWeight: "700" },
  // Sits inline in a sentence, so it has to read as a marker rather than as a
  // word: small, tinted, and padded enough to be tappable without pushing the
  // surrounding line height around.
  citationMark: {
    color: colors.brand,
    fontSize: 11,
    fontWeight: "700",
    backgroundColor: "#EFEBFD",
  },
  sources: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: "rgba(58,47,90,0.10)",
  },
  sourcesLabel: { fontSize: 11, color: colors.muted, marginBottom: 6 },
  sourceRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  sourceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    maxWidth: "100%",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: "#FFFFFF",
    borderColor: colors.border,
    borderWidth: 1,
  },
  // Institutional sources are visually distinct: for a parenting question the
  // publisher is most of the signal.
  sourceChipAuthority: { borderColor: colors.brand, backgroundColor: "#F4F1FE" },
  sourceIndex: { fontSize: 10, fontWeight: "700", color: colors.brand },
  sourceName: { fontSize: 11, color: colors.onSurface, flexShrink: 1 },
  sourceLang: { fontSize: 9, color: colors.muted, fontWeight: "700" },

  typingBubble: { paddingVertical: spacing.md },
  dotsRow: { flexDirection: "row", gap: 5, alignItems: "center", height: 16 },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.brand,
    opacity: 0.85,
  },

  cardDivider: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  cardDividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  cardDividerLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    maxWidth: "62%",
  },
  cardDividerText: {
    fontSize: type.sm,
    color: colors.onSurfaceTertiary,
    fontWeight: "600",
    flexShrink: 1,
  },
  memoryContextCard: {
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "rgba(100, 76, 195, 0.24)",
    backgroundColor: "rgba(250, 248, 255, 0.94)",
    gap: spacing.sm,
    shadowColor: colors.brand,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  memoryContextHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  memoryContextIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#EEE9FF",
  },
  memoryContextTitle: {
    flex: 1,
    color: "#3A2F5A",
    fontSize: type.base,
    fontWeight: "800",
  },
  memoryContextNotice: {
    color: colors.onSurfaceTertiary,
    fontSize: type.sm,
    lineHeight: 19,
  },
  memoryContextItems: {
    gap: spacing.sm,
    paddingTop: 2,
  },
  memoryContextItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: "rgba(238, 233, 255, 0.72)",
  },
  memoryContextBullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 7,
    backgroundColor: colors.brand,
  },
  memoryContextText: {
    flex: 1,
    color: colors.onSurface,
    fontSize: type.sm,
    lineHeight: 20,
  },
  transitionCard: {
    flex: 1, gap: 12,
  },
  transitionPrompt: { backgroundColor: "#fff", borderRadius: 24, padding: 16, color: "#241C3F", fontSize: 16, lineHeight: 21, shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 5, elevation: 2 },
  taskCarousel: { gap: 10, paddingRight: 18 }, generatedSlide: { width: 266 }, generatedCard: { borderRadius: 28, padding: 6 },
  generatedType: { color: "#3A2F5A", fontSize: 16, fontWeight: "900", paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  generatedInner: { backgroundColor: "#fff", borderRadius: 20, padding: 12 },
  generatedSection: { color: "#3A2F5A", fontSize: 14, fontWeight: "900", marginTop: 2 },
  generatedBody: { color: "#3A2F5A", fontSize: 12, lineHeight: 17 },
  addTaskBtn: { alignSelf: "flex-start", backgroundColor: "#3A2F5A", borderRadius: 10, marginTop: 8, paddingHorizontal: 14, paddingVertical: 8 },
  addTaskDone: { opacity: 0.5 }, addTaskText: { color: "#fff", fontSize: 12, fontWeight: "900" }, addedHint: { color: "#3A2F5A", fontSize: 12, textAlign: "center" },
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
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  imageProcessing: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: "rgba(255,255,255,0.94)",
  },
  imageProcessingText: {
    color: colors.onSurfaceTertiary,
    fontSize: type.sm,
    fontWeight: "600",
  },
  imagePreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.sm,
    paddingRight: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "rgba(100,76,195,0.22)",
    backgroundColor: "rgba(255,255,255,0.96)",
    shadowColor: "#3A2F5A",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  imagePreviewThumb: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceTertiary,
  },
  imagePreviewCopy: { flex: 1, gap: 3 },
  imagePreviewTitle: { color: colors.onSurface, fontSize: type.sm, fontWeight: "800" },
  imagePreviewHint: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  imageRemove: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F0ECFA",
  },
  inputPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#3A2F5A",
    paddingLeft: 6,
    paddingRight: 6,
    gap: spacing.sm,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 110,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
    fontSize: type.base,
    color: colors.onSurface,
  },
  micBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtn: { backgroundColor: colors.brand },
  imageMenuOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: Platform.OS === "ios" ? 24 : 16,
    backgroundColor: "rgba(25,18,48,0.34)",
  },
  imageMenu: {
    padding: spacing.md,
    paddingTop: spacing.sm,
    borderRadius: 24,
    backgroundColor: "#FFFDFC",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  imageMenuHandle: {
    alignSelf: "center",
    width: 42,
    height: 4,
    borderRadius: 2,
    marginBottom: spacing.md,
    backgroundColor: "#D7D0E5",
  },
  imageMenuTitle: { color: colors.onSurface, fontSize: type.lg, fontWeight: "900" },
  imageMenuHint: {
    color: colors.muted,
    fontSize: type.sm,
    lineHeight: 19,
    marginTop: 4,
    marginBottom: spacing.sm,
  },
  imagePrivacyHint: {
    color: colors.onSurfaceTertiary,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: "#F5F1FD",
  },
  imageMenuAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 58,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  imageMenuIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F0ECFA",
  },
  imageMenuActionText: {
    flex: 1,
    color: colors.onSurface,
    fontSize: type.base,
    fontWeight: "700",
  },
  imageMenuCancel: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: "#F3F0F7",
  },
  imageMenuCancelText: { color: colors.onSurface, fontSize: type.base, fontWeight: "700" },
});
