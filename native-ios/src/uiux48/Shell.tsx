import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { usePathname, useRouter, useSegments, useGlobalSearchParams } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useT } from "@/src/i18n";
import NativePageControls from "@/src/components/NativePageControls";
import { requestGuardedNativeNavigation } from "@/src/components/nativeNavigation";
import { NuriScene } from "./Scene";
import { useNuriTheme } from "./Theme";
import { GlassSurface, NuriIcon } from "./Primitives";

export function NuriShell({ children }: { children: ReactNode }) {
  const path=usePathname(); const segments=useSegments(); const {night,mode}=useNuriTheme();
  const [keyboard,setKeyboard]=useState(false);
  useEffect(()=>{const show=Keyboard.addListener("keyboardWillShow",()=>setKeyboard(true));const hide=Keyboard.addListener("keyboardWillHide",()=>setKeyboard(false));const showAndroid=Keyboard.addListener("keyboardDidShow",()=>setKeyboard(true));const hideAndroid=Keyboard.addListener("keyboardDidHide",()=>setKeyboard(false));return()=>{show.remove();hide.remove();showAndroid.remove();hideAndroid.remove();};},[]);
  const welcome=path==="/welcome";
  const {uiState}=useGlobalSearchParams<{uiState?:string}>();
  const signedOutResult=path==="/account-deletion"&&uiState==="deleted";
  const home=segments[0]==="(tabs)"&&path==="/";
  const auth=/^\/(welcome|login|register|verify-email|forgot-password|onboarding|ai-permission)$/.test(path);
  return <View testID={`nuri-shell-${mode}`} style={{flex:1,backgroundColor:night?"#2d2942":"#f5edde"}}>
    <StatusBar style={night?"light":"dark"} />
    <NuriScene welcome={welcome} mascot={home} focused={!welcome&&!home} />
    {!welcome?<SafeAreaView edges={["top"]} style={Platform.OS==="web"?{paddingTop:62}:undefined}>{home?null:<NativePageControls />}</SafeAreaView>:null}
    <SafeAreaView edges={auth&&!welcome?["bottom"]:[]} style={{flex:1,minHeight:0,paddingBottom:Platform.OS==="web"&&auth&&!welcome?34:0}}>{children}</SafeAreaView>
    {!auth&&!welcome&&!keyboard&&!signedOutResult?<NuriTabBar />:null}
  </View>;
}

export function NuriTabBar() {
  const path=usePathname();const router=useRouter();const {locale}=useT();const t=useNuriTheme();const safe=useSafeAreaInsets();
  const active=path.startsWith("/chat")?"chat":path.startsWith("/notification")?"notifications":path.startsWith("/community")?"community":path==="/"?"home":null;
  const routes=[{name:"home",cn:"首页",en:"Home",route:"/(tabs)"},{name:"chat",cn:"对话",en:"Chat",route:"/(tabs)/chats"},{name:"notifications",cn:"推送",en:"Notifications",route:"/notifications"},{name:"community",cn:"社区",en:"Community",route:"/community"}] as const;
  return <View style={[s.footer,{paddingBottom:Math.max(25,safe.bottom-9)}]} testID="nuri-tab-bar"><GlassSurface kind="pill" contentStyle={s.tabs} style={{width:"100%",maxWidth:500,alignSelf:"center"}}>{routes.map(tab=><Pressable key={tab.name} onPress={()=>{
    if(active===tab.name)return;
    if(requestGuardedNativeNavigation(path,tab.name))return;
    router.navigate(tab.route as never);
  }} accessibilityRole="tab" accessibilityLabel={locale==="en"?tab.en:tab.cn} accessibilityState={{selected:active===tab.name}} testID={`nuri-tab-${tab.name}`} style={[s.tab,{backgroundColor:active===tab.name?(t.night?"rgba(166,125,153,.26)":"rgba(166,125,153,.19)"):"transparent"}]}><NuriIcon name={tab.name} /><Text numberOfLines={1} style={{fontSize:9,lineHeight:12,color:t.ink}}>{locale==="en"?tab.en:tab.cn}</Text></Pressable>)}</GlassSurface></View>;
}
const s=StyleSheet.create({footer:{paddingHorizontal:24,paddingTop:16},tabs:{flexDirection:"row",height:54,padding:3},tab:{flex:1,minHeight:48,borderRadius:24,alignItems:"center",justifyContent:"center",gap:2}});
