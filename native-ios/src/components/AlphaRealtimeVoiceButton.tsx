import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { AudioModule } from "expo-audio";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import WebView, { type WebViewMessageEvent } from "react-native-webview";

import { ApiError, apiRequest, type ResourceLocale } from "../api";
import { getSessionGeneration, subscribeSessionBoundary } from "../sessionBoundary";
import { API, colors } from "../theme";

type Status = "hidden" | "ready" | "connecting" | "listening" | "speaking" | "permission" | "unavailable" | "ended"
  | "finishing" | "saving" | "saveFailed";
type VoiceActor = "user" | "nuri";
type VoiceMeter = { active: boolean; level: number; receivedAt: number };
type OrbMode = "idle" | "connecting" | "listening" | VoiceActor;
type Connection = { id: string; expires: number; proof: string };
type TranscriptPermit = Omit<Connection, "id">;
type TranscriptEntry = { item_id: string; order: number; role: "user" | "ai"; text: string };
export type SavedVoiceMessage = { id: string; role: "user" | "ai"; text: string; created_at?: string };
type TranscriptSave = {
  generation: number;
  body: TranscriptPermit & { session_id: string; call_id: string; entries: TranscriptEntry[] };
};
type OfferAnswer = { sdp: string; connection: Connection; transcript?: TranscriptPermit; manual_turns?: boolean };
type Props = {
  allowed: boolean;
  locale: ResourceLocale;
  disabled?: boolean;
  sessionId?: string;
  onActiveChange?: (active: boolean) => void;
  onTranscriptSaved?: (sessionId: string, messages: SavedVoiceMessage[]) => void;
};

const CLIENT_URL = API + "/alpha/realtime/client";
const CALL_PATH = "/chat/realtime/call";
const TRANSCRIPT_PATH = "/chat/realtime/transcript";
const MAX_SDP = 65_536;
const MAX_BRIDGE_MESSAGE = 128 * 1024;
const MAX_SESSION_MS = 5 * 60 * 1000;
const FINISH_TIMEOUT_MS = 2500;

const strings = {
  en: {
    title: "Live voice",
    description: "During the call, Nuri shares microphone audio, your saved family profile, and allowed chat context with OpenAI. The AI voice conversation is saved as text here.",
    start: "Start talking",
    end: "End call",
    close: "Close",
    connecting: "Connecting…",
    listening: "Nuri is listening",
    userSpeaking: "You’re speaking",
    speaking: "Nuri is speaking",
    permission: "Allow microphone access in Settings to talk with Nuri.",
    unavailable: "Live voice couldn’t connect. Try again or continue in text.",
    ended: "Call ended. Start another when you’re ready.",
    finishing: "Ending call…",
    saving: "Saving the conversation to this chat…",
    saveFailed: "The conversation couldn’t be saved. Try again.",
    retry: "Retry saving",
  },
  "zh-CN": {
    title: "实时语音",
    description: "通话时，Nuri 会向 OpenAI 发送麦克风音频、已保存的家庭档案和你允许使用的聊天信息。语音由 AI 生成，通话会以文字保存在这里。",
    start: "开始对话",
    end: "结束通话",
    close: "关闭",
    connecting: "正在连接…",
    listening: "Nuri 正在听",
    userSpeaking: "你正在说话",
    speaking: "Nuri 正在说",
    permission: "请在系统设置中允许麦克风访问，再与 Nuri 对话。",
    unavailable: "实时语音连接失败。可以重试或继续使用文字聊天。",
    ended: "通话已结束。准备好后可以重新开始。",
    finishing: "正在结束通话…",
    saving: "正在把通话内容保存到聊天…",
    saveFailed: "通话内容未能保存，请重试。",
    retry: "重试保存",
  },
  "zh-TW": {
    title: "即時語音",
    description: "通話時，Nuri 會向 OpenAI 傳送麥克風音訊、已儲存的家庭檔案和你允許使用的聊天資訊。語音由 AI 生成，通話會以文字儲存在這裡。",
    start: "開始對話",
    end: "結束通話",
    close: "關閉",
    connecting: "正在連線…",
    listening: "Nuri 正在聽",
    userSpeaking: "你正在說話",
    speaking: "Nuri 正在說",
    permission: "請在系統設定中允許麥克風存取，再與 Nuri 對話。",
    unavailable: "即時語音連線失敗。可以重試或繼續使用文字聊天。",
    ended: "通話已結束。準備好後可以重新開始。",
    finishing: "正在結束通話…",
    saving: "正在把通話內容儲存到聊天…",
    saveFailed: "通話內容未能儲存，請重試。",
    retry: "重試儲存",
  },
};

function isSdp(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SDP && /^v=0\r?\n/.test(value);
}

function isConnection(value: Connection | undefined): value is Connection {
  return !!value && /^rtc_[\w-]{1,128}$/.test(value.id) && /^[a-f0-9]{64}$/.test(value.proof)
    && Number.isSafeInteger(value.expires);
}

function isTranscriptPermit(value: TranscriptPermit | undefined): value is TranscriptPermit {
  return !!value && /^[a-f0-9]{64}$/.test(value.proof) && Number.isSafeInteger(value.expires)
    && value.expires > Date.now() / 1000;
}

function readTranscript(entries: unknown): TranscriptEntry[] | null {
  if (!Array.isArray(entries) || entries.length > 256) return null;
  const ids = new Set<string>();
  let previousOrder = -1;
  for (const entry of entries) {
    if (!entry || typeof entry.item_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.item_id)
        || ids.has(entry.item_id) || !Number.isInteger(entry.order) || entry.order <= previousOrder
        || entry.order > 65535 || (entry.role !== "user" && entry.role !== "ai")
        || typeof entry.text !== "string" || !entry.text.trim() || Array.from(entry.text).length > 2048) return null;
    ids.add(entry.item_id);
    previousOrder = entry.order;
  }
  return entries.map(({ item_id, order, role, text }) => ({ item_id, order, role, text }));
}

function isInBackground() {
  return AppState.currentState === "background";
}

function newVoiceMeters(): Record<VoiceActor, VoiceMeter> {
  return { user: { active: false, level: 0, receivedAt: 0 }, nuri: { active: false, level: 0, receivedAt: 0 } };
}

const orbPalettes = {
  idle: { fill: ["#FBE6E8", "#E4A0B7", "#B978A2"], halo: "#E99EAE" },
  connecting: { fill: ["#F8E3EC", "#D8A5D1", "#A47DB5"], halo: "#D1A2D2" },
  listening: { fill: ["#F9E6E6", "#E4A6C0", "#B888B5"], halo: "#E2A1BD" },
  user: { fill: ["#FCE0CA", "#F09B87", "#C95F78"], halo: "#EE998A" },
  nuri: { fill: ["#F2E2FB", "#B798DF", "#7955A5"], halo: "#B397DD" },
} as const;

function RealtimeVoiceOrb({ mode, level, reduceMotion }: {
  mode: OrbMode;
  level: Animated.Value;
  reduceMotion: boolean;
}) {
  const breath = useRef(new Animated.Value(0)).current;
  const motion = !reduceMotion && mode !== "idle";
  useEffect(() => {
    breath.setValue(0);
    if (!motion) return;
    const duration = mode === "connecting" ? 720 : mode === "listening" ? 1450 : 470;
    const transition = (toValue: number) => Animated.timing(breath, {
      toValue, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true, isInteraction: false,
    });
    const breathing = Animated.loop(Animated.sequence([transition(1), transition(0)]));
    breathing.start();
    return () => breathing.stop();
  }, [breath, mode, motion]);
  const palette = orbPalettes[mode];
  const speaking = mode === "user" || mode === "nuri";
  const activity = Animated.add(Animated.multiply(level, .85), Animated.multiply(breath, speaking ? .15 : .32));
  const size = activity.interpolate({ inputRange: [0, 1], outputRange: [1, 1.13] });
  const haloSize = activity.interpolate({ inputRange: [0, 1], outputRange: [1, 1.24] });
  const haloOpacity = activity.interpolate({ inputRange: [0, 1], outputRange: [speaking ? .34 : .20, .5] });
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none"
    testID="alpha-live-voice-orb" style={styles.orbStage}>
    <Animated.View style={[styles.orbHalo, { backgroundColor: palette.halo },
      motion ? { opacity: haloOpacity, transform: [{ scale: haloSize }] } : { opacity: speaking ? .35 : .21 }]} />
    <Animated.View style={[styles.orbCore, motion && { transform: [{ scale: size }] }]}>
      <LinearGradient colors={palette.fill} start={{ x: .14, y: .05 }} end={{ x: .9, y: .95 }} style={StyleSheet.absoluteFill} />
      <View style={styles.orbWave}>
        {[.31, .57, .84, .64, .37].map((bar, index) => (
          <Animated.View key={bar} style={[styles.orbBar, {
            opacity: [.62, .81, .97, .84, .65][index],
            transform: [{ scaleY: motion ? activity.interpolate({
              inputRange: [0, 1], outputRange: [bar * .57, bar * 1.65],
            }) : bar * (speaking ? 1.15 : .57) }],
          }]} />
        ))}
      </View>
    </Animated.View>
  </View>;
}

function hangUp(connection: Connection | null) {
  if (!connection) return;
  // Closing never requires an AI consent grant. The audio and peer have
  // already stopped locally even if the authenticated hangup is unavailable.
  void apiRequest(CALL_PATH, {
    method: "DELETE",
    body: JSON.stringify(connection),
  }, 5000).catch(() => {});
}

export function AlphaRealtimeVoiceButton({ allowed, locale, disabled, sessionId, onActiveChange, onTranscriptSaved }: Props) {
  const copy = strings[locale] ?? strings.en;
  const [status, setStatus] = useState<Status>("hidden");
  const [viewAttempt, setViewAttempt] = useState<number | null>(null);
  const [voiceActor, setVoiceActor] = useState<VoiceActor | null>(null);
  const [reduceMotion, setReduceMotion] = useState(true);
  const voiceLevel = useRef(new Animated.Value(0)).current;
  const voiceMeters = useRef(newVoiceMeters());
  const shownActor = useRef<VoiceActor | null>(null);
  const webView = useRef<WebView>(null);
  const attempt = useRef(0);
  const active = useRef(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const permissionPending = useRef(false);
  const connected = useRef(false);
  const offerSent = useRef(false);
  const loaded = useRef(false);
  const callSession = useRef<string | undefined>(undefined);
  const currentConnection = useRef<Connection | null>(null);
  const callGeneration = useRef<number>(0);
  const transcriptPermit = useRef<TranscriptPermit | null>(null);
  const transcriptEntries = useRef<TranscriptEntry[]>([]);
  const finishing = useRef<Status | null>(null);
  const pendingSave = useRef<TranscriptSave | null>(null);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onActive = useRef(onActiveChange);
  onActive.current = onActiveChange;
  const onSaved = useRef(onTranscriptSaved);
  onSaved.current = onTranscriptSaved;
  const chatSession = typeof sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : undefined;

  useEffect(() => {
    let subscribed = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (subscribed) setReduceMotion(value);
    }).catch(() => {});
    const settings = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { subscribed = false; settings.remove(); };
  }, []);

  const updateOrb = useCallback(() => {
    const { user, nuri } = voiceMeters.current;
    const speaker = user.active ? "user" : nuri.active ? "nuri" : null;
    if (speaker !== shownActor.current) {
      shownActor.current = speaker;
      setVoiceActor(speaker);
    }
    if (reduceMotion) {
      voiceLevel.setValue(0);
    } else {
      const gain = speaker ? voiceMeters.current[speaker].level : 0;
      Animated.timing(voiceLevel, {
        toValue: gain, duration: speaker ? 120 : 210, easing: Easing.out(Easing.quad),
        useNativeDriver: true, isInteraction: false,
      }).start();
    }
  }, [reduceMotion, voiceLevel]);

  const setBusy = useCallback((value: boolean) => {
    if (busy.current === value) return;
    busy.current = value;
    onActive.current?.(value);
  }, []);

  const saveTranscript = useCallback(async (job: TranscriptSave, next: Status) => {
    if (saving.current || pendingSave.current !== job) return;
    saving.current = true;
    if (mounted.current) {
      setBusy(true);
      setStatus("saving");
    }
    let messages: SavedVoiceMessage[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (pendingSave.current !== job || job.generation !== getSessionGeneration()) break;
      try {
        const result = await apiRequest<{ messages: SavedVoiceMessage[] }>(TRANSCRIPT_PATH, {
          method: "POST",
          body: JSON.stringify(job.body),
        }, 7000);
        if (!Array.isArray(result?.messages) || !result.messages.length || !result.messages.every(message =>
          message && typeof message.id === "string" && typeof message.text === "string"
          && (message.role === "user" || message.role === "ai"))) throw new Error("Invalid transcript response");
        messages = result.messages;
        break;
      } catch (error) {
        // A connection failure may follow a successful write. Retry the same
        // provider items so the backend responds with the same message IDs.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) break;
      }
    }
    saving.current = false;
    if (pendingSave.current !== job) return;
    if (job.generation !== getSessionGeneration()) {
      pendingSave.current = null;
      setBusy(false);
      return;
    }
    if (messages) {
      pendingSave.current = null;
      if (mounted.current) onSaved.current?.(job.body.session_id, messages);
    }
    setBusy(false);
    if (mounted.current) setStatus(previous => previous === "hidden" ? previous : messages ? next : "saveFailed");
  }, [setBusy]);

  const finish = useCallback((next: Status, keepTranscript = true) => {
    const session = callSession.current;
    const connection = currentConnection.current;
    const permit = transcriptPermit.current;
    const entries = transcriptEntries.current;
    const generation = callGeneration.current;
    const hadCall = active.current;
    active.current = false;
    attempt.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    permissionPending.current = false;
    offerSent.current = false;
    loaded.current = false;
    connected.current = false;
    callSession.current = undefined;
    currentConnection.current = null;
    transcriptPermit.current = null;
    transcriptEntries.current = [];
    finishing.current = null;
    voiceMeters.current = newVoiceMeters();
    shownActor.current = null;
    voiceLevel.setValue(0);
    webView.current?.injectJavaScript("window.nuriRealtime?.close(); true;");
    if (generation === getSessionGeneration()) hangUp(connection);
    if (!keepTranscript) pendingSave.current = null;
    const job = keepTranscript && session && connection && permit && entries.length && generation === getSessionGeneration()
      ? { generation, body: { session_id: session, call_id: connection.id, ...permit, entries } }
      : null;
    if (job) {
      pendingSave.current = job;
      void saveTranscript(job, next);
    } else if (hadCall || !keepTranscript) {
      setBusy(false);
    }
    if (mounted.current) {
      setViewAttempt(null);
      setVoiceActor(null);
      if (!job) setStatus(next);
    }
  }, [saveTranscript, setBusy, voiceLevel]);

  function requestFinish(next: Status) {
    if (saving.current) {
      if (next === "hidden") setStatus(next);
      return;
    }
    if (finishing.current !== null) return;
    if (!connected.current || !transcriptPermit.current || !webView.current) return finish(next);
    finishing.current = next;
    if (timer.current) clearTimeout(timer.current);
    const id = attempt.current;
    timer.current = setTimeout(() => { if (id === attempt.current) finish(next); }, FINISH_TIMEOUT_MS);
    setStatus("finishing");
    webView.current.injectJavaScript("window.nuriRealtime?.finish(); true;");
  }

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", (next) => {
      if (active.current && (next === "background" || (next === "inactive" && !permissionPending.current))) {
        finish("hidden");
      }
    });
    const unsubscribe = subscribeSessionBoundary(() => finish("hidden", false));
    return () => {
      setBusy(false);
      mounted.current = false;
      subscription.remove();
      unsubscribe();
      finish("hidden");
    };
  }, [finish, setBusy]);

  useFocusEffect(useCallback(() => () => finish("hidden"), [finish]));

  useEffect(() => {
    if (!allowed) finish("hidden", false);
    else if (active.current && callSession.current !== chatSession) finish("hidden");
  }, [allowed, chatSession, finish]);

  async function begin() {
    if (!allowed || !chatSession || disabled || active.current || pendingSave.current || AppState.currentState !== "active") return;
    const id = ++attempt.current;
    active.current = true;
    callSession.current = chatSession;
    callGeneration.current = getSessionGeneration();
    setBusy(true);
    permissionPending.current = true;
    setStatus("connecting");
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (id !== attempt.current) return;
      permissionPending.current = false;
      if (!permission.granted) return finish("permission");
      if (isInBackground()) return finish("hidden");
      timer.current = setTimeout(() => { if (attempt.current === id) finish("unavailable"); }, 24_000);
      setViewAttempt(id);
    } catch {
      if (id === attempt.current) finish("unavailable");
    }
  }

  async function receive(event: WebViewMessageEvent, id: number) {
    if (id !== attempt.current || !active.current || !allowed || event.nativeEvent.url !== CLIENT_URL
        || event.nativeEvent.data.length > MAX_BRIDGE_MESSAGE) return;
    let message;
    try { message = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (!message || typeof message !== "object") return;

    if (message.type === "offer" && !offerSent.current && isSdp(message.sdp)) {
      offerSent.current = true;
      const generation = callGeneration.current;
      try {
        const result = await apiRequest<OfferAnswer>(CALL_PATH, {
          method: "POST",
          body: JSON.stringify({
            sdp: message.sdp, locale, share_profile: true, share_context: true,
            save_transcript: true, session_id: callSession.current,
            ...(message.manualTurns === true ? { manual_turns: true } : {}),
          }),
        }, 16_000);
        if (!isConnection(result.connection)) throw new Error("Invalid connection");
        if (id !== attempt.current) {
          if (generation === getSessionGeneration()) hangUp(result.connection);
          return;
        }
        currentConnection.current = result.connection;
        if (!isSdp(result.sdp) || !webView.current || !isTranscriptPermit(result.transcript)) {
          throw new Error("Invalid answer");
        }
        transcriptPermit.current = result.transcript;
        const answer = [result.sdp, true, locale, message.manualTurns === true && result.manual_turns === true]
          .map(value => JSON.stringify(value)).join(", ");
        webView.current.injectJavaScript("window.nuriRealtime?.answer(" + answer + "); true;");
      } catch {
        if (id === attempt.current) finish("unavailable");
      }
    } else if ((message.type === "transcript" || message.type === "transcript_end") && transcriptPermit.current) {
      const entries = readTranscript(message.entries);
      if (entries && entries.length >= transcriptEntries.current.length) transcriptEntries.current = entries;
      if (message.type === "transcript_end" && finishing.current !== null) finish(finishing.current);
    } else if (message.type === "listening" && currentConnection.current && finishing.current === null) {
      if (!connected.current) {
        connected.current = true;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { if (attempt.current === id) finish("ended"); }, MAX_SESSION_MS);
      }
      voiceMeters.current.nuri.active = false;
      updateOrb();
      setStatus("listening");
    } else if (message.type === "speaking" && connected.current && finishing.current === null) {
      setStatus("speaking");
    } else if (message.type === "activity" && connected.current) {
      const actor: unknown = message.actor;
      const level: unknown = message.level;
      if ((actor !== "user" && actor !== "nuri") || typeof level !== "number" ||
          !Number.isFinite(level) || level < 0 || level > 1 ||
          (message.active !== undefined && typeof message.active !== "boolean")) return;
      const meter = voiceMeters.current[actor];
      const speaking = typeof message.active === "boolean" ? message.active : level >= .06;
      const now = Date.now();
      const elapsed = now - meter.receivedAt;
      if (speaking === meter.active && elapsed >= 0 && elapsed < 75) return;
      voiceMeters.current[actor] = { active: speaking, level: speaking ? level : 0, receivedAt: now };
      updateOrb();
    } else if (message.type === "error") {
      const next = message.code === "permission" ? "permission" : message.code === "ended" ? "ended" : "unavailable";
      finish(finishing.current ?? next);
    }
  }

  if (Platform.OS !== "ios" || !CLIENT_URL.startsWith("https://")) return null;
  const inCall = status === "connecting" || status === "listening" || status === "speaking";
  const isClosing = status === "finishing" || status === "saving";
  const orbMode: OrbMode = voiceActor ?? (status === "speaking" ? "nuri"
    : status === "listening" || status === "connecting" ? status : "idle");
  const message = status === "ready" || status === "hidden" ? copy.description
    : isClosing ? copy[status] : voiceActor === "user" ? copy.userSpeaking : orbMode === "nuri" ? copy.speaking : copy[status];

  return <>
    <Pressable
      testID="alpha-live-voice-open"
      accessibilityRole="button"
      accessibilityLabel={copy.title}
      accessibilityState={{ disabled: !allowed || !!disabled }}
      disabled={!allowed || disabled}
      style={[styles.entry, (!allowed || disabled) && styles.disabled]}
      onPress={() => {
        if (pendingSave.current && !isTranscriptPermit(pendingSave.current.body)) pendingSave.current = null;
        setStatus(saving.current ? "saving" : pendingSave.current ? "saveFailed" : "ready");
      }}
    >
      <Ionicons name="pulse-outline" size={22} color={colors.onSurface} />
    </Pressable>
    <Modal
      visible={status !== "hidden"}
      transparent
      animationType={reduceMotion ? "none" : "fade"}
      onRequestClose={() => requestFinish("hidden")}
    >
      <View style={styles.overlay}>
        <View style={styles.panel} accessibilityViewIsModal onAccessibilityEscape={() => requestFinish("hidden")}>
          <Pressable accessibilityRole="button" accessibilityLabel={copy.close} style={styles.close}
            testID="alpha-live-voice-close" onPress={() => requestFinish("hidden")}>
            <Ionicons name="close" size={23} color={colors.onSurface} />
          </Pressable>
          <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelContent} bounces={false}>
            {status !== "hidden" ? <RealtimeVoiceOrb mode={orbMode} level={voiceLevel} reduceMotion={reduceMotion} /> : null}
            <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
            <Text accessibilityLiveRegion="polite" style={styles.detail}>{message}</Text>
            {!isClosing ? <Pressable accessibilityRole="button"
              testID={status === "saveFailed" ? "alpha-live-voice-retry" : inCall ? "alpha-live-voice-end" : "alpha-live-voice-start"}
              style={styles.primary} onPress={() => {
                if (status === "saveFailed" && pendingSave.current) void saveTranscript(pendingSave.current, "hidden");
                else if (inCall) requestFinish("hidden");
                else void begin();
              }}>
              <Text style={styles.actionLabel}>{status === "saveFailed" ? copy.retry : inCall ? copy.end : copy.start}</Text>
            </Pressable> : null}
          </ScrollView>
          {viewAttempt !== null ? <View style={styles.transport} pointerEvents="none" accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants">
            <WebView
              ref={webView}
              key={viewAttempt}
              source={{ uri: CLIENT_URL }}
              onShouldStartLoadWithRequest={(request) => request.url === CLIENT_URL}
              originWhitelist={["*"]}
              onLoad={(event) => {
                if (event.nativeEvent.url !== CLIENT_URL || viewAttempt !== attempt.current || loaded.current) return;
                loaded.current = true;
                webView.current?.injectJavaScript("window.nuriRealtime?.start(); true;");
              }}
              onMessage={(event) => { void receive(event, viewAttempt); }}
              onError={() => { if (viewAttempt === attempt.current) finish("unavailable"); }}
              onHttpError={() => { if (viewAttempt === attempt.current) finish("unavailable"); }}
              onContentProcessDidTerminate={() => { if (viewAttempt === attempt.current) finish("unavailable"); }}
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              mediaCapturePermissionGrantType="grantIfSameHostElseDeny"
              incognito
              sharedCookiesEnabled={false}
              allowFileAccess={false}
              setSupportMultipleWindows={false}
              scrollEnabled={false}
              style={styles.transport}
            />
          </View> : null}
        </View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  entry: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
  overlay: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24, backgroundColor: "rgba(44,33,46,0.40)" },
  panel: { width: "100%", maxWidth: 380, maxHeight: "92%", borderRadius: 28, backgroundColor: "#FFF8F2" },
  panelScroll: { flexGrow: 0, borderRadius: 28 },
  panelContent: { paddingHorizontal: 26, paddingTop: 41, paddingBottom: 28, alignItems: "center" },
  close: { position: "absolute", right: 12, top: 10, width: 44, height: 44, alignItems: "center", justifyContent: "center", zIndex: 1 },
  orbStage: { width: 158, height: 158, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  orbHalo: { position: "absolute", width: 126, height: 126, borderRadius: 63 },
  orbCore: { width: 114, height: 114, borderRadius: 57, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  orbWave: { height: 47, flexDirection: "row", alignItems: "center", gap: 5 },
  orbBar: { width: 4, height: 27, borderRadius: 2, backgroundColor: "#FFFFFF" },
  title: { color: colors.onSurface, fontSize: 23, fontWeight: "600", textAlign: "center" },
  detail: { color: colors.onSurfaceSecondary, fontSize: 15, lineHeight: 23, textAlign: "center", marginTop: 12, marginBottom: 22 },
  primary: { minHeight: 48, minWidth: 150, maxWidth: "100%", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 24, backgroundColor: "#D26470", alignItems: "center", justifyContent: "center" },
  actionLabel: { color: colors.onBrandPrimary, fontSize: 19, fontWeight: "700", textAlign: "center" },
  transport: { width: 2, height: 2, backgroundColor: "transparent", position: "absolute" },
});
