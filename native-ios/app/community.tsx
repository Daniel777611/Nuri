import { useLocalSearchParams, useRouter } from "expo-router";
import { useT } from "@/src/i18n";
import { CardList, MenuRow, NuriText } from "@/src/uiux48/Primitives";
import { StateCard } from "@/src/uiux48/StateCard";
import FlowPreview, { FLOW_PREVIEW_ENABLED } from "nuri-ux49-flow-preview";

/** No MeFi endpoint is present in the verified local API contract. Keep the
 * design's destinations, but do not invent nearby parents, replies or sends. */
export default function Community() {
 if(FLOW_PREVIEW_ENABLED)return <FlowPreview entry="community" />;
 return <UnavailableCommunity />;
}
export function UnavailableCommunity() {
 const {locale}=useT();const en=locale==="en";const tw=locale==="zh-TW";const router=useRouter();const {uiState:screen}=useLocalSearchParams<{uiState?:string}>();
 const go=(screen:string)=>router.push({pathname:"/community",params:{uiState:screen}});
 const launchStatus=en?"Coming soon":tw?"未上線":"未上线";
 // Complete MeFi designs remain in the development-only gallery. The release
 // has no compose form, matching, fabricated inbox, or service mutations.
 if(screen)return <StateCard testID="community-service-unavailable"
   title={launchStatus}
   message={en?"Community is not available in this version. No question or profile has been sent.":tw?"社區功能尚未上線；沒有發送問題或個人資料。":"社区功能尚未上线；没有发送问题或个人资料。"}
   primary={{label:en?"Back to Community":tw?"返回社區":"返回社区",onPress:()=>router.canGoBack()?router.back():router.replace("/community")}} />;
 return <CardList heading={en?"What do you need today?":tw?"今天，你需要什麼？":"今天，你需要什么？"} contentContainerStyle={{gap:0}}>
   <NuriText secondary testID="community-launch-status">{launchStatus}</NuriText>
   <MenuRow density="community" label={en?"Ask parents with similar experiences":tw?"向有相似經歷的家長提問":"向有相似经历的家长提问"} detail={en?"Send a bottle and hear other parents' experiences.":tw?"發一個漂流瓶，聽聽其他家長的經驗。":"发一个漂流瓶，听听其他家长的经验。"} onPress={()=>go("ask")} testID="community-ask" />
   <MenuRow density="community" label={en?"Meet parents you connect with":tw?"認識聊得來的家長":"认识聊得来的家长"} detail={en?"Nearby parents with shared interests.":tw?"認識附近、興趣相投的家長。":"认识附近、兴趣相投的家长。"} onPress={()=>go("find")} testID="community-find" />
   <MenuRow density="community" label={en?"Chats & bottles":tw?"聊天與漂流瓶":"聊天与漂流瓶"} detail={launchStatus} onPress={()=>go("inbox")} testID="community-inbox" />
 </CardList>;
}
