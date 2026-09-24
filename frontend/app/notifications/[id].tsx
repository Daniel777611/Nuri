// Where a tapped notification lands, for as long as it takes to leave.
//
// Both native shells only open `/notifications/<id>`, so this route stays the
// entry point, but a notification is no longer read here. The server writes
// it into the NURI conversation as NURI's own message — a care line word for
// word, or the featured post as a card — and this screen goes straight there.
// The server answers 404 for a notification that belongs to someone else,
// which this screen shows exactly like one that never existed.

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";

import { api, ApiError, isAuthError } from "@/src/api";
import { colors, radius, spacing, type } from "@/src/theme";
import { useT } from "@/src/i18n";

type LoadState = { kind: "loading" } | { kind: "missing" } | { kind: "error" };

export default function NotificationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useT();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const open = useCallback(async () => {
    if (!id) {
      setState({ kind: "missing" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const { session_id } = await api.openNotification(String(id));
      // Replace, not push: going back from the conversation should not land
      // on a screen whose only job was to forward.
      router.replace(`/chat/${session_id}` as never);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setState(err instanceof ApiError && err.status === 404 ? { kind: "missing" } : { kind: "error" });
    }
  }, [id, router]);

  useEffect(() => {
    void open();
  }, [open]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
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
