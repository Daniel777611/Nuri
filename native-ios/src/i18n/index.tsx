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

// Written on every change so the next launch renders in the right language
// immediately, instead of flashing Simplified until /auth/me answers.
const LOCALE_KEY = "ui_language";
const LANGUAGE_MODE_KEY = "ui_language_mode";
export type LanguageMode = Locale | "system";
export function systemLocale(): Locale {
  let value:unknown;
  try { value=Platform.OS==="ios"?Settings.get("AppleLanguages")?.[0]||Settings.get("AppleLocale"):Intl.DateTimeFormat().resolvedOptions().locale; } catch { value="en"; }
  return /^zh/i.test(String(value))?normalizeLocale(value):"en";
}

type I18nValue = {
  locale: Locale;
  languageMode: LanguageMode;
  chooseLanguage: (next: LanguageMode) => Promise<Locale>;
  /** Switch the UI now and remember the choice. Does not call the API — the
   *  settings screen owns persisting to the server. */
  setLocale: (next: unknown) => Promise<void>;
  t: (source: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  languageMode: DEFAULT_LOCALE,
  chooseLanguage: async () => DEFAULT_LOCALE,
  setLocale: async () => {},
  t: (s, v) => interpolate(s, v),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [languageMode,setLanguageMode]=useState<LanguageMode>(DEFAULT_LOCALE);
  const mode=useRef<LanguageMode>(DEFAULT_LOCALE),intent=useRef(0);
  const writes=useRef<Promise<void>>(Promise.resolve());
  const enqueue=useCallback(<T,>(work:()=>Promise<T>):Promise<T>=>{
    const task=writes.current.catch(()=>{}).then(work);
    writes.current=task.then(()=>{},()=>{});
    return task;
  },[]);

  useEffect(() => {
    let active=true;const ticket=intent.current;
    void (async () => {
      const [saved,savedMode]=await Promise.all([storage.getItem(LOCALE_KEY,"" as string),storage.getItem(LANGUAGE_MODE_KEY,"" as string)]);
      if(!active||ticket!==intent.current)return;
      const chosen:LanguageMode=savedMode==="system"?"system":normalizeLocale(savedMode||saved||DEFAULT_LOCALE);
      mode.current=chosen;setLanguageMode(chosen);setLocaleState(chosen==="system"?systemLocale():normalizeLocale(saved||chosen));
    })();
    const sub=AppState.addEventListener("change",state=>{if(state==="active"&&mode.current==="system"){void enqueue(async()=>{if(mode.current!=="system")return;const next=systemLocale();const saved=await storage.setItem(LOCALE_KEY,next);if(saved&&mode.current==="system")setLocaleState(next);});}});
    return()=>{active=false;sub.remove();};
  }, [enqueue]);

  const setLocale = useCallback(async (next: unknown) => {
    const ticket=++intent.current;
    return enqueue(async()=>{
    // Account/profile hydration must not override a previously chosen system
    // language, even when it resolves before the provider's initial read.
    const savedMode=await storage.getItem(LANGUAGE_MODE_KEY,"" as string);
    if(ticket!==intent.current)return;
    if(savedMode==="system"){mode.current="system";setLanguageMode("system");}
    const normalized = mode.current==="system"?systemLocale():normalizeLocale(next);
    const saved = await storage.setItem(LOCALE_KEY, normalized);
    if (!saved) throw new Error("LOCAL_LANGUAGE_SAVE_FAILED");
    if(ticket===intent.current)setLocaleState(normalized);
    });
  }, [enqueue]);
  const chooseLanguage=useCallback(async(next:LanguageMode)=>{
    const ticket=++intent.current;
    const normalized=next==="system"?systemLocale():normalizeLocale(next);
    return enqueue(async()=>{
    if(ticket!==intent.current)throw new Error("LANGUAGE_SELECTION_SUPERSEDED");
    const result=[await storage.setItem(LOCALE_KEY,normalized),await storage.setItem(LANGUAGE_MODE_KEY,next)];
    if(result.some(value=>!value))throw new Error("LOCAL_LANGUAGE_SAVE_FAILED");
    if(ticket!==intent.current)throw new Error("LANGUAGE_SELECTION_SUPERSEDED");
    mode.current=next;setLanguageMode(next);setLocaleState(normalized);return normalized;
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
