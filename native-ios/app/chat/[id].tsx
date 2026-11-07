import { FrostedPressable } from "@/src/uiuxfinal/ButtonMaterial";
import { NuriKeyboardFrame, GlassSurface, NuriText, NuriIcon, IconAction } from "@/src/uiux48/Primitives";
import { VoiceInputBar } from "@/src/uiux48/VoiceInputBar";
import { NuriComposer } from "@/src/uiux48/Composer";
import { ChatAttachmentMenu } from "@/src/uiux48/ChatAttachmentMenu";
import { ChatAttachmentPreview } from "@/src/uiux48/ChatAttachmentPreview";
import type { ChatAttachmentAnchor, ChatDraftAttachment } from "@/src/chatAttachments";
import { CHAT_MAX_ATTACHMENTS, prepareChatAttachment, pickWebChatMediaFiles, releaseChatAttachment, releaseChatPickerAssets } from "@/src/chatMediaInput";
import { useComposerDockInset } from "@/src/uiux48/useComposerDock";
import { FinalChatBubble, FinalText } from "@/src/uiuxfinal/Primitives";
import { NuriAvatar as SceneAvatar } from "@/src/uiux48/Scene";
import { useNuriTheme } from "@/src/uiux48/Theme";
import { readChatDraft, writeChatDraft } from "@/src/uiux48/chatDraft";
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
import { ChatReportSheet } from "@/src/components/ChatReportSheet";
import { ApiError, api, isStreamUnsupported, type ChatReportReason } from "@/src/api";
import { buildChatMessagePayload } from "@/src/chatClientContext";
import {
  ChatImageInputError,
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
  reported?: boolean;
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
  const { generation, capture: captureAccount, current: currentAccount } = useAccountScope();
  const { t, locale } = useT();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const [pageHeaderHeight, setPageHeaderHeight] = useState(0);
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const phoneWidth = Math.min(viewportWidth, 402);
  const params = useLocalSearchParams<{ id: string }>();
  const id = sessionId ?? params.id;
  // A covered native screen can be reused for another conversation without
  // changing accounts. Bind every async callback to this exact render's route
  // epoch as well as the account epoch, including an A → B → A transition.
  const routeOwnerRef = useRef({ id, generation, version: 0 });
  if (routeOwnerRef.current.id !== id || routeOwnerRef.current.generation !== generation) {
    routeOwnerRef.current = { id, generation, version: routeOwnerRef.current.version + 1 };
  }
  const routeVersion = routeOwnerRef.current.version;
  const capture = useCallback(() => routeOwnerRef.current.version === routeVersion ? captureAccount() : null, [captureAccount, routeVersion]);
  const current = useCallback((ticket: number | null) => routeOwnerRef.current.version === routeVersion && currentAccount(ticket), [currentAccount, routeVersion]);
  const safeInsets = useSafeAreaInsets();
  const dockBottom = useComposerDockInset(!embedded);
  const composerRef = useRef<TextInput>(null);
  const launchAction = useRef(initialAction);
  const theme48 = useNuriTheme();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [historyLoadState, setHistoryLoadState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [input, setInput] = useState("");
  const [composerSpace,setComposerSpace] = useState<number|undefined>(undefined);
  const initialDraftOwner=useRef(generation);
  const initialDraftUsed=useRef(false);
  const draftWriteScope=useRef<{id:string;generation:number}|null>(null);
  useEffect(() => {
    // Hydrate the bridge before the first write. Otherwise a fresh empty input
    // would erase the draft handed over by the still-mounted Home screen.
    if(draftWriteScope.current?.id!==id||draftWriteScope.current.generation!==generation){draftWriteScope.current={id,generation};return;}
    writeChatDraft(id, input, generation);
  }, [id, input, generation]);
  const [attachments, setAttachments] = useState<ChatDraftAttachment[]>([]);
  const attachmentOwnerRef = useRef<ChatDraftAttachment[]>([]);
  attachmentOwnerRef.current = attachments;
  const attachmentResourcesRef = useRef(new Set<ChatDraftAttachment>());
  const attachmentWorkVersionRef = useRef(0);
  const attachmentWorkInFlightRef = useRef(false);
  const [previewAttachment, setPreviewAttachment] = useState<ChatDraftAttachment | null>(null);
  const [attachmentAnchor, setAttachmentAnchor] = useState<ChatAttachmentAnchor | undefined>(undefined);
  const attachmentAnchorRef = useRef<ChatAttachmentAnchor | undefined>(undefined);
  const composerDockRef = useRef<View>(null);
  const menuDockOffsetRef = useRef<number | null>(null);
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
  const scrollGeometry = useRef({viewportHeight:0,contentHeight:0});
  const scrollToLatest = useCallback((animated=false) => {
    // Native scrollToEnd can choose the horizontal axis when transient content
    // is wider than its viewport. This conversation always scrolls vertically.
    const {viewportHeight,contentHeight}=scrollGeometry.current;
    scrollRef.current?.scrollTo({x:0,y:Math.max(0,contentHeight-viewportHeight),animated});
  },[]);
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

  const [reportTarget, setReportTarget] = useState<Msg | null>(null);
  const [reportSaving, setReportSaving] = useState(false);
  const submitReport = useCallback(async (reason: ChatReportReason, note: string) => {
    const ticket = capture();
    if (ticket === null || !id || !reportTarget || reportSaving) return;
    const messageId = reportTarget.id;
    setReportSaving(true);
    try {
      await api.reportChatMessage(id, messageId, reason, note);
      if (!current(ticket)) return;
      setMessages((list) => list.map((item) => item.id === messageId ? { ...item, reported: true } : item));
      setReportTarget(null);
      showToast(t("已收到举报，我们会尽快审核"));
    } catch {
      if (current(ticket)) showToast(t("举报提交失败，请重试"));
    } finally {
      if (current(ticket)) setReportSaving(false);
    }
  }, [id, reportTarget, reportSaving, showToast, t, capture, current, setMessages, setReportSaving, setReportTarget]);

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
    const timer=setTimeout(() => scrollToLatest(true),100);
    return () => clearTimeout(timer);
  }, [messages, typing, streamingText, scrollToLatest]);

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
    else router.navigate(({notifications:"/notifications",chat:"/(tabs)/chats",community:"/community",profile:"/(tabs)/profile"}[action]) as never);
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
    if (!id || sendingRef.current || attachmentWorkInFlightRef.current) return;
    const text = (textOverride ?? input).trim();
    // This TestFlight build exposes the complete local media draft flow. The
    // verified transport sends one photo: never discard extra media, pretend
    // to upload a video, or silently send its cover as the original clip.
    if (!imageBase64 && (attachments.length > 1 || attachments.some(item => item.kind === "video"))) {
      setMediaError(locale === "en" ? "This test build can send one photo at a time. Multiple photos and videos remain in your draft and have not been sent." : locale === "zh-TW" ? "此測試版暫時只能傳送一張照片。多張照片和影片已保留在草稿中，尚未傳送。" : "此测试版暂时只能发送一张照片。多张照片和视频已保留在草稿中，尚未发送。");
      return;
    }
    const selectedAttachments = attachments;
    const selectedImage = imageBase64
      ? { previewUri: imageBase64, dataUri: imageBase64, width: 0, height: 0 }
      : attachments[0]?.image;
    const normalizedImage = selectedImage?.dataUri || null;
    if (!text && !normalizedImage) return;
    setInput("");
    setAttachments([]);
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
      selectedAttachments.forEach(item => {
        releaseChatAttachment(item);
        attachmentResourcesRef.current.delete(item);
      });
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
      if (selectedAttachments.length) setAttachments(selectedAttachments);
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
    attachmentWorkVersionRef.current++;
    attachmentWorkInFlightRef.current = false;
    setProcessingImage(false);
    attachmentResourcesRef.current.forEach(releaseChatAttachment);
    attachmentResourcesRef.current.clear();
    attachmentOwnerRef.current = [];
    setAttachments([]);
    setPreviewAttachment(null);
    setSending(false);
    setTyping(false);
    setStreamingText("");
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
  }, [generation, id, clearVoiceTimer]);

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
      setPreviewAttachment(null);
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
      showToast(locale === "en" ? "This file is too large. Choose a smaller file." : translate(locale, "文件过大，请选择小一些的照片或视频。"));
      return;
    }
    if (error instanceof ChatImageInputError && error.code === "unsupported") {
      showToast(locale === "en" ? "This media format cannot be opened." : translate(locale, "无法打开这个媒体格式，请重新选择。"));
      return;
    }
    showToast(locale === "en" ? "Could not prepare this media. Please try again." : translate(locale, "媒体准备失败，请重试。"));
  };

  const acceptPickerResult = async (result: ImagePicker.ImagePickerResult, ticket = capture()) => {
    if (result.canceled || !result.assets?.length) return;
    if (!current(ticket) || !voiceActiveRef.current || attachmentWorkInFlightRef.current) {
      releaseChatPickerAssets(result.assets);
      return;
    }
    const remaining = CHAT_MAX_ATTACHMENTS - attachmentOwnerRef.current.length;
    if (remaining <= 0) { releaseChatPickerAssets(result.assets); return; }
    const version = ++attachmentWorkVersionRef.current;
    attachmentWorkInFlightRef.current = true;
    setProcessingImage(true);
    const prepared: ChatDraftAttachment[] = [];
    try {
      // Bound and serialize image decoding/video thumbnails; never create six
      // full-resolution bitmaps at once. Nothing uploads on selection.
      for (const asset of result.assets.slice(0, remaining)) {
        if (!current(ticket) || !voiceActiveRef.current || version !== attachmentWorkVersionRef.current) return;
        const attachment = await prepareChatAttachment(asset);
        prepared.push(attachment);
      }
      if (!current(ticket) || !voiceActiveRef.current || version !== attachmentWorkVersionRef.current) return;
      const committed = prepared.slice();
      committed.forEach(item => attachmentResourcesRef.current.add(item));
      setAttachments(previous => [...previous, ...committed]);
      attachmentOwnerRef.current = [...attachmentOwnerRef.current, ...committed];
      prepared.length = 0; // Resources are now owned by this account's draft.
      setMediaError("");
    } catch (error) {
      if (!current(ticket)) return;
      explainImageError(error);
    } finally {
      prepared.forEach(releaseChatAttachment);
      releaseChatPickerAssets(result.assets);
      if (current(ticket) && version === attachmentWorkVersionRef.current) {
        attachmentWorkInFlightRef.current = false;
        setProcessingImage(false);
      }
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
          mediaTypes: ["images", "videos"],
          cameraType: ImagePicker.CameraType.back,
          allowsEditing: false,
          base64: false,
          exif: false,
          quality: 0.68,
          videoMaxDuration: 120,
        }), ticket);
        return;
      }

      // iOS PHPicker grants access only to the selected media. Broad Photo
      // Library authorization is not needed for this system selection UI.
      await acceptPickerResult(await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images", "videos"],
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: Math.max(1, CHAT_MAX_ATTACHMENTS - attachmentOwnerRef.current.length),
        orderedSelection: true,
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

  const openSafeWebPicker = async (source: "camera" | "library") => {
    const ticket = capture();
    if (ticket === null || nativePickerInFlightRef.current) return;
    nativePickerInFlightRef.current = true;
    try {
      // This stays in the user's icon press stack, so browsers retain their
      // chooser gesture. Validate raw files before allocating image surfaces.
      const pendingAssets = pickWebChatMediaFiles(source, CHAT_MAX_ATTACHMENTS - attachmentOwnerRef.current.length);
      setImageMenuVisible(false);
      const assets = await pendingAssets;
      if (assets.length) await acceptPickerResult({ canceled: false, assets }, ticket);
    } catch (error) {
      if (!current(ticket)) return;
      explainImageError(error);
    } finally {
      nativePickerInFlightRef.current = false;
    }
  };

  const takePhoto = () => {
    if (Platform.OS === "web") {
      void openSafeWebPicker("camera");
      return;
    }
    deferNativePickerUntilModalCloses("camera");
  };

  const choosePhoto = () => {
    if (Platform.OS === "web") {
      void openSafeWebPicker("library");
      return;
    }
    deferNativePickerUntilModalCloses("library");
  };

  const refreshAttachmentAnchor = () => {
    composerDockRef.current?.measureInWindow((x, y, _width, height) => {
      if (capture() === null) return;
      const previous = attachmentAnchorRef.current;
      const anchor = {
        x: Math.max(8, Math.min(viewportWidth - 68, previous?.x ?? x + (embedded ? 0 : 24) + 3)),
        y: Math.max(safeInsets.top + 116, y + (menuDockOffsetRef.current ?? height - dockBottom - (height - dockBottom > 80 ? 64 : 60))),
        width: 60, height: 60,
      };
      attachmentAnchorRef.current = anchor;
      setAttachmentAnchor(anchor);
    });
  };

  const openImageInput = (anchor?: ChatAttachmentAnchor) => {
    if (capture() === null || !voiceActiveRef.current || voicePhaseRef.current !== "idle" || sendingRef.current || processingImage || nativePickerInFlightRef.current || historyLoadState !== "ready") return;
    if (attachmentOwnerRef.current.length >= CHAT_MAX_ATTACHMENTS) {
      showToast(locale === "en" ? `You can add up to ${CHAT_MAX_ATTACHMENTS} items to this draft.` : translate(locale, `本次草稿最多添加 ${CHAT_MAX_ATTACHMENTS} 个附件。`));
      return;
    }
    setMediaError("");
    const initialAnchor = anchor ?? { x: embedded ? 8 : 27, y: viewportHeight - dockBottom - 60, width: 60, height: 60 };
    attachmentAnchorRef.current = initialAnchor;
    setAttachmentAnchor(initialAnchor);
    menuDockOffsetRef.current = null;
    if (anchor) composerDockRef.current?.measureInWindow((_x, y, _width, height) => {
      // An expanded editor's action was measured in its just-dismissed Modal,
      // not the underlying dock. Use the current dock for that handoff.
      if (anchor.y >= y - 8 && anchor.y <= y + height) menuDockOffsetRef.current = anchor.y - y;
    });
    Keyboard.dismiss();
    setImageMenuVisible(true);
  };

  const removeAttachment = (attachmentId: string) => {
    if (capture() === null || sendingRef.current || attachmentWorkInFlightRef.current) return;
    const item = attachmentOwnerRef.current.find(attachment => attachment.id === attachmentId);
    if (!item) return;
    if (previewAttachment?.id === attachmentId) setPreviewAttachment(null);
    releaseChatAttachment(item);
    attachmentResourcesRef.current.delete(item);
    attachmentOwnerRef.current = attachmentOwnerRef.current.filter(attachment => attachment.id !== attachmentId);
    setAttachments(previous => previous.filter(attachment => attachment.id !== attachmentId));
    setMediaError("");
  };

  useEffect(() => {
    if (!imageMenuVisible || Platform.OS === "web") return;
    const listener = Keyboard.addListener("keyboardDidHide", refreshAttachmentAnchor);
    return () => listener.remove();
  }, [imageMenuVisible, dockBottom]);

  useEffect(() => () => {
    attachmentWorkVersionRef.current++;
    attachmentResourcesRef.current.forEach(releaseChatAttachment);
    attachmentResourcesRef.current.clear();
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
  const content = <View testID="chat-content" style={{flex:1,minHeight:0,width:"100%",minWidth:0,maxWidth:"100%"}} onLayout={e=>{const next=e.nativeEvent.layout.height;setComposerSpace(previous=>previous===next?previous:next);}}>
    {!embedded ? <Stack.Screen options={{ gestureEnabled: !sending }} /> : null}
    <ScrollView ref={scrollRef} horizontal={false} directionalLockEnabled alwaysBounceHorizontal={false} style={{flex:1,minHeight:0,width:"100%",minWidth:0,maxWidth:"100%"}} contentContainerStyle={{width:"100%",minWidth:0,maxWidth:"100%",paddingHorizontal:embedded?0:24,paddingTop:embedded?0:8,paddingBottom:16,gap:16}} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" onLayout={e=>{scrollGeometry.current.viewportHeight=e.nativeEvent.layout.height;scrollToLatest();}} onContentSizeChange={(_width,height)=>{scrollGeometry.current.contentHeight=height;scrollToLatest();}} testID="chat-scroll">
      {historyLoadState==="loading"?<View testID="chat-history-loading"><ActivityIndicator /><NuriText secondary>{t("正在加载对话…")}</NuriText></View>:null}
      {historyLoadState==="error"?<Pressable onPress={()=>void load()} style={{minHeight:44}} testID="chat-history-retry"><NuriText>{t("对话未能打开，点此重试")}</NuriText></Pressable>:null}
      {messages.map(m=><MessageBubble key={m.id} msg={m} actionsEnabled={!m.id.startsWith("tmp-")} feedbackSaving={feedbackSavingIds.has(m.id)} onCopy={copyResponse} onFeedback={rateResponse} onReport={setReportTarget} />)}
      {streamingText?<MessageBubble msg={{id:"__streaming__",role:"ai",text:streamingText}} actionsEnabled={false} />:null}
      {typing?<TypingDots />:null}
    </ScrollView>
    <View ref={composerDockRef} collapsable={false} testID="chat-composer-dock" style={{width:"100%",alignSelf:"stretch",minWidth:0,maxWidth:"100%",flexShrink:0,paddingHorizontal:embedded?0:24,paddingBottom:voiceState!=="idle"&&!embedded?Math.max(114,dockBottom):dockBottom}}>
      {processingImage?<View style={{padding:12}} testID="chat-image-processing"><ActivityIndicator /><NuriText secondary>{locale==="en"?"Preparing media…":translate(locale,"正在准备照片和视频…")}</NuriText></View>:null}
      {voiceState!=="idle"?<VoiceInputBar phase={voiceState} seconds={voiceSeconds} metered={voiceMetered} level={readVoiceLevel} onCancel={cancelVoice} onStop={()=>void stopVoice("draft")} onSend={()=>void stopVoice("send")} />:
        <NuriComposer value={input} onChangeText={setInput} availableHeight={composerSpace} inputRef={composerRef} onSend={()=>void send()} onAttach={openImageInput} onMic={()=>void startVoice()} busy={sending||processingImage} disabled={historyLoadState!=="ready"} hasAttachment={attachments.length>0} attachments={attachments} onRemoveAttachment={removeAttachment} onPreviewAttachment={attachment=>{if(capture()!==null&&!sendingRef.current&&!attachmentWorkInFlightRef.current){Keyboard.dismiss();setPreviewAttachment(attachment);}}} testID={embedded?"home-chat":"chat"} />}
      {mediaError?<View style={{flexDirection:"row",alignItems:"center",gap:8,paddingTop:8}} testID="chat-media-error"><NuriText accessibilityLiveRegion="assertive" style={{flex:1}}>{mediaError}</NuriText><IconAction name="close" label={t("关闭")} onPress={()=>setMediaError("")} /></View>:null}
    </View>
      <Modal visible={imageMenuVisible} transparent animationType="fade" onShow={refreshAttachmentAnchor} onRequestClose={()=>setImageMenuVisible(false)} onDismiss={flushNativePicker}>
        <View style={{flex:1}} testID="chat-attachment-overlay">
          <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={t("取消")} onPress={()=>setImageMenuVisible(false)} />
          <ChatAttachmentMenu anchor={attachmentAnchor} onCamera={takePhoto} onLibrary={choosePhoto} onDismiss={()=>setImageMenuVisible(false)} />
        </View>
      </Modal>
      <ChatAttachmentPreview attachment={previewAttachment} onClose={()=>setPreviewAttachment(null)} />
      <ChatReportSheet visible={!!reportTarget} busy={reportSaving} onClose={()=>setReportTarget(null)} onSubmit={(reason,note)=>void submitReport(reason,note)} />
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
  onReport,
}: {
  msg: Msg;
  actionsEnabled?: boolean;
  feedbackSaving?: boolean;
  onCopy?: (message: Msg) => void;
  onFeedback?: (message: Msg, rating: "like" | "dislike") => void;
  onReport?: (message: Msg) => void;
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
      {isAI?<Pressable onPress={()=>setActionsVisible(v=>!v)} accessibilityRole="button" accessibilityLabel={t("回复操作")} style={{width:36,minHeight:44,alignSelf:"flex-end",justifyContent:"center",marginRight:8}} hitSlop={4}><SceneAvatar size={36}/></Pressable>:null}
      <FinalChatBubble incoming={isAI} style={{maxWidth:isAI?"88%":"92%",flexShrink:1,paddingHorizontal:16,paddingVertical:isAI?14:12}} testID={`bubble-${msg.role}`}>
        {msg.image_base64 ? (
          <Image
            source={{ uri: msg.image_base64 }}
            style={styles.bubbleImage}
            contentFit="cover"
          />
        ) : null}
        {msg.text && !post && !video ? (
          <FinalText style={[styles.bubbleText, {color:palette.ink,fontSize:16,lineHeight:24,fontWeight:"400"}]}>
            {isAI ? (
              <RichText text={msg.text} />
            ) : (
              msg.text
            )}
          </FinalText>
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
            <FrostedPressable
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
            </FrostedPressable>
            <FrostedPressable
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
            </FrostedPressable>
            <FrostedPressable
              onPress={() => onReport?.(msg)}
              disabled={msg.reported === true}
              style={[styles.responseAction, msg.reported === true && styles.responseActionSelected]}
              accessibilityRole="button"
              accessibilityLabel={msg.reported ? t("已举报这条回复") : t("举报这条回复")}
              accessibilityState={{ disabled: msg.reported === true }}
              testID={`chat-report-${msg.id}`}
            >
              <Ionicons name={msg.reported ? "flag" : "flag-outline"} size={17} color={msg.reported ? colors.brand : colors.onSurfaceTertiary} />
            </FrostedPressable>
          </View>
        ) : null}
      </FinalChatBubble>
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
  row: { flexDirection: "row", width:"100%", minWidth:0, maxWidth:"100%", marginBottom: spacing.sm, alignItems: "flex-end" },
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
