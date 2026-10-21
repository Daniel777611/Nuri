import { NuriKeyboardFrame, GlassSurface, NuriText, NuriIcon, IconAction, NuriButton, MenuRow } from "@/src/uiux48/Primitives";
import { VoiceInputBar } from "@/src/uiux48/VoiceInputBar";
import { NuriComposer } from "@/src/uiux48/Composer";
import { NuriAvatar as SceneAvatar } from "@/src/uiux48/Scene";
import { useNuriTheme } from "@/src/uiux48/Theme";
import { readChatDraft, writeChatDraft } from "@/src/uiux48/chatDraft";
import { appStoreNavigationRoute } from "@/src/appStoreRelease";
import { auth } from "@/src/api";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCallback, useEffect, useRef } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  Keyboard,
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
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { useHeaderHeight } from "@react-navigation/elements";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import * as ImagePicker from "expo-image-picker";
import * as Clipboard from "expo-clipboard";
import { registerNativeNavigationGuard, type NativeNavigationAction } from "@/src/components/nativeNavigation";
import Toast from "@/src/components/Toast";
import { ApiError, api, isStreamUnsupported } from "@/src/api";
import { buildChatMessagePayload } from "@/src/chatClientContext";
import {
  ChatImageInputError,
  pickWebChatImageFile,
  prepareChatImage,
  type PreparedChatImage,
} from "@/src/chatImageInput";
import {
  MAX_VOICE_SECONDS,
  VoiceInputError,
  isVoiceInputSupported,
  startVoiceRecording,
  type VoiceRecording,
} from "@/src/chatVoiceInput";
import { colors, radius, spacing, type } from "@/src/theme";
import { useT, translate } from "@/src/i18n";
import { shortResourceSummary } from "@/src/resourceSummary";

const blurredTaskBackground = require("@/assets/images/tasks-blurred-background.png");

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
  feedback_rating?: "like" | "dislike" | null;
};

/** `transition.post` on a card marker written when a post notification is opened. */
type DailyPostOnMessage = {
  id: string;
  headline: string;
  takeaways?: string[];
  source_label?: string;
};
type DailyVideoOnMessage = { id: string; title: string; key_points?: string; summary?: string; thumbnail_url?: string; channel?: string };

async function copyChatText(text: string): Promise<void> {
  if (Platform.OS !== "web") {
    await Clipboard.setStringAsync(text);
    return;
  }
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await globalThis.navigator.clipboard.writeText(text);
      return;
    } catch {
      // The iOS shell's WKWebView exposes the API but can refuse the write;
      // the selection copy below still works there.
    }
  }
  const doc = globalThis.document;
  if (!doc) throw new Error("clipboard unavailable");
  const input = doc.createElement("textarea");
  input.value = text;
  // iOS only copies a selection it considers editable and on screen, and
  // zooms the page when a field under 16px takes focus.
  input.setAttribute("readonly", "");
  input.contentEditable = "true";
  input.style.position = "fixed";
  input.style.top = "0";
  input.style.left = "0";
  input.style.fontSize = "16px";
  input.style.opacity = "0";
  doc.body.appendChild(input);
  input.focus();
  input.select();
  input.setSelectionRange(0, text.length);
  const copied = doc.execCommand("copy");
  doc.body.removeChild(input);
  if (!copied) throw new Error("copy failed");
}

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

// ── Sub-component: inline markup ────────────────────────────────────────────
// The model writes **bold** headings, which a plain <Text> renders as literal
// asterisks. Citation markers used to be handled here too; nothing emits them
// any more, and the backend strips any that survive.
//
// Segments are nested <Text>, not <Pressable> or <View>: anything else breaks
// wrapping mid-paragraph.
const MARKUP_RE = /(\*\*[^*\n]+\*\*)/g;

function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  MARKUP_RE.lastIndex = 0;
  while ((match = MARKUP_RE.exec(text)) !== null) {
    const token = match[0];
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(
      <Text key={`b${match.index}`} style={styles.bold}>
        {token.slice(2, -2)}
      </Text>,
    );
    cursor = match.index + token.length;
  }
  if (!parts.length) return <>{text}</>;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
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
    <GlassSurface kind="message" contentStyle={{padding:16,gap:8}} style={{marginBottom:8}} testID="chat-memory-context">
      <View style={styles.memoryContextHeader}>
        <NuriText style={{fontSize:17,lineHeight:22,fontWeight:"500"}}>{t("已恢复的家庭记忆")}</NuriText>
      </View>
      <NuriText secondary style={{fontSize:12,lineHeight:16}}>{notice}</NuriText>
      {items.length ? (
        <View style={styles.memoryContextItems}>
          {items.map((item, index) => (
            <View
              key={`${item.category || "memory"}:${item.key || index}`}
              style={styles.memoryContextItem}
              testID={`chat-memory-context-item-${index}`}
            >
              <NuriText style={{flex:1,fontSize:17,lineHeight:26}}>{item.text}</NuriText>
            </View>
          ))}
        </View>
      ) : null}
    </GlassSurface>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────
export default function ChatDetail({ sessionId, embedded = false, initialDraft, initialAction, onExpand }: { sessionId?:string; embedded?:boolean; initialDraft?:string; initialAction?:"send"|"attach"|"mic"|"focus"; onExpand?:()=>void } = {}) {
  const { generation, capture, current } = useAccountScope();
  const { t, locale } = useT();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const [pageHeaderHeight, setPageHeaderHeight] = useState(0);
  const { width: viewportWidth } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const params = useLocalSearchParams<{ id: string }>();
  const id = sessionId ?? params.id;
  const safeInsets = useSafeAreaInsets();
  const composerRef = useRef<TextInput>(null);
  const launchAction = useRef(initialAction);
  const theme48 = useNuriTheme();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [historyLoadState, setHistoryLoadState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [input, setInput] = useState("");
  const initialDraftOwner=useRef(generation);
  const initialDraftUsed=useRef(false);
  const draftWriteScope=useRef<{id:string;generation:number}|null>(null);
  useEffect(() => {
    // Hydrate the bridge before the first write. Otherwise a fresh empty input
    // would erase the draft handed over by the still-mounted Home screen.
    if(draftWriteScope.current?.id!==id||draftWriteScope.current.generation!==generation){draftWriteScope.current={id,generation};return;}
    writeChatDraft(id, input, generation);
  }, [id, input, generation]);
  const [pendingImage, setPendingImage] = useState<PreparedChatImage | null>(null);
  const [imageMenuVisible, setImageMenuVisible] = useState(false);
  const [mediaError,setMediaError]=useState("");
  const [processingImage, setProcessingImage] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const voicePhaseRef = useRef<typeof voiceState>("idle");
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  // Whether this browser lets us read the mic level; without it the banner
  // falls back to the elapsed-time counter.
  const [voiceMetered, setVoiceMetered] = useState(false);
  const voiceRecordingRef = useRef<VoiceRecording | null>(null);
  const voiceActiveRef = useRef(true);
  const voiceStartVersionRef = useRef(0);
  const voiceStartInFlightRef = useRef(false);
  const readVoiceLevel = useCallback(() => voiceRecordingRef.current?.level() ?? null, []);
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingNativePickerRef = useRef<"camera" | "library" | null>(null);
  const nativePickerInFlightRef = useRef(false);
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
  // otherwise Home's NURI preview can read the conversation before it lands.
  const pendingHomeReturnRef = useRef(false);
  const pendingHeaderNavigationRef = useRef<NativeNavigationAction | null>(null);
  const [typing, setTyping] = useState(false);
  // Reply text accumulated from the SSE stream, rendered as a live bubble until
  // the persisted message arrives and replaces it.
  const [streamingText, setStreamingText] = useState("");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [feedbackSavingIds, setFeedbackSavingIds] = useState<Set<string>>(new Set());
  const feedbackSavingRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<ScrollView>(null);
  const showToast = useCallback((message: string) => {
    setToastMsg(message);
    setTimeout(() => setToastMsg(null), 1800);
  }, [setToastMsg]);

  const copyResponse = useCallback(async (message: Msg) => {
    if (capture() === null) return;
    try {
      await copyChatText(message.text);
      showToast(t("已复制回复"));
    } catch {
      showToast(t("复制失败，请重试"));
    }
  }, [showToast, t, capture]);

  const rateResponse = useCallback(async (message: Msg, rating: "like" | "dislike") => {
    const ticket = capture();
    if (ticket === null) return;
    if (!id || feedbackSavingRef.current.has(message.id) || message.feedback_rating === rating) return;
    const previous = message.feedback_rating ?? null;
    feedbackSavingRef.current.add(message.id);
    setFeedbackSavingIds((current) => new Set(current).add(message.id));
    setMessages((current) => current.map((item) =>
      item.id === message.id ? { ...item, feedback_rating: rating } : item));
    try {
      const saved = await api.setChatMessageFeedback(id, message.id, rating);
      if (!current(ticket)) return;
      setMessages((current) => current.map((item) =>
        item.id === message.id ? { ...item, feedback_rating: saved.rating } : item));
      showToast(t("已记录你的反馈"));
    } catch {
      if (!current(ticket)) return;
      setMessages((current) => current.map((item) =>
        item.id === message.id ? { ...item, feedback_rating: previous } : item));
      showToast(t("反馈保存失败，请重试"));
    } finally {
      setFeedbackSavingIds((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
      if (current(ticket)) feedbackSavingRef.current.delete(message.id);
    }
  }, [id, showToast, t, capture, current, setFeedbackSavingIds, setMessages]);

  const load = useCallback(async () => {
    const ticket = capture();
    if (ticket === null) return;
    if (!id) return;
    setHistoryLoadState("loading");
    try {
      const msgs = await api.getMessages(id);
      if (!current(ticket)) return;
      setMessages(msgs);
      setHistoryLoadState("ready");
    } catch (error) {
      if (!current(ticket)) return;
      // Old clients could keep a deleted session URL in navigation history.
      // A 404 is safe to heal because the authenticated, idempotent endpoint
      // returns only this account's current canonical conversation.
      if (error instanceof ApiError && error.status === 404) {
        try {
          const session = await api.getOrStartMainSession();
          if (!current(ticket)) return;
          if (session?.id && session.id !== id) {
            router.replace(`/chat/${session.id}`);
            return;
          }
        } catch {
          if (!current(ticket)) return;
          // Fall through to an explicit retry state; never render fake history.
        }
      }
      setHistoryLoadState("error");
    }
  }, [id, router, capture, current, setMessages, setHistoryLoadState]);

  useFocusEffect(useCallback(() => {
    void load();
    const draft=!initialDraftUsed.current&&initialDraftOwner.current===generation
      ? initialDraft??readChatDraft(id) : readChatDraft(id);
    initialDraftUsed.current=true;
    setInput(draft);
  }, [load,id,setInput,initialDraft,generation]));

  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages, typing, streamingText]);

  // Home's daily card is fixed for the day, so a finished turn no longer
  // needs to hand it a refresh nonce; the NURI preview re-reads on focus.
  const returnHome = useCallback(() => {
    if (capture() === null) return;
    router.dismissTo("/(tabs)");
  }, [router, capture]);

  const navigateFromChat = useCallback((action: NativeNavigationAction) => {
    if (capture() === null) return;
    // Back restores the actual source stack (video/post/saved/Home); Home is
    // a separate explicit Tab action. Do not discard the resource context.
    if (action === "back") {
      if (router.canGoBack()) router.back();
      else router.dismissTo("/(tabs)");
    } else if (action === "home") returnHome();
    else {
      const destination=appStoreNavigationRoute(action);
      if(destination)router.navigate(destination as never);
    }
  }, [router, capture, returnHome]);

  const requestHomeReturn = useCallback(() => {
    if (capture() === null) return;
    if(voiceRecordingRef.current){showToast(t("请先结束录音，再离开对话。"));return;}
    pendingHeaderNavigationRef.current = null;
    if (sendingRef.current) {
      if (!pendingHomeReturnRef.current) {
        pendingHomeReturnRef.current = true;
        showToast(t("正在保存这轮对话，完成后会自动返回首页"));
      }
      return;
    }
    returnHome();
  }, [returnHome, showToast, t, capture]);

  useFocusEffect(useCallback(() => registerNativeNavigationGuard(embedded?"/":`/chat/${id}`, (action) => {
    if (capture() === null) return;
    if (action === "home") { requestHomeReturn(); return; }
    if(voiceRecordingRef.current){showToast(locale==="en"?"Finish recording before leaving.":translate(locale, "请先结束录音，再离开对话。"));return;}
    if (sendingRef.current) {
      pendingHomeReturnRef.current = false;
      pendingHeaderNavigationRef.current = action;
      showToast(locale === "en" ? "Saving this reply before leaving…" : translate(locale, "正在保存这轮对话，完成后会离开…"));
    } else {
      navigateFromChat(action);
    }
  }), [id, embedded, locale, requestHomeReturn, navigateFromChat, showToast, capture]));

  const send = async (textOverride?: string, imageBase64?: string | null) => {
    const ticket = capture();
    if (ticket === null) return;
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
          if (!current(ticket)) return;
          // First token replaces the typing dots with the live bubble.
          setTyping(false);
          setStreamingText((prev) => prev + chunk);
        });
      } catch (err) {
        if (!current(ticket)) return;
        if (!isStreamUnsupported(err)) throw err;
        // The stream never started, so nothing was persisted — the plain
        // endpoint can serve this turn instead.
        setTyping(true);
        res = await api.sendMessage(id, payload);
      }
      if (!current(ticket)) return;
      setMessages((p) => [
        ...p.filter((m) => m.id !== optimistic.id),
        res.user_message,
        ...res.ai_messages,
      ]);
      failedSendRef.current = null;
      if (pendingHeaderNavigationRef.current) {
        const action=pendingHeaderNavigationRef.current;
        pendingHeaderNavigationRef.current = null;
        navigateFromChat(action);
      } else if (pendingHomeReturnRef.current) {
        pendingHomeReturnRef.current = false;
        returnHome();
      }
    } catch {
      if (!current(ticket)) return;
      // Mid-stream failures may have already persisted the user message, so
      // preserve both the draft and its stable key. An unchanged retry then
      // asks the backend to replay the same durable turn rather than generating
      // a second response while the first request may still be running.
      failedSendRef.current = { text, imageBase64: normalizedImage, payload };
      if (text) setInput(text);
      if (selectedImage) setPendingImage(selectedImage);
      setMessages((p) => p.filter((m) => m.id !== optimistic.id));
      pendingHomeReturnRef.current = false;
      pendingHeaderNavigationRef.current = null;
      showToast(t("发送失败，请重试"));
      await load().catch(() => {});
    } finally {
      if (current(ticket)) {
        setStreamingText("");
        setTyping(false);
        setSending(false);
        sendingRef.current = false;
      }
    }
  };

  const clearVoiceTimer = useCallback(() => {
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    sendingRef.current = false;
    failedSendRef.current = null;
    pendingHomeReturnRef.current = false;
    pendingHeaderNavigationRef.current = null;
    feedbackSavingRef.current.clear();
    pendingNativePickerRef.current = null;
    if (nativePickerFallbackTimerRef.current) clearTimeout(nativePickerFallbackTimerRef.current);
    voiceStartVersionRef.current++;
    clearVoiceTimer();
    voiceRecordingRef.current?.cancel();
    voiceRecordingRef.current = null;
    voicePhaseRef.current = "idle";
  }, [generation, clearVoiceTimer]);

  // Stack keeps covered screens mounted. Blur, background, and a late
  // permission result must all release the microphone and reset the controls.
  useFocusEffect(useCallback(() => {
    voiceActiveRef.current = true;
    return () => {
      voiceActiveRef.current = false;
      voiceStartVersionRef.current += 1;
      clearVoiceTimer();
      voiceRecordingRef.current?.cancel();
      voiceRecordingRef.current = null;
      voicePhaseRef.current = "idle";
      setVoiceState("idle");
      setVoiceSeconds(0);
      setImageMenuVisible(false);setMediaError("");
      pendingNativePickerRef.current = null;
    };
  }, [clearVoiceTimer, setVoiceState, setVoiceSeconds]));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      // iOS briefly becomes inactive while asking for microphone permission.
      // There is no recorder yet; the adapter checks foreground state before
      // recording. A real background transition or screen blur still cancels.
      if (state === "inactive" && voiceStartInFlightRef.current && !voiceRecordingRef.current) return;
      voiceStartVersionRef.current += 1;
      clearVoiceTimer();
      voiceRecordingRef.current?.cancel();
      voiceRecordingRef.current = null;
      voicePhaseRef.current = "idle";
      setVoiceState("idle");
      setVoiceSeconds(0);
    });
    return () => subscription.remove();
  }, [clearVoiceTimer, setVoiceState, setVoiceSeconds]);

  const explainVoiceError = (error: unknown) => {
    const code = error instanceof VoiceInputError ? error.code : "failed";
    setMediaError(code==="permission_denied"?(locale==="en"?"Microphone access was not granted. You can use text instead.":translate(locale, "麦克风权限未获允许，可以改用文字。")):locale==="en"?"Voice input was not confirmed. Please retry or use text.":translate(locale, "语音输入未确认成功，请重试或改用文字。"));
    if (code === "unsupported") showToast(t("当前浏览器不支持语音输入"));
    else if (code === "permission_denied") showToast(t("需要麦克风权限才能语音输入，请在系统设置中允许"));
    else if (code === "no_microphone") showToast(t("没有找到可用的麦克风"));
    else if (code === "too_short") showToast(t("说话时间太短"));
    else showToast(t("语音识别失败，请重试"));
  };

  const stopVoice = async (intent: "draft" | "send" = "draft") => {
    const ticket = capture();
    if (ticket === null) return;
    const recording = voiceRecordingRef.current;
    if (!recording) return;
    const version = voiceStartVersionRef.current;
    voiceRecordingRef.current = null;
    clearVoiceTimer();
    voicePhaseRef.current = "transcribing";
    setVoiceState("transcribing");
    try {
      const clip = await recording.stop();
      if (!current(ticket) || !voiceActiveRef.current || version !== voiceStartVersionRef.current) return;
      const { text } = await api.transcribeVoice(clip, locale);
      if (!current(ticket) || !voiceActiveRef.current || version !== voiceStartVersionRef.current) return;
      const spoken = (text || "").trim();
      if (!spoken) {
        setMediaError(locale==="en"?"No speech was recognized. Please retry.":translate(locale, "没有听清，请再说一次。"));
        showToast(t("没有听清，请再说一次"));
        return;
      }
      // Recording locks the editor; append to the exact draft that was visible
      // when Stop/Send was tapped. Never send from a React state updater.
      const draft = input.trim() ? `${input.trimEnd()} ${spoken}` : spoken;
      setInput(draft);
      setMediaError("");
      if (intent === "send") {
        voicePhaseRef.current = "idle";
        setVoiceState("idle");
        await send(draft);
      }
    } catch (error) {
      if (current(ticket) && voiceActiveRef.current && version === voiceStartVersionRef.current) explainVoiceError(error);
    } finally {
      if (current(ticket) && voiceActiveRef.current && version === voiceStartVersionRef.current) {
        voicePhaseRef.current = "idle";
        setVoiceState("idle");
        setVoiceSeconds(0);
      }
    }
  };

  const cancelVoice = () => {
    voiceStartVersionRef.current += 1;
    clearVoiceTimer();
    voiceRecordingRef.current?.cancel();
    voiceRecordingRef.current = null;
    voicePhaseRef.current = "idle";
    setVoiceState("idle");
    setVoiceSeconds(0);
  };

  const startVoice = async () => {
    const ticket = capture();
    if (ticket === null) return;
    if (voicePhaseRef.current !== "idle" || voiceStartInFlightRef.current || sendingRef.current || processingImage || nativePickerInFlightRef.current || historyLoadState !== "ready") return;
    if (!isVoiceInputSupported()) {
      setMediaError(locale==="en"?"Voice input is unavailable on this device. Use text instead.":translate(locale, "此设备暂不支持语音输入，可以改用文字。"));
      showToast(t(Platform.OS === "web" ? "当前浏览器不支持语音输入" : "语音输入功能即将上线"));
      return;
    }
    setMediaError("");
    Keyboard.dismiss();
    voicePhaseRef.current = "starting";
    setVoiceState("starting");
    voiceStartInFlightRef.current = true;
    const version = ++voiceStartVersionRef.current;
    try {
      const recording = await startVoiceRecording();
      if (!current(ticket) || !voiceActiveRef.current || version !== voiceStartVersionRef.current) {
        recording.cancel();
        return;
      }
      voiceRecordingRef.current = recording;
    } catch (error) {
      if (!current(ticket) || !voiceActiveRef.current || version !== voiceStartVersionRef.current) return;
      setVoiceState("idle");
      voicePhaseRef.current = "idle";
      explainVoiceError(error);
      return;
    } finally {
      voiceStartInFlightRef.current = false;
    }
    setVoiceSeconds(0);
    setVoiceMetered(voiceRecordingRef.current.level() !== null);
    setVoiceState("recording");
    voicePhaseRef.current = "recording";
    setMediaError("");
    const startedAt = Date.now();
    voiceTimerRef.current = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setVoiceSeconds(seconds);
      if (seconds >= MAX_VOICE_SECONDS) void stopVoice();
    }, 250);
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

  const acceptPickerResult = async (result: ImagePicker.ImagePickerResult, ticket = capture()) => {
    if (!current(ticket)) return;
    if (result.canceled || !result.assets?.length) return;
    setProcessingImage(true);
    try {
      const asset = result.assets[0];
      const prepared = await prepareChatImage(asset);
      if (!current(ticket)) return;
      setPendingImage(prepared);
      setMediaError("");
    } catch (error) {
      if (!current(ticket)) return;
      explainImageError(error);
    } finally {
      if (current(ticket)) setProcessingImage(false);
    }
  };

  const openNativePicker = async (source: "camera" | "library") => {
    const ticket = capture();
    if (ticket === null || !voiceActiveRef.current || nativePickerInFlightRef.current) return;
    nativePickerInFlightRef.current = true;
    try {
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!current(ticket)) return;
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
        }), ticket);
        return;
      }

      // iOS PHPicker grants access only to the selected image. Broad Photo
      // Library authorization is not needed for this system selection UI.
      await acceptPickerResult(await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        allowsMultipleSelection: false,
        base64: false,
        exif: false,
        quality: 0.78,
      }), ticket);
    } catch {
      if (!current(ticket)) return;
      showToast(t(source === "camera" ? "无法打开相机，请重试" : "无法读取图片，请重试"));
    } finally {
      nativePickerInFlightRef.current = false;
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
    if (capture() === null || pendingNativePickerRef.current || nativePickerInFlightRef.current) return;
    pendingNativePickerRef.current = source;
    setImageMenuVisible(false);
    // onDismiss is reliable on iOS. Android does not consistently emit it for
    // every RN Modal implementation, so use a guarded fallback after the fade.
    if (Platform.OS === "android") {
      nativePickerFallbackTimerRef.current = setTimeout(flushNativePicker, 350);
    }
  };

  const openSafeWebPicker = async () => {
    const ticket = capture();
    if (ticket === null) return;
    try {
      // Do not force capture=environment or use Expo's eager Web metadata
      // decode. Safari owns the chooser transition and NURI validates the raw
      // file header before allocating any full-resolution image surface.
      const pendingAsset = pickWebChatImageFile();
      setImageMenuVisible(false);
      const asset = await pendingAsset;
      if (asset && current(ticket)) await acceptPickerResult({ canceled: false, assets: [asset] }, ticket);
    } catch (error) {
      if (!current(ticket)) return;
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

  const openImageInput = () => {
    if (capture() === null || voicePhaseRef.current !== "idle" || sendingRef.current || processingImage || nativePickerInFlightRef.current || historyLoadState !== "ready") return;
    setMediaError("");
    if (Platform.OS === "web") {
      void openSafeWebPicker();
      return;
    }
    Keyboard.dismiss();
    setImageMenuVisible(true);
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
  useEffect(() => {
    if (historyLoadState !== "ready" || !launchAction.current) return;
    if(initialDraftOwner.current!==generation){launchAction.current=undefined;return;}
    const action = launchAction.current;
    launchAction.current = undefined;
    if (action === "send" && initialDraft?.trim()) void send(initialDraft);
    else if (action === "attach") openImageInput();
    else if (action === "mic") void startVoice();
    else composerRef.current?.focus();
  }, [historyLoadState, id]);
  const content = <View style={{flex:1,minHeight:0}}>
    {!embedded ? <Stack.Screen options={{ gestureEnabled: !sending }} /> : null}
    <ScrollView ref={scrollRef} style={{flex:1,minHeight:0}} contentContainerStyle={{paddingHorizontal:embedded?0:24,paddingTop:embedded?0:8,paddingBottom:16,gap:16}} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" onLayout={()=>scrollRef.current?.scrollToEnd({animated:false})} onContentSizeChange={()=>scrollRef.current?.scrollToEnd({animated:false})} testID="chat-scroll">
      {historyLoadState==="loading"?<View testID="chat-history-loading"><ActivityIndicator /><NuriText secondary>{t("正在加载对话…")}</NuriText></View>:null}
      {historyLoadState==="error"?<Pressable onPress={()=>void load()} style={{minHeight:44}} testID="chat-history-retry"><NuriText>{t("对话未能打开，点此重试")}</NuriText></Pressable>:null}
      {messages.map(m=><MessageBubble key={m.id} msg={m} actionsEnabled={!m.id.startsWith("tmp-")} feedbackSaving={feedbackSavingIds.has(m.id)} onCopy={copyResponse} onFeedback={rateResponse} />)}
      {streamingText?<MessageBubble msg={{id:"__streaming__",role:"ai",text:streamingText}} actionsEnabled={false} />:null}
      {typing?<TypingDots />:null}
    </ScrollView>
    <View style={{paddingHorizontal:embedded?0:24,paddingBottom:embedded?0:12}}>
      {processingImage?<View style={{padding:12}} testID="chat-image-processing"><ActivityIndicator /><NuriText secondary>{t("正在准备图片…")}</NuriText></View>:null}
      {pendingImage?<GlassSurface kind="composer" contentStyle={{padding:12,flexDirection:"row",alignItems:"center",gap:12}} testID="chat-image-preview"><Image source={{uri:pendingImage.previewUri}} style={{width:64,height:64,borderRadius:12}} contentFit="cover" /><NuriText style={{flex:1}}>{t("已添加图片")}</NuriText><IconAction name="close" label={t("移除图片")} onPress={()=>setPendingImage(null)} disabled={voiceState!=="idle"||sending} testID="chat-image-remove" /></GlassSurface>:null}
      {voiceState!=="idle"?<VoiceInputBar phase={voiceState} seconds={voiceSeconds} metered={voiceMetered} level={readVoiceLevel} onCancel={cancelVoice} onStop={()=>void stopVoice("draft")} onSend={()=>void stopVoice("send")} />:
        <NuriComposer value={input} onChangeText={setInput} inputRef={composerRef} onSend={()=>void send()} onAttach={openImageInput} onMic={()=>void startVoice()} busy={sending||processingImage} disabled={historyLoadState!=="ready"} hasAttachment={!!pendingImage} testID={embedded?"home-chat":"chat"} />}
      {mediaError?<View style={{flexDirection:"row",alignItems:"center",gap:8,paddingTop:8}} testID="chat-media-error"><NuriText accessibilityLiveRegion="assertive" style={{flex:1}}>{mediaError}</NuriText><IconAction name="close" label={t("关闭")} onPress={()=>setMediaError("")} /></View>:null}
    </View>
      <Modal visible={imageMenuVisible} transparent animationType="fade" onRequestClose={()=>setImageMenuVisible(false)} onDismiss={flushNativePicker}>
        <View style={{flex:1,justifyContent:"flex-end",paddingHorizontal:24,paddingBottom:Math.max(safeInsets.bottom,16),backgroundColor:"rgba(20,16,24,.28)"}} testID="chat-attachment-sheet">
          <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={t("取消")} onPress={()=>setImageMenuVisible(false)} />
          <GlassSurface contentStyle={{padding:24,gap:16}} testID="attachments-card">
            <NuriText role="H2">{locale==="en"?"Add photo":translate(locale,"添加照片")}</NuriText>
            <MenuRow label={locale==="en"?"Take a photo":translate(locale,"拍照")} onPress={takePhoto} testID="chat-image-camera" />
            <MenuRow label={locale==="en"?"Choose from photos":translate(locale,"从照片中选择")} onPress={choosePhoto} testID="chat-image-library" />
            <NuriText secondary role="Caption">{t("你发送的图片会交给 NURI 的 AI 服务（OpenAI）分析，请不要上传不必要的隐私信息")}</NuriText>
            <NuriButton secondary label={t("取消")} onPress={()=>setImageMenuVisible(false)} testID="chat-image-cancel" />
          </GlassSurface>
        </View>
      </Modal>
    <Toast message={toastMsg} />
  </View>;
  return embedded ? content : <NuriKeyboardFrame>{content}</NuriKeyboardFrame>;
}

// ── Sub-component: message bubble (text, image, transitions) ────────────────
function MessageBubble({
  msg,
  actionsEnabled = true,
  feedbackSaving = false,
  onCopy,
  onFeedback,
}: {
  msg: Msg;
  actionsEnabled?: boolean;
  feedbackSaving?: boolean;
  onCopy?: (message: Msg) => void;
  onFeedback?: (message: Msg, rating: "like" | "dislike") => void;
}) {
  const { t } = useT();
  const palette = useNuriTheme();
  const [actionsVisible,setActionsVisible] = useState(false);
  const router = useRouter();
  const { capture } = useAccountScope();
  const isAI = msg.role === "ai";
  // A featured post NURI brought in from a tapped notification: the marker is
  // also NURI's message, and the post rides on it as a card.
  const post: DailyPostOnMessage | null =
    msg.transition?.kind === "card_opened" && msg.transition.post?.id ? msg.transition.post : null;
  const video: DailyVideoOnMessage | null =
    msg.transition?.kind === "card_opened" && msg.transition.video?.id ? msg.transition.video : null;
  const postHeadline = post ? shortResourceSummary(post.headline, 110) : null;
  const postPreview = post && Array.isArray(post.takeaways) ? shortResourceSummary(post.takeaways.slice(0, 2), 220) : null;
  const videoPreview = video ? shortResourceSummary(video.key_points, 220) || shortResourceSummary(video.summary, 220) : null;

  if (msg.transition?.kind === "memory_context") {
    return <MemoryContextCard transition={msg.transition as MemoryContextTransition} />;
  }

  // A parent opened a feed card. There is only ever one conversation, so this
  // marks where the subject changed instead of the card getting a chat of its
  // own. It carries no text — it is a separator, not something anyone said —
  // and without this branch it would render as an empty bubble.
  if (msg.transition?.kind === "card_opened" && !post && !video) {
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

  // Historical task/medical transitions remain server data, not new UI actions.
  // Never display invented hospital names, distances or phone numbers.
  if ((msg.transition?.kind === "task_card" || msg.transition?.kind === "hospital_card") && !msg.text) return null;

  return (
    <View
      style={[
        styles.row,
        { justifyContent: isAI ? "flex-start" : "flex-end" },
      ]}
    >
      <GlassSurface kind={isAI ? "message" : "user"} style={{maxWidth:isAI?"100%":"84%",width:isAI?"100%":undefined}} contentStyle={{padding:16}} testID={`bubble-${msg.role}`}>
        {isAI ? <Pressable onPress={()=>setActionsVisible(v=>!v)} accessibilityRole="button" accessibilityLabel={t("回复操作")} style={{flexDirection:"row",alignItems:"center",gap:8,minHeight:24,marginBottom:8}} hitSlop={10}><View style={{width:24,height:24}}><View style={{transform:[{scale:24/34}],transformOrigin:"top left"}}><SceneAvatar /></View></View><NuriText style={{fontSize:16,lineHeight:24}}>Nuri</NuriText></Pressable>:null}
        {msg.image_base64 ? (
          <Image
            source={{ uri: msg.image_base64 }}
            style={styles.bubbleImage}
            contentFit="cover"
          />
        ) : null}
        {msg.text && !post && !video ? (
          <Text style={[styles.bubbleText, {color:palette.ink,fontSize:17,lineHeight:26,fontWeight:"400"}]}>
            {isAI ? (
              <RichText text={msg.text} />
            ) : (
              msg.text
            )}
          </Text>
        ) : null}
        {post ? (
          <Pressable
            style={styles.postCard}
            onPress={() => { if (capture() !== null) router.push({ pathname: "/daily-post", params: { id: post.id } }); }}
            accessibilityRole="button"
            testID="chat-daily-post-card"
          >
            <NuriText secondary style={styles.postCardEyebrow}>{t("每日精选")}</NuriText>
            <NuriText style={styles.postCardTitle}>{postHeadline || t("打开推荐的家长分享")}</NuriText>
            {postPreview ? <NuriText style={styles.postCardSummary} numberOfLines={3} testID="chat-daily-post-summary">{postPreview}</NuriText> : null}
            <View style={styles.postCardCta}>
              <NuriText style={styles.postCardCtaText}>{t("查看摘要与来源")}</NuriText>
              <NuriIcon name="arrowRight" />
            </View>
          </Pressable>
        ) : null}
        {video ? <Pressable style={styles.postCard}
          onPress={() => { if (capture() !== null) router.push({ pathname: "/daily-video", params: { id: video.id } }); }}
          accessibilityRole="button" testID="chat-daily-video-card">
          <NuriText secondary style={styles.postCardEyebrow} testID="chat-daily-video-source">YouTube · {t("精选视频")}</NuriText>
          <NuriText style={styles.postCardTitle}>{t("在YouTube查看推荐视频")}</NuriText>
          {videoPreview ? <NuriText style={styles.postCardSummary} numberOfLines={3} testID="chat-daily-video-summary">{videoPreview}</NuriText> : null}
          <NuriText secondary style={styles.postCardEyebrow}>{t("AI 检索摘要 · 非完整视频摘要")}</NuriText>
          <View style={styles.postCardCta}><NuriText style={styles.postCardCtaText}>{t("查看摘要与来源")}</NuriText><NuriIcon name="arrowRight" /></View>
        </Pressable> : null}
        {isAI && actionsVisible && actionsEnabled && msg.text && !post && !video ? (
          <View style={styles.responseActions} testID={`chat-response-actions-${msg.id}`}>
            <Pressable
              onPress={() => onCopy?.(msg)}
              style={styles.responseAction}
              accessibilityRole="button"
              accessibilityLabel={t("复制回复")}
              testID={`chat-copy-${msg.id}`}
            >
              <Ionicons name="copy-outline" size={17} color={colors.onSurfaceTertiary} />
            </Pressable>
            <Pressable
              onPress={() => onFeedback?.(msg, "like")}
              disabled={feedbackSaving}
              style={[styles.responseAction, msg.feedback_rating === "like" && styles.responseActionSelected]}
              accessibilityRole="button"
              accessibilityLabel={t("喜欢这条回复")}
              accessibilityState={{ selected: msg.feedback_rating === "like", disabled: feedbackSaving }}
              aria-pressed={msg.feedback_rating === "like"}
              testID={`chat-like-${msg.id}`}
            >
              <Ionicons name={msg.feedback_rating === "like" ? "thumbs-up" : "thumbs-up-outline"} size={18} color={msg.feedback_rating === "like" ? colors.brand : colors.onSurfaceTertiary} />
            </Pressable>
            <Pressable
              onPress={() => onFeedback?.(msg, "dislike")}
              disabled={feedbackSaving}
              style={[styles.responseAction, msg.feedback_rating === "dislike" && styles.responseActionSelected]}
              accessibilityRole="button"
              accessibilityLabel={t("不喜欢这条回复")}
              accessibilityState={{ selected: msg.feedback_rating === "dislike", disabled: feedbackSaving }}
              aria-pressed={msg.feedback_rating === "dislike"}
              testID={`chat-dislike-${msg.id}`}
            >
              <Ionicons name={msg.feedback_rating === "dislike" ? "thumbs-down" : "thumbs-down-outline"} size={18} color={msg.feedback_rating === "dislike" ? colors.brand : colors.onSurfaceTertiary} />
            </Pressable>
          </View>
        ) : null}
      </GlassSurface>
    </View>
  );
}

// ── Sub-component: animated "typing…" indicator ─────────────────────────────
function TypingDots() {
  const palette=useNuriTheme();
  const {locale}=useT();
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
    <GlassSurface kind="message" contentStyle={{padding:16,gap:8}} style={{width:"100%"}} testID="chat-typing">
      <View style={{flexDirection:"row",alignItems:"center",gap:8}}>
        <View style={{width:24,height:24}}><View style={{transform:[{scale:24/34}],transformOrigin:"top left"}}><SceneAvatar /></View></View>
        <NuriText style={{fontSize:15,lineHeight:22,fontWeight:"600"}}>Nuri</NuriText>
      </View>
      <NuriText accessibilityLiveRegion="polite" style={{fontSize:17,lineHeight:26}}>{locale==="en"?"Nuri is replying…":translate(locale, "Nuri 正在回复…")}</NuriText>
        <View style={{flexDirection:"row",gap:5,alignItems:"center",height:16}}>
          {[dot1, dot2, dot3].map((dot, i) => (
            <Animated.View
              key={i}
              style={{width:7,height:7,borderRadius:3.5,backgroundColor:palette.ink,opacity:.85,transform:[{translateY:dot}]}}
            />
          ))}
        </View>
    </GlassSurface>
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
  responseActions: {
    flexDirection: "row",
    alignItems: "center",
    // Keep the 17/18pt native icons inside separate, non-overlapping 44pt targets.
    width: 132,
    height: 44,
    gap: 0,
    marginTop: 10,
  },
  responseAction: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  responseActionSelected: { backgroundColor: "rgba(108, 79, 214, 0.12)" },

  bold: { fontWeight: "700" },
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
  postCard: {
    minHeight: 44,
    gap: 8,
  },
  postCardEyebrow: { fontSize: 12, lineHeight:16 },
  postCardTitle: { fontSize: 17, lineHeight: 22, fontWeight: "500" },
  postCardSummary: {fontSize:17,lineHeight:26},
  postCardLine: { fontSize: type.sm, lineHeight: 19, color: colors.onSurfaceTertiary },
  postCardCta: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  postCardCtaText: { fontSize: 15, lineHeight:22, fontWeight: "500" },
  videoThumbWrap: { borderRadius: 12, overflow: "hidden", aspectRatio: 16 / 9, backgroundColor: "#000000", marginBottom: 4 },
  videoThumb: { width: "100%", height: "100%" },
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
    paddingVertical: 8,
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

  planCard: {
    flex: 1,
    backgroundColor: "#fff",
    borderColor: colors.brand,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 6,
  },
  planHead: { flexDirection: "row", alignItems: "center", gap: 5 },
  planBadge: { fontSize: 11, fontWeight: "700", color: colors.brand },
  planTitle: { fontSize: 15, fontWeight: "800", color: colors.onSurface },
  planGoal: { fontSize: 12, color: colors.muted },
  planTask: { gap: 2, marginTop: 4 },
  planAction: { fontSize: 13, color: colors.onSurface, lineHeight: 19 },
  planMeta: { fontSize: 12, color: colors.muted, lineHeight: 18 },
  planFoot: { fontSize: 11, color: colors.muted, marginTop: 4 },
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
  recordingBtn: { backgroundColor: "#E5484D" },
  voiceBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 6,
    borderRadius: radius.lg,
    backgroundColor: "rgba(255,255,255,0.94)",
  },
  voiceDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#E5484D" },
  voiceBannerText: { flex: 1, fontSize: type.sm, color: "#3A2F5A" },
  voiceBannerHint: { fontSize: type.sm, color: colors.muted },
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
