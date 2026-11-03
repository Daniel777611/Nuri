import { Ionicons } from "@expo/vector-icons";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useT, translate } from "@/src/i18n";
import { colors } from "@/src/theme";
import { useAIConsent } from "@/src/useAIConsent";
import { aiConsentCopy } from "@/src/aiConsentCopy";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { requestFailureCopy } from "@/src/requestFailure";
import { requestGuardedNativeNavigation, type NativeNavigationAction } from "./nativeNavigation";
import { IconAction, NuriText } from "@/src/uiux48/Primitives";
import { NuriAvatar } from "@/src/uiux48/Scene";
import { CurrentUserAvatarAction } from "@/src/uiuxfinal/UserAvatar";
import { FinalText } from "@/src/uiuxfinal/Primitives";

/** Inline Stack header controls. The native header owns the top safe area. */
export default function NativePageControls() {
  const router = useRouter();
  const pathname = usePathname();
  const {uiState,flowTitle,communityHideBack,communityHeader,communityHideAvatar,section}=useGlobalSearchParams<{uiState?:string;flowTitle?:string;communityHideBack?:string;communityHeader?:string;communityHideAvatar?:string;section?:string}>();
  const prototypeTitle=process.env.EXPO_PUBLIC_FLOW_PROTOTYPE==="1"&&(pathname==="/community"||pathname==="/notifications")&&typeof flowTitle==="string"&&flowTitle.length<=160?flowTitle:null;
  const { t, locale } = useT();
  const { state } = useAIConsent();
  const aiCopy = aiConsentCopy(locale);
  const openPermission = () => { if (pathname !== "/ai-permission") router.push(aiPermissionHref(pathname)); };
  const notificationsLabel = locale === "en" ? "Notification settings" : locale === "zh-TW" ? "通知設定" : "通知设置";
  const labels: Record<string, [string,string]> = { "/login":["欢迎回来","Welcome back"],"/register":["创建账号","Create account"],"/verify-email":["验证邮箱","Verify email"],"/forgot-password":["重置密码","Reset password"],"/onboarding":["认识你和家人","Your family"],"/community":["社区","Community"],"/notifications":["推送","Notifications"],"/notification-settings":["通知设置","Notifications"],"/profile":["个人资料与设置","Profile & settings"],"/chats":["Nuri","Nuri"],"/daily-video":["推送","Recommendations"],"/daily-post":["推送","Recommendations"] };
  const stateTitle = pathname==="/daily-post"&&uiState==="takeaway" ? ["一起想想怎么做","Think it through"] : pathname==="/onboarding" ? (uiState==="setupChild"?["介绍一下宝宝","Tell us about your child"]:uiState==="setupConcerns"?["最近关注什么？","What's on your mind?"]:["先认识一下你","Let's get to know you"]) : pathname.startsWith("/child/") ? ["孩子资料","Child profile"] : pathname.startsWith("/saved/") ? (uiState==="choose" ? ["选择收藏分类","Choose a collection"] : ["已保存的内容","Saved content"]) : pathname==="/account-deletion"&&uiState==="deleted" ? ["账号已删除","Account deleted"] : null;
  const title = stateTitle ? stateTitle[locale==="en"?1:0] : pathname==="/source-preview"?(locale==="en"?"View original content":translate(locale, "查看原始内容")):pathname==="/content-unavailable"?(locale==="en"?"Not ready yet":translate(locale, "暂时没有准备好")):pathname==="/forgot-password"&&uiState==="resetDone"?(locale==="en"?"Password updated":translate(locale, "密码已更新")):pathname==="/notification-settings"&&uiState==="permission"?(locale==="en"?"Device notification access":translate(locale, "设备通知权限")):pathname.startsWith("/chat/") ? "Nuri" : labels[pathname]?.[locale === "en" ? 1 : 0] ?? "Nuri";
  const authenticated = !/^\/(login|register|verify-email|forgot-password|onboarding|ai-permission)$/.test(pathname);
  const reading = pathname==="/daily-post"||pathname==="/daily-video";
  const nuriChat=pathname.startsWith("/chat/")||pathname==="/chats";
  const settings=/^\/(profile|child|notification-settings|account-deletion|ai-permission)(\/|$)/.test(pathname);
  const regularCommunity=pathname==="/community"&&communityHeader==="regular";
  const hideCommunityAvatar=communityHideAvatar==="1"||communityHideAvatar===undefined&&["preferences","blocked","blockedEmpty"].includes(String(uiState));
  const displayTitle=prototypeTitle??(pathname==="/profile"?t(({main:"设置",personal:"个人信息",children:"孩子信息",preferences:"家庭偏好",favorites:"我的收藏",language:"语言",privacy:"隐私与 AI",account:"账号与安全",collections:"收藏分类"} as Record<string,string>)[String(section??"main")]??"设置"):t(title));
  // Parent conversations own the complete Figma header. Keep the shell's safe
  // area, but never stack the generic profile/settings header above it. An
  // explicit default wins over a stale initial deep-link uiState on return.
  if (process.env.EXPO_PUBLIC_FLOW_PROTOTYPE==="1" && pathname==="/community" &&
      (communityHeader==="parent-chat" || communityHeader==="feedback" || communityHeader===undefined && ["chat","chatOn","consent"].includes(String(uiState)))) return null;

  const navigate = (action: NativeNavigationAction) => {
    if (requestGuardedNativeNavigation(pathname, action)) return;
    if (action === "notifications") {
      if (pathname !== "/notification-settings") router.push("/notification-settings" as never);
    } else if (action === "back" && router.canGoBack()) {
      router.back();
    } else {
      router.dismissTo("/");
    }
  };

  return (
    <View testID="native-page-controls">
    <View style={[styles.row,nuriChat?{gap:8}:null]}>
      {pathname==="/community"&&communityHideBack==="1"?<View style={{width:8}} />:<IconAction name="back" label={t("返回")} onPress={() => navigate("back")} testID="native-header-back" />}
      {pathname.startsWith("/chat/")||pathname==="/chats"?<NuriAvatar />:null}
      {settings||nuriChat||pathname==="/community"?<FinalText size={nuriChat?18:20} secondary={settings||pathname==="/community"&&communityHeader!=="blocked-list"} style={{flex:1,marginLeft:nuriChat?0:4,lineHeight:pathname==="/community"&&!regularCommunity?28:26,fontWeight:settings||regularCommunity?"400":"500"}}>{displayTitle}</FinalText>:<NuriText role="H2" secondary={!reading} style={{flex:1,marginLeft:4,...(reading?{fontSize:20,lineHeight:28,color:"#4A454D",fontWeight:"500"}:null)}}>{displayTitle}</NuriText>}
      {authenticated&&pathname==="/community"&&!hideCommunityAvatar?<CurrentUserAvatarAction path={pathname} testID="native-header-settings" />:null}
    </View>
      {(pathname.startsWith("/chat")||pathname==="/daily-post"||pathname==="/daily-video"||pathname==="/knowledge"||pathname.startsWith("/detail/")) && ["not_allowed", "error"].includes(state.status) ? <Pressable onPress={openPermission} style={styles.banner} accessibilityRole="button" testID="native-ai-permission-blocked"><NuriText style={{fontSize:12,lineHeight:18}}>{state.status === "error" ? (state.failure === "session" ? requestFailureCopy(locale, "session").detail : aiCopy.loadError) : aiCopy.banner}</NuriText></Pressable> : null}
    </View>
  );
}

function Control({ icon, label, onPress, testID }: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Ionicons name={icon} size={22} color={colors.onSurface} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4, height:60, paddingLeft:12, paddingRight:24 },
  button: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: colors.brandTertiary },
  aiButton: { marginLeft: "auto", minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, maxWidth: "60%" },
  aiText: { color: colors.brand, fontSize: 13, flexShrink: 1 },
  banner: { backgroundColor: colors.brandTertiary, padding: 10, borderRadius: 10 },
  bannerText: { color: colors.onBrandTertiary, fontSize: 12, lineHeight: 18 },
});
