import { useCallback, useRef } from "react";
import { useAccountState as useState, useAccountScope } from "@/src/useAccountState";
import { ActivityIndicator, Platform, View } from "react-native";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { api } from "@/src/api";
import { colors } from "@/src/theme";
import { aiPermissionHref } from "@/src/aiPermissionNavigation";
import { requestFailureKind, type RequestFailureKind } from "@/src/requestFailure";
import RequestFailureNotice from "@/src/components/RequestFailureNotice";
import ChatDetail from "../chat/[id]";

// The tab opens the account's existing conversation or creates it with AI consent.
export default function Chats() {
  const { capture, current } = useAccountScope();
  const router = useRouter();
  const alphaChat = Platform.OS === "ios" && ["live-alpha", "early-access", "app-store"].includes(process.env.EXPO_PUBLIC_RELEASE_FLAVOR ?? "");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<RequestFailureKind | null>(null);
  const requests = useRef(0);
  const resolvedAlphaSession = alphaChat ? sessionId : null;

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
    if (resolvedAlphaSession) return;
    void load();
    const counter = requests;
    return () => { counter.current++; };
  }, [resolvedAlphaSession, load]));

  const failureNotice = failure ? <RequestFailureNotice error={failure} onRetry={() => void load()}
    onPermission={() => router.push(aiPermissionHref("/(tabs)/chats"))}
    onLogin={() => router.push("/login")} /> : null;

  if (alphaChat) {
    return <ChatDetail sessionId={sessionId ?? undefined} mainEntry={{failureNotice, replaceSessionId:setSessionId}} />;
  }

  if (!sessionId) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        {failureNotice ?? <ActivityIndicator color={colors.brand} testID="chat-entry-loading" />}
      </View>
    );
  }

  return <Redirect href={`/chat/${sessionId}`} />;
}
