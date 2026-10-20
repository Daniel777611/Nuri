import { useRouter } from "expo-router";
import { useT, translate } from "@/src/i18n";
import { CenteredCard, NuriButton, NuriText } from "@/src/uiux48/Primitives";

/** The existing server supports opening a notification by ID, but exposes no
 * history-list contract. An unavailable list must not be labeled an empty inbox. */
export default function NotificationCenter() {
 const {locale}=useT();const en=locale==="en";const router=useRouter();
 return <CenteredCard testID="notification-history-unavailable"><NuriText style={{fontSize:20,fontWeight:"500"}}>{en?"Notification history — coming soon":locale==="zh-TW"?"通知歷史未上線":"通知历史未上线"}</NuriText><NuriText secondary>{en?"You can still open a delivered system notification to continue in Nuri's conversation, or manage notification settings.":translate(locale, "仍可点击已收到的系统推送进入 Nuri 对话，或管理通知设置。")}</NuriText><NuriButton label={en?"Go home":translate(locale, "回到首页")} onPress={()=>router.dismissTo("/(tabs)")} /><NuriButton label={en?"Manage notifications":translate(locale, "管理通知")} secondary onPress={()=>router.push("/notification-settings")} testID="notification-center-settings" /></CenteredCard>;
}
