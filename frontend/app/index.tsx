import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { View, ActivityIndicator } from "react-native";

import { api, auth, isAuthError } from "@/src/api";
import { useT } from "@/src/i18n";
import { colors } from "@/src/theme";

export default function Index() {
  const router = useRouter();
  const { setLocale } = useT();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const token = await auth.getToken();
        if (!token) {
          // Returning users are the common case, so land on login. New users
          // reach register via the "立即注册" link there.
          router.replace("/login");
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
            router.replace("/login");
            return;
          }
          // Stay signed in and route on the last known state. Individual
          // screens surface their own errors if the backend is really down.
          router.replace((await auth.getOnboarded()) ? "/(tabs)" : "/onboarding");
          return;
        }

        // Adopt the account's saved UI language before the first screen paints,
        // so a fresh install doesn't open in the wrong one.
        if (me?.language) await setLocale(me.language);
        const onboarded = !!me?.onboarding_completed;
        await auth.setOnboarded(onboarded);
        router.replace(onboarded ? "/(tabs)" : "/onboarding");
      } finally {
        setChecking(false);
      }
    })();
  }, [router, setLocale]);

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
