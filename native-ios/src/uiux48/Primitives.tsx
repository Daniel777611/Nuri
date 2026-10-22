import { forwardRef, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type PressableProps, type ScrollViewProps, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import { useT, translate } from "@/src/i18n";
import { useRouter } from "expo-router";
import { useNuriTheme } from "./Theme";
import { GLASS_BLUR48, GLASS_SHADOW48 } from "./materials";
import { TYPE49, type TextRole49 } from "@/src/uiux49/spec";
import { GlassLighting } from "./GlassLighting";

const icons = {
  home: require("@/assets/uiux48/approved-icons/home.svg"), chat: require("@/assets/uiux48/approved-icons/chat.svg"),
  notifications: require("@/assets/uiux48/approved-icons/notifications.svg"), community: require("@/assets/uiux48/approved-icons/community.svg"),
  settings: require("@/assets/uiux48/approved-icons/settings.svg"), plus: require("@/assets/uiux48/approved-icons/plus.svg"),
  mic: require("@/assets/community-redesign/microphone.svg"), expand: require("@/assets/uiux48/approved-icons/expand.svg"),
  collapse: require("@/assets/uiux48/approved-icons/collapse.svg"), send: require("@/assets/uiux48/approved-icons/send.svg"),
  back: require("@/assets/uiux48/approved-icons/back.svg"), play: require("@/assets/uiux48/approved-icons/play.svg"),
  person: require("@/assets/uiux48/approved-icons/person.svg"), chevronRight: require("@/assets/uiux48/approved-icons/chevron-right.svg"),
  arrowRight: require("@/assets/uiux48/approved-icons/arrow-right.svg"), camera: require("@/assets/uiux48/approved-icons/camera.svg"),
  image: require("@/assets/uiux48/approved-icons/image.svg"), close: require("@/assets/uiux48/approved-icons/close.svg"),
};
export type NuriIconName = keyof typeof icons;
export function NuriIcon({ name }: { name: NuriIconName }) {
  const { ink, night } = useNuriTheme();
  // Figma 127:24534: original outline SVG, no material or backing plate.
  // Preserve its daytime artwork; Night is a white alpha-mask tint only.
  return <Image source={icons[name]} style={{ width: 24, height: 24 }} contentFit="contain" tintColor={name === "mic" ? night ? "#FFFFFF" : undefined : ink} testID={`nuri-icon-${name}`} accessible={false} accessibilityElementsHidden />;
}
export function IconAction({ name, label, onPress, testID, disabled }: { name: NuriIconName; label: string; onPress: () => void; testID?: string; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled} testID={testID} style={({ pressed }) => [s.iconTarget, { opacity: disabled ? .4 : pressed ? .6 : 1 }]}><NuriIcon name={name} /></Pressable>;
}
export function NuriText({ children, secondary = false, style, role, ...props }: Omit<import("react-native").TextProps,"role"> & { secondary?: boolean; role?: TextRole49 }) {
  const theme = useNuriTheme();
  const {locale}=useT();const flattened=StyleSheet.flatten(style);
  const size=flattened?.fontSize??16;
  const resolved=role??(size<=12?"Caption":size<=17?"Body":size<=18?"H3":size<=20?"H2":"H1");
  const typography=TYPE49[resolved];
  const weight=resolved==="Body"&&Number(flattened?.fontWeight)>=500?"500":typography.fontWeight;
  // Traditional Chinese uses the platform CJK font, not Simplified glyph forms.
  const fontFamily=locale!=="zh-CN"?undefined:Number(weight)>=500?"NotoSansSC_500Medium":"NotoSansSC_400Regular";
  return <Text {...props} style={[s.body, { color: secondary ? theme.secondary : theme.ink }, style, typography, {fontFamily,fontWeight:weight}]}>{children}</Text>;
}

/** Shadow lives outside the clipped material. Only the material clips; neither
 * the outer shadow nor the card's top/bottom corners belong to a ScrollView. */
export function GlassSurface({ children, style, contentStyle, kind = "card", shadow = true, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; contentStyle?: StyleProp<ViewStyle>; kind?: "card" | "message" | "user" | "composer" | "pill"; shadow?: boolean; testID?: string }) {
  const t = useNuriTheme();
  const radius = kind === "pill" ? 999 : kind === "composer" ? 24 : 28;
  const fill = kind === "message" ? t.message : kind === "user" ? t.userMessage : kind === "composer" ? t.composer : t.glass;
  return <View testID={testID} style={[{ borderRadius: radius, boxShadow: shadow ? kind === "pill" ? GLASS_SHADOW48.floating : GLASS_SHADOW48.surface : undefined }, style]}>
    <View style={{ borderRadius: radius, overflow: "hidden", flexShrink: 1 }}>
      <BlurView intensity={GLASS_BLUR48[t.mode][kind]} tint={t.night ? "dark" : "light"} style={[StyleSheet.absoluteFill,{borderRadius:radius,overflow:"hidden"}]} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
      <GlassLighting radius={radius} night={t.night} control={kind==="composer"||kind==="pill"} />
      <View style={[{flexShrink:1},contentStyle]}>{children}</View>
    </View>
  </View>;
}
export function NuriButton({ label, busy, secondary, style, ...props }: Omit<PressableProps,"children"|"style"> & { label: string; busy?: boolean; secondary?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useNuriTheme();
  return <View style={[s.pill,style]}><Pressable {...props} accessibilityRole={props.accessibilityRole??"button"} accessibilityState={{ disabled: !!props.disabled, busy: !!busy }} style={({ pressed }) => [StyleSheet.absoluteFill,{borderRadius:999,overflow:"hidden",alignItems:"center",justifyContent:"center",opacity:props.disabled?.5:pressed?.7:1}]}>
    <BlurView intensity={GLASS_BLUR48[t.mode].pill} tint={secondary&&t.night?"dark":"light"} style={[StyleSheet.absoluteFill,{borderRadius:999,overflow:"hidden"}]} />
    <View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:secondary?String(t.token("color/welcome38/secondary-tint")):t.coral}]} />
    <GlassLighting radius={999} night={t.night} control />
    {busy ? <ActivityIndicator color={secondary ? t.ink : "white"} /> : <Text style={[s.buttonText, { color: secondary ? t.ink : "white" }]}>{label}</Text>}
  </Pressable></View>;
}
export const NuriField = forwardRef<TextInput,TextInputProps & { label?: string }>(function NuriField({ label, style, ...props }, ref) {
  const t = useNuriTheme();
  return <View style={s.fieldWrap}>{label ? <NuriText secondary style={s.label}>{label}</NuriText> : null}<TextInput keyboardAppearance={t.keyboard.appearance} {...props} ref={ref} placeholderTextColor={t.secondary} style={[s.field,{color:t.ink,backgroundColor:t.composer,borderColor:t.outline},style]} /></View>;
});
export function CenteredCard({ children, testID, maxHeight, scroll = true, contentGap = 20 }: { children: ReactNode; testID?: string; maxHeight?: number; scroll?: boolean; contentGap?: number }) {
  return <View style={s.cardRegion}><GlassSurface testID={testID} style={[s.mainCard, maxHeight ? {maxHeight} : null]} contentStyle={{ padding: 24 }} kind="message">
    {scroll ? <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: contentGap }} style={{flexShrink:1}}>{children}</ScrollView> : children}
  </GlassSurface></View>;
}
/** The KAV is at y=0 inside this wrapper. Measure the wrapper's actual window
 * origin rather than assuming a fixed header/banner/safe-area height. */
export function NuriKeyboardFrame({children}:{children:ReactNode}) {
 const frame=useRef<View>(null);const [origin,setOrigin]=useState(0);
 return <View ref={frame} style={{flex:1,minHeight:0}} onLayout={()=>frame.current?.measureInWindow((_x,y)=>setOrigin(y))}><KeyboardAvoidingView style={{flex:1,minHeight:0}} behavior={Platform.OS==="ios"?"padding":"height"} keyboardVerticalOffset={origin}>{children}</KeyboardAvoidingView></View>;
}
export function AuthFrame({ children, testID, contentGap }: {children:ReactNode;testID?:string;contentGap?:number}) { return <NuriKeyboardFrame><CenteredCard testID={testID} contentGap={contentGap}>{children}</CenteredCard></NuriKeyboardFrame>; }
export function CardList({ children, heading, ...props }: ScrollViewProps & {heading?:string}) { return <View style={[s.cardRegion,heading?{gap:20}:null]}>{heading?<NuriText style={{fontSize:20,fontWeight:"500"}}>{heading}</NuriText>:null}<GlassSurface style={[s.mainCard,{flexShrink:1}]} contentStyle={{padding:24,flexShrink:1}} kind="message"><ScrollView {...props} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[{gap:16,paddingBottom:4},props.contentContainerStyle]}>{children}</ScrollView></GlassSurface></View>; }
/** Multi-card settings layout from Figma48: short stacks center, while long
 * stacks scroll without shrinking cards or clipping their projected shadows. */
export function CardStack({children,testID}:{children:ReactNode;testID?:string}) {
 return <ScrollView testID={testID} style={{flex:1,minHeight:0}} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{flexGrow:1,justifyContent:"center",paddingHorizontal:24,paddingTop:32,paddingBottom:40,gap:12}}>{children}</ScrollView>;
}
export function FormTabs({ active }: { active: "login" | "register" }) {
  const { locale } = useT(); const { ink, secondary } = useNuriTheme();
  const router = useRouter();
  return <View style={{flexDirection:"row",height:44}}>{(["login","register"] as const).map(tab => <Pressable key={tab} onPress={()=>router.replace(tab === "login" ? "/login" : "/register")} accessibilityRole="tab" accessibilityState={{selected:active===tab}} testID={`auth-tab-${tab}`} style={{flex:1,alignItems:"center",justifyContent:"center",gap:8}}><Text style={{fontSize:16,color:active===tab?ink:secondary}}>{tab==="login"?(locale==="en"?"Log in":translate(locale, "登录")):(locale==="en"?"Create account":translate(locale, "创建账号"))}</Text><View style={{height:2,width:64,backgroundColor:ink,opacity:active===tab?1:0}} /></Pressable>)}</View>;
}
export function InlineState({ message, busy, action, onPress }: { message: string; busy?: boolean; action?: string; onPress?: () => void }) { return <View accessibilityLiveRegion="polite" style={{gap:16,paddingVertical:12}}>{busy?<ActivityIndicator />:null}<NuriText secondary>{message}</NuriText>{action&&onPress?<NuriButton label={action} onPress={onPress} secondary />:null}</View>; }
export function MenuRow({label,detail,onPress,testID,danger=false,disabled=false,density="default",separator=true}:{label:string;detail?:string;onPress:()=>void;testID?:string;danger?:boolean;disabled?:boolean;density?:"default"|"community"|"list";separator?:boolean}) {
 const t=useNuriTheme();
 const community=density==="community";
 return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" testID={testID} style={{minHeight:50,paddingVertical:community?20:14,flexDirection:"row",gap:12,alignItems:"center",borderBottomWidth:separator?1:0,borderBottomColor:t.outline,opacity:disabled?.45:1}}><View style={{flex:1,gap:community?6:5}}><NuriText role={community?"H3":"Body"} style={danger?{color:"#a25563"}:undefined}>{label}</NuriText>{detail?<NuriText secondary role={community||density==="list"?"Body":"Caption"}>{detail}</NuriText>:null}</View><NuriIcon name="chevronRight" /></Pressable>;
}
export function ToggleRow({label,value,onChange,testID,disabled=false}:{label:string;value:boolean;onChange:(v:boolean)=>void;testID?:string;disabled?:boolean}) {
 const t=useNuriTheme();
 return <View style={{minHeight:50,flexDirection:"row",alignItems:"center",gap:12,opacity:disabled?.45:1}}><NuriText style={{flex:1,fontSize:16,lineHeight:22}}>{label}</NuriText><Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled} testID={testID} thumbColor="#ffffff" trackColor={{true:"#765f88",false:t.outline}} /></View>;
}
export function ChoiceChip({label,selected,onPress,testID,disabled=false,compact=false}:{label:string;selected:boolean;onPress:()=>void;testID?:string;disabled?:boolean;compact?:boolean}) { const t=useNuriTheme();return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="checkbox" accessibilityState={{checked:selected,disabled}} aria-checked={selected} testID={testID} style={{minWidth:compact?64:92,flexGrow:compact?0:1,maxWidth:"100%",opacity:disabled?.45:1}}><GlassSurface kind="pill" shadow={false} contentStyle={{minHeight:compact?44:50,paddingVertical:8,paddingHorizontal:compact?14:8,alignItems:"center",justifyContent:"center",backgroundColor:selected?String(t.token("color/control/choice-selected-36")):"transparent",borderWidth:1,borderColor:selected?String(t.token("color/control/choice-selected-border-36")):"transparent",borderRadius:999}}><NuriText style={{fontSize:16,lineHeight:24}}>{label}</NuriText></GlassSurface></Pressable>; }
const s = StyleSheet.create({
  iconTarget:{width:44,height:44,alignItems:"center",justifyContent:"center"},
  body:{...TYPE49.Body,textAlign:"left"},
  pill:{width:278,maxWidth:"100%",height:50,alignSelf:"center",borderRadius:999,alignItems:"center",justifyContent:"center",boxShadow:GLASS_SHADOW48.button},
  buttonText:{...TYPE49.Body,fontWeight:"500",textAlign:"center"},
  fieldWrap:{gap:8,width:"100%"},label:{...TYPE49.Body},
  field:{height:54,borderRadius:10,borderWidth:1,paddingHorizontal:16,fontSize:16,textAlign:"left"},
  cardRegion:{flex:1,justifyContent:"center",paddingHorizontal:24,paddingVertical:24},
  mainCard:{width:"100%",maxWidth:500,alignSelf:"center",flexShrink:1},
});
