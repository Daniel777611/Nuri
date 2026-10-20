import { View, StyleSheet } from "react-native";
import { useT } from "@/src/i18n";
import { CenteredCard, NuriButton, NuriText } from "@/src/uiux48/Primitives";

/** Shared in-card confirmation; caller ownership checks remain authoritative. */
export default function ConfirmDialog({visible,title,message,confirmText="确认",cancelText="取消",danger=false,onConfirm,onCancel}:{visible:boolean;title:string;message?:string;confirmText?:string;cancelText?:string;danger?:boolean;onConfirm:()=>void;onCancel:()=>void}) {
 const {t}=useT();if(!visible)return null;
 return <View style={{...StyleSheet.absoluteFillObject,zIndex:50,backgroundColor:"rgba(35,26,44,.28)"}} accessibilityViewIsModal><CenteredCard testID="confirm-dialog"><NuriText style={{fontSize:20,lineHeight:28}}>{t(title)}</NuriText>{message?<NuriText secondary>{message}</NuriText>:null}<NuriButton label={t(confirmText)} onPress={onConfirm} testID="confirm-ok" accessibilityHint={danger?t("此操作无法撤销"):undefined} /><NuriButton label={t(cancelText)} secondary onPress={onCancel} testID="confirm-cancel" /></CenteredCard></View>;
}
