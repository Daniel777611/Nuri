import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, Text, View, type KeyboardEvent } from "react-native";
import { usePathname, useRouter, useSegments, useGlobalSearchParams } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { useT, translate } from "@/src/i18n";
import NativePageControls from "@/src/components/NativePageControls";
import { requestGuardedNativeNavigation } from "@/src/components/nativeNavigation";
import { NuriScene } from "./Scene";
import { useNuriTheme } from "./Theme";
import { NuriIcon } from "./Primitives";
import { FINAL_COLOR, FinalSurface } from "@/src/uiuxfinal/Primitives";
import { FinalChatBackdrop } from "@/src/uiuxfinal/ChatBackdrop";
import { FinalReadingBackdrop } from "@/src/uiuxfinal/ReadingBackdrop";
import { keyboardPanelTop } from "./keyboard";

export function NuriShell({ children }: { children: ReactNode }) {
  const path=usePathname(); const segments=useSegments(); const {night,mode,keyboard:keyboardTheme}=useNuriTheme();
  const [keyboard,setKeyboard]=useState(false);
  const root=useRef<View>(null);
  const [rootFrame,setRootFrame]=useState({y:0,width:0,height:0});
  const [keyboardFrame,setKeyboardFrame]=useState<KeyboardEvent["endCoordinates"]|null>(null);
  useEffect(()=>{
    const show=(event:KeyboardEvent)=>{if(Platform.OS==="ios")Keyboard.scheduleLayoutAnimation(event);setKeyboard(true);setKeyboardFrame(event.endCoordinates);};
    const hide=()=>{setKeyboard(false);setKeyboardFrame(null);};
    const change=(event:KeyboardEvent)=>{Keyboard.scheduleLayoutAnimation(event);setKeyboardFrame(event.endCoordinates);};
    const listeners=[Keyboard.addListener("keyboardWillShow",show),Keyboard.addListener("keyboardWillHide",hide),Keyboard.addListener("keyboardDidShow",show),Keyboard.addListener("keyboardDidHide",hide),Keyboard.addListener("keyboardWillChangeFrame",change)];
    return()=>listeners.forEach(listener=>listener.remove());
  },[]);
  const panelTop=Platform.OS==="ios"&&keyboard?keyboardPanelTop(keyboardFrame,rootFrame):null;
  const welcome=path==="/welcome";
  const {uiState,communityHeader,communityBackdrop,communityHideTabs}=useGlobalSearchParams<{uiState?:string;communityHeader?:string;communityBackdrop?:string;communityHideTabs?:string}>();
  const community=path==="/community"&&process.env.EXPO_PUBLIC_FLOW_PROTOTYPE==="1";
  const parentChat=community&&(communityHeader==="parent-chat"||communityHeader===undefined&&["chat","chatOn","consent"].includes(String(uiState)));
  const signedOutResult=path==="/account-deletion"&&uiState==="deleted";
  const home=segments[0]==="(tabs)"&&path==="/";
  const chat=path==="/chats"||path.startsWith("/chat/");
  const reading=path==="/daily-post"||path==="/daily-video";
  const auth=/^\/(welcome|login|register|verify-email|forgot-password|onboarding|ai-permission)$/.test(path);
  const communitySettings=community&&(communityBackdrop==="settings"||communityBackdrop===undefined&&["preferences","blocked","blockedEmpty","parentSettings","safetyConfirm","profileSettings"].includes(String(uiState)));
  const settings=/^\/(profile|child|notification-settings|account-deletion|ai-permission)(\/|$)/.test(path)||communitySettings;
  return <View ref={root} onLayout={()=>root.current?.measureInWindow((_x,y,width,height)=>setRootFrame(previous=>previous.y===y&&previous.width===width&&previous.height===height?previous:{y,width,height}))} testID={`nuri-shell-${mode}`} style={{flex:1,backgroundColor:night?"#2d2942":"#f5edde"}}>
    <StatusBar style={night?"light":"dark"} />
    {community?parentChat||communityBackdrop==="plain"?<FinalChatBackdrop scene="parent"/>:<Image source={communityBackdrop==="final-bottle"?require("@/assets/final-flow-20261101/bottle-background.png"):require("@/assets/final-flow-20261101/community-background.png")} contentFit="cover" style={StyleSheet.absoluteFill} testID="community-approved-background" />:chat?<FinalChatBackdrop/>:reading?<FinalReadingBackdrop/>:!auth&&!home?<LinearGradient colors={["#FFFAF5","#F9F5F2","#F2EEEE"]} style={StyleSheet.absoluteFill}/>:<NuriScene welcome={welcome} mascot={home} focused={!welcome&&!home} />}
    {settings?<View pointerEvents="none" style={StyleSheet.absoluteFill}><Image source={require("@/assets/final-flow-20261101/settings-background.png")} contentFit="cover" style={StyleSheet.absoluteFill}/><View style={[StyleSheet.absoluteFill,{backgroundColor:"rgba(255,250,242,.78)"}]}/>{Platform.OS==="web"?<View style={[StyleSheet.absoluteFill,{backdropFilter:"blur(20px)"}]}/>:<BlurView tint="light" intensity={40} style={StyleSheet.absoluteFill}/>}<View style={[StyleSheet.absoluteFill,{backgroundColor:"rgba(255,255,255,.5)"}]}/></View>:null}
    {panelTop!==null?<View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="nuri-keyboard-backplate" style={{position:"absolute",top:panelTop,left:0,right:0,bottom:0,borderTopLeftRadius:28,borderTopRightRadius:28,backgroundColor:keyboardTheme.surface}} />:null}
    {!welcome?<SafeAreaView edges={["top"]} style={Platform.OS==="web"?{paddingTop:62}:undefined}>{home?null:<NativePageControls />}</SafeAreaView>:null}
    <SafeAreaView edges={auth&&!welcome?["bottom"]:[]} style={{flex:1,minHeight:0,paddingBottom:Platform.OS==="web"&&auth&&!welcome?34:0}}>{children}</SafeAreaView>
    {!keyboard&&!signedOutResult&&(home||path==="/chats"||community&&!parentChat&&communityHideTabs!=="1")?<NuriTabBar />:null}
  </View>;
}

export function NuriTabBar() {
  const path=usePathname();const router=useRouter();const {locale}=useT();const t=useNuriTheme();const safe=useSafeAreaInsets();
  const active=path.startsWith("/chat")?"chat":path.startsWith("/notification")?"notifications":path.startsWith("/community")?"community":path==="/"?"home":null;
  const routes=[{name:"home",cn:"首页",en:"Home",route:"/(tabs)"},{name:"chat",cn:"对话",en:"Chat",route:"/(tabs)/chats"},{name:"community",cn:"社区",en:"Community",route:"/community"}] as const;
  const community=path==="/community";
  const homeIcons={home:require("@/assets/final-flow-20261101/home-tab-home.svg"),chat:require("@/assets/final-flow-20261101/home-tab-chat.svg"),community:require("@/assets/final-flow-20261101/home-tab-community.svg")};
  return <View style={[s.footer,{paddingBottom:Math.max(21,safe.bottom-13)}]} testID="nuri-tab-bar"><FinalSurface material={community?"community-navigation":"navigation"} bordered={!community} contentStyle={s.tabs} style={{width:268,maxWidth:"100%",alignSelf:"center"}}>{routes.map(tab=><Pressable key={tab.name} onPress={()=>{
    if(active===tab.name)return;
    if(requestGuardedNativeNavigation(path,tab.name))return;
    router.navigate(tab.route as never);
  }} accessibilityRole="tab" accessibilityLabel={locale==="en"?tab.en:translate(locale,tab.cn)} accessibilityState={{selected:active===tab.name}} testID={`nuri-tab-${tab.name}`} style={[s.tab,{backgroundColor:active===tab.name?"rgba(255,255,255,.4)":"transparent"}]}>{community?<NuriIcon name={tab.name} color={active===tab.name?FINAL_COLOR.coral:FINAL_COLOR.ink} size={32}/>:<Image source={homeIcons[tab.name]} tintColor={active===tab.name?FINAL_COLOR.coral:FINAL_COLOR.ink} accessible={false} contentFit="contain" style={{width:20,height:20}}/>}</Pressable>)}</FinalSurface></View>;
}
const s=StyleSheet.create({footer:{paddingHorizontal:24,paddingTop:18},tabs:{flexDirection:"row",height:56,paddingHorizontal:8,paddingVertical:6},tab:{flex:1,height:44,borderRadius:22,alignItems:"center",justifyContent:"center"}});
