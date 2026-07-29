import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { View, ActivityIndicator } from "react-native";

import { api, auth, isAuthError } from "@/src/api";
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

        let me: any = null;
        try {
          me = await api.me();
        } catch (err) {
          // Only a rejected token means signed out. A timeout, a network drop
          // or a 5xx says nothing about the credentials — clearing the token
          // there turned every serverless cold start into a forced logout.
          if (isAuthError(err)) {
            await auth.clearToken();
            router.replace("/register");
            return;
          }
          // Stay signed in and route on the last known state. Individual
          // screens surface their own errors if the backend is really down.
          router.replace((await auth.getOnboarded()) ? "/(tabs)" : "/onboarding");
          return;
        }

        const onboarded = !!me?.onboarding_completed;
        await auth.setOnboarded(onboarded);
        router.replace(onboarded ? "/(tabs)" : "/onboarding");
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
