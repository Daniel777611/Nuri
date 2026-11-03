// Where a tapped notification lands, for as long as it takes to leave.
//
// Both native shells only open `/notifications/<id>`, so this route stays the
// entry point, but a notification is no longer read here. The server writes
// it into the NURI conversation as NURI's own message — a care line word for
// word, or the featured post as a card — and this screen goes straight there.
// The server answers 404 for a notification that belongs to someone else,
// which this screen shows exactly like one that never existed.

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "@/src/components/NativeSafeAreaView";
import { useLocalSearchParams, useRouter } from "expo-router";

import { api, auth, ApiError, isAuthError } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { useT } from "@/src/i18n";
import { safeNotificationRoute } from "@/src/nativePushRuntime";

type LoadState = { kind: "loading" } | { kind: "missing" } | { kind: "error" };

export default function NotificationScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const router = useRouter();
  const { t } = useT();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const sessionRevisionRef = useRef(0);

  const open = useCallback(async () => {
    if (!mountedRef.current) return;
    const request = ++requestSequenceRef.current;
    const revision = sessionRevisionRef.current;
    const requestIsCurrent = () => mountedRef.current && requestSequenceRef.current === request && sessionRevisionRef.current === revision;
    const notificationRoute = typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? safeNotificationRoute(`/notifications/${id}`) : null;
    if (!notificationRoute) {
      setState({ kind: "missing" });
      return;
    }
    setState({ kind: "loading" });
    let token: string | null = null;
    try {
      token = await auth.getToken();
      if (!requestIsCurrent()) return;
      const { session_id } = await api.openNotification(id as string);
      const currentToken = await auth.getToken();
      if (!requestIsCurrent() || currentToken !== token) return;
      // Replace, not push: going back from the conversation should not land
      // on a screen whose only job was to forward.
      router.replace(`/chat/${session_id}` as never);
    } catch (err) {
      if (!requestIsCurrent()) return;
      const currentToken = await auth.getToken();
      if (!requestIsCurrent() || currentToken !== token) return;
      if (isAuthError(err)) {
        router.replace({ pathname: "/login", params: { returnTo: notificationRoute } });
        return;
      }
      setState(err instanceof ApiError && err.status === 404 ? { kind: "missing" } : { kind: "error" });
    }
  }, [id, router]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = auth.subscribeSessionChange(() => { sessionRevisionRef.current += 1; });
    void open();
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      unsubscribe();
    };
  }, [open]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      {state.kind === "loading" && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      )}

      {state.kind === "missing" && (
        <View style={styles.center}>
          <Text style={styles.stateText}>{t("这条通知不存在或已过期")}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => router.replace("/")}>
            <Text style={styles.secondaryButtonText}>{t("回到首页")}</Text>
          </Pressable>
        </View>
      )}

      {state.kind === "error" && (
        <View style={styles.center}>
          <Text style={styles.stateText}>{t("加载失败，请稍后再试")}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => void open()}>
            <Text style={styles.secondaryButtonText}>{t("重试")}</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg, padding: spacing.xl },
  stateText: { fontSize: type.base, color: colors.muted, textAlign: "center" },
  secondaryButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  secondaryButtonText: { fontSize: type.base, color: colors.onSurface },
});
