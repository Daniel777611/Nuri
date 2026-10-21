import { ActivityIndicator, Pressable, View } from "react-native";
import { useT } from "@/src/i18n";
import VoiceWaveform from "@/src/components/VoiceWaveform";
import { GlassSurface, IconAction, NuriText } from "./Primitives";
import { useNuriTheme } from "./Theme";

/** Dictation stays in the composer, never in a separate recording/review page. */
export function VoiceInputBar({ phase, seconds, metered, level, onCancel, onStop, onSend }: {
  phase: "starting" | "recording" | "transcribing";
  seconds: number;
  metered: boolean;
  level: () => number | null;
  onCancel: () => void;
  onStop: () => void;
  onSend: () => void;
}) {
  const { t, locale } = useT();
  const theme = useNuriTheme();
  const recording = phase === "recording";
  const label = (cn: string, en: string, tw: string) => locale === "en" ? en : locale === "zh-TW" ? tw : cn;
  return <GlassSurface kind="composer" contentStyle={{ padding: 6, gap: 6 }} testID={`chat-voice-${phase}`}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44 }}>
      <IconAction name="close" label={t("取消录音")} onPress={onCancel} testID="chat-voice-cancel" />
      {recording ? <>
        <View style={{ flex: 1, minWidth: 24 }}>
          {metered ? <VoiceWaveform level={level} color={theme.ink} testID="chat-voice-waveform" /> : <NuriText role="Caption">{t("正在录音")}</NuriText>}
        </View>
        <NuriText role="Caption" style={{ minWidth: 34 }} testID="chat-voice-timer">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</NuriText>
        <Pressable onPress={onStop} accessibilityRole="button" accessibilityLabel={label("停止并转成文字", "Stop and keep as text", "停止並轉成文字")} style={{ minWidth: 52, minHeight: 44, alignItems: "center", justifyContent: "center" }} testID="chat-voice-stop">
          <NuriText>{label("停止", "Stop", "停止")}</NuriText>
        </Pressable>
        <IconAction name="send" label={label("识别并发送", "Transcribe and send", "辨識並傳送")} onPress={onSend} testID="chat-voice-send" />
      </> : <View style={{ flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <ActivityIndicator />
        <NuriText accessibilityLiveRegion="polite" style={{ flex: 1 }}>{phase === "starting" ? label("正在开启麦克风…", "Starting microphone…", "正在開啟麥克風…") : t("正在识别语音…")}</NuriText>
      </View>}
    </View>
    {recording ? <NuriText secondary role="Caption" style={{ paddingHorizontal: 12, paddingBottom: 6 }}>{label("停止后可编辑，或直接发送。", "Stop to edit, or send directly.", "停止後可編輯，或直接傳送。")}</NuriText> : null}
  </GlassSurface>;
}
