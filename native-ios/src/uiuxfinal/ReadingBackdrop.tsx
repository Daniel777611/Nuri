import {StyleSheet,View,useWindowDimensions} from "react-native";
import {Image} from "expo-image";

/** Original muted landscape + Figma's continuous 62% cream reading veil. */
export function FinalReadingBackdrop(){
 const {width}=useWindowDimensions();
 return <View testID="final-reading-background" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
  <Image accessible={false} source={require("@/assets/final-flow-20261101/reading-background.png")} contentFit="cover" blurRadius={12*width/402} style={StyleSheet.absoluteFill}/>
  <View style={[StyleSheet.absoluteFill,{backgroundColor:"rgba(255,250,242,.62)"}]}/>
 </View>;
}
