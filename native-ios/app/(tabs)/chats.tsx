import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { api } from "@/src/api";
import { colors } from "@/src/theme";

// 产品只有一个持续会话；这个 tab 只是负责跳到那个真实会话（没有就创建一个）。
export default function Chats() {
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getOrStartMainSession().then((s) => {
      if (!cancelled) setSessionId(s.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!sessionId) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  return <Redirect href={`/chat/${sessionId}`} />;
}
