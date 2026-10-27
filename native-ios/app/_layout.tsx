import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import { TEXT_FONTS } from "@/src/textFonts";
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
import { NuriThemeProvider, NuriNavigationTheme } from "@/src/uiux48/Theme";
import { NuriShell } from "@/src/uiux48/Shell";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [iconFontsLoaded, iconFontsError] = useIconFonts();
  const [textFontsLoaded, textFontsError] = useFonts(TEXT_FONTS);
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
          <NuriThemeProvider><NuriNavigationTheme><NuriShell><Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: "transparent" },
            }}
          /></NuriShell></NuriNavigationTheme></NuriThemeProvider>
        </SafeAreaProvider>
      </I18nProvider>
    </GestureHandlerRootView>
  );
}
