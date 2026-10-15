import { Ionicons } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useT } from "@/src/i18n";
import { colors } from "@/src/theme";
import { useAIConsent } from "@/src/useAIConsent";
import { aiConsentCopy } from "@/src/aiConsentCopy";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { requestFailureCopy } from "@/src/requestFailure";
import { requestGuardedNativeNavigation, type NativeNavigationAction } from "./nativeNavigation";

/** Inline Stack header controls. The native header owns the top safe area. */
export default function NativePageControls() {
  const router = useRouter();
  const pathname = usePathname();
  const { t, locale } = useT();
  const { state } = useAIConsent();
  const aiCopy = aiConsentCopy(locale);
  const openPermission = () => { if (pathname !== "/ai-permission") router.push(aiPermissionHref(pathname)); };
  const notificationsLabel = locale === "en" ? "Notification settings" : locale === "zh-TW" ? "通知設定" : "通知设置";

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
    <View style={styles.row}>
      <Control icon="chevron-back" label={t("返回")} onPress={() => navigate("back")} testID="native-header-back" />
      <Control icon="home-outline" label={locale === "en" ? "Home" : locale === "zh-TW" ? "首頁" : "首页"} onPress={() => navigate("home")} testID="native-header-home" />
      <Control icon="notifications-outline" label={notificationsLabel} onPress={() => navigate("notifications")} testID="native-header-notifications" />
      <Pressable onPress={openPermission} style={styles.aiButton} accessibilityRole="button" accessibilityLabel={aiCopy.header} testID="native-header-ai-permission"><Ionicons name="shield-checkmark-outline" size={20} color={colors.brand} /><Text style={styles.aiText}>{aiCopy.header}</Text></Pressable>
    </View>
      {pathname !== "/ai-permission" && ["not_allowed", "error"].includes(state.status) ? <Pressable onPress={openPermission} style={styles.banner} accessibilityRole="button" testID="native-ai-permission-blocked"><Text style={styles.bannerText}>{state.status === "error" ? (state.failure === "session" ? requestFailureCopy(locale, "session").detail : aiCopy.loadError) : aiCopy.banner}</Text></Pressable> : null}
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
  row: { flexDirection: "row", alignItems: "center", gap: 2 },
  button: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  pressed: { backgroundColor: colors.brandTertiary },
  aiButton: { marginLeft: "auto", minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, maxWidth: "60%" },
  aiText: { color: colors.brand, fontSize: 13, flexShrink: 1 },
  banner: { backgroundColor: colors.brandTertiary, padding: 10, borderRadius: 10 },
  bannerText: { color: colors.onBrandTertiary, fontSize: 12, lineHeight: 18 },
});
