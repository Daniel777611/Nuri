import {useRef} from "react";
import {StyleSheet,View,useWindowDimensions} from "react-native";
import {Image} from "expo-image";

/** Original Figma background pattern (188:63428), then the 188:63430 blur
 * and 50% white veil. Never blur messages or replace the pattern with a
 * screenshot of a screen. Preserve the canvas when the keyboard appears. */
export function FinalChatBackdrop(){
 const {width,height}=useWindowDimensions();
 const canvas=useRef({width,height});
 if(canvas.current.width!==width)canvas.current={width,height};
 else if(height>canvas.current.height)canvas.current.height=height;
 return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="final-chat-background" style={[StyleSheet.absoluteFill,{height:canvas.current.height,overflow:"hidden"}]}>
  <Image source={require("@/assets/final-flow-20261101/chat-background-source.png")} contentFit="cover" blurRadius={20*width/402} style={StyleSheet.absoluteFill} testID="final-chat-background-pattern"/>
  <View style={[StyleSheet.absoluteFill,{backgroundColor:"rgba(255,255,255,.5)"}]} testID="final-chat-background-veil"/>
 </View>;
}
