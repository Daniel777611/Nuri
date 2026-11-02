import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextProps, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { useT } from "@/src/i18n";
export const FINAL_COLOR = { ink: "#4A454D", secondary: "#706A74", accent: "#735C84", selected: "#C1A0DD", coral: "#EB8183", base: "#FFFAF2" } as const;
export function FinalText({ children, size = 16, secondary = false, style, ...props }: TextProps & {
    size?: number;
    secondary?: boolean;
}) {
    const { locale } = useT();
    return <Text {...props} style={[{ fontSize: size, lineHeight: size >= 18 ? 28 : size <= 12 ? 16 : 24, color: secondary ? FINAL_COLOR.secondary : FINAL_COLOR.ink, fontFamily: locale === "zh-CN" ? "NotoSansSC_400Regular" : undefined, textAlign: "left" }, style]}>{children}</Text>;
}
/** The shadow is outside the rounded clip. Lists scroll inside the material. */
export function FinalSurface({ children, style, contentStyle, fill = false, testID, radius=28 }: {
    children: ReactNode;
    style?: StyleProp<ViewStyle>;
    contentStyle?: StyleProp<ViewStyle>;
    fill?: boolean;
    testID?: string;
    radius?:number;
}) {
    return <View testID={testID} style={[{ borderRadius: radius, boxShadow: "0px 1px 15px rgba(92,86,98,.18)", ...(fill ? { flex: 1, minHeight: 0 } : { flexShrink: 1 }) }, style]}>
    <View style={{ borderRadius: radius, overflow: "hidden", ...(fill ? { flex: 1, minHeight: 0 } : { flexShrink: 1 }) }}>
      <BlurView tint="light" intensity={20} style={StyleSheet.absoluteFill} pointerEvents="none"/>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(255,255,255,.5)" }]}/>
      <View style={[fill ? { flex: 1, minHeight: 0 } : { flexShrink: 1 }, contentStyle]}>{children}</View>
    </View>
  </View>;
}
export function FinalButton({ label, onPress, secondary = false, disabled = false, testID, small = false }: {
    label: string;
    onPress: () => void;
    secondary?: boolean;
    disabled?: boolean;
    testID?: string;
    small?: boolean;
}) {
    return <Pressable onPress={onPress} disabled={disabled} testID={testID} accessibilityRole="button" accessibilityState={{ disabled }} style={({ pressed }) => ({ width: small ? 144 : 212, flexShrink:1, maxWidth: "100%", minHeight: 50, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 25, backgroundColor: secondary ? "rgba(255,250,244,.75)" : FINAL_COLOR.coral, alignSelf: "center", alignItems: "center", justifyContent: "center", opacity: disabled ? .5 : pressed ? .7 : 1, boxShadow: "0px 2px 8px rgba(62,37,34,.10)" })}>
    <FinalText style={{ color: secondary ? FINAL_COLOR.ink : "white", textAlign: "center" }}>{label}</FinalText>
  </Pressable>;
}
export function FinalDivider() { return <View style={{ height: 1, backgroundColor: "rgba(115,92,132,.20)", alignSelf: "stretch" }}/>; }
export function FinalCardPage({children,testID}:{children:ReactNode;testID?:string}){
 return <View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:16,paddingBottom:34}}><FinalSurface fill testID={testID}><ScrollView style={{flex:1,minHeight:0}} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:24,gap:16}}>{children}</ScrollView></FinalSurface></View>;
}
