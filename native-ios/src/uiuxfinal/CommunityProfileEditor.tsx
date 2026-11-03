import { useState, type ReactNode } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { useT, translate } from "@/src/i18n";
import { FinalText, FINAL_COLOR } from "./Primitives";

export type CommunityProfileEditorProps = {
  displayName: string;
  city: string;
  about: string;
  onAboutChange: (text: string) => void;
  selectedIntents: readonly number[];
  onToggleIntent: (index: number) => void;
  avatar?: ReactNode;
};

// Indices match the existing Community intent reducer, not their display order.
const INTENTS = [
  { index: 1, width: 123.333, cn: "聊聊育儿心事", tw: "聊聊育兒心事", en: "Parenting chats" },
  { index: 4, width: 88, cn: "在我附近", tw: "在我附近", en: "Nearby" },
  { index: 5, width: 88, cn: "随便聊聊", tw: "隨便聊聊", en: "Just chat" },
  { index: 0, width: 123.333, cn: "交流育儿智慧", tw: "交流育兒智慧", en: "Parenting ideas" },
  { index: 2, width: 88, cn: "经历相似", tw: "經歷相似", en: "Similar lives" },
  { index: 3, width: 86, cn: "一起遛娃", tw: "一起遛娃", en: "Outings" },
] as const;

function OriginalProfilePortrait() {
  return <View style={{ width: 104, height: 104, borderRadius: 69.333, overflow: "hidden" }}>
    <Image source={require("@/assets/final-flow-20261101/community-profile-background.svg")} style={{ width: 104, height: 104 }} contentFit="contain" accessible={false}/>
    <Image source={require("@/assets/final-flow-20261101/community-profile-head.png")} style={{ position: "absolute", left: 10.4, top: 32.0667, width: 82.3333, height: 71.9333 }} contentFit="fill" accessible={false}/>
  </View>;
}

/** Figma 188:63068 card body only. The caller owns its surface, scrolling,
 * keyboard/safe-area treatment and Save action. All edits remain controlled
 * local drafts; this component has no account or transport dependency. */
export function CommunityProfileEditor({ displayName, city, about, onAboutChange, selectedIntents, onToggleIntent, avatar }: CommunityProfileEditorProps) {
  const { locale } = useT();
  const [aboutHeight, setAboutHeight] = useState(44);
  const c = (cn: string, en: string, tw?: string) => locale === "en" ? en : locale === "zh-TW" ? tw ?? translate(locale, cn) : cn;
  const divider = <View style={{ height: 1, backgroundColor: "rgba(77,64,92,.22)" }}/>;

  return <View testID="final-profile-editor-content" style={{ paddingHorizontal: 24, paddingTop: 32, paddingBottom: 19, gap: 16 }}>
    <View style={{ minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8 }}>
      <FinalText size={12} secondary style={{ flex: 1, lineHeight: 18, fontWeight: "500" }}>{c("我的档案", "My profile", "我的檔案")}</FinalText>
      <FinalText size={12} secondary testID="final-profile-editing-status" style={{ minWidth: 72, lineHeight: 16, fontWeight: "500", textAlign: "right" }}>{c("编辑中", "Editing", "編輯中")}</FinalText>
    </View>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 20 }}>
      <View testID="final-profile-editor-portrait" style={{ width: 104, height: 104, flexShrink: 0 }}>{avatar ?? <OriginalProfilePortrait/>}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <FinalText size={36} style={{ lineHeight: 46, fontWeight: "700" }}>{displayName}</FinalText>
        <FinalText size={14} secondary style={{ lineHeight: 18, fontWeight: "500" }}>{city}</FinalText>
        <FinalText size={12} secondary style={{ lineHeight: 18, fontWeight: "500" }}>{c("喜欢“咖啡”，“阅读”，“园艺”", "Enjoys coffee, reading and gardening", "喜歡「咖啡」、「閱讀」、「園藝」")}</FinalText>
      </View>
    </View>
    {divider}
    <FinalText size={18} style={{ lineHeight: 26, fontWeight: "500" }}>{c("我的生活", "My life")}</FinalText>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 16 }}>
      <View style={{ width: "51.2121%", maxWidth: 169, minWidth: 0, gap: 4 }}>
        <FinalText style={{ lineHeight: 24, fontWeight: "500" }}>{c("我的小孩", "My children")}</FinalText>
        <FinalText size={12} secondary style={{ lineHeight: 18 }}>{c("正在经历学龄前阶段", "At the preschool stage", "正在經歷學齡前階段")}</FinalText>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <FinalText style={{ lineHeight: 24, fontWeight: "500" }}>{c("生活节奏", "Daily rhythm", "生活節奏")}</FinalText>
        <FinalText size={12} secondary style={{ lineHeight: 18 }}>{c("喜欢安静的周末活动", "Relaxed weekend activities", "喜歡安靜的週末活動")}</FinalText>
      </View>
    </View>
    {divider}
    <View style={{ gap: 4 }}>
      <FinalText style={{ lineHeight: 24, fontWeight: "500" }}>{c("关于我", "About me", "關於我")}</FinalText>
      <TextInput testID="final-profile-about" accessibilityLabel={c("关于我", "About me", "關於我")} keyboardAppearance="light" multiline value={about} onChangeText={onAboutChange} onContentSizeChange={event=>setAboutHeight(Math.max(44, Math.min(164, Math.ceil(event.nativeEvent.contentSize.height))))} placeholder={c("写一点关于自己的事", "A little about yourself", "寫一點關於自己的事")} placeholderTextColor="#918896" style={{ height: aboutHeight, minHeight: 44, borderRadius: 18, borderWidth: 1, borderColor: "rgba(93,80,96,.25)", backgroundColor: "rgba(255,250,245,.9)", paddingHorizontal: 12, paddingVertical: 11, fontSize: 14, lineHeight: 20, fontWeight: "400", fontFamily: locale === "zh-CN" ? "NotoSansSC_400Regular" : undefined, color: FINAL_COLOR.secondary, textAlignVertical: "top", includeFontPadding: false }}/>
    </View>
    <FinalText style={{ lineHeight: 24, fontWeight: "500" }}>{c("希望和新朋友一起", "With new friends, I'd like to…")}</FinalText>
    <View testID="final-profile-editor-intents" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 4, minHeight: 88, alignItems: "center" }}>
      {INTENTS.map(intent=>{
        const selected = selectedIntents.includes(intent.index);
        return <Pressable key={intent.index} testID={`final-profile-intent-${intent.index}`} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={()=>onToggleIntent(intent.index)} hitSlop={{ top: 4, bottom: 4 }} style={{ width: intent.width, minHeight: 36, paddingHorizontal: 6, paddingVertical: 6, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: selected ? FINAL_COLOR.selected : FINAL_COLOR.base }}>
          <FinalText style={{ lineHeight: 24, textAlign: "center", color: selected ? "white" : FINAL_COLOR.ink }}>{c(intent.cn, intent.en, intent.tw)}</FinalText>
        </Pressable>;
      })}
    </View>
  </View>;
}
