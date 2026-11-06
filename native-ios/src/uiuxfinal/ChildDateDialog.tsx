import { NuriTextInput, AppKeyboardScope, AppKeyboardHost } from "@/src/keyboard/AppKeyboard";
import { useId, useState } from "react";
import { Modal, TextInput, View, KeyboardAvoidingView, Platform } from "react-native";
import { BlurView } from "expo-blur";
import { useT, translate } from "@/src/i18n";
import { formatDateOnly, isValidBirthDate, isValidDueDate } from "@/src/child-age";
import { FinalButton, FinalSurface, FinalText, FINAL_COLOR } from "./Primitives";
import { singleLineInputStyle } from "@/src/uiux48/inputLayout";

export function ChildDateDialog({value,expecting,onClose,onConfirm}:{value:string;expecting:boolean;onClose:()=>void;onConfirm:(value:string)=>void}){
 const {locale}=useT(),en=locale==="en",parts=value.split("-");
 const scopeId=`child-date-${useId()}`;
 const [draft,setDraft]=useState([parts[0]||"",parts[1]||"",parts[2]||""]);
 const complete=draft.every(Boolean);
 const selected=complete?formatDateOnly({year:Number(draft[0]),month:Number(draft[1]),day:Number(draft[2])}):"";
 const valid=complete&&(expecting?isValidDueDate(selected):isValidBirthDate(selected));
 const c=(cn:string,english:string)=>en?english:translate(locale,cn);
 return <Modal transparent animationType="fade" onRequestClose={onClose}>
   <AppKeyboardScope id={scopeId}><View style={{flex:1}}><BlurView intensity={40} tint="light" style={{flex:1,backgroundColor:"rgba(255,250,244,.22)"}}>
     <KeyboardAvoidingView behavior={Platform.OS==="ios"?"padding":"height"} style={{flex:1,justifyContent:"center",padding:24}}>
       <FinalSurface testID="child-date-dialog" contentStyle={{padding:24,gap:24}}>
         <FinalText size={20} secondary>{expecting?c("预产期","Due date"):c("出生日期","Date of birth")}</FinalText>
         <View style={{flexDirection:"row",gap:10}}>{[c("年","Year"),c("月","Month"),c("日","Day")].map((label,index)=><View key={index} style={{flex:index===0?1.5:1,gap:8}}>
           <FinalText size={12} secondary>{label}</FinalText><NuriTextInput testID={`child-date-part-${index}`} accessibilityLabel={label} value={draft[index]} onChangeText={text=>{if(/^\d*$/.test(text))setDraft(old=>old.map((v,i)=>i===index?text:v));}} maxLength={index===0?4:2} keyboardType="number-pad" keyboardAppearance="light" placeholder={index===0?"YYYY":index===1?"MM":"DD"} selectTextOnFocus style={{...singleLineInputStyle,height:50,borderRadius:12,paddingHorizontal:12,borderWidth:1,borderColor:"#DDD2DE",color:FINAL_COLOR.ink,fontSize:16,backgroundColor:"rgba(255,250,244,.6)"}}/>
         </View>)}</View>
         {expecting?<FinalText size={12} secondary>{c("预产期需在今天之后的40周内。","The due date must be within the next 40 weeks.")}</FinalText>:null}
         <View style={{flexDirection:"row",gap:12,justifyContent:"center"}}><FinalButton small secondary label={c("取消","Cancel")} onPress={onClose}/><FinalButton small label={c("确定","Confirm")} disabled={!valid} onPress={()=>onConfirm(selected)} testID="child-date-confirm"/></View>
       </FinalSurface>
     </KeyboardAvoidingView>
   </BlurView><AppKeyboardHost scopeId={scopeId}/></View></AppKeyboardScope>
 </Modal>;
}
