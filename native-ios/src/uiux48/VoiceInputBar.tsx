import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Platform, Pressable, View } from "react-native";
import { Image } from "expo-image";
import { useT } from "@/src/i18n";
import VoiceWaveform from "@/src/components/VoiceWaveform";
import { IconAction } from "./Primitives";
import { useNuriTheme } from "./Theme";
import { FinalSurface, FinalText } from "@/src/uiuxfinal/Primitives";

const stopArtwork=require("@/assets/final-flow-20261101/voice-stop-32.svg");
const sendArtwork=require("@/assets/final-flow-20261101/voice-send-32.svg");
// Figma188:64135 has56 samples twice, translated−336pt over4s, linear/loop.
// This authored trace is only for explicitly labelled local previews. Real
// recording keeps its microphone-driven meter, including actual silence.
const PREVIEW_SAMPLES=[4,6,10,18,26,14,8,12,22,30,18,10,6,4,8,16,24,32,20,12,8,10,18,28,22,14,8,4,6,12,20,28,18,10,8,14,24,30,20,12,6,4,10,18,26,16,8,6,12,22,30,24,16,10,6,4];
export function VoicePreviewWaveform(){
  const translation=useRef(new Animated.Value(0)).current;
  const [reduced,setReduced]=useState(true);
  useEffect(()=>{
    let alive=true;
    const update=(value:boolean)=>{if(alive)setReduced(value);};
    void AccessibilityInfo.isReduceMotionEnabled().then(update).catch(()=>{});
    const subscription=AccessibilityInfo.addEventListener("reduceMotionChanged",update);
    return()=>{alive=false;subscription.remove();};
  },[]);
  useEffect(()=>{
    translation.setValue(0);
    if(reduced)return;
    const loop=Animated.loop(Animated.timing(translation,{toValue:-336,duration:4000,easing:Easing.linear,useNativeDriver:Platform.OS!=="web"}));
    loop.start();return()=>{loop.stop();translation.setValue(0);};
  },[reduced,translation]);
  return <View style={{height:32,overflow:"hidden",width:"100%"}} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Animated.View testID="chat-voice-preview-motion" style={{position:"absolute",left:0,top:0,width:672,height:32,flexDirection:"row",alignItems:"center",gap:3,paddingRight:3,transform:[{translateX:translation}]}}>{[...PREVIEW_SAMPLES,...PREVIEW_SAMPLES].map((height,index)=><View key={index} style={{width:3,height,borderRadius:1.5,backgroundColor:"#5C5662",flexShrink:0}} />)}</Animated.View></View>;
}

/** Dictation stays in the composer, never in a separate recording/review page. */
export function VoiceInputBar({ phase, seconds, metered, level, onCancel, onStop, onSend, previewOnly=false }: {
  phase: "starting" | "recording" | "transcribing";
  seconds: number;
  metered: boolean;
  level: () => number | null;
  onCancel: () => void;
  onStop: () => void;
  onSend: () => void;
  previewOnly?:boolean;
}) {
  const { t, locale } = useT();
  const theme = useNuriTheme();
  const recording = phase === "recording";
  const label = (cn: string, en: string, tw: string) => locale === "en" ? en : locale === "zh-TW" ? tw : cn;
  const elapsed=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`;
  const previewLabel=label("语音演示 · 未录音","Voice preview · Not recording","語音示範 · 未錄音");
  const surface=<FinalSurface radius={999} surfaceColor="rgba(255,250,242,.64)" contentStyle={{height:60,padding:8,flexDirection:"row",alignItems:"center",gap:12}} testID={`chat-voice-${phase}`}>
    {recording?<>
      <Pressable testID="chat-voice-cancel" accessible accessibilityRole="button" accessibilityLabel={`${previewOnly?previewLabel:t("正在录音")} · ${elapsed}`} accessibilityHint={label("长按取消录音；或使用取消操作。","Hold to cancel, or choose the Cancel action.","長按取消錄音；或使用取消操作。")} accessibilityActions={[{name:"cancel",label:t("取消录音")}]} onAccessibilityAction={event=>{if(event.nativeEvent.actionName==="cancel")onCancel();}} onAccessibilityEscape={onCancel} onLongPress={onCancel} style={{flex:1,minWidth:24,height:32,justifyContent:"center"}}>
        {previewOnly?<VoicePreviewWaveform/>:metered?<VoiceWaveform level={level} color={theme.ink} testID="chat-voice-waveform"/>:<FinalText size={12}>{t("正在录音")}</FinalText>}
      </Pressable>
      <Pressable onPress={onStop} accessibilityRole="button" accessibilityLabel={label("停止并转成文字","Stop and keep as text","停止並轉成文字")} style={{width:44,height:44,alignItems:"center",justifyContent:"center",flexShrink:0}} testID="chat-voice-stop"><Image source={stopArtwork} style={{width:32,height:32}} contentFit="contain" accessible={false} accessibilityElementsHidden/></Pressable>
      <Pressable onPress={onSend} accessibilityRole="button" accessibilityLabel={label("识别并发送","Transcribe and send","辨識並傳送")} style={{width:44,height:44,alignItems:"center",justifyContent:"center",flexShrink:0}} testID="chat-voice-send"><Image source={sendArtwork} style={{width:32,height:32}} contentFit="contain" accessible={false} accessibilityElementsHidden/></Pressable>
    </>:<>
      <IconAction name="close" label={t("取消录音")} onPress={onCancel} testID="chat-voice-cancel" />
      <ActivityIndicator/>
      <FinalText size={12} accessibilityLiveRegion="polite" style={{flex:1,minWidth:0}}>{phase==="starting"?label("正在开启麦克风…","Starting microphone…","正在開啟麥克風…"):t("正在识别语音…")}</FinalText>
    </>}
  </FinalSurface>;
  return previewOnly&&recording?<View style={{gap:4}}><FinalText size={12} style={{textAlign:"right"}}>{previewLabel}</FinalText>{surface}</View>:surface;
}
