import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, Text, View, type KeyboardEvent } from "react-native";
import { usePathname, useRouter, useSegments, useGlobalSearchParams } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useT, translate } from "@/src/i18n";
import NativePageControls from "@/src/components/NativePageControls";
import { requestGuardedNativeNavigation } from "@/src/components/nativeNavigation";
import { NuriScene } from "./Scene";
import { useNuriTheme } from "./Theme";
import { GlassSurface, NuriIcon } from "./Primitives";
import { keyboardPanelTop } from "./keyboard";
import { APP_STORE_TABS } from "@/src/appStoreRelease";

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
  const {uiState}=useGlobalSearchParams<{uiState?:string}>();
  const signedOutResult=path==="/account-deletion"&&uiState==="deleted";
  const home=segments[0]==="(tabs)"&&path==="/";
  const auth=/^\/(welcome|login|register|verify-email|forgot-password|onboarding|ai-permission)$/.test(path);
  return <View ref={root} onLayout={()=>root.current?.measureInWindow((_x,y,width,height)=>setRootFrame(previous=>previous.y===y&&previous.width===width&&previous.height===height?previous:{y,width,height}))} testID={`nuri-shell-${mode}`} style={{flex:1,backgroundColor:night?"#2d2942":"#f5edde"}}>
    <StatusBar style={night?"light":"dark"} />
    <NuriScene welcome={welcome} mascot={home} focused={!welcome&&!home} />
    {panelTop!==null?<View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="nuri-keyboard-backplate" style={{position:"absolute",top:panelTop,left:0,right:0,bottom:0,borderTopLeftRadius:28,borderTopRightRadius:28,backgroundColor:keyboardTheme.surface}} />:null}
    {!welcome?<SafeAreaView edges={["top"]} style={Platform.OS==="web"?{paddingTop:62}:undefined}>{home?null:<NativePageControls />}</SafeAreaView>:null}
    <SafeAreaView edges={auth&&!welcome?["bottom"]:[]} style={{flex:1,minHeight:0,paddingBottom:Platform.OS==="web"&&auth&&!welcome?34:0}}>{children}</SafeAreaView>
    {!auth&&!welcome&&!keyboard&&!signedOutResult?<NuriTabBar />:null}
  </View>;
}

export function NuriTabBar() {
  const path=usePathname();const router=useRouter();const {locale}=useT();const t=useNuriTheme();const safe=useSafeAreaInsets();
  const active=path.startsWith("/chat")?"chat":path==="/"?"home":null;
  return <View style={[s.footer,{paddingBottom:Math.max(25,safe.bottom-9)}]} testID="nuri-tab-bar"><GlassSurface kind="pill" contentStyle={s.tabs} style={{width:"100%",maxWidth:280,alignSelf:"center"}}>{APP_STORE_TABS.map(tab=><Pressable key={tab.name} onPress={()=>{
    if(active===tab.name)return;
    if(requestGuardedNativeNavigation(path,tab.name))return;
    router.navigate(tab.route as never);
  }} accessibilityRole="tab" accessibilityLabel={locale==="en"?tab.en:translate(locale,tab.cn)} accessibilityState={{selected:active===tab.name}} testID={`nuri-tab-${tab.name}`} style={[s.tab,{backgroundColor:active===tab.name?(t.night?"rgba(166,125,153,.26)":"rgba(166,125,153,.19)"):"transparent"}]}><NuriIcon name={tab.name} /><Text numberOfLines={1} style={{fontSize:9,lineHeight:12,color:t.ink}}>{locale==="en"?tab.en:translate(locale,tab.cn)}</Text></Pressable>)}</GlassSurface></View>;
}
const s=StyleSheet.create({footer:{paddingHorizontal:24,paddingTop:16},tabs:{flexDirection:"row",height:54,padding:3},tab:{flex:1,minHeight:48,borderRadius:24,alignItems:"center",justifyContent:"center",gap:2}});
