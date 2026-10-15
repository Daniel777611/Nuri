import { useCallback, useRef } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import { ActivityIndicator, View } from "react-native";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { api } from "@/src/api";
import { colors } from "@/src/theme";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { requestFailureKind, type RequestFailureKind } from "@/src/requestFailure";
import RequestFailureNotice from "@/src/components/RequestFailureNotice";

// 产品只有一个持续会话；这个 tab 只是负责跳到那个真实会话（没有就创建一个）。
export default function Chats() {
  const { capture, current } = useAccountScope();
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<RequestFailureKind | null>(null);
  const requests = useRef(0);

  const load = useCallback(async () => {
    const ticket = capture();
    if (ticket === null) return;
    const request = ++requests.current;
    setFailure(null);
    try {
      // Existing history is read-only. Creation/greeting remains AI-gated.
      const preview = await api.getMainConversationPreview();
      if (!current(ticket) || request !== requests.current) return;
      const session = preview.has_conversation && preview.session_id
        ? { id: preview.session_id }
        : await api.getOrStartMainSession();
      if (current(ticket) && request === requests.current) setSessionId(session.id);
    } catch (error) {
      if (current(ticket) && request === requests.current) setFailure(requestFailureKind(error));
    }
  }, [capture, current, setFailure, setSessionId]);
  useFocusEffect(useCallback(() => {
    void load();
    const counter = requests;
    return () => { counter.current++; };
  }, [load]));

  if (!sessionId) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        {failure ? <RequestFailureNotice error={failure} onRetry={() => void load()}
          onPermission={() => router.push(aiPermissionHref("/(tabs)/chats"))}
          onLogin={() => router.push("/login")} /> : <ActivityIndicator color={colors.brand} testID="chat-entry-loading" />}
      </View>
    );
  }

  return <Redirect href={`/chat/${sessionId}`} />;
}
