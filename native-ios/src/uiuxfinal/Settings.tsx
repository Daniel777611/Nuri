import { NuriTextInput, useAppKeyboardVisible, type NuriTextInputProps } from "@/src/keyboard/AppKeyboard";
import { FrostedPressable } from "./ButtonMaterial";
import { Children, Fragment, cloneElement, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Keyboard, Platform, Pressable, ScrollView, TextInput, View, type KeyboardEvent, type PressableProps, type StyleProp, type ViewStyle, type ScrollViewProps, type TextInputProps } from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "@/src/i18n";
import { NuriIcon } from "@/src/uiux48/Primitives";
import { singleLineInputStyle, multilineInputStyle } from "@/src/uiux48/inputLayout";
import { FinalText, FINAL_COLOR } from "./Primitives";

/** A marker keeps actions in their controller's JSX, while the page places
 * them outside the scroll. It never owns a save callback or a second inset. */
export function SettingsFormFooter({children}:{children:ReactNode}){return <>{children}</>;}
export function settingsPageParts(children:ReactNode){
 const body:ReactNode[]=[],footer:ReactNode[]=[];
 const visit=(nodes:ReactNode,prefix:string)=>Children.forEach(nodes,(node,index)=>{
  const element=isValidElement<{children?:ReactNode}>(node)?node:null,key=`${prefix}:${element?.key??index}`;
  if(element?.type===Fragment)visit(element.props.children,key);
  else if(element?.type===SettingsFormFooter)Children.forEach(element.props.children,(action,actionIndex)=>footer.push(isValidElement(action)?cloneElement(action,{key:`${key}:${action.key??actionIndex}`}):action));
  else body.push(element?cloneElement(element,{key}):node);
 });
 visit(children,"settings");return{body,footer};
}
export function settingsKeyboardOverlap(frame:{screenY:number;height:number;width:number}|null,bounds:{y:number;height:number;width:number}){
 if(!frame||frame.height<=0||bounds.height<=0||frame.width<bounds.width-1)return 0;
 return Math.max(0,Math.min(bounds.height,bounds.y+bounds.height-frame.screenY));
}
export function SettingsPage({children,heading:_heading,...props}:ScrollViewProps&{heading?:string}){
  const appKeyboard=useAppKeyboardVisible();
  const safe=useSafeAreaInsets(),parts=settingsPageParts(children),hasFooter=parts.footer.length>0;
  const root=useRef<View>(null),[bounds,setBounds]=useState({y:0,height:0,width:0});
  const [keyboard,setKeyboard]=useState(()=>Keyboard.metrics?.()??null);
  useEffect(()=>{
   if(!hasFooter||Platform.OS==="web")return;
   setKeyboard(Keyboard.metrics?.()??null);
   const show=(event:KeyboardEvent)=>setKeyboard(event.endCoordinates),hide=()=>setKeyboard(null);
   const listeners=[Keyboard.addListener("keyboardWillShow",show),Keyboard.addListener("keyboardDidShow",show),Keyboard.addListener("keyboardWillChangeFrame",show),Keyboard.addListener("keyboardWillHide",hide),Keyboard.addListener("keyboardDidHide",hide)];
   return()=>listeners.forEach(listener=>listener.remove());
  },[hasFooter]);
  const overlap=hasFooter&&Platform.OS!=="web"?settingsKeyboardOverlap(keyboard,bounds):0;
  const dockedKeyboard=appKeyboard||Platform.OS!=="web"&&keyboard&&bounds.height>0&&keyboard.width>=bounds.width-1&&keyboard.screenY<=bounds.y+bounds.height+1;
  const scroll=<ScrollView {...props} style={[{flex:1,minHeight:0},props.style]} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} contentContainerStyle={[{flexGrow:1,paddingHorizontal:24,paddingTop:22,paddingBottom:hasFooter?24:Math.max(40,safe.bottom+6),gap:16},props.contentContainerStyle]}>{parts.body}</ScrollView>;
  if(!hasFooter)return scroll;
  return <View ref={root} testID="settings-form-layout" onLayout={()=>root.current?.measureInWindow((_x,y,width,height)=>setBounds(previous=>previous.y===y&&previous.width===width&&previous.height===height?previous:{y,width,height}))} style={{flex:1,minHeight:0,paddingBottom:overlap}}>{scroll}<View testID="settings-form-footer" style={{flexShrink:0,paddingHorizontal:24,paddingTop:24,paddingBottom:dockedKeyboard?12:Math.max(66,safe.bottom+32),gap:12}}>{parts.footer}</View></View>;
}
export function SettingsField({label,style,compactMultiline=false,...props}:NuriTextInputProps&{label?:string;compactMultiline?:boolean}){
 const {locale}=useT(),[contentHeight,setContentHeight]=useState(54);
 return <View style={{gap:8}}>{label?<FinalText size={12} secondary style={{fontWeight:"500",fontFamily:locale==="zh-CN"?"NotoSansSC_500Medium":undefined}}>{label}</FinalText>:null}<NuriTextInput keyboardAppearance="light" {...props} onContentSizeChange={event=>{if(compactMultiline&&props.multiline)setContentHeight(Math.max(54,Math.min(140,Math.ceil(event.nativeEvent.contentSize.height))));props.onContentSizeChange?.(event);}} placeholderTextColor="#918896" style={[{height:compactMultiline&&props.multiline?contentHeight:54,borderRadius:18,borderWidth:1,borderColor:"rgba(93,80,96,.12)",paddingHorizontal:16,fontSize:16,lineHeight:24,fontWeight:"400",fontFamily:locale==="zh-CN"?"NotoSansSC_400Regular":undefined,color:FINAL_COLOR.ink,backgroundColor:"rgba(255,250,245,.9)"},props.multiline?multilineInputStyle:singleLineInputStyle,style]}/></View>;
}
export function SettingsRow({label,detail,onPress,testID,danger=false,disabled=false,separator=false}:{label:string;detail?:string;onPress:()=>void;testID?:string;danger?:boolean;disabled?:boolean;separator?:boolean;density?:string}){
  const {locale}=useT();
  return <Pressable onPress={onPress} disabled={disabled} testID={testID} accessibilityRole="button" style={{minHeight:52,paddingVertical:14,flexDirection:"row",gap:12,alignItems:"center",opacity:disabled?.45:1,borderBottomWidth:separator?1:0,borderBottomColor:"rgba(112,106,116,.14)"}}><View style={{flex:1,minWidth:0,gap:4}}><FinalText style={danger?{color:"#9A606A"}:undefined}>{label}</FinalText>{detail?<FinalText size={12} secondary style={{fontWeight:"500",fontFamily:locale==="zh-CN"?"NotoSansSC_500Medium":undefined}}>{detail}</FinalText>:null}</View><NuriIcon name="chevronRight" size={20} color="#5C5662"/></Pressable>;
}
export function SettingsChoices({children}:{children:ReactNode}){
 const choices=Children.toArray(children);
 return <View style={{gap:10}}>{Array.from({length:Math.ceil(choices.length/2)},(_,index)=><View key={index} style={{flexDirection:"row",gap:10}}>{choices.slice(index*2,index*2+2)}{index*2+1===choices.length?<View style={{flex:1,minWidth:0,paddingHorizontal:10}}/>:null}</View>)}</View>;
}
export function SettingsChoice({label,selected,onPress,testID,disabled=false}:{label:string;selected:boolean;onPress:()=>void;testID?:string;disabled?:boolean}){
  return <FrostedPressable onPress={onPress} disabled={disabled} accessibilityRole="checkbox" accessibilityState={{checked:selected,disabled}} testID={testID} style={{flex:1,minWidth:0,minHeight:44,paddingHorizontal:10,paddingVertical:10,borderRadius:22,alignItems:"center",justifyContent:"center",backgroundColor:selected?FINAL_COLOR.selected:"rgba(255,248,242,.75)",opacity:disabled?.45:1,boxShadow:"0px 4px 4px rgba(0,0,0,.25)"}}><FinalText style={{color:selected?"white":FINAL_COLOR.ink,textAlign:"center"}}>{label}</FinalText></FrostedPressable>;
}
export function SettingsToggle({label,detail,value,onChange,testID,disabled=false,accessibilityHint}:{label:string;detail?:string;value:boolean;onChange:(v:boolean)=>void;testID?:string;disabled?:boolean;accessibilityHint?:string}){
 const {locale}=useT();
 return <Pressable onPress={()=>{if(!disabled)onChange(!value);}} disabled={disabled} testID={testID} accessibilityRole="switch" accessibilityLabel={label} accessibilityHint={accessibilityHint} accessibilityState={{checked:value,disabled}} style={{minHeight:68,paddingVertical:12,flexDirection:"row",alignItems:"center",gap:16,opacity:disabled?.45:1}}><View style={{flex:1,minWidth:0,gap:4}}><FinalText>{label}</FinalText>{detail?<FinalText size={12} secondary style={{fontWeight:"500",fontFamily:locale==="zh-CN"?"NotoSansSC_500Medium":undefined}}>{detail}</FinalText>:null}</View><View pointerEvents="none" style={{width:52,height:44,justifyContent:"center"}}><View style={{width:44,height:44,marginLeft:-5.75,alignItems:"center",justifyContent:"center"}}><Image accessible={false} source={value?require("@/assets/final-flow-20261101/settings-switch-on.svg"):require("@/assets/final-flow-20261101/settings-switch-off.svg")} contentFit="contain" style={{width:value?32.5:44,height:value?20:44}}/></View></View></Pressable>;
}
export function SettingsDivider(){return <View style={{height:1,backgroundColor:"rgba(112,106,116,.14)"}}/>;}
export function SettingsAction({label,danger=false,testID,onPress,disabled=false}:{label:string;danger?:boolean;testID?:string;onPress:()=>void;disabled?:boolean}){return <Pressable testID={testID} accessibilityRole="button" disabled={disabled} onPress={onPress} style={{minWidth:44,maxWidth:"100%",minHeight:44,marginVertical:-10,justifyContent:"center",opacity:disabled?.45:1}}><FinalText style={{color:danger?"#9A606A":FINAL_COLOR.accent}}>{label}</FinalText></Pressable>;}
export function SettingsSpacer(){return <View style={{flex:1,minHeight:24}}/>;}
export function SettingsButton({label,busy,secondary,style,...props}:Omit<PressableProps,"children"|"style">&{label:string;busy?:boolean;secondary?:boolean;style?:StyleProp<ViewStyle>}){
 return <FrostedPressable {...props} accessibilityRole="button" accessibilityState={{disabled:!!props.disabled,busy:!!busy}} style={[{width:212,maxWidth:"100%",minHeight:50,padding:12,borderRadius:25,alignSelf:"center",alignItems:"center",justifyContent:"center",backgroundColor:secondary?(props.disabled?"rgba(255,250,244,.375)":"rgba(255,250,244,.75)"):props.disabled?"rgba(235,129,131,.2)":FINAL_COLOR.coral,boxShadow:"0px 3px 10px rgba(62,37,34,.10)"},style]}>{busy?<ActivityIndicator color={secondary?FINAL_COLOR.ink:"white"}/>:<FinalText style={{color:secondary?FINAL_COLOR.ink:"white",textAlign:"center"}}>{label}</FinalText>}</FrostedPressable>;
}
