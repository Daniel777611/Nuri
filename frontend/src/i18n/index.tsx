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
  useState,
  type ReactNode,
} from "react";

import { storage } from "@/src/utils/storage";
import { en } from "./en";
import { zhTW } from "./zh-TW";

export const LOCALES = ["zh-CN", "zh-TW", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "简中",
  "zh-TW": "繁中",
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

type I18nValue = {
  locale: Locale;
  /** Switch the UI now and remember the choice. Does not call the API — the
   *  settings screen owns persisting to the server. */
  setLocale: (next: unknown) => Promise<void>;
  t: (source: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  setLocale: async () => {},
  t: (s, v) => interpolate(s, v),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    (async () => {
      const saved = await storage.getItem(LOCALE_KEY, "");
      if (saved) setLocaleState(normalizeLocale(saved));
    })();
  }, []);

  const setLocale = useCallback(async (next: unknown) => {
    const normalized = normalizeLocale(next);
    setLocaleState(normalized);
    await storage.setItem(LOCALE_KEY, normalized);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (source, vars) => translate(locale, source, vars),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  return useContext(I18nContext);
}
