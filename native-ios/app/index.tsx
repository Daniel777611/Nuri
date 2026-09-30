import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { View, Text, Pressable, ActivityIndicator } from "react-native";

import { api, auth, isAuthError } from "@/src/api";
import { useT } from "@/src/i18n";
import { openNotificationSettings } from "@/src/nativePush";
import { colors } from "@/src/theme";

export default function Index() {
  const router = useRouter();
  const { setLocale, locale } = useT();
  const [checking, setChecking] = useState(true);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const retryingCleanupRef = useRef(false);
  const cleanupMessage = locale === "en"
    ? "Your sign-in expired, but local credentials could not be cleared. Retry before signing in again; restarting may restore the old credentials. Old-account notifications may still arrive, so you can also turn off NURI notifications in system settings."
    : locale === "zh-TW"
      ? "登入已失效，但本機憑據未確認清除。請重試後再登入；重新啟動可能恢復舊憑據。也可能收到舊帳號通知，可先在系統設定關閉 NURI 通知。"
      : "登录已失效，但本机凭据未确认清除。请重试后再登录；重新启动可能恢复旧凭据。也可能收到旧账号通知，可先在系统设置关闭 NURI 通知。";

  const retryCredentialCleanup = async () => {
    if (checking || retryingCleanupRef.current) return;
    retryingCleanupRef.current = true;
    setChecking(true);
    setSettingsError(null);
    try {
      // getToken() intentionally returns null after a failed credential removal
      // in this process. Retry the removal itself, not the authentication gate.
      await auth.clearToken({ forceLocal: true });
      router.replace("/login");
    } catch {
      setCleanupError(cleanupMessage);
    } finally {
      retryingCleanupRef.current = false;
      setChecking(false);
    }
  };

  useEffect(() => {
    setChecking(true);
    setCleanupError(null);
    setSettingsError(null);
    (async () => {
      try {
        const token = await auth.getToken();
        if (!token) {
          // Returning users are the common case, so land on login. New users
          // reach register via the "立即注册" link there.
          router.replace("/login");
          return;
        }

        let me: any = null;
        try {
          me = await api.me();
        } catch (err) {
          // Only a rejected token means signed out. A timeout, a network drop
          // or a 5xx says nothing about the credentials — clearing the token
          // there turned every serverless cold start into a forced logout.
          if (isAuthError(err)) {
            try {
              // This JWT was actually rejected. A DELETE using the same JWT
              // cannot gate returning to login; retain bounded push cleanup
              // separately while clearing only the local expired credentials.
              await auth.clearToken({ forceLocal: true });
            } catch {
              setCleanupError(cleanupMessage);
              return;
            }
            router.replace("/login");
            return;
          }
          // Stay signed in and route on the last known state. Individual
          // screens surface their own errors if the backend is really down.
          router.replace((await auth.getOnboarded()) ? "/(tabs)" : "/onboarding");
          return;
        }

        // Adopt the account's saved UI language before the first screen paints,
        // so a fresh install doesn't open in the wrong one.
        if (me?.language) await setLocale(me.language);
        const onboarded = !!me?.onboarding_completed;
        await auth.setOnboarded(onboarded);
        router.replace(onboarded ? "/(tabs)" : "/onboarding");
      } finally {
        setChecking(false);
      }
    })();
  }, [router, setLocale, cleanupMessage]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.surface,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 16,
      }}
    >
      {checking ? <ActivityIndicator color={colors.brandPrimary} /> : null}
      {cleanupError ? <>
        <Text style={{ color: colors.error, textAlign: "center", lineHeight: 22 }} accessibilityLiveRegion="assertive" testID="expired-session-cleanup-error">{cleanupError}</Text>
        <Pressable disabled={checking} onPress={() => void retryCredentialCleanup()} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 16 }} accessibilityRole="button" testID="expired-session-cleanup-retry">
          <Text style={{ color: colors.brand }}>{locale === "en" ? "Retry credential cleanup" : locale === "zh-TW" ? "重試清除登入憑據" : "重试清除登录凭据"}</Text>
        </Pressable>
        <Pressable disabled={checking} onPress={() => void openNotificationSettings().catch(() => setSettingsError(locale === "en" ? "System settings could not be opened. Please retry." : locale === "zh-TW" ? "系統設定暫時無法開啟，請重試。" : "系统设置暂时无法打开，请重试。"))} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 16 }} accessibilityRole="button" testID="expired-session-notification-settings">
          <Text style={{ color: colors.brand }}>{locale === "en" ? "Open system notification settings" : locale === "zh-TW" ? "開啟系統通知設定" : "打开系统通知设置"}</Text>
        </Pressable>
        {settingsError ? <Text style={{ color: colors.error, textAlign: "center" }} accessibilityLiveRegion="polite">{settingsError}</Text> : null}
      </> : null}
    </View>
  );
}
