import { useCallback, useEffect, useRef, useState } from "react";
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
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const sessionRevisionRef = useRef(0);
  const lastPublishedSessionRef = useRef<string | null | undefined>(undefined);
  const rejectedSessionRef = useRef<{ token: string; revision: number } | null>(null);
  const retryingCleanupRef = useRef(false);
  const cleanupMessage = locale === "en"
    ? "Your sign-in expired, but local credentials could not be cleared. Retry before signing in again; restarting may restore the old credentials. Old-account notifications may still arrive, so you can also turn off NURI notifications in system settings."
    : locale === "zh-TW"
      ? "登入已失效，但本機憑據未確認清除。請重試後再登入；重新啟動可能恢復舊憑據。也可能收到舊帳號通知，可先在系統設定關閉 NURI 通知。"
      : "登录已失效，但本机凭据未确认清除。请重试后再登录；重新启动可能恢复旧凭据。也可能收到旧账号通知，可先在系统设置关闭 NURI 通知。";
  const cleanupMessageRef = useRef(cleanupMessage);
  cleanupMessageRef.current = cleanupMessage;

  const requestIsCurrent = useCallback((request: number) => mountedRef.current && requestSequenceRef.current === request, []);
  const sessionIsCurrent = useCallback(async (token: string | null, revision: number, request: number) => {
    if (!requestIsCurrent(request) || sessionRevisionRef.current !== revision) return false;
    const currentToken = await auth.getToken();
    return requestIsCurrent(request) && sessionRevisionRef.current === revision && currentToken === token;
  }, [requestIsCurrent]);
  const onlyThisSessionWasCleared = useCallback(async (revision: number, request: number) => {
    if (!requestIsCurrent(request) || sessionRevisionRef.current !== revision + 1 || lastPublishedSessionRef.current !== null) return false;
    const currentToken = await auth.getToken();
    return requestIsCurrent(request) && sessionRevisionRef.current === revision + 1 && lastPublishedSessionRef.current === null && currentToken === null;
  }, [requestIsCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = auth.subscribeSessionChange((token) => {
      sessionRevisionRef.current += 1;
      lastPublishedSessionRef.current = token;
      // A newly signed-in account gets its own gate. The null event emitted by
      // this gate's cleanup is handled below, not mistaken for another request.
      if (token !== null && mountedRef.current) {
        requestSequenceRef.current += 1;
        setSessionGeneration((current) => current + 1);
      }
    });
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      unsubscribe();
    };
  }, []);

  const retryCredentialCleanup = async () => {
    const rejected = rejectedSessionRef.current;
    if (!mountedRef.current || checking || retryingCleanupRef.current || !rejected) return;
    retryingCleanupRef.current = true;
    const request = ++requestSequenceRef.current;
    setChecking(true);
    setSettingsError(null);
    try {
      const currentToken = await auth.getToken();
      if (!requestIsCurrent(request) || sessionRevisionRef.current !== rejected.revision || (currentToken !== rejected.token && !(currentToken === null && lastPublishedSessionRef.current === null))) return;
      // Keep the original rejected token despite the process-local Keychain
      // tombstone. The auth queue's raw-token CAS can retry A, but cannot clear B.
      const cleared = await auth.clearToken({ forceLocal: true, expectedToken: rejected.token });
      if (cleared === false) return;
      if (await onlyThisSessionWasCleared(rejected.revision, request) && requestIsCurrent(request) && sessionRevisionRef.current === rejected.revision + 1) router.replace("/login");
    } catch {
      if (await onlyThisSessionWasCleared(rejected.revision, request) || await sessionIsCurrent(rejected.token, rejected.revision, request)) {
        if (!requestIsCurrent(request)) return;
        rejectedSessionRef.current = { token: rejected.token, revision: sessionRevisionRef.current };
        setCleanupError(cleanupMessageRef.current);
      }
    } finally {
      retryingCleanupRef.current = false;
      if (requestIsCurrent(request)) setChecking(false);
    }
  };

  const openSystemNotificationSettings = async () => {
    const request = requestSequenceRef.current;
    const revision = sessionRevisionRef.current;
    try {
      await openNotificationSettings();
    } catch {
      if (requestIsCurrent(request) && sessionRevisionRef.current === revision) setSettingsError(locale === "en" ? "System settings could not be opened. Please retry." : locale === "zh-TW" ? "系統設定暫時無法開啟，請重試。" : "系统设置暂时无法打开，请重试。");
    }
  };

  useEffect(() => {
    const request = ++requestSequenceRef.current;
    rejectedSessionRef.current = null;
    setChecking(true);
    setCleanupError(null);
    setSettingsError(null);
    (async () => {
      try {
        const revision = sessionRevisionRef.current;
        const token = await auth.getToken();
        if (!requestIsCurrent(request) || sessionRevisionRef.current !== revision) return;
        if (!token) {
          // Returning users are the common case, so land on login. New users
          // reach register via the "立即注册" link there.
          if (await sessionIsCurrent(null, revision, request) && requestIsCurrent(request) && sessionRevisionRef.current === revision) router.replace("/login");
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
            if (!await sessionIsCurrent(token, revision, request) || !requestIsCurrent(request) || sessionRevisionRef.current !== revision) return;
            try {
              // This JWT was actually rejected. A DELETE using the same JWT
              // cannot gate returning to login; retain bounded push cleanup
              // separately while clearing only the local expired credentials.
              const cleared = await auth.clearToken({ forceLocal: true, expectedToken: token });
              if (cleared === false) return;
            } catch {
              if (await onlyThisSessionWasCleared(revision, request) || await sessionIsCurrent(token, revision, request)) {
                if (!requestIsCurrent(request)) return;
                rejectedSessionRef.current = { token, revision: sessionRevisionRef.current };
                setCleanupError(cleanupMessageRef.current);
              }
              return;
            }
            if (await onlyThisSessionWasCleared(revision, request) && requestIsCurrent(request) && sessionRevisionRef.current === revision + 1) router.replace("/login");
            return;
          }
          // Stay signed in and route on the last known state. Individual
          // screens surface their own errors if the backend is really down.
          const onboarded = await auth.getOnboarded();
          if (await sessionIsCurrent(token, revision, request) && requestIsCurrent(request) && sessionRevisionRef.current === revision) router.replace(onboarded ? "/(tabs)" : "/onboarding");
          return;
        }

        // Adopt the account's saved UI language before the first screen paints,
        // so a fresh install doesn't open in the wrong one.
        if (!await sessionIsCurrent(token, revision, request) || !requestIsCurrent(request) || sessionRevisionRef.current !== revision) return;
        if (me?.language) await setLocale(me.language);
        if (!await sessionIsCurrent(token, revision, request) || !requestIsCurrent(request) || sessionRevisionRef.current !== revision) return;
        const onboarded = !!me?.onboarding_completed;
        const saved = await auth.setOnboarded(onboarded, { expectedToken: token });
        if (saved === false) return;
        if (await sessionIsCurrent(token, revision, request) && requestIsCurrent(request) && sessionRevisionRef.current === revision) router.replace(onboarded ? "/(tabs)" : "/onboarding");
      } finally {
        if (requestIsCurrent(request)) setChecking(false);
      }
    })();
    return () => { if (requestSequenceRef.current === request) requestSequenceRef.current += 1; };
    // Locale updates must not restart or revive the request that saved them.
  }, [router, setLocale, sessionGeneration, requestIsCurrent, sessionIsCurrent, onlyThisSessionWasCleared]);

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
        <Pressable disabled={checking} onPress={() => void openSystemNotificationSettings()} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 16 }} accessibilityRole="button" testID="expired-session-notification-settings">
          <Text style={{ color: colors.brand }}>{locale === "en" ? "Open system notification settings" : locale === "zh-TW" ? "開啟系統通知設定" : "打开系统通知设置"}</Text>
        </Pressable>
        {settingsError ? <Text style={{ color: colors.error, textAlign: "center" }} accessibilityLiveRegion="polite">{settingsError}</Text> : null}
      </> : null}
    </View>
  );
}
