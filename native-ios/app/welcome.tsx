import { View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "@/src/i18n";
import { NuriButton, NuriText } from "@/src/uiux48/Primitives";

export default function Welcome() {
  const router=useRouter();const {locale}=useT();const safe=useSafeAreaInsets();const {width}=useWindowDimensions();const scale=width/402;const en=locale==="en";
  return <View style={{flex:1}} testID="welcome-screen">
    <View style={{position:"absolute",top:116*scale,left:32*scale,right:32*scale,gap:14}}><NuriText style={{fontSize:28,lineHeight:36,fontWeight:"500"}}>{en?"Hi, I'm Nuri.":"你好，我是 Nuri。"}</NuriText><NuriText secondary style={{fontSize:16,lineHeight:24}}>{en?"It's lovely to meet you.\nLet's make everyday life a little lighter.":"很高兴遇见你。\n我们一起，把日常过轻一点。"}</NuriText></View>
    <View style={{position:"absolute",left:24,right:24,bottom:Math.max(25,safe.bottom-9),gap:12}}><NuriButton label={en?"Get started":"开始使用"} onPress={()=>router.push("/register")} testID="welcome-signup" /><NuriButton label={en?"Already have an account? Log in":"已有账号，登录"} secondary onPress={()=>router.push("/login")} testID="welcome-login" /></View>
  </View>;
}
