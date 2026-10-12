import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { colors } from "@/src/theme";
import { useT } from "@/src/i18n";

// 产品只有一个持续会话；这个 tab 只是负责跳到那个真实会话（没有就创建一个）。
export default function Chats() {
  const { t } = useT();
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  // A failed lookup used to leave the spinner up for good.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    api
      .getOrStartMainSession()
      .then((s) => {
        if (!cancelled) setSessionId(s.id);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (sessionId) return <Redirect href={`/chat/${sessionId}`} />;

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}>
      {failed ? (
        <>
          <Ionicons name="cloud-offline-outline" size={32} color={colors.muted} />
          <Text style={{ color: colors.onSurface, fontSize: 15, textAlign: "center" }}>
            {t("对话暂时无法打开，请稍后再试")}
          </Text>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))}
              style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 999, backgroundColor: colors.surfaceTertiary }}
              testID="chats-back"
            >
              <Text style={{ color: colors.onSurface, fontWeight: "600" }}>{t("返回")}</Text>
            </Pressable>
            <Pressable
              onPress={retry}
              style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 999, backgroundColor: colors.brand }}
              testID="chats-retry"
            >
              <Text style={{ color: "#fff", fontWeight: "600" }}>{t("重试")}</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <ActivityIndicator color={colors.brand} />
      )}
    </View>
  );
}
