import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { FinalText } from "./Primitives";

/** Original avatar exports and crop slots from 188:65075 / 188:65290. */
export function ParentChatAvatar({size=40}:{size?:32|40}) {
  const header=size===32;
  return <View style={{width:size,height:size,borderRadius:size/1.5,overflow:"hidden",flexShrink:0}}>
    <Image accessible={false} source={header?require("@/assets/final-flow-20261101/parent-header-avatar-background.svg"):require("@/assets/final-flow-20261101/parent-avatar-background.svg")} style={{width:size,height:size}} contentFit="contain"/>
    <Image accessible={false} source={header?require("@/assets/final-flow-20261101/parent-header-avatar.png"):require("@/assets/final-flow-20261101/parent-avatar.png")} style={{position:"absolute",left:header?3.2:4,top:header?9.866:12.332,width:header?25.333:31.667,height:header?22.133:27.667}} contentFit="fill"/>
  </View>;
}

/** One page-owned header, not a second row under the generic settings header.
 * The 44pt original toggle artwork is separate from its semantic switch. */
export function ParentChatHeader({person,participating,status,backLabel,toggleHint,onBack,onToggle}:{
  person:string;participating:boolean;status:string;backLabel:string;toggleHint:string;
  onBack:()=>void;onToggle:(value:boolean)=>void;
}) {
  return <View testID="final-parent-header" style={s.header}>
    <Pressable testID="final-parent-back" accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} style={s.action}>
      <View style={{width:24,height:24}}><Image accessible={false} source={require("@/assets/final-flow-20261101/parent-header-back.svg")} contentFit="contain" style={{position:"absolute",left:8.5,top:5.5,width:7,height:13}}/></View>
    </Pressable>
    <ParentChatAvatar size={32}/>
    <FinalText testID="final-parent-name" size={20} secondary numberOfLines={1} ellipsizeMode="tail" style={{flex:1,minWidth:0,lineHeight:28,fontWeight:"500"}}>{person}</FinalText>
    <FinalText testID="final-parent-ai-status" size={12} secondary numberOfLines={2} style={{width:72,flexShrink:0,lineHeight:18,fontWeight:"500"}}>{status}</FinalText>
    <Pressable testID="final-parent-ai-toggle" accessibilityRole="switch" accessibilityLabel={status} accessibilityHint={toggleHint} accessibilityState={{checked:participating}} aria-checked={participating} onPress={()=>onToggle(!participating)} style={s.action}>
      <Image testID="final-parent-ai-art" accessible={false} source={participating?require("@/assets/final-flow-20261101/parent-ai-on.svg"):require("@/assets/final-flow-20261101/parent-ai-off.svg")} contentFit="contain" style={{width:44,height:44}}/>
    </Pressable>
  </View>;
}
const s=StyleSheet.create({
  header:{minHeight:60,flexShrink:0,paddingLeft:12,paddingRight:24,flexDirection:"row",alignItems:"center",gap:8},
  action:{width:44,height:44,flexShrink:0,alignItems:"center",justifyContent:"center"}
});
