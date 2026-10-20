import type { ReactNode } from "react";
import { Modal, Platform, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IconAction, NuriText } from "./Primitives";
import { NuriScene } from "./Scene";
import { NuriTabBar } from "./Shell";
import { useNuriTheme } from "./Theme";

/** One native modal owner: picker opens only after this modal's onDismiss. */
export function MediaPanel({visible,title,onClose,onDismiss,children}:{visible:boolean;title:string;onClose:()=>void;onDismiss?:()=>void;children:ReactNode}) {
  const theme=useNuriTheme();
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={onDismiss}>
    <View style={{flex:1,backgroundColor:theme.night?"#2d2942":"#f5edde"}} accessibilityViewIsModal testID="media-panel">
      <NuriScene focused />
      <SafeAreaView edges={["top"]} style={Platform.OS==="web"?{paddingTop:62}:undefined}><View style={{height:60,paddingLeft:12,paddingRight:24,flexDirection:"row",alignItems:"center",gap:4}}><IconAction name="back" label="Back" onPress={onClose} testID="media-back" /><NuriText style={{flex:1,fontSize:20,lineHeight:26,fontWeight:"500"}}>{title}</NuriText></View></SafeAreaView>
      <View style={{flex:1,minHeight:0}}>{children}</View>
      <NuriTabBar />
    </View>
  </Modal>;
}
