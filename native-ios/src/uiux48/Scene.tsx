import { useRef } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useNuriTheme } from "./Theme";
import { SCENE48 } from "./sceneGeometry";

const scenes = {
  Morning: { room: require("@/assets/uiux48/imgNuriSceneRoomMorning.png"), mascot: require("@/assets/uiux48/imgNuriMascotIndividualEditableColorLayers.svg"), avatar: require("@/assets/uiux48/avatar-morning.svg"), horizon: require("@/assets/uiux48/welcome-morning-imgSceneDistantGentleHorizon.svg"), ground: require("@/assets/uiux48/welcome-morning-imgSceneBroadOpenGround.svg"), body: require("@/assets/uiux48/welcome-morning-imgNuriFullBodyLinked.svg") },
  Afternoon: { room: require("@/assets/uiux48/community-afternoon-imgNuriSceneRoomAfternoon.png"), mascot: require("@/assets/uiux48/home-afternoon-imgNuriMascotIndividualEditableColorLayers.svg"), avatar: require("@/assets/uiux48/home-afternoon-imgNuriPortraitEditableCharacter.svg"), horizon: require("@/assets/uiux48/welcome-afternoon-imgSceneDistantGentleHorizon.svg"), ground: require("@/assets/uiux48/welcome-afternoon-imgSceneBroadOpenGround.svg"), body: require("@/assets/uiux48/welcome-afternoon-imgNuriFullBodyLinked.svg") },
  Night: { room: require("@/assets/uiux48/chat-night-imgNuriSceneRoomNight.png"), mascot: require("@/assets/uiux48/home-night-imgNuriMascotIndividualEditableColorLayers.svg"), avatar: require("@/assets/uiux48/home-night-imgNuriPortraitEditableCharacter.svg"), horizon: require("@/assets/uiux48/welcome-night-imgSceneDistantGentleHorizon.svg"), ground: require("@/assets/uiux48/welcome-night-imgSceneBroadOpenGround.svg"), body: require("@/assets/uiux48/welcome-night-imgNuriFullBodyLinked.svg") },
};
const shadows = {
  welcome: {
    Morning: require("@/assets/uiux48/approved-shadows/welcome-morning-shadow.png"),
    Afternoon: require("@/assets/uiux48/approved-shadows/welcome-afternoon-shadow.png"),
    Night: require("@/assets/uiux48/approved-shadows/welcome-night-shadow.png"),
  },
  home: {
    Morning: require("@/assets/uiux48/approved-shadows/home-morning-shadow.png"),
    Afternoon: require("@/assets/uiux48/approved-shadows/home-afternoon-shadow.png"),
    Night: require("@/assets/uiux48/approved-shadows/home-night-shadow.png"),
  },
};

/** The room/character canvas does not reflow when a keyboard shrinks the
 * foreground. Width/orientation changes intentionally establish a new canvas. */
export function NuriScene({ welcome = false, mascot = false, focused = false }: { welcome?: boolean; mascot?: boolean; focused?: boolean }) {
  const { width, height } = useWindowDimensions();
  const canvas = useRef({ width, height });
  if (canvas.current.width !== width) canvas.current = { width, height };
  else if (height > canvas.current.height) canvas.current.height = height;
  const t = useNuriTheme(); const a = scenes[t.mode]; const scale = width / 402;
  // The exported shadow includes 43pt of left-side overflow. Use its render
  // bounds, not the group's nominal 354pt frame, to avoid stretching the cast.
  const role = welcome ? "welcome" : "home"; const geometry = welcome?SCENE48[role][t.mode]:{actor:{left:116.36735,top:324.04724,width:221.2653,height:295.90546},shadow:{left:7,top:333,width:395,height:332}};
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill,{height:canvas.current.height,overflow:"hidden"}]} testID="nuri-scene">
    {welcome ? <LinearGradient colors={[String(t.token("color/welcome37/sky-top")),String(t.token("color/welcome37/sky-bottom"))]} style={StyleSheet.absoluteFill} /> : <Image source={require("@/assets/final-flow-20261101/home-room.png")} style={StyleSheet.absoluteFill} contentFit="cover" />}
    <View style={{width:402,height:874,transform:[{scale}],transformOrigin:"top left"}}>
      {welcome ? <><Image source={a.horizon} style={{position:"absolute",left:-122,top:446,width:650,height:160}} /><Image source={a.ground} style={{position:"absolute",left:0,top:0,width:402,height:874}} /></> : null}
      {welcome || mascot ? <><View style={{position:"absolute",...geometry.shadow,mixBlendMode:"multiply"}} testID={`${role}-ground-shadow`}><Image source={welcome?shadows[role][t.mode]:require("@/assets/final-flow-20261101/home-shadow-alpha.png")} style={{width:geometry.shadow.width,height:geometry.shadow.height}} contentFit="contain" /></View><Image source={welcome?a.body:require("@/assets/final-flow-20261101/home-mascot.svg")} style={{position:"absolute",...geometry.actor}} contentFit="contain" testID={welcome?"welcome-mascot":"home-mascot"} /></> : null}
    </View>
    {focused && !welcome ? <View style={[StyleSheet.absoluteFill,{backgroundColor:String(t.token("color/scene/chat-focus-scrim"))}]} /> : null}
  </View>;
}
export function NuriAvatar({size=34}:{size?:number}={}) { const { mode } = useNuriTheme(); return <View style={{width:size,height:size}}><View style={{width:34,height:34,borderRadius:17,overflow:"hidden",backgroundColor:"rgba(245,237,222,.12)",borderWidth:1,borderColor:"rgba(255,255,255,.35)",transform:[{scale:size/34}],transformOrigin:"top left"}}><Image source={scenes[mode].avatar} style={{width:84.24,height:112.657,position:"absolute",left:-12.42,top:-3.43}} /></View></View>; }
