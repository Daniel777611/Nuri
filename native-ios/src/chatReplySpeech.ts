import { NativeModules, Platform } from "react-native";
import { apiRequest } from "./api";

type ReplySpeechBridge = {
  play: (base64Audio: string) => Promise<boolean>;
  stop: () => void;
};

const bridge = Platform.OS === "ios" && process.env.EXPO_PUBLIC_RELEASE_FLAVOR === "live-alpha"
  ? NativeModules.NuriReplySpeechBridge as ReplySpeechBridge | undefined
  : undefined;

export const replySpeechAvailable = Boolean(bridge?.play && bridge?.stop);

export async function speakReply(sessionId: string, messageId: string, isCurrent: () => boolean) {
  if (!bridge || !replySpeechAvailable || !isCurrent()) return;
  const path = `/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/audio`;
  for (let part = 0; isCurrent(); part += 1) {
    const result = await apiRequest<{ audio_base64?: string; has_more?: boolean }>(`${path}?part=${part}`, { method: "POST" }, 28_000);
    if (!isCurrent()) return;
    if (typeof result.audio_base64 !== "string" || !result.audio_base64 || result.audio_base64.length > 3_600_000) {
      throw new Error("Invalid reply audio");
    }
    const finished = await bridge.play(result.audio_base64);
    if (!isCurrent() || !result.has_more) return;
    if (!finished) throw new Error("Reply audio playback interrupted");
  }
}

export function stopReplySpeech() {
  if (replySpeechAvailable) bridge?.stop();
}
