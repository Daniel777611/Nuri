import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextProps, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { useT } from "@/src/i18n";
import { FrostedPressable } from "./ButtonMaterial";
export const FINAL_COLOR = { ink: "#4A454D", secondary: "#706A74", accent: "#735C84", selected: "#C1A0DD", coral: "#EB8183", base: "#FFFAF2" } as const;
export function FinalText({ children, size = 16, secondary = false, style, ...props }: TextProps & {
    size?: number;
    secondary?: boolean;
}) {
    const { locale } = useT();
    const resolved=StyleSheet.flatten(style),weight=resolved?.fontWeight;
    const numericWeight=weight==="bold"?700:Number(weight)||400;
    const fontFamily=locale!=="zh-CN"?undefined:numericWeight>=700?"NotoSansSC_700Bold":numericWeight>=600?"NotoSansSC_600SemiBold":numericWeight>=500?"NotoSansSC_500Medium":"NotoSansSC_400Regular";
    const face=resolved?.fontFamily??fontFamily;
    // Expo registers each named font face separately, with a normal CSS weight.
    // Asking the browser to embolden that already-medium/bold face doubles it.
    const namedWeight=face?.startsWith("NotoSansSC_");
    return <Text {...props} style={[{ fontSize: size, lineHeight: size >= 18 ? 28 : size <= 12 ? 16 : 24, color: secondary ? FINAL_COLOR.secondary : FINAL_COLOR.ink, textAlign: "left" }, style, {fontFamily:face,...(namedWeight?{fontWeight:"400" as const}:null)}]}>{children}</Text>;
}
/** The shadow is outside the rounded clip. Lists scroll inside the material. */
export function FinalSurface({ children, style, contentStyle, fill = false, testID, radius=28, material="card", surfaceColor, bordered=false }: {
    children: ReactNode;
    style?: StyleProp<ViewStyle>;
    contentStyle?: StyleProp<ViewStyle>;
    fill?: boolean;
    testID?: string;
    radius?:number;
    material?:"card"|"navigation"|"community-navigation"|"reading";
    surfaceColor?:string;
    bordered?:boolean;
}) {
    // Figma background-blur radii 40/20 export as CSS blur 20/10px. Expo's
    // native intensity is a material strength, NOT a physical blur radius.
    const communityNavigation=material==="community-navigation",navigation=material==="navigation"||communityNavigation,reading=material==="reading";
    return <View testID={testID} style={[{ borderRadius: radius, boxShadow: communityNavigation?"0px 0px 8px rgba(0,0,0,.12)":navigation?"0px 4px 10px rgba(0,0,0,.125)":reading?"0px 1px 10px rgba(0,0,0,.1)":"0px 1px 15px rgba(92,86,98,.18)", ...(fill ? { flex: 1, minHeight: 0 } : { flexShrink: 1 }) }, style]}>
    <View style={{ borderRadius: radius, overflow: "hidden", ...(fill ? { flex: 1, minHeight: 0 } : { flexShrink: 1 }) }}>
      {Platform.OS==="web"?<View pointerEvents="none" style={[StyleSheet.absoluteFill,{backdropFilter:`blur(${navigation||reading?10:20}px)`} as ViewStyle]}/>:<BlurView tint="light" intensity={navigation||reading?20:40} style={StyleSheet.absoluteFill} pointerEvents="none"/>}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: surfaceColor??(communityNavigation?"rgba(255,255,255,.4)":"rgba(255,255,255,.5)") }]}/>
      {reading||bordered?<View pointerEvents="none" style={[StyleSheet.absoluteFill,{borderRadius:radius,borderWidth:1,borderColor:"white"}]}/>:null}
      <View style={[fill ? { flex: 1, minHeight: 0 } : { flexShrink: 1 }, contentStyle]}>{children}</View>
    </View>
  </View>;
}
/** Message fills are opaque cream / translucent coral, not glass cards. */
export function FinalChatBubble({children,incoming,style,testID}:{children:ReactNode;incoming:boolean;style?:StyleProp<ViewStyle>;testID?:string}){
 return <View testID={testID} style={[{borderRadius:18,padding:16,boxShadow:"0px 0px 8px rgba(0,0,0,.1)",backgroundColor:incoming?FINAL_COLOR.base:"rgba(235,129,131,.15)",flexShrink:1},style]}>{children}</View>;
}
export function FinalButton({ label, onPress, secondary = false, disabled = false, testID, small = false }: {
    label: string;
    onPress: () => void;
    secondary?: boolean;
    disabled?: boolean;
    testID?: string;
    small?: boolean;
}) {
    return <FrostedPressable onPress={onPress} disabled={disabled} testID={testID} accessibilityRole="button" accessibilityState={{ disabled }} style={({ pressed }) => ({ width: small ? 144 : 212, flexShrink:1, maxWidth: "100%", minHeight: 50, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 25, backgroundColor: secondary ? (disabled?"rgba(255,250,244,.375)":"rgba(255,250,244,.75)") : disabled?"rgba(235,129,131,.2)":FINAL_COLOR.coral, alignSelf: "center", alignItems: "center", justifyContent: "center", opacity: pressed ? .7 : 1, boxShadow: "0px 2px 8px rgba(62,37,34,.10)" })}>
    <FinalText style={{ color: secondary ? FINAL_COLOR.ink : "white", textAlign: "center" }}>{label}</FinalText>
  </FrostedPressable>;
}
export function FinalDivider() { return <View style={{ height: 1, backgroundColor: "rgba(115,92,132,.20)", alignSelf: "stretch" }}/>; }
export function FinalCardPage({children,testID}:{children:ReactNode;testID?:string}){
 return <View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:16,paddingBottom:34}}><FinalSurface fill testID={testID}><ScrollView style={{flex:1,minHeight:0}} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:24,gap:16}}>{children}</ScrollView></FinalSurface></View>;
}
