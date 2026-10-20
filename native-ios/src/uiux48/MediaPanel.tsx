import type { ReactNode } from "react";
import { Modal, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "@/src/i18n";
import { IconAction, NuriText } from "./Primitives";
import { NuriScene } from "./Scene";
import { NuriTabBar } from "./Shell";
import { useNuriTheme } from "./Theme";

/** One native modal owner: picker opens only after this modal's onDismiss. */
export function MediaPanel({visible,title,onClose,onDismiss,children}:{visible:boolean;title:string;onClose:()=>void;onDismiss?:()=>void;children:ReactNode}) {
  const theme=useNuriTheme();const insets=useSafeAreaInsets();const {t}=useT();
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={onDismiss}>
    <View style={{flex:1,backgroundColor:theme.night?"#2d2942":"#f5edde"}} accessibilityViewIsModal testID="media-panel">
      <NuriScene focused />
      {/* Native Modal owns a separate UIView hierarchy. Read the existing root
          provider's measured JS insets instead of a native SafeAreaView that
          can resolve zero top inset inside that hierarchy. */}
      <View style={{paddingTop:Platform.OS==="web"?62:insets.top}} testID="media-header-safe-area"><View style={{height:60,paddingLeft:12,paddingRight:24,flexDirection:"row",alignItems:"center",gap:4}}><IconAction name="back" label={t("返回")} onPress={onClose} testID="media-back" /><NuriText style={{flex:1,fontSize:20,lineHeight:26,fontWeight:"500"}}>{title}</NuriText></View></View>
      <View style={{flex:1,minHeight:0}}>{children}</View>
      <NuriTabBar />
    </View>
  </Modal>;
}
