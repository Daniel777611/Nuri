import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import { TEXT_FONTS } from "@/src/textFonts";
import * as SplashScreen from "expo-splash-screen";
import { useRef, useSyncExternalStore } from "react";
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
import { AppKeyboardProvider } from "@/src/keyboard/AppKeyboard";
import { getIdentityGeneration, subscribeSessionBoundary } from "@/src/sessionBoundary";
import { AIConsentStartupGate } from "@/src/components/AIConsentStartupGate";

SplashScreen.preventAutoHideAsync();

/** Run app-lifetime effects without remounting the navigator. */
function AppRuntimeEffects() {
  useActivityHeartbeat();
  usePushBridge();
  return null;
}

export default function RootLayout() {
  const splashHidden = useRef(false);
  const identity=useSyncExternalStore(subscribeSessionBoundary,getIdentityGeneration,getIdentityGeneration);
  const [iconFontsLoaded, iconFontsError] = useIconFonts();
  const [textFontsLoaded, textFontsError] = useFonts(TEXT_FONTS);
  const fontsReady =
    (iconFontsLoaded || Boolean(iconFontsError)) &&
    (textFontsLoaded || Boolean(textFontsError));
  if (!fontsReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#FCF7F1" }} onLayout={() => {
      if (splashHidden.current) return;
      splashHidden.current = true;
      void SplashScreen.hideAsync().catch(() => { splashHidden.current = false; });
    }}>
      <I18nProvider>
        <AppRuntimeEffects />
        <SafeAreaProvider>
          <NuriThemeProvider><NuriNavigationTheme><AppKeyboardProvider ownerKey={identity}><AIConsentStartupGate><NuriShell><Stack
            screenOptions={({ route }) => ({
              headerShown: false,
              contentStyle: { backgroundColor: "transparent" },
              animation: route.name === "(tabs)" || route.name === "community" ? "none" : "simple_push",
              animationDuration: 300,
            })}
          /></NuriShell></AIConsentStartupGate></AppKeyboardProvider></NuriNavigationTheme></NuriThemeProvider>
        </SafeAreaProvider>
      </I18nProvider>
    </GestureHandlerRootView>
  );
}
