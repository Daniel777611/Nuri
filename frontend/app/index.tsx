import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { View, ActivityIndicator } from "react-native";

import { api, auth } from "@/src/api";
import { colors } from "@/src/theme";

export default function Index() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const token = await auth.getToken();
        if (!token) {
          router.replace("/register");
          return;
        }
        // Validate token — only force-logout on explicit auth errors (401/403),
        // not on network failures or server errors (which would falsely clear a valid token)
        try {
          await api.me();
        } catch (e: any) {
          const msg: string = e?.message ?? "";
          const isAuthError = msg.includes(" 401") || msg.includes(" 403");
          if (isAuthError) {
            await auth.clearToken();
            router.replace("/register");
            return;
          }
          // Network / server error — keep the token and proceed; the UI will
          // surface errors naturally if the backend is truly unavailable
        }
        const children = await api.listChildren();
        if (children && children.length > 0) router.replace("/(tabs)");
        else router.replace("/onboarding");
      } finally {
        setChecking(false);
      }
    })();
  }, [router]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.surface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checking ? <ActivityIndicator color={colors.brandPrimary} /> : null}
    </View>
  );
}
