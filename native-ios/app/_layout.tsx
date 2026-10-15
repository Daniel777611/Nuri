import { Stack } from "expo-router";
import { NotoSansSC_400Regular } from "@expo-google-fonts/noto-sans-sc/400Regular";
import { NotoSansSC_500Medium } from "@expo-google-fonts/noto-sans-sc/500Medium";
import { NotoSansSC_600SemiBold } from "@expo-google-fonts/noto-sans-sc/600SemiBold";
import { NotoSansSC_700Bold } from "@expo-google-fonts/noto-sans-sc/700Bold";
import { NotoSansSC_900Black } from "@expo-google-fonts/noto-sans-sc/900Black";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { I18nProvider } from "@/src/i18n";
import { useActivityHeartbeat } from "@/src/useActivityHeartbeat";
import { usePushBridge } from "@/src/usePushBridge";
import NativePageControls from "@/src/components/NativePageControls";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [iconFontsLoaded, iconFontsError] = useIconFonts();
  const [textFontsLoaded, textFontsError] = useFonts({
    NotoSansSC_400Regular,
    NotoSansSC_500Medium,
    NotoSansSC_600SemiBold,
    NotoSansSC_700Bold,
    NotoSansSC_900Black,
  });
  const fontsReady =
    (iconFontsLoaded || Boolean(iconFontsError)) &&
    (textFontsLoaded || Boolean(textFontsError));
  useActivityHeartbeat();
  usePushBridge();

  useEffect(() => {
    if (fontsReady) {
      SplashScreen.hideAsync();
    }
  }, [fontsReady]);

  if (!fontsReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <I18nProvider>
        <SafeAreaProvider>
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerShown: Platform.OS !== "web",
              header: () => (
                <SafeAreaView edges={["top"]} style={{ backgroundColor: "#FAFAF9" }}>
                  <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                    <NativePageControls />
                  </View>
                </SafeAreaView>
              ),
              contentStyle: { backgroundColor: "#FAFAF9" },
            }}
          />
        </SafeAreaProvider>
      </I18nProvider>
    </GestureHandlerRootView>
  );
}
