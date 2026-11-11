// UI translation.
//
// Keys are the Simplified Chinese source strings themselves rather than
// invented identifiers ("profile.addChild"). Two reasons: screens read the same
// as before, and an untranslated string falls back to readable Simplified
// Chinese instead of leaking a key name onto the screen.
//
// Usage:
//   const { t } = useT();
//   <Text>{t("添加孩子")}</Text>
//   <Text>{t("{n} 月龄", { n: 8 })}</Text>
//
// Admin screens (app/admin*.tsx) are deliberately not translated — they're an
// internal tool, not a user surface.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform, Settings } from "react-native";

import { storage } from "@/src/utils/storage";
import { en } from "./en";
import { zhTW } from "./zh-TW";

export const LOCALES = ["zh-CN", "zh-TW", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
};

export const DEFAULT_LOCALE: Locale = "zh-CN";

// zh-CN needs no table: it *is* the key space.
const DICTIONARIES: Record<Locale, Record<string, string>> = {
  "zh-CN": {},
  "zh-TW": zhTW,
  en,
};

// Mirrors _normalize_language() in backend/main.py. Anything unrecognised
// degrades to Simplified rather than throwing — a bad locale must never be
// able to blank the UI.
export function normalizeLocale(value: unknown): Locale {
  const raw = String(value ?? "").trim().replace(/_/g, "-").toLowerCase();
  if (raw.startsWith("en")) return "en";
  if (["zh-tw", "zh-hk", "zh-mo"].includes(raw) || raw.includes("hant")) return "zh-TW";
  return "zh-CN";
}

/** Substitute `{name}` placeholders. Unknown names are left as-is so a typo is
 *  visible in testing rather than silently rendering an empty gap. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export function translate(
  locale: Locale,
  source: string,
  vars?: Record<string, string | number>,
): string {
  return interpolate(DICTIONARIES[locale]?.[source] ?? source, vars);
}

// This cache is not proof of a user choice: older account hydration also wrote
// it. Only the separate, valid mode key records an explicit app preference.
const LOCALE_KEY = "ui_language";
const LANGUAGE_MODE_KEY = "ui_language_mode";
export type LanguageMode = Locale | "system";

/** Device fallback is intentionally different from backend language parsing.
 * Unsupported phone languages use English, never an inferred Chinese choice. */
export function normalizeDeviceLocale(value: unknown): Locale {
  const raw = String(value ?? "").trim().replace(/_/g, "-").toLowerCase();
  if (/^en(?:-|$)/.test(raw)) return "en";
  if (!/^zh(?:-|$)/.test(raw)) return "en";
  if (/(?:^|-)hant(?:-|$)/.test(raw) || /^zh-(?:tw|hk|mo)(?:-|$)/.test(raw)) return "zh-TW";
  return "zh-CN";
}

export function systemLocale(): Locale {
  try {
    const value = Platform.OS === "ios"
      ? Settings.get("AppleLanguages")?.[0] || Settings.get("AppleLocale")
      : Intl.DateTimeFormat().resolvedOptions().locale;
    return normalizeDeviceLocale(value);
  } catch { return "en"; }
}

function storedLanguageMode(value: unknown): LanguageMode {
  return value === "system" || LOCALES.includes(value as Locale) ? value as LanguageMode : "system";
}

type I18nValue = {
  locale: Locale;
  languageMode: LanguageMode;
  chooseLanguage: (next: LanguageMode) => Promise<Locale>;
  /** Reconcile after account/profile hydration without treating a server
   * language as a device preference. Explicit choices use chooseLanguage. */
  setLocale: (next: unknown) => Promise<void>;
  t: (source: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  languageMode: "system",
  chooseLanguage: async () => DEFAULT_LOCALE,
  setLocale: async () => {},
  t: (s, v) => interpolate(s, v),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(systemLocale);
  const [languageMode,setLanguageMode]=useState<LanguageMode>("system");
  const mode=useRef<LanguageMode>("system"),intent=useRef(0),mounted=useRef(true);
  const writes=useRef<Promise<void>>(Promise.resolve());
  const enqueue=useCallback(<T,>(work:()=>Promise<T>):Promise<T>=>{
    const task=writes.current.catch(()=>{}).then(work);
    writes.current=task.then(()=>{},()=>{});
    return task;
  },[]);

  useEffect(() => {
    mounted.current=true;let active=true,foreground=AppState.currentState==="active";const ticket=intent.current;
    void (async () => {
      let savedMode:unknown;
      try { savedMode=await storage.getItem(LANGUAGE_MODE_KEY,"" as string); } catch { savedMode=""; }
      if(!active||ticket!==intent.current)return;
      const chosen=storedLanguageMode(savedMode);
      mode.current=chosen;setLanguageMode(chosen);setLocaleState(chosen==="system"?systemLocale():chosen);
    })();
    const refreshDevice=()=>{if(active&&foreground&&mode.current==="system")setLocaleState(systemLocale());};
    const sub=AppState.addEventListener("change",state=>{foreground=state==="active";refreshDevice();});
    // RN's Settings.get reads a JS cache. Its settingsUpdated event refreshes
    // that cache; watchKeys also catches updates delivered after AppState active.
    const watch=Platform.OS==="ios"&&typeof Settings.watchKeys==="function"
      ? Settings.watchKeys(["AppleLanguages","AppleLocale"],refreshDevice):null;
    return()=>{active=false;mounted.current=false;sub.remove();if(watch!==null)Settings.clearWatch(watch);};
  }, []);

  const setLocale = useCallback(async (_next: unknown) => {
    const ticket=intent.current;
    return enqueue(async()=>{
    if(!mounted.current||ticket!==intent.current)return;
    let savedMode:unknown;
    try { savedMode=await storage.getItem(LANGUAGE_MODE_KEY,"" as string); } catch { return; }
    if(!mounted.current||ticket!==intent.current)return;
    const chosen=storedLanguageMode(savedMode);
    mode.current=chosen;setLanguageMode(chosen);setLocaleState(chosen==="system"?systemLocale():chosen);
    });
  }, [enqueue]);
  const chooseLanguage=useCallback(async(next:LanguageMode)=>{
    if(next!=="system"&&!LOCALES.includes(next))throw new Error("UNSUPPORTED_LANGUAGE_SELECTION");
    const ticket=++intent.current;
    return enqueue(async()=>{
    if(!mounted.current||ticket!==intent.current)throw new Error("LANGUAGE_SELECTION_SUPERSEDED");
    const normalized=next==="system"?systemLocale():normalizeLocale(next);
    if(!await storage.setItem(LOCALE_KEY,normalized))throw new Error("LOCAL_LANGUAGE_SAVE_FAILED");
    if(!mounted.current||ticket!==intent.current)throw new Error("LANGUAGE_SELECTION_SUPERSEDED");
    if(!await storage.setItem(LANGUAGE_MODE_KEY,next))throw new Error("LOCAL_LANGUAGE_SAVE_FAILED");
    if(!mounted.current||ticket!==intent.current)throw new Error("LANGUAGE_SELECTION_SUPERSEDED");
    const currentLocale=next==="system"?systemLocale():normalized;
    mode.current=next;setLanguageMode(next);setLocaleState(currentLocale);return currentLocale;
    });
  },[enqueue]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      languageMode,
      chooseLanguage,
      setLocale,
      t: (source, vars) => translate(locale, source, vars),
    }),
    [locale, setLocale,languageMode,chooseLanguage],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  return useContext(I18nContext);
}
