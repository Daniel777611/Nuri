import { useEffect } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { api } from "@/src/api";
import { colors } from "@/src/theme";

// 产品只有一个持续会话；这个 tab 只是负责跳到那个真实会话（没有就创建一个）。
export default function Chats() {
  const { capture, current } = useAccountScope();
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    const ticket = capture();
    if (ticket === null) return;
    let cancelled = false;
    api.getOrStartMainSession().then((s) => {
      if (!cancelled && current(ticket)) setSessionId(s.id);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [capture, current, setSessionId]);

  if (!sessionId) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  return <Redirect href={`/chat/${sessionId}`} />;
}
