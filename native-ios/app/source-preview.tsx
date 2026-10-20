import {useLocalSearchParams,useRouter} from "expo-router";
import {useT} from "@/src/i18n";
import {CenteredCard,NuriText,NuriButton} from "@/src/uiux48/Primitives";
import {contentReturnTarget} from "@/src/uiux48/contentReturn";

/** Informational return screen after the existing OS link opener succeeds.
 * It never embeds, downloads or claims to have verified external content. */
export default function SourcePreview(){
 const {locale}=useT(),en=locale==="en",router=useRouter();
 const {kind,id}=useLocalSearchParams<{kind?:string;id?:string}>();
 return <CenteredCard testID="source-preview-card" contentGap={24}>
  <NuriText style={{fontSize:16,lineHeight:22}}>{en?"Original content opens in an external browser or YouTube.":"原始内容会在外部浏览器或 YouTube 中打开。"}</NuriText>
  <NuriText style={{fontSize:16,lineHeight:22}}>{en?"After viewing, you can return to NURI and keep talking.":"看完后可以回到 NURI 继续聊。"}</NuriText>
  <NuriButton label={en?"Return to NURI":"返回 NURI"} onPress={()=>router.replace(contentReturnTarget(kind,id))} testID="source-preview-return" />
 </CenteredCard>;
}
