import {View} from "react-native";
import {useLocalSearchParams,useRouter} from "expo-router";
import {useT,translate} from "@/src/i18n";
import {CenteredCard,NuriText,NuriButton} from "@/src/uiux48/Primitives";
import {contentReturnTarget} from "@/src/uiux48/contentReturn";

export default function ContentUnavailable(){
 const {locale}=useT(),en=locale==="en",router=useRouter();
 const {kind,id}=useLocalSearchParams<{kind?:string;id?:string}>();
 return <CenteredCard testID="content-unavailable-card" contentGap={24}>
  <NuriText style={{fontSize:16,lineHeight:22}}>{en?"This content is temporarily unavailable. Try again later, or talk with Nuri first.":translate(locale, "这条内容暂时无法读取。你可以稍后重试，或先和 Nuri 聊聊。")}</NuriText>
  <View style={{gap:10}}><NuriButton label={en?"Reload":translate(locale, "重新加载")} onPress={()=>router.replace(contentReturnTarget(kind,id))} testID="content-unavailable-reload" />
  <NuriButton secondary label={en?"Talk with Nuri":translate(locale, "和 Nuri 聊聊")} onPress={()=>router.navigate("/(tabs)/chats")} testID="content-unavailable-chat" /></View>
 </CenteredCard>;
}
