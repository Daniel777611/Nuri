import { forwardRef } from "react";
import { Platform, Pressable, StyleSheet, View, type ColorValue, type PressableProps, type PressableStateCallbackType, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";

/** Shared button-only backdrop. Figma40 exports as CSS20px; native intensity
 * is a public material strength, not a promise of a physical40pt blur kernel.
 * Colour/disabled alpha is composited AFTER blur, never on the label or on
 * the entire blur group (which would expose an unblurred backdrop again). */
export function ButtonBackdrop({color,opacity=1,radius=25,blurRadius=40,radii,testID}:{color:ColorValue;opacity?:ViewStyle["opacity"];radius?:number;blurRadius?:number;radii?:ViewStyle;testID?:string}){
  const blur=Math.max(0,Math.min(100,blurRadius));
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID={testID} style={[StyleSheet.absoluteFill,{borderRadius:radius,overflow:"hidden"},radii]}>
    {Platform.OS==="web"?<View pointerEvents="none" style={[StyleSheet.absoluteFill,{backdropFilter:`blur(${blur/2}px)`,WebkitBackdropFilter:`blur(${blur/2}px)`} as ViewStyle]}/>:<BlurView pointerEvents="none" intensity={blur} tint="light" style={StyleSheet.absoluteFill}/>}
    <View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:color,opacity}]}/>
  </View>;
}

/** Drop-in for painted controls only. Unpainted icon actions stay unpainted.
 * The original ref, hit target, event handlers, disabled flag and text remain
 * owned by the same Pressable; only its background paint moves behind blur. */
export const FrostedPressable=forwardRef<View,PressableProps & {blurRadius?:number}>(function FrostedPressable({style,children,blurRadius=40,...props},ref){
  const resolved=(state:PressableStateCallbackType)=>StyleSheet.flatten(typeof style==="function"?style(state):style)??{};
  const painted=(value:ViewStyle)=>value.backgroundColor!==undefined&&value.backgroundColor!=="transparent";
  return <Pressable {...props} ref={ref} style={state=>{
    const value=resolved(state);
    return painted(value)?{...value,backgroundColor:"transparent",opacity:1}:value;
  }}>{state=>{
    const value=resolved(state),hasPaint=painted(value);
    return <>{hasPaint?<ButtonBackdrop color={value.backgroundColor!} opacity={value.opacity??1} radius={typeof value.borderRadius==="number"?value.borderRadius:0} blurRadius={blurRadius} radii={{borderTopLeftRadius:value.borderTopLeftRadius,borderTopRightRadius:value.borderTopRightRadius,borderBottomLeftRadius:value.borderBottomLeftRadius,borderBottomRightRadius:value.borderBottomRightRadius}} testID={props.testID?`${props.testID}-material`:undefined}/>:null}{typeof children==="function"?children(state):children}</>;
  }}</Pressable>;
});
