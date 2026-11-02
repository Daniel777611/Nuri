import { View, StyleSheet, ScrollView } from "react-native";
import { BlurView } from "expo-blur";
import { useT } from "@/src/i18n";
import { FinalSurface, FinalText as NuriText } from "@/src/uiuxfinal/Primitives";
import { SettingsButton as NuriButton } from "@/src/uiuxfinal/Settings";

/** Shared in-card confirmation; caller ownership checks remain authoritative. */
export default function ConfirmDialog({visible,title,message,confirmText="确认",cancelText="取消",danger=false,onConfirm,onCancel}:{visible:boolean;title:string;message?:string;confirmText?:string;cancelText?:string;danger?:boolean;onConfirm:()=>void;onCancel:()=>void}) {
 const {t}=useT();if(!visible)return null;
 return <View style={{...StyleSheet.absoluteFillObject,zIndex:50,justifyContent:"center",padding:24}} accessibilityViewIsModal><BlurView intensity={40} tint="light" style={[StyleSheet.absoluteFill,{backgroundColor:"rgba(255,250,244,.24)"}]}/><FinalSurface testID="confirm-dialog" style={{maxHeight:"95%"}}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{padding:24,gap:24}}><NuriText style={{fontSize:20,lineHeight:28}}>{t(title)}</NuriText>{message?<NuriText secondary>{message}</NuriText>:null}<NuriButton label={t(confirmText)} onPress={onConfirm} testID="confirm-ok" accessibilityHint={danger?t("此操作无法撤销"):undefined} /><NuriButton label={t(cancelText)} secondary onPress={onCancel} testID="confirm-cancel" /></ScrollView></FinalSurface></View>;
}
