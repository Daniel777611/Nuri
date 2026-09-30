import { Ionicons } from "@expo/vector-icons";
import { usePathname, useRouter } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";

import { useT } from "@/src/i18n";
import { colors } from "@/src/theme";
import { requestGuardedNativeNavigation, type NativeNavigationAction } from "./nativeNavigation";

/** Inline Stack header controls. The native header owns the top safe area. */
export default function NativePageControls() {
  const router = useRouter();
  const pathname = usePathname();
  const { t, locale } = useT();
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
    <View style={styles.row} testID="native-page-controls">
      <Control icon="chevron-back" label={t("返回")} onPress={() => navigate("back")} testID="native-header-back" />
      <Control icon="home-outline" label={locale === "en" ? "Home" : locale === "zh-TW" ? "首頁" : "首页"} onPress={() => navigate("home")} testID="native-header-home" />
      <Control icon="notifications-outline" label={notificationsLabel} onPress={() => navigate("notifications")} testID="native-header-notifications" />
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
});
