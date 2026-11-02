import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Switch, TextInput, View, type PressableProps, type StyleProp, type ViewStyle, type ScrollViewProps, type TextInputProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NuriIcon } from "@/src/uiux48/Primitives";
import { FinalText, FINAL_COLOR } from "./Primitives";

export function SettingsPage({children,heading:_heading,...props}:ScrollViewProps&{heading?:string}){
  const safe=useSafeAreaInsets();
  return <ScrollView {...props} style={[{flex:1,minHeight:0},props.style]} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} contentContainerStyle={[{flexGrow:1,paddingHorizontal:24,paddingTop:20,paddingBottom:Math.max(40,safe.bottom+6),gap:16},props.contentContainerStyle]}>{children}</ScrollView>;
}
export function SettingsField({label,style,...props}:TextInputProps&{label?:string}){
  return <View style={{gap:8}}>{label?<FinalText size={12} secondary>{label}</FinalText>:null}<TextInput keyboardAppearance="light" {...props} placeholderTextColor="#918896" style={[{height:54,borderRadius:18,borderWidth:1,borderColor:"rgba(115,92,132,.14)",paddingHorizontal:16,fontSize:16,color:FINAL_COLOR.ink,backgroundColor:"rgba(255,250,244,.45)"},style]}/></View>;
}
export function SettingsRow({label,detail,onPress,testID,danger=false,disabled=false,separator=false}:{label:string;detail?:string;onPress:()=>void;testID?:string;danger?:boolean;disabled?:boolean;separator?:boolean;density?:string}){
  return <Pressable onPress={onPress} disabled={disabled} testID={testID} accessibilityRole="button" style={{minHeight:52,paddingVertical:12,flexDirection:"row",gap:12,alignItems:"center",opacity:disabled?.45:1,borderBottomWidth:separator?1:0,borderBottomColor:"rgba(115,92,132,.15)"}}><View style={{flex:1,gap:4}}><FinalText style={danger?{color:"#A75F6D"}:undefined}>{label}</FinalText>{detail?<FinalText size={12} secondary>{detail}</FinalText>:null}</View><NuriIcon name="chevronRight"/></Pressable>;
}
export function SettingsChoice({label,selected,onPress,testID,disabled=false}:{label:string;selected:boolean;onPress:()=>void;testID?:string;disabled?:boolean}){
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="checkbox" accessibilityState={{checked:selected,disabled}} testID={testID} style={{flexBasis:"47%",flexGrow:1,minHeight:44,padding:10,borderRadius:24,alignItems:"center",justifyContent:"center",backgroundColor:selected?FINAL_COLOR.selected:"rgba(255,250,244,.75)",opacity:disabled?.45:1,boxShadow:"0px 2px 4px rgba(62,37,34,.15)"}}><FinalText style={{color:selected?"white":FINAL_COLOR.ink,textAlign:"center"}}>{label}</FinalText></Pressable>;
}
export function SettingsToggle({label,detail,value,onChange,testID,disabled=false}:{label:string;detail?:string;value:boolean;onChange:(v:boolean)=>void;testID?:string;disabled?:boolean}){
  return <View style={{minHeight:66,flexDirection:"row",alignItems:"center",gap:12,opacity:disabled?.45:1}}><View style={{flex:1,gap:4}}><FinalText>{label}</FinalText>{detail?<FinalText size={12} secondary>{detail}</FinalText>:null}</View><Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled} testID={testID} trackColor={{true:FINAL_COLOR.selected,false:"#DED9E0"}} thumbColor="white"/></View>;
}
export function SettingsSpacer(){return <View style={{flex:1,minHeight:24}}/>;}
export function SettingsButton({label,busy,secondary,style,...props}:Omit<PressableProps,"children"|"style">&{label:string;busy?:boolean;secondary?:boolean;style?:StyleProp<ViewStyle>}){
 return <Pressable {...props} accessibilityRole="button" accessibilityState={{disabled:!!props.disabled,busy:!!busy}} style={[{width:212,maxWidth:"100%",minHeight:50,padding:12,borderRadius:25,alignSelf:"center",alignItems:"center",justifyContent:"center",opacity:props.disabled?.5:1,backgroundColor:secondary?"rgba(255,250,244,.75)":FINAL_COLOR.coral,boxShadow:"0px 3px 10px rgba(62,37,34,.10)"},style]}>{busy?<ActivityIndicator color={secondary?FINAL_COLOR.ink:"white"}/>:<FinalText style={{color:secondary?FINAL_COLOR.ink:"white",textAlign:"center"}}>{label}</FinalText>}</Pressable>;
}
