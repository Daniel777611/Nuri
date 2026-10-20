import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Appearance, Platform } from "react-native";
import { storage } from "@/src/utils/storage";
import { THEME48, type NuriMode } from "./tokens";
import { useT } from "@/src/i18n";
import { DefaultTheme, DarkTheme, ThemeProvider as NavigationThemeProvider } from "@react-navigation/native";
import { iosKeyboard48 } from "./keyboard";

const MODES: NuriMode[] = ["Morning", "Afternoon", "Night"];
const hourMode = (): NuriMode => { const h = new Date().getHours(); return h < 12 && h >= 5 ? "Morning" : h < 19 && h >= 12 ? "Afternoon" : "Night"; };
const Context = createContext({ mode: "Morning" as NuriMode, setMode: (_mode: NuriMode) => {} });

export function NuriThemeProvider({ children }: { children: ReactNode }) {
  const [mode, update] = useState<NuriMode>(hourMode);
  const { setLocale } = useT();
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    // This is an app-local appearance override, not a device setting. Keep
    // system keyboard chrome/alerts in the same day/night mode as Nuri.
    Appearance.setColorScheme(mode === "Night" ? "dark" : "light");
    return () => Appearance.setColorScheme(null);
  }, [mode]);
  useEffect(() => {
    let active = true;
    void storage.getItem("nuri_uiux48_theme", "").then(saved => {
      // A preview-only URL override is for deterministic visual acceptance;
      // production never reads it and no server preference is changed.
      const query = Platform.OS === "web" && process.env.EXPO_PUBLIC_PREVIEW_MODE === "1"
        ? new URLSearchParams(globalThis.location?.search).get("theme") : null;
      const selected = MODES.find(m => m === String(query)) ?? MODES.find(m => m === String(saved));
      if (active && selected) update(selected);
      if (active && Platform.OS === "web" && process.env.EXPO_PUBLIC_PREVIEW_MODE === "1") {
        const lang = new URLSearchParams(globalThis.location?.search).get("lang");
        if (lang === "en" || lang === "zh-CN" || lang === "zh-TW") void setLocale(lang);
      }
    });
    return () => { active = false; };
  }, [setLocale]);
  const value = useMemo(() => ({ mode, setMode: (next: NuriMode) => {
    update(next);
    void storage.setItem("nuri_uiux48_theme", next).catch(() => {});
  } }), [mode]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useNuriTheme() {
  const { mode, setMode } = useContext(Context);
  const token = (name: keyof typeof THEME48) => THEME48[name][mode];
  return { mode, setMode, night: mode === "Night", keyboard: iosKeyboard48(mode === "Night"), token,
    ink: String(token("color/text/primary")), secondary: String(token("color/text/card-secondary")),
    glass: String(token("color/glass/unified-card-27")),
    message: String(token("color/chat/nuri-message-glass-23")),
    userMessage: String(token("color/chat/user-bubble")),
    composer: String(token("color/chat/composer-glass-23")),
    coral: String(token("color/welcome38/primary-tint")),
    outline: String(token("color/control/field-border-36")),
  };
}
export function NuriNavigationTheme({children}:{children:ReactNode}) {
  const {night,ink,coral}=useNuriTheme();const base=night?DarkTheme:DefaultTheme;
  const value=useMemo(()=>({...base,colors:{...base.colors,background:"transparent",card:"transparent",text:ink,primary:coral}}),[base,ink,coral]);
  return <NavigationThemeProvider value={value}>{children}</NavigationThemeProvider>;
}
