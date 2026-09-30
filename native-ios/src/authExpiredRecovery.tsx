import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { auth, isAuthError } from "./api";
import { SafeAreaView } from "./components/NativeSafeAreaView";
import { useT } from "./i18n";
import { openNotificationSettings } from "./nativePush";

export type ExpiredSessionRecoveryResult =
  | { kind: "not_rejected" }
  | { kind: "cleared" }
  | { kind: "failed"; code: string };

/** Only an actual 401 permits local recovery; network/5xx never clear login. */
export async function recoverExpiredSession(error: unknown): Promise<ExpiredSessionRecoveryResult> {
  if (!isAuthError(error)) return { kind: "not_rejected" };
  try {
    // A rejected JWT cannot authenticate push retirement. The existing auth
    // client retains bounded push cleanup separately and reports Keychain loss.
    await auth.clearToken({ forceLocal: true });
    return { kind: "cleared" };
  } catch (failure) {
    const code = failure && typeof failure === "object" && "code" in failure
      ? String(failure.code) : "UNCONFIRMED";
    return { kind: "failed", code };
  }
}

export function useExpiredSessionRecovery(onCleared?: () => void) {
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const rejectedError = useRef<unknown>(null);
  const clearedCallback = useRef(onCleared);
  clearedCallback.current = onCleared;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const recover = useCallback(async (error?: unknown): Promise<void> => {
    if (error !== undefined) {
      if (!isAuthError(error)) return;
      rejectedError.current = error;
    }
    if (!rejectedError.current || busy.current) return;
    busy.current = true;
    if (mounted.current) setPending(true);
    try {
      const result = await recoverExpiredSession(rejectedError.current);
      if (!mounted.current) return;
      if (result.kind === "failed") setFailureCode(result.code);
      else if (result.kind === "cleared") {
        setFailureCode(null);
        clearedCallback.current?.();
      }
    } catch {
      // Navigation failures must not escape an effect/event's async handler.
      if (mounted.current) setFailureCode("UNCONFIRMED");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return { blocked: failureCode !== null, failureCode, pending, recover };
}

/** Keeps rejected credentials from silently restoring after an app restart. */
export function ExpiredSessionRecoveryNotice({ pending, onRetry }: {
  pending: boolean;
  onRetry: () => Promise<void>;
}) {
  const { locale } = useT();
  const [settingsFailed, setSettingsFailed] = useState(false);
  const copy = locale === "en" ? {
    message: "Your sign-in expired, but local credentials could not be confirmed cleared. Retry before signing in again; restarting may restore the old credentials. Old-account notifications may still arrive. You can turn off NURI notifications in system settings.",
    retry: "Retry clearing credentials", busy: "Clearing credentials…", settings: "Open system notification settings",
    settingsFailed: "System settings could not be opened. Please retry.",
  } : locale === "zh-TW" ? {
    message: "登入已失效，但本機憑據未確認清除。請重試後再登入；重新啟動可能恢復舊憑據。也可能收到舊帳號通知，可先在系統設定關閉 NURI 通知。",
    retry: "重試清除登入憑據", busy: "正在清理…", settings: "開啟系統通知設定",
    settingsFailed: "系統設定暫時無法開啟，請重試。",
  } : {
    message: "登录已失效，但本机凭据未确认清除。请重试后再登录；重新启动可能恢复旧凭据。也可能收到旧账号通知，可先在系统设置关闭 NURI 通知。",
    retry: "重试清除登录凭据", busy: "正在清理…", settings: "打开系统通知设置",
    settingsFailed: "系统设置暂时无法打开，请重试。",
  };

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <View style={styles.panel} testID="expired-session-recovery">
        <Text style={styles.message} accessibilityLiveRegion="assertive">{copy.message}</Text>
        <Pressable disabled={pending} onPress={() => { void onRetry().catch(() => {}); }}
          style={styles.button} accessibilityRole="button" testID="expired-session-cleanup-retry">
          <Text style={styles.buttonText}>{pending ? copy.busy : copy.retry}</Text>
        </Pressable>
        <Pressable disabled={pending} onPress={() => {
          setSettingsFailed(false);
          void openNotificationSettings().catch(() => setSettingsFailed(true));
        }} style={styles.button} accessibilityRole="button" testID="expired-session-notification-settings">
          <Text style={styles.buttonText}>{copy.settings}</Text>
        </Pressable>
        {settingsFailed ? <Text style={styles.message} accessibilityLiveRegion="assertive">{copy.settingsFailed}</Text> : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FAFAF9", justifyContent: "center", padding: 24 },
  panel: { gap: 16 },
  message: { fontSize: 15, lineHeight: 23, color: "#5B3946" },
  button: { minHeight: 44, borderRadius: 12, backgroundColor: "#EEE8FC", padding: 12, justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "600", color: "#3A2F5A" },
});
